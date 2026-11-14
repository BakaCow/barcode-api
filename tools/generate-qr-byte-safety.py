"""Freeze QR-heavy byte/format compatibility from known encoder inputs.

No decoder calls or outcome filtering. Raw input bytes are authoritative;
printable ASCII additionally requires exact displayed text. Explicit ECI,
GS1 QR, structured append and damaged finder recovery are not claimed here.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import random
import zlib

from PIL import Image, ImageDraw, ImageFilter
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]
SEED = 841205697


def digest(data):
    return hashlib.sha256(data).hexdigest()


def truth(payload, format_name):
    formats = [format_name]
    if format_name == 'QRCode':
        formats += ['QRCodeModel1', 'QRCodeModel2']
    result = {'bytes': list(payload), 'formats': formats}
    if all(32 <= value <= 126 for value in payload):
        result['text'] = payload.decode('ascii')
    return result


def encode(payload, format_name, ec_level='M'):
    options = {'ec_level': ec_level} if format_name == 'QRCode' else {}
    barcode = zxingcpp.create_barcode(payload, getattr(zxingcpp.BarcodeFormat, format_name), **options)
    if format_name == 'QRCode':
        assert barcode.ec_level == ec_level
    return Image.fromarray(barcode.to_image(scale=3, add_quiet_zones=True)).convert('L')


def case(name, group, image, expected, parameters):
    assert image.width * image.height <= 1_500_000
    with image.convert('RGBA') as rgba:
        return {'name': name, 'groupId': group, 'width': image.width, 'height': image.height,
                'expected': expected, 'parameters': parameters, 'source': 'synthetic',
                'rgba_zlib_base64': base64.b64encode(zlib.compress(rgba.tobytes(), 9)).decode('ascii')}


def ean(first):
    return (first + str((-sum(int(v) * (1 if i % 2 == 0 else 3) for i, v in enumerate(first))) % 10)).encode('ascii')


def prior_payloads():
    values = set()
    for path in sorted((ROOT / 'tests/fixtures').glob('*.json')):
        if path.name == 'qr-byte-safety.json':
            continue
        document = json.loads(path.read_text(encoding='utf-8'))
        for item in document.get('cases', []):
            for expected in item.get('expected', []) if isinstance(item.get('expected'), list) else []:
                if isinstance(expected, dict):
                    if isinstance(expected.get('bytes'), list):
                        values.add(bytes(expected['bytes']))
                    if isinstance(expected.get('text'), str):
                        values.add(expected['text'].encode('utf-8'))
            if isinstance(item.get('expectedBytes'), list):
                values.add(bytes(item['expectedBytes']))
            if isinstance(item.get('encoderBytes'), list):
                values.add(bytes(item['encoderBytes']))
    return values


def generate(output):
    rng = random.Random(SEED)
    token = lambda: str(rng.randrange(10000000, 99999999)).encode('ascii')
    qr = [
        ('ascii', b'QR-FRESH/' + token() + b'/aZ-_%?', 'L'),
        ('numeric', b'0472' + token() + token() + token(), 'M'),
        ('alphanumeric', b'QR CHECK ' + token() + b':ABC%$*+-./', 'Q'),
        ('utf8', b'QR-' + token() + '/caf\u00e9/\u6f22\u5b57/\U0001f9fe'.encode('utf-8'), 'H'),
        ('latin1', b'QR-' + token() + b'/\xa3\xe9\xff', 'M'),
        ('controls', b'QR-' + token() + b'\x00\x01\x1d\x1f\x7f/end', 'Q'),
        ('high-bytes', b'QR-' + token() + bytes([128, 129, 190, 222, 254, 255]), 'H'),
        ('binary-range', b'QR-' + token() + bytes(range(256)), 'M'),
        ('dense-url', b'https://example.invalid/qr-fresh/' + token() + b'?key=' + token() * 8, 'L'),
        ('binary-mixed', b'QR-' + token() + bytes(rng.randrange(256) for _ in range(48)), 'Q'),
    ]
    other = [
        ('code128-ascii', b'FRESH-' + token() + b'/aZ', 'Code128'),
        ('code128-controls', b'FRESH-' + token() + b'\x00\x1d\x80\xff', 'Code128'),
        ('ean13', ean('7' + token().decode() + '281'), 'EAN13'),
        ('ean13-second', ean('5' + token().decode() + '673'), 'EAN13'),
    ]
    payloads = [item[1] for item in qr + other]
    assert len(set(payloads)) == len(payloads)
    assert not set(payloads) & prior_payloads(), 'Fresh payload overlaps an earlier corpus.'
    labels, cases = [], []
    for index, (semantic, payload, ecc) in enumerate(qr):
        group = f'qr-safety-{index + 1}'
        expected = [truth(payload, 'QRCode')]
        image = encode(payload, 'QRCode', ecc)
        params = {'semantic': semantic, 'encoderInputHex': payload.hex(), 'errorCorrection': ecc,
                  'encoderFormat': 'QRCode', 'explicitECI': False}
        labels.append((image, expected, params))
        cases.append(case(f'qr/{group}/clean', group, image, expected, {**params, 'condition': 'clean'}))
        with image.rotate((-1 if index % 2 else 1) * 13, Image.Resampling.BICUBIC, expand=True, fillcolor=255) as rotated:
            cases.append(case(f'qr/{group}/rotated', group, rotated, expected, {**params, 'condition': 'rotated'}))
        with image.resize((round(image.width * .67), round(image.height * .67)), Image.Resampling.LANCZOS) as reduced:
            with Image.new('L', (1100, 700), 255) as scene:
                scene.paste(reduced, (65 + index * 9, 150))
                cases.append(case(f'qr/{group}/small', group, scene, expected, {**params, 'condition': 'small', 'scale': .67}))
        with image.filter(ImageFilter.GaussianBlur(.55)) as blurred:
            cases.append(case(f'qr/{group}/blurred', group, blurred, expected, {**params, 'condition': 'blurred', 'radius': .55}))
    for index, (semantic, payload, format_name) in enumerate(other):
        group = f'mixed-safety-{index + 1}'
        expected = [truth(payload, format_name)]
        image = encode(payload, format_name)
        params = {'semantic': semantic, 'encoderInputHex': payload.hex(), 'encoderFormat': format_name}
        labels.append((image, expected, params))
        cases.append(case(f'other/{group}/clean', group, image, expected, {**params, 'condition': 'clean'}))
        with image.rotate(9, Image.Resampling.BICUBIC, expand=True, fillcolor=255) as rotated:
            cases.append(case(f'other/{group}/rotated', group, rotated, expected, {**params, 'condition': 'rotated'}))
    for index, pair in enumerate(((0, 1), (4, 5), (3, 7), (0, 10), (6, 11), (2, 12))):
        left, right = [labels[i] for i in pair]
        group = f'qr-multiple-{index + 1}'
        with Image.new('L', (max(left[0].width, right[0].width) + 120, left[0].height + right[0].height + 150), 255) as scene:
            scene.paste(left[0], (25, 25)); scene.paste(right[0], (65, left[0].height + 100))
            cases.append(case(f'multiple/{group}/two-labels', group, scene, left[1] + right[1],
                              {'condition': 'separate-labels', 'sourceIndices': pair}))
    for index in range(8):
        group = f'qr-negative-{index + 1}'
        with Image.new('L', (420, 320), 255 if index != 1 else 31) as image:
            draw = ImageDraw.Draw(image)
            if index >= 2:
                # Three finder-like marks alone have no encoded data or valid
                # QR timing/format/data structure. Never manufacture negatives
                # by damaging a valid code that could still error-correct.
                module = 3 + index
                for x, y in ((25, 25), (300 - 7 * module, 25), (25, 250 - 7 * module)):
                    for offset, size, fill in ((0, 7, 0), (1, 5, 255), (2, 3, 0)):
                        draw.rectangle((x + offset * module, y + offset * module,
                                        x + (offset + size) * module - 1, y + (offset + size) * module - 1), fill=fill)
            cases.append(case(f'negative/{group}/unencoded', group, image, [], {'condition': 'blank' if index < 2 else 'finder-only'}))
    for image, _, _ in labels:
        image.close()
    assert len(cases) == 62 and sum(bool(item['expected']) for item in cases) == 54
    document = {'version': 1, 'seed': SEED, 'split': 'qr-byte-safety',
                'description': 'QR-heavy known-input byte/format and multi-label compatibility. No decoder calls or outcome filtering; synthetic images, not phone photographs.',
                'provenance': {'generator': 'tools/generate-qr-byte-safety.py',
                               'generatorSha256': digest(Path(__file__).read_bytes().replace(b'\r\n', b'\n')),
                               'dependencies': {name: importlib.metadata.version(name) for name in ('Pillow', 'zxing-cpp')},
                               'groundTruth': 'Encoder input bytes and format, with exact printable ASCII text. No byte transcoding to fit decoder output.',
                               'grouping': '10 QR payload groups with four variants each; four other-format groups with two variants each; six two-label scenes; eight unencoded negatives.',
                               'coverageLimits': 'No explicit ECI, GS1 QR or structured append. Non-ASCII displayed text is recorded but raw bytes define identity.',
                               'evaluationPolicy': 'Frozen before updated decoder outcomes. Per-case outcomes withheld until implementation freeze.'},
                'cases': cases}
    encoded = (json.dumps(document, separators=(',', ':')) + '\n').encode('utf-8')
    output = Path(output).resolve(); output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and output.read_bytes() != encoded:
        raise ValueError(f'Refusing to overwrite changed frozen fixture: {output}')
    if not output.exists():
        output.write_bytes(encoded)
    print(json.dumps({'cases': len(cases), 'positives': 54, 'negatives': 8, 'sha256': digest(encoded), 'output': str(output)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'tests/fixtures/qr-byte-safety.json')
    generate(parser.parse_args().output)
