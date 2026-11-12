"""Measure the API's actual image-reading function against labelled pixel fixtures.

This excludes HTTP, upload parsing and camera time. No network requests are made.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import math
from pathlib import Path
import sys
from time import perf_counter
import zlib

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--reader', type=Path, default=ROOT / 'barcode_reader.py')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    corpus = json.loads(args.corpus.read_text(encoding='utf-8'))
    if corpus.get('version') != 1 or not corpus.get('cases'):
        parser.error('A nonempty version 1 pixel corpus is required.')
    spec = importlib.util.spec_from_file_location('benchmarked_api_reader', args.reader)
    reader = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = reader
    spec.loader.exec_module(reader)
    results = []
    for case in corpus['cases']:
        width, height = case['width'], case['height']
        if not isinstance(width, int) or not isinstance(height, int) or min(width, height) < 1 or width * height > 4_000_000:
            raise ValueError('Benchmark images must be bounded to four megapixels.')
        compressed = base64.b64decode(case['rgba_zlib_base64'], validate=True)
        decoder = zlib.decompressobj()
        raw = decoder.decompress(compressed, width * height * 4 + 1)
        if len(raw) != width * height * 4 or not decoder.eof or decoder.unused_data:
            raise ValueError('Invalid pixel buffer.')
        error = None
        with Image.frombytes('RGBA', (width, height), raw) as rgba:
            with rgba.convert('RGB') as image:
                started = perf_counter()
                try:
                    found = [{'text': code.text, 'format': code.format.name, 'points': code.points}
                             for code in reader.read_barcodes(image)]
                    for code in found:
                        if len(code['points']) != 4 or not all(math.isfinite(x) and math.isfinite(y) and 0 <= x <= width and 0 <= y <= height for x, y in code['points']):
                            raise ValueError('Reader returned invalid coordinates.')
                except Exception as exc:
                    found = []
                    error = str(exc)
                duration_ms = (perf_counter() - started) * 1000
        expected = case['expected']
        def matches(actual, truth):
            return actual['text'] == truth['text'] and actual['format'] in truth['formats']
        missing = [truth['text'] for truth in expected if not any(matches(actual, truth) for actual in found)]
        unexpected = [actual for actual in found if not any(matches(actual, truth) for truth in expected)]
        results.append({'name': case['name'], 'expectedCount': len(expected),
                        'exact': not error and not missing and not unexpected,
                        'missing': missing, 'unexpected': unexpected,
                        'durationMs': round(duration_ms, 3), **({'error': error} if error else {})})
    positives = [item for item in results if item['expectedCount']]
    negatives = [item for item in results if not item['expectedCount']]
    timings = sorted(item['durationMs'] for item in results)
    report = {
        'description': 'Actual API reader on identical labelled pixels. Host decode times exclude HTTP, image import and camera work. Synthetic damage examples do not establish real phone accuracy.',
        'split': corpus.get('split'), 'reader': args.reader.name,
        'readerSha256': hashlib.sha256(args.reader.read_text(encoding='utf-8').replace('\r\n', '\n').encode()).hexdigest(),
        'corpusSha256': hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
        'versions': {package: importlib.metadata.version(package) for package in ('zxing-cpp', 'Pillow')},
        'summary': {'total': len(results), 'positives': len(positives),
                    'exactPositiveReads': sum(item['exact'] for item in positives),
                    'negatives': len(negatives), 'negativesCorrectlyRejected': sum(item['exact'] for item in negatives),
                    'unexpectedResults': sum(len(item['unexpected']) for item in results),
                    'errors': sum(bool(item.get('error')) for item in results),
                    'medianMs': timings[len(timings) // 2], 'p95Ms': timings[math.ceil(len(timings) * .95) - 1]},
        'cases': results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report['summary'], indent=2))
    print('Unsuccessful positive cases:', ', '.join(item['name'] for item in positives if not item['exact']) or 'none')
    return 1 if report['summary']['unexpectedResults'] or report['summary']['errors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
