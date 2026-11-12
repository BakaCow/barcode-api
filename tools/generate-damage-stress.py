"""Generate reproducible synthetic barcode damage tests with frozen group splits.

Run from the project environment: python tools/generate-damage-stress.py
Add --images PATH to export development PNGs; --image-split both explicitly
exports evaluation images too. No decoder is called, and no cases are selected
according to decoding success. Keep evaluation results unopened while tuning.
"""

import argparse
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import random
import zlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps
import zxingcpp


ROOT = Path(__file__).resolve().parents[1]
SEEDS = {"dev": 93640117, "eval": 57422093}
FORMATS = [("qr", zxingcpp.BarcodeFormat.QRCode, "QRCode"),
           ("code128", zxingcpp.BarcodeFormat.Code128, "Code128"),
           ("ean13", zxingcpp.BarcodeFormat.EAN13, "EAN13")]
MAX_PIXELS = 1_500_000


def ean13(first):
    assert len(first) == 12 and first.isdigit()
    return first + str((-sum(int(v) * (1 if i % 2 == 0 else 3)
                           for i, v in enumerate(first))) % 10)


def symbol(text, format_, scale=3, quiet=True):
    return Image.fromarray(zxingcpp.create_barcode(text, format_).to_image(
        scale=scale, add_quiet_zones=quiet)).convert("L")


