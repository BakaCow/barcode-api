/* Decode off the UI thread. All executable assets are hosted with this app. */
importScripts('./vendor/zxing-reader.js');

let decoder;
const MAX_PIXELS = 4_000_000;
const OPTIONS = {
  tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true,
  returnErrors: false, isPure: false, minLineCount: 2, maxNumberOfSymbols: 12,
};
function initialize() {
  if (!decoder) {
    decoder = ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (path) => new URL('./vendor/' + path, self.location.href).href },
      fireImmediately: true,
    }).catch((error) => { decoder = null; throw error; });
  }
  return decoder;
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

function validResults(results, inverse, width, height) {
  return results.filter((result) => result.isValid === true && !result.error).map((result) => {
    let position = result.position;
    if (inverse && position) position = Object.fromEntries(Object.entries(position).map(([key, point]) => {
      const mapped = inverse(point);
      return [key, { x: Math.max(0, Math.min(width, mapped.x)), y: Math.max(0, Math.min(height, mapped.y)) }];
    }));
    return { text: result.text, format: result.format, position, bytes: Array.from(result.bytes || []) };
  });
}

async function decode(image, mode, retryIndex) {
  const started = performance.now();
  const budgetMs = mode === 'live' ? 350 : 2500;
  let results = validResults(await ZXingWASM.readBarcodes(image, OPTIONS));
  if (results.length) return { results, diagnostics: { passes: 1, strategy: 'original' } };
  const gray = luminance(image);
  // Live mode spreads expensive retries over different camera frames. Imported
  // images have no next frame, so they may use all four bounded fallback passes.
  const retries = mode === 'live' ? [retryIndex % 4] : [0, 1, 2, 3];
  let passes = 1, strategy = 'original';
  for (const retry of retries) {
    // A single WASM call cannot be interrupted here. The app also has a hard
    // worker timeout; this deadline prevents starting further expensive work.
    if (performance.now() - started > budgetMs) break;
    let candidate, inverse, options = OPTIONS;
    if (retry === 0) {
      strategy = 'contrast'; candidate = rgba(gray, image.width, image.height);
      options = { ...OPTIONS, binarizer: 'GlobalHistogram' };
    } else if (retry === 1) {
      strategy = 'sharpen'; candidate = sharpen(gray, image.width, image.height);
    } else if (retry === 2) {
      strategy = 'rotate-45';
      ({ image: candidate, inverse } = rotated(gray, image.width, image.height, 45));
    } else {
      // Native tryInvert does not recover all inverted linear formats.
      strategy = 'invert';
      candidate = rgba(gray.map((value) => 255 - value), image.width, image.height);
    }
    results = validResults(await ZXingWASM.readBarcodes(candidate, options), inverse, image.width, image.height);
    passes++;
    if (results.length) break;
  }
  return { results, diagnostics: { passes, strategy } };
}

self.onmessage = async ({ data: message }) => {
  const { id, type } = message || {};
  try {
    await initialize();
    if (type === 'init') {
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (type !== 'decode') throw new Error('Unknown decoder request.');
    const { width, height, data } = message.image || {};
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width * height > MAX_PIXELS || !(data instanceof ArrayBuffer) || data.byteLength !== width * height * 4) {
      throw new Error('Image is too large or invalid.');
    }
    const mode = message.mode ?? 'image';
    if (!['image', 'live'].includes(mode)) throw new Error('Unknown scanning mode.');
    const retryIndex = Number.isSafeInteger(message.retryIndex) && message.retryIndex >= 0 ? message.retryIndex : 0;
    const image = new ImageData(new Uint8ClampedArray(data), width, height);
    self.postMessage({ id, type: 'result', ...await decode(image, mode, retryIndex) });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message || 'Could not read this image.' });
  }
};
