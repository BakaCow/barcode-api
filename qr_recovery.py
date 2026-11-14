"""Bounded QR finder proposals and source sampling, never payload inference.

Every sampled module comes from the supplied image. Finder patterns locate the
grid; data modules, missing corners and borders are never filled from a template.
The caller still requires the native QR decoder's error correction to succeed.
"""
from dataclasses import dataclass
from itertools import combinations
import math
from time import monotonic

from PIL import Image

MAX_PIXELS = 4_000_000
MAX_SIDE = 960


@dataclass(frozen=True, slots=True)
class Finder:
    x: float
    y: float
    module: float
    count: int
    inverted: bool


@dataclass(frozen=True, slots=True)
class Proposal:
    top_left: Finder
    top_right: Finder
    bottom_left: Finder
    dimension: int
    score: float

    def point(self, column, row):
        span = self.dimension - 7
        u, v = (column - 3.5) / span, (row - 3.5) / span
        return (self.top_left.x + u * (self.top_right.x - self.top_left.x) + v * (self.bottom_left.x - self.top_left.x),
                self.top_left.y + u * (self.top_right.y - self.top_left.y) + v * (self.bottom_left.y - self.top_left.y))

    def contains_symbol(self, points):
        """Associate a decoded footprint with this proposal, not a nearby label."""
        ax, ay = self.top_right.x - self.top_left.x, self.top_right.y - self.top_left.y
        bx, by = self.bottom_left.x - self.top_left.x, self.bottom_left.y - self.top_left.y
        determinant = ax * by - ay * bx
        if abs(determinant) < 1:
            return False
        coordinates = []
        for x, y in points:
            dx, dy = x - self.top_left.x, y - self.top_left.y
            coordinates.append((3.5 + (dx * by - dy * bx) / determinant * (self.dimension - 7),
                                3.5 + (ax * dy - ay * dx) / determinant * (self.dimension - 7)))
        for axis in (0, 1):
            low, high = min(point[axis] for point in coordinates), max(point[axis] for point in coordinates)
            if low < -3 or high > self.dimension + 3 or high - low < self.dimension * 0.6:
                return False
        return True


@dataclass(frozen=True, slots=True)
class Search:
    proposals: tuple[Proposal, ...]
    complete: bool


def _ratio(counts):
    module = sum(counts) / 7
    if module < 0.7:
        return None
    if any(abs(value - expected * module) > module * (1.35 if expected == 3 else 0.8)
           for value, expected in zip(counts, (1, 1, 3, 1, 1))):
        return None
    return module


def _cross(values, center):
    center = round(center)
    if not 0 <= center < len(values) or not values[center]:
        return None
    left, right = center, center + 1
    while left > 0 and values[left - 1]: left -= 1
    while right < len(values) and values[right]: right += 1
    middle = right - left
    end_left, end_right = left, right
    while left > 0 and not values[left - 1]: left -= 1
    while right < len(values) and not values[right]: right += 1
    white_left, white_right = end_left - left, right - end_right
    end_left, end_right = left, right
    while left > 0 and values[left - 1]: left -= 1
    while right < len(values) and values[right]: right += 1
    counts = (end_left - left, white_left, middle, white_right, right - end_right)
    module = _ratio(counts)
    if module is None or left == 0 or right == len(values):
        return None
    return left + counts[0] + counts[1] + counts[2] / 2, module


def _finder_patterns_agree(image, proposal, threshold):
    """Check the photographed finder cells; never write a template into data."""
    pixels = image.load()
    for ox, oy in ((0, 0), (proposal.dimension - 7, 0), (0, proposal.dimension - 7)):
        hits = total = 0
        for row in range(7):
            for column in range(7):
                x, y = proposal.point(ox + column + 0.5, oy + row + 0.5)
                if not (0 <= x < image.width and 0 <= y < image.height):
                    return False
                actual = pixels[min(image.width - 1, round(x)), min(image.height - 1, round(y))] <= threshold
                expected = column in (0, 6) or row in (0, 6) or (2 <= column <= 4 and 2 <= row <= 4)
                hits += (actual != proposal.top_left.inverted) == expected
                total += 1
        if hits / total < 0.78:
            return False
    return True


