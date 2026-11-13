"""The benchmark must not accept wrong raw data merely because text matches."""
import copy
import json
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = next(case for case in json.loads((ROOT / 'tests/fixtures/barcode-pixels.json').read_text())['cases']
              if case['name'] == 'QR code')


def run(tmp_path, expected):
    sample = copy.deepcopy(SAMPLE)
    sample['expected'] = expected
    corpus, output = tmp_path / 'corpus.json', tmp_path / 'report.json'
    corpus.write_text(json.dumps({'version': 1, 'cases': [sample]}))
    result = subprocess.run([sys.executable, str(ROOT / 'tools/benchmark-damage-api.py'),
                             '--corpus', str(corpus), '--output', str(output)],
                            capture_output=True, text=True, timeout=30)
    return result, json.loads(output.read_text()) if output.exists() else None


def test_wrong_bytes_fail_even_when_text_is_exact(tmp_path):
    truth = SAMPLE['expected'][0]
    actual_bytes = list(truth['text'].encode('utf-8'))
    result, report = run(tmp_path, [{**truth, 'bytes': [actual_bytes[0] ^ 1, *actual_bytes[1:]]}])
    assert result.returncode == 1, result.stderr
    assert report['summary']['exactPositiveReads'] == 0
    assert report['summary']['unexpectedResults'] == 1
    assert report['cases'][0]['unexpected'][0]['bytes'] == actual_bytes
    assert report['cases'][0]['unexpected'][0]['text'] == truth['text']


def test_byte_only_truth_preserves_raw_payload_independently_of_presentation(tmp_path):
    truth = SAMPLE['expected'][0]
    actual_bytes = list(truth['text'].encode('utf-8'))
    result, report = run(tmp_path, [{'formats': truth['formats'], 'bytes': actual_bytes}])
    assert result.returncode == 0, result.stderr
    assert report['summary']['exactPositiveReads'] == 1
    assert report['cases'][0]['found'][0]['bytes'] == actual_bytes
    assert 'barcode_reader.py' in report['runtimeSourcesSha256']


@pytest.mark.parametrize('invalid', [[-1], [256], [1.5], ['1'], [True]])
def test_malformed_raw_truth_fails_before_a_report(tmp_path, invalid):
    result, report = run(tmp_path, [{'formats': ['QRCode'], 'bytes': invalid}])
    assert result.returncode != 0
    assert report is None
    assert 'unsigned bytes' in result.stderr
