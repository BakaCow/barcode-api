"""Real production upload regressions using old development images only."""

import base64
from functools import lru_cache
from io import BytesIO
import json
from pathlib import Path
import zlib

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageOps
import pytest
import zxingcpp


ROOT = Path(__file__).resolve().parents[1]
API_KEY = 'test-only-damage-upgrade-key'


@pytest.fixture
def client(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    monkeypatch.setenv('BARCODE_API_KEY', API_KEY)
    from app import app
    with TestClient(app, headers={'X-API-Key': API_KEY}) as client:
        yield client


@lru_cache
def cases(filename):
    return json.loads((ROOT / 'tests' / 'fixtures' / filename).read_text())['cases']


def source_image(case):
    with Image.frombytes('RGBA', (case['width'], case['height']),
                         zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))) as rgba:
        return rgba.convert('L')


def encode(image):
    stream = BytesIO()
    image.save(stream, 'PNG')
    return stream.getvalue()


def read(client, content):
    response = client.post('/v1/barcodes/read', files={'file': ('damage.png', content, 'image/png')})
    assert response.status_code == 200, response.text
    return response.json()


def pos(client, content, formats):
    response = client.post('/v1/pos/decode', files={'frames': ('damage.png', content, 'image/png')},
                           data={'options': json.dumps({'allowed_formats': formats, 'confirmation_frames': 1})})
    assert response.status_code == 200, response.text
    return response.json()


def assert_record(record, case, public_format):
    expected = case['expected'][0]
    assert (record['format'], record['text']) == (public_format, expected['text'])
    assert base64.b64decode(record['bytes_base64'], validate=True) == bytes(expected.get('bytes', expected['text'].encode()))
    corners = record['position']
    assert len(corners) == 4
    assert all(0 <= point['x'] <= case['width'] and 0 <= point['y'] <= case['height'] for point in corners)
    assert corners[0]['x'] < corners[1]['x'] and corners[3]['x'] < corners[2]['x']
    assert corners[0]['y'] < corners[3]['y'] and corners[1]['y'] < corners[2]['y']


def assert_single_read(payload, case, family):
    assert payload['image'] == {'width': case['width'], 'height': case['height']}
    assert len(payload['barcodes']) == 1, payload
    assert_record(payload['barcodes'][0], case, family)


def assert_single_pos(payload, case, family):
    assert payload['status'] == 'confirmed' and payload['reason'] == 'single_match', payload
    assert len(payload['candidates']) == 1
    assert payload['barcode'] == payload['candidates'][0]
    assert payload['barcode']['frame_indices'] == [0]
    assert (payload['barcode']['format'], payload['barcode']['text']) == (family, case['expected'][0]['text'])
    assert base64.b64decode(payload['barcode']['bytes_base64'], validate=True) == case['expected'][0]['text'].encode()
    assert_single_read(payload['frames'][0], case, family)


@pytest.mark.parametrize('label', [1, 2, 3])
@pytest.mark.parametrize('endpoint', ['read', 'pos'])
def test_old_qr_patch_gains_survive_production_upload(client, label, endpoint):
    case = next(case for case in cases('damage-stress-signal-upgrade.json')
                if case['name'] == f'qr/signal-upgrade-qr-label-{label}/missing-patch-1')
    with source_image(case) as image:
        assert not zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.QRCode)
        content = encode(image)
    if endpoint == 'read':
        assert_single_read(read(client, content), case, 'qr')
    else:
        assert_single_pos(pos(client, content, ['qr']), case, 'qr')


def test_false_upce_abstains_unrestricted_but_ean_only_pos_returns_exact_source_value(client):
    case = next(case for case in cases('damage-stress-signal-upgrade.json')
                if case['name'] == 'ean13/signal-upgrade-ean13-label-1/missing-patch-1')
    with source_image(case) as image:
        initial = zxingcpp.read_barcodes(image)
        assert len(initial) == 1 and initial[0].format.name == 'UPCE'
        assert initial[0].text != case['expected'][0]['text'], 'Exercise the actual prior false reading.'
        content = encode(image)
    assert read(client, content) == {'image': {'width': case['width'], 'height': case['height']}, 'barcodes': []}
    assert_single_pos(pos(client, content, ['ean13']), case, 'ean13')
    ambiguous_formats = pos(client, content, ['ean13', 'upce'])
    assert ambiguous_formats['status'] == 'rescan' and ambiguous_formats['reason'] == 'no_code'
    assert ambiguous_formats['barcode'] is None and ambiguous_formats['candidates'] == []
    assert ambiguous_formats['frames'][0]['barcodes'] == []


def staggered_damage(source, color):
    """Erase different interior spans on different rows; no whole intact row."""
    result = source.copy()
    with ImageOps.invert(source) as inverse:
        left, _, right, _ = inverse.getbbox()
    span = right - left
    patch = max(18, round(span * .075))
    draw = ImageDraw.Draw(result)
    for y in range(source.height):
        part = (y * 9 // source.height) % 3
        center = round(left + span * (.25 + .25 * part))
        draw.line((center - patch // 2, y, center + (patch + 1) // 2 - 1, y), fill=color)
    return result


@pytest.mark.parametrize('family', ['ean13', 'code128'])
@pytest.mark.parametrize('color', [0, 255])
def test_source_row_reconstruction_survives_real_upload_and_pos(client, family, color):
    case = next(case for case in cases('damage-stress-qr-upgrade.json')
                if case['name'].startswith(family + '/') and case['name'].endswith('/clean-0'))
    with source_image(case) as original, staggered_damage(original, color) as damaged:
        assert not zxingcpp.read_barcodes(damaged, formats=zxingcpp.BarcodeFormats([
            zxingcpp.BarcodeFormat.EAN13, zxingcpp.BarcodeFormat.Code128]))
        content = encode(damaged)
    assert_single_read(read(client, content), case, family)
    assert_single_pos(pos(client, content, [family]), case, family)
