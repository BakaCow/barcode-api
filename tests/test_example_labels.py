"""Shipped example labels must actually decode to the demo catalogue values."""
from pathlib import Path

from PIL import Image
import pytest
import zxingcpp


@pytest.mark.parametrize(("name", "text", "format"), [
    ("tea", "DEMO-TEA-01", zxingcpp.BarcodeFormat.Code128),
    ("oats", "DEMO-OATS-02", zxingcpp.BarcodeFormat.Code128),
    ("bag", "DEMO:BAG:03", zxingcpp.BarcodeFormat.QRCode),
])
def test_shipped_pos_label_decodes_exactly(name, text, format):
    label = Path(__file__).resolve().parents[1] / "web" / "examples" / "pos" / "labels" / f"{name}.png"
    with Image.open(label) as image:
        results = zxingcpp.read_barcodes(image)
    assert [(result.text, result.format) for result in results] == [(text, format)]
