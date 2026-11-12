/* Small, dependency-free policies shared by camera scanning and its tests. */
(function (root) {
  'use strict';

  // Require extra observations for formats without mandatory checks and unknown formats.
  const checkedFormats = new Set(['QRCode', 'MicroQRCode', 'RMQRCode', 'DataMatrix', 'Aztec', 'AztecCode',
    'PDF417', 'MicroPDF417', 'MaxiCode', 'Code128', 'Code93', 'EAN13', 'EAN8', 'UPCA', 'UPCE',
    'DataBar', 'DataBarExpanded', 'DataBarLimited']);
  const corners = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

  function keyFor(result) {
    const bytes = result.bytes;
    const hasBytes = (Array.isArray(bytes) || ArrayBuffer.isView(bytes)) &&
      Array.from(bytes).every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
    return JSON.stringify([result.format, hasBytes ? 'bytes' : 'text', hasBytes ? Array.from(bytes) : result.text]);
  }

  function createConfirmation({ maxAgeMs = 2500, maxEntries = 48 } = {}) {
    const candidates = new Map();
    return {
      reset() { candidates.clear(); },
      observe(results, frameId, now) {
        for (const [key, value] of candidates) {
          if (now < value.firstSeen || now - value.firstSeen > maxAgeMs) candidates.delete(key);
        }
        const confirmed = [];
        const inThisFrame = new Set();
        for (const result of results) {
          const key = keyFor(result);
          if (inThisFrame.has(key)) continue;
          inThisFrame.add(key);
          let value = candidates.get(key);
          if (!value) {
            value = { firstSeen: now, frames: new Set() };
            candidates.set(key, value);
          }
          value.frames.add(frameId);
          const required = checkedFormats.has(result.format) ? 2 : 3;
          if (value.frames.size >= required) confirmed.push(result);
          // No need to retain a growing set after a value is confirmed.
          if (value.frames.size > required) value.frames.delete(value.frames.values().next().value);
        }
        while (candidates.size > maxEntries) candidates.delete(candidates.keys().next().value);
        return confirmed;
      },
    };
  }

  function capturePlan(width, height, { fraction = 1, maxSide = 1920, maxPixels = 4_000_000 } = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        !Number.isFinite(fraction) || fraction <= 0 || fraction > 1 ||
        !Number.isFinite(maxSide) || maxSide < 1 || !Number.isFinite(maxPixels) || maxPixels < 1) {
      throw new Error('Invalid capture dimensions.');
    }
    const cropWidth = Math.max(1, Math.floor(width * fraction));
    const cropHeight = Math.max(1, Math.floor(height * fraction));
    const ratio = Math.min(1, maxSide / Math.max(cropWidth, cropHeight), Math.sqrt(maxPixels / (cropWidth * cropHeight)));
    const outputWidth = Math.max(1, Math.floor(cropWidth * ratio));
    const outputHeight = Math.max(1, Math.min(Math.floor(cropHeight * ratio), Math.floor(maxPixels / outputWidth)));
    return {
      x: Math.floor((width - cropWidth) / 2), y: Math.floor((height - cropHeight) / 2),
      cropWidth, cropHeight, fraction,
      width: outputWidth, height: outputHeight,
    };
  }

  function remapResults(results, plan) {
    return results.map((result) => {
      if (!result.position) return result;
      const position = {};
      for (const corner of corners) {
        const point = result.position[corner];
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ...result, position: null };
        position[corner] = {
          x: plan.x + point.x * plan.cropWidth / plan.width,
          y: plan.y + point.y * plan.cropHeight / plan.height,
        };
      }
      return { ...result, position };
    });
  }

  // Always return to the whole view between crops so off-centre codes remain discoverable.
  function cropFraction(misses) {
    if (misses < 3 || misses % 2 === 0) return 1;
    return misses % 4 === 3 ? 0.7 : 0.45;
  }

  const api = { keyFor, createConfirmation, capturePlan, remapResults, cropFraction };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScanPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
