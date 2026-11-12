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
function verticalBars(width = 120, height = 60) {
  const input = image(width, height), pixels = new Uint8ClampedArray(input.data);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = Math.floor(x / 4) % 2 ? 0 : 255;
  }
  return input;
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
  assert.ok(worker.calls.length <= 7, 'at most one primary and six recovery attempts');
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
  const result = await worker.send({ image: verticalBars(width, height), mode: 'live', retryIndex: 2 });
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

test('unchecked formats remain available on the original pass only', async () => {
  for (const format of ['ITF', 'Code39', 'Codabar']) {
    const unchecked = { ...valid, format };
    const original = harness(() => [unchecked]);
    assert.equal((await original.send({ image: image() })).results[0].format, format);
    assert.equal(original.calls.length, 1);
    const recovery = harness((candidate, options, call) => call === 1 ? [] : [unchecked]);
    const result = await recovery.send({ image: image(), mode: 'image' });
    assert.deepEqual(result.results, [], 'result filtering must work even if the decoder ignores its format option');
    for (const { options } of recovery.calls.slice(1)) {
      assert.ok(options.formats.includes('Code128'));
      assert.ok(!options.formats.includes(format));
    }
  }
});

test('upscaled corners return to the original pixel centers', async () => {
  const points = { topLeft: { x: 12.25, y: 8.5 }, topRight: { x: 90.75, y: 8.5 }, bottomRight: { x: 90.75, y: 51.25 }, bottomLeft: { x: 12.25, y: 51.25 } };
  const worker = harness((candidate, options, call) => {
    if (call === 1) return [];
    assert.equal(candidate.width, 240); assert.equal(candidate.height, 120);
    const position = Object.fromEntries(Object.entries(points).map(([key, { x, y }]) =>
      [key, { x: 2 * x + 0.5, y: 2 * y + 0.5 }]));
    return [{ ...valid, position }];
  });
  const result = await worker.send({ image: verticalBars(), mode: 'live', retryIndex: 5 });
  assert.equal(result.diagnostics.strategy, 'upscale');
  assert.deepEqual(result.results[0].position, points);
  assert.equal(worker.calls.length, 2);
});

test('gradient-selected deskew maps corners back without changing their origin', async () => {
  const width = 80, height = 40, input = image(width, height), pixels = new Uint8ClampedArray(input.data);
  // Equal positive x and negative y gradients give an independently known -45 degree direction.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 120 + x - y;
  }
  const points = { topLeft: { x: 20, y: 25 }, topRight: { x: 40, y: 5 }, bottomRight: { x: 45, y: 10 }, bottomLeft: { x: 25, y: 30 } };
  const worker = harness((candidate, options, call) => {
    if (call === 1) return [];
    const position = Object.fromEntries(Object.entries(points).map(([key, { x, y }]) => {
      const dx = x - (width - 1) / 2, dy = y - (height - 1) / 2;
      return [key, { x: Math.SQRT1_2 * (dx - dy) + (candidate.width - 1) / 2,
        y: Math.SQRT1_2 * (dx + dy) + (candidate.height - 1) / 2 }];
    }));
    return [{ ...valid, position }];
  });
  const result = await worker.send({ image: input, mode: 'live', retryIndex: 4 });
  assert.equal(result.diagnostics.strategy, 'local-contrast-deskew');
  for (const [key, point] of Object.entries(result.results[0].position)) {
    assert.ok(Math.abs(point.x - points[key].x) < 1e-9);
    assert.ok(Math.abs(point.y - points[key].y) < 1e-9);
  }
});

test('upscaling skips inputs that would exceed four million output pixels', async () => {
  const worker = harness(() => []);
  const result = await worker.send({ image: image(1001, 1000), mode: 'live', retryIndex: 5 });
  assert.deepEqual(result.results, []);
  assert.equal(worker.calls.length, 1);
});

test('large rotated candidates remain under the worker pixel limit', async () => {
  const worker = harness((candidate) => {
    assert.ok(candidate.width * candidate.height <= 4_000_000);
    return [];
  });
  const result = await worker.send({ image: image(2000, 1900), mode: 'live', retryIndex: 2 });
  assert.deepEqual(result.results, []);
  assert.equal(worker.calls.length, 2);
});

test('linear recovery requires coherent source bars aligned with its scanline', async () => {
  const diagonal = { topLeft: { x: 20, y: 10 }, topRight: { x: 60, y: 50 }, bottomRight: { x: 65, y: 50 }, bottomLeft: { x: 25, y: 10 } };
  const horizontal = { topLeft: { x: 20, y: 10 }, topRight: { x: 100, y: 10 }, bottomRight: { x: 100, y: 50 }, bottomLeft: { x: 20, y: 50 } };
  const read = (position, format = 'Code128') => (candidate, options, call) => call === 1 ? [] : [{ ...valid, format, position }];
  const mismatched = harness(read(diagonal));
  assert.deepEqual((await mismatched.send({ image: verticalBars(), mode: 'live' })).results, []);
  const featureless = harness(read(horizontal));
  assert.deepEqual((await featureless.send({ image: image(), mode: 'live' })).results, []);
  const missing = harness(read(undefined));
  assert.deepEqual((await missing.send({ image: verticalBars(), mode: 'live' })).results, []);
  const matrix = harness(read(diagonal, 'QRCode'));
  assert.equal((await matrix.send({ image: image(), mode: 'live' })).results[0].format, 'QRCode');
  const original = harness(() => [{ ...valid, position: diagonal }]);
  assert.equal((await original.send({ image: verticalBars(), mode: 'live' })).results[0].format, 'Code128');
});