def find_proposals(image, deadline, limit=3):
    if image.mode != 'L' or min(image.size) < 1 or image.width * image.height > MAX_PIXELS:
        raise ValueError('QR recovery requires bounded grayscale input.')
    scale = min(1, MAX_SIDE / max(image.size))
    width, height = max(1, round(image.width * scale)), max(1, round(image.height * scale))
    with image.resize((width, height), Image.Resampling.BILINEAR) as thumbnail:
        low, high = thumbnail.getextrema()
        threshold, raw = (low + high) / 2, thumbnail.tobytes()
    if high - low < 12:
        return Search((), True)
    complete = True
    finders = []
    for inverted in (False, True):
        binary = bytes((value > threshold) if inverted else (value <= threshold) for value in raw)
        clusters = []
        for y in range(1, height - 1, max(1, height // 360)):
            if monotonic() >= deadline:
                return Search((), False)
            row = binary[y * width:(y + 1) * width]
            runs, start = [], 0
            for x in range(1, width + 1):
                if x == width or row[x] != row[start]:
                    runs.append((row[start], x - start, start)); start = x
            for index in range(len(runs) - 4):
                part = runs[index:index + 5]
                if not part[0][0]: continue
                module = _ratio([run[1] for run in part])
                if module is None: continue
                center_x = part[2][2] + part[2][1] / 2
                column = binary[min(width - 1, round(center_x))::width]
                vertical = _cross(column, y)
                if vertical is None or not 0.5 <= vertical[1] / module <= 2:
                    continue
                center_y = vertical[0]
                horizontal = _cross(binary[min(height - 1, round(center_y)) * width:
                                            (min(height - 1, round(center_y)) + 1) * width], center_x)
                if horizontal is None:
                    continue
                center_x, module = horizontal[0], (horizontal[1] + vertical[1]) / 2
                cluster = next((cluster for cluster in clusters if
                    math.hypot(cluster[0] - center_x, cluster[1] - center_y) <= max(module, cluster[2]) * 1.5 and
                    0.5 <= module / cluster[2] <= 2), None)
                if cluster is None:
                    if len(clusters) < 48:
                        clusters.append([center_x, center_y, module, 1])
                    else:
                        complete = False
                else:
                    n = cluster[3]
                    cluster[:3] = [(cluster[0] * n + center_x) / (n + 1),
                                   (cluster[1] * n + center_y) / (n + 1), (cluster[2] * n + module) / (n + 1)]
                    cluster[3] += 1
        finders.extend(Finder(x / scale - 0.5, y / scale - 0.5, module / scale, count, inverted)
                       for x, y, module, count in clusters if count >= 2)
    proposals = []
    complete = complete and len(finders) <= 24
    finders = sorted(finders, key=lambda finder: -finder.count)[:24]
    for triple in combinations(finders, 3):
        if monotonic() >= deadline:
            return Search((), False)
        if len({finder.inverted for finder in triple}) != 1:
            continue
        for corner in range(3):
            tl, tr, bl = triple[corner], triple[(corner + 1) % 3], triple[(corner + 2) % 3]
            ax, ay, bx, by = tr.x - tl.x, tr.y - tl.y, bl.x - tl.x, bl.y - tl.y
            a, b = math.hypot(ax, ay), math.hypot(bx, by)
            if min(a, b) < 12 or not 0.65 < a / b < 1.55:
                continue
            skew = abs(ax * bx + ay * by) / (a * b)
            if skew > 0.25:
                continue
            dimension_x = a / ((tl.module + tr.module) / 2) + 7
            dimension_y = b / ((tl.module + bl.module) / 2) + 7
            estimate = (dimension_x + dimension_y) / 2
            dimension = 21 + 4 * round((estimate - 21) / 4)
            if not 21 <= dimension <= 177 or abs(dimension_x - dimension_y) > 3 or abs(estimate - dimension) > 1.8:
                continue
            if ax * by - ay * bx < 0:
                tr, bl = bl, tr
            proposal = Proposal(tl, tr, bl, dimension, sum(finder.count for finder in triple) - 10 * skew)
            # Require the complete symbol inside the source. Quiet margin is
            # sampled only where it exists, never synthesized outside the frame.
            corners = [proposal.point(x, y) for x, y in ((0, 0), (dimension, 0),
                                                       (dimension, dimension), (0, dimension))]
            if (all(-0.5 <= x <= image.width - 0.5 and -0.5 <= y <= image.height - 0.5 for x, y in corners)
                    and _finder_patterns_agree(image, proposal, threshold)):
                proposals.append(proposal)
    selected = []
    for proposal in sorted(proposals, key=lambda proposal: -proposal.score):
        if any(proposal.dimension == previous.dimension and
               0.9 <= proposal.top_left.module / previous.top_left.module <= 1.1 and
               all(math.dist(proposal.point(x, y), previous.point(x, y)) <=
                   2 * max(proposal.top_left.module, previous.top_left.module)
                   for x, y in ((0, 0), (proposal.dimension, 0), (0, proposal.dimension)))
               for previous in selected):
            continue
        selected.append(proposal)
    return Search(tuple(selected[:limit]), complete and len(selected) <= limit)


def variants(image, proposal):
    """Yield small real-pixel crops and module samples with source transforms."""
    dimension = proposal.dimension
    corners = [proposal.point(x, y) for x, y in ((-4, -4), (dimension + 4, -4),
                                                (dimension + 4, dimension + 4), (-4, dimension + 4))]
    left, top = max(0, math.floor(min(x for x, _ in corners))), max(0, math.floor(min(y for _, y in corners)))
    right, bottom = min(image.width, math.ceil(max(x for x, _ in corners))), min(image.height, math.ceil(max(y for _, y in corners)))
    with image.crop((left, top, right, bottom)) as crop:
        factor = min(3.0, math.sqrt(1_000_000 / (crop.width * crop.height)))
        size = max(1, math.floor(crop.width * factor)), max(1, math.floor(crop.height * factor))
        sx, sy = crop.width / size[0], crop.height / size[1]
        enlarged = crop.resize(size, Image.Resampling.BILINEAR)
        yield enlarged, lambda x, y: (left + (x + 0.5) * sx - 0.5, top + (y + 0.5) * sy - 0.5), 'qr-source-crop', False
    pixels = image.load()
    # Independent samples inside each module reduce a narrow scratch's influence.
    # Inverse filtering acts on observed intensities, never on expected payloads.
    for phase, robust, deblur in ((0, False, 0), (0, True, 0), (-0.16, False, 0),
                                  (0.16, False, 0), (0, False, 0.4), (0, False, 0.9), (0, False, 1.5)):
        def sample(column, row):
            x, y = proposal.point(column, row)
            if not (0 <= x <= image.width - 1 and 0 <= y <= image.height - 1):
                return None
            x0, y0 = math.floor(x), math.floor(y)
            x1, y1 = min(image.width - 1, x0 + 1), min(image.height - 1, y0 + 1)
            dx, dy = x - x0, y - y0
            return ((1 - dx) * (1 - dy) * pixels[x0, y0] + dx * (1 - dy) * pixels[x1, y0] +
                    (1 - dx) * dy * pixels[x0, y1] + dx * dy * pixels[x1, y1])

        border = next((border for border in range(4, -1, -1) if all(
            sample(x + phase, y + phase) is not None
            for x in (-border + 0.15, dimension + border - 0.15)
            for y in (-border + 0.15, dimension + border - 0.15))), None)
        if border is None:
            continue
        cells = dimension + border * 2
        values = []
        for row in range(cells):
            for column in range(cells):
                u, v = column - border + 0.5 + phase, row - border + 0.5 + phase
                value = sample(u, v)
                if value is None:
                    return
                if robust:
                    samples = [value] + [sample(u + dx, v + dy) for dx, dy in
                                         ((-0.24, -0.24), (0.24, -0.24), (-0.24, 0.24), (0.24, 0.24))]
                    if any(value is None for value in samples):
                        return
                    value = sorted(samples)[2]
                values.append(value)
        low, high = min(values), max(values)
        if high - low < 12:
            continue
        if deblur:
            original = values.copy()
            for row in range(1, cells - 1):
                for column in range(1, cells - 1):
                    index = row * cells + column
                    values[index] = max(low, min(high, original[index] * (1 + 4 * deblur) - deblur *
                        (original[index - 1] + original[index + 1] + original[index - cells] + original[index + cells])))
        threshold = (low + high) / 2
        with Image.new('L', (cells, cells)) as binary:
            binary.putdata([0 if value < threshold else 255 for value in values])
            enlarged = binary.resize((cells * 4, cells * 4), Image.Resampling.NEAREST)
        strategy = 'qr-module-deblur' if deblur else 'qr-module-median' if robust else 'qr-module-sample'
        yield enlarged, lambda x, y, phase=phase, border=border: proposal.point(x / 4 - border + phase, y / 4 - border + phase), strategy, True
