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
  // Escalation changes capture detail, never the evidence needed to confirm.
  // It is deliberately bounded and stops reacting after any observed identity.
  function createRecovery() {
    let misses, firstMiss, lastNow, lastFrame, detailUntil, cooldownUntil, blocked;
    function reset() {
      misses = 0; firstMiss = null; lastNow = -1; lastFrame = null;
      detailUntil = 0; cooldownUntil = 0; blocked = false;
    }
    reset();
    return {
      reset,
      detailed(now) { return Number.isFinite(now) && now >= 0 && now < detailUntil; },
      observe({ now, frameId, analysis, hasResults = false, stale = false }) {
        if (hasResults) blocked = true; // Conflicts and duplicate reads also stop escalation.
        if (!Number.isFinite(now) || now < 0 || now <= lastNow || frameId === null || frameId === undefined || frameId === lastFrame) return false;
        lastNow = now; lastFrame = frameId;
        if (stale) { detailUntil = 0; cooldownUntil = now + 10000; misses = 0; firstMiss = null; return false; }
        if (blocked || now < cooldownUntil) return false;
        const useful = analysis?.regions?.length === 1 && ['small', 'blurred', 'low-detail'].includes(analysis.hint);
        if (!useful) { misses = 0; firstMiss = null; return false; }
        firstMiss ??= now; misses++;
        if (misses < 3 || now - firstMiss < 400) return false;
        detailUntil = now + 3000; cooldownUntil = now + 10000;
        misses = 0; firstMiss = null;
        return true;
      },
    };
  }
  // Keep this view independent of decoder crops and temporary detail profiles.
  // It is an additional duplicate guard, never proof of a new camera exposure.
  function cameraIdentity(source, width, height, canvas, context) {
    const scale = Math.min(1, 320 / Math.max(width, height));
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let a = (0x811c9dc5 ^ canvas.width) >>> 0, b = (0x9e3779b9 ^ canvas.height) >>> 0;
    for (let p = 0; p < data.length; p++) {
      a = Math.imul(a ^ data[p], 0x01000193) >>> 0;
      b = Math.imul(b ^ data[p] ^ p, 0x85ebca6b) >>> 0;
    }
    return `camera:${canvas.width}x${canvas.height}:${a.toString(16)}:${b.toString(16)}`;
  }
  const api = { create, createRecovery, cameraIdentity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptureSelection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
