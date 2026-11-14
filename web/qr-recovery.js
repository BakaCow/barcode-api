/* Bounded QR candidates derived only from the supplied source pixels. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QRRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const { floor, ceil, min, max } = Math;
  function pixels(image) { return image.data instanceof ArrayBuffer ? new Uint8ClampedArray(image.data) : image.data; }
  function grayAt(data, width, x, y) {
    const p = (y * width + x) * 4, alpha = data[p + 3] / 255;
    return ((306 * data[p] + 601 * data[p + 1] + 117 * data[p + 2]) / 1024) * alpha + 255 * (1 - alpha);
  }
  function crop(image, region) {
    const x = max(0, floor(region.x)), y = max(0, floor(region.y));
    const width = min(image.width, ceil(region.x + region.width)) - x, height = min(image.height, ceil(region.y + region.height)) - y;
    if (width < 1 || height < 1 || width * height > 1_000_000) return null;
    const source = pixels(image), data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) data.set(source.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + width) * 4), row * width * 4);
    return { image: { data, width, height }, mapPoint: p => ({ x: p.x + x, y: p.y + y }), strategy: 'qr-finder-crop' };
  }
  function mapFor(region) {
    const q = region.quad, d = region.dimension;
    return (x, y) => ({ x: q.topLeft.x + x * (q.topRight.x - q.topLeft.x) / d + y * (q.bottomLeft.x - q.topLeft.x) / d,
      y: q.topLeft.y + x * (q.topRight.y - q.topLeft.y) / d + y * (q.bottomLeft.y - q.topLeft.y) / d });
  }
  function grid(image, region, phaseX = 0, phaseY = 0, robust = false, thresholdOffset = 0, deblur = 0) {
    if (!region.gridReliable || region.clipped || !region.quad || !Number.isInteger(region.dimension) || region.dimension < 21 || region.dimension > 177) return null;
    const source = pixels(image), map = mapFor(region), dimension = region.dimension;
    const inside = p => p.x >= 0 && p.y >= 0 && p.x <= image.width - 1 && p.y <= image.height - 1;
    // Keep only margin that was actually photographed. Missing outside pixels
    // are never replaced by an invented white quiet zone.
    let border = 4;
    for (; border >= 0; border--) {
      if ([-border + 0.15, dimension + border - 0.15].every(x => [-border + 0.15, dimension + border - 0.15].every(y => inside(map(x + phaseX, y + phaseY))))) break;
    }
    if (border < 0) return null;
    const size = dimension + border * 2, values = new Float32Array(size * size);
    let low = 255, high = 0;
    function sample(x, y) {
      const p = map(x, y);
      if (!inside(p)) return null;
      const x0 = floor(p.x), y0 = floor(p.y), x1 = min(image.width - 1, x0 + 1), y1 = min(image.height - 1, y0 + 1), fx = p.x - x0, fy = p.y - y0;
      return (1 - fy) * ((1 - fx) * grayAt(source, image.width, x0, y0) + fx * grayAt(source, image.width, x1, y0)) + fy * ((1 - fx) * grayAt(source, image.width, x0, y1) + fx * grayAt(source, image.width, x1, y1));
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x - border + 0.5 + phaseX, v = y - border + 0.5 + phaseY;
      let value = sample(u, v);
      if (value === null) return null;
      if (robust) {
        const samples = [value, sample(u - 0.24, v - 0.24), sample(u + 0.24, v - 0.24), sample(u - 0.24, v + 0.24), sample(u + 0.24, v + 0.24)];
        if (samples.some(n => n === null)) return null;
        samples.sort((a, b) => a - b); value = samples[2];
      }
      values[y * size + x] = value; low = min(low, value); high = max(high, value);
    }
    if (high - low < 12) return null;
    if (deblur) {
      // A small inverse filter on measured module centers, with no replacement
      // of unavailable samples. Clamping limits ringing around strong edges.
      const original = values.slice(), a = deblur;
      for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        values[i] = min(high, max(low, original[i] * (1 + 4 * a) - a * (original[i - 1] + original[i + 1] + original[i - size] + original[i + size])));
      }
    }
    const scale = 4, width = size * scale, data = new Uint8ClampedArray(width * width * 4);
    const threshold = (low + high) / 2 + thresholdOffset * (high - low);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const cx = floor(x / scale), cy = floor(y / scale);
      const p = (y * width + x) * 4, value = values[cy * size + cx] < threshold ? 0 : 255;
      data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
    }
    return { image: { data, width, height: width }, mapPoint: p => map(p.x / scale - border + phaseX, p.y / scale - border + phaseY),
      strategy: deblur ? 'qr-grid-deblur' : robust ? 'qr-module-median' : 'qr-grid-sample', options: { binarizer: 'FixedThreshold', isPure: true } };
  }
  function filtered(image, region, kind) {
    const candidate = crop(image, region);
    if (!candidate || region.clipped || !(region.moduleSize >= 1.5)) return null;
    const { width, height, data } = candidate.image, values = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = grayAt(data, width, x, y);
    const output = new Uint8Array(values.length);
    {
      // Close only narrow bright scratches. Kernel length is tied to observed
      // module pitch, capped below two modules; never arbitrary large repair.
      const radius = min(3, floor(region.moduleSize * 0.48));
      if (radius < 1) return null;
      const temp = new Uint8Array(values.length), vertical = kind === 'vertical';
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let value = 255;
        for (let k = -radius; k <= radius; k++) value = min(value, values[min(height - 1, max(0, y + (vertical ? k : 0))) * width + min(width - 1, max(0, x + (vertical ? 0 : k)))]);
        temp[y * width + x] = value;
      }
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        let value = 0;
        for (let k = -radius; k <= radius; k++) value = max(value, temp[min(height - 1, max(0, y + (vertical ? k : 0))) * width + min(width - 1, max(0, x + (vertical ? 0 : k)))]);
        output[y * width + x] = value;
      }
    }
    for (let i = 0; i < output.length; i++) data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = output[i];
    return { ...candidate, strategy: `qr-scratch-${kind}` };
  }
  function* candidates(image, region, { mode = 'image', retryIndex = 0 } = {}) {
    const original = crop(image, region);
    if (original) yield original;
    if (!region.gridReliable || region.clipped) return;
    const attempts = [() => grid(image, region, 0, 0, false, 0, 0.9),
      () => grid(image, region), () => grid(image, region, 0, 0, true),
      () => grid(image, region, 0, 0, false, 0, 0.4),
      () => grid(image, region, 0, 0, false, 0, 1.5),
      () => grid(image, region, -0.16, -0.16), () => grid(image, region, 0.16, 0.16),
      () => grid(image, region, -0.16, 0.16), () => grid(image, region, 0.16, -0.16),
      () => grid(image, region, 0, 0, false, -0.08), () => grid(image, region, 0, 0, false, 0.08),
      () => filtered(image, region, 'vertical'), () => filtered(image, region, 'horizontal')];
    for (const make of mode === 'live' ? [attempts[retryIndex % attempts.length]] : attempts) {
      const candidate = make(); if (candidate) yield candidate;
    }
  }
  return { crop, grid, filtered, candidates };
});
