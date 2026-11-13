"""Cross-decoder regressions use encoder inputs and existing development pixels."""
import base64
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
import zlib

from PIL import Image
import pytest
import zxingcpp

import barcode_reader as reader
import independent_zbar as independent

ROOT = Path(__file__).resolve().parents[1]


def image_for(name):
    cases = json.loads((ROOT / 'tests/fixtures/damage-stress-recovery.json').read_text())['cases']
    case = next(case for case in cases if case['name'] == name)
    with Image.frombytes('RGBA', (case['width'], case['height']),
                         zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))) as image:
        return image.convert('L'), case['expected']


def encoded(payload, format_=zxingcpp.BarcodeFormat.Code128):
    return Image.fromarray(zxingcpp.create_barcode(payload, format_).to_image(scale=3, add_quiet_zones=True)).convert('L')


def identities(records):
    return {(record.format.name, record.bytes) for record in records}


@pytest.mark.parametrize('allowed', [None, ['code128'], ['qr', 'code128']])
def test_real_wrong_first_pass_code128_requires_cross_decoder_byte_agreement(allowed):
    image, expected = image_for('code128/recovery-code128-label-3/small-in-frame-1')
    target = expected[0]['text'].encode('ascii')
    with image:
        raw = zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.Code128)
        assert len(raw) == 1 and raw[0].bytes != target, 'Actual baseline wrong read must be reproduced.'
        found = reader.read_barcodes(image, allowed_formats=allowed)
    assert identities(found) == {('Code128', target)}
    assert found[0].text == expected[0]['text']
    assert all(300 <= x <= 650 and 260 <= y <= 410 for x, y in found[0].points)


@pytest.mark.parametrize('number', [1, 2])
def test_real_shaded_ean_is_recovered_by_independent_engine(number):
    image, expected = image_for(f'ean13/recovery-ean13-label-{number}/shading-lowcontrast-2')
    with image:
        assert zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.EAN13) == []
        found = reader.read_barcodes(image, allowed_formats=['ean13'])
    assert identities(found) == {('EAN13', expected[0]['text'].encode('ascii'))}


@pytest.mark.parametrize('payload', [b'DEV-API-ASCII/aZ', b'12345678901234567890',
                                      b'DEV-API-\x00\x1d\x7f', b'DEV-API-\x80\xbe\xff',
                                      b'\x81\x82\x83\x84\x85', b'A\x80B\xffC'])
def test_native_control_and_extended_code128_bytes_are_preserved(payload):
    with encoded(payload) as image:
        native = reader._records(zxingcpp.read_barcodes(image), image.size)
        assert identities(native) == {('Code128', payload)}
        found = reader.read_barcodes(image, allowed_formats=['code128'])
    assert found == native, 'Independent lack of support cannot change genuine native bytes or display text.'


def test_untrusted_fnc4_observation_cannot_replace_native_recovery(monkeypatch):
    payload = b'DEV-API-\x80\xbe\xff'
    native = zxingcpp.read_barcodes
    calls = 0

    def first_miss(image, **options):
        nonlocal calls
        calls += 1
        return [] if calls == 1 else native(image, **options)

    with encoded(payload) as image:
        observations = independent.observations(image, ['code128'])
        assert observations
        # Reproduce ZBar's known FNC4 high-bit loss without requiring every
        # future platform build to retain that upstream bug.
        untrusted = replace(observations[0], data=b'DEV-API-\x00>\x7f')
        monkeypatch.setattr(reader, 'zbar_observations', lambda *args: [untrusted])
        monkeypatch.setattr(zxingcpp, 'read_barcodes', first_miss)
        found = reader.read_barcodes(image, allowed_formats=['code128'])
    assert identities(found) == {('Code128', payload)}
    assert calls > 2, 'Unproved independent bytes must fall through to the existing recovery path.'


@pytest.mark.parametrize('value', ['04252614', '15766746'])
def test_compressed_upce_is_never_relabelled_as_allowed_ean13(value):
    with encoded(value, zxingcpp.BarcodeFormat.UPCE) as image:
        assert independent.observations(image, ['ean13']) == []
        assert reader.read_barcodes(image, allowed_formats=['ean13', 'upca']) == []
        assert {record.format.name for record in reader.read_barcodes(image, allowed_formats=['upce'])} == {'UPCE'}


@pytest.mark.parametrize('family', ['ean13', 'upca'])
def test_real_leading_zero_retail_native_reads_remain_supported(family):
    with encoded('0036000291452', zxingcpp.BarcodeFormat.EAN13) as image:
        found = reader.read_barcodes(image, allowed_formats=[family])
    assert identities(found) == {(family.upper(), b'0036000291452')}


