"""Generate development EAN-13 labels whose left half spells a valid UPC-E.

This is a development regression set, never a held-out accuracy estimate.
A tilted EAN-13 can be crossed from its start guard to its centre guard only;
for about one number in ten those bars are a checksum-valid number-system-1
UPC-E. Expected values are the independent encoder inputs. The UPC-E each left
half spells is derived below from the UPC-E expansion rules and fixed before
decoding, not taken from any decoder output. No scanner is called here.
"""
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import zlib

from PIL import Image
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]
# One EAN-13 for each UPC-E expansion rule: sixth left digit 0-2, 3, 4 and 5-9.
ALIASES = [('5067751808601', '0106100007755'), ('4001753562476', '0100100000754'),
           ('4019984607026', '0101990000084'), ('9364168251423', '0136416000089')]
# A real number-system-1 UPC-E label and its expanded value. It must stay a UPC-E.
REAL_UPCE = ('15766746', '0157660000076')


def left_half_upce(ean):
    """Expand the six left digits as a number-system-1 UPC-E; None unless its check digit is the EAN's first digit."""
    first, (a, b, c, d, e, f) = ean[0], ean[1:7]
    if f in '012':
        body = '1' + a + b + f + '0000' + c + d + e
    elif f == '3':
        body = '1' + a + b + c + '00000' + d + e
    elif f == '4':
        body = '1' + a + b + c + d + '00000' + e
    else:
        body = '1' + a + b + c + d + e + '0000' + f
    total = sum(int(digit) * (3 if index % 2 == 0 else 1) for index, digit in enumerate(reversed(body)))
    return '0' + body + first if first != '0' and (10 - total % 10) % 10 == int(first) else None


def encoded(text, format_, angle):
    with Image.fromarray(zxingcpp.create_barcode(text, format_).to_image(scale=3, add_quiet_zones=True)) as clean:
        return clean.convert('L').rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=255)


def case(name, image, expected, parameters):
    with image.convert('RGBA') as rgba:
        return {'name': name, 'width': rgba.width, 'height': rgba.height,
                'rgba_zlib_base64': base64.b64encode(zlib.compress(rgba.tobytes(), 9)).decode(),
                'expected': expected, 'parameters': parameters}


def generate():
    cases = []
    for ean, alias in ALIASES:
        assert left_half_upce(ean) == alias
        for angle in [-45, 30, 45, 60]:
            with encoded(ean, zxingcpp.BarcodeFormat.EAN13, angle) as image:
                cases.append(case(f'alias/{ean}/angle-{angle}', image, [{'text': ean, 'formats': ['EAN13']}],
                                  {'input': ean, 'angle': angle, 'leftHalfUpce': alias}))
    text, expanded = REAL_UPCE
    for angle in [30, 45, 60]:
        with encoded(text, zxingcpp.BarcodeFormat.UPCE, angle) as image:
            cases.append(case(f'upce-system-1/{text}/angle-{angle}', image, [{'text': expanded, 'formats': ['UPCE']}],
                              {'input': text, 'angle': angle}))
    document = {'version': 1, 'description': __doc__.strip(),
                'provenance': {'generator': 'tools/generate-left-half-alias.py',
                               'sourceSha256': hashlib.sha256(Path(__file__).read_text().replace('\r\n', '\n').encode()).hexdigest(),
                               'versions': {name: importlib.metadata.version(name) for name in ['zxing-cpp', 'Pillow']},
                               'truth': 'Independent encoder inputs; left-half UPC-E values fixed from the expansion rules before decoding.'},
                'cases': cases}
    output = ROOT / 'tests/fixtures/ean-left-half-alias.json'
    data = (json.dumps(document, separators=(',', ':')) + '\n').encode()
    output.write_bytes(data)
    print(json.dumps({'cases': len(cases), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))


if __name__ == '__main__':
    generate()
