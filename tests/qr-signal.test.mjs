import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), signal = require('../web/qr-signal.js');
const root = new URL('../', import.meta.url);
const load = file => JSON.parse(readFileSync(new URL('tests/fixtures/' + file, root))).cases;
const cases = ['damage-stress-dev.json', 'damage-stress-recovery.json', 'damage-stress-qr-upgrade.json'].flatMap(load);
const targets = cases.filter(f => f.name.startsWith('qr/') && /\/(motion-blur|small-in-frame)-2$/.test(f.name));
const pixels = f => ({ width: f.width, height: f.height, data: new Uint8ClampedArray(inflateSync(Buffer.from(f.rgba_zlib_base64, 'base64'))) });
const native = vm.createContext({ console, URL, WebAssembly, Response, TextDecoder, TextEncoder, performance,
  ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array, Blob,
  async fetch(url) { assert.equal(String(url), 'https://offline.test/zxing_reader.wasm');
    return new Response(readFileSync(new URL('web/vendor/zxing_reader.wasm', root)), { headers: { 'Content-Type': 'application/wasm' } }); }
});
vm.runInContext(readFileSync(new URL('web/vendor/zxing-reader.js', root), 'utf8'), native);
await native.ZXingWASM.prepareZXingModule({ overrides: { locateFile: name => 'https://offline.test/' + name }, fireImmediately: true });
const readNative = (image, options = {}) => native.ZXingWASM.readBarcodes(image, { formats: ['QRCode'], tryHarder: true, returnErrors: false, ...options });
const recover = (image, options = {}) => signal.recover(image, { readNative, timeBudgetMs: 500, ...options });

for (const fixture of targets) test('source QR model recovers ' + fixture.name, async () => {
  const image = pixels(fixture), before = Buffer.from(image.data), found = await recover(image);
  assert.equal(found.complete, true); assert.equal(found.results.length, 1);
  assert.equal(found.results[0].text, fixture.expected[0].text);
  assert.deepEqual(Array.from(found.results[0].bytes), Array.from(new TextEncoder().encode(fixture.expected[0].text)));
  assert.deepEqual(Buffer.from(image.data), before);
  for (const point of Object.values(found.results[0].position)) assert.ok(point.x >= 0 && point.x <= image.width && point.y >= 0 && point.y <= image.height);
});

test('development negatives and clipped QR do not acquire payloads or synthetic quiet margins', async () => {
  for (const fixture of cases.filter(f => !f.expected.length || (f.name.startsWith('qr/') && f.name.endsWith('/clipping-2')))) {
    assert.deepEqual((await recover(pixels(fixture))).results, [], fixture.name);
  }
});

function blur(image, length = 9, vertical = false) {
  const data = new Uint8ClampedArray(image.data), half = length >> 1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const sx = x + (vertical ? 0 : k), sy = y + (vertical ? k : 0);
      sum += sx < 0 || sy < 0 || sx >= image.width || sy >= image.height ? 255 : image.data[(sy * image.width + sx) * 4];
    }
    const index = (y * image.width + x) * 4; data[index] = data[index + 1] = data[index + 2] = Math.round(sum / length);
  }
  return { ...image, data };
}

test('native binary, control, Latin1 and UTF8 bytes survive horizontal and vertical restoration', async () => {
  for (const fixture of load('independent-byte-controls.json').filter(f => f.format === 'QRCode')) {
    const original = pixels(fixture), canonical = (await readNative(original))[0];
    assert.deepEqual(Array.from(canonical.bytes), fixture.encoderBytes);
    for (const vertical of [false, true]) {
      const found = await recover(blur(original, 9, vertical));
      assert.equal(found.complete, true); assert.equal(found.results.length, 1, fixture.name);
      assert.equal(found.results[0].text, canonical.text);
      assert.deepEqual(Array.from(found.results[0].bytes), fixture.encoderBytes);
    }
  }
});

test('invalid native status, wrong format, and unrelated positions cannot become observations', async () => {
  const image = pixels(targets.find(f => f.name.endsWith('/motion-blur-2')));
  for (const change of [result => ({ ...result, isValid: false }), result => ({ ...result, error: 'checksum' }),
    result => ({ ...result, format: 'Code128' }), result => ({ ...result, position: Object.fromEntries(Object.entries(result.position).map(([key, point]) => [key, { x: point.x + 1000, y: point.y }])) })]) {
    const found = await recover(image, { readNative: async (candidate, options) => (await readNative(candidate, options)).map(change) });
    assert.deepEqual(found.results, []);
  }
});

