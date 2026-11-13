"""Generate a development regression scene for automatic source-detail recovery.

This is a deliberate development fixture, not part of the withheld evaluation.
The barcode value comes from the encoder input, never a decoder prediction.
Browser tests simulate nearest-neighbor sampling; this is not a phone-camera
accuracy measurement.
"""
import base64
import json
from pathlib import Path
import zlib

from PIL import Image
import zxingcpp


def main():
    text = "9384716502814"
    encoded = zxingcpp.create_barcode(text, zxingcpp.BarcodeFormat.EAN13)
    label = Image.fromarray(encoded.to_image(scale=1, add_quiet_zones=True))
    assert label.width == 113
    label = label.resize((113, 70), Image.Resampling.NEAREST).convert("RGBA")
    scene = Image.new("RGBA", (2560, 1440), "white")
    scene.paste(label, (1128, 670))
    document = {
        "name": "EAN13-source-detail-recovery",
        "provenance": "Development fixture; independent encoder; nearest-neighbor camera simulation.",
        "width": scene.width, "height": scene.height,
        "expected": [{"text": text, "formats": ["EAN13"]}],
        "label": {"width": label.width, "height": label.height, "x": 1128, "y": 670},
        "rgba_zlib_base64": base64.b64encode(zlib.compress(scene.tobytes(), 9)).decode("ascii"),
    }
    output = Path(__file__).resolve().parents[1] / "tests/fixtures/automatic-capture-recovery.json"
    output.write_text(json.dumps(document, separators=(",", ":")) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
