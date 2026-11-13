import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';

// Pixel fixtures and expected payloads were generated independently of decoding.
// Discovered wrong reads are explicitly promoted to regressions; the fresh
// verification split is never loaded or used to select these expectations.
const project = new URL('../', import.meta.url);
const source = readFileSync(new URL('web/scanner-worker.js', project), 'utf8');
const reader = readFileSync(new URL('web/vendor/zxing-reader.js', project), 'utf8');
const wasm = readFileSync(new URL('web/vendor/zxing_reader.wasm', project));
const development = ['accuracy-pixels.json', 'damage-stress-dev.json', 'damage-regressions.json'].flatMap((name) =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')).cases);
const fixtures = new Map(development.map((entry) => [entry.name, entry]));
const messages = new Map();
let context, sequence = 0;
context = vm.createContext({
  console, URL, WebAssembly, Response, TextDecoder, TextEncoder, performance,
  ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array,
  Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, Blob,
  ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
  location: { href: 'https://offline.test/scan/scanner-worker.js' },
  importScripts(path) {
    assert.equal(path, './vendor/zxing-reader.js');
    vm.runInContext(reader, context);
  },
  async fetch(url) {
    assert.equal(String(url), 'https://offline.test/scan/vendor/zxing_reader.wasm');
    return new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
  },
  postMessage(message) { messages.set(message.id, message); },
});
context.self = context;
vm.runInContext(source, context);

async function decode(name) {
  const fixture = fixtures.get(name);
  assert.ok(fixture, `Missing development fixture ${name}`);
  const pixels = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
  const image = { width: fixture.width, height: fixture.height,
    data: pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) };
  const id = ++sequence;
  await context.onmessage({ data: { id, type: 'decode', image, mode: 'image' } });
  const response = messages.get(id); messages.delete(id);
  assert.equal(response?.type, 'result', response?.message);
  return { fixture, response: JSON.parse(JSON.stringify(response)) };
}

for (const name of [
  'code128/rotate-17', 'code128/rotate-73', 'code128/weak-shaded', 'ean13/weak-shaded', 'code128/inverted',
  'code128/downsampled', 'ean13/downsampled', 'datamatrix/downsampled',
  'code128/dev-code128-label-3/angled-2', 'code128/dev-code128-label-1/shading-lowcontrast-2',
  'ean13/dev-ean13-label-2/blur-2', 'qr/dev-qr-label-2/clean-0',
  'qr/dev-qr-label-1/motion-blur-1', 'qr/dev-qr-label-1/blur-2',
  'qr/dev-qr-label-2/blur-2', 'qr/dev-qr-label-3/motion-blur-1', 'qr/dev-qr-label-3/blur-2',
  'ean13/dev-ean13-label-1/motion-blur-1', 'ean13/dev-ean13-label-1/blur-2',
  'ean13/dev-ean13-label-3/motion-blur-1',
]) {
  test(`real WASM recovers the exact payload without extra reads: ${name}`, async () => {
    const { fixture, response } = await decode(name);
    const matches = (found, expected) => found.text === expected.text && expected.formats.includes(found.format);
    for (const expected of fixture.expected) {
      assert.ok(response.results.some((found) => matches(found, expected)), JSON.stringify(response));
    }
    for (const found of response.results) {
      assert.ok(fixture.expected.some((expected) => matches(found, expected)), `Unexpected ${JSON.stringify(found)}`);
      for (const point of Object.values(found.position)) {
        assert.ok(point.x >= 0 && point.x <= fixture.width);
        assert.ok(point.y >= 0 && point.y <= fixture.height);
      }
    }
    assert.ok(response.diagnostics.passes <= 7);
  });
}

test('clipped EAN-13 never becomes a plausible unchecked ITF read during recovery', async () => {
  const { response } = await decode('ean13/dev-ean13-label-3/clipping-2');
  assert.deepEqual(response.results, [], 'missing barcode bars must produce a miss, not ITF 8650');
});

test('an oblique transformed scanline cannot turn invalid EAN bars into UPC-E', async () => {
  const { response } = await decode('regression/invalid-ean13-oblique-upce');
  assert.deepEqual(response.results, [], 'a coincidentally valid UPC checksum cannot override incompatible source bars');
});

for (const name of [
  'negative/invalid-code128-checksum/1', 'negative/invalid-ean13-checksum/1',
  'negative/short-random-bars/1', 'negative/finder-lookalikes/1',
]) {
  test(`damage recovery rejects an independent negative: ${name}`, async () => {
    const { response } = await decode(name);
    assert.deepEqual(response.results, []);
  });
}
