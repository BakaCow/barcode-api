/** Compare the experimental engine with local ZXing on a human-labelled export. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';

const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}
if (args.includes('--help')) {
  console.log('node tools/benchmark-code128.mjs --fixtures data/local/dev-pixels.json --output data/local/dev-report.json');
  process.exit(0);
}
const fixturePath = option('--fixtures', null);
const outputPath = option('--output', null);
if (!fixturePath || !outputPath) throw new Error('Supply --fixtures and --output. Export a chosen dataset split with tools/dataset.py first.');
if (statSync(fixturePath).size > 70 * 1024 * 1024) throw new Error('Fixture JSON exceeds 70 MiB.');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
if (fixture.version !== 'code128-dataset-v1' || !['train', 'dev', 'test'].includes(fixture.split) ||
    !Array.isArray(fixture.cases) || !fixture.cases.length || fixture.cases.length > 500) {
  throw new Error('Use a nonempty version1 Code128 dataset export with one explicitly selected split.');
}
const groups = new Map(), ids = new Set();
for (const sample of fixture.cases) {
  if (!sample || typeof sample.name !== 'string' || ids.has(sample.name) || typeof sample.groupId !== 'string' || !sample.groupId ||
      sample.split !== fixture.split || !['real', 'synthetic'].includes(sample.source) || sample.reviewRequired ||
      !Number.isInteger(sample.width) || !Number.isInteger(sample.height) || sample.width < 1 || sample.height < 1 ||
      sample.width * sample.height > 4_000_000 || typeof sample.rgba_zlib_base64 !== 'string' ||
      !Array.isArray(sample.expected) || sample.expected.some(item => typeof item.text !== 'string' || !item.text ||
        !Array.isArray(item.formats) || item.formats.length !== 1 || item.formats[0] !== 'Code128')) {
    throw new Error(`Invalid or unreviewed fixture: ${sample?.name || '(unnamed)'}`);
  }
  ids.add(sample.name);
  if (groups.has(sample.groupId) && groups.get(sample.groupId) !== sample.split) throw new Error('A physical label/session crosses dataset splits.');
  groups.set(sample.groupId, sample.split);
}

const globals = {
  console, URL, performance, WebAssembly, Response, TextEncoder, TextDecoder,
  ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array,
  Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  Blob, setTimeout, clearTimeout,
  ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
};
const custom = vm.createContext({ ...globals });
custom.self = custom;
const enginePaths = ['code128-decoder.js', 'code128-detector.js', 'code128-engine.js'];
const engineHash = createHash('sha256');
for (const filename of enginePaths) {
  const source = readFileSync(resolve(project, 'web/engine', filename), 'utf8').replace(/\r\n/g, '\n');
  engineHash.update(filename + '\0').update(source);
  vm.runInContext(source, custom, { filename });
}
assert.equal(typeof custom.Code128Engine?.read, 'function', 'custom engine exposes read(image)');

const wasm = readFileSync(resolve(project, 'web/vendor/zxing_reader.wasm'));
const baseline = vm.createContext({ ...globals,
  location: { href: 'https://offline.test/scan/vendor/zxing-reader.js' },
  fetch: async url => {
    assert.equal(String(url), 'https://offline.test/scan/vendor/zxing_reader.wasm', 'benchmark dependencies stay local');
    return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
  },
});
baseline.self = baseline;
vm.runInContext(readFileSync(resolve(project, 'web/vendor/zxing-reader.js'), 'utf8'), baseline);
await baseline.ZXingWASM.prepareZXingModule({ fireImmediately: true,
  overrides: { locateFile: () => 'https://offline.test/scan/vendor/zxing_reader.wasm' } });

const readers = {
  experimental: image => custom.Code128Engine.read(image),
  zxing: image => baseline.ZXingWASM.readBarcodes(new baseline.ImageData(image.data, image.width, image.height),
    { formats: ['Code128'], tryHarder: true, tryRotate: true, tryInvert: true, returnErrors: false }),
};
function inspect(found, expected) {
  if (!Array.isArray(found)) throw new Error('Engine returned an invalid result array.');
  const results = found.filter(item => item.isValid !== false && !item.error).map(item => ({ text: item.text, format: item.format }));
  const matches = (actual, truth) => actual.text === truth.text && truth.formats.includes(actual.format);
  const missing = expected.filter(truth => !results.some(actual => matches(actual, truth)));
  const unexpected = results.filter(actual => !expected.some(truth => matches(actual, truth)));
  return { exact: missing.length === 0 && unexpected.length === 0,
    missing: missing.map(item => item.text), unexpected, results };
}
const cases = [];
for (const sample of fixture.cases) {
  const rgba = inflateSync(Buffer.from(sample.rgba_zlib_base64, 'base64'), { maxOutputLength: 16_000_000 });
  if (rgba.byteLength !== sample.width * sample.height * 4) throw new Error(`Invalid pixel buffer: ${sample.name}`);
  const record = { id: sample.name, source: sample.source, device: sample.device, groupId: sample.groupId,
    conditions: sample.conditions, expected: sample.expected, engines: {} };
  for (const [name, read] of Object.entries(readers)) {
    const image = { data: new Uint8ClampedArray(rgba), width: sample.width, height: sample.height };
    const started = performance.now();
    try {
      const found = await read(image);
      record.engines[name] = { ...inspect(found, sample.expected), durationMs: +(performance.now() - started).toFixed(3) };
    } catch (error) {
      record.engines[name] = { exact: false, unexpected: [], error: error.message,
        durationMs: +(performance.now() - started).toFixed(3) };
    }
  }
  cases.push(record);
}
function summarize(name, selected = cases) {
  const positives = selected.filter(item => item.expected.length), negatives = selected.filter(item => !item.expected.length);
  const correct = positives.filter(item => item.engines[name].exact).length;
  const negativeWrong = negatives.filter(item => item.engines[name].unexpected.length).length;
  const wrong = selected.filter(item => item.engines[name].unexpected.length).length;
  const times = selected.map(item => item.engines[name].durationMs).sort((a, b) => a - b);
  return { images: selected.length, positiveImages: positives.length, exactPositiveReads: correct,
    correctReadRate: positives.length ? correct / positives.length : null,
    negativeImages: negatives.length, negativeFalsePositives: negativeWrong,
    negativeFalsePositiveRate: negatives.length ? negativeWrong / negatives.length : null,
    imagesWithWrongRead: wrong, wrongReadImageRate: selected.length ? wrong / selected.length : null,
    errors: selected.filter(item => item.engines[name].error).length,
    medianDecodeMs: times.length ? times[Math.floor(times.length / 2)] : null,
    p95DecodeMs: times.length ? times[Math.ceil(times.length * 0.95) - 1] : null,
    timeToConfirmedResultMs: null };
}
const sourceCounts = Object.fromEntries(['real', 'synthetic'].map(source => [source, cases.filter(item => item.source === source).length]));
const report = {
  schemaVersion: 1, split: fixture.split, sourceCounts, distinctGroups: groups.size,
  scope: 'One pass per labelled still image. Host decoding time excludes capture, startup and live-frame confirmation. A real source label describes the supplied media, not proof of phone performance or label quality. No Scanbot comparison.',
  manifestSha256: fixture.manifestSha256,
  // Semantic JSON hash avoids platform-specific LF/CRLF differences.
  fixtureSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
  experimentalSourceSha256: engineHash.digest('hex'),
  zxingWasmSha256: createHash('sha256').update(wasm).digest('hex'),
  hashMethods: {
    experimentalSourceSha256: 'SHA-256 of ordered filename + NUL + UTF-8 source, with CRLF normalized to LF, for decoder/detector/engine.',
    fixtureSha256: 'SHA-256 of JSON.stringify(parsed fixture); ignores JSON whitespace and file line endings, retains object key order.',
    manifestSha256: 'SHA-256 of UTF-8 manifest JSON with sorted object keys and compact separators, provided by the Python exporter.',
    zxingWasmSha256: 'SHA-256 of the raw binary WASM bytes.',
  },
  summaries: Object.fromEntries(Object.keys(readers).map(name => [name, summarize(name)])),
  bySource: Object.fromEntries(['real', 'synthetic'].map(source => [source,
    Object.fromEntries(Object.keys(readers).map(name => [name, summarize(name, cases.filter(item => item.source === source))]))])),
  cases,
};
mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ split: report.split, sourceCounts, summaries: report.summaries }, null, 2));
console.log(`Detailed report: ${outputPath}`);
if (Object.values(report.summaries).some(summary => summary.errors || summary.imagesWithWrongRead)) process.exitCode = 1;