test('source forward fit rejects a restored QR paired with incompatible photographed pixels', () => {
  const input = signal.source(pixels(targets.find(f => f.name.endsWith('/motion-blur-2'))));
  let restored, region, length;
  for (length of [3, 5, 7, 9, 11, 13, 15]) {
    restored = signal.restore(input, length);
    const geometry = require('../web/qr-geometry.js').analyze(restored, { timeBudgetMs: 100, maxRegions: 4 });
    region = geometry.regions.find(r => signal.forwardFit(input, restored, r, length));
    if (region) break;
  }
  assert.ok(region);
  const changed = { ...input, gray: new Uint8Array(input.gray.length).fill(127) };
  assert.equal(signal.forwardFit(changed, restored, region, length), null);
  assert.equal(signal.forwardFit(input, restored, { ...region, clipped: true }, length), null);
});

test('unsupported optical grids and exhausted budgets abstain before native decoding', async () => {
  let calls = 0;
  for (const image of [{ width: 10, height: 10, data: new Uint8ClampedArray(400) }, { width: 21, height: 21, data: new Uint8Array(3) }]) {
    assert.deepEqual((await recover(image, { readNative: () => { calls++; return []; } })).results, []);
  }
  const image = pixels(targets[0]);
  assert.equal((await recover(image, { timeBudgetMs: 0, readNative: () => { calls++; return []; } })).complete, false);
  assert.equal(calls, 0);
  assert.equal(signal.optical({}, { dimension: 61, gridReliable: true, moduleSize: 4 }), null);
  assert.equal(signal.optical({}, { dimension: 21, gridReliable: true, moduleSize: 1 }), null);
});

test('expiration after a verified source observation retains a veto instead of accepting a singleton', async () => {
  let now = 0, positive = false;
  const context = vm.createContext({ ArrayBuffer, Uint8Array, Uint8ClampedArray, Float64Array, performance: { now: () => now } });
  for (const file of ['qr-geometry.js', 'qr-signal.js']) vm.runInContext(readFileSync(new URL('web/' + file, root), 'utf8'), context);
  const fixture = targets.find(f => f.name.endsWith('/motion-blur-2'));
  const found = await context.QRSignal.recover(pixels(fixture), { timeBudgetMs: 500, readNative: async (image, options) => {
    const result = await readNative(image, options);
    if (positive) now = 1000;
    if (result.length) positive = true;
    return result;
  } });
  assert.equal(found.complete, false); assert.ok(found.observed > 0);
  assert.equal(found.diagnostics.incompleteEvidence, true); assert.equal(found.results.length, 0);
});

test('different valid native candidates remain a conflict and never win by threshold score', async () => {
  const fixture = targets.find(f => f.name.endsWith('/small-in-frame-2'));
  let count = 0;
  const found = await recover(pixels(fixture), { readNative: async (image, options) => (await readNative(image, options)).map(result => {
    count++; return count % 2 ? result : { ...result, text: 'conflicting-native-result', bytes: [1, 2, 3] };
  }) });
  assert.equal(found.results.length, 2); assert.notEqual(found.results[0].text, found.results[1].text);
});

test('a single optical threshold hit stays withheld while preserving source evidence', async () => {
  const fixture = targets.find(f => f.name.endsWith('/small-in-frame-2'));
  let emitted = false;
  const found = await recover(pixels(fixture), { readNative: async (image, options) => {
    const result = await readNative(image, options);
    if (emitted || !options.isPure) return [];
    if (result.length) emitted = true;
    return result;
  } });
  assert.equal(found.complete, false); assert.equal(found.observed, 1);
  assert.equal(found.diagnostics.incompleteEvidence, true); assert.deepEqual(found.results, []);
});

function diagonal(first, second) {
  const side = Math.max(first.width, first.height) + Math.max(second.width, second.height) + 20;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const [image, offset] of [[first, 0], [second, Math.max(first.width, first.height) + 20]]) {
    for (let y = 0; y < image.height; y++) data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((y + offset) * side + offset) * 4);
  }
  return { width: side, height: side, data };
}

test('separate physical QR labels preserve separate observations and conflicting values', async () => {
  const labels = targets.filter(f => f.name.includes('qr-upgrade') && f.name.endsWith('/motion-blur-2')).map(pixels);
  for (const second of [labels[0], labels[1]]) {
    const found = await recover(diagonal(labels[0], second));
    assert.equal(found.complete, true); assert.equal(found.results.length, 2);
    assert.ok(Math.abs(found.results[0].position.topLeft.x - found.results[1].position.topLeft.x) > 100);
  }
});
