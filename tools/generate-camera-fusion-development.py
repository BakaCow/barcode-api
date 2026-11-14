"""Deterministic development camera sequence; no decoder calls or outcome selection.

Three independent opaque white occlusions cover disjoint 10x10-module patches.
The alternate source differs by one payload character and tests label switching.
These are simulated exposures, not Android/iPhone camera measurements.
"""
import base64
import json
from pathlib import Path
import zlib

from PIL import Image, ImageDraw
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]
TEXT = 'CAMERA-FUSION-SOURCE-PIXELS-' + ''.join(str((i * 7 + 3) % 10) for i in range(130))
PATCHES = [[10, 10, 10, 10], [20, 10, 10, 10], [10, 20, 10, 10]]


def encoded(text):
    barcode = zxingcpp.create_barcode(text, zxingcpp.BarcodeFormat.QRCode, ec_level='L')
    return Image.fromarray(barcode.to_image(scale=4, add_quiet_zones=True)).convert('RGBA')


def pixels(image):
    return {'width': image.width, 'height': image.height,
            'rgba_zlib_base64': base64.b64encode(zlib.compress(image.tobytes(), 9)).decode('ascii')}


def frames(image):
    output = []
    for x, y, width, height in PATCHES:
        damaged = image.copy()
        ImageDraw.Draw(damaged).rectangle(((x + 4) * 4, (y + 4) * 4,
                                          (x + 4 + width) * 4 - 1, (y + 4 + height) * 4 - 1), fill='white')
        output.append(pixels(damaged))
    return output


if __name__ == '__main__':
    clean = encoded(TEXT)
    alternate_text = TEXT[:-1] + ('7' if TEXT[-1] != '7' else '8')
    alternate = encoded(alternate_text)
    assert clean.size == alternate.size == (164, 164)
    document = {'description': __doc__, 'text': TEXT, 'dimension': 33, 'ecLevel': 'L', 'scale': 4,
                'patchModules': PATCHES, 'frames': frames(clean), 'clean': pixels(clean),
                'alternateText': alternate_text, 'alternateFrames': frames(alternate), 'alternateClean': pixels(alternate)}
    (ROOT / 'tests/fixtures/camera-fusion-development.json').write_text(json.dumps(document) + '\n', encoding='utf-8', newline='\n')
