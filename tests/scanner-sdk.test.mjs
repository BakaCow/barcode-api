/** SDK lifecycle tests use actual policy/selection helpers and controlled pixels.
 * They simulate browsers; they do not measure physical Android/iPhone cameras. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import { createScanner } from '../web/sdk/scanner.js';
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const item = { text: '00042', format: 'Code128', bytes: [48, 48, 48, 52, 50], position: {
  topLeft: { x: 4, y: 5 }, topRight: { x: 32, y: 5 }, bottomRight: { x: 32, y: 20 }, bottomLeft: { x: 4, y: 20 },
} };
const other = { ...item, text: '00043', bytes: [48, 48, 48, 52, 51] };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function harness(settings = {}, frameSupport = 'decoded') {
  const messages = [], waiting = [], workers = [], streams = [], events = new Map(), timers = new Map(), bitmaps = [];
  const results = [], statuses = [], errors = [], constraints = [], frameCallbacks = new Map();
  const state = { now: 1000, frame: 1, frozen: false, scene: 'sharp', calls: 0, next: 0, permission: null, bitmapRequest: null };
  const listen = prefix => ({ addEventListener(type, fn) { events.set(prefix + type, fn); }, removeEventListener(type, fn) { if (events.get(prefix + type) === fn) events.delete(prefix + type); } });
  const context = { fillRect() {}, drawImage() {}, getImageData(_x, _y, width, height) {
    if (state.fixture) {
      const pixels = inflateSync(Buffer.from(state.fixture.rgba_zlib_base64, 'base64'));
      assert.equal(width, state.fixture.width); assert.equal(height, state.fixture.height);
      return { width, height, data: new Uint8ClampedArray(pixels) };
    }
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const value = state.scene === 'blur' ? (x % 4 < 2 ? 120 : 145) : (x % 4 < 2 ? 20 : 240);
      data[p] = data[p + 1] = data[p + 2] = value;
    }
    data[0] = state.frozen ? 1 : state.frame % 256;
    return { width, height, data };
  } };
  const canvas = { getContext: () => context, width: 0, height: 0 };
  const doc = { ...listen('document:'), hidden: false, baseURI: 'https://scanner.test/examples/', createElement: () => canvas };
  const video = { ownerDocument: doc, play: async () => {}, srcObject: null, readyState: 4,
    videoWidth: 64, videoHeight: 48, currentTime: 0 };
  if (frameSupport === 'decoded') video.getVideoPlaybackQuality = () => ({ totalVideoFrames: state.frame });
  if (frameSupport === 'presented') {
    video.requestVideoFrameCallback = fn => { const id = ++state.next; frameCallbacks.set(id, fn); return id; };
    video.cancelVideoFrameCallback = id => frameCallbacks.delete(id);
  }
  function makeStream() {
    const track = { ...listen(`track${streams.length}:`), stopped: 0, stop() { this.stopped++; },
      getCapabilities: () => ({ focusMode: ['continuous'] }), applyConstraints: async value => constraints.push(value) };
    const stream = { track, getTracks: () => [track], getVideoTracks: () => [track] }; streams.push(stream); return stream;
  }
  class Worker {
    constructor(url) { this.url = String(url); this.terminated = false; workers.push(this); }
    postMessage(message) {
      messages.push(message);
      if (message.type === 'init') queueMicrotask(() => this.onmessage({ data: { id: message.id, type: 'ready' } }));
      else waiting.push({ worker: this, message });
    }
    terminate() { this.terminated = true; }
  }
  const env = { ...listen('window:'), Worker, location: new URL('https://scanner.test/examples/'), isSecureContext: true,
    performance: { now: () => state.now }, crypto: { randomUUID: () => `scan-${++state.next}` }, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout(fn, ms) { const id = ++state.next; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    navigator: { mediaDevices: { getUserMedia() { state.calls++; return state.permission?.promise || Promise.resolve(makeStream()); } } },
    createImageBitmap() {
      if (state.bitmapRequest) return state.bitmapRequest.promise;
      const bitmap = { width: state.fixture?.width || 64, height: state.fixture?.height || 48, closed: 0, close() { this.closed++; } }; bitmaps.push(bitmap); return Promise.resolve(bitmap);
    },
  };
  doc.defaultView = env;
  const scanner = createScanner({ video, assetBaseUrl: 'https://scanner.test/assets/',
    onScan: result => results.push(result), onStatus: status => statuses.push(status), onError: error => errors.push(error),
    preferClearFrames: false, ...settings });
  async function tick({ advance = 180, fresh = true } = {}) {
    state.now += advance;
    if (fresh) { state.frame++; video.currentTime += advance / 1000; }
    if (frameSupport === 'presented') {
      const [id, callback] = [...frameCallbacks][0] || [];
      if (callback) { frameCallbacks.delete(id); callback(state.now, { presentedFrames: state.frame }); }
    }
    const [id, task] = [...timers].find(([, value]) => value.ms <= 180) || [];
    if (task) { timers.delete(id); task.fn(); }
    await flush();
  }
  async function reply(results = [item], extra = {}) {
    const request = waiting.shift(); assert.ok(request, 'expected a pending decode');
    request.worker.onmessage({ data: { id: request.message.id, type: 'result', results, ...extra } }); await flush();
    return request;
  }
  return { scanner, state, env, doc, video, canvas, messages, waiting, workers, streams, events, timers, bitmaps,
    results, statuses, errors, constraints, frameCallbacks, makeStream, tick, reply };
}

test('constructor validates format allowlist, options and same-origin assets', () => {
  for (const settings of [{ formats: [] }, { confirmationFrames: 0 }, { cropBarcodes: 'yes' }, { unexpected: true },
    { assetBaseUrl: 'https://other.test/scanner/' }]) assert.throws(() => harness(settings));
});

test('concurrent starts acquire one camera and initialize same-origin assets once', async () => {
  const h = harness();
  const first = h.scanner.start(), second = h.scanner.start();
  assert.equal(first, second); await first;
  assert.equal(h.state.calls, 1); assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].url, 'https://scanner.test/assets/scanner-worker.js');
  assert.equal(h.video.muted, true); assert.equal(h.video.playsInline, true);
  assert.deepEqual(h.constraints, [{ advanced: [{ focusMode: 'continuous' }] }]);
  h.scanner.destroy();
});

test('stop cancels pending permission and releases a late-acquired stream', async () => {
  const h = harness(); h.state.permission = deferred();
  const opening = h.scanner.start(); const rejection = assert.rejects(opening, { name: 'AbortError' }); await flush();
  h.scanner.stop(); await rejection;
  const stream = h.makeStream(); h.state.permission.resolve(stream); await flush();
  assert.ok(stream.track.stopped > 0); assert.equal(h.video.srcObject, null); assert.equal(h.waiting.length, 0);
  h.scanner.destroy();
});

test('stop in the same turn as start creates no late worker or camera', async () => {
  const h = harness(); const opening = h.scanner.start(); h.scanner.stop();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(h.workers.length, 0); assert.equal(h.state.calls, 0); h.scanner.destroy();
});

test('a host stop inside starting status cancels the operation and allows a later start', async () => {
  let cancel = true;
  const h = harness({ onStatus(status) { if (status.state === 'starting' && cancel) h.scanner.stop(); } });
  await assert.rejects(h.scanner.start(), { name: 'AbortError' });
  assert.equal(h.workers.length, 0); cancel = false; await h.scanner.start();
  assert.equal(h.state.calls, 1); h.scanner.destroy();
});

test('a host destroy inside starting status cannot create late resources', async () => {
  const h = harness({ onStatus(status) { if (status.state === 'starting') h.scanner.destroy(); } });
  await assert.rejects(h.scanner.start(), { name: 'AbortError' });
  assert.equal(h.workers.length, 0); assert.equal(h.events.size, 0);
});

test('a rejected start is retryable and never leaves a start lock', async () => {
  const h = harness(); h.env.isSecureContext = false;
  await assert.rejects(h.scanner.start(), /HTTPS/); h.env.isSecureContext = true;
  await h.scanner.start(); assert.equal(h.state.calls, 1); h.scanner.destroy();
});

test('destroy cancels pending play, removes listeners and forbids restart', async () => {
  const h = harness(), playing = deferred(); h.video.play = () => playing.promise;
  const opening = h.scanner.start(); const rejected = assert.rejects(opening, { name: 'AbortError' }); await flush();
  h.scanner.destroy(); await rejected;
  assert.equal(h.events.size, 0); assert.ok(h.streams[0].track.stopped > 0); assert.equal(h.video.srcObject, null);
  assert.throws(() => h.scanner.start(), /destroyed/); assert.throws(() => h.scanner.rescan(), /destroyed/);
  playing.resolve(); await flush();
});

test('two distinct frames emit one canonical result and pause until explicit rescan', async () => {
  const h = harness(); await h.scanner.start();
  await h.tick(); await h.reply(); assert.equal(h.results.length, 0);
  await h.tick(); await h.reply(); assert.equal(h.results.length, 1);
  assert.equal(h.results[0].text, '00042'); assert.equal(h.results[0].format, 'code128');
  assert.equal(h.results[0].bytesBase64, Buffer.from(item.bytes).toString('base64'));
  const id = h.results[0].scanId; await h.tick(); assert.equal(h.waiting.length, 0);
  h.scanner.rescan(); await h.tick(); await h.reply(); await h.tick(); await h.reply();
  assert.equal(h.results.length, 2); assert.notEqual(h.results[1].scanId, id); h.scanner.destroy();
});

test('duplicate pixel frames cannot reach confirmation even with increasing counters', async () => {
  const h = harness(); h.state.frozen = true; await h.scanner.start();
  for (let i = 0; i < 4; i++) { await h.tick(); await h.reply(); }
  assert.equal(h.results.length, 0); h.scanner.destroy();
});

test('a host status callback cannot stop an attempt then receive its stale scan event', async () => {
  for (const action of ['stop', 'destroy', 'rescan', 'setOptions']) {
    const h = harness({ confirmationFrames: 1, onStatus(status) {
      if (status.state === 'confirmed') h.scanner[action](...(action === 'setOptions' ? [{ formats: ['qr'] }] : []));
    } });
    await h.scanner.start(); await h.tick(); await h.reply();
    assert.equal(h.results.length, 0, action); h.scanner.destroy();
  }
});

test('competing values stay ambiguous instead of majority acceptance', async () => {
  const h = harness(); await h.scanner.start();
  await h.tick(); await h.reply([item, other]); await h.tick(); await h.reply([item]);
  assert.equal(h.results.length, 0); assert.equal(h.statuses.at(-1).state, 'ambiguous'); h.scanner.destroy();
});

test('clock-only browsers decline multi-frame confirmation, explicit single frame works', async () => {
  const h = harness({}, 'clock'); await h.scanner.start();
  await h.tick(); await h.reply(); await h.tick(); await h.reply();
  assert.equal(h.results.length, 0); assert.equal(h.statuses.at(-1).reason, 'unreliable_frames');
  h.scanner.setOptions({ confirmationFrames: 1 }); await h.tick(); await h.reply();
  assert.equal(h.results.length, 1); h.scanner.destroy();
});

test('presented-frame callbacks confirm and are cancelled on stop', async () => {
  const h = harness({}, 'presented'); await h.scanner.start();
  await h.tick(); await h.reply(); await h.tick(); await h.reply();
  assert.equal(h.results.length, 1); h.scanner.stop(); assert.equal(h.frameCallbacks.size, 0); h.scanner.destroy();
});

test('old replies after options changes cannot confirm or enter the next attempt', async () => {
  const h = harness({ confirmationFrames: 1 }); await h.scanner.start(); await h.tick();
  h.scanner.setOptions({ formats: ['qr'] }); await h.reply(); assert.equal(h.results.length, 0);
  await h.tick(); assert.deepEqual(h.waiting[0].message.posOptions.allowedFormats, ['qr']);
  await h.reply([item]); assert.equal(h.results.length, 0); h.scanner.destroy();
});

test('stop ignores late worker messages and releases camera/worker/canvas memory', async () => {
  const h = harness({ confirmationFrames: 1 }); await h.scanner.start(); await h.tick();
  h.scanner.stop(); await h.reply();
  assert.equal(h.results.length, 0); assert.equal(h.workers[0].terminated, true);
  assert.equal(h.canvas.width, 0); assert.equal(h.canvas.height, 0); assert.equal(h.video.srcObject, null);
  assert.ok(h.streams[0].track.stopped > 0); h.scanner.destroy();
});

test('page hiding stops the camera; the SDK does not silently restart it', async () => {
  const h = harness(); await h.scanner.start(); h.doc.hidden = true;
  h.events.get('document:visibilitychange')(); await flush();
  assert.equal(h.video.srcObject, null); assert.ok(h.streams[0].track.stopped > 0);
  h.doc.hidden = false; h.events.get('document:visibilitychange')(); await h.tick();
  assert.equal(h.state.calls, 1); h.scanner.destroy();
});

test('stale camera decodes are rejected', async () => {
  const h = harness({ confirmationFrames: 1 }); await h.scanner.start(); await h.tick(); h.state.now += 1201;
  await h.reply(); assert.equal(h.results.length, 0); assert.equal(h.statuses.at(-1).reason, 'stale_frame'); h.scanner.destroy();
});

test('best-frame option buffers a bounded burst, then decodes with crop and format controls', async () => {
  const h = harness({ preferClearFrames: true, formats: ['code128'], confirmationFrames: 1 }); await h.scanner.start();
  h.state.scene = 'blur'; await h.tick({ advance: 80 }); assert.equal(h.waiting.length, 0);
  h.state.scene = 'sharp'; await h.tick({ advance: 80 }); assert.equal(h.waiting.length, 0);
  h.state.scene = 'blur'; await h.tick({ advance: 80 });
  const request = h.waiting[0].message;
  assert.equal(new Uint8ClampedArray(request.image.data)[0], 3); // middle, sharper frame
  assert.equal(request.enhanceLive, true); assert.deepEqual(request.posOptions, { allowedFormats: ['code128'], confirmationFrames: 1 });
  await h.reply(); assert.equal(h.results.length, 1); h.scanner.destroy();
});

test('camera dimensions are capped and returned corners map to original pixels', async () => {
  const h = harness({ confirmationFrames: 1 }); h.video.videoWidth = 3840; h.video.videoHeight = 2160;
  await h.scanner.start(); await h.tick();
  const image = h.waiting[0].message.image; assert.ok(image.width <= 1920); assert.ok(image.width * image.height <= 2_100_000);
  await h.reply(); assert.equal(h.results[0].position.topLeft.x, item.position.topLeft.x * 3840 / image.width); h.scanner.destroy();
});

test('worker timeout terminates decoding and reports an actionable error', async () => {
  const h = harness(); await h.scanner.start(); await h.tick();
  const [id, deadline] = [...h.timers].find(([, value]) => value.ms === 12000); h.timers.delete(id); deadline.fn(); await flush();
  assert.equal(h.workers[0].terminated, true); assert.match(h.errors[0].message, /timed out/);
  assert.equal(h.video.srcObject, null); h.scanner.destroy();
});

test('one imported image cannot satisfy two frames and separate imports never accumulate', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    const reading = h.scanner.scanImage(new Blob(['test'], { type: 'image/png' })); await flush(); await h.reply();
    assert.equal(await reading, null);
  }
  assert.equal(h.results.length, 0); assert.equal(h.bitmaps.every(bitmap => bitmap.closed === 1), true); h.scanner.destroy();
});

test('single-frame image scanning stops camera and returns the same confirmed event', async () => {
  const h = harness({ confirmationFrames: 1 }); await h.scanner.start();
  const reading = h.scanner.scanImage(new Blob(['test'], { type: 'image/png' })); await flush(); await h.reply();
  assert.equal(await reading, h.results[0]); assert.equal(h.video.srcObject, null); assert.ok(h.streams[0].track.stopped > 0);
  assert.equal(h.bitmaps[0].closed, 1); h.scanner.destroy();
});

test('single-image conflicts remain ambiguous', async () => {
  const h = harness({ confirmationFrames: 1 });
  const reading = h.scanner.scanImage(new Blob(['test'], { type: 'image/png' })); await flush(); await h.reply([item, other]);
  assert.equal(await reading, null); assert.equal(h.results.length, 0); assert.equal(h.statuses.at(-1).state, 'ambiguous'); h.scanner.destroy();
});

test('destroy during image loading closes late bitmaps and never emits a result', async () => {
  const h = harness({ confirmationFrames: 1 }); h.state.bitmapRequest = deferred();
  const reading = h.scanner.scanImage(new Blob(['test'], { type: 'image/png' }));
  const rejected = assert.rejects(reading, { name: 'AbortError' }); await flush(); h.scanner.destroy(); await rejected;
  const bitmap = { width: 64, height: 48, closed: 0, close() { this.closed++; } };
  h.state.bitmapRequest.resolve(bitmap); await flush(); assert.equal(bitmap.closed, 1); assert.equal(h.results.length, 0);
});

test('invalid and oversized uploads are rejected before disturbing an active camera', async () => {
  const h = harness(); await h.scanner.start(); const stream = h.video.srcObject;
  await assert.rejects(h.scanner.scanImage(new Blob(['test'], { type: 'image/svg+xml' })), /PNG/);
  await assert.rejects(h.scanner.scanImage({ size: 11 * 1024 * 1024, type: 'image/png', arrayBuffer() {} }), /10 MiB/);
  assert.equal(h.video.srcObject, stream); h.scanner.destroy();
});

test('SDK image path reads Code128 and QR with the real local WASM worker and rejects conflicting QR labels', async () => {
  const root = new URL('../web/', import.meta.url);
  const fixtures = JSON.parse(readFileSync(new URL('fixtures/barcode-pixels.json', import.meta.url))).cases;
  class NativeWorker {
    constructor(url) {
      this.terminated = false;
      const context = vm.createContext({ console, URL, WebAssembly, Response, TextEncoder, TextDecoder, Blob,
        performance, ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array,
        Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
        location: { href: String(url) },
        ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
        fetch: async path => {
          assert.equal(String(path), 'https://scanner.test/assets/vendor/zxing_reader.wasm');
          return new Response(readFileSync(new URL('vendor/zxing_reader.wasm', root)), { headers: { 'Content-Type': 'application/wasm' } });
        },
        importScripts: path => {
          assert.ok(['./vendor/zxing-reader.js', './pos-policy.js', './frame-analysis.js'].includes(path));
          vm.runInContext(readFileSync(new URL(path, root), 'utf8'), context);
        },
        postMessage: data => { if (!this.terminated) this.onmessage({ data }); },
      });
      context.self = context; this.context = context;
      vm.runInContext(readFileSync(new URL('scanner-worker.js', root), 'utf8'), context);
    }
    postMessage(data) { void this.context.onmessage({ data }); }
    terminate() { this.terminated = true; }
  }
  for (const name of ['Code 128', 'QR code', 'Multiple QR codes']) {
    const h = harness({ confirmationFrames: 1 }); h.state.fixture = fixtures.find(fixture => fixture.name === name); h.env.Worker = NativeWorker;
    const result = await h.scanner.scanImage(new Blob(['fixture'], { type: 'image/png' }));
    if (name === 'Multiple QR codes') {
      assert.equal(result, null); assert.equal(h.statuses.at(-1).state, 'ambiguous');
    } else {
      assert.equal(result.text, h.state.fixture.expected[0].text);
      assert.equal(result.format, name === 'Code 128' ? 'code128' : 'qr');
    }
    h.scanner.destroy();
  }
});
