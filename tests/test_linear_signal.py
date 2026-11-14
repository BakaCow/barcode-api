"""Original-pixel recovery and abstention checks on development-only images."""
import base64
from dataclasses import replace
import json
from pathlib import Path
from time import monotonic
from types import SimpleNamespace
import zlib

from PIL import Image
import pytest
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / 'tests/fixtures/damage-stress-qr-upgrade.json').read_text())['cases']
TARGETS = [case for case in CASES if case['name'].split('/')[0] in ('ean13', 'code128') and
           case['name'].endswith(('/motion-blur-2', '/small-in-frame-2'))]


@pytest.fixture
def signal(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    import linear_signal
    return linear_signal


def image(case):
    with Image.frombytes('RGBA', (case['width'], case['height']), zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))) as source:
        return source.convert('L')


@pytest.mark.parametrize('case', TARGETS, ids=lambda case: case['name'])
def test_whole_source_model_recovers_severe_linear_cases(signal, case):
    with image(case) as source:
        before = source.tobytes()
        result = signal.recover(source, deadline=monotonic() + 1.2)
        assert result.complete
        assert len(result.observations) == 1
        observation = result.observations[0]
        assert observation.code.text == case['expected'][0]['text']
        assert observation.code.bytes == case['expected'][0]['text'].encode('utf-8')
        assert source.tobytes() == before
        assert all(0 <= x <= source.width and 0 <= y <= source.height for x, y in observation.points)


def test_development_negatives_and_clipped_linear_guards_abstain(signal):
    cases = [case for case in CASES if not case['expected'] or
             case['name'].split('/')[0] in ('ean13', 'code128') and case['name'].endswith('/clipping-2')]
    assert len(cases) == 54
    for case in cases:
        with image(case) as source:
            assert not signal.recover(source, deadline=monotonic() + 1.2).observations, case['name']


