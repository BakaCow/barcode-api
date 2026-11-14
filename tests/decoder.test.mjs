import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';

const project = new URL('../', import.meta.url);
const workerSource = readFileSync(new URL('web/scanner-worker.js', project), 'utf8');
const readerSource = readFileSync(new URL('web/vendor/zxing-reader.js', project), 'utf8');
const wasmBytes = readFileSync(new URL('web/vendor/zxing_reader.wasm', project));
const fixtures = JSON.parse(readFileSync(new URL('fixtures/barcode-pixels.json', import.meta.url), 'utf8'));

/** Exercise the shipped worker with real WASM; every dependency is read locally. */
function decoderHarness(base = 'https://offline.test/scan/') {
  const requests = [];
  const messages = [];
  const localWasm = new Map(['vendor/zxing_reader.wasm', 'vendor/zbar/zbar.wasm'].map(path =>
    [new URL(path, base).href, readFileSync(new URL('web/' + path, project))]));
  let context;
  const globals = {
    console, URL, WebAssembly, Response, TextDecoder, TextEncoder, performance,
    ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array,
    Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
    Blob,
    ImageData: class ImageData {
      constructor(data, width, height) { Object.assign(this, { data, width, height }); }
    },
    location: { href: new URL('scanner-worker.js', base).href },
    importScripts(path) {
      assert.ok(['./vendor/zxing-reader.js', './vendor/zbar/index.js', './independent-reader.js',
        './qr-geometry.js', './qr-recovery.js',
        './engine/code128-decoder.js', './engine/code128-detector.js', './engine/code128-engine.js'].includes(path), path);
      vm.runInContext(readFileSync(new URL('web/' + path.slice(2), project), 'utf8'), context, { filename: path });
    },
    async fetch(url) {
      requests.push(String(url));
      assert.ok(localWasm.has(String(url)), 'decoding must never contact a CDN or API server');
      return new Response(localWasm.get(String(url)), { status: 200, headers: { 'Content-Type': 'application/wasm' } });
    },
    postMessage(message) { messages.push(message); },
  };
  context = vm.createContext(globals);
  context.self = context;
  vm.runInContext(workerSource, context, { filename: 'scanner-worker.js' });
  let sequence = 0;
  return {
    requests,
    async send(payload) {
      const id = ++sequence;
      await context.onmessage({ data: { ...payload, id } });
      const response = messages.find((message) => message.id === id);
      assert.ok(response, `worker responded to request ${id}`);
      return JSON.parse(JSON.stringify(response));
    },
  };
}

function imageFor(fixture) {
  const rgba = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
  return {
    width: fixture.width,
    height: fixture.height,
    data: rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength),
  };
}

const decoder = decoderHarness();

test('worker starts from local assets and reuses its initialized decoder', async () => {
  assert.equal((await decoder.send({ type: 'init' })).type, 'ready');
  assert.equal((await decoder.send({ type: 'init' })).type, 'ready');
  assert.equal(decoder.requests.length, 2);
  assert.equal(new Set(decoder.requests).size, 2, 'each local engine is initialized once');
});

test('worker also resolves its assets under a GitHub Pages project subpath', async () => {
  const nested = decoderHarness('https://offline.test/barcode-api/');
  const response = await nested.send({ type: 'decode', image: imageFor(fixtures.cases[0]) });
  assert.equal(response.type, 'result', response.message);
  assert.equal(response.results[0].text, 'offline-camera-42');
  assert.deepEqual([...nested.requests].sort(), ['https://offline.test/barcode-api/vendor/zxing_reader.wasm',
    'https://offline.test/barcode-api/vendor/zbar/zbar.wasm'].sort());
});

for (const fixture of fixtures.cases) {
  test(`actual WASM decoder: ${fixture.name}`, async () => {
    const response = await decoder.send({ type: 'decode', image: imageFor(fixture) });
    assert.equal(response.type, 'result', response.message);
    if (fixture.name === 'Blank image') {
      assert.deepEqual(response.results, []);
      return;
    }
    const expected = fixture.name === 'UPC-A' ? [fixture.expected] : fixture.expected.map((item) => [item]);
    for (const alternatives of expected) {
      const result = response.results.find((result) => alternatives.some((item) =>
        item.text === result.text && item.formats.includes(result.format)));
      assert.ok(result, `Missing expected barcode: ${JSON.stringify(response.results)}`);
      assert.equal(new TextDecoder().decode(Uint8Array.from(result.bytes)), result.text);
      assert.ok(result.position, 'barcode location is available for overlays');
      for (const corner of Object.values(result.position)) {
        assert.ok(corner.x >= 0 && corner.x <= fixture.width);
        assert.ok(corner.y >= 0 && corner.y <= fixture.height);
      }
    }
    assert.equal(decoder.requests.length, 2, 'reading more frames makes no network request');
  });
}

test('worker rejects oversized dimensions before barcode decoding', async () => {
  const response = await decoder.send({ type: 'decode', image: { width: 4001, height: 1000, data: new ArrayBuffer(4) } });
  assert.equal(response.type, 'error');
  assert.match(response.message, /too large or invalid/i);
});

test('worker rejects a pixel buffer inconsistent with its dimensions', async () => {
  const response = await decoder.send({ type: 'decode', image: { width: 10, height: 10, data: new ArrayBuffer(4) } });
  assert.equal(response.type, 'error');
});

test('worker rejects unknown requests without losing future decode capability', async () => {
  assert.equal((await decoder.send({ type: 'unknown' })).type, 'error');
  const response = await decoder.send({ type: 'decode', image: imageFor(fixtures.cases[0]) });
  assert.equal(response.type, 'result');
  assert.equal(response.results[0].text, 'offline-camera-42');
});