def test_independent_engine_is_skipped_for_excluded_families(monkeypatch):
    monkeypatch.setattr(reader, 'zbar_observations', lambda *args: pytest.fail('Excluded family reached ZBar.'))
    with encoded('API-QR-ONLY', zxingcpp.BarcodeFormat.QRCode) as image:
        assert {record.format.name for record in reader.read_barcodes(image, allowed_formats=['qr'])} == {'QRCode'}
    with Image.new('L', (30, 30), 255) as image:
        assert reader.read_barcodes(image, allowed_formats=['qr']) == []


def test_native_mask_is_explicit_and_filters_a_misbehaving_independent_decoder(monkeypatch):
    calls = []

    def unexpected_type(image, *, symbols):
        calls.append(symbols)
        return [SimpleNamespace(type='QRCODE', data=b'ignored', quality=10, rect=(1, 1, 20, 20))]

    monkeypatch.setattr(independent, 'decode', unexpected_type)
    with Image.new('L', (30, 30), 255) as image:
        assert independent.observations(image, ['code128']) == []
        assert independent.observations(image, ['qr']) == []
    assert calls == [[independent.ZBarSymbol.CODE128]]


@pytest.mark.parametrize('change', [{'quality': 1}, {'data': b'123'}, {'data': b'7695101115612'},
                                    {'rect': (10, 10, 0, 8)}, {'type': 'UPCE'},
                                    {'data': b'0042100005264'}])
def test_unchecked_or_ambiguous_independent_retail_observations_are_not_published(monkeypatch, change):
    code = SimpleNamespace(type='EAN13', data=b'7695101115611', quality=10, rect=(1, 1, 20, 20))
    for key, value in change.items():
        setattr(code, key, value)
    monkeypatch.setattr(independent, 'decode', lambda *args, **kwargs: [code])
    with Image.new('L', (30, 30), 255) as image:
        assert independent.observations(image, ['ean13']) == []


def test_failed_independent_observation_preserves_native_read(monkeypatch):
    def unavailable(*args):
        raise RuntimeError('Simulated independent scan failure')

    monkeypatch.setattr(reader, 'zbar_observations', unavailable)
    with encoded(b'API-NATIVE-SURVIVES') as image:
        native = reader._records(zxingcpp.read_barcodes(image), image.size)
        assert reader.read_barcodes(image) == native


def test_expired_native_read_cannot_allocate_independent_work(monkeypatch):
    times = iter([0, reader.RETRY_SECONDS])
    monkeypatch.setattr(reader, 'monotonic', lambda: next(times))
    monkeypatch.setattr(reader, '_working_image', lambda _: pytest.fail('Expired work allocated an image.'))
    with encoded(b'API-DEADLINE') as image:
        assert identities(reader.read_barcodes(image)) == {('Code128', b'API-DEADLINE')}


def test_corroboration_does_not_replace_separate_labels(monkeypatch):
    image, expected = image_for('code128/recovery-code128-label-3/small-in-frame-1')
    with image:
        original = reader._records(zxingcpp.read_barcodes(image), image.size)
        # No deadline in this targeted geometry check; moving the independent
        # source footprint creates a separate label despite a matching payload.
        monkeypatch.setattr(reader, 'monotonic', lambda: 0)
        observations = reader._independent_observations(image, lambda x, y: (x, y), image.size, None, 0)
        distant = [replace(value, points=tuple((x, y + 150) for x, y in value.points)) for value in observations]
        monkeypatch.setattr(zxingcpp, 'read_barcodes', lambda *args, **kwargs: pytest.fail('Non-overlapping labels must not trigger replacement.'))
        assert reader._independent_agreement(original, distant, image, lambda x, y: (x, y), image.size, 0) == original


def test_unverified_code128_blocks_partial_unique_independent_recovery(monkeypatch):
    points = ((2, 2), (40, 2), (40, 20), (2, 20))
    observed = [reader.DecodedBarcode('', zxingcpp.BarcodeFormat.Code128, b'unproved', points),
                reader.DecodedBarcode('7695101115611', zxingcpp.BarcodeFormat.EAN13, b'7695101115611', points)]
    monkeypatch.setattr(reader, 'monotonic', lambda: 0)
    monkeypatch.setattr(zxingcpp, 'read_barcodes', lambda *args, **kwargs: [])
    with Image.new('L', (50, 30), 255) as image:
        assert reader._independent_agreement([], observed, image, lambda x, y: (x, y), image.size, 0) == []


