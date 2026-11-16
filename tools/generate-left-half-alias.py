"""Generate development EAN-13 labels whose left half spells a valid UPC-E.

This is a development regression set, never a held-out accuracy estimate.
The left half of an EAN-13 is, bar for bar, a checksum-valid number-system-1
UPC-E for about one number in ten. Three groups exercise that:

- alias: the whole label, tilted. A scanline can cross only the left half, but
  the complete EAN-13 is in the image and is the expected value.
- covered: the right half hidden, squarely or by a slanted edge. The image then
  holds what is a complete UPC-E symbol, and no value is expected.
- upce-system-1: a real number-system-1 UPC-E label. It cannot be told from a
  covered EAN-13, so no value is expected while EAN-13 is being read.

Expected values are for a read that includes EAN-13. With EAN-13 excluded,
every image is expected to give the UPC-E named in its parameters. Truth is the
independent encoder input; the UPC-E each left half spells is derived below
from the UPC-E expansion rules and fixed before decoding, not taken from any
decoder output. No scanner is called here.
"""
import base64
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import zlib

from PIL import Image, ImageDraw
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]
# One EAN-13 for each UPC-E expansion rule: sixth left digit 0-2, 3, 4 and 5-9.
ALIASES = [('5067751808601', '0106100007755'), ('4001753562476', '0100100000754'),
           ('4019984607026', '0101990000084'), ('9364168251423', '0136416000089')]
# A real number-system-1 UPC-E label and its expanded value.
REAL_UPCE = ('15766746', '0157660000076')
SCALE = 3
# Modules from the first bar: start guard 3, six digits 42, centre guard 5 and
# one module of the first right-hand digit, which is always a bar. Those 51
# modules are, bar for bar, a complete UPC-E symbol.
COVERED_FROM = 51


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


def encoded(text, format_, angle=0):
    with Image.fromarray(zxingcpp.create_barcode(text, format_).to_image(scale=SCALE, add_quiet_zones=True)) as clean:
        return clean.convert('L').rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=255)


def covered(ean, slant):
    """Paint white over everything right of COVERED_FROM; `slant` leans the cover's edge, in degrees."""
    image = encoded(ean, zxingcpp.BarcodeFormat.EAN13)
    first_bar = image.point(lambda value: 255 - value).getbbox()[0]
    edge, lean = first_bar + COVERED_FROM * SCALE, math.tan(math.radians(slant)) * image.height
    ImageDraw.Draw(image).polygon([(edge - lean / 2, 0), (image.width, 0), (image.width, image.height),
                                   (edge + lean / 2, image.height)], fill=255)
    return image


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
                                  {'input': ean, 'angle': angle, 'upceWithoutEan13': alias}))
    for ean, alias in ALIASES:
        for slant in [0, 30]:
            with covered(ean, slant) as image:
                cases.append(case(f'covered/{ean}/edge-{slant}', image, [],
                                  {'input': ean, 'coveredFromModule': COVERED_FROM, 'edgeSlant': slant,
                                   'upceWithoutEan13': alias}))
    text, expanded = REAL_UPCE
    for angle in [30, 45, 60]:
        with encoded(text, zxingcpp.BarcodeFormat.UPCE, angle) as image:
            cases.append(case(f'upce-system-1/{text}/angle-{angle}', image, [],
                              {'input': text, 'angle': angle, 'upceWithoutEan13': expanded}))
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
