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


@pytest.mark.parametrize('geometry_elapsed,expected_read', [(.2, True), (1.21, False), (2.51, False)],
                         ids=['slower-complete-locator', 'qr-budget-exhausted', 'request-budget-exhausted'])
def test_tiny_ean_upload_keeps_a_complete_read_but_never_ignores_expired_qr_work(client, monkeypatch,
                                                                              geometry_elapsed, expected_read):
    import barcode_reader
    import linear_signal
    import qr_damage
    import qr_recovery
    import qr_signal

    case = next(case for case in TARGETS
                if case['name'] == 'ean13/qr-upgrade-ean13-label-3/small-in-frame-2')
    clock, alternate, linear_results, qr_results = [0.0], [None], [], []
    for module in (barcode_reader, linear_signal, qr_damage, qr_recovery, qr_signal):
        monkeypatch.setattr(module, 'monotonic', lambda: clock[0])

    original_enlarge, original_locator = qr_signal.enlarge, qr_recovery.find_proposals
    original_linear, original_qr = linear_signal.recover, qr_signal.recover

    def enlarge(source, factor=4):
        image = original_enlarge(source, factor)
        if factor == 6:
            alternate[0] = image
        return image

    def locate(image, deadline, limit=3):
        # Model elapsed work on the larger second sampling phase. The real
        # locator still examines all source pixels and enforces its deadline.
        if image is alternate[0]:
            clock[0] = geometry_elapsed
        return original_locator(image, deadline, limit)

    def linear(*args, **kwargs):
        result = original_linear(*args, **kwargs)
        linear_results.append(result)
        return result

    def qr(*args, **kwargs):
        result = original_qr(*args, **kwargs)
        qr_results.append(result)
        return result

    monkeypatch.setattr(qr_signal, 'enlarge', enlarge)
    monkeypatch.setattr(qr_recovery, 'find_proposals', locate)
    monkeypatch.setattr(linear_signal, 'recover', linear)
    monkeypatch.setattr(qr_signal, 'recover', qr)
    response = client.post('/v1/barcodes/read', files={'file': ('source.png', png(case), 'image/png')})
    assert response.status_code == 200, response.text
    assert alternate[0] is not None, 'Exercise the alternate tiny-source geometry search.'
    expected = case['expected'][0]['text']
    assert len(linear_results) == 1 and linear_results[0].complete
    assert [item.code.bytes for item in linear_results[0].observations] == [expected.encode()]
    assert len(qr_results) == 1 and qr_results[0].complete is expected_read
    found = response.json()['barcodes']
    if expected_read:
        assert len(found) == 1 and (found[0]['format'], found[0]['text']) == ('ean13', expected)
        assert base64.b64decode(found[0]['bytes_base64']) == expected.encode()
        assert all(0 <= point['x'] <= case['width'] and 0 <= point['y'] <= case['height'] for point in found[0]['position'])
    else:
        assert found == [], 'Incomplete QR work must still veto the unique linear result.'


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
