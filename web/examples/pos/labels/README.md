# Demo label assets

These labels were generated locally with the project's pinned ZXing-C++ dependency. They encode fictional catalogue entries from `../cart.mjs`, include quiet zones, and contain no tracking URL or customer data. SVG files are used for page previews; PNG files can be downloaded and imported into the plain JavaScript example with matching frames set to one.

To regenerate them, run Python from this project root using its virtual environment:

```python
from pathlib import Path
from PIL import Image
import zxingcpp

destination = Path("web/examples/pos/labels")
labels = [
    ("tea", "DEMO-TEA-01", zxingcpp.BarcodeFormat.Code128),
    ("oats", "DEMO-OATS-02", zxingcpp.BarcodeFormat.Code128),
    ("bag", "DEMO:BAG:03", zxingcpp.BarcodeFormat.QRCode),
]
for name, value, format in labels:
    code = zxingcpp.create_barcode(value, format)
    (destination / f"{name}.svg").write_text(
        code.to_svg(scale=4, add_quiet_zones=True), encoding="utf-8"
    )
    Image.fromarray(code.to_image(scale=4, add_quiet_zones=True)).save(
        destination / f"{name}.png"
    )
```

`tests/test_example_labels.py` checks real decoding of every shipped PNG against its exact format and known value.
