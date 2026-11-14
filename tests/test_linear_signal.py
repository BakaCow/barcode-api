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
