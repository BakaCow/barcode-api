/* Bounded recovery from three disjoint, genuinely different camera exposures.
 * Only observed source pixels are used. Registration supports small translations;
 * rotation, scale changes, ambiguous scenes and permanent holes are not repaired.
 * A returned burst is ONE observation, never three confirmation votes.
 */
(function (root) {
  'use strict';
  const MAX_SIDE = 640, MAX_AGE = 1100, MAX_SEEN = 256, SHIFT = 6;
  const { abs, ceil, floor, max, min, round } = Math;
  const clock = () => performance.now();

  function hash(gray) {
    let value = 2166136261;
    for (const pixel of gray) value = Math.imul(value ^ pixel, 16777619);
    return (value >>> 0).toString(16);
  }
  function validRegion(analysis, width, height) {
    if (!analysis || analysis.regionsComplete !== true || analysis.qr?.complete === false ||
        analysis.qr?.count > 1 || analysis.qr?.clipped === true || analysis.hint === 'clipped' || analysis.regions?.length !== 1) return null;
    const region = analysis.regions[0];
    if (!['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key])) ||
        region.x < 0 || region.y < 0 || region.width < 24 || region.height < 24 ||
        region.x + region.width > width || region.y + region.height > height) return null;
    return region;
  }
  function boxFor(region, width, height) {
    const padding = max(12, ceil(min(region.width, region.height) * .15));
    const x = max(0, floor(region.x - padding)), y = max(0, floor(region.y - padding));
    const right = min(width, ceil(region.x + region.width + padding));
    const bottom = min(height, ceil(region.y + region.height + padding));
    if (right - x > MAX_SIDE || bottom - y > MAX_SIDE) return null;
    return { x, y, width: right - x, height: bottom - y };
  }
  function sameGeometry(a, b) {
    return abs(a.width - b.width) <= max(3, a.width * .025) &&
      abs(a.height - b.height) <= max(3, a.height * .025) &&
      abs(a.x - b.x) <= SHIFT && abs(a.y - b.y) <= SHIFT;
  }
  function damageMask(gray, width, height, pitch) {
    const mask = new Uint8Array(gray.length), stride = width + 1;
    const integral = new Uint32Array(stride * (height + 1));
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        const value = gray[y * width + x]; row += value >= 235 ? 1 : 0;
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
        if (value < 128) { left = min(left, x); top = min(top, y); right = max(right, x + 1); bottom = max(bottom, y + 1); }
      }
    }
    const radius = max(3, ceil(pitch * 2.5)), side = radius * 2 + 1;
    if (side > min(right - left, bottom - top)) return mask;
    const difference = new Int32Array(integral.length);
    // Identify oversized flat bright areas in EACH original exposure before
    // looking at inter-frame differences. Five modules across exceeds normal
    // linear spaces and ordinary QR cell texture. The quiet border is excluded.
    for (let y = top; y + side <= bottom; y++) for (let x = left; x + side <= right; x++) {
      const a = y * stride + x, b = a + side, c = (y + side) * stride + x, d = c + side;
      if (integral[d] - integral[b] - integral[c] + integral[a] !== side * side) continue;
      difference[a]++; difference[b]--; difference[c]--; difference[d]++;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = y * stride + x;
      if (x) difference[p] += difference[p - 1];
      if (y) difference[p] += difference[p - stride];
      if (x && y) difference[p] -= difference[p - stride - 1];
      mask[y * width + x] = difference[p] > 0 ? 1 : 0;
    }
    return mask;
  }
  function measuredPitch(gray, width, height, region, qr) {
    if (qr?.gridReliable === true && Number.isFinite(qr.moduleSize) && qr.moduleSize >= 1.5 && qr.moduleSize <= 12) return qr.moduleSize;
    if (region.kind !== 'linear') return null;
    const runs = [];
    for (let j = 1; j <= 7; j++) {
      const y = floor(height * j / 8); let start = 0, dark = gray[y * width] < 128;
      for (let x = 1; x < width; x++) {
        const next = gray[y * width + x] < 128;
        if (next !== dark) { if (start > 0) runs.push(x - start); start = x; dark = next; }
      }
    }
    if (runs.length < 40) return null;
    runs.sort((a, b) => a - b);
    const pitch = runs[floor(runs.length * .2)];
    return pitch >= 2 && pitch <= 12 ? pitch : null;
  }

  function register(reference, sample, deadline = Infinity) {
    const { width, height } = reference.box, first = reference.gray, second = sample.gray;
    const left = max(SHIFT + 1, floor(reference.region.x - reference.box.x));
    const top = max(SHIFT + 1, floor(reference.region.y - reference.box.y));
    const right = min(width - SHIFT - 1, ceil(left + reference.region.width));
    const bottom = min(height - SHIFT - 1, ceil(top + reference.region.height));
    const step = max(1, floor(Math.sqrt((right - left) * (bottom - top) / 1800)));
    const points = [];
    for (let y = top; y < bottom; y += step) for (let x = left; x < right; x += step) {
      const p = y * width + x;
      if (abs(first[p + 1] - first[p - 1]) + abs(first[p + width] - first[p - width]) >= 50) points.push([x, y, first[p]]);
    }
    if (points.length < 70) return null;
    let best = null;
    for (let dy = -SHIFT; dy <= SHIFT; dy++) for (let dx = -SHIFT; dx <= SHIFT; dx++) {
      if (clock() >= deadline) return null;
      let sum = 0, count = 0;
      for (const [x, y, value] of points) {
        const target = (y + dy) * width + x + dx;
        if (reference.damage[y * width + x] || sample.damage[target]) continue;
        sum += abs(value - second[target]); count++;
      }
      if (count < max(70, points.length * .55)) continue;
      const score = sum / count;
      if (!best || score < best.score || (score === best.score && dx * dx + dy * dy < best.dx * best.dx + best.dy * best.dy)) best = { dx, dy, score };
    }
    if (!best || best.score > 8) return null;
    // A few compact changed areas can be occlusion/glare. Distributed changes
    // are more consistent with a different label, scale/rotation, or bad fit.
    const tiles = Array.from({ length: 64 }, () => [0, 0]);
    let changed = 0, unexplained = 0, total = 0;
    for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
      const error = abs(first[y * width + x] - second[(y + best.dy) * width + x + best.dx]);
      const index = min(7, floor((y - top) * 8 / (bottom - top))) * 8 + min(7, floor((x - left) * 8 / (right - left)));
      tiles[index][1]++; total++;
      if (error > 48) {
        changed++; tiles[index][0]++;
        if (!reference.damage[y * width + x] && !sample.damage[(y + best.dy) * width + x + best.dx]) unexplained++;
      }
    }
    const occupied = tiles.filter(([bad, count]) => count && bad / count > .12).length;
    if (changed / total > .28 || occupied > 25 || unexplained > 0) return null;
    return best;
  }

  function combine(frames, { timeBudgetMs = 80 } = {}) {
    if (!Array.isArray(frames) || frames.length !== 3 || !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0 || timeBudgetMs > 150) return null;
    const deadline = clock() + timeBudgetMs;
    const first = frames[0], offsets = [{ dx: 0, dy: 0 }];
    for (const frame of frames.slice(1)) {
      const offset = register(first, frame, deadline);
      if (!offset) return null;
      offsets.push(offset);
    }
    // Also validate the two later exposures against each other; matching only
    // the reference must not conceal a scene replacement behind a damaged area.
    const secondPair = register(frames[1], frames[2], deadline);
    if (!secondPair || abs(secondPair.dx - offsets[2].dx + offsets[1].dx) > 1 ||
        abs(secondPair.dy - offsets[2].dy + offsets[1].dy) > 1) return null;
    const { width, height } = first.box;
    const left = max(0, ...offsets.map(({ dx }) => -dx)), top = max(0, ...offsets.map(({ dy }) => -dy));
    const right = min(width, ...offsets.map(({ dx }) => width - dx));
    const bottom = min(height, ...offsets.map(({ dy }) => height - dy));
    const outputWidth = right - left, outputHeight = bottom - top;
    const data = new Uint8ClampedArray(outputWidth * outputHeight * 4);
    let uncertain = 0, improved = 0, count = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      if (x === left && y % 16 === 0 && clock() >= deadline) return null;
      const a = frames[0].gray[y * width + x], b = frames[1].gray[(y + offsets[1].dy) * width + x + offsets[1].dx];
      const c = frames[2].gray[(y + offsets[2].dy) * width + x + offsets[2].dx];
      const low = min(a, b, c), high = max(a, b, c), value = a + b + c - low - high;
      // The median itself is an observed sample. Require a second exposure to
      // support it; never fabricate a value between three conflicting samples.
      const maskA = frames[0].damage[y * width + x], maskB = frames[1].damage[(y + offsets[1].dy) * width + x + offsets[1].dx];
      const maskC = frames[2].damage[(y + offsets[2].dy) * width + x + offsets[2].dx];
      const agreeing = Number(!maskA && abs(value - a) <= 24) + Number(!maskB && abs(value - b) <= 24) + Number(!maskC && abs(value - c) <= 24);
      if (agreeing < 2 || min(value - low, high - value) > 24) uncertain++;
      if (maskA && abs(value - a) > 48) improved++;
      const p = ((y - top) * outputWidth + x - left) * 4;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255; count++;
    }
    if (clock() >= deadline || uncertain > 0 || improved < max(12, count * .001)) return null;
    const last = offsets[2];
    return { image: { width: outputWidth, height: outputHeight, data: data.buffer },
      region: { x: first.box.x + left + last.dx, y: first.box.y + top + last.dy, width: outputWidth, height: outputHeight },
      frameId: 'fusion:' + frames.map(frame => frame.frameId).join('|'),
      fingerprint: 'fusion:' + frames.map(frame => frame.fingerprint).sort().join('|'),
      cameraFingerprint: 'fusion:' + frames.map(frame => frame.cameraFingerprint || frame.fingerprint).sort().join('|'),
      capturedAt: frames[2].capturedAt, oldestCapturedAt: frames[0].capturedAt, sourceFrameIds: frames.map(frame => frame.frameId),
      evidenceCount: 1, strategy: 'three-exposure-observed-median' };
  }

  function create() {
    let frames = [], lastTime = null, blocked = false;
    const seenIds = new Set(), seenPixels = new Set(), seenCamera = new Set();
    let prepared = new WeakSet();
    return {
      reset() { frames = []; lastTime = null; blocked = false; prepared = new WeakSet(); seenIds.clear(); seenPixels.clear(); seenCamera.clear(); },
      discard() { frames = []; },
      capture(image, analysis, { frameId, capturedAt, cameraFingerprint } = {}) {
        if (blocked || typeof frameId !== 'string' || frameId.length > 35 || !/^(presented|decoded):\d+$/.test(frameId) ||
            cameraFingerprint !== undefined && (typeof cameraFingerprint !== 'string' || cameraFingerprint.length > 64) || !Number.isFinite(capturedAt) || capturedAt < 0 ||
            !Number.isInteger(image?.width) || !Number.isInteger(image?.height) || image.width * image.height > 4_000_000) return null;
        const region = validRegion(analysis, image.width, image.height);
        if (!region) { frames = []; return null; }
        if (frames.length && (capturedAt - frames[0].capturedAt > MAX_AGE ||
            frames[0].sourceWidth !== image.width || frames[0].sourceHeight !== image.height || !sameGeometry(frames[0].region, region))) frames = [];
        const box = frames[0]?.box || boxFor(region, image.width, image.height);
        if (!box) return null;
        const pixels = image.data instanceof ArrayBuffer ? new Uint8ClampedArray(image.data) : image.data;
        if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length !== image.width * image.height * 4) return null;
        const gray = new Uint8Array(box.width * box.height);
        for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
          const p = ((box.y + y) * image.width + box.x + x) * 4, alpha = pixels[p + 3] / 255;
          gray[y * box.width + x] = round((pixels[p] * .299 + pixels[p + 1] * .587 + pixels[p + 2] * .114) * alpha + 255 * (1 - alpha));
        }
        const pitch = measuredPitch(gray, box.width, box.height, region, analysis.qr);
        if (!pitch) { frames = []; return null; }
        const damage = damageMask(gray, box.width, box.height, pitch);
        const frame = { gray, damage, box: { ...box }, region: { ...region }, sourceWidth: image.width, sourceHeight: image.height,
          frameId, capturedAt, fingerprint: box.width + ':' + box.height + ':' + hash(gray), cameraFingerprint };
        prepared.add(frame); return frame;
      },
      push(frame, now) {
        if (!frame || !prepared.has(frame)) return null;
        prepared.delete(frame);
        if (blocked || !Number.isFinite(now) || now < frame.capturedAt || now - frame.capturedAt > MAX_AGE ||
            (lastTime !== null && frame.capturedAt <= lastTime)) { frames = []; return null; }
        lastTime = frame.capturedAt;
        if (seenIds.has(frame.frameId) || seenPixels.has(frame.fingerprint) ||
            frame.cameraFingerprint && seenCamera.has(frame.cameraFingerprint)) { frames = []; return null; }
        // Bound memory without silently forgetting consumed observations. A long
        // unsuccessful attempt needs an explicit reset/control change to retry.
        if (seenIds.size >= MAX_SEEN) { blocked = true; frames = []; return null; }
        seenIds.add(frame.frameId); seenPixels.add(frame.fingerprint);
        if (frame.cameraFingerprint) seenCamera.add(frame.cameraFingerprint);
        if (frames.length && (now - frames[0].capturedAt > MAX_AGE || frames[0].box.width !== frame.box.width || frames[0].box.height !== frame.box.height ||
            frames[0].box.x !== frame.box.x || frames[0].box.y !== frame.box.y || !sameGeometry(frames[0].region, frame.region))) frames = [];
        frames.push(frame);
        if (frames.length < 3) return null;
        const burst = frames; frames = []; // Consumed even when registration fails.
        return combine(burst);
      },
    };
  }
  const api = { create, register, combine, MAX_SIDE, MAX_AGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrameFusion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
