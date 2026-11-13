"""POS format restriction regressions on the actual pinned native decoder."""
import base64
import json
from pathlib import Path
import zlib

from PIL import Image
import pytest
import zxingcpp

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def reader(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    import barcode_reader
    return barcode_reader


def fixture_image(corpus, name):
    cases = json.loads((ROOT / 'tests/fixtures' / corpus).read_text())['cases']
    case = next(item for item in cases if item['name'] == name)
    with Image.frombytes('RGBA', (case['width'], case['height']),
                         zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))) as image:
        return image.convert('RGB'), case['expected']


def encoded_image(format_, payload):
    return Image.fromarray(zxingcpp.create_barcode(payload, format_).to_image(scale=3, add_quiet_zones=True))


def observe_native(monkeypatch):
    native = zxingcpp.read_barcodes
    calls = []

    def observed(image, **options):
        calls.append(options)
        return native(image, **options)

    monkeypatch.setattr(zxingcpp, 'read_barcodes', observed)
    return calls


def test_supported_pos_names_and_alias_families_are_explicit(reader):
    assert set(reader.POS_FORMATS) == {'qr', 'code128', 'ean13', 'ean8', 'upca', 'upce',
                                       'datamatrix', 'aztec', 'pdf417', 'code93'}
    for name, native in reader.POS_FORMATS.items():
        assert reader.canonical_format_name(native) == name
    for native, expected in [('QRCodeModel1', 'qr'), ('QRCodeModel2', 'qr'),
                             ('AztecCode', 'aztec'), ('AztecRune', 'aztec'),
                             ('CompactPDF417', 'pdf417')]:
        assert reader.canonical_format_name(getattr(zxingcpp.BarcodeFormat, native)) == expected
    for native in ['MicroQRCode', 'RMQRCode', 'MicroPDF417', 'Code39', 'ITF']:
        assert reader.canonical_format_name(getattr(zxingcpp.BarcodeFormat, native)) is None


@pytest.mark.parametrize('allowed', [[], (), '', 'qr', b'qr', {}, {'qr'}, [''], ['QRCode'],
                                    ['qr', 'unknown'], [None], [1]])
def test_invalid_allowlists_fail_before_native_decode(reader, monkeypatch, allowed):
    def unexpected(*args, **kwargs):
        pytest.fail('Invalid allowlist reached the decoder.')
    monkeypatch.setattr(zxingcpp, 'read_barcodes', unexpected)
    with pytest.raises(ValueError, match='nonempty sequence'):
        reader.read_barcodes(None, allowed_formats=allowed)


def test_restricted_first_pass_removes_known_upce_false_result(reader, monkeypatch):
    image, expected = fixture_image('damage-stress-verify.json', 'ean13/verify-ean13-label-2/angled-2')
    assert expected == [{'text': '7695101115611', 'formats': ['EAN13']}]
    calls = observe_native(monkeypatch)
    with image:
        found = reader.read_barcodes(image, allowed_formats=['ean13', 'upca', 'code128', 'qr'])
    assert [(code.text, code.format.name) for code in found] == [('7695101115611', 'EAN13')]
    assert len(calls) == 1
    assert calls[0]['formats'] == zxingcpp.BarcodeFormats([
        zxingcpp.BarcodeFormat.EAN13, zxingcpp.BarcodeFormat.UPCA,
        zxingcpp.BarcodeFormat.Code128, zxingcpp.BarcodeFormat.QRCode])


def test_requested_formats_reject_a_corroborated_same_symbol_upce_alias(reader):
    image, _ = fixture_image('damage-stress-verify.json', 'ean13/verify-ean13-label-2/angled-2')
    with image:
        found = reader.read_barcodes(image, allowed_formats=['ean13', 'upce'])
    assert {(code.text, code.format.name) for code in found} == {('7695101115611', 'EAN13')}


