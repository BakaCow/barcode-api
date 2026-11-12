"""Bounded recovery attempts for images the native decoder could not read.

The original image is always decoded first. Extra passes improve some difficult
images; they cannot reconstruct information absent from the photograph. The
deadline prevents starting more work, but cannot interrupt a native decode.
"""

from dataclasses import dataclass
import math
from time import monotonic
from typing import Callable

from PIL import Image, ImageChops, ImageFilter, ImageOps
import zxingcpp


MAX_RETRY_PIXELS = 4_000_000
RETRY_SECONDS = 2.5
PointMap = Callable[[float, float], tuple[float, float]]
# Transforms can make damaged bars resemble unchecked formats such as short ITF.
# Keep those formats on the untouched first pass; recovery requires a mandatory
# checksum or error correction. These checks reduce risk, not prove a true read.
RECOVERY_FORMATS = zxingcpp.BarcodeFormats([getattr(zxingcpp.BarcodeFormat, name) for name in
             ("QRCode", "MicroQRCode", "RMQRCode", "DataMatrix", "Aztec", "PDF417",
              "MicroPDF417", "MaxiCode", "Code128", "Code93", "EAN13", "EAN8", "UPCA",
              "UPCE", "DataBar", "DataBarExp", "DataBarLtd")])
RECOVERY_NAMES = {
    "QRCode", "QRCodeModel1", "QRCodeModel2", "MicroQRCode", "RMQRCode", "DataMatrix",
    "Aztec", "AztecCode", "AztecRune", "PDF417", "CompactPDF417", "MicroPDF417",
    "MaxiCode", "Code128", "Code93", "EAN13", "EAN8", "UPCA", "UPCE", "DataBar",
    "DataBarOmni", "DataBarStk", "DataBarStkOmni", "DataBarExp", "DataBarExpStk", "DataBarLtd",
}
LINEAR_RECOVERY_NAMES = {"Code128", "Code93", "EAN13", "EAN8", "UPCA", "UPCE",
                         "DataBar", "DataBarOmni", "DataBarStk", "DataBarStkOmni",
                         "DataBarExp", "DataBarExpStk", "DataBarLtd"}


@dataclass(frozen=True, slots=True)
class DecodedBarcode:
    text: str
    format: object
    bytes: bytes
    points: tuple[tuple[int, int], ...]


