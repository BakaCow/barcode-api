"""Bounded QR source-exposure restoration with native decoding and source fit.

This helper models uniform horizontal/vertical exposure integration and small,
front-facing square QR cells (versions 1–10). Unsupported geometry abstains.
Native ZXing supplies text, raw bytes and error correction; no payload is guessed.
"""
from dataclasses import dataclass, replace
from math import ceil, floor, hypot, sqrt
from time import monotonic

from PIL import Image
import zxingcpp

import qr_recovery

QR_FORMATS = (zxingcpp.BarcodeFormat.QRCode, zxingcpp.BarcodeFormat.QRCodeModel1, zxingcpp.BarcodeFormat.QRCodeModel2)

@dataclass(frozen=True, slots=True)
class Source:
    gray: bytes
    width: int
    height: int
    x: int
    y: int
    low: int
    high: int


@dataclass(frozen=True, slots=True)
class Observation:
    code: object
    points: tuple[tuple[float, float], ...]


@dataclass(frozen=True, slots=True)
class Result:
    observations: tuple[Observation, ...]
    complete: bool
    observed: int
    passes: int


def source(image):
    if image.width < 21 or image.height < 21 or image.width * image.height > 4_000_000:
        return None
    with image.convert('L') as gray:
        low, high = gray.getextrema()
        if high - low < 60:
            return None
        threshold = low + (high - low) * .72
        with gray.point(lambda value: 255 if value < threshold else 0) as mask:
            box = mask.getbbox()
        if not box:
            return None
        left, top, right, bottom = box
        width, height = right - left, bottom - top
        if width < 18 or height < 18 or not .55 <= width / height <= 1.8 or max(width, height) > 640:
            return None
        left, top = max(0, left - 24), max(0, top - 24)
        right, bottom = min(image.width, right + 24), min(image.height, bottom + 24)
        with gray.crop((left, top, right, bottom)) as cropped:
            return Source(cropped.tobytes(), cropped.width, cropped.height, left, top, low, high)


def restore(input_, length, vertical=False, clamped=False):
    if not input_ or length not in (3, 5, 7, 9, 11, 13, 15):
        return None
    width, height, gray, low, high = input_.width, input_.height, input_.gray, input_.low, input_.high
    half, span = length // 2, high - low
    lines, size = (width, height) if vertical else (height, width)
    if size < length * 2 + 14 or width * height > 500_000:
        return None
    def at(line, offset):
        return offset * width + line if vertical else line * width + offset
    # Both initial-condition margins must be present in the supplied photograph.
    for line in range(lines):
        for offset in range(half + 1):
            if gray[at(line, offset)] < high - span * .04 or gray[at(line, size - 1 - offset)] < high - span * .04:
                return None
    output = bytearray([255]) * (width * height)
    for line in range(lines):
        reconstructed = [float(high)] * (size + half)
        for offset in range(size):
            index = offset + half
            value = length * (gray[at(line, offset)] - (gray[at(line, offset - 1)] if offset else high)) + (reconstructed[index - length] if index >= length else high)
            reconstructed[index] = min(high, max(low, value)) if clamped else value
        for offset in range(size):
            output[at(line, offset)] = 0 if reconstructed[offset] < (low + high) / 2 else 255
    return Image.frombytes('L', (width, height), bytes(output))