def test_result_filter_rejects_disallowed_output_even_if_native_ignores_options(reader, monkeypatch):
    with encoded_image(zxingcpp.BarcodeFormat.QRCode, 'disallowed-qr') as image:
        qr = zxingcpp.read_barcodes(image)
        assert len(qr) == 1
        calls = []

        def ignoring_options(candidate, **options):
            calls.append(options)
            return qr

        monkeypatch.setattr(zxingcpp, 'read_barcodes', ignoring_options)
        assert reader.read_barcodes(image, allowed_formats=['code128']) == []
    assert 1 < len(calls) <= 10, 'all active recovery passes remain restricted within the retry cap'
    assert all(options['formats'] == zxingcpp.BarcodeFormats([zxingcpp.BarcodeFormat.Code128]) for options in calls)


def test_clean_excluded_format_is_not_reenabled_by_recovery(reader, monkeypatch):
    calls = observe_native(monkeypatch)
    with encoded_image(zxingcpp.BarcodeFormat.QRCode, 'only-qr-present') as image:
        assert reader.read_barcodes(image, allowed_formats=['code128']) == []
    assert 1 < len(calls) <= 10
    assert all(options['formats'] == zxingcpp.BarcodeFormats([zxingcpp.BarcodeFormat.Code128]) for options in calls)


def test_allowed_weak_shaded_code128_recovers_without_broadening_formats(reader, monkeypatch):
    image, expected = fixture_image('accuracy-pixels.json', 'code128/weak-shaded')
    with image:
        assert zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.Code128) == []
        calls = observe_native(monkeypatch)
        found = reader.read_barcodes(image, allowed_formats=('code128',))
    assert [code.text for code in found] == [expected[0]['text']]
    assert found[0].bytes == expected[0]['text'].encode()
    assert len(calls) > 1
    assert all(options['formats'] == zxingcpp.BarcodeFormats([zxingcpp.BarcodeFormat.Code128]) for options in calls)


def test_none_preserves_legacy_first_pass_values_bytes_and_coordinates(reader, monkeypatch):
    with encoded_image(zxingcpp.BarcodeFormat.ITF, '12345678') as image:
        native = zxingcpp.read_barcodes(image)
        calls = observe_native(monkeypatch)
        implicit = reader.read_barcodes(image)
        explicit = reader.read_barcodes(image, allowed_formats=None)
    assert implicit == explicit
    assert calls == [{}, {}]
    assert [(code.text, code.bytes, code.format) for code in implicit] == [
        (code.text, code.bytes, code.format) for code in native]
    for actual, original in zip(implicit, native):
        points = original.position
        assert actual.points == tuple((point.x, point.y) for point in
                                      (points.top_left, points.top_right, points.bottom_right, points.bottom_left))


@pytest.mark.parametrize(('allowed', 'reported'), [(['upca'], 'UPCA'), (['ean13'], 'EAN13'),
                                                  (['ean13', 'upca'], 'EAN13')])
def test_upca_alias_preserves_native_gtin_text_and_bytes(reader, allowed, reported):
    with encoded_image(zxingcpp.BarcodeFormat.UPCA, '036000291452') as image:
        found = reader.read_barcodes(image, allowed_formats=allowed)
    assert len(found) == 1
    assert (found[0].text, found[0].bytes, found[0].format.name) == ('0036000291452', b'0036000291452', reported)
    assert reader.canonical_format_name(found[0].format) == reported.lower()


def test_non_upca_ean13_is_excluded_from_upca_only(reader):
    with encoded_image(zxingcpp.BarcodeFormat.EAN13, '7695101115611') as image:
        assert reader.read_barcodes(image, allowed_formats=['upca']) == []


def test_upce_keeps_native_expanded_identifier_and_separate_format(reader):
    with encoded_image(zxingcpp.BarcodeFormat.UPCE, '04252614') as image:
        found = reader.read_barcodes(image, allowed_formats=['upce'])
        excluded = reader.read_barcodes(image, allowed_formats=['ean13', 'upca'])
    assert len(found) == 1
    assert (found[0].text, found[0].bytes, reader.canonical_format_name(found[0].format)) == (
        '0042100005264', b'0042100005264', 'upce')
    assert excluded == []
