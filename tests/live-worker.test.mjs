import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';

const project = new URL('../', import.meta.url);
const workerSource = readFileSync(new URL('web/scanner-worker.js', project), 'utf8');
const wasm = readFileSync(new URL('web/vendor/zxing_reader.wasm', project));
const basicFixtures = JSON.parse(readFileSync(new URL('fixtures/barcode-pixels.json', import.meta.url))).cases;
const caseFrom = (filename, name) => JSON.parse(readFileSync(new URL(`fixtures/${filename}`, import.meta.url))).cases.find((entry) => entry.name === name);

function imageFor(fixture) {
  const pixels = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
  return { width: fixture.width, height: fixture.height,
    data: pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) };
}
function blank(width = 120, height = 60) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255).buffer };
}
const points = { topLeft: { x: 2, y: 2 }, topRight: { x: 18, y: 2 },
  bottomRight: { x: 18, y: 18 }, bottomLeft: { x: 2, y: 18 } };
const valid = (text = 'one', format = 'QRCode') => ({
  isValid: true, error: '', format, text, bytes: new TextEncoder().encode(text), position: points,
});

function harness({ read, frameAnalysis, clock = performance } = {}) {
  const calls = [], imports = [], responses = [], fetches = [];
  let initialized = 0, context;
  context = vm.createContext({
    console, URL, WebAssembly, Response, TextDecoder, TextEncoder, Blob,
    performance: clock, ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array,
    Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array,
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    location: { href: 'https://offline.test/nested/scanner-worker.js' },
    importScripts(path) {
      assert.ok(['./vendor/zxing-reader.js', './pos-policy.js', './frame-analysis.js'].includes(path), path);
      imports.push(path);
      if (path === './vendor/zxing-reader.js' && read) {
        context.ZXingWASM = {
          prepareZXingModule: async () => { initialized++; },
          readBarcodes: async (image, options) => { calls.push({ image, options }); return read(image, options, calls.length); },
        };
      } else if (path === './frame-analysis.js' && frameAnalysis) {
        context.FrameAnalysis = frameAnalysis;
      } else {
        vm.runInContext(readFileSync(new URL(`web/${path.slice(2)}`, project), 'utf8'), context, { filename: path });
      }
    },
    async fetch(url) {
      fetches.push(String(url));
      assert.equal(String(url), 'https://offline.test/nested/vendor/zxing_reader.wasm');
      return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
    },
    postMessage(message) { responses.push(message); },
  });
  context.self = context;
  vm.runInContext(workerSource, context, { filename: 'scanner-worker.js' });
  return {
    calls, imports, fetches, context,
    get initialized() { return initialized; },
    async send(message) {
      await context.onmessage({ data: { id: responses.length + 1, type: 'decode', ...message } });
      return JSON.parse(JSON.stringify(responses.at(-1)));
    },
  };
}

function proposedRegions(count = 3) {
  const regions = Array.from({ length: count }, (_, index) => ({ x: index * 35, y: 10, width: 30, height: 30, score: 20 - index, kind: 'matrix' }));
  return {
    analyze: () => ({ score: 12, hint: null, fingerprint: 'original-pixels', regions }),
    crop: (_image, region) => ({ image: blank(region.width, region.height), mapPoint: ({ x, y }) => ({ x: x + region.x, y: y + region.y }) }),
  };
}

test('quality analysis loads only local analysis code and never initializes or calls WASM', async () => {
  const worker = harness({ read: () => assert.fail('analysis must not decode') });
  const response = await worker.send({ type: 'analyze', image: blank() });
  assert.equal(response.type, 'analysis');
  assert.ok(Number.isFinite(response.analysis.score));
  assert.ok(response.analysis.fingerprint.length > 0);
  assert.equal(worker.initialized, 0);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(worker.imports, ['./vendor/zxing-reader.js', './frame-analysis.js']);
});

test('POS options are checked before native initialization and decoding', async () => {
  for (const posOptions of [null, { allowedFormats: [] }, { allowedFormats: ['unknown'] },
    { confirmationFrames: true }, { confirmationFrames: 4 }, { extra: true }]) {
    const worker = harness({ read: () => assert.fail('invalid options reached decoding') });
    const response = await worker.send({ image: blank(), posOptions });
    assert.equal(response.type, 'error', JSON.stringify(posOptions));
    assert.equal(worker.initialized, 0);
    assert.equal(worker.calls.length, 0);
  }
});

