/* Decode off the UI thread. All executable assets are hosted with this app. */
importScripts('./vendor/zxing-reader.js');

let decoder;
const MAX_PIXELS = 4_000_000;
const OPTIONS = {
  tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true,
  returnErrors: false, isPure: false, minLineCount: 2, maxNumberOfSymbols: 12,
};
// Enhancement can turn clipped bars into plausible unchecked formats. Limit
// recovery to formats with mandatory checksum/error correction; the original
// pass keeps the reader's full format support for compatibility.
const RECOVERY_FORMATS = [
  'QRCode', 'MicroQRCode', 'RMQRCode', 'DataMatrix', 'Aztec', 'PDF417', 'MicroPDF417', 'MaxiCode',
  'Code128', 'Code93', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'DataBar', 'DataBarExp', 'DataBarLtd',
];
const RECOVERY_RESULTS = new Set([
  ...RECOVERY_FORMATS, 'QRCodeModel1', 'QRCodeModel2', 'AztecCode', 'AztecRune', 'CompactPDF417',
  'DataBarOmni', 'DataBarStk', 'DataBarStkOmni', 'DataBarExpStk', 'DataBarExpanded', 'DataBarLimited',
]);
const RECOVERY_OPTIONS = { ...OPTIONS, formats: RECOVERY_FORMATS };
const LINEAR_RECOVERY = new Set([
  'Code128', 'Code93', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'DataBar', 'DataBarExp', 'DataBarLtd',
  'DataBarOmni', 'DataBarStk', 'DataBarStkOmni', 'DataBarExpStk', 'DataBarExpanded', 'DataBarLimited',
]);
function initialize() {
  if (!decoder) {
    decoder = ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (path) => new URL('./vendor/' + path, self.location.href).href },
      fireImmediately: true,
    }).catch((error) => { decoder = null; throw error; });
  }
  return decoder;
}

function loadPosPolicy() {
  if (typeof PosPolicy === 'undefined') importScripts('./pos-policy.js');
}

function loadFrameAnalysis() {
  if (typeof FrameAnalysis === 'undefined') importScripts('./frame-analysis.js');
}

// Work on luminance only for retries; the first pass always sees the original.
// Contrast stretching cannot reconstruct bars that the camera never captured.
function luminance(image) {
  const gray = new Uint8Array(image.width * image.height);
  const histogram = new Uint32Array(256);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const alpha = image.data[p + 3] / 255;
    const value = Math.round(((306 * image.data[p] + 601 * image.data[p + 1] + 117 * image.data[p + 2]) / 1024) * alpha + 255 * (1 - alpha));
    gray[i] = value; histogram[value]++;
  }
  // Ignore sparse extremes, but retain enough of the range for small codes.
  const tail = Math.floor(gray.length * 0.005);
  let low = 0, high = 255, count = 0;
  while (low < 254 && count + histogram[low] <= tail) count += histogram[low++];
  count = 0;
  while (high > low && count + histogram[high] <= tail) count += histogram[high--];
  const span = high - low;
  if (span >= 8 && span < 180) {
    for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, Math.round((gray[i] - low) * 255 / span)));
  }
  return gray;
}

function rgba(gray, width, height) {
  const data = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    data[p] = data[p + 1] = data[p + 2] = gray[i]; data[p + 3] = 255;
  }
  return new ImageData(data, width, height);
}

function sharpen(gray, width, height) {
  const output = new Uint8Array(gray);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const neighbors = (gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width]) / 4;
      output[i] = Math.max(0, Math.min(255, Math.round(gray[i] + 1.2 * (gray[i] - neighbors))));
    }
  }
  return rgba(output, width, height);
}

