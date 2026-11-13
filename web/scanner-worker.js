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
const QR_RECOVERY_FORMATS = ['QRCode', 'MicroQRCode', 'RMQRCode'];
const QR_RECOVERY_RESULTS = new Set([...QR_RECOVERY_FORMATS, 'QRCodeModel1', 'QRCodeModel2']);
const LINEAR_RECOVERY = new Set([
  'Code128', 'Code93', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'DataBar', 'DataBarExp', 'DataBarLtd',
  'DataBarOmni', 'DataBarStk', 'DataBarStkOmni', 'DataBarExpStk', 'DataBarExpanded', 'DataBarLimited',
]);
function initialize() {
  if (!decoder) {
    if (typeof IndependentReader === 'undefined') importScripts('./independent-reader.js');
    decoder = Promise.all([ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (path) => new URL('./vendor/' + path, self.location.href).href },
      fireImmediately: true,
    }), IndependentReader.initialize()]).catch((error) => { decoder = null; throw error; });
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
  // A wider unsharp mask restores some blurred module boundaries that a
  // four-neighbor edge boost misses. Sliding sums keep work linear and add only
  // one column array, rather than another full-size integral image.
  const radius = 2, amount = 4, output = new Uint8Array(gray.length);
  const columns = new Uint32Array(width);
  for (let y = 0; y < Math.min(height, radius + 1); y++) {
    for (let x = 0; x < width; x++) columns[x] += gray[y * width + x];
  }
  for (let y = 0; y < height; y++) {
    if (y > 0) {
      for (let x = 0; x < width; x++) {
        if (y > radius) columns[x] -= gray[(y - radius - 1) * width + x];
        if (y + radius < height) columns[x] += gray[(y + radius) * width + x];
      }
    }
    const rows = Math.min(height, y + radius + 1) - Math.max(0, y - radius);
    let sum = 0;
    for (let x = 0; x < Math.min(width, radius + 1); x++) sum += columns[x];
    for (let x = 0; x < width; x++) {
      if (x > 0) {
        if (x > radius) sum -= columns[x - radius - 1];
        if (x + radius < width) sum += columns[x + radius];
      }
      const count = rows * (Math.min(width, x + radius + 1) - Math.max(0, x - radius));
      const i = y * width + x, value = gray[i];
      output[i] = Math.max(0, Math.min(255, Math.round(value + amount * (value - sum / count))));
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

function sourceTensor(position, gray, width, height) {
  if (!position || !gray || width < 3 || height < 3) return null;
  const { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br } = position;
  const corners = [tl, tr, bl, br];
  if (corners.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const vx = (tr.x - tl.x + br.x - bl.x) / 2, vy = (tr.y - tl.y + br.y - bl.y) / 2;
  const length2 = vx * vx + vy * vy;
  if (length2 < 1) return null;
  // Readers sometimes report only two rows on a bar's top edge. Include a small
  // neighborhood so the tensor measures bar interiors, not just that boundary.
  const padding = Math.min(32, Math.max(2, Math.ceil(Math.sqrt(length2) * 0.06)));
  const x0 = Math.max(1, Math.floor(Math.min(...corners.map((point) => point.x))) - padding);
  const y0 = Math.max(1, Math.floor(Math.min(...corners.map((point) => point.y))) - padding);
  const x1 = Math.min(width - 2, Math.ceil(Math.max(...corners.map((point) => point.x))) + padding);
  const y1 = Math.min(height - 2, Math.ceil(Math.max(...corners.map((point) => point.y))) + padding);
  if (x1 < x0 || y1 < y0) return null;
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
  return { xx, xy, yy, vx, vy, length2, anisotropy: Math.hypot(xx - yy, 2 * xy), energy: xx + yy };
}

function sourceGeometryAgrees(position, gray, width, height) {
  const tensor = sourceTensor(position, gray, width, height);
  if (!tensor) return false;
  const { xx, xy, yy, vx, vy, length2, anisotropy, energy } = tensor;
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

function sameSymbolSegment(position, footprint) {
  const corners = (value) => value && [value.topLeft, value.topRight, value.bottomRight, value.bottomLeft];
  const segment = corners(position), quad = corners(footprint);
  if (!segment || !quad || [...segment, ...quad].some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const left = midpoint(segment[0], segment[3]), right = midpoint(segment[1], segment[2]);
  if (Math.hypot(right.x - left.x, right.y - left.y) < 1) return false;
  return [0.25, 0.5, 0.75].every(fraction => {
    const x = left.x + fraction * (right.x - left.x), y = left.y + fraction * (right.y - left.y);
    const cross = quad.map((a, index) => {
      const b = quad[(index + 1) % 4];
      return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    });
    // Strict interior only: degenerate/uncertain geometry retains the conflict.
    return cross.every(value => value > 0) || cross.every(value => value < 0);
  });
}

async function corroborateRetailOverlap(results, image, options, permitted, started, budgetMs) {
  const original = { results, diagnostics: { passes: 1, strategy: 'original' } };
  const upce = results.find(result => result.format === 'UPCE');
  const ean = results.filter(result => ['EAN13', 'UPCA'].includes(result.format));
  if (!upce || !ean.length || performance.now() - started >= budgetMs) return original;
  const gray = luminance(image), tensor = sourceTensor(upce.position, gray, image.width, image.height);
  if (!tensor || !tensor.energy || tensor.anisotropy / tensor.energy < 0.7) return original;
  const angle = Math.atan2(2 * tensor.xy, tensor.xx - tensor.yy) * 90 / Math.PI;
  if (Math.abs(angle) <= 3 || Math.abs(angle) >= 87 || performance.now() - started >= budgetMs) return original;
  const { image: candidate, inverse } = rotated(gray, image.width, image.height, -angle);
  if (performance.now() - started >= budgetMs) return original;
  const diagnostics = { passes: 2, strategy: 'retail-corroboration' };
  try {
    // Native scanline boxes may cut obliquely through another retail symbol.
    // One source-aligned reread must reproduce the exact EAN identity and its
    // oriented footprint before an unreproduced UPC-E inside it can be removed.
    // Use the original allowlist and never add new identities from this check.
    const checked = permitted(validResults(await ZXingWASM.readBarcodes(candidate, options), inverse, image.width, image.height));
    const identity = result => JSON.stringify([result.format, result.text, result.bytes]);
    const eanKeys = new Set(ean.map(identity)), checkedKeys = new Set(checked.map(identity));
    const footprints = checked.filter(result => eanKeys.has(identity(result)));
    return { results: results.filter(result => result.format !== 'UPCE' || checkedKeys.has(identity(result)) ||
      !footprints.some(footprint => sameSymbolSegment(result.position, footprint.position))), diagnostics };
  } catch {
    // An optional corroboration failure cannot turn a known conflict into an
    // accepted single value. Preserve the complete original evidence.
    return { results, diagnostics };
  }
}

const resultIdentity = result => JSON.stringify([result.format, result.text, result.bytes]);
const matchingBytes = (a, b) => a.format === b.format && Array.isArray(a.bytes) && Array.isArray(b.bytes) &&
  a.bytes.length > 0 && a.bytes.length === b.bytes.length && a.bytes.every((value, index) => value === b.bytes[index]);
function uniqueResults(results) { return [...new Map(results.map(result => [resultIdentity(result), result])).values()]; }
function incompleteEvidence(results) { const unique = uniqueResults(results); return unique.length > 1 ? unique : []; }
// Native HRI presentation for GS1/control/extended bytes remains authoritative.
// The new project's fallback currently supports unambiguous printable text only.
const printableProject = result => result.gs1 === false && result.bytes.length > 0 && result.bytes.every(value => value >= 32 && value <= 126);
const publicResult = ({ text, format, bytes, position }) => ({ text, format, bytes, position });
function comparableFootprint(position, footprint) {
  if (!sameSymbolSegment(position, footprint)) return false;
  const vector = quad => ({ x: (quad.topRight.x + quad.bottomRight.x - quad.topLeft.x - quad.bottomLeft.x) / 2,
    y: (quad.topRight.y + quad.bottomRight.y - quad.topLeft.y - quad.bottomLeft.y) / 2 });
  const a = vector(position), b = vector(footprint), al = Math.hypot(a.x, a.y), bl = Math.hypot(b.x, b.y);
  // A wide outer-label region must not absorb a shorter, separate barcode.
  return al > 0 && bl > 0 && al / bl >= 0.8 && al / bl <= 1.25 && Math.abs(a.x * b.x + a.y * b.y) / (al * bl) >= Math.cos(Math.PI / 12);
}

async function corroborateCode128(original, image, started, budgetMs) {
  if (!original.results.some(result => result.format === 'Code128')) return original;
  const remaining = Math.max(0, budgetMs - (performance.now() - started));
  let checked;
  try { checked = await IndependentReader.read(image, { formats: ['Code128'], timeBudgetMs: Math.min(remaining, budgetMs === 350 ? 120 : 500) }); }
  catch { return { ...original, diagnostics: { ...original.diagnostics, independentError: true } }; }
  const diagnostics = { ...original.diagnostics, passes: original.diagnostics.passes + checked.passes,
    independentPasses: checked.passes };
  // ZBar 0.23.90 can drop FNC4 high bits. Never let its Code128 value alone
  // override native bytes. Require a distinct project's checksum/row decoder
  // to agree on every byte and on the physical symbol's footprint.
  const corroborated = checked.complete ? checked.project.filter(project => printableProject(project) && checked.zbar.some(zbar => matchingBytes(zbar, project) &&
    comparableFootprint(zbar.position, project.position))) : [];
  let corrected = 0;
  const results = original.results.map(result => {
    if (result.format !== 'Code128') return result;
    // Positive evidence for this original identity must not be erased by a
    // neighbouring or overlapping label's larger footprint.
    if ([...checked.zbar, ...checked.project].some(candidate => matchingBytes(result, candidate) &&
      (comparableFootprint(result.position, candidate.position) || comparableFootprint(candidate.position, result.position)))) return result;
    const candidates = corroborated.filter(candidate => comparableFootprint(result.position, candidate.position) &&
      original.results.filter(other => other.format === 'Code128' && comparableFootprint(other.position, candidate.position)).length === 1);
    if (candidates.length !== 1 || matchingBytes(result, candidates[0])) return result;
    corrected++;
    return publicResult(candidates[0]);
  });
  for (const candidate of checked.project.filter(printableProject)) {
    // A newly observed separate label or unresolved interpretation remains
    // visible to the caller's ambiguity policy, even when the native pass read
    // something first. Never silently turn two credible values into one.
    if (!results.some(result => matchingBytes(result, candidate) &&
      (sameSymbolSegment(result.position, candidate.position) || sameSymbolSegment(candidate.position, result.position)))) {
      results.push(publicResult(candidate));
    }
  }
  return { results, diagnostics: { ...diagnostics,
    ...(!checked.complete ? { strategy: 'independent-incomplete' } : {}),
    ...(corrected ? { strategy: 'independent-code128-corroboration', corrected } : {}) } };
}

async function independentRecovery(image, formats, started, budgetMs) {
  const selected = formats.filter(format => IndependentReader.supportedFormats.includes(format));
  if (!selected.length || performance.now() - started >= budgetMs) return null;
  let checked;
  try { checked = await IndependentReader.read(image, { formats: selected,
    timeBudgetMs: Math.min(budgetMs === 350 ? 120 : 500, Math.max(0, budgetMs - (performance.now() - started))) }); }
  catch { return null; }
  // The project matcher supplies supported Code128 values. ZBar's Code128
  // interpretation is used only for corroboration, never as a lone fallback.
  let gray;
  const sourceAgrees = result => typeof result.text === 'string' && Array.isArray(result.bytes) && result.bytes.length > 0 &&
    result.bytes.length <= 8192 && result.bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255) &&
    result.position && ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].every(name => {
      const point = result.position[name];
      return point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x <= image.width && point.y <= image.height;
    }) && sourceGeometryAgrees(result.position, gray ||= luminance(image), image.width, image.height);
  const project = checked.project.filter(printableProject).map(publicResult).filter(sourceAgrees);
  let results = uniqueResults([...checked.zbar.filter(result => result.format === 'EAN13' && sourceAgrees(result)), ...project]);
  const unverifiedCode128 = checked.zbar.some(zbar => zbar.format === 'Code128' && !project.some(project =>
    matchingBytes(zbar, project) && comparableFootprint(zbar.position, project.position)));
  if (!checked.complete || unverifiedCode128) results = incompleteEvidence(results);
  return { results, diagnostics: { passes: 1 + checked.passes, independentPasses: checked.passes,
    strategy: checked.complete ? 'independent-recovery' : 'independent-incomplete' } };
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
  if (results.length) {
    const original = await corroborateRetailOverlap(results, image, firstOptions, permitted, started, budgetMs);
    return { ...await corroborateCode128(original, image, started, budgetMs), ...details };
  }
  // An empty native format list means all formats in some ZXing versions.
  if (!recoveryOptions.formats.length) return { results, ...details, diagnostics: { passes: 1, strategy: 'original' } };
  const independent = await independentRecovery(image, recoveryOptions.formats, started, budgetMs);
  if (independent?.results.length) return { ...independent, ...details };
  const gray = luminance(image);
  let passes = 1, strategy = 'original';
  if (analysis) {
    const seen = new Set(), croppedResults = [];
    // A unique partial result is unsafe when an unchecked planned crop may
    // contain a different label. Keep conflicts already observed, but do not
    // let the recovery deadline turn this into first-crop-wins acceptance.
    const incomplete = () => ({ results: seen.size > 1 ? croppedResults : [], ...details,
      diagnostics: { passes, strategy } });
    for (const region of analysis.regions.slice(0, mode === 'live' ? 2 : 3)) {
      if (performance.now() - started > budgetMs) return incomplete();
      const crop = FrameAnalysis.crop(image, region, MAX_PIXELS);
      if (performance.now() - started > budgetMs) return incomplete();
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
  // images have no next frame, so they may use all seven bounded fallback passes.
  const retries = mode === 'live' ? [retryIndex % 7] : [0, 1, 2, 3, 4, 5, 6];
  for (const retry of retries) {
    // A single WASM call cannot be interrupted here. The app also has a hard
    // worker timeout; this deadline prevents starting further expensive work.
    if (performance.now() - started > budgetMs) break;
    let candidate, inverse, options = recoveryOptions;
    if (retry === 0) {
      strategy = 'contrast'; candidate = rgba(gray, image.width, image.height);
      // The normalized midpoint can separate blurred bars/modules that the
      // decoder's histogram/local thresholds merge. Keep checksum and source
      // geometry validation identical to the other transformed retries.
      options = { ...recoveryOptions, binarizer: 'FixedThreshold' };
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
    } else if (retry === 5) {
      const enlarged = upscaled(gray, image.width, image.height);
      if (!enlarged) continue;
      strategy = 'upscale';
      ({ image: candidate, inverse } = enlarged);
    } else {
      // Native 2D denoising closes small scratch gaps before QR detection/grid
      // sampling. Restrict this extra path to requested QR families; never let
      // an empty native allowlist enable every format or assume a pure image.
      const formats = recoveryOptions.formats.filter(format => QR_RECOVERY_FORMATS.includes(format));
      if (!formats.length) continue;
      strategy = 'qr-denoise'; candidate = image;
      options = { ...recoveryOptions, formats, tryDenoise: true };
    }
    results = permitted(validResults(await ZXingWASM.readBarcodes(candidate, options), inverse, image.width, image.height, true, gray));
    if (retry === 6) results = results.filter(result => QR_RECOVERY_RESULTS.has(result.format));
    passes++;
    if (results.length) break;
  }
  return { results, ...details, diagnostics: { passes, strategy } };
}

function canPrepareCapture() {
  if (typeof OffscreenCanvas !== 'function' || typeof ImageBitmap !== 'function') return false;
  try { return Boolean(new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })); }
  catch { return false; }
}

function prepareCapture(message) {
  const { bitmap, sourceWidth: width, sourceHeight: height, imported, captureMode, targetRegion, cropBarcodes } = message;
  try {
    if (typeof ImageBitmap !== 'function' || !(bitmap instanceof ImageBitmap) || !canPrepareCapture() ||
        !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        typeof imported !== 'boolean' || typeof cropBarcodes !== 'boolean' || !['balanced', 'detail'].includes(captureMode) ||
        bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > (imported ? 20_000_000 : 8_294_400)) {
      throw new Error('Invalid capture preparation request.');
    }
    if (typeof CaptureGeometry === 'undefined') importScripts('./capture-geometry.js');
    loadFrameAnalysis();
    const { regionPlan, sourceRegions, validateTarget } = CaptureGeometry;
    const detail = captureMode === 'detail', target = validateTarget(targetRegion);
    const scale = { x: bitmap.width / width, y: bitmap.height / height };
    const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d', { willReadFrequently: true });
    function capture(region, maxPixels, maxSide) {
      const plan = regionPlan(width, height, region, maxPixels, maxSide);
      canvas.width = plan.width; canvas.height = plan.height;
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, plan.x * scale.x, plan.y * scale.y, plan.cropWidth * scale.x, plan.cropHeight * scale.y,
        0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      return { image: { width: pixels.width, height: pixels.height, data: pixels.data.buffer }, plan };
    }
    try {
      const sample = capture(target, imported || (detail && target) ? 4_000_000 : 2_100_000, detail && target ? 3840 : 1920);
      const analysis = FrameAnalysis.analyze(sample.image);
      const proposals = sourceRegions(analysis, sample.plan, width, height), recovery = [];
      if (detail && !target && cropBarcodes && sample.plan.width < bitmap.width) {
        for (const region of proposals.slice(0, 2)) {
          const { kind, ...rectangle } = region;
          const crop = capture(rectangle, 1_000_000, 3840);
          if (crop.plan.width / crop.plan.cropWidth > sample.plan.width / sample.plan.cropWidth * 1.05) recovery.push(crop);
        }
      }
      return { ...sample, analysis, proposals, recovery, sourceWidth: width, sourceHeight: height };
    } finally { canvas.width = canvas.height = 0; }
  } finally { bitmap?.close?.(); }
}

self.onmessage = async ({ data: message }) => {
  const { id, type } = message || {};
  try {
    if (type === 'init') {
      await initialize();
      self.postMessage({ id, type: 'ready', capabilities: { offscreenCapture: canPrepareCapture() } });
      return;
    }
    if (type === 'prepare') {
      const sample = prepareCapture(message);
      self.postMessage({ id, type: 'prepared', sample }, [sample.image.data, ...sample.recovery.map(crop => crop.image.data)]);
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
      const analysis = FrameAnalysis.analyze(image);
      if (message.returnImage === true) self.postMessage({ id, type: 'analysis', analysis, image: message.image }, [data]);
      else self.postMessage({ id, type: 'analysis', analysis });
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
