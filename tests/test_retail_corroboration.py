"""Native pixel checks for narrowly corroborated EAN/UPC-E same-symbol aliases."""
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


def encoded(format_, value, angle=0):
    # The expected values below are fixed independent encoder inputs. ZXing
    # represents the UPC-E input as a zero-prefixed expanded GTIN-13 on output.
    with Image.fromarray(zxingcpp.create_barcode(value, format_).to_image(scale=3, add_quiet_zones=True)) as image:
        return image.convert('L').rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=255)


def damaged(corpus):
    document = json.loads((ROOT / 'tests/fixtures' / corpus).read_text())
    case = next(item for item in document['cases'] if item['name'].endswith('ean13-label-2/angled-2'))
    with Image.frombytes('RGBA', (case['width'], case['height']),
                         zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))) as image:
        return image.convert('RGB'), case['expected'][0]['text']


@pytest.mark.parametrize('corpus', ['damage-stress-verify.json', 'damage-stress-accuracy-next.json'])
@pytest.mark.parametrize('allowed', [None, ['ean13', 'upce']])
def test_oblique_ean_extra_upce_needs_a_contradictory_corroborated_source_footprint(reader, monkeypatch, corpus, allowed):
    image, expected = damaged(corpus)
    native = zxingcpp.read_barcodes
    original = native(image)
    assert {code.format.name for code in original} == {'EAN13', 'UPCE'}, 'The native ambiguity is real.'
    calls = []

    def observed(candidate, **options):
        calls.append((candidate.size, options))
        return native(candidate, **options)

    monkeypatch.setattr(zxingcpp, 'read_barcodes', observed)
    with image:
        found = reader.read_barcodes(image, allowed_formats=allowed)
    assert [(code.format.name, code.text) for code in found] == [('EAN13', expected)]
    assert len(calls) == 2, 'Only one source-aligned corroboration decode is allowed.'
    assert calls[1][0][0] * calls[1][0][1] <= reader.MAX_RETRY_PIXELS
    if allowed:
        formats = zxingcpp.BarcodeFormats([zxingcpp.BarcodeFormat.EAN13, zxingcpp.BarcodeFormat.UPCE])
        assert all(options['formats'] == formats for _, options in calls)


@pytest.mark.parametrize('angle', [-75, -45, -15, 0, 15, 30, 60, 90])
@pytest.mark.parametrize('value,expected', [('04252614', '0042100005264'), ('01234565', '0012345000065')])
def test_real_upce_alone_preserves_its_expanded_value_at_oblique_angles(reader, angle, value, expected):
    with encoded(zxingcpp.BarcodeFormat.UPCE, value, angle) as image:
        found = reader.read_barcodes(image)
    assert {(code.format.name, code.text, code.bytes) for code in found} == {('UPCE', expected, expected.encode())}


@pytest.mark.parametrize('upce_angle,ean_angle', [(-75, 0), (-45, 0), (-15, 90), (0, 0), (15, 0), (30, 90), (60, 0), (90, 90)])
def test_separate_real_upce_and_ean_codes_keep_both_identities(reader, upce_angle, ean_angle):
    with encoded(zxingcpp.BarcodeFormat.UPCE, '04252614', upce_angle) as upce, \
         encoded(zxingcpp.BarcodeFormat.EAN13, '4006381333931', ean_angle) as ean, \
         Image.new('L', (upce.width + ean.width + 100, max(upce.height, ean.height) + 60), 255) as scene:
        scene.paste(upce, (20, 20)); scene.paste(ean, (upce.width + 70, 30))
        expected = {('UPCE', '0042100005264'), ('EAN13', '4006381333931')}
        assert {(code.format.name, code.text) for code in zxingcpp.read_barcodes(scene)} == expected
        for allowed in (None, ['ean13', 'upce']):
            found = reader.read_barcodes(scene, allowed_formats=allowed)
            assert {(code.format.name, code.text) for code in found} == expected


def test_uncertain_or_failed_corroboration_keeps_original_conflicting_evidence(reader, monkeypatch):
    image, _ = damaged('damage-stress-accuracy-next.json')
    native = zxingcpp.read_barcodes
    original = native(image)
    calls = 0

    def unreadable_check(candidate, **options):
        nonlocal calls
        calls += 1
        return original if calls == 1 else []

    monkeypatch.setattr(zxingcpp, 'read_barcodes', unreadable_check)
    with image:
        found = reader.read_barcodes(image)
    assert {code.format.name for code in found} == {'EAN13', 'UPCE'}
    assert calls == 2