function rotated(gray, width, height, angle) {
  const radians = angle * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const naturalWidth = Math.ceil(Math.abs(width * c) + Math.abs(height * s));
  const naturalHeight = Math.ceil(Math.abs(width * s) + Math.abs(height * c));
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (naturalWidth * naturalHeight)));
  const outWidth = Math.max(1, Math.floor(naturalWidth * scale));
  const outHeight = Math.max(1, Math.floor(naturalHeight * scale));
  const inverse = ({ x, y }) => {
    const dx = (x - (outWidth - 1) / 2) / scale, dy = (y - (outHeight - 1) / 2) / scale;
    return { x: c * dx + s * dy + (width - 1) / 2, y: -s * dx + c * dy + (height - 1) / 2 };
  };
  const output = new Uint8Array(outWidth * outHeight).fill(255);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const dx = (x - (outWidth - 1) / 2) / scale, dy = (y - (outHeight - 1) / 2) / scale;
      const sx = c * dx + s * dy + (width - 1) / 2, sy = -s * dx + c * dy + (height - 1) / 2;
      if (sx < 0 || sy < 0 || sx > width - 1 || sy > height - 1) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      output[y * outWidth + x] = Math.round((1 - fy) * ((1 - fx) * gray[y0 * width + x0] + fx * gray[y0 * width + x1]) + fy * ((1 - fx) * gray[y1 * width + x0] + fx * gray[y1 * width + x1]));
    }
  }
  return { image: rgba(output, outWidth, outHeight), inverse };
}

function direction(gray, width, height) {
  let xx = 0, xy = 0, yy = 0;
  const stride = Math.max(1, Math.floor(Math.sqrt(width * height / 300_000)));
  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      const i = y * width + x, dx = gray[i + 1] - gray[i - 1], dy = gray[i + width] - gray[i - width];
      xx += dx * dx; xy += dx * dy; yy += dy * dy;
    }
  }
  return { angle: Math.atan2(2 * xy, xx - yy) * 90 / Math.PI, coherence: Math.hypot(xx - yy, 2 * xy) / (xx + yy || 1) };
}

function adaptive(gray, width, height) {
  // A summed-area table removes slowly varying illumination. At most four
  // million 8-bit samples keep the cumulative sum within Uint32's range.
  const pitch = width + 1, integral = new Uint32Array(pitch * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += gray[y * width + x];
      integral[(y + 1) * pitch + x + 1] = integral[y * pitch + x + 1] + row;
    }
  }
  const output = new Uint8Array(gray.length), radius = 15;
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1);
      const sum = integral[y1 * pitch + x1] - integral[y0 * pitch + x1] - integral[y1 * pitch + x0] + integral[y0 * pitch + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      output[y * width + x] = gray[y * width + x] < mean - 5 ? 0 : 255;
    }
  }
  return output;
}

function upscaled(gray, width, height) {
  // Only low-resolution inputs use this pass. Interpolation changes decoder
  // sampling; it does not recover information absent from the photograph.
  if (width * height > MAX_PIXELS / 4) return null;
  const outWidth = width * 2, outHeight = height * 2;
  const output = new Uint8Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const sy = (y + 0.5) / 2 - 0.5, y0 = Math.floor(sy), fy = sy - y0;
    const row0 = Math.max(0, Math.min(height - 1, y0)) * width, row1 = Math.max(0, Math.min(height - 1, y0 + 1)) * width;
    for (let x = 0; x < outWidth; x++) {
      const sx = (x + 0.5) / 2 - 0.5, x0 = Math.floor(sx), fx = sx - x0;
      const a = Math.max(0, Math.min(width - 1, x0)), b = Math.max(0, Math.min(width - 1, x0 + 1));
      output[y * outWidth + x] = Math.round((1 - fy) * ((1 - fx) * gray[row0 + a] + fx * gray[row0 + b]) + fy * ((1 - fx) * gray[row1 + a] + fx * gray[row1 + b]));
    }
  }
  return { image: rgba(output, outWidth, outHeight), inverse: ({ x, y }) => ({ x: (x + 0.5) / 2 - 0.5, y: (y + 0.5) / 2 - 0.5 }) };
}

