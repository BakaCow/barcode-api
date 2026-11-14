"""Real uploaded pixels reach the production read/POS endpoints, not a probe."""
import base64
from io import BytesIO
import json
from pathlib import Path
import zlib

from fastapi.testclient import TestClient
from PIL import Image
import pytest

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / 'tests/fixtures/damage-stress-qr-upgrade.json').read_text(encoding='utf-8'))['cases']
TARGETS = [case for case in CASES if case['expected'] and case['name'].rsplit('/', 1)[-1] in ('motion-blur-2', 'small-in-frame-2')]
assert len(TARGETS) == 18


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('BARCODE_API_KEY', 'test-only-signal-api-key')
    monkeypatch.syspath_prepend(str(ROOT))
    from app import app
    with TestClient(app, headers={'X-API-Key': 'test-only-signal-api-key'}) as session:
        yield session


def png(case, changed=False):
    raw = zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))
    with Image.frombytes('RGBA', (case['width'], case['height']), raw) as image:
        if changed:
            image.putpixel((0, 0), (254, 254, 254, 255))
        output = BytesIO()
        image.save(output, 'PNG')
        return output.getvalue()


@pytest.mark.parametrize('case', TARGETS, ids=lambda case: case['name'])
def test_severe_motion_and_tiny_development_images_through_upload_endpoint(client, case):
    response = client.post('/v1/barcodes/read', files={'file': ('source.png', png(case), 'image/png')})
    assert response.status_code == 200, response.text
    found = response.json()['barcodes']
    assert len(found) == 1, found
    assert found[0]['format'] == case['name'].split('/')[0]
    assert found[0]['text'] == case['expected'][0]['text']
    assert base64.b64decode(found[0]['bytes_base64']) == case['expected'][0]['text'].encode('utf-8')
    assert all(0 <= point['x'] <= case['width'] and 0 <= point['y'] <= case['height'] for point in found[0]['position'])


@pytest.mark.parametrize('family', ['qr', 'code128', 'ean13'])
def test_recovered_motion_still_requires_distinct_pos_images(client, family):
    case = next(case for case in TARGETS if case['name'] == f'{family}/qr-upgrade-{family}-label-2/motion-blur-2')
    original = png(case)
    def upload(contents):
        response = client.post('/v1/pos/decode', files=[('frames', (f'frame-{index}.png', content, 'image/png')) for index, content in enumerate(contents)],
                               data={'options': json.dumps({'allowed_formats': [family], 'confirmation_frames': 2})})
        assert response.status_code == 200, response.text
        return response.json()
    assert upload([original])['status'] == 'rescan'
    assert upload([original, original])['status'] == 'rescan'
    confirmed = upload([original, png(case, changed=True)])
    assert confirmed['status'] == 'confirmed', confirmed
    assert confirmed['barcode']['text'] == case['expected'][0]['text']
    assert confirmed['confirmation']['distinct_frames'] == 2
