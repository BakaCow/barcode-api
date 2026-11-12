"""Generate a fixed synthetic challenge set; it is not a real-camera benchmark.

Run with the project's Python dependencies installed. The seed, source payloads,
and degradation parameters are deliberately fixed so before/after results remain
comparable. Some cases remove too much information to be recoverable.
"""

import argparse
import base64
import json
from pathlib import Path
import random
import zlib

from PIL import Image, ImageDraw, ImageFilter, ImageOps
import zxingcpp


ROOT = Path(__file__).resolve().parents[1]
SEED = 421913
SYMBOLS = [
    ("qr", zxingcpp.BarcodeFormat.QRCode, "accuracy-test://qr/421913?payload=offline", ["QRCode"]),
    ("code128", zxingcpp.BarcodeFormat.Code128, "ACCURACY-421913-BOX", ["Code128"]),
    ("ean13", zxingcpp.BarcodeFormat.EAN13, "5901234123457", ["EAN13"]),
    ("datamatrix", zxingcpp.BarcodeFormat.DataMatrix, "ACCURACY-421913-DM", ["DataMatrix"]),
]


def center(image, size, background=255):
    result = Image.new("L", size, background)
    result.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2))
    return result


def shade(image, black, white, gradient):
    source = image.convert("L")
    output = bytearray(source.width * source.height)
    for y in range(source.height):
        for x in range(source.width):
            value = source.getpixel((x, y))
            light = gradient * x / max(1, source.width - 1)
            output[y * source.width + x] = round(min(255, max(0, black + value * (white - black) / 255 + light)))
    return Image.frombytes("L", source.size, bytes(output))


def scratch(image):
    result = image.copy()
    draw = ImageDraw.Draw(result)
    draw.line((image.width * 0.1, image.height * 0.3, image.width * 0.9, image.height * 0.7), fill=255, width=3)
    return result


def missing_patch(image):
    result = image.copy()
    draw = ImageDraw.Draw(result)
    draw.rectangle((image.width * 0.46, image.height * 0.2, image.width * 0.54, image.height * 0.8), fill=255)
    return result


def variants(image):
    for name, result in [
        ("clean", image),
        ("rotate-17", image.rotate(17, Image.Resampling.BICUBIC, expand=True, fillcolor=255)),
        ("rotate-37", image.rotate(37, Image.Resampling.BICUBIC, expand=True, fillcolor=255)),
        ("rotate-73", image.rotate(73, Image.Resampling.BICUBIC, expand=True, fillcolor=255)),
        ("inverted", ImageOps.invert(image)),
        ("weak-contrast", shade(image, 116, 132, 0)),
        ("weak-shaded", shade(image, 90, 111, 95)),
        ("blur-0.8", image.filter(ImageFilter.GaussianBlur(0.8))),
        ("blur-1.4", image.filter(ImageFilter.GaussianBlur(1.4))),
        ("blur-2.2", image.filter(ImageFilter.GaussianBlur(2.2))),
        ("downsampled", image.resize((max(1, round(image.width * 0.45)), max(1, round(image.height * 0.45))), Image.Resampling.BILINEAR)),
        ("bright-gradient", shade(image, 50, 195, 120)),
        ("scratch", scratch(image)),
        ("missing-patch", missing_patch(image)),
        ("small-in-frame", center(image.resize((max(1, image.width // 3), max(1, image.height // 3)), Image.Resampling.LANCZOS), (1600, 900))),
        ("skew", image.transform((image.width + image.height // 3, image.height), Image.Transform.AFFINE, (1, -0.32, 0, 0, 1, 0), resample=Image.Resampling.BICUBIC, fillcolor=255)),
    ]:
        yield name, result


def negative_images():
    rng = random.Random(SEED)
    yield "white", Image.new("L", (640, 360), 255)
    yield "black", Image.new("L", (640, 360), 0)
    yield "gray", Image.new("L", (640, 360), 127)
    noise = Image.frombytes("L", (192, 128), bytes(rng.randrange(256) for _ in range(192 * 128)))
    yield "noise", noise
    yield "blurred-noise", noise.filter(ImageFilter.GaussianBlur(1))
    for name, spacing in [("stripes", 7), ("dense-stripes", 2)]:
        image = Image.new("L", (640, 200), 255)
        draw = ImageDraw.Draw(image)
        for x in range(20, 620, spacing * 2):
            draw.rectangle((x, 20, x + spacing - 1, 180), fill=0)
        yield name, image
    image = Image.new("L", (320, 240), 255)
    draw = ImageDraw.Draw(image)
    for y in range(0, 240, 10):
        for x in range(0, 320, 10):
            if (x // 10 + y // 10) % 2:
                draw.rectangle((x, y, x + 9, y + 9), fill=0)
    yield "checkerboard", image


def encode_case(name, image, expected):
    rgba = image.convert("RGBA")
    return {
        "name": name,
        "width": image.width,
        "height": image.height,
        "expected": expected,
        "rgba_zlib_base64": base64.b64encode(zlib.compress(rgba.tobytes(), 9)).decode("ascii"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "tests/fixtures/accuracy-pixels.json")
    parser.add_argument("--images", type=Path, help="Optionally save inspectable PNG images to this directory.")
    args = parser.parse_args()
    cases = []
    if args.images:
        args.images.mkdir(parents=True, exist_ok=True)
    for name, format_, payload, formats in SYMBOLS:
        code = zxingcpp.create_barcode(payload, format_)
        image = Image.fromarray(code.to_image(scale=3, add_quiet_zones=True)).convert("L")
        # A quiet background preserves complete borders after geometric transforms.
        image = ImageOps.expand(image, border=12, fill=255)
        for variant, transformed in variants(image):
            case_name = f"{name}/{variant}"
            cases.append(encode_case(case_name, transformed, [{"text": payload, "formats": formats}]))
            if args.images:
                transformed.save(args.images / f"{name}-{variant}.png")
    for name, image in negative_images():
        cases.append(encode_case(f"negative/{name}", image, []))
        if args.images:
            image.save(args.images / f"negative-{name}.png")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        "version": 1,
        "seed": SEED,
        "description": "Fixed synthetic degradation suite. Generated by ZXing-C++ 3.1.1 and Pillow 12.3.0. Not camera photos or a Scanbot comparison; no cases were removed after results were measured.",
        "cases": cases,
    }, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(cases)} cases to {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