def stacked(first, second, thin=False):
    with image(first) as a, image(second) as b:
        result = Image.new('L', (max(a.width, b.width), a.height + 40 + (2 if thin else b.height)), 255)
        result.paste(a, (0, 0))
        if thin:
            with b.crop((0, b.height // 2, b.width, b.height // 2 + 2)) as strip:
                result.paste(strip, (0, a.height + 40))
        else:
            result.paste(b, (0, a.height + 40))
        return result


@pytest.mark.parametrize('same', [False, True])
def test_separate_physical_labels_remain_separate(signal, same):
    labels = [case for case in TARGETS if case['name'].startswith('ean13/') and case['name'].endswith('/motion-blur-2')]
    chosen = [labels[0], labels[0 if same else 1]]
    with stacked(*chosen) as source:
        result = signal.recover(source, deadline=monotonic() + 1.2)
    assert result.complete
    assert len(result.observations) == 2
    assert sorted(item.code.text for item in result.observations) == sorted(case['expected'][0]['text'] for case in chosen)
    assert result.observations[0].points[2][1] < result.observations[1].points[0][1]


def test_credible_short_label_vetoes_unique_read(signal):
    labels = [case for case in TARGETS if case['name'].startswith('ean13/') and case['name'].endswith('/motion-blur-2')]
    with stacked(*labels[:2], thin=True) as source:
        result = signal.recover(source, deadline=monotonic() + 1.2)
    assert not result.complete and result.observed == 2
    assert not result.observations


@pytest.mark.parametrize('change', [{'bytes': b'wrong'}, {'valid': False}, {'error': 'checksum'}])
def test_native_canonicalization_requires_exact_bytes_and_validity(signal, monkeypatch, change):
    native = zxingcpp.read_barcodes
    def changed(source, **options):
        return [SimpleNamespace(**(dict(text=code.text, bytes=code.bytes, format=code.format, valid=code.valid, error=code.error) | change))
                for code in native(source, **options)]
    monkeypatch.setattr(signal.zxingcpp, 'read_barcodes', changed)
    with image(TARGETS[0]) as source:
        result = signal.recover(source, deadline=monotonic() + 1.2)
    assert not result.complete and result.observed == 1 and not result.observations


def test_allowlists_and_expired_deadline_prevent_native_calls(signal, monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail('Excluded or expired search called native decoding.')
    monkeypatch.setattr(signal.zxingcpp, 'read_barcodes', unexpected)
    with image(TARGETS[0]) as source:
        assert signal.recover(source, deadline=monotonic() + 1, formats=()).complete
        assert not signal.recover(source, deadline=monotonic() - 1).complete
        assert not signal.recover(source, deadline=monotonic() + 1, formats=('EAN13',)).observations


def test_code128_payload_does_not_repair_checksum_or_claim_unsupported_fnc4(signal):
    # A/B control and GS1 bytes are represented exactly; FNC4 needs the old path.
    def words(start, data):
        return [start, *data, (start + sum(index * value for index, value in enumerate(data, 1))) % 103]
    assert signal._code_payload(words(103, [64, 33])) == (b'\x00A', False)
    assert signal._code_payload(words(104, [102, 33, 102, 34])) == (b'A\x1dB', True)
    assert signal._code_payload(words(104, [100, 33])) is None
    invalid = words(104, [33, 34]); invalid[-1] = (invalid[-1] + 1) % 103
    assert signal._code_payload(invalid) is None


def test_deadline_keeps_evidence_from_an_already_fitted_tiny_proposal(signal, monkeypatch):
    case = next(case for case in TARGETS if case['name'].startswith('ean13/') and case['name'].endswith('/small-in-frame-2'))
    clock, best_fit = {'expired': False}, signal._best_fit
    def timed_fit(*args, **kwargs):
        proof = best_fit(*args, **kwargs)
        if proof:
            clock['expired'] = True
            # Keep another equivalent geometry pending so the next deadline
            # check occurs inside the proposal search, after this source fit.
            return replace(proof, rmse=.03)
        return proof
    monkeypatch.setattr(signal, '_best_fit', timed_fit)
    real_clock = monotonic
    deadline = real_clock() + 1.2
    monkeypatch.setattr(signal, 'monotonic', lambda: deadline + 1 if clock['expired'] else real_clock())
    with image(case) as source:
        result = signal.recover(source, deadline=deadline)
    assert clock['expired']
    assert not result.complete and result.observed > 0
    assert not result.observations


def test_deadline_inside_model_refinement_keeps_complete_source_fit(signal, monkeypatch):
    case = next(case for case in TARGETS if case['name'].startswith('ean13/') and case['name'].endswith('/small-in-frame-2'))
    clock, fit = {'expired': False}, signal._fit
    def timed_fit(*args, **kwargs):
        proof = fit(*args, **kwargs)
        if proof and proof.rmse <= .045 and proof.max_block <= .095:
            clock['expired'] = True
        return proof
    monkeypatch.setattr(signal, '_fit', timed_fit)
    real_clock = monotonic
    deadline = real_clock() + 1.2
    monkeypatch.setattr(signal, 'monotonic', lambda: deadline + 1 if clock['expired'] else real_clock())
    with image(case) as source:
        result = signal.recover(source, deadline=deadline)
    assert clock['expired']
    assert not result.complete and result.observed > 0
    assert not result.observations


def test_native_overrun_does_not_publish_late_unique_result(signal, monkeypatch):
    native, clock = zxingcpp.read_barcodes, {'expired': False}
    real_clock, deadline = monotonic, monotonic() + 1.2
    def late_native(*args, **kwargs):
        found = native(*args, **kwargs)
        clock['expired'] = True
        return found
    monkeypatch.setattr(signal.zxingcpp, 'read_barcodes', late_native)
    monkeypatch.setattr(signal, 'monotonic', lambda: deadline + 1 if clock['expired'] else real_clock())
    with image(TARGETS[0]) as source:
        result = signal.recover(source, deadline=deadline)
    assert not result.complete and result.observed == 1
    assert not result.observations


def staggered_damage(source, color=255, full_height=False):
    from PIL import ImageDraw, ImageOps
    result = source.copy()
    left, _, right, _ = ImageOps.invert(source).getbbox()
    span = right - left
    patch = max(18, round(span * .075))
    draw = ImageDraw.Draw(result)
    for y in range(source.height):
        part = 1 if full_height else (y * 9 // source.height) % 3
        center = round(left + span * (.25 + .25 * part))
        draw.line((center - patch // 2, y, center + (patch + 1) // 2 - 1, y), fill=color)
    return result


@pytest.mark.parametrize('family', ['ean13', 'code128'])
@pytest.mark.parametrize('color', [0, 255])
def test_cross_row_reconstruction_uses_surviving_original_pixels(signal, family, color):
    case = next(case for case in CASES if case['name'].startswith(family + '/') and case['name'].endswith('/clean-0'))
    with image(case) as original, staggered_damage(original, color) as damaged:
        before = damaged.tobytes()
        assert not zxingcpp.read_barcodes(damaged, formats=zxingcpp.BarcodeFormats([zxingcpp.BarcodeFormat.EAN13, zxingcpp.BarcodeFormat.Code128]))
        result = signal.recover(damaged, deadline=monotonic() + 1.2)
        assert result.complete and len(result.observations) == 1
        code = result.observations[0].code
        assert code.text == case['expected'][0]['text']
        assert code.bytes == case['expected'][0]['text'].encode()
        assert damaged.tobytes() == before


def test_known_native_false_upce_has_positive_full_ean_source_evidence(signal):
    cases = json.loads((ROOT / 'tests/fixtures/damage-stress-signal-upgrade.json').read_text())['cases']
    case = next(case for case in cases if case['name'] == 'ean13/signal-upgrade-ean13-label-1/missing-patch-1')
    with image(case) as source:
        result = signal.recover(source, deadline=monotonic() + 1.2)
    assert result.complete and len(result.observations) == 1
    assert result.observations[0].code.format.name == 'EAN13'
    assert result.observations[0].code.text == case['expected'][0]['text']


def test_no_original_row_can_supply_a_full_height_missing_stripe(signal):
    for family in ('ean13', 'code128'):
        case = next(case for case in CASES if case['name'].startswith(family + '/') and case['name'].endswith('/clean-0'))
        for color in (0, 255):
            with image(case) as original, staggered_damage(original, color, full_height=True) as source:
                assert not signal.recover(source, deadline=monotonic() + 1.2).observations


def test_cross_row_reconstruction_preserves_control_bytes(signal):
    cases = json.loads((ROOT / 'tests/fixtures/independent-code128-safety.json').read_text())['cases']
    for group in (1, 5):
        case = next(case for case in cases if case['name'] == f'code128/independent-code128-{group}/clean')
        with image(case) as original, staggered_damage(original) as source:
            result = signal.recover(source, deadline=monotonic() + 1.2)
        assert result.complete and len(result.observations) == 1
        assert result.observations[0].code.bytes == bytes(case['expected'][0]['bytes'])


def test_uninspected_neighbour_of_reconstructed_code_cannot_be_hidden(signal):
    case = next(case for case in CASES if case['name'].startswith('code128/') and case['name'].endswith('/clean-0'))
    with image(case) as original, staggered_damage(original) as label:
        with Image.new('L', (label.width * 2 + 40, label.height), 255) as source:
            source.paste(label, (0, 0)); source.paste(label, (label.width + 40, 0))
            result = signal.recover(source, deadline=monotonic() + 1.2)
    assert not result.complete and result.observed > 0 and not result.observations


def test_different_valid_row_patterns_cannot_be_voted_away_as_damage(signal):
    cases = [case for case in CASES if case['name'].startswith('ean13/') and case['name'].endswith('/clean-0')][:2]
    with image(cases[0]) as first, image(cases[1]) as second:
        with staggered_damage(first) as a, staggered_damage(second) as b:
            for fraction in (.2, .4):
                with a.copy() as mixed:
                    y = int(mixed.height * (1 - fraction))
                    with b.crop((0, y, b.width, b.height)) as strip:
                        mixed.paste(strip, (0, y))
                    assert not signal.recover(mixed, deadline=monotonic() + 1.2).observations


def test_deadline_retains_completed_cross_row_proof_as_withheld_evidence(signal, monkeypatch):
    case = next(case for case in CASES if case['name'].startswith('ean13/') and case['name'].endswith('/clean-0'))
    real_proof, clock = signal._composite_proof, {'expired': False}
    deadline, real_clock = monotonic() + 1.2, monotonic
    def completed_proof(*args):
        result = real_proof(*args)
        if result:
            clock['expired'] = True
        return result
    monkeypatch.setattr(signal, '_composite_proof', completed_proof)
    monkeypatch.setattr(signal, 'monotonic', lambda: deadline + 1 if clock['expired'] else real_clock())
    with image(case) as original, staggered_damage(original) as source:
        result = signal.recover(source, deadline=deadline)
    assert clock['expired'] and not result.complete and result.observed > 0
    assert not result.observations