def forward_fit(input_, restored, proposal, length, vertical=False):
    width, height, low, high = input_.width, input_.height, input_.low, input_.high
    half, span = length // 2, high - low
    corners = [proposal.point(x, y) for x, y in ((0, 0), (proposal.dimension, 0), (proposal.dimension, proposal.dimension), (0, proposal.dimension))]
    module = (hypot(proposal.top_right.x - proposal.top_left.x, proposal.top_right.y - proposal.top_left.y) +
              hypot(proposal.bottom_left.x - proposal.top_left.x, proposal.bottom_left.y - proposal.top_left.y)) / (2 * (proposal.dimension - 7))
    if module < 1.2 or any(x < -.5 or y < -.5 or x > width - .5 or y > height - .5 for x, y in corners):
        return None
    left, top = max(half, floor(min(x for x, _ in corners))), max(half, floor(min(y for _, y in corners)))
    right, bottom = min(width - half, ceil(max(x for x, _ in corners))), min(height - half, ceil(max(y for _, y in corners)))
    if right - left < 21 or bottom - top < 21:
        return None
    binary = restored.tobytes()
    squared, count = 0., 0
    tiles = [[0., 0] for _ in range(16)]
    for y in range(top, bottom):
        for x in range(left, right):
            total = sum(binary[(y + (k if vertical else 0)) * width + x + (0 if vertical else k)] / 255 for k in range(-half, half + 1))
            error = (low + span * total / length - input_.gray[y * width + x]) / span
            squared += error * error
            count += 1
            tile = tiles[min(3, (y - top) * 4 // (bottom - top)) * 4 + min(3, (x - left) * 4 // (right - left))]
            tile[0] += error * error
            tile[1] += 1
    rmse = sqrt(squared / count)
    worst = max(sqrt(total / amount) for total, amount in tiles if amount)
    return (rmse, worst) if rmse <= .055 and worst <= .105 else None


def enlarge(input_, scale=4):
    width, height = input_.width * scale, input_.height * scale
    output = bytearray(width * height)
    for y in range(height):
        sy = max(0, min(input_.height - 1, (y + .5) / scale - .5))
        iy, fy = floor(sy), sy - floor(sy)
        ny = min(input_.height - 1, iy + 1)
        for x in range(width):
            sx = max(0, min(input_.width - 1, (x + .5) / scale - .5))
            ix, fx = floor(sx), sx - floor(sx)
            nx = min(input_.width - 1, ix + 1)
            output[y * width + x] = round((1 - fy) * ((1 - fx) * input_.gray[iy * input_.width + ix] + fx * input_.gray[iy * input_.width + nx]) +
                                               fy * ((1 - fx) * input_.gray[ny * input_.width + ix] + fx * input_.gray[ny * input_.width + nx]))
    return Image.frombytes('L', (width, height), bytes(output))


def optical(input_, proposal, deadline):
    """Fit a nearly front-facing small grid to photographed pixel areas."""
    dimension, scale = proposal.dimension, 4
    q0, q1, q2 = proposal.point(0, 0), proposal.point(dimension, 0), proposal.point(0, dimension)
    module = (hypot(q1[0] - q0[0], q1[1] - q0[1]) + hypot(q2[0] - q0[0], q2[1] - q0[1])) / (2 * dimension)
    if dimension > 57 or not .7 <= module / scale <= 1.6 or abs(q1[1] - q0[1]) > module * .4 or abs(q2[0] - q0[0]) > module * .4:
        return None
    p = [(q0[0] + .5) / scale - .5, (q0[1] + .5) / scale - .5, (q1[0] - q0[0]) / scale / dimension, (q2[1] - q0[1]) / scale / dimension]
    if min(p[2:]) <= 0 or not .9 <= p[2] / p[3] <= 1.1:
        return None
    p[2] = p[3] = (p[2] + p[3]) / 2
    initial = p[:]
    width, height, gray, low, high = input_.width, input_.height, input_.gray, input_.low, input_.high
    span = high - low
    def functional(x, y):
        if x < 8 and y < 8:
            ox, oy = 0, 0
        elif x >= dimension - 8 and y < 8:
            ox, oy = dimension - 7, 0
        elif x < 8 and y >= dimension - 8:
            ox, oy = 0, dimension - 7
        elif (x == 6 and 8 <= y < dimension - 8) or (y == 6 and 8 <= x < dimension - 8):
            return int((x + y) % 2 == 0)
        else:
            return None
        a, b = x - ox, y - oy
        if min(a, b) < 0 or max(a, b) > 6:
            return 0
        return int(a in (0, 6) or b in (0, 6) or (2 <= a <= 4 and 2 <= b <= 4))
    def weights(pixel, origin, pitch):
        a, b = (pixel - .5 - origin) / pitch, (pixel + .5 - origin) / pitch
        return [(cell, (min(b, cell + 1) - max(a, cell)) * pitch) for cell in range(floor(a), ceil(b))
                if (min(b, cell + 1) - max(a, cell)) * pitch > 1e-6]
    def measurements(parameters, only_functional):
        output = []
        for y in range(max(0, floor(parameters[1])), min(height, ceil(parameters[1] + dimension * parameters[3]))):
            for x in range(max(0, floor(parameters[0])), min(width, ceil(parameters[0] + dimension * parameters[2]))):
                cells, known, predicted = [], True, 0.
                for cy, wy in weights(y, parameters[1], parameters[3]):
                    for cx, wx in weights(x, parameters[0], parameters[2]):
                        if not (0 <= cx < dimension and 0 <= cy < dimension):
                            known = False
                            continue
                        expected = functional(cx, cy)
                        if expected is None:
                            known = False
                        else:
                            predicted += wx * wy * expected
                        cells.append((cy * dimension + cx, wx * wy))
                if only_functional and not known:
                    continue
                output.append((cells, (high - gray[y * width + x]) / span, predicted, x, y))
        return output
    def score(parameters):
        items = measurements(parameters, True)
        return float('inf') if len(items) < 30 else sum((predicted - value) ** 2 for _, value, predicted, _, _ in items) / len(items)
    best = score(p)
    for amount in (.35, .17, .07, .03):
        for _ in range(2):
            for axis in range(3):
                if monotonic() >= deadline:
                    return None
                selected = p[axis]
                for sign in (-1, 1):
                    trial = p[:]
                    trial[axis] += sign * amount / (1 if axis < 2 else dimension)
                    if axis == 2:
                        trial[3] = trial[2]
                    if abs(trial[axis] - initial[axis]) > (.9 if axis < 2 else .9 / dimension):
                        continue
                    value = score(trial)
                    if value < best:
                        best, selected = value, trial[axis]
                p[axis] = selected
                if axis == 2:
                    p[3] = selected
    groups = [[], [], []]
    for _, value, predicted, x, y in measurements(p, True):
        cx, cy = (x - p[0]) / p[2], (y - p[1]) / p[3]
        group = 0 if cx < 8 and cy < 8 else 1 if cx >= dimension - 8 and cy < 8 else 2 if cx < 8 and cy >= dimension - 8 else -1
        if group >= 0:
            groups[group].append((predicted - value) ** 2)
    if sqrt(best) > .12 or any(len(group) < 10 or sqrt(sum(group) / len(group)) > .14 for group in groups):
        return None
    ox, oy, px, py = p
    if ox - 4 * px < 0 or oy - 4 * py < 0 or ox + (dimension + 4) * px >= width or oy + (dimension + 4) * py >= height:
        return None
    for cell in range(-3, dimension + 3):
        for x, y in ((cell, -2), (cell, dimension + 2), (-2, cell), (dimension + 2, cell)):
            if gray[round(oy + y * py) * width + round(ox + x * px)] < high - .08 * span:
                return None
    entries = measurements(p, False)
    modules, norm = [0.] * (dimension * dimension), [0.] * (dimension * dimension)
    for cells, value, *_ in entries:
        for index, weight in cells:
            modules[index] += weight * value
            norm[index] += weight
    modules = [value / normal if normal else .5 for value, normal in zip(modules, norm)]
    fixed = [functional(index % dimension, index // dimension) for index in range(len(modules))]
    for iteration in range(160):
        if monotonic() >= deadline:
            return None
        gradient, diagonal = [0.] * len(modules), [0.] * len(modules)
        for cells, value, *_ in entries:
            predicted = sum(weight * modules[index] for index, weight in cells)
            for index, weight in cells:
                gradient[index] += weight * (predicted - value)
                diagonal[index] += weight * weight
        for index in range(len(modules)):
            if fixed[index] is not None:
                modules[index] = fixed[index]
                continue
            prior = .02 if iteration > 60 else 0
            modules[index] = max(0, min(1, modules[index] - .3 * (gradient[index] + prior * (1 - 2 * modules[index])) / max(.1, diagonal[index])))
    candidates = []
    for threshold in (.4, .45, .5, .55, .6):
        binary = [int(value > threshold) for value in modules]
        squared, tiles = 0., [[0., 0] for _ in range(16)]
        for cells, value, _, x, y in entries:
            error = (sum(weight * binary[index] for index, weight in cells) - value) ** 2
            squared += error
            tx, ty = min(3, max(0, floor((x - ox) / (dimension * px) * 4))), min(3, max(0, floor((y - oy) / (dimension * py) * 4)))
            tiles[ty * 4 + tx][0] += error
            tiles[ty * 4 + tx][1] += 1
        if sqrt(squared / len(entries)) > .14 or max(sqrt(total / count) for total, count in tiles if count) > .23:
            continue
        side = (dimension + 8) * 4
        output = bytearray([255]) * (side * side)
        for y in range(dimension):
            for x in range(dimension):
                value = 0 if binary[y * dimension + x] else 255
                for dy in range(4):
                    for dx in range(4):
                        output[((y + 4) * 4 + dy) * side + (x + 4) * 4 + dx] = value
        candidates.append(Image.frombytes('L', (side, side), bytes(output)))
    return candidates, dimension, p


def recover(image, *, deadline):
    deadline = min(deadline, monotonic() + 1.2)
    if monotonic() >= deadline:
        return Result((), False, 0, 0)
    input_ = source(image)
    if not input_:
        return Result((), True, 0, 0)
    observations, identities, passes, complete = [], set(), 0, True
    def remember(code, mapped):
        if any(x < 0 or y < 0 or x > image.width or y > image.height for x, y in mapped):
            return
        key = (code.format.name, code.text, code.bytes)
        identities.add(key)
        if not any((entry.code.format.name, entry.code.text, entry.code.bytes) == key and
                   max(abs(a - b) for p, q in zip(entry.points, mapped) for a, b in zip(p, q)) < 4 for entry in observations):
            observations.append(Observation(code, mapped))
    if input_.width <= 128 and input_.height <= 128 and monotonic() < deadline:
        with enlarge(input_) as enlarged:
            search = qr_recovery.find_proposals(enlarged, min(deadline, monotonic() + .1))
        if search.complete and not search.proposals and monotonic() < deadline:
            # A second sampling phase can expose a subpixel finder missed at
            # 4x. All geometry maps back before fitting the untouched source.
            with enlarge(input_, 6) as enlarged:
                alternate = qr_recovery.find_proposals(enlarged, min(deadline, monotonic() + .1))
            def map_finder(finder):
                return replace(finder, x=(finder.x + .5) * 4 / 6 - .5,
                               y=(finder.y + .5) * 4 / 6 - .5, module=finder.module * 4 / 6)
            search = qr_recovery.Search(tuple(replace(proposal, top_left=map_finder(proposal.top_left),
                                                      top_right=map_finder(proposal.top_right),
                                                      bottom_left=map_finder(proposal.bottom_left))
                                             for proposal in alternate.proposals), alternate.complete)
        if not search.complete:
            complete = False
        for proposal in search.proposals:
            fitted = optical(input_, proposal, deadline)
            if fitted is None:
                continue
            candidates, dimension, parameters = fitted
            values = {}
            try:
                for candidate in candidates:
                    if monotonic() >= deadline:
                        complete = False
                        break
                    for code in zxingcpp.read_barcodes(candidate, formats=zxingcpp.BarcodeFormat.QRCode,
                                                     is_pure=True, binarizer=zxingcpp.Binarizer.FixedThreshold):
                        if not code.valid or code.error or code.format not in QR_FORMATS:
                            continue
                        points = tuple((point.x, point.y) for point in (code.position.top_left, code.position.top_right, code.position.bottom_right, code.position.bottom_left))
                        left, top = min(x for x, _ in points), min(y for _, y in points)
                        right, bottom = max(x for x, _ in points), max(y for _, y in points)
                        if max(abs(left - 16), abs(top - 16), abs(right - 16 - dimension * 4), abs(bottom - 16 - dimension * 4)) > 8:
                            continue
                        ox, oy, px, py = parameters
                        mapped = tuple((input_.x + ox + (x / 4 - 4) * px, input_.y + oy + (y / 4 - 4) * py) for x, y in points)
                        key = (code.format.name, code.text, code.bytes)
                        previous = values.get(key, (0, code, mapped))
                        values[key] = (previous[0] + 1, code, mapped)
                    passes += 1
                for count, code, mapped in values.values():
                    remember(code, mapped)
                    if count < 2 and len(values) == 1:
                        complete = False
            finally:
                for candidate in candidates:
                    candidate.close()
        if observations and any(not any(proposal.contains_symbol(tuple(((x - input_.x) * 4, (y - input_.y) * 4)
                                                                       for x, y in entry.points)) for entry in observations)
                                for proposal in search.proposals):
            complete = False
    for vertical in (False, True):
        for length in (3, 5, 7, 9, 11, 13, 15):
            for clamped in (False, True):
                if monotonic() >= deadline:
                    complete = False
                    break
                restored = restore(input_, length, vertical, clamped)
                if restored is None:
                    continue
                with restored:
                    codes = [code for code in zxingcpp.read_barcodes(restored, formats=zxingcpp.BarcodeFormat.QRCode,
                             try_rotate=True, try_downscale=False, try_invert=False) if code.valid and not code.error and code.format in QR_FORMATS]
                    passes += 1
                    if not codes:
                        continue
                    search = qr_recovery.find_proposals(restored, min(deadline, monotonic() + .06))
                    if not search.complete:
                        complete = False
                        break
                    proved = [proposal for proposal in search.proposals if forward_fit(input_, restored, proposal, length, vertical)]
                    accepted = []
                    for code in codes:
                        points = tuple((point.x, point.y) for point in (code.position.top_left, code.position.top_right, code.position.bottom_right, code.position.bottom_left))
                        if any(proposal.contains_symbol(points) for proposal in proved):
                            accepted.append((code, points))
                    if accepted and any(not any(proposal.contains_symbol(points) for _, points in accepted) for proposal in search.proposals):
                        complete = False
                    for code, points in accepted:
                        mapped = tuple((x + input_.x, y + input_.y) for x, y in points)
                        remember(code, mapped)
            if not complete and monotonic() >= deadline:
                break
        if not complete and monotonic() >= deadline:
            break
    if monotonic() >= deadline:
        complete = False
    return Result(tuple(observations) if complete or len(identities) > 1 else (), complete, len(observations), passes)