function sourceGeometryAgrees(position, gray, width, height) {
  if (!position || !gray || width < 3 || height < 3) return false;
  const { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br } = position;
  const corners = [tl, tr, bl, br];
  if (corners.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  const vx = (tr.x - tl.x + br.x - bl.x) / 2, vy = (tr.y - tl.y + br.y - bl.y) / 2;
  const length2 = vx * vx + vy * vy;
  if (length2 < 1) return false;
  // Readers sometimes report only two rows on a bar's top edge. Include a small
  // neighborhood so the tensor measures bar interiors, not just that boundary.
  const padding = Math.min(32, Math.max(2, Math.ceil(Math.sqrt(length2) * 0.06)));
  const x0 = Math.max(1, Math.floor(Math.min(...corners.map((point) => point.x))) - padding);
  const y0 = Math.max(1, Math.floor(Math.min(...corners.map((point) => point.y))) - padding);
  const x1 = Math.min(width - 2, Math.ceil(Math.max(...corners.map((point) => point.x))) + padding);
  const y1 = Math.min(height - 2, Math.ceil(Math.max(...corners.map((point) => point.y))) + padding);
  if (x1 < x0 || y1 < y0) return false;
  const stride = Math.max(1, Math.ceil(Math.sqrt((x1 - x0 + 1) * (y1 - y0 + 1) / 4096)));
  let xx = 0, xy = 0, yy = 0, samples = 0;
  for (let y = y0; y <= y1 && samples < 4096; y += stride) {
    for (let x = x0; x <= x1 && samples < 4096; x += stride) {
      // Jitter within each cell prevents a regular grid from sampling only the
      // centers of equal-width bars and incorrectly observing zero contrast.
      const jitter = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      const sx = Math.min(x1, x + jitter % stride), sy = Math.min(y1, y + Math.floor(jitter / stride) % stride);
      const i = sy * width + sx, dx = gray[i + 1] - gray[i - 1], dy = gray[i + width] - gray[i - width];
      xx += dx * dx; xy += dx * dy; yy += dy * dy; samples++;
    }
  }
  const anisotropy = Math.hypot(xx - yy, 2 * xy), energy = xx + yy;
  if (!energy || anisotropy / energy < 0.5) return false;
  // A doubled-angle dot product compares unoriented bar gradients with the
  // mapped scanline. It catches plausible checksums created by oblique retries.
  const agreement = ((xx - yy) * (vx * vx - vy * vy) + 4 * xy * vx * vy) / (anisotropy * length2);
  return agreement >= Math.cos(50 * Math.PI / 180);
}

function validResults(results, inverse, width, height, recovery = false, gray) {
  return results.filter((result) => result.isValid === true && !result.error &&
    (!recovery || RECOVERY_RESULTS.has(result.format))).map((result) => {
    let position = result.position;
    if (inverse && position) position = Object.fromEntries(Object.entries(position).map(([key, point]) => [key, inverse(point)]));
    if (recovery && LINEAR_RECOVERY.has(result.format) && !sourceGeometryAgrees(position, gray, width, height)) return null;
    if (inverse && position) position = Object.fromEntries(Object.entries(position).map(([key, point]) =>
      [key, { x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) }]));
    return { text: result.text, format: result.format, position, bytes: Array.from(result.bytes || []) };
  }).filter(Boolean);
}

