/* A small, bounded camera burst. Selection ranks images; it never confirms a code. */
(function (root) {
  'use strict';
  function create({ maxFrames = 3, windowMs = 240 } = {}) {
    if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 3 ||
        !Number.isFinite(windowMs) || windowMs < 0 || windowMs > 500) throw new Error('Invalid frame-selection limits.');
    let frames = [];
    function reset() { frames = []; }
    function take(now) {
      const fresh = frames.filter(frame => now >= frame.capturedAt && now - frame.capturedAt <= 600);
      reset();
      return fresh.reduce((best, frame) => !best || frame.analysis.score >= best.analysis.score ? frame : best, null);
    }
    return {
      reset,
      push(frame) {
        if (!frame || !Number.isFinite(frame.capturedAt) || !Number.isFinite(frame.analysis?.score)) throw new Error('Invalid camera sample.');
        if (frames.length && frame.capturedAt < frames[0].capturedAt) reset();
        if (!frames.some(item => item.frameId === frame.frameId)) frames.push(frame);
        if (frames.length >= maxFrames || frame.capturedAt - frames[0].capturedAt >= windowMs) return take(frame.capturedAt);
        return null;
      },
      flush(now) {
        return frames.length && now - frames[0].capturedAt >= windowMs ? take(now) : null;
      },
    };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptureSelection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
