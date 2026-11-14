"""Source-model recovery tests use development fixtures, never unseen evaluation."""
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

import qr_signal
import qr_recovery

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    return json.loads((ROOT / 'tests/fixtures' / name).read_text(encoding='utf-8'))['cases']


CASES = sum((load(name) for name in ('damage-stress-dev.json', 'damage-stress-recovery.json', 'damage-stress-qr-upgrade.json')), [])
TARGETS = [case for case in CASES if case['name'].startswith('qr/') and case['name'].rsplit('/', 1)[-1] in ('motion-blur-2', 'small-in-frame-2')]


def pixels(case):
    return Image.frombytes('RGBA', (case['width'], case['height']), zlib.decompress(base64.b64decode(case['rgba_zlib_base64'])))


def recover(image):
    return qr_signal.recover(image, deadline=monotonic() + 2)


@pytest.mark.parametrize('case', TARGETS, ids=lambda case: case['name'])
def test_native_source_model_recovery(case):
    with pixels(case) as image:
        before = image.tobytes()
        result = recover(image)
        assert result.complete
        assert len(result.observations) == 1
        observed = result.observations[0]
        assert observed.code.text == case['expected'][0]['text']
        assert observed.code.bytes == case['expected'][0]['text'].encode('utf-8')
        assert image.tobytes() == before
        assert all(0 <= x <= image.width and 0 <= y <= image.height for x, y in observed.points)


def test_development_negatives_and_clipping_do_not_create_payloads():
    for case in load('damage-stress-qr-upgrade.json'):
        if case['expected'] and not (case['name'].startswith('qr/') and case['name'].endswith('/clipping-2')):
            continue
        with pixels(case) as image:
            assert not recover(image).observations, case['name']


def blur(image, length=9, vertical=False):
    with image.convert('L') as gray:
        raw = gray.tobytes()
    output = bytearray(len(raw))
    half = length // 2
    for y in range(image.height):
        for x in range(image.width):
            total = 0
            for k in range(-half, half + 1):
                sx, sy = x + (0 if vertical else k), y + (k if vertical else 0)
                total += raw[sy * image.width + sx] if 0 <= sx < image.width and 0 <= sy < image.height else 255
            output[y * image.width + x] = int(total / length + .5)
    return Image.frombytes('L', image.size, bytes(output))


def test_native_nontext_bytes_survive_horizontal_and_vertical_exposure():
    for case in load('independent-byte-controls.json'):
        if case['format'] != 'QRCode':
            continue
        with pixels(case) as original:
            canonical = zxingcpp.read_barcodes(original, formats=zxingcpp.BarcodeFormat.QRCode)[0]
            assert canonical.bytes == bytes(case['encoderBytes'])
            for vertical in (False, True):
                with blur(original, vertical=vertical) as image:
                    result = recover(image)
                assert result.complete and len(result.observations) == 1, case['name']
                assert result.observations[0].code.bytes == bytes(case['encoderBytes'])
                assert result.observations[0].code.text == canonical.text


def test_native_status_format_and_source_association_are_required(monkeypatch):
    native = zxingcpp.read_barcodes
    fixture = next(case for case in TARGETS if case['name'].endswith('/motion-blur-2'))
    for mutation in ({'valid': False}, {'error': 'checksum'}, {'format': zxingcpp.BarcodeFormat.Code128}):
        def read(image, **options):
            return [SimpleNamespace(**dict({'valid': code.valid, 'error': code.error, 'format': code.format,
                                           'text': code.text, 'bytes': code.bytes, 'position': code.position}, **mutation))
                    for code in native(image, **options)]
        monkeypatch.setattr(zxingcpp, 'read_barcodes', read)
        with pixels(fixture) as image:
            assert not recover(image).observations


def test_forward_model_rejects_unrelated_source_pixels():
    fixture = next(case for case in TARGETS if case['name'].endswith('/motion-blur-2'))
    with pixels(fixture) as image:
        input_ = qr_signal.source(image)
    found = False
    for length in (3, 5, 7, 9, 11, 13, 15):
        with qr_signal.restore(input_, length) as restored:
            for proposal in qr_recovery.find_proposals(restored, monotonic() + .2).proposals:
                if qr_signal.forward_fit(input_, restored, proposal, length):
                    changed = replace(input_, gray=bytes([127]) * len(input_.gray))
                    assert qr_signal.forward_fit(changed, restored, proposal, length) is None
                    found = True
    assert found


def test_exhausted_budget_does_not_call_native(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Native decoding called outside budget')
    monkeypatch.setattr(zxingcpp, 'read_barcodes', forbidden)
    with pixels(TARGETS[0]) as image:
        result = qr_signal.recover(image, deadline=monotonic() - 1)
    assert not result.complete and not result.observations and result.passes == 0


def test_deadline_after_observation_keeps_incomplete_veto(monkeypatch):
    actual, native, elapsed, positive = monotonic, zxingcpp.read_barcodes, 0., False
    def read(image, **options):
        nonlocal elapsed, positive
        result = native(image, **options)
        if positive:
            elapsed = 10
        if result:
            positive = True
        return result
    monkeypatch.setattr(qr_signal, 'monotonic', lambda: actual() + elapsed)
    monkeypatch.setattr(zxingcpp, 'read_barcodes', read)
    with pixels(next(case for case in TARGETS if case['name'].endswith('/motion-blur-2'))) as image:
        result = qr_signal.recover(image, deadline=actual() + 2)
    assert not result.complete and result.observed > 0 and not result.observations


def test_single_optical_threshold_hit_is_withheld_but_keeps_evidence(monkeypatch):
    native, emitted = zxingcpp.read_barcodes, False
    def read(image, **options):
        nonlocal emitted
        result = native(image, **options)
        if emitted or not options.get('is_pure'):
            return []
        if result:
            emitted = True
        return result
    monkeypatch.setattr(zxingcpp, 'read_barcodes', read)
    with pixels(next(case for case in TARGETS if 'qr-upgrade' in case['name'] and case['name'].endswith('/small-in-frame-2'))) as image:
        result = recover(image)
    assert not result.complete and result.observed == 1 and not result.observations


def diagonal(first, second):
    offset = max(first.size) + 20
    side = offset + max(second.size)
    output = Image.new('L', (side, side), 255)
    output.paste(first.convert('L'), (0, 0))
    output.paste(second.convert('L'), (offset, offset))
    return output


def test_separate_physical_labels_preserve_locations_and_conflicts():
    cases = [case for case in TARGETS if 'qr-upgrade' in case['name'] and case['name'].endswith('/motion-blur-2')]
    with pixels(cases[0]) as first, pixels(cases[1]) as other:
        for second in (first, other):
            with diagonal(first, second) as image:
                result = recover(image)
            assert result.complete and len(result.observations) == 2
            assert abs(result.observations[0].points[0][0] - result.observations[1].points[0][0]) > 100
