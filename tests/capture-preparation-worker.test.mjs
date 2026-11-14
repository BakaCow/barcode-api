/** Controlled OffscreenCanvas pixels test worker geometry/ownership, not phone hardware. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Analysis from '../web/frame-analysis.js';

function harness({ offscreen = true, regions } = {}) {
  const responses = [], draws = [], canvases = [];
  class Bitmap {
    constructor(width, height) {
      this.width = width; this.height = height; this.closed = 0;
      this.data = new Uint8ClampedArray(width * height * 4).fill(255);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, shade = (Math.floor(x / 4) % 2) * 255;
        this.data[i] = this.data[i + 1] = this.data[i + 2] = shade;
      }
    }
    close() { this.closed++; }
  }
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; canvases.push(this); }
    getContext() { return {
      fillRect() {},
      drawImage(...args) { this.draw = args; draws.push(args); },
      getImageData(_x, _y, width, height) {
        const [source, sx, sy, sw, sh] = this.draw;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const px = Math.min(source.width - 1, Math.floor(sx + (x + 0.5) * sw / width));
          const py = Math.min(source.height - 1, Math.floor(sy + (y + 0.5) * sh / height));
          data.set(source.data.subarray((py * source.width + px) * 4, (py * source.width + px) * 4 + 4), (y * width + x) * 4);
        }
        return { width, height, data };
      },
    }; }
  }
  const context = vm.createContext({
    URL, ArrayBuffer, Uint8Array, Uint8ClampedArray, Uint32Array, performance,
    ImageBitmap: Bitmap, ...(offscreen ? { OffscreenCanvas: Canvas } : {}),
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    location: { href: 'https://test.local/scanner-worker.js' },
    ZXingWASM: { prepareZXingModule: async () => {} },
    IndependentReader: { initialize: async () => {} },
    importScripts(path) {
      if (path === './vendor/zxing-reader.js') return;
      assert.ok(['./capture-geometry.js', './frame-analysis.js', './qr-geometry.js', './qr-recovery.js'].includes(path));
      vm.runInContext(readFileSync(new URL(`../web/${path.slice(2)}`, import.meta.url), 'utf8'), context);
      if (regions && path === './frame-analysis.js') {
        const analyze = context.FrameAnalysis.analyze;
        context.FrameAnalysis.analyze = image => ({ ...analyze(image), regions });
      }
    },
    postMessage(message, transfer = []) { responses.push({ message, transfer }); },
  });
  context.self = context;
  vm.runInContext(readFileSync(new URL('../web/scanner-worker.js', import.meta.url), 'utf8'), context);
  return { Bitmap, draws, canvases, async send(extra) {
    await context.onmessage({ data: { id: 1, type: 'prepare', imported: false, captureMode: 'balanced',
      targetRegion: null, cropBarcodes: true, ...extra } });
    return responses.at(-1);
  } };
}

test('worker advertises optional offscreen preparation without requiring it', async () => {
  for (const offscreen of [false, true]) {
    const h = harness({ offscreen });
    assert.equal((await h.send({ type: 'init' })).message.capabilities.offscreenCapture, offscreen);
  }
});

test('offscreen target preparation preserves pixels, mapped source coordinates and ownership', async () => {
  const h = harness(), bitmap = new h.Bitmap(200, 100);
  const response = await h.send({ bitmap, sourceWidth: 400, sourceHeight: 200, captureMode: 'detail',
    targetRegion: { x: 0.5, y: 0.25, width: 0.25, height: 0.5 } });
  assert.equal(response.message.type, 'prepared');
  const sample = response.message.sample;
  assert.deepEqual(JSON.parse(JSON.stringify(sample.plan)), { x: 200, y: 50, cropWidth: 100, cropHeight: 100, width: 100, height: 100 });
  assert.deepEqual(h.draws[0].slice(1, 5), [100, 25, 50, 50]);
  assert.equal(sample.analysis.fingerprint, Analysis.analyze(sample.image).fingerprint);
  assert.equal(response.transfer.length, 1); assert.equal(response.transfer[0], sample.image.data);
  assert.equal(bitmap.closed, 1); assert.equal(h.canvases.at(-1).width, 0);
  const copied = structuredClone(response.message, { transfer: response.transfer });
  assert.equal(sample.image.data.byteLength, 0);
  assert.equal(copied.sample.image.data.byteLength, 100 * 100 * 4);
});

test('detail preparation retains at most two bounded crops from the one supplied bitmap', async () => {
  const regions = [100, 600, 1100].map(x => ({ x, y: 200, width: 300, height: 100, kind: 'linear' }));
  const h = harness({ regions }), bitmap = new h.Bitmap(3840, 2160);
  const { message, transfer } = await h.send({ bitmap, sourceWidth: 3840, sourceHeight: 2160, captureMode: 'detail' });
  assert.equal(message.type, 'prepared');
  assert.equal(message.sample.image.width, 1920); assert.equal(message.sample.recovery.length, 2);
  assert.equal(message.sample.recoveryComplete, false, 'the third planned source region remains unchecked');
  assert.equal(transfer.length, 3); assert.equal(bitmap.closed, 1);
  assert.ok(h.draws.every(draw => draw[0] === bitmap));
  assert.ok(message.sample.recovery.every(crop => crop.image.width * crop.image.height <= 1_000_000));
});

test('invalid or oversized preparation releases its bitmap and never returns candidate pixels', async () => {
  for (const overrides of [{ sourceWidth: 0 }, { targetRegion: { x: 1, y: 0, width: 1, height: 1 } },
    { imported: 'yes' }, { captureMode: 'unknown' }, { cropBarcodes: 1 }]) {
    const h = harness(), bitmap = new h.Bitmap(20, 20);
    const { message } = await h.send({ bitmap, sourceWidth: 20, sourceHeight: 20, ...overrides });
    assert.equal(message.type, 'error'); assert.equal(bitmap.closed, 1);
  }
  const h = harness(), bitmap = new h.Bitmap(1, 1); bitmap.width = 3841; bitmap.height = 2160;
  assert.equal((await h.send({ bitmap, sourceWidth: 3841, sourceHeight: 2160 })).message.type, 'error');
  assert.equal(bitmap.closed, 1);
});

test('fallback analysis returns the same transferable pixels without native decoding', async () => {
  const h = harness({ offscreen: false }), bitmap = new h.Bitmap(40, 20);
  const image = { width: bitmap.width, height: bitmap.height, data: bitmap.data.buffer };
  const { message, transfer } = await h.send({ type: 'analyze', image, returnImage: true });
  assert.equal(message.type, 'analysis'); assert.equal(message.image, image);
  assert.equal(message.analysis.fingerprint, Analysis.analyze(image).fingerprint);
  assert.equal(transfer[0], image.data);
});
