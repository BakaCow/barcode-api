/** Compare exact reads using the shipped offline worker and WASM, without a browser. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}
const workerPath = option('--worker', resolve(root, 'web/scanner-worker.js'));
const corpusPath = option('--corpus', resolve(root, 'tests/fixtures/accuracy-pixels.json'));
const outputPath = option('--output', null);
const mode = option('--mode', 'image');
const retryIndex = Number(option('--retry-index', '0'));
if (!Number.isSafeInteger(retryIndex) || retryIndex < 0) throw new Error('--retry-index must be a nonnegative integer');
const enhanceIndex = args.indexOf('--enhance-live');
const enhanceLive = enhanceIndex !== -1;
if (args.filter((arg) => arg === '--enhance-live').length > 1 ||
    enhanceLive && args[enhanceIndex + 1] && !args[enhanceIndex + 1].startsWith('--')) {
  throw new Error('--enhance-live is a flag without a value and must be supplied once.');
}
if (args.filter((arg) => arg === '--pos-formats').length > 1) throw new Error('--pos-formats must be supplied once.');
const formatList = option('--pos-formats', null);
let posOptions;
if (formatList !== null) {
  const require = createRequire(import.meta.url);
  const policy = require(resolve(root, 'web/pos-policy.js'));
  posOptions = policy.validateOptions({ allowedFormats: formatList.split(',').map((name) => name.trim()), confirmationFrames: 1 });
}
const profileEnabled = enhanceLive || posOptions !== undefined;
const dependencySha256 = {};
for (const filename of [...(enhanceLive ? ['frame-analysis.js'] : []), ...(posOptions ? ['pos-policy.js'] : [])]) {
  const normalized = readFileSync(resolve(root, 'web', filename), 'utf8').replace(/\r\n/g, '\n');
  dependencySha256[filename] = createHash('sha256').update(normalized).digest('hex');
}
const workerSource = readFileSync(workerPath, 'utf8');
const readerSource = readFileSync(resolve(root, 'web/vendor/zxing-reader.js'), 'utf8');
const wasmBytes = readFileSync(resolve(root, 'web/vendor/zxing_reader.wasm'));
const corpusBytes = readFileSync(corpusPath);
const fixtures = JSON.parse(corpusBytes);
const base = 'https://offline.test/scan/';
const messages = new Map();
let context;
const globals = {
  console, URL, WebAssembly, Response, TextDecoder, TextEncoder, performance,
  ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array,
  Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  Blob, setTimeout, clearTimeout,
  ImageData: class ImageData {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  },
  location: { href: new URL('scanner-worker.js', base).href },
  importScripts(...paths) {
    for (const path of paths) {
      assert.ok(path.startsWith('./') && !path.includes('..'), 'worker imports must stay in its web folder');
      const source = path === './vendor/zxing-reader.js' ? readerSource : readFileSync(resolve(root, 'web', path), 'utf8');
      vm.runInContext(source, context, { filename: path });
    }
  },
  async fetch(url) {
    assert.equal(String(url), new URL('vendor/zxing_reader.wasm', base).href, 'all WASM dependencies remain local');
    return new Response(wasmBytes, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
  },
  postMessage(message) { messages.set(message.id, message); },
};
context = vm.createContext(globals);
context.self = context;
vm.runInContext(workerSource, context, { filename: 'scanner-worker.js' });
let id = 0;
async function send(message) {
  const requestId = ++id;
  await context.onmessage({ data: { ...message, id: requestId } });
  const response = messages.get(requestId);
  messages.delete(requestId);
  assert.ok(response, 'worker responds to every request');
  return response;
}
assert.equal((await send({ type: 'init' })).type, 'ready');
const results = [];
for (const fixture of fixtures.cases) {
  const rgba = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
  const image = { width: fixture.width, height: fixture.height, data: rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) };
  const start = performance.now();
  const response = await send({ type: 'decode', image, mode, retryIndex,
    ...(enhanceLive ? { enhanceLive: true } : {}), ...(posOptions ? { posOptions } : {}) });
  const durationMs = performance.now() - start;
  const found = response.results || [];
  const expected = fixture.expected;
  const matches = (a, b) => a.text === b.text && b.formats.includes(a.format);
  const missing = expected.filter((item) => !found.some((result) => matches(result, item)));
  const unexpected = found.filter((result) => !expected.some((item) => matches(result, item)));
  results.push({ name: fixture.name, expectedCount: expected.length,
    exact: response.type === 'result' && !missing.length && !unexpected.length,
    missing: missing.map((item) => item.text),
    unexpected: unexpected.map(({ text, format }) => ({ text, format })),
    durationMs: +durationMs.toFixed(2), ...(response.diagnostics ? { diagnostics: response.diagnostics } : {}),
    ...(response.type === 'error' ? { error: response.message } : {}),
  });
}
const positives = results.filter((item) => item.expectedCount);
const negatives = results.filter((item) => !item.expectedCount);
const times = results.map((item) => item.durationMs).sort((a, b) => a - b);
const report = {
  description: profileEnabled ? 'Fixed synthetic images, one warmed worker invocation per case, including optional region retries and format restriction. This does not exercise camera capture, frame selection or POS confirmation. Latency is host-specific and excludes WASM startup and image import. This is not a Scanbot or real-device comparison.' :
    'Fixed synthetic images, one warmed decoder pass per case. Latency is host-specific and excludes camera capture, WASM startup, image import, and UI confirmation. This is not a Scanbot or real-device comparison.',
  worker: workerPath, corpusVersion: fixtures.version,
  corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'),
  workerSha256: createHash('sha256').update(workerSource).digest('hex'), mode, retryIndex,
  ...(profileEnabled ? {
    settings: { enhanceLive, posOptions: posOptions || null, cameraFrameSelection: false, posConfirmation: false },
    dependencySha256,
  } : {}),
  summary: { total: results.length, positives: positives.length, exactPositiveReads: positives.filter((item) => item.exact).length,
    negatives: negatives.length, negativesCorrectlyRejected: negatives.filter((item) => item.exact).length,
    unexpectedResults: results.reduce((sum, item) => sum + item.unexpected.length, 0),
    errors: results.filter((item) => item.error).length,
    medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1],
  },
  cases: results,
};
if (outputPath) writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
console.log('Unsuccessful positive cases:', positives.filter((item) => !item.exact).map((item) => item.name).join(', ') || 'none');
if (report.summary.unexpectedResults || report.summary.errors) process.exitCode = 1;
