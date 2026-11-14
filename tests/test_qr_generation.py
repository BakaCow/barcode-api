"""Generation options are verified from rendered pixels and the encoded symbol."""
from io import BytesIO
from xml.etree import ElementTree

from PIL import Image, ImageOps
import pytest
from pydantic import ValidationError
import zxingcpp

from app import GenerateRequest, generate


@pytest.mark.parametrize('level', ['L', 'M', 'Q', 'H'])
@pytest.mark.parametrize('quiet', [4, 8, 16])
def test_qr_error_correction_and_minimum_module_border_are_encoded(level, quiet):
    text, scale = 'QR-GENERATION-CONTROL / café 日本語', 3
    response = generate(GenerateRequest(text=text, qr_error_correction=level, qr_quiet_zone=quiet, scale=scale))
    assert response.media_type == 'image/png'
    with Image.open(BytesIO(response.body)) as image:
        assert image.width == image.height
        ink = ImageOps.invert(image.convert('L')).getbbox()
        margin = quiet * scale
        assert ink == (margin, margin, image.width - margin, image.height - margin)
        found = zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.QRCode)
    assert len(found) == 1
    assert found[0].text == text and found[0].ec_level == level


def test_omitting_qr_options_preserves_existing_png_and_svg_output():
    text, scale = 'QR-GENERATION-DEFAULT', 4
    native = zxingcpp.create_barcode(text, zxingcpp.BarcodeFormat.QRCode)
    assert native.ec_level == 'L'
    with Image.fromarray(native.to_image(scale=scale, add_quiet_zones=True)) as image:
        expected = BytesIO(); image.save(expected, format='PNG')
    png = generate(GenerateRequest(text=text, scale=scale))
    svg = generate(GenerateRequest(text=text, scale=scale, output='svg'))
    assert png.body == expected.getvalue()
    assert svg.body == native.to_svg(scale=scale, add_quiet_zones=True).encode()


@pytest.mark.parametrize('quiet', [5, 16])
def test_svg_border_uses_scaled_modules_and_never_inserts_payload_markup(quiet):
    text, scale = '<script>alert("literal barcode content")</script>', 2
    response = generate(GenerateRequest(text=text, output='svg', scale=scale,
                                        qr_error_correction='H', qr_quiet_zone=quiet))
    root = ElementTree.fromstring(response.body)
    namespace = '{http://www.w3.org/2000/svg}'
    assert root.tag == namespace + 'svg'
    assert not list(root.iter(namespace + 'script'))
    assert b'alert(' not in response.body
    inner = root.find(namespace + 'svg')
    assert inner is not None
    assert int(inner.get('x')) == int(inner.get('y')) == quiet * scale
    assert int(root.get('width')) == int(inner.get('width')) + 2 * quiet * scale
    assert int(root.get('height')) == int(inner.get('height')) + 2 * quiet * scale
    assert root.find(namespace + 'rect').get('fill') == '#FFFFFF'


@pytest.mark.parametrize('options', [{'qr_quiet_zone': 3}, {'qr_quiet_zone': 17},
                                     {'qr_quiet_zone': True}, {'qr_quiet_zone': 4.0},
                                     {'qr_quiet_zone': '4'}, {'qr_error_correction': 'h'},
                                     {'qr_error_correction': '100%'}, {'qr_error_correction': 2}])
def test_invalid_qr_options_are_rejected_before_encoding(options):
    with pytest.raises(ValidationError):
        GenerateRequest(text='QR-GENERATION-INVALID', **options)


@pytest.mark.parametrize('format_', ['code128', 'ean13', 'upca'])
@pytest.mark.parametrize('options', [{'qr_error_correction': 'H'}, {'qr_quiet_zone': 4}])
def test_qr_options_are_not_silently_ignored_for_other_formats(format_, options):
    with pytest.raises(ValidationError, match='only to QR'):
        GenerateRequest(format=format_, text='123456', **options)
