"""QR fallback exercises real pixels, encoder bytes and complete region checks."""
import base64
import json
from pathlib import Path
from time import monotonic
import zlib

from PIL import Image
import pytest
import zxingcpp

import barcode_reader as reader
import qr_recovery

ROOT = Path(__file__).resolve().parents[1]


def encoded(payload, scale=4):
    return Image.fromarray(zxingcpp.create_barcode(payload, zxingcpp.BarcodeFormat.QRCode).to_image(
        scale=scale, add_quiet_zones=True)).convert('L')


def montage(payloads):
    images = [encoded(payload) for payload in payloads]
    result = Image.new('L', (sum(image.width for image in images) + 40 * (len(images) + 1),
                             max(image.height for image in images) + 80), 255)
    left = 40
    for image in images:
        result.paste(image, (left, 40)); left += image.width + 40; image.close()
    return result


def recover(image):
    return reader._recover_qr(image, lambda x, y: (x, y), image.size, ['qr'], monotonic())


@pytest.mark.parametrize('number', [1, 2, 3])
def test_measured_module_deblur_recovers_existing_development_failures(number):
    cases = json.loads((ROOT / 'tests/fixtures/damage-stress-recovery.json').read_text())['cases']
    case = next(case for case in cases if case['name'] == f'qr/recovery-qr-label-{number}/blur-2')
    with Image.frombytes('RGBA', (case['width'], case['height']),
                         zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))) as rgba:
        with rgba.convert('L') as image:
            assert zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.QRCode) == []
            results = reader.read_barcodes(image, allowed_formats=['qr'])
    assert [(result.format.name, result.bytes) for result in results] == [
        ('QRCode', case['expected'][0]['text'].encode('utf-8'))]
    assert all(20 <= x <= 113 and 20 <= y <= 113 for x, y in results[0].points)


@pytest.mark.parametrize('payload', [b'QR-DEV-ASCII-0000', b'QR-DEV-\x00\x1d\x7f',
                                      b'QR-DEV-\x80\xbe\xff', 'QR-DEV-日本語-café', bytes(range(32))])
def test_new_grid_path_preserves_native_bytes_and_presentation(monkeypatch, payload):
    native = zxingcpp.read_barcodes
    with encoded(payload) as image:
        expected = native(image)[0]
        monkeypatch.setattr(zxingcpp, 'read_barcodes', lambda image, **options:
                            native(image, **options) if options.get('is_pure') else [])
        results = reader.read_barcodes(image, allowed_formats=['qr'])
    assert [(record.bytes, record.text, record.format.name) for record in results] == [
        (expected.bytes, expected.text, expected.format.name)]


def test_all_detected_labels_survive_recovery_and_original_coordinates():
    with montage([b'QR-DEV-MULTI-ONE', b'QR-DEV-MULTI-TWO']) as image:
        results = recover(image)
    assert {record.bytes for record in results} == {b'QR-DEV-MULTI-ONE', b'QR-DEV-MULTI-TWO'}
    centers = sorted(sum(x for x, _ in record.points) / 4 for record in results)
    assert centers[1] - centers[0] > 100


def test_same_payload_at_separate_positions_preserves_both_physical_labels():
    with montage([b'QR-DEV-DUPLICATE', b'QR-DEV-DUPLICATE']) as image:
        results = recover(image)
    assert [record.bytes for record in results] == [b'QR-DEV-DUPLICATE'] * 2
    centers = sorted(sum(x for x, _ in record.points) / 4 for record in results)
    assert centers[1] - centers[0] > 100


def test_unreadable_proposal_cannot_turn_another_crop_into_unique_acceptance(monkeypatch):
    native = zxingcpp.read_barcodes
    monkeypatch.setattr(zxingcpp, 'read_barcodes', lambda image, **options:
                        [code for code in native(image, **options) if code.bytes != b'QR-DEV-UNREADABLE'])
    with montage([b'QR-DEV-READABLE', b'QR-DEV-UNREADABLE']) as image:
        assert recover(image) == []


def test_region_overflow_is_reported_and_abstains():
    with montage([f'QR-DEV-REGION-{number}'.encode() for number in range(4)]) as image:
        search = qr_recovery.find_proposals(image, monotonic() + 2.5)
        assert not search.complete
        assert len(search.proposals) == 3
        assert recover(image) == []


def test_no_qr_allowed_never_runs_qr_geometry(monkeypatch):
    monkeypatch.setattr(qr_recovery, 'find_proposals', lambda *args, **kwargs: pytest.fail('QR not allowed'))
    with Image.new('L', (100, 100), 255) as image:
        assert reader._recover_qr(image, None, image.size, ['code128'], monotonic()) == []


def test_deadline_and_input_size_are_bounded():
    with encoded(b'QR-DEV-BUDGET') as image:
        assert not qr_recovery.find_proposals(image, monotonic() - 1).complete
        assert reader._recover_qr(image, None, image.size, ['qr'], monotonic() - 3) == []
    with Image.new('L', (2001, 2000)) as image:
        with pytest.raises(ValueError, match='bounded grayscale'):
            qr_recovery.find_proposals(image, monotonic() + 2.5)


def test_partial_recovery_deadline_abstains(monkeypatch):
    native = zxingcpp.read_barcodes
    expired = False
    start = monotonic()
    def decode(image, **options):
        nonlocal expired
        found = native(image, **options)
        expired = True
        return found
    monkeypatch.setattr(zxingcpp, 'read_barcodes', decode)
    monkeypatch.setattr(reader, 'monotonic', lambda: start + (3 if expired else 0))
    with encoded(b'QR-DEV-TIMEOUT') as image:
        assert reader._recover_qr(image, lambda x, y: (x, y), image.size, ['qr'], start) == []


def test_nearby_label_cannot_satisfy_another_proposal():
    with encoded(b'QR-DEV-GEOMETRY') as image:
        proposal = qr_recovery.find_proposals(image, monotonic() + 2.5).proposals[0]
        points = [proposal.point(x, y) for x, y in [(0, 0), (21, 0), (21, 21), (0, 21)]]
        assert proposal.contains_symbol(points)
        assert not proposal.contains_symbol([(x + 100, y) for x, y in points])
        assert not proposal.contains_symbol([points[0]] * 4)


def test_nested_unreadable_label_does_not_become_unique_crop_acceptance():
    outer = zxingcpp.create_barcode('QR-DEV-NESTED-' + 'ABCDEFGH' * 20,
                                    zxingcpp.BarcodeFormat.QRCode, ec_level='H')
    with Image.fromarray(outer.to_image(scale=6, add_quiet_zones=True)).convert('L') as image:
        with encoded(b'QR-DEV-INNER', scale=2) as inner:
            image.paste(inner, ((image.width - inner.width) // 2, (image.height - inner.height) // 2))
        results = recover(image)
    # A readable inset must not silently hide a different outer proposal.
    assert not results or len({record.bytes for record in results}) >= 2
