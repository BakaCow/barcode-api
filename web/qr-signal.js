/* Bounded source-signal QR recovery. Uniform axis-aligned exposure inversion,
 * plus a square-cell optical fit for small front-facing QR versions 1–10.
 * Native QR decoding alone supplies payload, bytes, checksum and correction.
 * Unsupported blur/geometry and missing source evidence deliberately abstain. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./qr-geometry.js') : root.QRGeometry);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QRSignal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (geometry) {
  'use strict';
  const { abs, ceil, floor, min, max, sqrt, round } = Math;
  const clock = () => typeof performance === 'object' ? performance.now() : Date.now();
  function source(image) {
    const { width, height } = image || {};
    const rgba = image?.data instanceof ArrayBuffer ? new Uint8ClampedArray(image.data) : image?.data;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 21 || height < 21 || width * height > 4_000_000 ||
      !(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4) return null;
    const gray = new Uint8Array(width * height); let low = 255, high = 0;
    for (let i = 0; i < gray.length; i++) {
      const p = i * 4, a = rgba[p + 3] / 255;
      const value = round(((306 * rgba[p] + 601 * rgba[p + 1] + 117 * rgba[p + 2]) / 1024) * a + 255 * (1 - a));
      gray[i] = value; low = min(low, value); high = max(high, value);
    }
    if (high - low < 60) return null;
    let left = width, top = height, right = 0, bottom = 0;
    const threshold = low + (high - low) * 0.72;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (gray[y * width + x] < threshold) {
      left = min(left, x); top = min(top, y); right = max(right, x + 1); bottom = max(bottom, y + 1);
    }
    const w = right - left, h = bottom - top;
    // This bounded proposal covers all observed dark content; it never selects
    // just the first label from a cluttered or multiple-label photograph.
    if (w < 18 || h < 18 || w / h < 0.55 || w / h > 1.8 || w > 640 || h > 640) return null;
    left = max(0, left - 24); top = max(0, top - 24);
    right = min(width, right + 24); bottom = min(height, bottom + 24);
    const cropped = new Uint8Array((right - left) * (bottom - top));
    for (let y = top; y < bottom; y++) cropped.set(gray.subarray(y * width + left, y * width + right), (y - top) * (right - left));
    return { gray: cropped, width: right - left, height: bottom - top, x: left, y: top, low, high };
  }
  function restore(input, length, vertical = false, clamped = false) {
    if (!input || !Number.isInteger(length) || length < 3 || length > 15 || length % 2 !== 1) return null;
    const { width, height, gray, low, high } = input, span = high - low, half = length >> 1;
    const lines = vertical ? width : height, size = vertical ? height : width;
    if (size < length * 2 + 14 || width * height > 500_000) return null;
    const at = (line, offset) => vertical ? offset * width + line : line * width + offset;
    // Initial conditions come from a real photographed light margin. A cropped
    // symbol touching an image edge is not repaired by padding a white border.
    for (let line = 0; line < lines; line++) for (let i = 0; i <= half; i++) {
      if (gray[at(line, i)] < high - span * 0.04 || gray[at(line, size - 1 - i)] < high - span * 0.04) return null;
    }
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let line = 0; line < lines; line++) {
      const reconstructed = new Float64Array(size + half).fill(high);
      for (let j = 0; j < size; j++) {
        const i = j + half;
        const value = length * (gray[at(line, j)] - (j ? gray[at(line, j - 1)] : high)) + (i >= length ? reconstructed[i - length] : high);
        reconstructed[i] = clamped ? min(high, max(low, value)) : value;
      }
      for (let i = 0; i < size; i++) {
        const p = at(line, i) * 4, value = reconstructed[i] < (low + high) / 2 ? 0 : 255;
        data[p] = data[p + 1] = data[p + 2] = value;
      }
    }
    return { width, height, data };
  }
  function forwardFit(input, restored, region, length, vertical = false) {
    const { width, height, gray, low, high } = input, half = length >> 1, span = high - low;
    const box = region?.content;
    if (!box || !region.gridReliable || region.clipped || region.moduleSize < 1.2) return null;
    const left = max(half, floor(box.x)), top = max(half, floor(box.y));
    const right = min(width - half, ceil(box.x + box.width)), bottom = min(height - half, ceil(box.y + box.height));
    if (right - left < 21 || bottom - top < 21) return null;
    let squared = 0, count = 0; const tiles = Array.from({ length: 16 }, () => [0, 0]);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      let sum = 0;
      for (let k = -half; k <= half; k++) sum += restored.data[((y + (vertical ? k : 0)) * width + x + (vertical ? 0 : k)) * 4] / 255;
      const predicted = low + span * sum / length, error = (predicted - gray[y * width + x]) / span;
      squared += error * error; count++;
      const tile = tiles[min(3, floor((y - top) * 4 / (bottom - top))) * 4 + min(3, floor((x - left) * 4 / (right - left)))];
      tile[0] += error * error; tile[1]++;
    }
    const rmse = sqrt(squared / count), worstTile = max(...tiles.filter(tile => tile[1]).map(tile => sqrt(tile[0] / tile[1])));
    return rmse <= 0.055 && worstTile <= 0.105 ? { rmse, worstTile } : null;
  }
  function enlarge(input, scale = 4) {
    const width = input.width * scale, height = input.height * scale, data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = max(0, min(input.width - 1, (x + .5) / scale - .5)), sy = max(0, min(input.height - 1, (y + .5) / scale - .5));
      const ix = floor(sx), iy = floor(sy), fx = sx - ix, fy = sy - iy, nx = min(input.width - 1, ix + 1), ny = min(input.height - 1, iy + 1);
      const value = (1 - fy) * ((1 - fx) * input.gray[iy * input.width + ix] + fx * input.gray[iy * input.width + nx]) +
        fy * ((1 - fx) * input.gray[ny * input.width + ix] + fx * input.gray[ny * input.width + nx]);
      const p = (y * width + x) * 4; data[p] = data[p + 1] = data[p + 2] = value;
    }
    return { width, height, data };
  }
  function optical(input, region, expired = () => false) {
    const dimension = region.dimension, scale = 4;
    if (!region.gridReliable || region.clipped || dimension > 57 || region.moduleSize / scale < .7 || region.moduleSize / scale > 1.6) return null;
    const q = region.quad;
    if (abs(q.topRight.y - q.topLeft.y) > region.moduleSize * .4 || abs(q.bottomLeft.x - q.topLeft.x) > region.moduleSize * .4) return null;
    const parameters = [(q.topLeft.x + .5) / scale - .5, (q.topLeft.y + .5) / scale - .5,
      (q.topRight.x - q.topLeft.x) / scale / dimension, (q.bottomLeft.y - q.topLeft.y) / scale / dimension];
    if (parameters[2] <= 0 || parameters[3] <= 0 || parameters[2] / parameters[3] < .9 || parameters[2] / parameters[3] > 1.1) return null;
    // This optical model is for nearly front-facing square cells. A general
    // projective/curved symbol remains on the existing native recovery paths.
    parameters[2] = parameters[3] = (parameters[2] + parameters[3]) / 2;
    const initial = parameters.slice(), { width, height, gray, low, high } = input, span = high - low;
    function functional(x, y) {
      let ox, oy;
      if (x < 8 && y < 8) { ox = 0; oy = 0; }
      else if (x >= dimension - 8 && y < 8) { ox = dimension - 7; oy = 0; }
      else if (x < 8 && y >= dimension - 8) { ox = 0; oy = dimension - 7; }
      else if ((x === 6 && y >= 8 && y < dimension - 8) || (y === 6 && x >= 8 && x < dimension - 8)) return (x + y) % 2 === 0 ? 1 : 0;
      else return null;
      const a = x - ox, b = y - oy;
      if (a < 0 || b < 0 || a > 6 || b > 6) return 0;
      return a === 0 || b === 0 || a === 6 || b === 6 || (a >= 2 && a <= 4 && b >= 2 && b <= 4) ? 1 : 0;
    }
    function weights(pixel, origin, pitch) {
      const a = (pixel - .5 - origin) / pitch, b = (pixel + .5 - origin) / pitch, output = [];
      for (let cell = floor(a); cell < ceil(b); cell++) {
        const weight = (min(b, cell + 1) - max(a, cell)) * pitch;
        if (weight > 1e-6) output.push([cell, weight]);
      }
      return output;
    }
    function measurements(p, onlyFunctional) {
      const output = [];
      for (let y = max(0, floor(p[1])); y < min(height, ceil(p[1] + dimension * p[3])); y++) {
        for (let x = max(0, floor(p[0])); x < min(width, ceil(p[0] + dimension * p[2])); x++) {
          const cells = []; let known = true, predicted = 0;
          for (const [cy, wy] of weights(y, p[1], p[3])) for (const [cx, wx] of weights(x, p[0], p[2])) {
            if (cx < 0 || cy < 0 || cx >= dimension || cy >= dimension) { known = false; continue; }
            const expected = functional(cx, cy); if (expected === null) known = false; else predicted += wx * wy * expected;
            cells.push([cy * dimension + cx, wx * wy]);
          }
          if (onlyFunctional && !known) continue;
          output.push({ cells, value: (high - gray[y * width + x]) / span, predicted, x, y });
        }
      }
      return output;
    }
    function score(p) {
      const items = measurements(p, true);
      return items.length < 30 ? Infinity : items.reduce((sum, item) => sum + (item.predicted - item.value) ** 2, 0) / items.length;
    }
    let best = score(parameters);
    for (const amount of [.35, .17, .07, .03]) for (let pass = 0; pass < 2; pass++) for (let axis = 0; axis < 3; axis++) {
      if (expired()) return null;
      let selected = parameters[axis];
      for (const sign of [-1, 1]) {
        const trial = parameters.slice(); trial[axis] += sign * amount / (axis < 2 ? 1 : dimension);
        if (axis === 2) trial[3] = trial[2];
        if (abs(trial[axis] - initial[axis]) > (axis < 2 ? .9 : .9 / dimension)) continue;
        const candidate = score(trial); if (candidate < best) { best = candidate; selected = trial[axis]; }
      }
      parameters[axis] = selected;
      if (axis === 2) parameters[3] = selected;
    }
    // Every photographed finder must support the fitted optical model, not just
    // the average of a good corner and an invented/damaged corner.
    const evidence = measurements(parameters, true), groups = [[], [], []];
    for (const item of evidence) {
      const cx = (item.x - parameters[0]) / parameters[2], cy = (item.y - parameters[1]) / parameters[3];
      const group = cx < 8 && cy < 8 ? 0 : cx >= dimension - 8 && cy < 8 ? 1 : cx < 8 && cy >= dimension - 8 ? 2 : -1;
      if (group >= 0) groups[group].push((item.predicted - item.value) ** 2);
    }
    if (sqrt(best) > .12 || groups.some(group => group.length < 10 || sqrt(group.reduce((a, b) => a + b, 0) / group.length) > .14)) return null;
    // The pure-grid border needs real four-module space and an observed light
    // quiet ring; clipping is not repaired by inventing a photographed margin.
    const [originX, originY, pitchX, pitchY] = parameters;
    if (originX - 4 * pitchX < 0 || originY - 4 * pitchY < 0 || originX + (dimension + 4) * pitchX >= width || originY + (dimension + 4) * pitchY >= height) return null;
    for (let cell = -3; cell < dimension + 3; cell++) for (const [x, y] of [[cell, -2], [cell, dimension + 2], [-2, cell], [dimension + 2, cell]]) {
      if (gray[round(originY + y * pitchY) * width + round(originX + x * pitchX)] < high - .08 * span) return null;
    }
    const entries = measurements(parameters, false), modules = new Float64Array(dimension * dimension), norm = new Float64Array(modules.length);
    for (const item of entries) for (const [index, weight] of item.cells) { modules[index] += weight * item.value; norm[index] += weight; }
    for (let index = 0; index < modules.length; index++) modules[index] = norm[index] ? modules[index] / norm[index] : .5;
    for (let iteration = 0; iteration < 160; iteration++) {
      if (expired()) return null;
      const gradient = new Float64Array(modules.length), diagonal = new Float64Array(modules.length);
      for (const item of entries) {
        let predicted = 0; for (const [index, weight] of item.cells) predicted += weight * modules[index];
        for (const [index, weight] of item.cells) { gradient[index] += weight * (predicted - item.value); diagonal[index] += weight * weight; }
      }
      for (let index = 0; index < modules.length; index++) {
        const known = functional(index % dimension, floor(index / dimension));
        if (known !== null) { modules[index] = known; continue; }
        const prior = iteration > 60 ? .02 : 0;
        modules[index] = max(0, min(1, modules[index] - .3 * (gradient[index] + prior * (1 - 2 * modules[index])) / max(.1, diagonal[index])));
      }
    }
    const candidates = [];
    for (const threshold of [.4, .45, .5, .55, .6]) {
      const binary = Uint8Array.from(modules, value => value > threshold ? 1 : 0);
      let squared = 0; const tiles = Array.from({ length: 16 }, () => [0, 0]);
      for (const item of entries) {
        const predicted = item.cells.reduce((sum, [index, weight]) => sum + weight * binary[index], 0), error = (predicted - item.value) ** 2;
        squared += error;
        const tx = min(3, max(0, floor((item.x - originX) / (dimension * pitchX) * 4))), ty = min(3, max(0, floor((item.y - originY) / (dimension * pitchY) * 4)));
        tiles[ty * 4 + tx][0] += error; tiles[ty * 4 + tx][1]++;
      }
      const residual = sqrt(squared / entries.length), worst = max(...tiles.filter(tile => tile[1]).map(tile => sqrt(tile[0] / tile[1])));
      if (residual > .14 || worst > .23) continue;
      const side = (dimension + 8) * 4, data = new Uint8ClampedArray(side * side * 4).fill(255);
      for (let y = 0; y < dimension; y++) for (let x = 0; x < dimension; x++) {
        const value = binary[y * dimension + x] ? 0 : 255;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
          const p = (((y + 4) * 4 + dy) * side + (x + 4) * 4 + dx) * 4; data[p] = data[p + 1] = data[p + 2] = value;
        }
      }
      candidates.push({ image: { width: side, height: side, data }, threshold, residual,
        mapPoint: p => ({ x: input.x + originX + (p.x / 4 - 4) * pitchX, y: input.y + originY + (p.y / 4 - 4) * pitchY }) });
    }
    return { candidates, dimension, parameters, residual: sqrt(best) };
  }
  const identity = result => JSON.stringify([result.format, result.text, Array.from(result.bytes || [])]);
  function bounds(position) {
    const points = Object.values(position || {});
    if (points.length !== 4 || points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    return { left: min(...points.map(p => p.x)), top: min(...points.map(p => p.y)), right: max(...points.map(p => p.x)), bottom: max(...points.map(p => p.y)) };
  }
  function matches(result, region) {
    const b = bounds(result.position), r = region.content;
    if (!b || !r) return false;
    const slack = region.moduleSize * 3;
    return abs(b.left - r.x) <= slack && abs(b.top - r.y) <= slack &&
      abs(b.right - r.x - r.width) <= slack && abs(b.bottom - r.y - r.height) <= slack;
  }
  async function recover(image, { readNative, timeBudgetMs = 250, mode = 'image' } = {}) {
    const begun = clock(), results = [], seen = new Set(); let passes = 0, complete = true, strategy = 'qr-source-motion';
    if (typeof readNative !== 'function' || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || !geometry) return { results, complete: false, observed: 0, passes, strategy };
    const budget = min(mode === 'live' ? 160 : 500, timeBudgetMs), input = source(image);
    const expired = () => clock() - begun >= budget;
    if (!input) return { results, complete: true, observed: 0, passes, strategy };
    const remember = result => {
      const key = identity(result), b = bounds(result.position);
      if (!b || b.left < 0 || b.top < 0 || b.right > image.width || b.bottom > image.height) return;
      seen.add(key);
      if (!results.some(existing => identity(existing) === key && abs(bounds(existing.position).left - b.left) < 4 && abs(bounds(existing.position).top - b.top) < 4)) results.push(result);
    };
    if (input.width <= 128 && input.height <= 128 && !expired()) {
      const enlarged = enlarge(input), located = geometry.analyze(enlarged, { maxScanDimension: 1024, maxRegions: 4, timeBudgetMs: min(60, max(1, budget - (clock() - begun))) });
      if (!located.complete) complete = false;
      for (const region of located.regions) {
        const fitted = optical(input, region, expired); if (!fitted) continue;
        const observations = new Map();
        for (const candidate of fitted.candidates) {
          if (expired()) { complete = false; break; }
          const native = await readNative(candidate.image, { formats: ['QRCode'], isPure: true, binarizer: 'FixedThreshold', returnErrors: false }); passes++;
          for (const result of native.filter(result => result?.isValid === true && !result.error && ['QRCode', 'QRCodeModel1', 'QRCodeModel2'].includes(result.format) && result.position)) {
            const b = bounds(result.position), side = fitted.dimension * 4;
            if (!b || abs(b.left - 16) > 8 || abs(b.top - 16) > 8 || abs(b.right - 16 - side) > 8 || abs(b.bottom - 16 - side) > 8) continue;
            const key = identity(result), entry = observations.get(key) || { count: 0, result: { ...result, position: Object.fromEntries(Object.entries(result.position).map(([key, p]) => [key, candidate.mapPoint(p)])) } };
            entry.count++; observations.set(key, entry);
          }
        }
        if (observations.size > 1) for (const entry of observations.values()) remember(entry.result);
        else for (const entry of observations.values()) {
          remember(entry.result);
          if (entry.count >= 2) strategy = 'qr-optical-grid';
          // A single threshold hit is source evidence, but not sufficient for
          // unique acceptance. Keep it visible to deadline/conflict handling.
          else complete = false;
        }
      }
      if (results.length && located.regions.some(region => region.gridReliable && !region.clipped && !results.some(result => {
        const local = { position: Object.fromEntries(Object.entries(result.position).map(([key, p]) =>
          [key, { x: (p.x - input.x) * 4, y: (p.y - input.y) * 4 }])) };
        return matches(local, region);
      }))) complete = false;
    }
    const proposals = [];
    for (const vertical of [false, true]) for (const length of [3, 5, 7, 9, 11, 13, 15]) for (const clamped of [false, true]) proposals.push({ length, vertical, clamped });
    for (const proposal of proposals) {
      if (expired()) { complete = false; break; }
      const restored = restore(input, proposal.length, proposal.vertical, proposal.clamped); if (!restored) continue;
      const found = await readNative(restored, { formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: false,
        tryDownscale: false, returnErrors: false, isPure: false });
      passes++;
      const valid = found.filter(result => result?.isValid === true && !result?.error &&
        ['QRCode', 'QRCodeModel1', 'QRCodeModel2'].includes(result.format) && result.position);
      if (!valid.length) continue;
      const located = geometry.analyze(restored, { maxScanDimension: 2048, maxRegions: 4, timeBudgetMs: min(60, max(1, budget - (clock() - begun))) });
      if (!located.complete) { complete = false; break; }
      const proved = located.regions.map(region => ({ region, fit: forwardFit(input, restored, region, proposal.length, proposal.vertical) }));
      const accepted = valid.filter(result => proved.some(item => item.fit && matches(result, item.region)));
      // A second credible finder triplet cannot disappear merely because its
      // data fails the forward fit or native correction while a neighbor reads.
      if (accepted.length && proved.some(item => item.region.gridReliable && !item.region.clipped && !accepted.some(result => matches(result, item.region)))) complete = false;
      for (const result of accepted) {
        const mapped = { ...result, position: Object.fromEntries(Object.entries(result.position).map(([key, p]) => [key, { x: p.x + input.x, y: p.y + input.y }])) };
        remember(mapped);
      }
    }
    if (expired()) complete = false;
    return { results: complete || seen.size > 1 ? results : [], complete, observed: results.length, passes, strategy,
      diagnostics: { incompleteEvidence: !complete && seen.size === 1 } };
  }
  return { source, restore, forwardFit, enlarge, optical, recover };
});
