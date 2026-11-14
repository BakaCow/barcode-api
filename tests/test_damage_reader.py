"""Production reader keeps exact source evidence and rejects the known UPC-E alias."""
import base64
import json
from pathlib import Path
import zlib

from PIL import Image
import pytest
import zxingcpp

import barcode_reader


ROOT = Path(__file__).resolve().parents[1]


def test_damaged_ean_is_not_published_as_the_known_wrong_upce():
    case = next(case for case in json.loads((ROOT / 'tests/fixtures/damage-stress-signal-upgrade.json').read_text())['cases']
                if case['name'] == 'ean13/signal-upgrade-ean13-label-1/missing-patch-1')
    with Image.frombytes('RGBA', (case['width'], case['height']), zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))) as image:
        unrestricted = barcode_reader.read_barcodes(image)
        expected = case['expected'][0]['text'].encode()
        assert all(code.format.name == 'EAN13' and code.bytes == expected for code in unrestricted)
        restricted = barcode_reader.read_barcodes(image, allowed_formats=['ean13'])
        assert [(code.format.name, code.bytes) for code in restricted] == [('EAN13', expected)]


@pytest.mark.parametrize('payload', ['04252614', '15766746'])
def test_genuine_upce_first_pass_preserves_native_bytes_when_ean_is_also_allowed(payload):
    encoded = zxingcpp.create_barcode(payload, zxingcpp.BarcodeFormat.UPCE)
    with Image.fromarray(encoded.to_image(scale=3, add_quiet_zones=True)).convert('L') as image:
        original = zxingcpp.read_barcodes(image)
        assert len(original) == 1 and original[0].format.name == 'UPCE'
        for formats in (None, ['upce'], ['upce', 'ean13']):
            found = barcode_reader.read_barcodes(image, allowed_formats=formats)
            assert [(code.format.name, code.bytes) for code in found] == [('UPCE', original[0].bytes)]
