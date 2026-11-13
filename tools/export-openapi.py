"""Export the public contract without starting a server or requiring API secrets."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if openapi.json is stale')
    args = parser.parse_args()
    content = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True) + '\n'
    target = ROOT / 'openapi.json'
    if args.check:
        if not target.exists() or target.read_text(encoding='utf-8') != content:
            raise SystemExit('openapi.json is stale. Run python tools/export-openapi.py.')
        print('OpenAPI contract is current.')
    else:
        target.write_text(content, encoding='utf-8')
        print('Exported openapi.json.')


if __name__ == '__main__':
    main()