def centered(image, size, offset=(0, 0), fill=250):
    result = Image.new("L", size, fill)
    result.paste(image, ((size[0] - image.width) // 2 + offset[0],
                         (size[1] - image.height) // 2 + offset[1]))
    return result


def motion_blur(image, length):
    """Uniform horizontal exposure integration with white outside the image."""
    half = length // 2
    result = None
    for index, offset in enumerate(range(-half, half + 1), 1):
        shifted = Image.new("L", image.size, 255)
        shifted.paste(image, (offset, 0))
        result = shifted if result is None else Image.blend(result, shifted, 1 / index)
    return result


def shaded(image, black, white, gradient):
    mapped = image.point(lambda value: round(black + value * (white - black) / 255))
    ramp = Image.linear_gradient("L").rotate(90).resize(image.size)
    ramp = ramp.point(lambda value: round(value * gradient / 255))
    return ImageChops.add(mapped, ramp)


def solve(matrix, values):
    """Small pivoted linear solve; keeps the generator free of NumPy/OpenCV."""
    rows = [list(row) + [value] for row, value in zip(matrix, values)]
    for column in range(len(values)):
        pivot = max(range(column, len(values)), key=lambda row: abs(rows[row][column]))
        rows[column], rows[pivot] = rows[pivot], rows[column]
        divisor = rows[column][column]
        if abs(divisor) < 1e-10:
            raise ValueError("Degenerate perspective transform")
        rows[column] = [value / divisor for value in rows[column]]
        for row in range(len(values)):
            if row != column:
                factor = rows[row][column]
                rows[row] = [a - factor * b for a, b in zip(rows[row], rows[column])]
    return [row[-1] for row in rows]


def perspective(image, skew, tilt):
    width, height = image.size
    margin = 20
    destination = [(margin + skew * width, margin),
                   (margin + width, margin + tilt * height),
                   (margin + width * (1 - skew / 2), margin + height),
                   (margin, margin + height * (1 - tilt / 2))]
    source = [(0, 0), (width, 0), (width, height), (0, height)]
    matrix, values = [], []
    for (x, y), (u, v) in zip(destination, source):
        matrix.extend([[x, y, 1, 0, 0, 0, -u * x, -u * y],
                       [0, 0, 0, x, y, 1, -v * x, -v * y]])
        values.extend([u, v])
    transformed = image.transform((width + margin * 2, height + margin * 2),
                                  Image.Transform.PERSPECTIVE, solve(matrix, values),
                                  Image.Resampling.BICUBIC, fillcolor=255)
    return transformed, [[round(x, 4), round(y, 4)] for x, y in destination]


def variants(image, rng):
    yield "clean", 0, image.copy(), {}
    for severity in (1, 2):
        radius = round((0.75 if severity == 1 else 1.85) + rng.uniform(-0.12, 0.17), 3)
        yield "blur", severity, image.filter(ImageFilter.GaussianBlur(radius)), {"radius": radius}

        length = rng.choice([3, 5] if severity == 1 else [9, 11])
        yield "motion-blur", severity, motion_blur(image, length), {"direction": "horizontal", "lengthPixels": length}

        black = rng.randrange(70, 105) if severity == 1 else rng.randrange(105, 135)
        contrast = rng.randrange(35, 55) if severity == 1 else rng.randrange(9, 19)
        gradient = rng.randrange(40, 70) if severity == 1 else rng.randrange(65, 100)
        yield "shading-lowcontrast", severity, shaded(image, black, black + contrast, gradient), {
            "black": black, "white": black + contrast, "horizontalGradient": gradient}

        skew = round((0.13 if severity == 1 else 0.31) + rng.uniform(-0.03, 0.035), 4)
        tilt = round((0.10 if severity == 1 else 0.29) + rng.uniform(-0.025, 0.04), 4)
        warped, quad = perspective(image, skew, tilt)
        yield "perspective", severity, warped, {"skew": skew, "tilt": tilt, "destinationCorners": quad}

        angle = round(rng.uniform(11, 27) if severity == 1 else rng.uniform(42, 79), 3)
        yield "angled", severity, image.rotate(angle, Image.Resampling.BICUBIC, expand=True, fillcolor=255), {"degrees": angle}

        result = image.copy()
        draw = ImageDraw.Draw(result)
        scratch_width = rng.randrange(1, 3) if severity == 1 else rng.randrange(4, 8)
        count = 1 if severity == 1 else 3
        lines = []
        for _ in range(count):
            line = [round(image.width * 0.10), round(image.height * rng.uniform(0.2, 0.8)),
                    round(image.width * 0.90), round(image.height * rng.uniform(0.2, 0.8))]
            draw.line(line, fill=255, width=scratch_width)
            lines.append(line)
        yield "scratches", severity, result, {"widthPixels": scratch_width, "lines": lines}

        result = image.copy()
        fraction = round(rng.uniform(0.025, 0.045) if severity == 1 else rng.uniform(0.10, 0.16), 4)
        center_x = round(image.width * rng.uniform(0.43, 0.61))
        patch = [center_x - max(1, round(image.width * fraction / 2)), round(image.height * 0.18),
                 center_x + max(1, round(image.width * fraction / 2)), round(image.height * 0.82)]
        ImageDraw.Draw(result).rectangle(patch, fill=255)
        yield "missing-patch", severity, result, {"fractionWidth": fraction, "rectangle": patch}

        scale = round(rng.uniform(0.51, 0.66) if severity == 1 else rng.uniform(0.26, 0.39), 4)
        reduced = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
        offset = (rng.randrange(-170, 171), rng.randrange(-95, 96))
        result = centered(reduced, (1056, 672), offset)
        yield "small-in-frame", severity, result, {"scale": scale, "canvas": [1056, 672], "offsetFromCenter": list(offset)}

        # Mild: erase the left quiet zone. Severe: remove actual symbol modules.
        ink = ImageOps.invert(image).getbbox()
        cut = max(0, ink[0] - 1) if severity == 1 else ink[0] + max(2, round((ink[2] - ink[0]) * rng.uniform(0.035, 0.075)))
        yield "clipping", severity, image.crop((cut, 0, image.width, image.height)), {"leftPixelsRemoved": cut, "cutsSymbol": severity == 2}


def payloads(split, rng):
    for slug, format_, expected_format in FORMATS:
        for index in range(3):
            if slug == "ean13":
                text = ean13("7" + "".join(str(rng.randrange(10)) for _ in range(11)))
            elif slug == "qr":
                text = f"https://example.com/stress/{split}/{rng.randrange(10**9, 10**10)}/{index}"
            elif index == 1:
                text = "".join(str(rng.randrange(10)) for _ in range(24))
            elif index == 2:
                text = f"bx:{split[0]}-{rng.randrange(100000, 999999)}/aZ"
            else:
                text = f"BOX-{split.upper()}-{rng.randrange(100000, 999999)}"
            group = f"{split}-{slug}-label-{index + 1}"
            image = ImageOps.expand(symbol(text, format_, scale=3), border=12, fill=255)
            for condition, severity, transformed, parameters in variants(image, rng):
                yield f"{slug}/{group}/{condition}-{severity}", group, condition, severity, transformed, [{"text": text, "formats": [expected_format]}], parameters


def invalid_code128(rng):
    # Uppercase letters force Code Set B throughout. Replace the checksum with
    # a different valid symbol pattern, preserving its width and all guards.
    payload = "NEGATIVE-" + "".join(rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ") for _ in range(6))
    correct = (104 + sum(i * (ord(value) - 32) for i, value in enumerate(payload, 1))) % 103
    replacement_text = "A" if correct != 34 else "B"
    wrong = 34 if replacement_text == "A" else 35
    image = symbol(payload, zxingcpp.BarcodeFormat.Code128, 1, False)
    replacement = symbol(replacement_text, zxingcpp.BarcodeFormat.Code128, 1, False)
    assert image.width == 11 * (len(payload) + 2) + 13
    assert correct != wrong
    image.paste(replacement.crop((replacement.width - 24, 0, replacement.width - 13, replacement.height)),
                (image.width - 24, 0))
    image = ImageOps.expand(image.resize((image.width * 3, image.height * 3), Image.Resampling.NEAREST), border=30, fill=255)
    return image, {"construction": "Code128 B with intentionally replaced modulo-103 checksum", "payload": payload,
                   "validChecksum": correct, "renderedChecksum": wrong}


def invalid_ean13(rng):
    prefix = "8" + "".join(str(rng.randrange(10)) for _ in range(11))
    payload = ean13(prefix)
    altered = ean13(prefix[:-1] + str((int(prefix[-1]) + 1) % 10))
    assert payload[-1] != altered[-1]
    image = symbol(payload, zxingcpp.BarcodeFormat.EAN13, 1, False)
    replacement = symbol(altered, zxingcpp.BarcodeFormat.EAN13, 1, False)
    assert image.width == replacement.width == 95
    # EAN-13's last digit occupies modules 85..91 before its final 101 guard.
    image.paste(replacement.crop((85, 0, 92, replacement.height)), (85, 0))
    image = ImageOps.expand(image.resize((image.width * 3, image.height * 3), Image.Resampling.NEAREST), border=30, fill=255)
    return image, {"construction": "EAN13 with intentionally incorrect final check digit", "first12": prefix,
                   "validCheckDigit": payload[-1], "renderedCheckDigit": altered[-1]}


def negatives(split, rng):
    for index in range(6):
        width, height = 384, 256
        for family in ("receipt-text", "woven-texture", "short-random-bars", "finder-lookalikes", "noise-texture", "circles", "invalid-code128-checksum", "invalid-ean13-checksum"):
            image = Image.new("L", (width, height), 248)
            draw = ImageDraw.Draw(image)
            parameters = {"variant": index}
            if family == "receipt-text":
                lines = ["RECEIPT / NO BARCODE", f"Order {rng.randrange(100000, 999999)}"]
                lines.extend(f"{rng.randrange(1, 9)} x ITEM {rng.randrange(10, 99)}   {rng.randrange(1, 99)}.50" for _ in range(8))
                draw.multiline_text((18, 16), "\n".join(lines), fill=12, spacing=7)
            elif family == "woven-texture":
                step = 7 + index
                for y in range(0, height, step):
                    draw.line((0, y, width, y + index % 3), fill=70, width=2)
                for x in range(0, width, step + 3):
                    draw.line((x, 0, x + index % 4, height), fill=110, width=2)
                parameters["spacing"] = step
            elif family == "short-random-bars":
                # Each separated fragment has 15 alternating runs, fewer than
                # a complete Code128 or EAN symbol; it is not an encoded label.
                fragments = []
                for y in (30, 120):
                    for start in (20, 215):
                        x = start
                        widths = [rng.randrange(2, 7) for _ in range(15)]
                        for run, bar_width in enumerate(widths):
                            if run % 2 == 0:
                                draw.rectangle((x, y, x + bar_width - 1, y + 60), fill=8)
                            x += bar_width
                        fragments.append(widths)
                parameters.update(construction="Separated 15-run fragments with no complete symbol", widths=fragments)
            elif family == "finder-lookalikes":
                module = 5 + index % 3
                for x, y in ((25, 30), (220, 145)):
                    for inset, color in ((0, 0), (1, 248), (2, 0)):
                        draw.rectangle((x + inset * module, y + inset * module,
                                        x + (7 - inset) * module - 1, y + (7 - inset) * module - 1), fill=color)
                parameters.update(construction="Two isolated finder-like rings, no symbol data or timing grid", module=module)
            elif family == "noise-texture":
                low = Image.frombytes("L", (64, 48), bytes(rng.randrange(30, 225) for _ in range(64 * 48)))
                image = low.resize((width, height), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(0.7))
                parameters["construction"] = "Continuous random surface texture, not encoded modules"
            elif family == "circles":
                for circle in range(18):
                    x, y = rng.randrange(width - 65), rng.randrange(height - 65)
                    radius = rng.randrange(12, 60)
                    draw.ellipse((x, y, x + radius, y + radius), outline=rng.randrange(0, 100), width=2 + circle % 3)
            elif family == "invalid-code128-checksum":
                image, parameters = invalid_code128(rng)
            elif family == "invalid-ean13-checksum":
                image, parameters = invalid_ean13(rng)
            group = f"{split}-negative-{family}-{index + 1}"
            yield f"negative/{family}/{index + 1}", group, family, 0, image, [], parameters


def encode_case(item):
    name, group, condition, severity, image, expected, parameters = item
    if image.width * image.height > MAX_PIXELS:
        raise ValueError(f"Case exceeds pixel limit: {name}")
    return {"name": name, "width": image.width, "height": image.height,
            "expected": expected, "groupId": group, "condition": condition,
            "severity": severity, "parameters": parameters, "source": "synthetic",
            "rgba_zlib_base64": base64.b64encode(zlib.compress(image.convert("RGBA").tobytes(), 9)).decode("ascii")}


def generate(split, output, images=None):
    rng = random.Random(SEEDS[split])
    cases = []
    for item in (*payloads(split, rng), *negatives(split, rng)):
        cases.append(encode_case(item))
        if images:
            images.mkdir(parents=True, exist_ok=True)
            item[4].save(images / f"{split}-{item[0].replace('/', '--')}.png")
    generator_source = Path(__file__).read_text(encoding="utf-8").replace("\r\n", "\n")
    document = {
        "version": 1, "seed": SEEDS[split], "split": split,
        "description": "Fixed synthetic damage stress suite. Human-chosen payload rules and encoder-generated ground truth; no decoded predictions or outcome filtering. Not camera photos, a phone benchmark, or a Scanbot comparison. Missing information may be irrecoverable.",
        "provenance": {"generator": "tools/generate-damage-stress.py",
                       "generatorSha256": hashlib.sha256(generator_source.encode()).hexdigest(),
                       "generatorHashMethod": "SHA256 of UTF-8 source with CRLF normalized to LF",
                       "dependencies": {name: importlib.metadata.version(name) for name in ("Pillow", "zxing-cpp")},
                       "seed": SEEDS[split], "grouping": "Every transform of one payload is confined to one split; dev/eval payload groups are disjoint.",
                       "evaluationPolicy": "Freeze evaluation fixture before algorithm changes. Do not inspect its decoding results while tuning development cases.",
                       "positiveGroupsPerFormat": 3, "variantsPerPositiveGroup": 19,
                       "negativeFamilies": 8, "negativeVariantsPerFamily": 6,
                       "maximumPixelsPerCase": MAX_PIXELS,
                       "negativePolicy": "No valid encoded labels. Deliberately invalid checksum symbols and unencoded textures. No decoder filtering: any decoder output remains an unexpected result.",
                       "severityMeaning": {"0": "clean positive or constructed negative", "1": "milder damage", "2": "stronger damage; not guaranteed recoverable"}},
        "cases": cases,
    }
    encoded = (json.dumps(document, separators=(",", ":")) + "\n").encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and output.read_bytes() != encoded:
        raise ValueError(f"Refusing to overwrite changed frozen fixture: {output}. Choose another --output-dir for a new corpus.")
    output.write_bytes(encoded)
    print(json.dumps({"split": split, "cases": len(cases), "positives": sum(bool(case["expected"]) for case in cases),
                      "negatives": sum(not case["expected"] for case in cases), "bytes": len(encoded),
                      "sha256": hashlib.sha256(encoded).hexdigest(), "output": str(output)}), flush=True)
    return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "tests/fixtures")
    parser.add_argument("--split", choices=["both", "dev", "eval"], default="both")
    parser.add_argument("--images", type=Path, help="Optionally export inspectable PNGs; development only by default.")
    parser.add_argument("--image-split", choices=["dev", "eval", "both"], default="dev")
    args = parser.parse_args()
    documents = []
    for split in (SEEDS if args.split == "both" else [args.split]):
        images = args.images if args.image_split in (split, "both") else None
        documents.append(generate(split, args.output_dir / f"damage-stress-{split}.json", images))
    if len(documents) == 2:
        first, second = documents
        assert not ({case["groupId"] for case in first["cases"]} & {case["groupId"] for case in second["cases"]})
        assert not ({value["text"] for case in first["cases"] for value in case["expected"]}
                    & {value["text"] for case in second["cases"] for value in case["expected"]})


if __name__ == "__main__":
    main()
