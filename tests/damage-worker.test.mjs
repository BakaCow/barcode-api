import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';

// Pixel fixtures and expected payloads were generated independently of decoding.
// Discovered wrong reads are explicitly promoted to regressions; the fresh
// verification split for the current update is never loaded here. Earlier
// accuracy-next and signal-update verification are now development data.
const project = new URL('../', import.meta.url);
const source = readFileSync(new URL('web/scanner-worker.js', project), 'utf8');
const reader = readFileSync(new URL('web/vendor/zxing-reader.js', project), 'utf8');
const wasm = readFileSync(new URL('web/vendor/zxing_reader.wasm', project));
const development = ['accuracy-pixels.json', 'damage-stress-dev.json', 'damage-regressions.json', 'damage-stress-accuracy-next.json', 'damage-stress-signal-upgrade.json'].flatMap((name) =>
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
    assert.ok(['./vendor/zxing-reader.js', './pos-policy.js', './qr-geometry.js', './qr-recovery.js', './linear-signal.js', './qr-signal.js', './qr-damage.js', './independent-reader.js', './vendor/zbar/index.js',
      './engine/code128-decoder.js', './engine/code128-detector.js', './engine/code128-engine.js'].includes(path), path);
    vm.runInContext(path === './vendor/zxing-reader.js' ? reader : readFileSync(new URL('web/' + path.slice(2), project), 'utf8'), context);
  },
  async fetch(url) {
    const assets = { 'https://offline.test/scan/vendor/zxing_reader.wasm': wasm,
      'https://offline.test/scan/vendor/zbar/zbar.wasm': readFileSync(new URL('web/vendor/zbar/zbar.wasm', project)) };
    assert.ok(assets[String(url)], String(url));
    return new Response(assets[String(url)], { headers: { 'Content-Type': 'application/wasm' } });
  },
  postMessage(message) { messages.set(message.id, message); },
});
context.self = context;
vm.runInContext(source, context);

async function decode(name, options = {}) {
  const fixture = fixtures.get(name);
  assert.ok(fixture, `Missing development fixture ${name}`);
  const pixels = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
  const image = { width: fixture.width, height: fixture.height,
    data: pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength) };
  const id = ++sequence;
  await context.onmessage({ data: { id, type: 'decode', image, mode: 'image', ...options } });
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
  'qr/dev-qr-label-1/scratches-1', 'qr/next-qr-label-3/scratches-1',
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
    // Signal recovery now inspects both planned families, including bounded QR
    // exposure proposals, even when the accepted symbol is linear.
    const extended = fixture.name.startsWith('qr/') || response.diagnostics.signalComplete !== undefined;
    assert.ok(response.diagnostics.passes <= (extended ? 64 : 8), JSON.stringify(response.diagnostics));
  });
}

test('clipped EAN-13 never becomes a plausible unchecked ITF read during recovery', async () => {
  const { response } = await decode('ean13/dev-ean13-label-3/clipping-2');
  assert.deepEqual(response.results, [], 'missing barcode bars must produce a miss, not ITF 8650');
});

test('damaged EAN source conflict withholds a false UPC-E and restricted reading recovers exact EAN', async () => {
  const name = 'ean13/signal-upgrade-ean13-label-1/missing-patch-1';
  const unrestricted = await decode(name);
  assert.ok(unrestricted.response.results.every(result => result.format === 'EAN13' && result.text === unrestricted.fixture.expected[0].text));
  if (!unrestricted.response.results.length) assert.equal(unrestricted.response.diagnostics.incompleteEvidence, true);
  const restricted = await decode(name, { posOptions: { allowedFormats: ['ean13'], confirmationFrames: 1 } });
  assert.equal(restricted.response.results.length, 1);
  assert.equal(restricted.response.results[0].text, restricted.fixture.expected[0].text);
  assert.equal(restricted.response.results[0].format, 'EAN13');
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