def _source_bars_agree(record: DecodedBarcode, source: Image.Image, original_size):
    """Validate recovered linear geometry against at most 4096 source gradients.

    A transformed crop can accidentally look like a checksum-valid short code.
    Its reported reading direction must agree with coherent bars in the input.
    This is a conservative filter, not proof that every accepted value is true.
    """
    if record.format.name not in LINEAR_RECOVERY_NAMES:
        return True
    if source.width < 3 or source.height < 3:
        return False
    sx, sy = source.width / original_size[0], source.height / original_size[1]
    points = [((x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) for x, y in record.points]
    left = max(1, math.floor(min(x for x, _ in points)))
    right = min(source.width - 2, math.ceil(max(x for x, _ in points)))
    top = max(1, math.floor(min(y for _, y in points)))
    bottom = min(source.height - 2, math.ceil(max(y for _, y in points)))
    if right < left or bottom < top:
        return False
    dx = points[1][0] - points[0][0] + points[2][0] - points[3][0]
    dy = points[1][1] - points[0][1] + points[2][1] - points[3][1]
    length_squared = dx * dx + dy * dy
    if length_squared < 1:
        return False
    width, height = right - left + 1, bottom - top + 1
    stride = max(1, math.ceil(math.sqrt(width * height / 4096)))
    while math.ceil(width / stride) * math.ceil(height / stride) > 4096:
        stride += 1
    pixels = source.load()
    xx = yy = xy = 0
    for y in range(top, bottom + 1, stride):
        for x in range(left, right + 1, stride):
            gx = pixels[x + 1, y] - pixels[x - 1, y]
            gy = pixels[x, y + 1] - pixels[x, y - 1]
            xx += gx * gx
            yy += gy * gy
            xy += gx * gy
    energy = xx + yy
    anisotropy = math.hypot(xx - yy, 2 * xy)
    if energy <= 0 or anisotropy / energy < 0.5:
        return False
    alignment = ((dx * dx - dy * dy) * (xx - yy) + 4 * dx * dy * xy) / (length_squared * anisotropy)
    return alignment >= math.cos(math.radians(50))


def _records(codes, size: tuple[int, int], mapping: PointMap | None = None, *, recovery=False):
    width, height = size
    records = []
    for code in codes:
        if not code.valid or code.error:
            continue
        if recovery and code.format.name not in RECOVERY_NAMES:
            continue
        position = code.position
        points = []
        for point in (position.top_left, position.top_right,
                      position.bottom_right, position.bottom_left):
            if mapping is None:
                points.append((point.x, point.y))
            else:
                x, y = mapping(point.x, point.y)
                points.append((max(0, min(width, round(x))),
                               max(0, min(height, round(y)))))
        records.append(DecodedBarcode(code.text, code.format, code.bytes, tuple(points)))
    return records


def _working_image(image: Image.Image):
    """Bound retry allocations while retaining a map to original coordinates."""
    factor = min(1.0, math.sqrt(MAX_RETRY_PIXELS / (image.width * image.height)))
    width = max(1, min(MAX_RETRY_PIXELS, math.floor(image.width * factor)))
    height = max(1, min(MAX_RETRY_PIXELS // width, math.floor(image.height * factor)))
    size = (width, height)
    # Resize before conversion so a large RGB input does not add a full-size
    # grayscale allocation merely for the bounded fallback.
    resized = image.resize(size, Image.Resampling.LANCZOS) if size != image.size else image
    try:
        working = resized.convert("L")
    finally:
        if resized is not image:
            resized.close()
    sx, sy = image.width / working.width, image.height / working.height

    def to_original(x, y):
        return (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5

    return working, to_original


def _rotated(image: Image.Image):
    """Rotate 45 degrees with one shared sampling/coordinate affine transform."""
    c = s = math.sqrt(0.5)
    natural_width = math.ceil(image.width * c + image.height * s)
    natural_height = math.ceil(image.width * s + image.height * c)
    scale = min(1.0, math.sqrt(MAX_RETRY_PIXELS / (natural_width * natural_height)))
    width, height = max(1, math.floor(natural_width * scale)), max(1, math.floor(natural_height * scale))
    a, b, d, e = c / scale, -s / scale, s / scale, c / scale
    tx = image.width / 2 - a * width / 2 - b * height / 2
    ty = image.height / 2 - d * width / 2 - e * height / 2
    candidate = image.transform((width, height), Image.Transform.AFFINE,
                                (a, b, tx, d, e, ty),
                                resample=Image.Resampling.BICUBIC, fillcolor=255)

    def to_working(x, y):
        # Pillow samples at pixel centers. ZXing returns integer pixel indices.
        return (a * (x + 0.5) + b * (y + 0.5) + tx - 0.5,
                d * (x + 0.5) + e * (y + 0.5) + ty - 0.5)

    return candidate, to_working


def read_barcodes(image: Image.Image) -> list[DecodedBarcode]:
    """Keep native successes unchanged, then try at most six recovery passes."""
    started = monotonic()
    records = _records(zxingcpp.read_barcodes(image), image.size)
    if records or monotonic() - started >= RETRY_SECONDS:
        return records
    working, to_original = _working_image(image)
    with working:
        with ImageOps.autocontrast(working, cutoff=0.5) as contrast:
            for attempt in range(6):
                if monotonic() - started >= RETRY_SECONDS:
                    break
                mapping = to_original
                options = {"formats": RECOVERY_FORMATS}
                if attempt == 0:
                    candidate = contrast.copy()
                    options["binarizer"] = zxingcpp.Binarizer.GlobalHistogram
                elif attempt == 1:
                    candidate = contrast.filter(ImageFilter.UnsharpMask(radius=1, percent=120, threshold=2))
                elif attempt == 2:
                    candidate, to_working = _rotated(contrast)

                    def mapping(x, y):
                        return to_original(*to_working(x, y))

                elif attempt == 3:
                    # Native inversion is format-dependent; an explicitly
                    # inverted image also gives linear labels a normal pass.
                    candidate = ImageOps.invert(contrast)
                elif attempt == 4:
                    # Remove slowly varying illumination while preserving local
                    # bar/module contrast. This does not guess missing data.
                    with working.filter(ImageFilter.BoxBlur(15)) as background:
                        with ImageChops.subtract(working, background, offset=128) as local:
                            candidate = ImageOps.autocontrast(local, cutoff=0.5)
                else:
                    factor = min(2.0, math.sqrt(MAX_RETRY_PIXELS / (contrast.width * contrast.height)))
                    width = max(1, math.floor(contrast.width * factor))
                    height = max(1, min(MAX_RETRY_PIXELS // width, math.floor(contrast.height * factor)))
                    if width <= contrast.width and height <= contrast.height:
                        continue
                    # Resampling can give the decoder a usable sampling grid for
                    # small modules; it adds no optical information.
                    candidate = contrast.resize((width, height), Image.Resampling.BICUBIC)
                    sx, sy = contrast.width / width, contrast.height / height

                    def mapping(x, y):
                        return to_original((x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5)
                with candidate:
                    if monotonic() - started >= RETRY_SECONDS:
                        break
                    records = _records(zxingcpp.read_barcodes(candidate, **options),
                                       image.size, mapping, recovery=True)
                    records = [record for record in records if _source_bars_agree(record, working, image.size)]
                if records:
                    return records
    return []
