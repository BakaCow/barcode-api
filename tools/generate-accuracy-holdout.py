"""Generate a separate validation set after the decoder strategy was frozen.

These payloads and degradation parameters were not used to choose the retries.
Do not tune the scanner against these cases and continue to call them holdout data.
"""

import argparse
import importlib.util
import json
from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFilter, ImageOps
import zxingcpp


ROOT = Path(__file__).resolve().parents[1]
SEED = 958217
spec = importlib.util.spec_from_file_location("accuracy_generator", Path(__file__).with_name("generate-accuracy-fixtures.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def ean13(rng):
    first = "7" + "".join(str(rng.randrange(10)) for _ in range(11))
    check = (-sum(int(digit) * (1 if index % 2 == 0 else 3) for index, digit in enumerate(first))) % 10
    return first + str(check)


def positives(rng):
    names = ["clean", "angle", "weak-contrast", "blur", "inverted", "shade", "scratch", "small-frame"]
    for slug, format_, _, formats in base.SYMBOLS:
        for index, degradation in enumerate(names):
            payload = ean13(rng) if slug == "ean13" else f"VALIDATE-{slug.upper()}-{rng.randrange(100000, 999999)}-{index}"
            code = zxingcpp.create_barcode(payload, format_)
            image = ImageOps.expand(Image.fromarray(code.to_image(scale=3, add_quiet_zones=True)).convert("L"), border=16, fill=255)
            parameters = {}
            if degradation == "angle":
                parameters["degrees"] = round(rng.uniform(13, 78), 2)
                image = image.rotate(parameters["degrees"], Image.Resampling.BICUBIC, expand=True, fillcolor=255)
            elif degradation == "weak-contrast":
                black = rng.randrange(90, 160)
                parameters.update(black=black, white=black + rng.randrange(10, 29))
                image = base.shade(image, parameters["black"], parameters["white"], 0)
            elif degradation == "blur":
                parameters["radius"] = round(rng.uniform(0.7, 1.8), 2)
                image = image.filter(ImageFilter.GaussianBlur(parameters["radius"]))
            elif degradation == "inverted":
                image = ImageOps.invert(image)
            elif degradation == "shade":
                parameters["gradient"] = rng.randrange(70, 131)
                image = base.shade(image, 70, 102, parameters["gradient"])
            elif degradation == "scratch":
                parameters["width"] = rng.randrange(1, 5)
                draw = ImageDraw.Draw(image)
                draw.line((image.width * 0.12, image.height * 0.64, image.width * 0.91, image.height * 0.22), fill=255, width=parameters["width"])
            elif degradation == "small-frame":
                parameters["scale"] = round(rng.uniform(0.35, 0.62), 2)
                image = base.center(image.resize((round(image.width * parameters["scale"]), round(image.height * parameters["scale"])), Image.Resampling.LANCZOS), (1400, 800))
            yield f"{slug}/{degradation}", image, [{"text": payload, "formats": formats}], parameters


def negatives(rng):
    image = Image.new("L", (500, 300), 255)
    ImageDraw.Draw(image).multiline_text((25, 25), "STORE RECEIPT\nOrder 984621\n3 x Widget 12.50\nTOTAL 37.50\nThank you for shopping", fill=0, spacing=8)
    yield "receipt-text", image
    yield "gradient", base.shade(Image.new("L", (640, 360), 0), 20, 60, 220)
    image = Image.new("L", (640, 360), 255)
    draw = ImageDraw.Draw(image)
    for x in range(-360, 640, 15):
        draw.line((x, 0, x + 360, 360), fill=0, width=4)
    yield "diagonal-lines", image
    image = Image.new("L", (340, 255), 255)
    draw = ImageDraw.Draw(image)
    for y in range(0, 255, 17):
        for x in range(0, 340, 17):
            if (x // 17 + y // 17) % 2:
                draw.rectangle((x, y, x + 16, y + 16), fill=0)
    yield "checkerboard", image
    yield "color-noise", Image.frombytes("RGB", (128, 96), bytes(rng.randrange(256) for _ in range(128 * 96 * 3)))
    image = Image.new("L", (600, 180), 255)
    draw = ImageDraw.Draw(image)
    x = 20
    while x < 575:
        width = rng.randrange(1, 8)
        draw.rectangle((x, 20, x + width, 160), fill=0)
        x += width + rng.randrange(2, 9)
    yield "random-bars", image
    image = Image.new("L", (224, 224), 255)
    draw = ImageDraw.Draw(image)
    for y in range(16, 208, 8):
        for x in range(16, 208, 8):
            if rng.random() < 0.5:
                draw.rectangle((x, y, x + 7, y + 7), fill=0)
    yield "random-modules", image
    code = zxingcpp.create_barcode("INCOMPLETE-842617", zxingcpp.BarcodeFormat.Code128)
    image = Image.fromarray(code.to_image(scale=3, add_quiet_zones=True)).convert("L")
    yield "truncated-code128", ImageOps.expand(image.crop((0, 0, image.width * 2 // 3, image.height)), border=16, fill=255)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "tests/fixtures/accuracy-holdout.json")
    parser.add_argument("--images", type=Path)
    args = parser.parse_args()
    rng = random.Random(SEED)
    cases = []
    if args.images:
        args.images.mkdir(parents=True, exist_ok=True)
    for name, image, expected, parameters in positives(rng):
        case = base.encode_case(name, image, expected)
        case["parameters"] = parameters
        cases.append(case)
        if args.images:
            image.save(args.images / f"{name.replace('/', '-')}.png")
    for name, image in negatives(rng):
        cases.append(base.encode_case(f"negative/{name}", image, []))
        if args.images:
            image.save(args.images / f"negative-{name}.png")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({
        "version": 1,
        "seed": SEED,
        "description": "Separate synthetic validation set generated after the four fallback strategies were frozen; different payloads and unseen degradation values. No post-result tuning against these cases. Not real-camera images or a Scanbot comparison.",
        "cases": cases,
    }, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(cases)} holdout cases to {args.output} ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
