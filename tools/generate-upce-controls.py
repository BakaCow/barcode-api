"""Generate development UPC-E controls from independent encoder inputs.

This is a development regression set, never a held-out accuracy estimate.
Expected expanded GTIN text is specified from the UPC-E expansion rules and
known check digits, not from any decoder output. No scanner is called here.
"""
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import zlib

from PIL import Image, ImageOps
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]
VALUES = [('04252614', '0042100005264'), ('01234565', '0012345000065'), ('01200003', '0012000000003')]


def encoded(text, format_, angle=0):
    with Image.fromarray(zxingcpp.create_barcode(text, format_).to_image(scale=4, add_quiet_zones=True)) as clean:
        return clean.rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=255)


def case(name, image, expected, parameters):
    with image.convert('RGBA') as rgba:
        return {'name': name, 'width': rgba.width, 'height': rgba.height,
                'rgba_zlib_base64': base64.b64encode(zlib.compress(rgba.tobytes(), 9)).decode(),
                'expected': expected, 'parameters': parameters}


def generate():
    cases = []
    for text, expanded in VALUES:
        for angle in [0, 15, 30, 45, 60, 75, 90]:
            with encoded(text, zxingcpp.BarcodeFormat.UPCE, angle) as image:
                cases.append(case(f'upce/{text}/angle-{angle}', image,
                                  [{'text': expanded, 'formats': ['UPCE']}], {'input': text, 'angle': angle}))
    for ean_angle, upce_angle in [(0, 0), (0, 30), (0, 60), (30, 30), (-30, 30), (60, 0)]:
        text, expanded = VALUES[0]
        with encoded('4006381333931', zxingcpp.BarcodeFormat.EAN13, ean_angle) as ean, encoded(text, zxingcpp.BarcodeFormat.UPCE, upce_angle) as upce:
            with Image.new('L', (ean.width + upce.width + 140, max(ean.height, upce.height) + 80), 255) as image:
                image.paste(ean, (30, 40)); image.paste(upce, (ean.width + 110, 40))
                cases.append(case(f'pair/ean-{ean_angle}/upce-{upce_angle}', image,
                                  [{'text': '4006381333931', 'formats': ['EAN13']}, {'text': expanded, 'formats': ['UPCE']}],
                                  {'eanInput': '4006381333931', 'upceInput': text, 'eanAngle': ean_angle, 'upceAngle': upce_angle}))
    with encoded(VALUES[0][0], zxingcpp.BarcodeFormat.UPCE) as first, encoded(VALUES[1][0], zxingcpp.BarcodeFormat.UPCE, 30) as second:
        with Image.new('L', (first.width + second.width + 140, max(first.height, second.height) + 80), 255) as image:
            image.paste(first, (30, 40)); image.paste(second, (first.width + 110, 40))
            cases.append(case('pair/two-upce', image, [{'text': text, 'formats': ['UPCE']} for _, text in VALUES[:2]], {}))
    document = {'version': 1, 'description': __doc__.strip(),
                'provenance': {'generator': 'tools/generate-upce-controls.py',
                               'sourceSha256': hashlib.sha256(Path(__file__).read_text().replace('\r\n', '\n').encode()).hexdigest(),
                               'versions': {name: importlib.metadata.version(name) for name in ['zxing-cpp', 'Pillow']},
                               'truth': 'Independent encoder inputs; UPC-E expansion table fixed before decoding.'}, 'cases': cases}
    output = ROOT / 'tests/fixtures/upce-controls.json'
    data = (json.dumps(document, separators=(',', ':')) + '\n').encode()
    output.write_bytes(data)
    print(json.dumps({'cases': len(cases), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}))


if __name__ == '__main__':
    generate()
