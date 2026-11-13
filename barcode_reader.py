"""Bounded recovery attempts for images the native decoder could not read.

The original image is always decoded first. Extra passes improve some difficult
images; they cannot reconstruct information absent from the photograph. The
deadline prevents starting more work, but cannot interrupt a native decode.
"""

from collections.abc import Sequence
from dataclasses import dataclass
import math
from time import monotonic
from typing import Callable

from PIL import Image, ImageChops, ImageFilter, ImageOps
import zxingcpp
from independent_zbar import observations as zbar_observations


MAX_RETRY_PIXELS = 4_000_000
RETRY_SECONDS = 2.5
PointMap = Callable[[float, float], tuple[float, float]]
POS_FORMATS = {name: getattr(zxingcpp.BarcodeFormat, native) for name, native in {
    "qr": "QRCode", "code128": "Code128", "ean13": "EAN13", "ean8": "EAN8",
    "upca": "UPCA", "upce": "UPCE", "datamatrix": "DataMatrix", "aztec": "Aztec",
    "pdf417": "PDF417", "code93": "Code93",
}.items()}
_CANONICAL_FORMAT_NAMES = {native.name: name for name, native in POS_FORMATS.items()}
_CANONICAL_FORMAT_NAMES.update({
    "QRCodeModel1": "qr", "QRCodeModel2": "qr", "AztecCode": "aztec",
    "AztecRune": "aztec", "CompactPDF417": "pdf417",
})
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


def canonical_format_name(format_) -> str | None:
    """Name a supported POS family without rewriting its payload or identifier.

    UPC-A can be reported as EAN13 when EAN13 is enabled. UPC-E payloads can
    already be expanded by ZXing. Keep the reported family and native bytes;
    catalog identifier normalization belongs in a separate explicit policy.
    """
    return _CANONICAL_FORMAT_NAMES.get(getattr(format_, "name", None))


def _requested_formats(allowed_formats: Sequence[str] | None):
    if allowed_formats is None:
        return None
    if (isinstance(allowed_formats, (str, bytes, bytearray)) or
            not isinstance(allowed_formats, Sequence) or not allowed_formats or
            any(not isinstance(name, str) or name not in POS_FORMATS for name in allowed_formats)):
        raise ValueError("allowed_formats must be a nonempty sequence of supported POS format names.")
    return tuple(dict.fromkeys(allowed_formats))


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


def _records(codes, size: tuple[int, int], mapping: PointMap | None = None, *, recovery=False,
             allowed_names: Sequence[str] | None = None):
    width, height = size
    records = []
    for code in codes:
        if not code.valid or code.error:
            continue
        if recovery and code.format.name not in RECOVERY_NAMES:
            continue
        if allowed_names is not None and canonical_format_name(code.format) not in allowed_names:
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


def _rotated(image: Image.Image, angle: float = 45):
    """Rotate with one shared sampling/coordinate affine transform."""
    c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
    natural_width = math.ceil(abs(image.width * c) + abs(image.height * s))
    natural_height = math.ceil(abs(image.width * s) + abs(image.height * c))
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


