/** Synthetic camera pixels and actual local WASM. These are not phone tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import Fusion from '../web/frame-fusion.js';
import Analysis from '../web/frame-analysis.js';

const fixture = JSON.parse(readFileSync(new URL('fixtures/camera-fusion-development.json', import.meta.url)));
const imageFor = (source, exposure = 0) => {
  const data = new Uint8ClampedArray(inflateSync(Buffer.from(source.rgba_zlib_base64, 'base64')));
  if (exposure) for (let p = 0; p < data.length; p += 4) if (data[p] < 128) data[p] = data[p + 1] = data[p + 2] = exposure;
  return { width: source.width, height: source.height, data };
};
function prepared(collector, source, id, time = id * 100, exposure = 0) {
  const image = imageFor(source, exposure);
  return collector.capture(image, Analysis.analyze(image), { frameId: `decoded:${id}`, capturedAt: time, cameraFingerprint: `camera-${id}` });
}
function burst(collector, sources = fixture.frames, start = 1, exposure = 0) {
  let output;
  for (let i = 0; i < 3; i++) output = collector.push(prepared(collector, sources[i], start + i, (start + i) * 100, exposure), (start + i) * 100);
  return output;
}

test('source-only glare masks recover observed pixels from three disjoint exposures', () => {
  const collector = Fusion.create(), output = burst(collector);
  assert.ok(output); assert.equal(output.evidenceCount, 1);
  assert.deepEqual(output.sourceFrameIds, ['decoded:1', 'decoded:2', 'decoded:3']);
  assert.equal(output.oldestCapturedAt, 100); assert.equal(output.capturedAt, 300);
  assert.deepEqual(new Uint8ClampedArray(output.image.data), imageFor(fixture.clean).data,
    'every output pixel equals the independent clean encoder source');
  assert.equal(burst(collector, fixture.frames, 4), null, 'new IDs cannot reuse already-consumed source pixels');
  assert.ok(burst(collector, fixture.frames, 7, 2), 'a truly different exposure can form another independent burst');
});

test('same-size near-payload label switches cannot be mistaken for removable damage', () => {
  for (const sources of [
    [fixture.frames[0], fixture.alternateFrames[1], fixture.frames[2]],
    [fixture.frames[0], fixture.alternateFrames[1], fixture.alternateFrames[2]],
    [fixture.clean, fixture.alternateClean, fixture.clean],
  ]) assert.equal(burst(Fusion.create(), sources), null);
});

test('small measured translation aligns observed pixels while rotation abstains', () => {
  function transformed(source, dx, dy, rotate = false) {
    const input = imageFor(source), { width, height } = input;
    const data = new Uint8ClampedArray(input.data.length).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sx = rotate ? y : x - dx, sy = rotate ? width - 1 - x : y - dy;
      if (sx >= 0 && sy >= 0 && sx < width && sy < height) data.set(input.data.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
    }
    return { width, height, data };
  }
  for (const rotate of [false, true]) {
    const collector = Fusion.create(); let output;
    for (let i = 0; i < 3; i++) {
      const image = transformed(fixture.frames[i], i, -i, rotate && i === 1);
      const frame = collector.capture(image, Analysis.analyze(image), { frameId: `decoded:${i + 1}`, capturedAt: i * 100 });
      output = collector.push(frame, i * 100);
    }
    if (rotate) assert.equal(output, null);
    else {
      assert.ok(output); assert.equal(output.image.width, fixture.clean.width - 2);
      const clean = imageFor(fixture.clean), data = new Uint8ClampedArray(output.image.data);
      for (let y = 0; y < output.image.height; y++) {
        assert.deepEqual(data.subarray(y * output.image.width * 4, (y + 1) * output.image.width * 4),
          clean.data.subarray(((y + 2) * clean.width) * 4, ((y + 2) * clean.width + output.image.width) * 4));
      }
    }
  }
});

test('permanent holes, repeated frames and stale captures cannot manufacture missing modules', () => {
  const collector = Fusion.create();
  for (let id = 1; id <= 3; id++) assert.equal(collector.push(prepared(collector, fixture.frames[0], id, id * 100, id), id * 100), null);
  const reused = Fusion.create();
  assert.equal(reused.push(prepared(reused, fixture.frames[0], 1), 100), null);
  assert.equal(reused.push(prepared(reused, fixture.frames[1], 1, 200), 200), null);
  assert.equal(reused.push(prepared(reused, fixture.frames[2], 2, 300), 300), null);
  const stale = Fusion.create();
  assert.equal(stale.push(prepared(stale, fixture.frames[0], 1), 1300), null);
  assert.equal(stale.push(prepared(stale, fixture.frames[1], 2, 1400), 1400), null);
  assert.equal(stale.push(prepared(stale, fixture.frames[2], 3, 1500), 1500), null);
});

test('reset revokes already-prepared captures and multiple/incomplete/clipped scenes abstain', () => {
  const collector = Fusion.create(), frame = prepared(collector, fixture.frames[0], 1);
  collector.reset(); assert.equal(collector.push(frame, 100), null);
  assert.equal(collector.push(prepared(collector, fixture.frames[1], 2), 200), null);
  assert.equal(collector.push(prepared(collector, fixture.frames[2], 3), 300), null);
  const image = imageFor(fixture.frames[0]), analysis = Analysis.analyze(image);
  for (const changes of [{ regionsComplete: false }, { hint: 'clipped' },
    { regions: [...analysis.regions, analysis.regions[0]] }, { qr: { ...analysis.qr, count: 2 } },
    { hint: 'dark', qr: { ...analysis.qr, clipped: true } }]) {
    assert.equal(collector.capture(image, { ...analysis, ...changes }, { frameId: 'decoded:4', capturedAt: 400 }), null);
  }
  assert.equal(Fusion.combine([], { timeBudgetMs: 0 }), null);
});

test('actual local worker misses each damaged exposure and reads the fused evidence with exact bytes', async () => {
  const root = new URL('../web/', import.meta.url), replies = [];
  const context = vm.createContext({ console, URL, WebAssembly, Response, TextEncoder, TextDecoder, Blob, performance,
    ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array,
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    location: { href: 'https://offline.test/scanner-worker.js' },
    fetch: async url => {
      const path = new URL(url).pathname.slice(1);
      assert.ok(['vendor/zxing_reader.wasm', 'vendor/zbar/zbar.wasm'].includes(path));
      return new Response(readFileSync(new URL(path, root)), { headers: { 'Content-Type': 'application/wasm' } });
    },
    importScripts: path => {
      assert.ok(['./pos-policy.js', './frame-analysis.js', './vendor/zxing-reader.js', './vendor/zbar/index.js', './independent-reader.js', './qr-geometry.js',
        './qr-recovery.js', './qr-signal.js', './qr-damage.js', './linear-signal.js', './engine/code128-decoder.js',
        './engine/code128-detector.js', './engine/code128-engine.js'].includes(path), path);
      vm.runInContext(readFileSync(new URL(path, root), 'utf8'), context);
    },
    postMessage: message => replies.push(message),
  });
  context.self = context;
  vm.runInContext(readFileSync(new URL('scanner-worker.js', root), 'utf8'), context);
  let id = 0;
  async function read(image) {
    const pixels = image.data;
    await context.onmessage({ data: { id: ++id, type: 'decode', mode: 'image', image: { ...image,
      data: pixels instanceof ArrayBuffer ? pixels : pixels.buffer }, posOptions: { allowedFormats: ['qr'], confirmationFrames: 1 } } });
    const reply = replies.find(reply => reply.id === id);
    assert.equal(reply.type, 'result', reply.message); return reply.results;
  }
  for (const frame of fixture.frames) assert.equal((await read(imageFor(frame))).length, 0, 'full current worker must miss each source exposure');
  const output = burst(Fusion.create()); assert.ok(output);
  const results = await read(output.image);
  assert.equal(results.length, 1); assert.equal(results[0].text, fixture.text);
  assert.deepEqual([...results[0].bytes], [...Buffer.from(fixture.text)]);
});