test('POS restrictions reach every native pass and defensively reject disallowed native results', async () => {
  const worker = harness({ read: () => [valid('disallowed', 'Code128')] });
  const response = await worker.send({ image: blank(), mode: 'image', posOptions: { allowedFormats: ['qr'] } });
  assert.equal(response.type, 'result');
  assert.deepEqual(response.results, []);
  assert.ok(worker.calls.length > 1);
  for (const call of worker.calls) assert.deepEqual(Array.from(call.options.formats), ['QRCode']);
});

test('enhanced decoding checks the full image first and retains all conflicting results', async () => {
  const frameAnalysis = proposedRegions();
  frameAnalysis.crop = () => assert.fail('a successful full-image read must not be replaced by a crop');
  const worker = harness({ read: () => [valid('one'), valid('two')], frameAnalysis });
  const response = await worker.send({ image: blank(), mode: 'live', enhanceLive: true,
    posOptions: { allowedFormats: ['qr'] } });
  assert.equal(worker.calls.length, 1);
  assert.deepEqual(response.results.map((item) => item.text), ['one', 'two']);
  assert.equal(response.analysis.fingerprint, 'original-pixels');
  assert.equal(response.diagnostics.strategy, 'original');
});

test('live crop retries stay bounded, preserve all distinct candidates and map source coordinates', async () => {
  const worker = harness({ read: (_image, _options, count) => count === 1 ? [] : [valid(`crop-${count}`)],
    frameAnalysis: proposedRegions() });
  const response = await worker.send({ image: blank(), mode: 'live', enhanceLive: true,
    posOptions: { allowedFormats: ['qr'] } });
  assert.equal(worker.calls.length, 3, 'full image plus at most two crops');
  assert.deepEqual(response.results.map((item) => item.text), ['crop-2', 'crop-3']);
  assert.deepEqual(response.results[0].position.topLeft, { x: 2, y: 12 });
  assert.deepEqual(response.results[1].position.topLeft, { x: 37, y: 12 });
  assert.equal(response.diagnostics.strategy, 'barcode-crop');
  for (const call of worker.calls) assert.deepEqual(Array.from(call.options.formats), ['QRCode']);
});

test('overlapping crops cannot duplicate the same candidate identity', async () => {
  const worker = harness({ read: (_image, _options, count) => count === 1 ? [] : [valid('same')], frameAnalysis: proposedRegions() });
  const response = await worker.send({ image: blank(), mode: 'live', enhanceLive: true });
  assert.equal(worker.calls.length, 3);
  assert.equal(response.results.length, 1);
});

test('crop retries cannot accept unchecked or source-incompatible linear results', async () => {
  for (const format of ['ITF', 'Code39', 'Codabar', 'Code128']) {
    const worker = harness({ read: (_image, _options, count) => count === 1 ? [] : [valid('false', format)], frameAnalysis: proposedRegions() });
    const response = await worker.send({ image: blank(), mode: 'live', enhanceLive: true });
    assert.deepEqual(response.results, [], format);
    assert.ok(worker.calls.length <= 4, 'full image, two crops, one fallback');
    for (const call of worker.calls.slice(1)) assert.ok(!call.options.formats.includes('ITF'));
  }
});

test('the live deadline prevents starting crop or recovery work after a slow native pass', async () => {
  let now = 0;
  const frameAnalysis = proposedRegions();
  frameAnalysis.crop = () => assert.fail('deadline passed before crop allocation');
  const worker = harness({ clock: { now: () => now }, frameAnalysis,
    read: () => { now = 351; return []; } });
  const response = await worker.send({ image: blank(), mode: 'live', enhanceLive: true });
  assert.deepEqual(response.results, []);
  assert.equal(worker.calls.length, 1);
});

test('malformed enhancement settings and analysis buffers fail without native decoding', async () => {
  const worker = harness({ read: () => assert.fail('malformed input reached decoding') });
  for (const request of [{ image: blank(), enhanceLive: 'true' },
    { type: 'analyze', image: { width: 5, height: 5, data: new ArrayBuffer(4) } }]) {
    assert.equal((await worker.send(request)).type, 'error');
  }
  assert.equal(worker.initialized, 0);
});

const actual = harness();
test('actual bundled decoder rejects an unrequested clean format on the first pass', async () => {
  const fixture = basicFixtures.find((item) => item.name === 'Code 128');
  const response = await actual.send({ image: imageFor(fixture), mode: 'image', posOptions: { allowedFormats: ['qr'] } });
  assert.equal(response.type, 'result', response.message);
  assert.deepEqual(response.results, []);
});

