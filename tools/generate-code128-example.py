"""Small reproducible synthetic example; never presented as real phone data."""
import argparse
from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFilter
import zxingcpp

from dataset import save, export_pixels


ROOT = Path(__file__).resolve().parents[1]


def generate(destination):
    destination = Path(destination)
    (destination / "media").mkdir(parents=True, exist_ok=True)
    entries = []

    def add(identifier, image, text, group, condition):
        image.save(destination / "media" / f"{identifier}.png", format="PNG")
        entries.append({"id": identifier, "path": f"media/{identifier}.png", "mediaType": "image",
                        "expected": [{"text": text, "format": "Code128"}] if text else [],
                        "negative": not bool(text), "groupId": group, "split": "dev",
                        "conditions": [condition], "device": "Generated with ZXing-C++ and Pillow; no camera",
                        "source": "synthetic"})

    alpha = Image.fromarray(zxingcpp.create_barcode("LAB-BOX-128", zxingcpp.BarcodeFormat.Code128).to_image(scale=3, add_quiet_zones=True)).convert("L")
    numeric = Image.fromarray(zxingcpp.create_barcode("00123456789012", zxingcpp.BarcodeFormat.Code128).to_image(scale=3, add_quiet_zones=True)).convert("L")
    with alpha, numeric:
        add("alpha-clean", alpha, "LAB-BOX-128", "synthetic-alpha", "clean")
        with alpha.rotate(29, Image.Resampling.BICUBIC, expand=True, fillcolor=255) as image:
            add("alpha-angled", image, "LAB-BOX-128", "synthetic-alpha", "angled")
        with alpha.point(lambda value: 110 + round(value * 30 / 255)) as image:
            add("alpha-lowcontrast", image, "LAB-BOX-128", "synthetic-alpha", "lowcontrast")
        with alpha.filter(ImageFilter.GaussianBlur(1.2)) as image:
            add("alpha-blurred", image, "LAB-BOX-128", "synthetic-alpha", "blur")
        add("numeric-clean", numeric, "00123456789012", "synthetic-numeric", "clean")
        with numeric.rotate(73, Image.Resampling.BICUBIC, expand=True, fillcolor=255) as image:
            add("numeric-angled", image, "00123456789012", "synthetic-numeric", "angled")
    with Image.new("L", (480, 160), 255) as image:
        add("negative-blank", image, None, "synthetic-blank", "negative")
    rng = random.Random(1282026)
    with Image.new("L", (480, 160), 245) as image:
        draw = ImageDraw.Draw(image)
        for x in range(20, 460, 7):
            draw.rectangle((x, 25, x + rng.randint(1, 5), 135), fill=20)
        add("negative-stripes", image, None, "synthetic-stripes", "negative")
    save(destination, {"version": 1, "description": "Generated smoke-test examples, not real-world validation or a held-out benchmark.", "entries": entries})
    export_pixels(destination, "dev", destination / "dev-pixels.json")
    return len(entries)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(ROOT / "data/synthetic"))
    args = parser.parse_args()
    print(f"Generated {generate(args.output)} explicitly synthetic examples in {args.output}.")
