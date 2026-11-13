/* Bounded camera heuristics. Regions and quality scores are search hints, never barcode evidence. */
(function (root) {
  'use strict';
  const MAX_PIXELS = 4_000_000;
  const MAX_SIDE = 384;
  // Cache intrinsics: repeated global lookups are costly in worker/VM realms.
  const { min, max, floor, ceil, round, sqrt, hypot, abs, imul } = Math;
  const clamp = (value, low, high) => max(low, min(high, value));

  function pixelsFor(image) {
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
        image.width < 1 || image.height < 1 || image.width * image.height > MAX_PIXELS) {
      throw new Error('Invalid analysis image dimensions.');
    }
    const data = image.data instanceof ArrayBuffer ? new Uint8Array(image.data) : image.data;
    if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
        data.byteLength !== image.width * image.height * 4) throw new Error('Invalid analysis pixel buffer.');
    return data;
  }

  function luminance(data, index) {
    const value = (77 * data[index] + 150 * data[index + 1] + 29 * data[index + 2]) / 256;
    return 255 + (value - 255) * data[index + 3] / 255;
  }

  function fingerprint(data, width, height) {
    // Two non-cryptographic checksums over ALL original RGBA pixels and dimensions.
    // Collisions can discard evidence; this is not proof of a new physical exposure.
    let a = (0x811c9dc5 ^ width) >>> 0, b = (0x9e3779b9 ^ height) >>> 0;
    const words = data.byteOffset % 4 === 0 ? new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4) : null;
    for (let p = 0; p < data.length / 4; p++) {
      const i = p * 4;
      const word = words ? words[p] : data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24;
      a = imul(a ^ word, 0x01000193) >>> 0;
      b = imul(b ^ word ^ p, 0x85ebca6b) >>> 0;
    }
    return `${width}x${height}:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
  }

  function thumbnail(data, width, height) {
    const scale = min(1, MAX_SIDE / max(width, height), sqrt(110592 / (width * height)));
    const w = max(1, floor(width * scale)), h = max(1, floor(height * scale));
    const gray = new Uint8Array(w * h);
    const firstX = new Uint32Array(w), secondX = new Uint32Array(w);
    for (let x = 0; x < w; x++) {
      firstX[x] = min(width - 1, floor((x + 0.25) * width / w));
      secondX[x] = min(width - 1, floor((x + 0.75) * width / w));
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (scale === 1) gray[y * w + x] = round(luminance(data, (y * width + x) * 4));
      else {
        // A four-sample area estimate reduces aliasing compared with point sampling.
        const row0 = min(height - 1, floor((y + 0.25) * height / h)) * width;
        const row1 = min(height - 1, floor((y + 0.75) * height / h)) * width;
        gray[y * w + x] = round((luminance(data, (row0 + firstX[x]) * 4) + luminance(data, (row0 + secondX[x]) * 4) +
          luminance(data, (row1 + firstX[x]) * 4) + luminance(data, (row1 + secondX[x]) * 4)) / 4);
      }
    }
    return { gray, width: w, height: h };
  }

  function locate(gray, width, height, sourceWidth, sourceHeight) {
    if (width < 16 || height < 16) return [];
    const tile = 8, cols = ceil(width / tile), rows = ceil(height / tile), n = cols * rows;
    const xx = new Float64Array(n), yy = new Float64Array(n), xy = new Float64Array(n);
    const count = new Uint16Array(n), edges = new Uint16Array(n);
    let total = 0;
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const p = y * width + x, cell = floor(y / tile) * cols + floor(x / tile);
      const gx = gray[p + 1] - gray[p - 1], gy = gray[p + width] - gray[p - width];
      xx[cell] += gx * gx; yy[cell] += gy * gy; xy[cell] += gx * gy; count[cell]++;
      if (abs(gx) + abs(gy) > 30) edges[cell]++;
    }
    for (let i = 0; i < n; i++) total += (xx[i] + yy[i]) / max(1, count[i]);
    const threshold = max(110, total / n * 0.24);
    const active = (i) => edges[i] >= max(3, count[i] * 0.07) && (xx[i] + yy[i]) / max(1, count[i]) >= threshold;
    const seen = new Uint8Array(n), candidates = [];
    for (let seed = 0; seed < n; seed++) {
      if (seen[seed] || !active(seed)) continue;
      const stack = [seed]; seen[seed] = 1;
      let size = 0, left = cols, right = 0, top = rows, bottom = 0, sx = 0, sy = 0, sxy = 0;
      while (stack.length) {
        const i = stack.pop(), x = i % cols, y = floor(i / cols);
        size++; left = min(left, x); right = max(right, x); top = min(top, y); bottom = max(bottom, y);
        sx += xx[i]; sy += yy[i]; sxy += xy[i];
        // One empty tile may separate wide bars or finder patterns. Connect spatially;
        // direction coherence below distinguishes linear from matrix-like proposals.
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const next = ny * cols + nx;
          if (!seen[next] && active(next)) { seen[next] = 1; stack.push(next); }
        }
      }
      if (size < 5) continue;
      const x0 = left * tile, y0 = top * tile;
      const x1 = min(width, (right + 1) * tile), y1 = min(height, (bottom + 1) * tile);
      const w = x1 - x0, h = y1 - y0, occupancy = size / ((right - left + 1) * (bottom - top + 1));
      if (min(w, h) < 12 || occupancy < 0.16) continue;
      const coherence = hypot(sx - sy, 2 * sxy) / max(1, sx + sy);
      const kind = coherence > 0.55 ? 'linear' : 'matrix';
      if (kind === 'matrix' && max(w / h, h / w) > 4) continue;
      const horizontalReading = sx >= sy;
      const marginX = max(12, w * (kind === 'linear' && !horizontalReading ? 0.10 : 0.18));
      const marginY = max(12, h * (kind === 'linear' && horizontalReading ? 0.10 : 0.18));
      const startX = max(0, floor((x0 - marginX) * sourceWidth / width));
      const startY = max(0, floor((y0 - marginY) * sourceHeight / height));
      const endX = min(sourceWidth, ceil((x1 + marginX) * sourceWidth / width));
      const endY = min(sourceHeight, ceil((y1 + marginY) * sourceHeight / height));
      const cropWidth = endX - startX, cropHeight = endY - startY;
      // Whole-scene texture is not useful as a crop; the normal decoder still sees it.
      if (cropWidth * cropHeight > sourceWidth * sourceHeight * 0.90) continue;
      const clipped = kind === 'linear' ? (horizontalReading ? x0 < 4 || x1 > width - 4 : y0 < 4 || y1 > height - 4) :
        x0 < 4 || y0 < 4 || x1 > width - 4 || y1 > height - 4;
      candidates.push({ x: startX, y: startY, width: cropWidth, height: cropHeight,
        score: size * sqrt(occupancy) * (kind === 'linear' ? 1 + coherence : 1), kind,
        content: { x: x0 * sourceWidth / width, y: y0 * sourceHeight / height,
          width: w * sourceWidth / width, height: h * sourceHeight / height }, clipped });
    }
    candidates.sort((a, b) => b.score - a.score);
    const selected = [];
    for (const candidate of candidates) {
      if (selected.some((other) => {
        const intersection = max(0, min(candidate.x + candidate.width, other.x + other.width) - max(candidate.x, other.x)) *
          max(0, min(candidate.y + candidate.height, other.y + other.height) - max(candidate.y, other.y));
        return intersection / min(candidate.width * candidate.height, other.width * other.height) > 0.65;
      })) continue;
      selected.push(candidate);
      if (selected.length === 3) break;
    }
    return selected;
  }

  function quality(data, width, height, region) {
    const left = max(1, floor(region.x)), top = max(1, floor(region.y));
    const right = min(width - 2, ceil(region.x + region.width) - 1);
    const bottom = min(height - 2, ceil(region.y + region.height) - 1);
    const step = max(1, ceil(sqrt(max(1, region.width * region.height) / 20000)));
    let count = 0, sum = 0, squares = 0, edge = 0, detail = 0, dark = 0, centerCount = 0, centerWhite = 0, outerDark = 0, outerCount = 0;
    for (let y = top; y <= bottom; y += step) for (let x = left; x <= right; x += step) {
      const p = (y * width + x) * 4, value = luminance(data, p);
      const l = luminance(data, p - 4), r = luminance(data, p + 4);
      const u = luminance(data, p - width * 4), d = luminance(data, p + width * 4);
      count++; sum += value; squares += value * value;
      edge += abs(r - l) + abs(d - u);
      detail += abs(4 * value - l - r - u - d);
      if (value < 80) dark++;
      const cx = (x - region.x) / region.width, cy = (y - region.y) / region.height;
      if (cx > 0.375 && cx < 0.625 && cy > 0.375 && cy < 0.625) {
        centerCount++; if (value >= 252) centerWhite++;
      } else { outerCount++; if (value < 80) outerDark++; }
    }
    const mean = sum / max(1, count), contrast = sqrt(max(0, squares / max(1, count) - mean * mean));
    const edgeMean = edge / max(1, count), detailMean = detail / max(1, count);
    const score = 40 * clamp(contrast / 100, 0, 1) + 20 * clamp(edgeMean / 100, 0, 1) + 40 * clamp(detailMean / 90, 0, 1);
    return { score, mean, contrast, detailMean, darkFraction: dark / max(1, count),
      centralHighlight: centerCount >= 20 && centerWhite / centerCount > 0.985 && outerDark / max(1, outerCount) > 0.20 };
  }

  function analyze(image) {
    const data = pixelsFor(image), { width, height } = image;
    const small = thumbnail(data, width, height);
    const proposals = locate(small.gray, small.width, small.height, width, height);
    const region = proposals[0];
    const stats = quality(data, width, height, region?.content || { x: 0, y: 0, width, height });
    let hint = null;
    if (stats.mean < 45 && stats.darkFraction > 0.85) hint = 'dark';
    else if (region?.clipped) hint = 'clipped';
    else if (region && stats.centralHighlight) hint = 'glare';
    else if (region && (region.kind === 'linear' ? max(region.content.width, region.content.height) < 160 : min(region.content.width, region.content.height) < 85)) hint = 'small';
    else if (stats.contrast < 7 || stats.detailMean < 2) hint = 'low-detail';
    return {
      score: round(stats.score * (region ? 1 : 0.7) * 100) / 100,
      hint,
      regions: proposals.map(({ x, y, width: w, height: h, score, kind }) => ({ x, y, width: w, height: h, score, kind })),
      fingerprint: fingerprint(data, width, height),
    };
  }

  function crop(image, region, maxPixels = MAX_PIXELS) {
    const data = pixelsFor(image);
    if (!region || !['x', 'y', 'width', 'height'].every((name) => Number.isFinite(region[name])) ||
        region.width <= 0 || region.height <= 0 || region.x < 0 || region.y < 0 ||
        region.x + region.width > image.width || region.y + region.height > image.height ||
        !Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > MAX_PIXELS) throw new Error('Invalid barcode crop.');
    const left = floor(region.x), top = floor(region.y);
    const right = min(image.width, ceil(region.x + region.width)), bottom = min(image.height, ceil(region.y + region.height));
    const naturalWidth = right - left, naturalHeight = bottom - top;
    const scale = min(1, sqrt(maxPixels / (naturalWidth * naturalHeight)));
    const width = max(1, min(maxPixels, floor(naturalWidth * scale)));
    const height = max(1, min(floor(naturalHeight * scale), floor(maxPixels / width)));
    const output = new Uint8ClampedArray(width * height * 4);
    if (width === naturalWidth && height === naturalHeight) {
      for (let y = 0; y < height; y++) output.set(data.subarray(((top + y) * image.width + left) * 4,
        ((top + y) * image.width + right) * 4), y * width * 4);
    } else {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const sx = left + min(naturalWidth - 1, floor((x + 0.5) * naturalWidth / width));
        const sy = top + min(naturalHeight - 1, floor((y + 0.5) * naturalHeight / height));
        const source = (sy * image.width + sx) * 4, target = (y * width + x) * 4;
        output.set(data.subarray(source, source + 4), target);
      }
    }
    return { image: { width, height, data: output.buffer },
      mapPoint: ({ x, y }) => ({ x: clamp(left + (x + 0.5) * naturalWidth / width - 0.5, left, right),
        y: clamp(top + (y + 0.5) * naturalHeight / height - 0.5, top, bottom) }) };
  }

  const api = { analyze, crop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrameAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
