/* Local POS decisions. Agreement reduces transient mistakes; it does not prove
 * that an identifier is correct or exists in a product catalogue. */
(function (root) {
  'use strict';

  const FORMATS = Object.freeze({
    qr: 'QRCode', code128: 'Code128', ean13: 'EAN13', ean8: 'EAN8',
    upca: 'UPCA', upce: 'UPCE', datamatrix: 'DataMatrix', aztec: 'Aztec',
    pdf417: 'PDF417', code93: 'Code93',
  });
  const DEFAULT_OPTIONS = Object.freeze({
    allowedFormats: Object.freeze(['ean13', 'upca', 'code128', 'qr']), confirmationFrames: 2,
  });
  const ALIASES = Object.freeze({
    qr: 'qr', qrcode: 'qr', qrcodemodel1: 'qr', qrcodemodel2: 'qr',
    code128: 'code128', ean13: 'ean13', ean8: 'ean8', upca: 'upca', upce: 'upce',
    datamatrix: 'datamatrix', aztec: 'aztec', azteccode: 'aztec', aztecrune: 'aztec',
    pdf417: 'pdf417', compactpdf417: 'pdf417', code93: 'code93',
  });
  const ATTEMPT_MS = 2500, MAX_CANDIDATES = 48, MAX_OBSERVATIONS = 256;
  const CORNERS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];

  function canonicalFormat(name) {
    if (typeof name !== 'string') return null;
    const normalized = name.replace(/^BarcodeFormat\./, '').toLowerCase().replace(/[-_ ]/g, '');
    return Object.hasOwn(ALIASES, normalized) ? ALIASES[normalized] : null;
  }

  function validateOptions(options = {}) {
    if (!options || Object.prototype.toString.call(options) !== '[object Object]' ||
        Reflect.ownKeys(options).some(key => key !== 'allowedFormats' && key !== 'confirmationFrames')) {
      throw new Error('POS options must contain only allowedFormats and confirmationFrames.');
    }
    const allowedFormats = Object.hasOwn(options, 'allowedFormats') ? options.allowedFormats : DEFAULT_OPTIONS.allowedFormats;
    const confirmationFrames = Object.hasOwn(options, 'confirmationFrames') ? options.confirmationFrames : DEFAULT_OPTIONS.confirmationFrames;
    if (!Array.isArray(allowedFormats) || !allowedFormats.length || allowedFormats.length > 10 ||
        allowedFormats.some(name => typeof name !== 'string' || !Object.hasOwn(FORMATS, name)) ||
        new Set(allowedFormats).size !== allowedFormats.length) {
      throw new Error('Choose one or more different supported POS formats.');
    }
    if (!Number.isInteger(confirmationFrames) || confirmationFrames < 1 || confirmationFrames > 3) {
      throw new Error('POS confirmation must be an integer from one to three frames.');
    }
    return { allowedFormats: [...allowedFormats], confirmationFrames };
  }

  function nativeFormats(options = {}) {
    return validateOptions(options).allowedFormats.map(name => FORMATS[name]);
  }

  function keyFor(result) {
    if (!result || typeof result !== 'object' || !canonicalFormat(result.format) ||
        typeof result.text !== 'string' || result.text.length > 10000 || result.isValid === false || result.error) return null;
    const bytes = result.bytes;
    if (!(Array.isArray(bytes) || ArrayBuffer.isView(bytes)) ||
        !Number.isInteger(bytes.length) || bytes.length < 1 || bytes.length > 10000) return null;
    const raw = Array.from(bytes);
    if (raw.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
    // QR ECI declarations can give identical bytes different text meanings.
    // Keep text exact, and never merge UPC-A with EAN-13 or strip leading zeros.
    return JSON.stringify([canonicalFormat(result.format), raw, result.text]);
  }

  function copyResult(result) {
    const position = result.position;
    const safePosition = position && CORNERS.every(name =>
      Number.isFinite(position[name]?.x) && Number.isFinite(position[name]?.y));
    return {
      text: result.text, format: result.format, bytes: Array.from(result.bytes),
      ...(position !== undefined ? { position: safePosition ? Object.fromEntries(CORNERS.map(name =>
        [name, { x: position[name].x, y: position[name].y }])) : null } : {}),
    };
  }

  function usableFrameId(frameId, requiredFrames) {
    if (typeof frameId === 'number') return Number.isSafeInteger(frameId) && frameId >= 0;
    if (typeof frameId !== 'string' || !frameId.trim() || frameId.length > 128) return false;
    if (frameId.startsWith('clock:')) {
      const time = frameId.slice(6);
      return requiredFrames === 1 && time.trim() !== '' && Number.isFinite(Number(time)) && Number(time) >= 0;
    }
    if (/^(presented|decoded):/.test(frameId)) return /^(presented|decoded):\d+$/.test(frameId);
    return true;
  }

  function createConfirmation(options = {}) {
    const config = validateOptions(options), allowed = new Set(config.allowedFormats);
    const candidates = new Map(), seenFrames = new Set(), seenPixels = new Set();
    let startedAt = null, lastNow = null, conflict = false, blocked = false;

    function clearAttempt() {
      candidates.clear(); seenFrames.clear(); seenPixels.clear();
      startedAt = null; conflict = false; blocked = false;
    }

    function snapshot({ fresh = false, hasCurrentCandidate = false, unreliable = false } = {}) {
      const publicCandidates = Array.from(candidates.values(), candidate => ({
        result: copyResult(candidate.result), frameIds: [...candidate.frames],
      }));
      const matchedFrames = Math.max(0, ...publicCandidates.map(candidate => candidate.frameIds.length));
      let status = 'rescan', reason = 'insufficient_confirmation', results = [];
      if (conflict || candidates.size > 1) {
        status = 'ambiguous'; reason = 'conflicting_values';
      } else if (unreliable) {
        reason = 'unreliable_frames';
      } else if (!candidates.size || !hasCurrentCandidate) {
        reason = 'no_code';
      } else if (!blocked && fresh && matchedFrames >= config.confirmationFrames) {
        status = 'confirmed';
        reason = config.confirmationFrames === 1 ? 'single_match' : 'frame_agreement';
        results = [copyResult(publicCandidates[0].result)];
      }
      return { status, reason, results, candidates: publicCandidates, matchedFrames,
        requiredFrames: config.confirmationFrames };
    }

    return {
      reset() { clearAttempt(); lastNow = null; },
      observe(results, frameId, now, pixelIdentity) {
        // Late or repeated timestamps cannot be re-labelled as fresh camera work.
        if (!Number.isFinite(now) || now < 0 || (lastNow !== null && now <= lastNow)) {
          return snapshot({ unreliable: true });
        }
        lastNow = now;
        if (startedAt !== null && now - startedAt >= ATTEMPT_MS) clearAttempt();
        if (startedAt === null) startedAt = now;

        const reliable = usableFrameId(frameId, config.confirmationFrames) &&
          typeof pixelIdentity === 'string' && pixelIdentity.length > 0 && pixelIdentity.length <= 256;
        let fresh = false;
        if (reliable) {
          const id = String(frameId);
          fresh = !seenFrames.has(id) && !seenPixels.has(pixelIdentity);
          if (seenFrames.size >= MAX_OBSERVATIONS || seenPixels.size >= MAX_OBSERVATIONS) {
            blocked = true; fresh = false;
          } else {
            seenFrames.add(id); seenPixels.add(pixelIdentity);
          }
        }
        if (!Array.isArray(results) || results.length > MAX_OBSERVATIONS) {
          blocked = true;
          return snapshot({ unreliable: !reliable });
        }

        let hasCurrentCandidate = false;
        const inThisFrame = new Set();
        for (const result of results) {
          if (!allowed.has(canonicalFormat(result?.format))) continue;
          const key = keyFor(result);
          if (key === null) { blocked = true; continue; }
          hasCurrentCandidate = true;
          if (inThisFrame.has(key)) continue;
          inThisFrame.add(key);
          let candidate = candidates.get(key);
          if (!candidate) {
            if (candidates.size >= MAX_CANDIDATES) { conflict = true; continue; }
            candidate = { result: copyResult(result), frames: new Set() };
            candidates.set(key, candidate);
          }
          candidate.result = copyResult(result);
          if (fresh) candidate.frames.add(frameId);
        }
        // A duplicate image can still reveal a decoder disagreement. It adds no
        // confirmation, but the competing identity must not disappear silently.
        if (candidates.size > 1) conflict = true;
        return snapshot({ fresh, hasCurrentCandidate, unreliable: !reliable });
      },
    };
  }

  const api = Object.freeze({ FORMATS, DEFAULT_OPTIONS, canonicalFormat, validateOptions,
    nativeFormats, keyFor, createConfirmation });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PosPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
