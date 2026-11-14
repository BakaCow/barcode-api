/* Finder geometry from observed pixels. Proposals are hints, never decoded values. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QRGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const { abs, ceil, floor, min, max, round, hypot } = Math;
  const now = () => typeof performance === 'object' ? performance.now() : Date.now();
  function analyze(image, options = {}) {
    const started = now(), width = image?.width, height = image?.height;
    const source = image?.data instanceof ArrayBuffer ? new Uint8ClampedArray(image.data) : image?.data;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 7 || height < 7 || width * height > 4_000_000 || !source || source.length !== width * height * 4) return { regions: [], complete: true, elapsedMs: now() - started };
    const bounded = (value, fallback, low, high) => Number.isFinite(value) ? min(high, max(low, value)) : fallback;
    const maxSide = bounded(options.maxScanDimension, 1600, 128, 2048);
    const limit = floor(bounded(options.maxRegions, 4, 1, 8));
    const budget = bounded(options.timeBudgetMs, 40, 0, 120);
    if (!budget) return { regions: [], complete: false, elapsedMs: now() - started };
    const scale = max(1, max(width, height) / maxSide), w = ceil(width / scale), h = ceil(height / scale);
    const gray = new Uint8Array(w * h);
    let low = 255, high = 0;
    for (let y = 0; y < h; y++) {
      const sy = min(height - 1, floor((y + 0.5) * scale));
      for (let x = 0; x < w; x++) {
        const p = (sy * width + min(width - 1, floor((x + 0.5) * scale))) * 4;
        const a = source[p + 3] / 255, v = round(((306 * source[p] + 601 * source[p + 1] + 117 * source[p + 2]) / 1024) * a + 255 * (1 - a));
        gray[y * w + x] = v; low = min(low, v); high = max(high, v);
      }
      if ((y & 31) === 31 && now() - started > budget) return { regions: [], complete: false, elapsedMs: now() - started };
    }
    if (high - low < 12) return { regions: [], complete: true, elapsedMs: now() - started };
    const threshold = (low + high) / 2, dark = (x, y) => gray[y * w + x] < threshold;
    const ratio = runs => {
      const total = runs.reduce((a, b) => a + b, 0), unit = total / 7;
      return total >= 7 && runs.every((n, i) => abs(n - (i === 2 ? 3 : 1) * unit) <= (i === 2 ? 1.35 : 0.8) * unit) ? unit : 0;
    };
    function cross(cx, cy, dx, dy, expected) {
      cx = round(cx); cy = round(cy);
      if (cx < 0 || cy < 0 || cx >= w || cy >= h || !dark(cx, cy)) return null;
      const runs = [0, 0, 1, 0, 0], cap = ceil(expected * 5 + 3);
      for (const sign of [-1, 1]) {
        let step = 1, stage = 2;
        while (stage >= 0 && stage <= 4 && step <= cap) {
          const x = cx + sign * dx * step, y = cy + sign * dy * step;
          if (x < 0 || y < 0 || x >= w || y >= h) break;
          if (dark(x, y) === (stage % 2 === 0)) runs[stage]++;
          else { stage += sign; if (stage < 0 || stage > 4) break; runs[stage]++; }
          step++;
        }
      }
      const unit = ratio(runs);
      if (!unit || unit / expected < 0.55 || unit / expected > 1.8 || runs.some(n => !n)) return null;
      // Locate both ends of the central black run to remove scan-row bias.
      let before = 0, after = 0;
      while (before < cap && cx - dx * (before + 1) >= 0 && cy - dy * (before + 1) >= 0 && dark(cx - dx * (before + 1), cy - dy * (before + 1))) before++;
      while (after < cap && cx + dx * (after + 1) < w && cy + dy * (after + 1) < h && dark(cx + dx * (after + 1), cy + dy * (after + 1))) after++;
      return { x: cx + dx * (after - before) / 2, y: cy + dy * (after - before) / 2, module: unit };
    }
    const finders = [], rowStep = max(1, floor(h / 700));
    let complete = true;
    for (let y = 0; y < h; y += rowStep) {
      if ((floor(y / rowStep) & 15) === 0 && now() - started > budget) { complete = false; break; }
      const runs = [], colors = [];
      let previous = dark(0, y), length = 1;
      for (let x = 1; x <= w; x++) {
        const color = x < w ? dark(x, y) : !previous;
        if (color === previous) { length++; continue; }
        runs.push(length); colors.push(previous);
        if (runs.length > 5) { runs.shift(); colors.shift(); }
        if (runs.length === 5 && colors[0] && colors[2] && colors[4]) {
          const unit = ratio(runs);
          if (unit) {
            const cx = x - runs[4] - runs[3] - runs[2] / 2 - 0.5;
            const vertical = cross(cx, y, 0, 1, unit);
            const horizontal = vertical && cross(vertical.x, vertical.y, 1, 0, vertical.module);
            if (horizontal) {
              const candidate = { x: horizontal.x, y: vertical.y, module: (unit + vertical.module + horizontal.module) / 3, count: 1 };
              const match = finders.find(f => abs(f.module - candidate.module) < candidate.module * 0.7 && hypot(f.x - candidate.x, f.y - candidate.y) < candidate.module * 1.8);
              if (match) {
                const count = match.count + 1;
                match.x += (candidate.x - match.x) / count; match.y += (candidate.y - match.y) / count;
                match.module += (candidate.module - match.module) / count; match.count = count;
              } else if (finders.length < 96) finders.push(candidate);
              else complete = false;
            }
          }
        }
        previous = color; length = 1;
      }
    }
    const confirmed = finders.filter(f => f.count >= 2 || f.module < 1.5).sort((a, b) => b.count - a.count);
    if (confirmed.length > 24) complete = false;
    const candidates = confirmed.slice(0, 24);
    const regions = [];
    const sample = (x, y) => {
      const ix = round(x), iy = round(y);
      return ix >= 0 && iy >= 0 && ix < w && iy < h ? gray[iy * w + ix] < threshold : null;
    };
    function functionalScore(tl, tr, bl, dimension) {
      const ux = (tr.x - tl.x) / (dimension - 7), uy = (tr.y - tl.y) / (dimension - 7);
      const vx = (bl.x - tl.x) / (dimension - 7), vy = (bl.y - tl.y) / (dimension - 7);
      let correct = 0, total = 0;
      const check = (x, y, wanted) => { const value = sample(tl.x + (x - 3) * ux + (y - 3) * vx, tl.y + (x - 3) * uy + (y - 3) * vy); if (value !== null) { total++; if (value === wanted) correct++; } };
      for (const [ox, oy] of [[0, 0], [dimension - 7, 0], [0, dimension - 7]]) {
        const beforeCorrect = correct, beforeTotal = total;
        for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) check(ox + x, oy + y, x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
        if (total - beforeTotal < 49 || (correct - beforeCorrect) / 49 < 0.78) return 0;
      }
      for (let i = 8; i < dimension - 8; i++) { check(i, 6, i % 2 === 0); check(6, i, i % 2 === 0); }
      return total ? correct / total : 0;
    }
    function refineSmall(finders, dimension) {
      const points = finders.map(f => ({ ...f })), initial = finders.map(f => ({ ...f }));
      const pitch = (hypot(points[1].x - points[0].x, points[1].y - points[0].y) + hypot(points[2].x - points[0].x, points[2].y - points[0].y)) / (2 * (dimension - 7));
      if (pitch >= 2.25) return points;
      function score() {
        const [tl, tr, bl] = points; let total = 0;
        for (const [ox, oy] of [[0, 0], [dimension - 7, 0], [0, dimension - 7]]) for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
          const u = (ox + x - 3) / (dimension - 7), v = (oy + y - 3) / (dimension - 7);
          const sx = tl.x + u * (tr.x - tl.x) + v * (bl.x - tl.x), sy = tl.y + u * (tr.y - tl.y) + v * (bl.y - tl.y);
          if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) return -Infinity;
          const ix = floor(sx), iy = floor(sy), fx = sx - ix, fy = sy - iy;
          const value = (1 - fy) * ((1 - fx) * gray[iy * w + ix] + fx * gray[iy * w + ix + 1]) + fy * ((1 - fx) * gray[(iy + 1) * w + ix] + fx * gray[(iy + 1) * w + ix + 1]);
          const expected = x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
          total += expected ? 255 - value : value;
        }
        return total;
      }
      let best = score();
      for (const fraction of [0.3, 0.15, 0.06]) for (let index = 0; index < 3; index++) for (const axis of ['x', 'y']) {
        if (now() - started > budget) { complete = false; return points; }
        const previous = points[index][axis]; let chosen = previous;
        for (const sign of [-1, 1]) {
          const trial = previous + pitch * fraction * sign;
          if (abs(trial - initial[index][axis]) > pitch * 0.65) continue;
          points[index][axis] = trial;
          const value = score(); if (value > best) { best = value; chosen = trial; }
        }
        points[index][axis] = chosen;
      }
      return points;
    }
    outer: for (let a = 0; a < candidates.length; a++) for (let b = a + 1; b < candidates.length; b++) for (let c = b + 1; c < candidates.length; c++) {
      if (now() - started > budget) { complete = false; break outer; }
      const trio = [candidates[a], candidates[b], candidates[c]];
      for (let corner = 0; corner < 3; corner++) {
        let tl = trio[corner], tr = trio[(corner + 1) % 3], bl = trio[(corner + 2) % 3];
        let dx = tr.x - tl.x, dy = tr.y - tl.y, ex = bl.x - tl.x, ey = bl.y - tl.y;
        const u = hypot(dx, dy), v = hypot(ex, ey), module = (tl.module + tr.module + bl.module) / 3;
        if (u < module * 12 || v < module * 12 || u / v < 0.55 || u / v > 1.8 || abs((dx * ex + dy * ey) / (u * v)) > 0.28 || max(...trio.map(f => f.module)) / min(...trio.map(f => f.module)) > 1.8) continue;
        if (dx * ey - dy * ex < 0) { const tmp = tr; tr = bl; bl = tmp; }
        const estimate = (u + v) / (2 * module) + 7;
        let dimension = 0, quality = 0;
        const nearest = 21 + 4 * round((estimate - 21) / 4);
        for (const dim of [nearest, nearest - 4, nearest + 4]) {
          if (dim < 21 || dim > 177 || abs(dim - estimate) > 5) continue;
          const score = functionalScore(tl, tr, bl, dim);
          if (score > quality) { dimension = dim; quality = score; }
        }
        if (!dimension || quality < 0.78) continue;
        [tl, tr, bl] = refineSmall([tl, tr, bl], dimension);
        const map = (x, y) => ({ x: (tl.x + (x - 3.5) * (tr.x - tl.x) / (dimension - 7) + (y - 3.5) * (bl.x - tl.x) / (dimension - 7) + 0.5) * scale - 0.5,
          y: (tl.y + (x - 3.5) * (tr.y - tl.y) / (dimension - 7) + (y - 3.5) * (bl.y - tl.y) / (dimension - 7) + 0.5) * scale - 0.5 });
        const quad = { topLeft: map(0, 0), topRight: map(dimension, 0), bottomRight: map(dimension, dimension), bottomLeft: map(0, dimension) };
        const points = Object.values(quad), x0 = min(...points.map(p => p.x)), y0 = min(...points.map(p => p.y)), x1 = max(...points.map(p => p.x)), y1 = max(...points.map(p => p.y));
        const moduleSize = (u + v) * scale / (2 * (dimension - 7)), padding = moduleSize * 4;
        const x = max(0, floor(x0 - padding)), y = max(0, floor(y0 - padding));
        const region = { x, y, width: min(width, ceil(x1 + padding)) - x, height: min(height, ceil(y1 + padding)) - y,
          kind: 'matrix', qr: true, content: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, quad,
          finders: Object.fromEntries([['topLeft', tl], ['topRight', tr], ['bottomLeft', bl]].map(([key, f]) => [key, { x: (f.x + 0.5) * scale - 0.5, y: (f.y + 0.5) * scale - 0.5 }])),
          moduleSize, dimension, gridReliable: true, clipped: points.some(p => p.x < -0.5 || p.y < -0.5 || p.x > width - 0.5 || p.y > height - 0.5), score: quality };
        const duplicate = regions.find(r => r.dimension === dimension && r.moduleSize / moduleSize > 0.9 && r.moduleSize / moduleSize < 1.1 &&
          ['topLeft', 'topRight', 'bottomLeft'].every(key => hypot(r.finders[key].x - region.finders[key].x, r.finders[key].y - region.finders[key].y) < moduleSize * 2));
        if (!duplicate) regions.push(region);
        else if (region.score > duplicate.score) Object.assign(duplicate, region);
      }
    }
    regions.sort((a, b) => b.score - a.score);
    if (regions.length > limit) complete = false;
    return { regions: regions.slice(0, limit), complete, elapsedMs: now() - started, finderCount: candidates.length };
  }
  return { analyze };
});
