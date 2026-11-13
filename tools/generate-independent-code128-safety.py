"""Freeze Code 128 semantic safety images from encoder inputs, never predictions.

Pattern table adapted from the existing project Code 128 table (ZXing-C++
ODCode128Patterns.h; Copyright 2016 Nu-book Inc. and ZXing authors, Apache-2.0).
See web/engine/THIRD-PARTY.txt and web/vendor/ZXING-CPP-LICENSE.txt.
Rendering, manually selected code-set paths and test payloads are project code.
FNC4/SHIFT semantics were cross-checked against the independent Zint encoder:
https://github.com/zint/zint/blob/master/backend/code128.c
No decoder is called, and no outcome filtering selects images.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import random
import zlib

from PIL import Image, ImageDraw, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SEED = 923761059
PATTERNS = (
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112',
)


def a_words(data):
    assert all(0 <= byte < 96 for byte in data)
    return [byte - 32 if byte >= 32 else byte + 64 for byte in data]


def b_words(data):
    assert all(32 <= byte <= 127 for byte in data)
    return [byte - 32 for byte in data]


def c_words(data):
    assert len(data) % 2 == 0 and data.isdigit()
    return [int(data[i:i + 2]) for i in range(0, len(data), 2)]


def checksum(words):
    return (words[0] + sum(index * word for index, word in enumerate(words[1:], 1))) % 103


def render(words, invalid=False):
    assert words[0] in (103, 104, 105) and all(0 <= word <= 102 for word in words[1:])
    check = checksum(words)
    sequence = words + [((check + 1) % 103) if invalid else check, 106]
    module, quiet = 3, 12
    width = (sum(sum(map(int, PATTERNS[word])) for word in sequence) + quiet * 2) * module
    image = Image.new('L', (width, 140), 255)
    draw, x = ImageDraw.Draw(image), quiet * module
    for word in sequence:
        dark = True
        for count in map(int, PATTERNS[word]):
            if dark:
                draw.rectangle((x, 16, x + count * module - 1, 123), fill=0)
            x += count * module
            dark = not dark
    return image, sequence


def specifications(rng):
    suffix = str(rng.randrange(100000, 999999)).encode('ascii')
    data = b'IV-A-' + suffix + bytes([0, 1, 31])
    yield 'set-a-controls', data, [103] + a_words(data), False
    data = b'Iv-b_' + suffix + b'|?!=~'
    yield 'set-b-printable', data, [104] + b_words(data), True
    data = ''.join(str(rng.randrange(10)) for _ in range(24)).encode('ascii')
    yield 'set-c-numeric', data, [105] + c_words(data), True
    digits = ''.join(str(rng.randrange(10)) for _ in range(12)).encode('ascii')
    data = b'Iv:' + digits + b':end'
    yield 'b-c-b-switch', data, [104] + b_words(b'Iv:') + [99] + c_words(digits) + [100] + b_words(b':end'), True
    data = b'Iv-shift-' + suffix + bytes([2]) + b'xy'
    yield 'b-a-shift', data, [104] + b_words(b'Iv-shift-' + suffix) + [98, 66] + b_words(b'xy'), False
    data = b'IV-SHIFT-' + suffix + b'q' + bytes([3])
    yield 'a-b-shift', data, [103] + a_words(b'IV-SHIFT-' + suffix) + [98, ord('q') - 32, 67], False
    gtin_body = '9' + ''.join(str(rng.randrange(10)) for _ in range(12))
    check = str((-sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(gtin_body)))) % 10)
    prefix = ('01' + gtin_body + check + '10').encode('ascii')
    lot, serial = b'IVLOT-' + suffix, b'21' + suffix[::-1]
    data = prefix + lot + bytes([29]) + serial
    yield 'gs1-fnc1', data, [105, 102] + c_words(prefix) + [100] + b_words(lot) + [102] + b_words(serial), False
    data = b'IV-GS-' + suffix + bytes([29]) + b'next'
    yield 'internal-fnc1', data, [104] + b_words(b'IV-GS-' + suffix) + [102] + b_words(b'next'), False
    prefix, high = b'IV-HB-' + suffix, bytes([201, 233, 250])
    data = prefix + high + b'Q'
    yield 'fnc4-single-b', data, [104] + b_words(prefix) + [word for byte in high for word in (100, byte - 160)] + b_words(b'Q'), False
    prefix, high = b'IV-HA-' + suffix, bytes([129, 150, 158])
    data = prefix + high + b'R'
    yield 'fnc4-single-a', data, [103] + a_words(prefix) + [word for byte in high for word in (101, byte - 64)] + a_words(b'R'), False
    prefix, first, last = b'IV-LATCH-' + suffix, bytes([200, 217, 234]), bytes([241, 254])
    data = prefix + first + b'X' + last + b'-END'
    words = [104] + b_words(prefix) + [100, 100] + [b - 160 for b in first] + [100, ord('X') - 32] + [b - 160 for b in last] + [100, 100] + b_words(b'-END')
    yield 'fnc4-latch-b', data, words, False
    data = b'ticket|' + suffix[::-1] + b'~!#$%&()*+,-./:;<=>?@[]^_{}'
    yield 'printable-punctuation', data, [104] + b_words(data), True


def expected_for(data, require_text):
    expected = {'bytes': list(data), 'formats': ['Code128']}
    if require_text:
        expected['text'] = data.decode('ascii')
    return expected


def encoded_case(name, group, image, expected, parameters):
    assert image.width * image.height <= 4_000_000
    return {'name': name, 'groupId': group, 'condition': parameters['condition'],
            'severity': 0, 'source': 'synthetic', 'width': image.width, 'height': image.height,
            'expected': expected, 'parameters': parameters,
            'rgba_zlib_base64': base64.b64encode(zlib.compress(image.convert('RGBA').tobytes(), 9)).decode('ascii')}


def generate(output):
    rng, cases, labels = random.Random(SEED), [], []
    specs = list(specifications(rng))
    assert len({data for _, data, _, _ in specs}) == len(specs) == 12
    previous_payloads = set()
    for path in (ROOT / 'tests/fixtures').glob('*.json'):
        if path.name == 'independent-code128-safety.json':
            continue
        document = json.loads(path.read_bytes())
        for item in document.get('cases', []):
            previous_payloads.update(bytes(value['bytes']) if 'bytes' in value else value.get('text', '').encode('utf-8') for value in item.get('expected', []))
            if 'expectedBytes' in item:
                previous_payloads.add(bytes(item['expectedBytes']))
    assert not previous_payloads.intersection(data for _, data, _, _ in specs)
    for index, (semantic, data, words, require_text) in enumerate(specs):
        group = f'independent-code128-{index + 1}'
        clean, sequence = render(words)
        expected = [expected_for(data, require_text)]
        labels.append((clean, expected, group))
        params = {'semantic': semantic, 'encodedCodewords': sequence, 'payloadHex': data.hex(),
                  'displayReferenceLatin1Escaped': data.decode('latin-1').encode('unicode_escape').decode('ascii'),
                  'presentationPolicy': 'Raw bytes and format define payload truth; text is additionally exact only for ordinary printable ASCII.'}
        cases.append(encoded_case(f'code128/{group}/clean', group, clean, expected, {**params, 'condition': 'clean'}))
        angle = 13 if index % 2 else -17
        with clean.rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=255) as rotated:
            cases.append(encoded_case(f'code128/{group}/rotated', group, rotated, expected, {**params, 'condition': 'rotated', 'angleDegrees': angle}))
        with clean.resize((round(clean.width * 0.51), round(clean.height * 0.51)), Image.Resampling.LANCZOS) as small:
            with Image.new('L', (max(1152, small.width + 100), 768), 255) as canvas:
                canvas.paste(small, (48 + index * 3, 225))
                cases.append(encoded_case(f'code128/{group}/small', group, canvas, expected, {**params, 'condition': 'small', 'scale': 0.51}))
        with clean.filter(ImageFilter.GaussianBlur(0.65)) as blurred:
            cases.append(encoded_case(f'code128/{group}/blurred', group, blurred, expected, {**params, 'condition': 'blurred', 'radius': 0.65}))
    for index, (left_index, right_index) in enumerate(((0, 1), (2, 3), (6, 8), (9, 10))):
        left, left_expected, _ = labels[left_index]
        right, right_expected, _ = labels[right_index]
        with Image.new('L', (max(left.width, right.width) + 96, left.height + right.height + 112), 255) as canvas:
            canvas.paste(left, (24, 24)); canvas.paste(right, (48, left.height + 72))
            group = f'independent-code128-pair-{index + 1}'
            cases.append(encoded_case(f'multiple/{group}/two-labels', group, canvas, left_expected + right_expected,
                                      {'condition': 'separate-labels', 'semanticGroups': [left_index + 1, right_index + 1]}))
    for index in range(6):
        payload = ('INVALID-IV-' + str(rng.randrange(1000000, 9999999))).encode('ascii')
        words = [104] + b_words(payload)
        with render(words, invalid=True)[0] as image:
            group = f'independent-code128-negative-{index + 1}'
            cases.append(encoded_case(f'negative/{group}/invalid-checksum', group, image, [],
                                      {'condition': 'invalid-checksum', 'trueChecksum': checksum(words),
                                       'renderedChecksum': (checksum(words) + 1) % 103, 'encoderInputHex': payload.hex()}))
    for index, gray in enumerate((255, 37)):
        with Image.new('L', (480, 240), gray) as image:
            group = f'independent-code128-negative-blank-{index + 1}'
            cases.append(encoded_case(f'negative/{group}/blank', group, image, [], {'condition': 'blank', 'gray': gray}))
    for image, _, _ in labels:
        image.close()
    assert len(cases) == 60 and sum(bool(case['expected']) for case in cases) == 52
    document = {'version': 1, 'seed': SEED, 'split': 'independent-code128-safety',
                'description': 'Manually encoded Code 128 semantic compatibility, generated from known input bytes and fixed code-set paths. No decoder calls or outcome filtering; not camera photographs.',
                'provenance': {'generator': 'tools/generate-independent-code128-safety.py',
                               'generatorSha256': hashlib.sha256(Path(__file__).read_bytes().replace(b'\r\n', b'\n')).hexdigest(),
                               'dependencies': {'Pillow': importlib.metadata.version('Pillow')},
                               'groundTruth': 'Input bytes, explicit Code128 codeword construction, modulo-103 checksum. FNC1 first position changes GS1 metadata without adding a byte; internal FNC1 supplies byte29. FNC4 singles/latches preserve the upper bit.',
                               'presentationPolicy': 'Bytes+format are authoritative; ordinary printable ASCII also requires exact text. Other human-readable text varies with reader HRI/character-set policies and is reported separately.',
                               'semanticGroups': 12, 'singleLabelCases': 48, 'multipleLabelCases': 4, 'negatives': 8,
                               'evaluationPolicy': 'Frozen before final algorithms; no per-case outcome disclosure before implementation freeze.'},
                'cases': cases}
    encoded = (json.dumps(document, separators=(',', ':')) + '\n').encode()
    output = Path(output).resolve(); output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and output.read_bytes() != encoded:
        raise ValueError(f'Refusing to overwrite changed frozen fixture: {output}')
    if not output.exists():
        output.write_bytes(encoded)
    print(json.dumps({'cases': len(cases), 'positives': 52, 'negatives': 8,
                      'sha256': hashlib.sha256(encoded).hexdigest(), 'output': str(output)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'tests/fixtures/independent-code128-safety.json')
    generate(parser.parse_args().output)
