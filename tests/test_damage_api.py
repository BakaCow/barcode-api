"""Real pixel regressions discovered by the damaged-barcode stress run."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import zlib

from PIL import Image
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