test('actual bundled decoder preserves a multi-code full image for POS ambiguity handling', async () => {
  const fixture = basicFixtures.find((item) => item.name === 'Multiple QR codes');
  const response = await actual.send({ image: imageFor(fixture), mode: 'live', enhanceLive: true, posOptions: { allowedFormats: ['qr'] } });
  assert.equal(response.type, 'result', response.message);
  assert.equal(response.results.length, 2);
  assert.deepEqual(response.results.map((item) => item.text).sort(), fixture.expected.map((item) => item.text).sort());
  assert.equal(response.diagnostics.passes, 1);
  assert.ok(response.analysis.fingerprint);
});

// This previously reported verification failure is deliberately a regression
// now; it is not new held-out evidence for this update.
test('the known angled EAN/UPC-E conflict is restricted before native decoding', async () => {
  const fixture = caseFrom('damage-stress-verify.json', 'ean13/verify-ean13-label-2/angled-2');
  const restricted = await actual.send({ image: imageFor(fixture), mode: 'image', posOptions: { allowedFormats: ['ean13'] } });
  assert.equal(restricted.type, 'result', restricted.message);
  assert.deepEqual(restricted.results.map(({ text, format }) => ({ text, format })), [{ text: fixture.expected[0].text, format: 'EAN13' }]);
  const unrestricted = await actual.send({ image: imageFor(fixture), mode: 'image', posOptions: { allowedFormats: ['ean13', 'upce'] } });
  assert.equal(unrestricted.type, 'result', unrestricted.message);
  assert.deepEqual(unrestricted.results.map(({ text, format }) => ({ text, format })).sort((a, b) => a.format.localeCompare(b.format)),
    [{ text: fixture.expected[0].text, format: 'EAN13' }, { text: '0169100005107', format: 'UPCE' }]);
});

test('enhanced real decoding keeps invalid-checksum damage as a miss', async () => {
  const fixture = caseFrom('damage-regressions.json', 'regression/invalid-ean13-oblique-upce');
  const response = await actual.send({ image: imageFor(fixture), mode: 'image', enhanceLive: true,
    posOptions: { allowedFormats: ['ean13', 'upce'] } });
  assert.equal(response.type, 'result', response.message);
  assert.deepEqual(response.results, []);
  assert.ok(response.diagnostics.passes <= 10);
});

test('enhanced real scanning needs no external code or network resources', async () => {
  const fixture = basicFixtures.find((item) => item.name === 'QR code');
  const response = await actual.send({ image: imageFor(fixture), mode: 'live', enhanceLive: true, posOptions: {} });
  assert.equal(response.type, 'result', response.message);
  assert.equal(response.results[0].text, fixture.expected[0].text);
  assert.deepEqual(actual.fetches, ['https://offline.test/nested/vendor/zxing_reader.wasm']);
  assert.ok(actual.imports.includes('./pos-policy.js'));
  assert.ok(actual.imports.includes('./frame-analysis.js'));
});

for (const [fixtureName, format] of [['QR code', 'qr'], ['Code 128', 'code128']]) {
  test(`real ${fixtureName} crop decoding returns original off-centre coordinates after a forced full-frame miss`, async () => {
    const fixture = basicFixtures.find((item) => item.name === fixtureName), label = imageFor(fixture);
    const image = blank(fixture.width + 450, fixture.height + 270), pixels = new Uint8ClampedArray(image.data);
    const source = new Uint8ClampedArray(label.data), x = 70, y = 50;
    for (let row = 0; row < fixture.height; row++) {
      pixels.set(source.subarray(row * fixture.width * 4, (row + 1) * fixture.width * 4), ((y + row) * image.width + x) * 4);
    }
    const worker = harness(), nativeRead = worker.context.ZXingWASM.readBarcodes;
    let calls = 0;
    // Force only the primary miss to exercise crop routing deterministically.
    // Region detection, cropped pixels, native crop decoding and coordinate
    // mapping are real. This test does not claim the original was unreadable.
    worker.context.ZXingWASM.readBarcodes = async (...args) => ++calls === 1 ? [] : nativeRead(...args);
    const response = await worker.send({ image, mode: 'image', enhanceLive: true,
      posOptions: { allowedFormats: [format] } });
    assert.equal(response.type, 'result', response.message);
    assert.equal(response.diagnostics.strategy, 'barcode-crop');
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0].text, fixture.expected[0].text);
    assert.ok(calls >= 2 && calls <= 3);
    for (const point of Object.values(response.results[0].position)) {
      assert.ok(point.x >= x && point.x <= x + fixture.width, JSON.stringify(point));
      assert.ok(point.y >= y && point.y <= y + fixture.height, JSON.stringify(point));
    }
  });
}