async function decode(image, mode, retryIndex, posOptions, enhanceLive) {
  const started = performance.now();
  const budgetMs = mode === 'live' ? 350 : 2500;
  const allowed = posOptions && new Set(posOptions.allowedFormats);
  const permitted = (results) => allowed ? results.filter((result) => allowed.has(PosPolicy.canonicalFormat(result.format))) : results;
  const firstOptions = posOptions ? { ...OPTIONS, formats: PosPolicy.nativeFormats(posOptions) } : OPTIONS;
  const recoveryOptions = posOptions ? { ...RECOVERY_OPTIONS,
    formats: PosPolicy.nativeFormats(posOptions).filter((format) => RECOVERY_FORMATS.includes(format)) } : RECOVERY_OPTIONS;
  const analysis = enhanceLive ? FrameAnalysis.analyze(image) : undefined;
  const details = analysis ? { analysis } : {};
  // Always inspect the full supplied image first. A crop must not hide a
  // conflicting value that the whole-image reader already found.
  let results = permitted(validResults(await ZXingWASM.readBarcodes(image, firstOptions)));
  if (results.length) return { results, ...details, diagnostics: { passes: 1, strategy: 'original' } };
  // An empty native format list means all formats in some ZXing versions.
  if (!recoveryOptions.formats.length) return { results, ...details, diagnostics: { passes: 1, strategy: 'original' } };
  const gray = luminance(image);
  let passes = 1, strategy = 'original';
  if (analysis) {
    const seen = new Set(), croppedResults = [];
    for (const region of analysis.regions.slice(0, mode === 'live' ? 2 : 3)) {
      if (performance.now() - started > budgetMs) break;
      const crop = FrameAnalysis.crop(image, region, MAX_PIXELS);
      if (performance.now() - started > budgetMs) break;
      const candidate = new ImageData(new Uint8ClampedArray(crop.image.data), crop.image.width, crop.image.height);
      const found = permitted(validResults(await ZXingWASM.readBarcodes(candidate, recoveryOptions),
        crop.mapPoint, image.width, image.height, true, gray));
      passes++; strategy = 'barcode-crop';
      // Examine the remaining bounded crops even after a match. Different
      // values must reach the POS policy together rather than first-one-wins.
      for (const result of found) {
        const key = JSON.stringify([result.format, result.bytes, result.text]);
        if (!seen.has(key)) { seen.add(key); croppedResults.push(result); }
      }
    }
    if (croppedResults.length) return { results: croppedResults, ...details, diagnostics: { passes, strategy } };
  }
  // Live mode spreads expensive retries over different camera frames. Imported
  // images have no next frame, so they may use all six bounded fallback passes.
  const retries = mode === 'live' ? [retryIndex % 6] : [0, 1, 2, 3, 4, 5];
  for (const retry of retries) {
    // A single WASM call cannot be interrupted here. The app also has a hard
    // worker timeout; this deadline prevents starting further expensive work.
    if (performance.now() - started > budgetMs) break;
    let candidate, inverse, options = recoveryOptions;
    if (retry === 0) {
      strategy = 'contrast'; candidate = rgba(gray, image.width, image.height);
      options = { ...recoveryOptions, binarizer: 'GlobalHistogram' };
    } else if (retry === 1) {
      strategy = 'sharpen'; candidate = sharpen(gray, image.width, image.height);
    } else if (retry === 2) {
      strategy = 'rotate-45';
      ({ image: candidate, inverse } = rotated(gray, image.width, image.height, 45));
    } else if (retry === 3) {
      // Native tryInvert does not recover all inverted linear formats.
      strategy = 'invert';
      candidate = rgba(gray.map((value) => 255 - value), image.width, image.height);
    } else if (retry === 4) {
      if (image.width < 8 || image.height < 8) continue;
      strategy = 'local-contrast-deskew';
      const corrected = adaptive(gray, image.width, image.height), orientation = direction(gray, image.width, image.height);
      if (orientation.coherence >= 0.55 && Math.abs(orientation.angle) > 3 && Math.abs(orientation.angle) < 87) {
        ({ image: candidate, inverse } = rotated(corrected, image.width, image.height, -orientation.angle));
      } else candidate = rgba(corrected, image.width, image.height);
    } else {
      const enlarged = upscaled(gray, image.width, image.height);
      if (!enlarged) continue;
      strategy = 'upscale';
      ({ image: candidate, inverse } = enlarged);
    }
    results = permitted(validResults(await ZXingWASM.readBarcodes(candidate, options), inverse, image.width, image.height, true, gray));
    passes++;
    if (results.length) break;
  }
  return { results, ...details, diagnostics: { passes, strategy } };
}

self.onmessage = async ({ data: message }) => {
  const { id, type } = message || {};
  try {
    if (type === 'init') {
      await initialize();
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (!['decode', 'analyze'].includes(type)) throw new Error('Unknown decoder request.');
    const { width, height, data } = message.image || {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width * height > MAX_PIXELS || !(data instanceof ArrayBuffer) || data.byteLength !== width * height * 4) {
      throw new Error('Image is too large or invalid.');
    }
    const image = new ImageData(new Uint8ClampedArray(data), width, height);
    if (type === 'analyze') {
      loadFrameAnalysis();
      self.postMessage({ id, type: 'analysis', analysis: FrameAnalysis.analyze(image) });
      return;
    }
    const mode = message.mode ?? 'image';
    if (!['image', 'live'].includes(mode)) throw new Error('Unknown scanning mode.');
    if (message.enhanceLive !== undefined && typeof message.enhanceLive !== 'boolean') throw new Error('Invalid frame enhancement setting.');
    let posOptions;
    if (message.posOptions !== undefined) {
      loadPosPolicy();
      posOptions = PosPolicy.validateOptions(message.posOptions);
    }
    if (message.enhanceLive) loadFrameAnalysis();
    const retryIndex = Number.isSafeInteger(message.retryIndex) && message.retryIndex >= 0 ? message.retryIndex : 0;
    await initialize();
    self.postMessage({ id, type: 'result', ...await decode(image, mode, retryIndex, posOptions, message.enhanceLive === true) });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message || 'Could not read this image.' });
  }
};
