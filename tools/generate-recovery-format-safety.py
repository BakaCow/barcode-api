"""Freeze independent valid UPC-E and multi-label compatibility examples.

Expected identifiers come from encoder inputs and UPC expansion arithmetic,
never decoding predictions. No examples are filtered by decoder outcomes.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import random
import zlib

from PIL import Image, ImageOps
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]
SEED = 618092437


def check_digit(body):
    return str((-sum(int(digit) * (3 if index % 2 == 0 else 1)
                     for index, digit in enumerate(reversed(body)))) % 10)


def upce_payload(number_system, digits):
    a, b, c, d, e, last = digits
    if last in '012':
        body = number_system + a + b + last + '0000' + c + d + e
    elif last == '3':
        body = number_system + a + b + c + '00000' + d + e
    elif last == '4':
        body = number_system + a + b + c + d + '00000' + e
    else:
        body = number_system + a + b + c + d + e + '0000' + last
    checksum = check_digit(body)
    return number_system + digits + checksum, '0' + body + checksum


def label(text, format_):
    encoded = zxingcpp.create_barcode(text, format_)
    return ImageOps.expand(Image.fromarray(encoded.to_image(scale=3, add_quiet_zones=True)).convert('L'), border=16, fill=255)


def encode_case(name, group, image, expected, parameters):
    return {'name': name, 'groupId': group, 'condition': parameters['condition'],
            'severity': 0, 'source': 'synthetic', 'width': image.width, 'height': image.height,
            'expected': expected, 'parameters': parameters,
            'rgba_zlib_base64': base64.b64encode(zlib.compress(image.convert('RGBA').tobytes(), 9)).decode('ascii')}


def generate(output):
    rng = random.Random(SEED)
    cases = []
    for number_system in ('0', '1'):
        for last in ('0', '1', '2', '3', '4', '5', '9'):
            # Nonzero canonical manufacturer/product digits avoid equivalent
            # representations from a different zero-suppression branch.
            digits = ''.join(str(rng.randrange(3, 10)) for _ in range(5)) + last
            compressed, expanded = upce_payload(number_system, digits)
            body = '9' + ''.join(str(rng.randrange(10)) for _ in range(11))
            ean = body + check_digit(body)
            group = f'recovery-format-{number_system}-{last}'
            expected = [{'text': expanded, 'formats': ['UPCE']}]
            with label(compressed, zxingcpp.BarcodeFormat.UPCE) as clean:
                cases.append(encode_case(f'upce/{group}/clean', group, clean, expected,
                                         {'condition': 'clean', 'encoderInput': compressed, 'expandedIdentifier': expanded}))
                angle = 13 if int(last) % 2 else -19
                with clean.rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=255) as angled:
                    cases.append(encode_case(f'upce/{group}/angled', group, angled, expected,
                                             {'condition': 'angled', 'encoderInput': compressed, 'angleDegrees': angle}))
                    with label(ean, zxingcpp.BarcodeFormat.EAN13) as second:
                        canvas = Image.new('L', (angled.width + second.width + 80,
                                               max(angled.height, second.height) + 64), 255)
                        with canvas:
                            canvas.paste(angled, (16, 16))
                            canvas.paste(second, (angled.width + 64, 32))
                            cases.append(encode_case(f'multiple/{group}/upce-ean13', group, canvas,
                                                     expected + [{'text': ean, 'formats': ['EAN13']}],
                                                     {'condition': 'separate-labels', 'upceInput': compressed,
                                                      'ean13Input': ean, 'upceAngleDegrees': angle}))
    assert len(cases) == 42
    document = {'version': 1, 'seed': SEED, 'split': 'recovery-format-safety',
                'description': 'Valid independently encoded UPC-E in both number systems and all zero-suppression families, alone/rotated/beside a separate EAN-13. Synthetic compatibility evidence, not camera photographs.',
                'provenance': {'generator': 'tools/generate-recovery-format-safety.py',
                               'generatorSha256': hashlib.sha256(Path(__file__).read_bytes().replace(b'\r\n', b'\n')).hexdigest(),
                               'dependencies': {name: importlib.metadata.version(name) for name in ('Pillow', 'zxing-cpp')},
                               'evaluationPolicy': 'Freeze before updated outcomes are inspected. No decoder calls or outcome filtering. Separate from algorithm-development tests.',
                               'groundTruth': 'UPC-E expansion and GS1 check-digit arithmetic on encoder inputs; EAN13 encoder inputs. Native decoder outputs never define expected identifiers.',
                               'groups': 14, 'casesPerGroup': 3}, 'cases': cases}
    encoded = (json.dumps(document, separators=(',', ':')) + '\n').encode()
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and output.read_bytes() != encoded:
        raise ValueError(f'Refusing to overwrite changed frozen fixture: {output}')
    if not output.exists(): output.write_bytes(encoded)
    print(json.dumps({'cases': len(cases), 'groups': 14, 'sha256': hashlib.sha256(encoded).hexdigest(), 'output': str(output)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'tests/fixtures/recovery-format-safety.json')
    generate(parser.parse_args().output)
