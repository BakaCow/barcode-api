"""Bounded linear-barcode hypotheses checked against original grayscale pixels.

The exposure-blur inverse proposes symbols; a forward model must fit the whole
symbol AND its observed quiet margins on at least three actual source rows.
Native reading of a rendered template supplies canonical bytes/text only. It is
not an independent reading of the photographed source.

Cross-row reconstruction is restricted to aligned source columns with local
oversized flat-run defects. Every reconstructed column needs at least three
unmasked original observations; missing full-height information is not filled.

Code128 pattern data derives from the project's existing Apache-2.0 ZXing-C++
ODCode128Patterns.h table: Nu-book 2016 / ZXing authors 2016. See
web/engine/THIRD-PARTY.txt and web/vendor/ZXING-CPP-LICENSE.txt.
"""
from dataclasses import dataclass, field
import math
from time import monotonic

from PIL import Image
import zxingcpp


MAX_PIXELS = 4_000_000
LEFT = ('0001101', '0011001', '0010011', '0111101', '0100011', '0110001',
        '0101111', '0111011', '0110111', '0001011')
EVEN = ('0100111', '0110011', '0011011', '0100001', '0011101', '0111001',
        '0000101', '0010001', '0001001', '0010111')
RIGHT = tuple(''.join('1' if bit == '0' else '0' for bit in bits) for bits in LEFT)
PARITY = ('LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
          'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL')
