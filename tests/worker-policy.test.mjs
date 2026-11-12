import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../web/scanner-worker.js', import.meta.url), 'utf8');
function harness(read) {
  const calls = [], responses = [];
  const globals = {
    URL, performance, ArrayBuffer, Uint8Array, Uint8ClampedArray, Uint32Array,
    location: { href: 'https://local.test/scan/scanner-worker.js' },
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    importScripts() {},
    ZXingWASM: {
      prepareZXingModule: () => Promise.resolve(),
      readBarcodes: async (image, options) => { calls.push({ image, options }); return read(image, options, calls.length); },
    },
    postMessage: (message) => responses.push(message),
  };
  const context = vm.createContext(globals); context.self = context;
  vm.runInContext(source, context);
  return {
    calls,
    async send(message) { await context.onmessage({ data: { id: 1, type: 'decode', ...message } }); return JSON.parse(JSON.stringify(responses.at(-1))); },
  };
}
function image(width = 120, height = 60) {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  return { width, height, data: pixels.buffer };
}
const valid = { isValid: true, error: '', text: 'verified', format: 'Code128', bytes: new Uint8Array([1, 2]) };

test('clean images return immediately without enhancement work', async () => {
  const worker = harness(() => [valid]);
  const result = await worker.send({ image: image() });
  assert.equal(result.results[0].text, 'verified');
  assert.equal(worker.calls.length, 1);
});

test('an invalid/error result cannot short-circuit retries or reach the app', async () => {
  const worker = harness(() => [{ ...valid, isValid: false }, { ...valid, error: 'ChecksumError' }, { ...valid, isValid: undefined }]);
  const result = await worker.send({ image: image(), mode: 'live' });
  assert.deepEqual(result.results, []);
  assert.equal(worker.calls.length, 2, 'live work is bounded to original plus one retry');
  for (const { options } of worker.calls) {
    assert.equal(options.returnErrors, false);
    assert.equal(options.isPure, false);
    assert.ok(options.minLineCount >= 2);
  }
});

test('empty still images use a finite retry budget', async () => {
  const worker = harness(() => []);
  await worker.send({ image: image(), mode: 'image' });
  assert.ok(worker.calls.length <= 6, 'at most one primary and five recovery attempts');
});

test('rotated results map precisely back to the supplied image coordinates', async () => {
  const width = 120, height = 60;
  const points = { topLeft: { x: 20, y: 15 }, topRight: { x: 100, y: 15 }, bottomRight: { x: 100, y: 45 }, bottomLeft: { x: 20, y: 45 } };
  const worker = harness((candidate, options, call) => {
    if (call === 1) return [];
    const c = Math.SQRT1_2;
    const position = Object.fromEntries(Object.entries(points).map(([key, { x, y }]) => {
      const dx = x - (width - 1) / 2, dy = y - (height - 1) / 2;
      return [key, { x: c * dx - c * dy + (candidate.width - 1) / 2, y: c * dx + c * dy + (candidate.height - 1) / 2 }];
    }));
    return [{ ...valid, position }];
  });
  const result = await worker.send({ image: image(width, height), mode: 'live', retryIndex: 2 });
  for (const [key, point] of Object.entries(result.results[0].position)) {
    assert.ok(Math.abs(point.x - points[key].x) < 1e-9);
    assert.ok(Math.abs(point.y - points[key].y) < 1e-9);
  }
});

test('missing or invalid buffers and scanning modes fail without decoding', async () => {
  for (const request of [ { image: null }, { image: { width: 4, height: 4, data: { byteLength: 64 } } }, { image: image(), mode: 'unknown' } ]) {
    const worker = harness(() => [valid]);
    const result = await worker.send(request);
    assert.equal(result.type, 'error');
    assert.equal(worker.calls.length, 0);
  }
});
