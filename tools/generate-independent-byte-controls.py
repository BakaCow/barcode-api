"""Development-only encoder-input controls for independent decoder integration.

No decoder predictions define expected bytes. These controls are not a holdout.
"""
import base64
import json
from pathlib import Path
import zlib

from PIL import Image
import zxingcpp


def main():
    samples = [("ascii", "Code128", b"BYTE-CONTROL/aZ"),
               ("code-c", "Code128", b"592816940731028491"),
               ("controls", "Code128", b"CTRL-\x00\x1d\x7f"),
               ("code-a", "Code128", b"\x01A\x02B"),
               ("fnc4", "Code128", b"BYTE-\x80\xbe\xff"),
               ("fnc4-mixed", "Code128", b"A\x80B\xffC"),
               ("leading-zero-ean", "EAN13", "0042100005264"),
               ("upce-system-0", "UPCE", "04252614"),
               ("upce-system-1", "UPCE", "15766746")]
    cases = []
    for name, format_name, payload in samples:
        barcode = zxingcpp.create_barcode(payload, getattr(zxingcpp.BarcodeFormat, format_name))
        image = Image.fromarray(barcode.to_image(scale=3, add_quiet_zones=True)).convert("RGBA")
        cases.append({"name": name, "format": format_name,
                      "encoderBytes": list(payload if isinstance(payload, bytes) else payload.encode("ascii")),
                      "width": image.width, "height": image.height,
                      "rgba_zlib_base64": base64.b64encode(zlib.compress(image.tobytes(), 9)).decode("ascii")})
    output = Path(__file__).resolve().parents[1] / "tests/fixtures/independent-byte-controls.json"
    output.write_bytes((json.dumps({"version": 1, "provenance": "Development encoder-input controls; not independent evaluation.", "cases": cases}, separators=(",", ":")) + "\n").encode())


if __name__ == "__main__":
    main()
