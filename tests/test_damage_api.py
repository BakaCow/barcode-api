"""Real pixel regressions discovered by the damaged-barcode stress run."""
import base64
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import zlib

from PIL import Image, ImageOps
import pytest
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def reader(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    import barcode_reader
    return barcode_reader


@pytest.mark.parametrize(('corpus_name', 'case_name'), [
    ('dev', 'ean13/dev-ean13-label-3/clipping-2'),
    ('eval', 'negative/invalid-ean13-checksum/3'),
    ('eval', 'negative/invalid-ean13-checksum/5'),
])
def test_damaged_ean13_is_not_reinterpreted_as_a_different_valid_code(reader, corpus_name, case_name):
    # The first evaluation exposed another false read and is now debugging data.
    # A separate, subsequently frozen verification set measures the final change.
    corpus = json.loads((ROOT / f'tests/fixtures/damage-stress-{corpus_name}.json').read_text())
    case = next(item for item in corpus['cases'] if item['name'] == case_name)
    pixels = zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))
    with Image.frombytes('RGBA', (case['width'], case['height']), pixels) as rgba:
        with rgba.convert('RGB') as image:
            found = reader.read_barcodes(image)
    assert not found, 'Damaged EAN-13 previously became an unrelated ITF, Codabar or checksum-valid UPC-E after rotation.'


@pytest.mark.parametrize('format_', [zxingcpp.BarcodeFormat.ITF, zxingcpp.BarcodeFormat.Code39])
def test_unchecked_formats_still_work_on_the_original_image(reader, monkeypatch, format_):
    payload = '12345678'
    encoded = zxingcpp.create_barcode(payload, format_)
    native = zxingcpp.read_barcodes
    calls = []

    def observed(image, **options):
        calls.append(options)
        return native(image, **options)

    monkeypatch.setattr(zxingcpp, 'read_barcodes', observed)
    with Image.fromarray(encoded.to_image(scale=3, add_quiet_zones=True)) as image:
        found = reader.read_barcodes(image)
    assert [code.text for code in found] == [payload]
    assert calls == [{}], 'The untouched first pass keeps all supported formats.'


@pytest.mark.parametrize('case_name', [
    'qr/dev-qr-label-1/scratches-1',
    'qr/dev-qr-label-2/blur-2',
    'code128/dev-code128-label-1/angled-1',
    'code128/dev-code128-label-3/angled-2',
    'ean13/dev-ean13-label-1/motion-blur-1',
    'ean13/dev-ean13-label-3/blur-2',
])
def test_recovery_reads_previously_missed_blurred_scratched_and_oblique_labels(reader, case_name):
    corpus = json.loads((ROOT / 'tests/fixtures/damage-stress-dev.json').read_text())
    case = next(item for item in corpus['cases'] if item['name'] == case_name)
    pixels = zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))
    with Image.frombytes('RGBA', (case['width'], case['height']), pixels) as rgba:
        with rgba.convert('RGB') as image:
            assert not zxingcpp.read_barcodes(image), 'The original pass must miss this regression.'
            expected = case['expected'][0]
            found = reader.read_barcodes(image)
            assert [(code.text, code.format.name) for code in found] == [(expected['text'], expected['formats'][0])]
            assert found[0].bytes == expected['text'].encode()
            assert all(0 <= x <= image.width and 0 <= y <= image.height for x, y in found[0].points)


@pytest.mark.parametrize('angle', [-73, -19, 17, 68])
def test_adaptive_deskew_maps_to_original_source_bars(reader, monkeypatch, angle):
    # Independently encode and rotate a new payload; do not validate the
    # implementation using its own affine transformation helper.
    text = f'OBLIQUE-ITEM-{abs(angle)}'
    encoded = zxingcpp.create_barcode(text, zxingcpp.BarcodeFormat.Code128)
    rotations, decoded_images = [], []
    rotate, native_read = reader._rotated, zxingcpp.read_barcodes

    def observe_rotation(image, rotation=45):
        candidate, mapping = rotate(image, rotation)
        rotations.append((rotation, candidate))
        return candidate, mapping

    def observe_decode(image, **options):
        decoded_images.append(image)
        return native_read(image, **options)

    monkeypatch.setattr(reader, '_rotated', observe_rotation)
    monkeypatch.setattr(zxingcpp, 'read_barcodes', observe_decode)
    with Image.fromarray(encoded.to_image(scale=3, add_quiet_zones=True)) as clean:
        with clean.rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=255) as image:
            assert not native_read(image), 'This independently generated label must require recovery.'
            found = reader.read_barcodes(image, allowed_formats=['code128'])
            assert [code.text for code in found] == [text]
            assert len(rotations) == 2 and rotations[-1][0] != 45
            assert decoded_images[-1] is rotations[-1][1], 'The actual adaptive rotation must supply the successful decode.'
            with clean.convert('L') as gray, ImageOps.invert(gray) as ink:
                left, top, right, bottom = ink.getbbox()
            c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
            for x, y in found[0].points:
                dx, dy = x + 0.5 - image.width / 2, y + 0.5 - image.height / 2
                sx, sy = c * dx - s * dy + clean.width / 2 - 0.5, s * dx + c * dy + clean.height / 2 - 0.5
                assert left - 3 <= sx <= right + 3
                assert top - 3 <= sy <= bottom + 3


def test_new_recovery_passes_keep_the_requested_format_allowlist(reader, monkeypatch):
    calls = []
    monkeypatch.setattr(reader, 'monotonic', lambda: 0.0)
    monkeypatch.setattr(zxingcpp, 'read_barcodes', lambda image, **options: calls.append(options) or [])
    with Image.new('L', (120, 120), 255) as image:
        assert reader.read_barcodes(image, allowed_formats=['qr']) == []
    assert len(calls) == 9, 'Blank input skips only the coherent-angle deskew.'
    assert all(options['formats'] == zxingcpp.BarcodeFormats([zxingcpp.BarcodeFormat.QRCode]) for options in calls)


def test_damage_benchmark_reports_truthfully_and_rejects_wrong_truth(tmp_path):
    corpus = json.loads((ROOT / 'tests/fixtures/damage-stress-dev.json').read_text())
    sample = next(case for case in corpus['cases'] if case['name'] == 'qr/dev-qr-label-1/clean-0')
    sample['expected'] = [{'text': 'intentionally-wrong-truth', 'formats': ['QRCode']}]
    fixture = tmp_path / 'wrong-truth.json'
    fixture.write_text(json.dumps({'version': 1, 'cases': [sample]}))
    output = tmp_path / 'report.json'
    result = subprocess.run([sys.executable, str(ROOT / 'tools/benchmark-damage-api.py'), '--corpus', str(fixture), '--output', str(output)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 1, result.stderr
    report = json.loads(output.read_text())
    assert report['summary']['exactPositiveReads'] == 0
    assert report['summary']['unexpectedResults'] == 1
    assert report['cases'][0]['missing'] == ['intentionally-wrong-truth']