PATTERNS = tuple(tuple(map(int, value)) for value in (
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112'))
CODE_BITS = tuple(''.join(('1' if index % 2 == 0 else '0') * run for index, run in enumerate(pattern))
                  for pattern in PATTERNS)


def _sinc(value):
    return 1.0 if abs(value) < 1e-9 else math.sin(math.pi * value) / (math.pi * value)


_SAMPLING_CDF = [0.0]
for _index in range(1, 385):
    _x = (_index - .5) / 64 - 3
    _SAMPLING_CDF.append(_SAMPLING_CDF[-1] + _sinc(_x) * _sinc(_x / 3) / 64)
_SAMPLING_CDF = tuple(value / _SAMPLING_CDF[-1] for value in _SAMPLING_CDF)


def _sampling_cdf(value):
    index = (value + 3) * 64
    if index <= 0:
        return 0.0
    if index >= 384:
        return 1.0
    base = math.floor(index)
    return _SAMPLING_CDF[base] + (index - base) * (_SAMPLING_CDF[base + 1] - _SAMPLING_CDF[base])


class _Deadline(Exception):
    def __init__(self, candidates=()):
        super().__init__('Linear source search exceeded its deadline.')
        self.candidates = tuple(candidates)


def _check_time(deadline):
    if monotonic() >= deadline:
        raise _Deadline


@dataclass(frozen=True, slots=True)
class Candidate:
    family: str
    payload: bytes
    bits: str
    left: float
    right: float
    quiet_left: float
    quiet_right: float
    gs1: bool = False


@dataclass(frozen=True, slots=True)
class Proof:
    left: float
    unit: float
    rmse: float
    max_block: float
    aperture: float = 1
    source_rows: tuple[int, ...] = ()
    outer_ink: bool = False


@dataclass(slots=True)
class Group:
    candidate: Candidate
    proof: Proof
    band: int
    rows: set[int] = field(default_factory=set)


@dataclass(frozen=True, slots=True)
class Observation:
    code: object
    points: tuple[tuple[float, float], ...]


@dataclass(frozen=True, slots=True)
class Recovery:
    observations: tuple[Observation, ...]
    complete: bool
    observed: int
    passes: int


def _round(value):
    return math.floor(value + .5)


def _inverse(row, length):
    output = [255.0] * len(row)
    half = length // 2
    previous = 255
    for x, value in enumerate(row):
        target = x + half
        if target < len(row):
            origin = output[target - length] if target >= length else 255
            output[target] = max(0, min(255, origin + length * (value - previous)))
        previous = value
    return bytes(0 if value < 128 else 255 for value in output)


def _ean_checksum(text):
    return len(text) == 13 and text.isascii() and text.isdigit() and sum(
        int(value) * (3 if index % 2 else 1) for index, value in enumerate(text)) % 10 == 0


def _ean_bits(text):
    return ('101' + ''.join((LEFT if PARITY[int(text[0])][index] == 'L' else EVEN)[int(digit)]
                           for index, digit in enumerate(text[1:7])) + '01010' +
            ''.join(RIGHT[int(digit)] for digit in text[7:]) + '101')


def _ean_line(row):
    left, right = 0, len(row)
    while left < right and row[left] > 128:
        left += 1
    while right > left and row[right - 1] > 128:
        right -= 1
    unit = (right - left) / 95
    if unit < .7 or unit > 24 or left < 11 * unit or len(row) - right < 7 * unit:
        return None
    bits = ''.join('1' if row[min(len(row) - 1, math.floor(left + (index + .5) * unit))] < 128 else '0'
                   for index in range(95))
    if bits[:3] != '101' or bits[45:50] != '01010' or bits[-3:] != '101':
        return None
    parity, digits = '', ''
    for index in range(6):
        symbol = bits[3 + index * 7:10 + index * 7]
        if symbol in LEFT:
            parity += 'L'; digits += str(LEFT.index(symbol))
        elif symbol in EVEN:
            parity += 'G'; digits += str(EVEN.index(symbol))
        else:
            return None
    if parity not in PARITY:
        return None
    text = str(PARITY.index(parity)) + digits
    for index in range(6):
        symbol = bits[50 + index * 7:57 + index * 7]
        if symbol not in RIGHT:
            return None
        text += str(RIGHT.index(symbol))
    # A zero-prefix physical EAN can also be UPC-A; leave aliases to old paths.
    if text[0] == '0' or not _ean_checksum(text):
        return None
    return Candidate('EAN13', text.encode('ascii'), bits, left, right, 11 * unit, 7 * unit)


def _pattern_error(runs, offset, pattern, count=None):
    count = len(pattern) if count is None else count
    if offset + count > len(runs):
        return None
    unit = sum(run[1] for run in runs[offset:offset + count]) / sum(pattern[:count])
    if unit < .8:
        return None
    error = 0
    for index in range(count):
        difference = runs[offset + index][1] / unit - pattern[index]
        if abs(difference) > .8:
            return None
        error += difference * difference
    error /= count
    return (error, unit) if error <= .16 else None


def _match_word(runs, offset, start_only=False):
    matches = []
    for word in range(103, 106) if start_only else range(107):
        fit = _pattern_error(runs, offset, PATTERNS[word], 6)
        if fit is not None:
            matches.append((fit[0], word, fit[1]))
    matches.sort()
    if not matches or len(matches) > 1 and matches[1][0] - matches[0][0] < .018:
        return None
    return matches[0]


def _code_payload(words):
    if len(words) < 3 or (words[0] + sum(index * word for index, word in enumerate(words[1:-1], 1))) % 103 != words[-1]:
        return None
    code_set, gs1, output, index = words[0] - 103, False, [], 1
    while index < len(words) - 1:
        word = words[index]
        if word == 102:
            if index == 1:
                gs1 = True
            elif not gs1 and index == 2 and (code_set == 2 or len(output) == 1 and (65 <= output[0] <= 90 or 97 <= output[0] <= 122)):
                return None
            else:
                output.append(29)
        elif code_set == 2:
            if word < 100:
                output.extend((48 + word // 10, 48 + word % 10))
            elif word in (100, 101):
                code_set = 1 if word == 100 else 0
            else:
                return None
        elif word < 96:
            output.append(word - 64 if code_set == 0 and word >= 64 else word + 32)
        elif word == 98:
            index += 1
            if index >= len(words) - 1 or words[index] >= 96:
                return None
            shifted, alternate = words[index], 1 - code_set
            output.append(shifted - 64 if alternate == 0 and shifted >= 64 else shifted + 32)
        elif word == 99:
            code_set = 2
        elif code_set == 0 and word == 100 or code_set == 1 and word == 101:
            code_set = 1 - code_set
        else:
            return None  # FNC2/FNC3/FNC4 remain on existing native paths.
        index += 1
    return (bytes(output), gs1) if output else None


def _code128_lines(row):
    runs = []
    for index, value in enumerate(row):
        dark = value < 128
        if runs and runs[-1][0] == dark:
            runs[-1][1] += 1
        else:
            runs.append([dark, 1, index])
    result = []
    for offset in range(1, len(runs) - 23):
        if not runs[offset][0] or runs[offset - 1][0]:
            continue
        start = _match_word(runs, offset, True)
        if start is None or runs[offset - 1][1] + .75 < 10 * start[2]:
            continue
        words, unit = [start[1]], start[2]
        for next_ in range(offset + 6, min(len(runs) - 6, offset + 6 * 256), 6):
            word = _match_word(runs, next_)
            if word is None or not .65 <= word[2] / unit <= 1.5:
                break
            if word[1] == 106:
                stop = _pattern_error(runs, next_, PATTERNS[106])
                quiet = runs[next_ + 7] if next_ + 7 < len(runs) else None
                if stop is None or quiet is None or quiet[0] or quiet[1] + .75 < 10 * stop[1]:
                    break
                payload = _code_payload(words)
                if payload:
                    bits = ''.join(CODE_BITS[value] for value in words) + CODE_BITS[106]
                    result.append(Candidate('Code128', payload[0], bits, runs[offset][2],
                                            runs[next_ + 6][2] + runs[next_ + 6][1],
                                            10 * start[2], 10 * stop[1], payload[1]))
                break
            if word[1] >= 103:
                break
            words.append(word[1]); unit = .8 * unit + .2 * word[2]
    return result


def _ideal_row(bits, width, left, unit, aperture=1):
    result = [1.0] * width
    if aperture == 0:
        for x in range(max(0, math.floor(left - 3)), min(width, math.ceil(left + len(bits) * unit + 3))):
            center = x + .5
            a = max(0, math.floor((center - 3 - left) / unit))
            b = min(len(bits) - 1, math.floor((center + 3 - left) / unit))
            dark = sum(_sampling_cdf(left + (module + 1) * unit - center) -
                       _sampling_cdf(left + module * unit - center)
                       for module in range(a, b + 1) if bits[module] == '1')
            result[x] = max(0, min(1, 1 - dark))
        return result
    for x in range(max(0, math.floor(left - aperture)), min(width, math.ceil(left + len(bits) * unit + aperture))):
        pixel_left, pixel_right = x + .5 - aperture / 2, x + .5 + aperture / 2
        a = max(0, math.floor((pixel_left - left) / unit))
        b = min(len(bits) - 1, math.floor((pixel_right - left) / unit))
        result[x] = 1 - sum(max(0, min(pixel_right, left + (module + 1) * unit) -
                                max(pixel_left, left + module * unit))
                            for module in range(a, b + 1) if bits[module] == '1') / aperture
    return result


def _fit(row, candidate, left, unit, length, aperture=1):
    start = math.floor(left - candidate.quiet_left)
    end = math.ceil(left + len(candidate.bits) * unit + candidate.quiet_right)
    half = length // 2
    if start - half < 0 or end + half > len(row):
        return None
    ideal = _ideal_row(candidate.bits, len(row), left, unit, aperture)
    prediction = [sum(ideal[x - half:x + half + 1]) / length for x in range(start, end)]
    actual = row[start:end]
    sx, sy = sum(prediction), sum(actual)
    n = end - start
    variance = sum(value * value for value in prediction) - sx * sx / n
    if variance < 1:
        return None
    contrast = (sum(a * b for a, b in zip(actual, prediction)) - sx * sy / n) / variance
    black = (sy - contrast * sx) / n
    if not 55 <= contrast <= 320 or not -60 <= black <= 120 or not 150 <= black + contrast <= 310:
        return None
    errors = [((a - black - contrast * b) / contrast) ** 2 for a, b in zip(actual, prediction)]
    block = max(1, _round(7 * unit))
    max_block = max(math.sqrt(sum(errors[offset:offset + block]) / len(errors[offset:offset + block]))
                    for offset in range(0, n, block))
    return Proof(left, unit, math.sqrt(sum(errors) / n), max_block, aperture)


def _best_fit(row, candidate, length, deadline=math.inf):
    best = local = None
    try:
        for aperture in (.7, .85, 1, 1.15, 1.3, 0) if length == 1 else (1,):
            _check_time(deadline)
            local = None
            for shift in (-.5, 0, .5):
                for stretch in (-.5, 0, .5):
                    proof = _fit(row, candidate, candidate.left + shift,
                                 (candidate.right - candidate.left + stretch) / len(candidate.bits), length, aperture)
                    if proof and (local is None or proof.rmse < local.rmse):
                        local = proof
            if local and length == 1:
                for step in (.2, .08, .032, .0128):
                    _check_time(deadline)
                    center = local
                    for shift in (-step, 0, step):
                        for stretch in (-step, 0, step):
                            proof = _fit(row, candidate, center.left + shift,
                                         center.unit + stretch / len(candidate.bits), length, aperture)
                            if proof and proof.rmse < local.rmse:
                                local = proof
            if local and (best is None or local.rmse < best.rmse):
                best = local
    except _Deadline as error:
        accepted = [proof for proof in (best, local) if proof and proof.rmse <= .045 and proof.max_block <= .095]
        if accepted:
            raise _Deadline([(candidate, min(accepted, key=lambda proof: proof.rmse)), *error.candidates]) from error
        raise
    return best if best and best.rmse <= .045 and best.max_block <= .095 else None


def _symbol_extent(row):
    low, high = min(row), max(row)
    if high - low < 70:
        return None
    threshold, first, last = (low + high) / 2, 0, len(row)
    while first < last and row[first] > threshold:
        first += 1
    while last > first and row[last - 1] > threshold:
        last -= 1
    return low, high, first, last


def _digit_cost(row, low, high, bits, origin, unit, *, ean=False):
    body = len(bits)
    previous = ('1' if bits[0] == '0' else '0') if ean else '0'
    following = bits[0] if ean else ('0' if bits[-1] == '1' else '1')
    bits = previous + bits + following
    error, count = 0.0, 0
    for x in range(math.floor(origin), math.ceil(origin + body * unit)):
        if x < 0 or x >= len(row):
            return math.inf
        dark = 0.0
        a = max(0, math.floor((x - origin) / unit) + 1)
        b = min(len(bits) - 1, math.floor((x + 1 - origin) / unit) + 1)
        for k in range(a, b + 1):
            if bits[k] == '1':
                dark += max(0, min(x + 1, origin + k * unit) - max(x, origin + (k - 1) * unit))
        error += ((row[x] - low) / (high - low) - (1 - dark)) ** 2
        count += 1
    return error / count if count >= 3 else math.inf


def _prove_direct(row, hypotheses, deadline):
    """Check every competing payload; equivalent geometry is a work cache.

    The best local template cost only orders proposals. It does not bypass the
    full source model, repair a checksum, or remove a different payload.
    """
    result = []
    for options in hypotheses.values():
        options.sort(key=lambda item: item[0])
        best = None
        try:
            for _error, candidate in options:
                _check_time(deadline)
                proof = _best_fit(row, candidate, 1, deadline)
                if proof and (best is None or proof.rmse < best[1].rmse):
                    best = candidate, proof
                # A complete, very close fit already supports this same physical
                # payload. Other identities are still searched and preserved.
                if best and best[1].rmse < .02:
                    break
        except _Deadline as error:
            # Withheld source evidence must survive an interrupted later search
            # so a caller cannot turn the partial batch into a unique read.
            raise _Deadline([*result, *([best] if best else []), *error.candidates]) from error
        if best:
            result.append(best)
    return result


def _signal_ean(row, deadline):
    extent = _symbol_extent(row)
    if extent is None:
        return []
    low, high, first, last = extent
    if not .72 <= (last - first) / 95 <= 2.2:
        return []
    proposals = {}
    for phase in (-.75, -.5, -.25, 0, .25, .5, .75):
        _check_time(deadline)
        for spread in (-1, -.5, 0, .5, 1):
            left, unit = first + phase, (last - first + spread) / 95
            if left < 11 * unit or len(row) - left - 95 * unit < 7 * unit:
                continue
            left_fits = [[sorted((_digit_cost(row, low, high, bits, left + (3 + 7 * index) * unit, unit, ean=True), digit)
                                 for digit, bits in enumerate(table)) for table in (LEFT, EVEN)] for index in range(6)]
            right_fits = [sorted((_digit_cost(row, low, high, bits, left + (50 + 7 * index) * unit, unit, ean=True), digit)
                                 for digit, bits in enumerate(RIGHT)) for index in range(6)]
            hypotheses = []
            for leading in range(1, 10):
                fits = [value[0 if PARITY[leading][index] == 'L' else 1] for index, value in enumerate(left_fits)] + right_fits
                text = str(leading) + ''.join(str(fit[0][1]) for fit in fits)
                hypotheses.append((sum(fit[0][0] for fit in fits) / 12, text,
                                   min(fit[1][0] - fit[0][0] for fit in fits)))
            hypotheses.sort()
            error, text, margin = hypotheses[0]
            # The unconstrained best sequence must satisfy its own checksum.
            if not _ean_checksum(text) or margin < .012 or hypotheses[1][0] - error < .004:
                continue
            candidate = Candidate('EAN13', text.encode('ascii'), _ean_bits(text), left, left + 95 * unit, 11 * unit, 7 * unit)
            proposals.setdefault(candidate.payload, []).append((error, candidate))
    return _prove_direct(row, proposals, deadline)


def _signal_code128(row, deadline):
    extent = _symbol_extent(row)
    if extent is None:
        return []
    low, high, first, last = extent
    span = last - first
    if span < 50 or span > 600:
        return []
    guards = []
    for count in range(3, min(70, math.floor(span / (.72 * 11))) + 1):
        _check_time(deadline)
        for phase in (-.75, -.5, -.25, 0, .25, .5, .75):
            for spread in (-1, -.5, 0, .5, 1):
                left, unit = first + phase, (span + spread) / (count * 11 + 13)
                if not .72 <= unit <= 1.8 or left < 10 * unit or len(row) - left - (count * 11 + 13) * unit < 10 * unit:
                    continue
                stop_error = _digit_cost(row, low, high, CODE_BITS[106], left + count * 11 * unit, unit)
                if stop_error >= .035:
                    continue
                for start in range(103, 106):
                    start_error = _digit_cost(row, low, high, CODE_BITS[start], left, unit)
                    if start_error < .035:
                        guards.append(((start_error + stop_error) / 2, left, unit, count, start))
    guards.sort()
    proposals = {}
    for guard_error, left, unit, count, start in guards[:12]:
        _check_time(deadline)
        words = [start]
        for index in range(1, count):
            fits = sorted((_digit_cost(row, low, high, bits, left + index * 11 * unit, unit), word)
                          for word, bits in enumerate(CODE_BITS[:103]))
            if fits[0][0] > .035 or fits[1][0] - fits[0][0] < .008:
                break
            words.append(fits[0][1])
        if len(words) != count:
            continue
        payload = _code_payload(words)
        if payload is None:
            continue
        bits = ''.join(CODE_BITS[word] for word in words) + CODE_BITS[106]
        candidate = Candidate('Code128', payload[0], bits, left, left + len(bits) * unit, 10 * unit, 10 * unit, payload[1])
        proposals.setdefault((candidate.payload, candidate.gs1), []).append((guard_error, candidate))
    return _prove_direct(row, proposals, deadline)


def _active_rows(raw, width, height, deadline):
    step, bands = max(1, height // 128), []
    for y in range(0, height, step):
        if monotonic() >= deadline:
            return [], False
        row = raw[y * width:(y + 1) * width]
        if max(row) - min(row) >= 45 and sum(abs(a - b) > 5 for a, b in zip(row[1:], row)) >= 12:
            if bands and y - bands[-1][1] <= step * 2:
                bands[-1][1] = y
            else:
                bands.append([y, y])
                if len(bands) > 4:
                    return [], False
    return [(band, y) for band, (top, bottom) in enumerate(bands)
            for y in sorted({_round(top + (bottom - top) * index / 8) for index in range(9)})], True


def _compatible(group, candidate, proof, band):
    if group.band != band or (group.candidate.family, group.candidate.payload, group.candidate.gs1) != (candidate.family, candidate.payload, candidate.gs1):
        return False
    width, previous = proof.unit * len(candidate.bits), group.proof.unit * len(group.candidate.bits)
    return min(width, previous) / max(width, previous) >= .9 and abs(proof.left - group.proof.left) <= max(2, 2 * max(proof.unit, group.proof.unit))


def _template(candidate):
    row = bytes(0 if bit == '1' else 255 for bit in '0' * 12 + candidate.bits + '0' * 12)
    expanded = bytes(value for value in row for _ in range(3))
    return Image.frombytes('L', (len(expanded), 12), expanded * 12)


def _composite_proof(rows, candidate, proof):
    """Every reconstructed column needs several unmasked original observations."""
    unit, left = proof.unit, proof.left
    right = left + len(candidate.bits) * unit
    if not 1.4 <= unit <= 16 or right - left > 1800 or len(rows) < 5:
        return None
    start, end = math.floor(left - candidate.quiet_left), math.ceil(right + candidate.quiet_right)
    if start < 0 or end > len(rows[0][1]):
        return None
    ideal = _ideal_row(candidate.bits, len(rows[0][1]), left, unit, proof.aperture)
    guards = (_ideal_row('101' + '0' * 42 + '01010' + '0' * 42 + '101', len(rows[0][1]), left, unit, proof.aperture)
              if candidate.family == 'EAN13' else None)
    support, squared, count, damage = [0] * (end - start), 0, 0, 0
    source_rows = []
    outer_ink = False
    for y, row in rows:
        low, high = min(row[start:end]), max(row[start:end])
        if high - low < 100:
            return None
        if any(value < high - 12 for value in row[:start]) or any(value < high - 12 for value in row[end:]):
            outer_ink = True
        # The EAN guard extensions below data bars are not data observations.
        if guards and all(abs((row[x] - low) / (high - low) - guards[x]) <= .16 for x in range(start, end)):
            continue
        source_rows.append(y)
        threshold, mask = (low + high) / 2, bytearray(end - start)
        masked = regions = 0
        x, limit = max(start, math.ceil(left)), min(end, math.floor(right))
        while x < limit:
            first, dark = x, row[x] < threshold
            while x < limit and (row[x] < threshold) == dark:
                x += 1
            if x - first < 4.75 * unit:
                continue
            # Defect locations follow abnormally long flat source runs, not
            # whichever pixels would disagree with a desirable checksum.
            if first < left + 7 * unit or x > right - 7 * unit or x - first > (right - left) * .25:
                return None
            regions += 1
            for column in range(max(start, first - 1), min(end, x + 1)):
                if not mask[column - start]:
                    mask[column - start] = 1
                    masked += 1
        if regions > 4 or masked > (right - left) * .35:
            return None
        row_squared = row_count = 0
        for x in range(start, end):
            error = (row[x] - low) / (high - low) - ideal[x]
            if mask[x - start]:
                damage += abs(error) > .3
                continue
            if abs(error) > .16:
                return None
            support[x - start] += 1
            row_squared += error * error
            row_count += 1
        if not row_count or math.sqrt(row_squared / row_count) > .055:
            return None
        squared += row_squared
        count += row_count
    if not damage or len(source_rows) < 5 or min(support) < 3:
        return None
    return Proof(left, unit, math.sqrt(squared / count), proof.max_block, proof.aperture, tuple(source_rows), outer_ink)


def _composite_candidates(raw, width, selected, allowed, deadline):
    if len(selected) < 5 or width > 2048 or selected[-1] - selected[0] < 4:
        return [], True
    rows = [(y, raw[y * width:(y + 1) * width]) for y in selected]
    output = {}
    try:
        for quantile in (.5, .15, .85):
            _check_time(deadline)
            rank = math.floor((len(rows) - 1) * quantile)
            profile = bytes(sorted(row[x] for _, row in rows)[rank] for x in range(width))
            low, high = min(profile), max(profile)
            if high - low < 100:
                continue
            binary = bytes(0 if value < (low + high) / 2 else 255 for value in profile)
            candidates = _code128_lines(binary) if 'Code128' in allowed else []
            if 'EAN13' in allowed:
                candidate = _ean_line(binary)
                if candidate:
                    candidates.append(candidate)
            for candidate in candidates:
                _check_time(deadline)
                unit = (candidate.right - candidate.left) / len(candidate.bits)
                fitted = _fit(profile, candidate, candidate.left, unit, 1)
                if not fitted or fitted.rmse > .045 or fitted.max_block > .095:
                    fitted = _best_fit(profile, candidate, 1, deadline)
                if not fitted:
                    continue
                proof = _composite_proof(rows, candidate, fitted)
                if not proof:
                    continue
                key = (candidate.family, candidate.payload, candidate.gs1, candidate.left, candidate.right)
                if key not in output or proof.rmse < output[key][1].rmse:
                    output[key] = (candidate, proof)
                if len(output) > 8:
                    return list(output.values())[:8], False
    except _Deadline:
        # A profile fit is not a source proof: only completed original-row
        # validations survive this interruption as withheld evidence.
        return list(output.values()), False
    return list(output.values()), monotonic() < deadline and not any(proof.outer_ink for _, proof in output.values())


def recover(image, *, deadline, formats=('EAN13', 'Code128')):
    """Return native canonical observations only after complete source checks."""
    if not isinstance(image, Image.Image) or image.mode != 'L' or min(image.size) < 1 or image.width > 8192 or image.width * image.height > MAX_PIXELS:
        raise ValueError('Linear signal recovery requires a bounded grayscale image.')
    if not isinstance(deadline, (int, float)) or not math.isfinite(deadline) or isinstance(formats, (str, bytes)) or any(value not in {'EAN13', 'Code128'} for value in formats):
        raise ValueError('Invalid linear signal recovery options.')
    allowed = set(formats)
    if not allowed:
        return Recovery((), True, 0, 0)
    if monotonic() >= deadline:
        return Recovery((), False, 0, 0)
    raw = image.tobytes()
    rows, complete = _active_rows(raw, image.width, image.height, deadline)
    if not complete:
        return Recovery((), False, 0, 0)
    groups, cache = [], {}
    for band, y in rows:
        if monotonic() >= deadline:
            complete = False; break
        row = raw[y * image.width:(y + 1) * image.width]
        if max(row) - min(row) < 45:
            continue
        if row not in cache:
            found = []
            try:
                if 'EAN13' in allowed:
                    found.extend(_signal_ean(row, deadline))
                if 'Code128' in allowed:
                    found.extend(_signal_code128(row, deadline))
                for length in (3, 5, 7, 9, 11, 13, 15):
                    _check_time(deadline)
                    restored = _inverse(row, length)
                    candidates = _code128_lines(restored) if 'Code128' in allowed else []
                    if 'EAN13' in allowed:
                        candidate = _ean_line(restored)
                        if candidate:
                            candidates.append(candidate)
                    for candidate in candidates:
                        proof = _best_fit(row, candidate, length, deadline)
                        if proof:
                            found.append((candidate, proof))
            except _Deadline as error:
                found.extend(error.candidates)
                complete = False
            cache[row] = found
        for candidate, proof in cache[row]:
            group = next((group for group in groups if _compatible(group, candidate, proof, band)), None)
            if group is None:
                group = Group(candidate, proof, band)
                groups.append(group)
            group.rows.add(y)
            if proof.rmse < group.proof.rmse:
                group.proof, group.candidate = proof, candidate
            if len(groups) > 8:
                complete = False; break
        if not complete:
            break
    if complete:
        for band in sorted({band for band, _ in rows}):
            if any(group.band == band for group in groups):
                continue
            selected = [y for row_band, y in rows if row_band == band]
            reconstructed, completed = _composite_candidates(raw, image.width, selected, allowed, deadline)
            for candidate, proof in reconstructed:
                group = Group(candidate, proof, band)
                group.rows.update(proof.source_rows)
                groups.append(group)
            if not completed or len(groups) > 8:
                complete = False
                break
    observations, passes = [], 0
    for group in groups:
        if len(group.rows) < 3 or max(group.rows) - min(group.rows) < 2:
            complete = False; continue
        if monotonic() >= deadline:
            complete = False; break
        candidate = group.candidate
        with _template(candidate) as template:
            codes = zxingcpp.read_barcodes(template, formats=getattr(zxingcpp.BarcodeFormat, candidate.family))
        passes += 1
        matching = [code for code in codes if code.valid and not code.error and code.format.name == candidate.family and code.bytes == candidate.payload]
        if len({(code.format.name, code.text, code.bytes) for code in matching}) != 1:
            complete = False; continue
        left = group.proof.left
        right = left + group.proof.unit * len(candidate.bits)
        top, bottom = min(group.rows), max(group.rows)
        observations.append(Observation(matching[0], ((left, top), (right, top), (right, bottom), (left, bottom))))
    if monotonic() >= deadline:
        complete = False
    identities = {(item.code.format.name, item.code.text, item.code.bytes) for item in observations}
    if not complete and len(identities) < 2:
        observations = []
    return Recovery(tuple(observations), complete, len(groups), passes)