def _bar_direction(image: Image.Image) -> float | None:
    """Estimate a coherent bar gradient from at most 16384 source samples."""
    width, height = image.size
    if width < 3 or height < 3:
        return None
    stride = max(1, math.ceil(math.sqrt(width * height / 16384)))
    while math.ceil((width - 2) / stride) * math.ceil((height - 2) / stride) > 16384:
        stride += 1
    pixels = image.load()
    xx = xy = yy = 0
    for y in range(1, height - 1, stride):
        for x in range(1, width - 1, stride):
            # Avoid a regular grid repeatedly measuring the centres of bars.
            jitter = ((x * 73856093) ^ (y * 19349663)) & 0xffffffff
            sx = min(width - 2, x + jitter % stride)
            sy = min(height - 2, y + (jitter // stride) % stride)
            dx, dy = pixels[sx + 1, sy] - pixels[sx - 1, sy], pixels[sx, sy + 1] - pixels[sx, sy - 1]
            xx += dx * dx
            xy += dx * dy
            yy += dy * dy
    energy = xx + yy
    if not energy or math.hypot(xx - yy, 2 * xy) / energy < 0.5:
        return None
    angle = math.degrees(math.atan2(2 * xy, xx - yy)) / 2
    return angle if 3 < abs(angle) < 87 else None


def _angle_near(record: DecodedBarcode, source: Image.Image, original_size) -> float | None:
    """Find coherent local bars, without treating an axis scanline as their angle."""
    if min(source.size) < 3:
        return None
    sx, sy = source.width / original_size[0], source.height / original_size[1]
    points = [((x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) for x, y in record.points]
    vx = (points[1][0] - points[0][0] + points[2][0] - points[3][0]) / 2
    vy = (points[1][1] - points[0][1] + points[2][1] - points[3][1]) / 2
    padding = min(32, max(2, math.ceil(math.hypot(vx, vy) * 0.06)))
    left = max(1, math.floor(min(x for x, _ in points)) - padding)
    right = min(source.width - 2, math.ceil(max(x for x, _ in points)) + padding)
    top = max(1, math.floor(min(y for _, y in points)) - padding)
    bottom = min(source.height - 2, math.ceil(max(y for _, y in points)) + padding)
    if right < left or bottom < top:
        return None
    stride = max(1, math.ceil(math.sqrt((right - left + 1) * (bottom - top + 1) / 4096)))
    pixels = source.load()
    xx = xy = yy = samples = 0
    for y in range(top, bottom + 1, stride):
        if samples >= 4096:
            break
        for x in range(left, right + 1, stride):
            if samples >= 4096:
                break
            jitter = ((x * 73856093) ^ (y * 19349663)) & 0xffffffff
            px = min(right, x + jitter % stride)
            py = min(bottom, y + (jitter // stride) % stride)
            dx, dy = pixels[px + 1, py] - pixels[px - 1, py], pixels[px, py + 1] - pixels[px, py - 1]
            xx += dx * dx; xy += dx * dy; yy += dy * dy; samples += 1
    energy = xx + yy
    if not energy or math.hypot(xx - yy, 2 * xy) / energy < 0.7:
        return None
    angle = math.degrees(math.atan2(2 * xy, xx - yy)) / 2
    return angle if 3 < abs(angle) < 87 else None


def _inside_quad(point, corners) -> bool:
    """Strict interior test: uncertain or degenerate footprints do not suppress."""
    cross = [(b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
             for a, b in zip(corners, corners[1:] + corners[:1])]
    return all(value > 0 for value in cross) or all(value < 0 for value in cross)


def _same_symbol_segment(record: DecodedBarcode, footprint: DecodedBarcode) -> bool:
    left = tuple((record.points[0][i] + record.points[3][i]) / 2 for i in (0, 1))
    right = tuple((record.points[1][i] + record.points[2][i]) / 2 for i in (0, 1))
    if math.dist(left, right) < 1:
        return False
    return all(_inside_quad(tuple(left[i] + fraction * (right[i] - left[i]) for i in (0, 1)), footprint.points)
               for fraction in (0.25, 0.5, 0.75))


def _corroborate_retail_overlap(records, image, first_options, requested, started):
    """Resolve a narrow UPC-E/EAN alias only with a second source-aligned read.

    The decoder can read an oblique interior segment of EAN bars as UPC-E.
    Axis-aligned native scanline boxes are not reliable orientation evidence.
    Keep all candidates unless a bounded deskew re-observes the exact EAN and
    places the UPC-E's central scan segment inside its oriented footprint, while
    failing to reproduce that UPC-E identity. Separate labels remain separate.
    """
    upce = [record for record in records if record.format.name == 'UPCE']
    ean = [record for record in records if record.format.name in {'EAN13', 'UPCA'}]
    if not upce or not ean or monotonic() - started >= RETRY_SECONDS:
        return records
    identity = lambda record: (record.format.name, record.text, record.bytes)
    ean_keys = {identity(record) for record in ean}
    working, to_original = _working_image(image)
    with working:
        # One view only, irrespective of the number of original detections.
        angle = _angle_near(upce[0], working, image.size)
        if angle is None or monotonic() - started >= RETRY_SECONDS:
            return records
        transformed, to_working = _rotated(working, angle)
        with transformed:
            if monotonic() - started >= RETRY_SECONDS:
                return records
            try:
                check = _records(zxingcpp.read_barcodes(transformed, **first_options), image.size,
                                 lambda x, y: to_original(*to_working(x, y)), allowed_names=requested)
            except (ValueError, RuntimeError):
                return records
    checked = {identity(record) for record in check}
    footprints = [record for record in check if identity(record) in ean_keys]
    return [record for record in records if record.format.name != 'UPCE' or identity(record) in checked or
            not any(_same_symbol_segment(record, footprint) for footprint in footprints)]


def _independent_observations(working, mapping, original_size, requested, started):
    if monotonic() - started >= RETRY_SECONDS:
        return []
    families = {'code128', 'ean13'} if requested is None else set(requested) & {'code128', 'ean13'}
    if not families:
        return []
    try:
        candidates = zbar_observations(working, families)
    except Exception:
        return []  # A failed optional observation cannot invalidate native evidence.
    if len(candidates) > 32 or monotonic() - started >= RETRY_SECONDS:
        return []
    records = []
    for candidate in candidates:
        points = tuple((max(0, min(original_size[0], round(x))), max(0, min(original_size[1], round(y))))
                       for x, y in (mapping(x, y) for x, y in candidate.points))
        # Code128 text is intentionally not interpreted here. Only native
        # corroboration can publish its bytes and established presentation.
        record = DecodedBarcode(candidate.data.decode('ascii') if candidate.family == 'ean13' else '',
                                POS_FORMATS[candidate.family], candidate.data, points)
        if _source_bars_agree(record, working, original_size):
            records.append(record)
    return records


def _same_code128_footprint(first, second):
    """A mutual association for full Code128s, separate from retail aliases."""
    def vector(record):
        return tuple((record.points[1][axis] - record.points[0][axis] +
                      record.points[2][axis] - record.points[3][axis]) / 2 for axis in (0, 1))
    a, b = vector(first), vector(second)
    la, lb = math.hypot(*a), math.hypot(*b)
    if min(la, lb) < 1 or min(la, lb) / max(la, lb) < 0.75:
        return False
    if abs(a[0] * b[0] + a[1] * b[1]) / (la * lb) < math.cos(math.radians(20)):
        return False
    return _same_symbol_segment(first, second) and _same_symbol_segment(second, first)


def _independent_agreement(records, observed, working, mapping, original_size, started, proof_cache=None):
    """Use positive agreement, never absence or a Unicode/GS1 payload blacklist.

    ZBar's Code128 FNC4 behavior can lose the high bit. It is not a tie-breaker
    by itself: independently sampled ZXing must reproduce its exact bytes in
    the same source footprint. Unproved disagreements preserve original reads.
    """
    code128 = [record for record in records if record.format.name == 'Code128']
    observations = [record for record in observed if record.format.name == 'Code128']
    if records:
        observations = [candidate for candidate in observations if any(
            candidate.bytes != record.bytes and _same_code128_footprint(record, candidate)
            for record in code128)]
    if proof_cache is None:
        proof_cache = {}
    checked = proof_cache.get('records', [])
    factor = min(2.0, math.sqrt(MAX_RETRY_PIXELS / (working.width * working.height)))
    if observations and 'records' not in proof_cache and factor > 1.05 and monotonic() - started < RETRY_SECONDS:
        width, height = math.floor(working.width * factor), math.floor(working.height * factor)
        with working.resize((width, height), Image.Resampling.BILINEAR) as enlarged:
            if monotonic() - started < RETRY_SECONDS:
                def to_source(x, y):
                    return mapping((x + 0.5) * working.width / width - 0.5,
                                   (y + 0.5) * working.height / height - 0.5)
                try:
                    checked = _records(zxingcpp.read_barcodes(enlarged, formats=zxingcpp.BarcodeFormat.Code128),
                                       original_size, to_source, recovery=True, allowed_names=['code128'])
                    checked = [record for record in checked if _source_bars_agree(record, working, original_size)]
                except Exception:
                    checked = []
                proof_cache['records'] = checked
    supported = [proof for proof in checked if any(
        proof.bytes == candidate.bytes and _same_code128_footprint(proof, candidate)
        for candidate in observations)]
    if records:
        result = []
        for original in records:
            if any(candidate.format.name == 'Code128' and candidate.bytes == original.bytes and
                   _same_code128_footprint(original, candidate) for candidate in observed):
                result.append(original)
                continue
            options = [proof for proof in supported if original.format.name == 'Code128' and
                       _same_code128_footprint(original, proof) and
                       sum(_same_code128_footprint(record, proof) for record in code128) == 1 and any(
                           candidate.bytes == proof.bytes and _same_code128_footprint(original, candidate) and
                           sum(_same_code128_footprint(record, candidate) for record in code128) == 1
                           for candidate in observations)]
            identities = {proof.bytes for proof in options}
            result.append(options[0] if len(identities) == 1 else original)
        return result
    # Do not publish a partial unique result while another observed Code128
    # candidate remains unverified. Its FNC4 semantics may not be trustworthy.
    if any(not any(proof.bytes == candidate.bytes and _same_code128_footprint(proof, candidate)
                   for proof in supported) for candidate in observations):
        return []
    return [record for record in observed if record.format.name == 'EAN13'] + supported


def read_barcodes(image: Image.Image, *, allowed_formats: Sequence[str] | None = None) -> list[DecodedBarcode]:
    """Read the requested families on every pass, or retain legacy behavior for None."""
    requested = _requested_formats(allowed_formats)
    started = monotonic()
    first_options = {} if requested is None else {
        "formats": zxingcpp.BarcodeFormats([POS_FORMATS[name] for name in requested])}
    records = _records(zxingcpp.read_barcodes(image, **first_options), image.size, allowed_names=requested)
    if records:
        records = _corroborate_retail_overlap(records, image, first_options, requested, started)
        if not any(record.format.name == 'Code128' for record in records) or monotonic() - started >= RETRY_SECONDS:
            return records
        working, to_original = _working_image(image)
        with working:
            observed = _independent_observations(working, to_original, image.size, requested, started)
            return _independent_agreement(records, observed, working, to_original, image.size, started)
    if monotonic() - started >= RETRY_SECONDS:
        return []
    recovery_formats = RECOVERY_FORMATS
    if requested is not None:
        recovery_values = [POS_FORMATS[name] for name in requested if POS_FORMATS[name].name in RECOVERY_NAMES]
        # An empty native format mask can mean all formats: never pass one as
        # the intersection when none of the requested families support recovery.
        if not recovery_values:
            return []
        recovery_formats = zxingcpp.BarcodeFormats(recovery_values)
    working, to_original = _working_image(image)
    with working:
        observed = _independent_observations(working, to_original, image.size, requested, started)
        proof_cache = {}
        independent = _independent_agreement([], observed, working, to_original, image.size, started, proof_cache)
        if independent:
            return independent
        with ImageOps.autocontrast(working, cutoff=0.5) as contrast:
            for attempt in range(9):
                if monotonic() - started >= RETRY_SECONDS:
                    break
                mapping = to_original
                options = {"formats": recovery_formats}
                if attempt == 0:
                    candidate = contrast.copy()
                    options["binarizer"] = zxingcpp.Binarizer.GlobalHistogram
                elif attempt == 1:
                    candidate = contrast.filter(ImageFilter.UnsharpMask(radius=2, percent=200, threshold=2))
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
                elif attempt == 5:
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
                elif attempt == 6:
                    # A fixed midtone threshold gives blurred but still
                    # separable bars another sampling path after local and
                    # histogram binarizers have failed.
                    candidate = contrast.point(lambda value: 255 if value > 128 else 0)
                elif attempt == 7:
                    angle = _bar_direction(contrast)
                    if angle is None:
                        continue
                    candidate, to_working = _rotated(contrast, angle)

                    def mapping(x, y):
                        return to_original(*to_working(x, y))
                else:
                    # Remove isolated speckles and thin scratches while
                    # retaining decoder checksum/error-correction validation.
                    candidate = contrast.filter(ImageFilter.MedianFilter(3))
                with candidate:
                    if monotonic() - started >= RETRY_SECONDS:
                        break
                    records = _records(zxingcpp.read_barcodes(candidate, **options),
                                       image.size, mapping, recovery=True, allowed_names=requested)
                    records = [record for record in records if _source_bars_agree(record, working, image.size)]
                if records:
                    return _independent_agreement(records, observed, working, to_original, image.size, started, proof_cache)
    return []