def test_correcting_a_code128_does_not_hide_another_real_label():
    image, expected = image_for('code128/recovery-code128-label-3/small-in-frame-1')
    neighbor_value = b'DEV-API-NEIGHBOR'
    with image, encoded(neighbor_value) as neighbor:
        image.paste(neighbor, (50, 20))
        found = reader.read_barcodes(image, allowed_formats=['code128'])
    assert identities(found) == {('Code128', expected[0]['text'].encode()), ('Code128', neighbor_value)}


def test_independent_input_and_retry_allocations_are_bounded(monkeypatch):
    with Image.new('L', (2001, 2000), 255) as too_large:
        with pytest.raises(ValueError, match='bounded'):
            independent.observations(too_large, ['code128'])
    points = ((1, 1), (200, 1), (200, 30), (1, 30))
    observed = [reader.DecodedBarcode('', zxingcpp.BarcodeFormat.Code128, b'new', points)]
    monkeypatch.setattr(reader, 'monotonic', lambda: 0)
    monkeypatch.setattr(zxingcpp, 'read_barcodes', lambda *args, **kwargs: pytest.fail('Near-cap image must not allocate a doubled retry.'))
    with Image.new('L', (2600, 1500), 255) as image:
        assert reader._independent_agreement([], observed, image, lambda x, y: (x, y), image.size, 0) == []


def test_positive_native_identity_is_preserved_with_nested_or_ambiguous_footprints(monkeypatch):
    narrow = ((25, 10), (75, 10), (75, 30), (25, 30))
    broad = ((0, 0), (100, 0), (100, 40), (0, 40))
    first = reader.DecodedBarcode('first', zxingcpp.BarcodeFormat.Code128, b'first', narrow)
    second = reader.DecodedBarcode('second', zxingcpp.BarcodeFormat.Code128, b'second', broad)
    monkeypatch.setattr(reader, 'monotonic', lambda: 0)
    with Image.new('L', (120, 60), 255) as image:
        found = reader._independent_agreement([first, second], [first, second], image,
            lambda x, y: (x, y), image.size, 0, {'records': [second]})
    assert found == [first, second], 'A different broader proof must not hide a positively observed label.'


def test_one_proof_cannot_replace_two_different_overlapping_native_identities(monkeypatch):
    points = ((2, 2), (90, 2), (90, 40), (2, 40))
    first = reader.DecodedBarcode('first', zxingcpp.BarcodeFormat.Code128, b'first', points)
    second = replace(first, text='second', bytes=b'second')
    candidate = replace(first, text='third', bytes=b'third')
    monkeypatch.setattr(reader, 'monotonic', lambda: 0)
    with Image.new('L', (100, 60), 255) as image:
        found = reader._independent_agreement([first, second], [candidate], image,
            lambda x, y: (x, y), image.size, 0, {'records': [candidate]})
    assert found == [first, second]


def test_larger_containing_label_does_not_establish_same_code128(monkeypatch):
    small = reader.DecodedBarcode('small', zxingcpp.BarcodeFormat.Code128, b'small',
                                 ((40, 10), (60, 10), (60, 30), (40, 30)))
    larger = reader.DecodedBarcode('larger', zxingcpp.BarcodeFormat.Code128, b'larger',
                                  ((0, 0), (100, 0), (100, 40), (0, 40)))
    assert reader._same_symbol_segment(small, larger), 'The old retail-alias containment has a different purpose.'
    assert not reader._same_code128_footprint(small, larger)
    monkeypatch.setattr(reader, 'monotonic', lambda: 0)
    monkeypatch.setattr(zxingcpp, 'read_barcodes', lambda *args, **kwargs: pytest.fail('Non-mutual association cannot trigger replacement.'))
    with Image.new('L', (120, 60), 255) as image:
        assert reader._independent_agreement([small], [larger], image, lambda x, y: (x, y), image.size, 0) == [small]


def test_existing_native_full_view_evidence_is_not_rewritten_by_untrusted_observation(monkeypatch):
    points = ((2, 2), (40, 2), (40, 20), (2, 20))
    native = reader.DecodedBarcode('7695101115611', zxingcpp.BarcodeFormat.EAN13, b'7695101115611', points)
    untrusted = reader.DecodedBarcode('', zxingcpp.BarcodeFormat.Code128, b'unproved', points)
    monkeypatch.setattr(reader, 'monotonic', lambda: 0)
    with Image.new('L', (50, 30), 255) as image:
        assert reader._independent_agreement([native], [untrusted], image,
                                            lambda x, y: (x, y), image.size, 0) == [native]