def test_expired_first_pass_cannot_start_optional_corroboration(reader, monkeypatch):
    image, _ = damaged('damage-stress-accuracy-next.json')
    times = iter([0, reader.RETRY_SECONDS])
    monkeypatch.setattr(reader, 'monotonic', lambda: next(times))
    monkeypatch.setattr(reader, '_working_image', lambda _: pytest.fail('Expired evidence must not start another image allocation.'))
    with image:
        found = reader.read_barcodes(image)
    assert {code.format.name for code in found} == {'EAN13', 'UPCE'}


def test_corroboration_requires_an_oriented_footprint_covering_the_same_scan_segment(reader):
    record = reader.DecodedBarcode('x', zxingcpp.BarcodeFormat.UPCE, b'x', ((0, 0), (20, 0), (20, 2), (0, 2)))
    distant = reader.DecodedBarcode('y', zxingcpp.BarcodeFormat.EAN13, b'y', ((30, 0), (70, 0), (70, 20), (30, 20)))
    degenerate = reader.DecodedBarcode('y', zxingcpp.BarcodeFormat.EAN13, b'y', ((0, 0), (50, 0), (50, 0), (0, 0)))
    assert not reader._same_symbol_segment(record, distant)
    assert not reader._same_symbol_segment(record, degenerate)


# EAN-13 values whose left half is, bar for bar, a checksum-valid number-system-1
# UPC-E, with that UPC-E as the native decoder reports it. One value for each
# UPC-E expansion rule (sixth digit 0-2, 3, 4 and 5-9).
LEFT_HALF_ALIASES = [('5067751808601', '0106100007755'), ('4001753562476', '0100100000754'),
                     ('4019984607026', '0101990000084'), ('9364168251423', '0136416000089')]


@pytest.mark.parametrize('angle', [-45, 30, 45, 60])
@pytest.mark.parametrize('value,alias', LEFT_HALF_ALIASES)
def test_oblique_ean_reported_only_as_its_left_half_upce_returns_the_whole_ean(reader, angle, value, alias):
    with encoded(zxingcpp.BarcodeFormat.EAN13, value, angle) as image:
        native = {(code.format.name, code.text) for code in zxingcpp.read_barcodes(image)}
        assert native == {('UPCE', alias)}, 'The native wrong reading is real and arrives without the EAN-13.'
        for allowed in (None, ['ean13', 'upce']):
            found = reader.read_barcodes(image, allowed_formats=allowed)
            assert [(code.format.name, code.text, code.bytes) for code in found] == [('EAN13', value, value.encode())]
            assert all(0 <= x <= image.width and 0 <= y <= image.height for x, y in found[0].points)
        # The caller excluded EAN-13, so there is nothing to compare the UPC-E against.
        assert {code.format.name for code in reader.read_barcodes(image, allowed_formats=['upce'])} == {'UPCE'}


@pytest.mark.parametrize('angle', [-60, -45, -30, 0, 30, 45, 60])
def test_real_number_system_one_upce_is_not_taken_for_an_ean_left_half(reader, angle):
    with encoded(zxingcpp.BarcodeFormat.UPCE, '15766746', angle) as image:
        for allowed in (None, ['ean13', 'upce']):
            found = reader.read_barcodes(image, allowed_formats=allowed)
            assert {(code.format.name, code.text, code.bytes) for code in found} == {
                ('UPCE', '0157660000076', b'0157660000076')}


def test_left_half_replacement_needs_a_reread_that_spells_the_same_upce(reader, monkeypatch):
    value, alias = LEFT_HALF_ALIASES[0]
    other = '4006381333931'  # A readable EAN-13 whose left half spells no UPC-E.
    native = zxingcpp.read_barcodes
    with encoded(zxingcpp.BarcodeFormat.EAN13, value, 45) as image, \
         encoded(zxingcpp.BarcodeFormat.EAN13, other) as unrelated:
        original = native(image)
        for reread in ([], native(unrelated)):
            calls = []

            def observed(candidate, **options):
                calls.append(options)
                return original if len(calls) == 1 else reread

            monkeypatch.setattr(zxingcpp, 'read_barcodes', observed)
            found = reader.read_barcodes(image)
            # Unconfirmed evidence is kept or withheld by the existing checks; it is never exchanged.
            assert all((code.format.name, code.text) == ('UPCE', alias) for code in found)
            assert calls[1] == {'formats': zxingcpp.BarcodeFormat.EAN13}, 'One EAN-13 reread of the deskewed source.'


@pytest.mark.parametrize('value,alias', LEFT_HALF_ALIASES + [
    ('9300633000196', '0130000000639'),
    ('4006381333931', None), ('5901234123457', None),  # check sums that do not work out
    ('0036000291452', None),  # a UPC-A: its left half has no UPC-E parity pattern
    ('506775180860', None), ('50677518086O1', None),
])
def test_left_half_alias_follows_the_upce_expansion_rules(reader, value, alias):
    assert reader._ean_left_half_alias(value.encode()) == (alias.encode() if alias else None)
