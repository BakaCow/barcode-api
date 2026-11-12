(function (root) {
  'use strict';
  const CONDITIONS = ['clean', 'blur', 'distant', 'angled', 'scratched', 'lowlight'];
  function label(input) {
    const negative = input.negative === true;
    const text = typeof input.text === 'string' ? input.text : '';
    if (!negative && (!text.length || text.length > 128 || /[^\x00-\x7f]/.test(text))) throw new Error('Enter the exact Code 128 value (1–128 ASCII characters), or mark a negative scene.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.groupId || '')) throw new Error('Enter a label/session group using letters, numbers, dashes or underscores.');
    if (!['train', 'dev', 'test'].includes(input.split)) throw new Error('Choose a dataset split.');
    const device = typeof input.device === 'string' ? input.device.trim() : '';
    if (!device || device.length > 256) throw new Error('Enter the phone or camera name.');
    const conditions = [...new Set(input.conditions || [])];
    if (!conditions.length || conditions.some((item) => !CONDITIONS.includes(item))) throw new Error('Choose at least one condition describing this scene.');
    return { expected: negative ? [] : [{ text, format: 'Code128' }], negative, groupId: input.groupId, split: input.split, conditions, device, source: 'real' };
  }
  function metadata(details, { id, path, mediaType, capturedAt, width, height, durationMs, mimeType, userAgent }) {
    if (!/^[A-Za-z0-9_-]+\.(png|webm|mp4)$/.test(path) || !['image', 'video'].includes(mediaType)) throw new Error('Invalid sample filename.');
    if ((mediaType === 'image') !== path.endsWith('.png')) throw new Error('Sample type and filename disagree.');
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1 || width * height > 4_000_000) throw new Error('Invalid sample dimensions.');
    if (mediaType === 'video' && (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 11000)) throw new Error('Invalid recording duration.');
    return { version: 1, id, path, mediaType, ...details, capturedAt, metadata: { width, height, ...(mediaType === 'video' ? { durationMs } : {}), mimeType, userAgent: String(userAgent || '').slice(0, 1024) } };
  }
  function captureSize(width, height) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new Error('Camera has not provided a frame yet.');
    const ratio = Math.min(1, 1920 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)));
    return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) };
  }
  function classify(results, expected) {
    const matches = (r, target) => r.format === target.format && r.text === target.text;
    const unexpected = results.filter((r) => !expected.some((e) => matches(r, e)));
    if (unexpected.length) return 'wrong';
    if (expected.every((e) => results.some((r) => matches(r, e)))) return 'exact';
    return 'miss';
  }
  function quantile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  }
  function isLabOfflineReady(status) {
    return status?.ready === true && Array.isArray(status.features) && status.features.includes('code128-lab');
  }
  function createTrial(expected, startMs) {
    const frames = new Set();
    const states = Object.fromEntries(['custom', 'zxing'].map((key) => [key, { frames: 0, exact: 0, wrong: 0, miss: 0, latency: [], candidateAt: null, candidateKey: null, confirmedMs: null }]));
    return {
      observe(frameId, now, customResults, baselineResults, timings) {
        if (frames.has(frameId) || !Number.isFinite(now) || now < startMs || frames.size >= 300) return false;
        if (![timings.customMs, timings.zxingMs].every((ms) => Number.isFinite(ms) && ms >= 0)) throw new Error('The decoder returned invalid timings.');
        frames.add(frameId);
        for (const [key, results, ms] of [['custom', customResults, timings.customMs], ['zxing', baselineResults, timings.zxingMs]]) {
          const state = states[key], outcome = classify(results, expected);
          state.frames++; state[outcome]++; state.latency.push(ms);
          if (expected.length && outcome === 'exact') {
            const resultKey = JSON.stringify(results.map((r) => [r.format, r.bytes ? Array.from(r.bytes) : r.text]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
            if (state.candidateAt !== null && state.candidateKey === resultKey && now - state.candidateAt <= 2500 && state.confirmedMs === null) state.confirmedMs = now - startMs;
            state.candidateAt = now; state.candidateKey = resultKey;
          } else { state.candidateAt = null; state.candidateKey = null; }
        }
        return true;
      },
      snapshot() {
        return Object.fromEntries(Object.entries(states).map(([key, state]) => [key, { frames: state.frames, exact: state.exact, wrong: state.wrong, miss: state.miss, medianDecodeMs: quantile(state.latency, 0.5), p95DecodeMs: quantile(state.latency, 0.95), timeToFirstConfirmedMs: state.confirmedMs }]));
      },
    };
  }
  const api = { CONDITIONS, label, metadata, captureSize, classify, quantile, isLabOfflineReady, createTrial };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Code128LabPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
