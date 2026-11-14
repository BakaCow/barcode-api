/** SDK lifecycle tests use actual policy/selection helpers and controlled pixels.
 * They simulate browsers; they do not measure physical Android/iPhone cameras. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import vm from 'node:vm';
import { createScanner } from '../web/sdk/scanner.js';
import Analysis from '../web/frame-analysis.js';
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
const item = { text: '00042', format: 'Code128', bytes: [48, 48, 48, 52, 50], position: {
  topLeft: { x: 4, y: 5 }, topRight: { x: 32, y: 5 }, bottomRight: { x: 32, y: 20 }, bottomLeft: { x: 4, y: 20 },
} };
const other = { ...item, text: '00043', bytes: [48, 48, 48, 52, 51] };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function harness(settings = {}, frameSupport = 'decoded') {
  const messages = [], waiting = [], workers = [], streams = [], events = new Map(), timers = new Map(), bitmaps = [];
  const results = [], statuses = [], errors = [], constraints = [], frameCallbacks = new Map(), captures = [], cameraRequests = [], canvases = [];
  const state = { now: 1000, frame: 1, frozen: false, scene: 'sharp', calls: 0, next: 0, permission: null, bitmapRequest: null };
  const listen = prefix => ({ addEventListener(type, fn) { events.set(prefix + type, fn); }, removeEventListener(type, fn) { if (events.get(prefix + type) === fn) events.delete(prefix + type); } });
  function makeCanvas() {
  const context = { fillRect() {}, drawImage(...args) { this.draw = args; captures.push(args); }, getImageData(_x, _y, width, height) {
    state.readbacks = (state.readbacks || 0) + 1;
    (state.readbackSizes ||= []).push({ width, height });
    if (state.fixture) {
      const pixels = inflateSync(Buffer.from(state.fixture.rgba_zlib_base64, 'base64'));
      const output = new Uint8ClampedArray(width * height * 4);
      const resolve = (draw, x, y) => {
        const [source, sx, sy, sw, sh, , , dw, dh] = draw;
        const px = sx + (x + 0.5) * sw / dw, py = sy + (y + 0.5) * sh / dh;
        if (source._context) return resolve(source._context.draw, px - 0.5, py - 0.5);
        return [Math.min(state.fixture.width - 1, Math.floor(px)), Math.min(state.fixture.height - 1, Math.floor(py))];
      };
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const [px, py] = resolve(this.draw, x, y);
        output.set(pixels.subarray((py * state.fixture.width + px) * 4, (py * state.fixture.width + px) * 4 + 4), (y * width + x) * 4);
      }
      return { width, height, data: output };
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
  const canvas = { getContext: () => context, _context: context, width: 0, height: 0 }; canvases.push(canvas); return canvas;
  }
  const doc = { ...listen('document:'), hidden: false, baseURI: 'https://scanner.test/examples/', createElement: makeCanvas };
  const video = { ownerDocument: doc, play: async () => {}, srcObject: null, readyState: 4,
    videoWidth: 64, videoHeight: 48, currentTime: 0 };
  if (frameSupport === 'decoded') video.getVideoPlaybackQuality = () => ({ totalVideoFrames: state.frame });
  if (frameSupport === 'presented') {
    video.requestVideoFrameCallback = fn => { const id = ++state.next; frameCallbacks.set(id, fn); return id; };
    video.cancelVideoFrameCallback = id => frameCallbacks.delete(id);
  }
  function makeStream() {
    const track = { ...listen(`track${streams.length}:`), stopped: 0, stop() { this.stopped++; },
      getCapabilities: () => ({ focusMode: ['continuous'], ...state.capabilities }),
      getSettings: () => ({ deviceId: `camera-${streams.indexOf(stream)}`, width: video.videoWidth, height: video.videoHeight, ...state.cameraSettings }),
      applyConstraints: async value => { constraints.push(value); if (state.constraintRequest) await state.constraintRequest.promise; } };
    const stream = { track, getTracks: () => [track], getVideoTracks: () => [track] }; streams.push(stream); return stream;
  }
  class Worker {
    constructor(url) { this.url = String(url); this.terminated = false; workers.push(this); }
    postMessage(message) {
      messages.push(message);
      if (message.type === 'init') queueMicrotask(() => this.onmessage({ data: { id: message.id, type: 'ready', capabilities: { offscreenCapture: state.offscreen === true } } }));
      else if (message.type === 'analyze' && !state.holdAnalysis) queueMicrotask(() => this.onmessage({ data: {
        id: message.id, type: 'analysis', analysis: Analysis.analyze(message.image), image: message.image } }));
      else waiting.push({ worker: this, message });
    }
    terminate() { this.terminated = true; }
  }
  const env = { ...listen('window:'), Worker, location: new URL('https://scanner.test/examples/'), isSecureContext: true,
    performance: { now: () => state.now }, crypto: { randomUUID: () => `scan-${++state.next}` }, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout(fn, ms) { const id = ++state.next; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    navigator: { mediaDevices: { getUserMedia(request) { state.calls++; cameraRequests.push(request); return state.permission?.promise || Promise.resolve(makeStream()); },
      enumerateDevices: async () => state.devices || [] } },
    createImageBitmap(source) {
      if (state.bitmapRequest) return state.bitmapRequest.promise;
      const bitmap = { width: source?.width || state.fixture?.width || 64, height: source?.height || state.fixture?.height || 48, closed: 0, close() { this.closed++; } }; bitmaps.push(bitmap); return Promise.resolve(bitmap);
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
  return { scanner, state, env, doc, video, canvas: canvases[0], canvases, messages, waiting, workers, streams, events, timers, bitmaps,
    results, statuses, errors, constraints, frameCallbacks, captures, cameraRequests, makeStream, tick, reply };
}

test('constructor validates format allowlist, options and same-origin assets', () => {
  for (const settings of [{ formats: [] }, { confirmationFrames: 0 }, { cropBarcodes: 'yes' }, { automaticRecovery: 'yes' }, { unexpected: true },
    { assetBaseUrl: 'https://other.test/scanner/' }]) assert.throws(() => harness(settings));
});

test('concurrent starts acquire one camera and initialize same-origin assets once', async () => {
  const h = harness();
  const first = h.scanner.start(), second = h.scanner.start();
  assert.equal(first, second); await first;
  assert.equal(h.state.calls, 1); assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0].url, 'https://scanner.test/assets/scanner-worker.js');
  assert.equal(h.video.muted, true); assert.equal(h.video.playsInline, true);
  assert.deepEqual(h.constraints[0].advanced, [{ focusMode: 'continuous' }]);
  assert.deepEqual(h.constraints[0].width, { ideal: 3840 });
  h.scanner.destroy();
});

test('automatic recovery requests source detail and only advertised continuous exposure', async () => {
  for (const [automaticRecovery, exposureModes] of [[true, ['continuous']], [true, ['manual']], [false, ['continuous']]]) {
    const h = harness({ automaticRecovery });
    h.state.capabilities = { exposureMode: exposureModes };
    await h.scanner.start();
    assert.deepEqual(h.cameraRequests[0].video.width, { ideal: automaticRecovery ? 3840 : 1920 });
    assert.deepEqual(h.cameraRequests[0].video.height, { ideal: automaticRecovery ? 2160 : 1080 });
    assert.deepEqual(h.constraints[0].advanced, [{ focusMode: 'continuous',
      ...(automaticRecovery && exposureModes.includes('continuous') ? { exposureMode: 'continuous' } : {}) }]);
    assert.equal(h.state.calls, 1);
    h.scanner.destroy();
  }
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

test('difficult live reads reuse the successful recovery method within the confirmation window', async () => {
  const h = harness(); await h.scanner.start();
  const retries = [];
  for (let frame = 0; frame < 3; frame++) {
    await h.tick({ advance: 900 });
    const index = h.waiting[0].message.retryIndex; retries.push(index);
    await h.reply(index === 1 ? [item] : []);
    if (frame < 2) assert.equal(h.results.length, 0, 'a first read never counts as two frames');
  }
  assert.deepEqual(retries, [0, 1, 1]);
  assert.equal(h.results.length, 1); assert.equal(h.results[0].text, item.text);
  h.scanner.rescan(); await h.tick();
  assert.equal(h.waiting[0].message.retryIndex, 0, 'a new scan starts a new recovery search');
  h.scanner.destroy();
});

test('reusing a recovery method does not count frozen pixels or hide later conflicting values', async () => {
  const h = harness(); await h.scanner.start();
  await h.tick(); await h.reply([]);
  h.state.frozen = true;
  await h.tick(); await h.reply([item]);
  for (let frame = 0; frame < 2; frame++) {
    await h.tick(); assert.equal(h.waiting[0].message.retryIndex, 1); await h.reply([item]);
  }
  assert.equal(h.results.length, 0, 'repeated pixels cannot confirm a recovered result');
  h.state.frozen = false;
  await h.tick(); await h.reply([item, other]);
  assert.equal(h.results.length, 0); assert.equal(h.statuses.at(-1).state, 'ambiguous');
  h.scanner.destroy();
});

test('a lost recovery match resumes searching and late results cannot restore an old method', async () => {
  const h = harness(); await h.scanner.start();
  await h.tick(); await h.reply([]);
  await h.tick(); await h.reply([item]);
  await h.tick(); assert.equal(h.waiting[0].message.retryIndex, 1); await h.reply([]);
  await h.tick(); assert.equal(h.waiting[0].message.retryIndex, 2);
  h.scanner.rescan(); await h.reply([item]);
  await h.tick(); assert.equal(h.waiting[0].message.retryIndex, 0);
  assert.equal(h.results.length, 0); h.scanner.destroy();
});

test('confirmed scans stay paused through controls, target changes and camera/profile restarts until rescan', async () => {
  const h = harness(); h.state.capabilities = { torch: true, zoom: { min: 1, max: 4, step: 0.5 } };
  await h.scanner.start(); await h.tick(); await h.reply(); await h.tick(); await h.reply();
  assert.equal(h.results.length, 1); const id = h.results[0].scanId;
  const changes = [
    () => h.scanner.setTorch(true), () => h.scanner.setZoom(2),
    () => h.scanner.setOptions({ targetRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }),
    () => h.scanner.setOptions({ targetRegion: null, formats: ['code128'], adaptiveFrameSelection: false }),
    () => h.scanner.switchCamera('next-camera'), () => h.scanner.setCaptureMode('detail'),
  ];
  for (const change of changes) {
    await change(); await h.tick();
    assert.equal(h.waiting.length, 0, 'a control change must not begin a new decode attempt');
    assert.equal(h.results.length, 1); assert.equal(h.statuses.at(-1).state, 'confirmed');
  }
  h.scanner.rescan(); await h.tick(); await h.reply(); assert.equal(h.results.length, 1);
  await h.tick(); await h.reply(); assert.equal(h.results.length, 2);
  assert.notEqual(h.results[1].scanId, id); h.scanner.destroy();
});

test('explicit start after stop and explicit image imports rearm a previously confirmed scanner', async () => {
  const h = harness({ confirmationFrames: 1 });
  await h.scanner.start(); await h.tick(); await h.reply(); assert.equal(h.results.length, 1);
  h.scanner.stop(); await h.scanner.start(); await h.tick(); await h.reply();
  assert.equal(h.results.length, 2);
  const reading = h.scanner.scanImage(new Blob(['fixture'], { type: 'image/png' }));
  await flush(); await h.reply(); assert.ok(await reading); assert.equal(h.results.length, 3);
  await h.scanner.start(); await h.tick(); await h.reply(); assert.equal(h.results.length, 4);
  assert.equal(new Set(h.results.map(result => result.scanId)).size, 4); h.scanner.destroy();
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
    assert.equal(h.results.length, 0, action); assert.equal(h.errors.length, 0, 'status changes must not recurse'); h.scanner.destroy();
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
  await h.reply(); assert.equal(h.results.length, 0); assert.equal(h.statuses.at(-1).reason, 'stale_frame');
  await h.tick(); assert.equal(h.waiting[0].message.retryIndex, 1, 'an expired read must not pin the previous slow method'); h.scanner.destroy();
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

test('camera enumeration never prompts, excludes microphones and keeps generic unnamed labels', async () => {
  const h = harness(); h.state.devices = [{kind:'audioinput',deviceId:'mic',label:'Mic'},
    {kind:'videoinput',deviceId:'first',label:''},{kind:'videoinput',deviceId:'second',label:'Rear camera'}];
  assert.deepEqual(await h.scanner.listCameras(),[{deviceId:'first',label:'Camera 1'},{deviceId:'second',label:'Rear camera'}]);
  assert.equal(h.state.calls,0); assert.equal(h.scanner.getCameraCapabilities().active,false); h.scanner.destroy();
});

test('unsupported flashlight and zoom reject without changing a camera', async () => {
  const h = harness(); await h.scanner.start();
  await assert.rejects(h.scanner.setTorch(true),/not supported/);
  await assert.rejects(h.scanner.setZoom(2),/not supported/);
  assert.equal(h.constraints.length,1); h.scanner.destroy();
});

test('torch and zoom changes serialize, suspend capture and clear confirmation before/after', async () => {
  const h = harness(); h.state.capabilities = {torch:true,zoom:{min:1,max:4,step:0.5}};
  await h.scanner.start(); await h.tick(); await h.reply();
  h.state.constraintRequest = deferred();
  const torch = h.scanner.setTorch(true), zoom = h.scanner.setZoom(1.31);
  await flush(); await h.tick(); assert.equal(h.waiting.length,0);
  assert.deepEqual(h.constraints.at(-1).advanced.at(-1),{torch:true});
  h.state.constraintRequest.resolve(); await torch; const caps = await zoom;
  assert.deepEqual(h.constraints.at(-1).advanced.at(-1),{zoom:1.5});
  assert.ok(h.constraints.at(-1).advanced.some(value=>value.torch===true));
  assert.deepEqual(h.constraints.at(-1).width,{ideal:3840});
  assert.equal(caps.torch.enabled,true); assert.equal(caps.zoom.value,1.5);
  await h.tick(); await h.reply(); assert.equal(h.results.length,0);
  await h.tick(); await h.reply(); assert.equal(h.results.length,1); h.scanner.destroy();
});

test('torch-after-zoom preserves zoom, resolution and autofocus constraints',async()=>{
  const h=harness({captureMode:'detail'});h.state.capabilities={torch:true,zoom:{min:1,max:4,step:0.5}};
  await h.scanner.start();await h.scanner.setZoom(2);await h.scanner.setTorch(true);
  const applied=h.constraints.at(-1);
  assert.equal(applied.width.ideal,3840);assert.equal(applied.height.ideal,2160);
  assert.ok(applied.advanced.some(value=>value.zoom===2));assert.ok(applied.advanced.some(value=>value.focusMode==='continuous'));
  assert.ok(applied.advanced.some(value=>value.torch===true));h.scanner.destroy();
});

test('stopping cancels a pending camera setting and prevents late state changes', async () => {
  const h = harness(); h.state.capabilities = {torch:true}; await h.scanner.start();
  h.state.constraintRequest = deferred(); const changing = h.scanner.setTorch(true);
  const rejected = assert.rejects(changing,{name:'AbortError'}); await flush(); h.scanner.stop(); await rejected;
  h.state.constraintRequest.resolve(); await flush();
  assert.equal(h.scanner.getCameraCapabilities().torch.enabled,false);
  assert.equal(h.video.srcObject,null); h.scanner.destroy();
});

test('camera switching closes the previous stream and explicit detail profile requests higher ideals', async () => {
  const h = harness(); await h.scanner.start(); const old = h.streams[0];
  await h.scanner.switchCamera('chosen-camera');
  assert.ok(old.track.stopped); assert.deepEqual(h.cameraRequests.at(-1).video.deviceId,{exact:'chosen-camera'});
  assert.throws(()=>h.scanner.setOptions({captureMode:'detail'}),/setCaptureMode/);
  await h.scanner.setCaptureMode('detail');
  assert.equal(h.cameraRequests.at(-1).video.width.ideal,3840);
  assert.equal(h.cameraRequests.at(-1).video.height.ideal,2160);
  assert.equal(h.cameraRequests.at(-1).video.deviceId.exact,'chosen-camera');
  assert.equal(h.scanner.getCameraCapabilities().captureMode,'detail'); h.scanner.destroy();
});

test('capture profile changes while idle never silently open a camera and effective options are copied', async () => {
  const h = harness({targetRegion:{x:0.2,y:0.2,width:0.5,height:0.5}});
  await h.scanner.setCaptureMode('detail'); assert.equal(h.state.calls,0);
  const options = h.scanner.getOptions(); options.formats.length = 0; options.targetRegion.x=0;
  assert.ok(h.scanner.getOptions().formats.length); assert.equal(h.scanner.getOptions().targetRegion.x,0.2);
  assert.equal(h.scanner.getOptions().captureMode,'detail'); h.scanner.destroy();
});

test('target regions crop original source coordinates and still reject conflicts within the target', async () => {
  const h = harness({confirmationFrames:1,targetRegion:{x:0.25,y:0.25,width:0.5,height:0.5}});
  h.video.videoWidth=800; h.video.videoHeight=600; await h.scanner.start(); await h.tick();
  const draw = h.captures.at(-1); assert.deepEqual(draw.slice(1,5),[200,150,400,300]);
  await h.reply([item,other]); assert.equal(h.results.length,0); assert.equal(h.statuses.at(-1).state,'ambiguous');
  h.scanner.rescan(); await h.tick(); await h.reply([item]);
  assert.deepEqual(h.results[0].position.topLeft,{x:204,y:155}); h.scanner.destroy();
});

test('candidate callbacks cannot change the target then decode a stale capture', async () => {
  let change = true;
  const h = harness({confirmationFrames:1,onCandidates(){if(change){change=false;h.scanner.setOptions({targetRegion:{x:0.1,y:0.1,width:0.7,height:0.7}});}}});
  await h.scanner.start(); await h.tick(); assert.equal(h.waiting.length,0);
  await h.tick(); await h.reply(); assert.equal(h.results.length,1); h.scanner.destroy();
});

test('SDK image path reads Code128 and QR with the real local WASM worker and rejects conflicting QR labels', async (t) => {
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
          const localPaths = new Map(['vendor/zxing_reader.wasm', 'vendor/zbar/zbar.wasm'].map(asset => ['https://scanner.test/assets/' + asset, asset]));
          assert.ok(localPaths.has(String(path)), 'scanner dependencies remain local');
          return new Response(readFileSync(new URL(localPaths.get(String(path)), root)), { headers: { 'Content-Type': 'application/wasm' } });
        },
        importScripts: path => {
          assert.ok(['./vendor/zxing-reader.js', './pos-policy.js', './frame-analysis.js', './independent-reader.js',
            './qr-geometry.js', './qr-recovery.js', './linear-signal.js', './qr-signal.js',
            './vendor/zbar/index.js', './engine/code128-decoder.js', './engine/code128-detector.js', './engine/code128-engine.js'].includes(path));
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
  await t.test('a shaded QR confirms on the next fresh frame using the real successful recovery method', async () => {
    const label = JSON.parse(readFileSync(new URL('fixtures/damage-stress-dev.json', import.meta.url))).cases
      .find(fixture => fixture.name === 'qr/dev-qr-label-2/shading-lowcontrast-2');
    const pixels = inflateSync(Buffer.from(label.rgba_zlib_base64, 'base64'));
    const h = harness({ cropBarcodes: false });
    h.video.videoWidth = label.width; h.video.videoHeight = label.height;
    const methods = []; let completed = 0, successfulMethod = null;
    h.env.Worker = class extends NativeWorker {
      postMessage(data) {
        if (data.type !== 'decode') return super.postMessage(data);
        methods.push(data.retryIndex);
        void this.context.onmessage({ data }).finally(() => { completed++; });
      }
    };
    await h.scanner.start();
    for (let frame = 0; frame < 16 && !h.results.length; frame++) {
      // A one-level change outside the code models distinct captured pixels;
      // the production decoder still sees and must read the whole shaded label.
      pixels[0] = frame;
      h.state.fixture = { ...label, rgba_zlib_base64: deflateSync(pixels).toString('base64') };
      await h.tick({ advance: 180 });
      for (let attempt = 0; attempt < 100 && completed <= frame; attempt++) await flush();
      assert.equal(completed, frame + 1);
      if (successfulMethod !== null) assert.equal(methods.at(-1), successfulMethod, 'next frame reuses the method that actually decoded this fixture');
      if (h.statuses.at(-1)?.reason === 'insufficient_confirmation') {
        successfulMethod = methods.at(-1);
        assert.equal(h.results.length, 0, 'a real first read still needs another frame');
      }
    }
    assert.notEqual(successfulMethod, null, 'the production reader found a candidate before confirmation');
    assert.equal(h.results[0]?.text, label.expected[0].text);
    assert.equal(h.results[0]?.format, 'qr'); h.scanner.destroy();
  });
  await t.test('explicit target isolates one actual label from a two-label image',async()=>{
    const fixture = fixtures.find(f=>f.name==='Multiple QR codes');
    const h = harness({confirmationFrames:1,targetRegion:{x:0,y:0,width:0.5,height:1}}); h.state.fixture=fixture; h.env.Worker=NativeWorker;
    const result = await h.scanner.scanImage(new Blob(['fixture'],{type:'image/png'}));
    assert.ok(result); assert.ok(fixture.expected.some(item=>item.text===result.text));
    assert.ok(result.position.topRight.x<=fixture.width/2); h.scanner.destroy();
  });
  await t.test('independent Code128 correction reaches the POS callback only after two real decoded frames', async () => {
    const cases = JSON.parse(readFileSync(new URL('fixtures/damage-stress-recovery.json', import.meta.url))).cases;
    const fixture = cases.find(item => item.name === 'code128/recovery-code128-label-3/small-in-frame-1');
    const pixels = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
    const h = harness({ confirmationFrames: 2, automaticRecovery: false });
    h.video.videoWidth = fixture.width; h.video.videoHeight = fixture.height;
    let completed = 0;
    h.env.Worker = class extends NativeWorker {
      postMessage(data) {
        if (data.type !== 'decode') return super.postMessage(data);
        void this.context.onmessage({ data }).finally(() => { completed++; });
      }
    };
    await h.scanner.start();
    for (let frame = 0; frame < 2; frame++) {
      // Only the empty background changes between simulated camera frames.
      // The decoder receives the original difficult barcode pixels unchanged.
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const p = (y * fixture.width + x) * 4;
        pixels[p] = pixels[p + 1] = pixels[p + 2] = 250 - frame;
      }
      h.state.fixture = { ...fixture, rgba_zlib_base64: deflateSync(pixels).toString('base64') };
      await h.tick({ advance: 250 });
      for (let attempt = 0; attempt < 100 && completed <= frame; attempt++) await flush();
      assert.equal(completed, frame + 1);
      if (frame === 0) assert.equal(h.results.length, 0, 'independent decoder agreement is still one camera frame');
    }
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].text, fixture.expected[0].text);
    assert.equal(h.results[0].format, 'code128');
    assert.equal(h.results[0].bytesBase64, Buffer.from(fixture.expected[0].text, 'utf8').toString('base64'));
    h.scanner.destroy();
  });
  await t.test('new QR grid recovery reads the two formerly missed blurred images through the SDK', async () => {
    const cases = JSON.parse(readFileSync(new URL('fixtures/damage-stress-recovery.json', import.meta.url))).cases;
    for (const label of [2, 3]) {
      const fixture = cases.find(entry => entry.name === `qr/recovery-qr-label-${label}/blur-2`);
      const h = harness({ confirmationFrames: 1 }); h.state.fixture = fixture; h.env.Worker = NativeWorker;
      try {
        const result = await h.scanner.scanImage(new Blob(['fixture'], { type: 'image/png' }));
        assert.equal(result?.text, fixture.expected[0].text);
        assert.equal(result.format, 'qr');
        assert.equal(result.bytesBase64, Buffer.from(fixture.expected[0].text, 'utf8').toString('base64'));
      } finally { h.scanner.destroy(); }
    }
  });
  await t.test('motion and tiny-code recovery reaches the actual SDK image callback with exact values', async t => {
    const cases = JSON.parse(readFileSync(new URL('fixtures/damage-stress-qr-upgrade.json', import.meta.url))).cases
      .filter(item => item.expected.length && ['motion-blur-2', 'small-in-frame-2'].includes(item.name.split('/').at(-1)));
    assert.equal(cases.length, 18);
    // These assertions test functionality under a deterministic worker clock.
    // Separate unchanged-image benchmarks measure production deadline/latency.
    class FunctionalWorker extends NativeWorker {
      constructor(url) { super(url); this.context.performance = { now: () => 0 }; }
    }
    for (const fixture of cases) await t.test(fixture.name, async () => {
      const h = harness({ confirmationFrames: 1 }); h.state.fixture = fixture; h.env.Worker = FunctionalWorker;
      try {
        const result = await h.scanner.scanImage(new Blob(['fixture'], { type: 'image/png' }));
        assert.equal(result?.text, fixture.expected[0].text);
        assert.equal(result.format, fixture.name.split('/')[0]);
        assert.equal(result.bytesBase64, Buffer.from(fixture.expected[0].text, 'utf8').toString('base64'));
        assert.equal(h.results.length, 1);
      } finally { h.scanner.destroy(); }
    });
  });
  await t.test('early live QR grid recovery still requires two distinct frames before the POS callback', async () => {
    const cases = JSON.parse(readFileSync(new URL('fixtures/damage-stress-recovery.json', import.meta.url))).cases;
    const fixture = cases.find(entry => entry.name === 'qr/recovery-qr-label-1/blur-2');
    const pixels = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
    const h = harness(), strategies = [], retries = [];
    h.video.videoWidth = fixture.width; h.video.videoHeight = fixture.height;
    h.env.Worker = class extends NativeWorker {
      constructor(url) {
        super(url); const send = this.context.postMessage;
        this.context.postMessage = data => { if (data.type === 'result') strategies.push(data.diagnostics?.strategy); send(data); };
      }
      postMessage(data) { if (data.type === 'decode') retries.push(data.retryIndex); super.postMessage(data); }
    };
    try {
      await h.scanner.start();
      for (let frame = 0; frame < 2; frame++) {
        // Change a small background corner only; QR pixels stay untouched.
        for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
          const offset = (y * fixture.width + x) * 4;
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 250 + frame;
        }
        h.state.fixture = { ...fixture, rgba_zlib_base64: deflateSync(pixels).toString('base64') };
        await h.tick();
        for (let wait = 0; wait < 100 && !h.results.length && !h.errors.length &&
          ![...h.timers.values()].some(timer => timer.ms <= 180); wait++) await flush();
        assert.equal(h.errors.length, 0);
        if (!frame) { assert.equal(h.results.length, 0); assert.equal(h.statuses.at(-1).reason, 'insufficient_confirmation'); }
      }
      assert.deepEqual(retries, [0, 0]);
      assert.ok(strategies.every(strategy => strategy === 'qr-grid-deblur'));
      assert.equal(h.results.length, 1); assert.equal(h.results[0].text, fixture.expected[0].text);
      assert.equal(h.results[0].format, 'qr');
      assert.equal(h.results[0].bytesBase64, Buffer.from(fixture.expected[0].text, 'utf8').toString('base64'));
    } finally { h.scanner.destroy(); }
  });
  await t.test('detail recovery decodes preserved source pixels after a forced broad-pass miss',async()=>{
    const label = fixtures.find(f=>f.name==='Code 128'), pixels=inflateSync(Buffer.from(label.rgba_zlib_base64,'base64'));
    const width=3840,height=2160,large=Buffer.alloc(width*height*4,255),left=1200,top=800;
    for(let y=0;y<label.height;y++) pixels.copy(large,((top+y)*width+left)*4,y*label.width*4,(y+1)*label.width*4);
    const h=harness({confirmationFrames:1,captureMode:'detail'});
    h.state.fixture={width,height,rgba_zlib_base64:deflateSync(large).toString('base64')};
    h.video.videoWidth=width;h.video.videoHeight=height;
    const decoded=[];
    h.env.Worker=class extends NativeWorker {
      postMessage(data){
        if(data.type==='decode'){
          decoded.push({width:data.image.width,height:data.image.height,retryIndex:data.retryIndex});
          if(decoded.length===1){queueMicrotask(()=>this.onmessage({data:{id:data.id,type:'result',results:[]}}));return;}
        }
        super.postMessage(data);
      }
    };
    await h.scanner.start(); await h.tick();
    for(let attempt=0;attempt<100&&!h.results.length;attempt++) await flush();
    assert.equal(h.results[0]?.text,label.expected[0].text);
    assert.ok(decoded.length>=2); assert.equal(decoded[0].width,1920);
    assert.ok(decoded.every(call=>call.retryIndex===0),'full view and source crops share one recovery method for this frame');
    assert.equal(h.captures.filter(draw=>draw[0]===h.video&&draw[7]>320).length,1,'one source snapshot serves all recovery passes, alongside the tiny evidence thumbnail');
    assert.ok(h.results[0].position.topLeft.x>=left-10); assert.ok(h.results[0].position.topLeft.y>=top-10);
    h.scanner.destroy();
  });
  await t.test('automatic detail crops recover a real distant EAN after unique misses and still require separate agreeing frames', async () => {
    // An independently encoded one-pixel EAN loses bars when the simulated
    // camera downsamples 2560 to 1920. Nothing intercepts decoder results:
    // only the real source crop can recover its known value.
    const fixture = JSON.parse(readFileSync(new URL('fixtures/automatic-capture-recovery.json', import.meta.url)));
    for (const automaticRecovery of [false, true]) {
      const pixels = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
      const decodes = [], proposals = [];
      const h = harness({ automaticRecovery, onCandidates: proposal => proposals.push(proposal) });
      h.video.videoWidth = fixture.width; h.video.videoHeight = fixture.height;
      h.env.Worker = class extends NativeWorker {
        postMessage(data) {
          if (data.type === 'decode') decodes.push({ frame: h.state.frame, width: data.image.width,
            retryIndex: data.retryIndex, enhanceLive: data.enhanceLive });
          super.postMessage(data);
        }
      };
      try {
        await h.scanner.start();
        for (let frame = 0; frame < 5; frame++) {
          // A faint changing background patch models fresh physical frames
          // at both decoder and stable evidence-thumbnail resolutions. The
          // barcode pixels remain untouched throughout the sequence.
          for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
            const offset = (y * fixture.width + x) * 4;
            pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 250 + frame;
          }
          h.state.fixture = { ...fixture, rgba_zlib_base64: deflateSync(pixels).toString('base64') };
          await h.tick({ advance: 240 });
          for (let wait = 0; wait < 200 && !h.results.length && !h.errors.length &&
            ![...h.timers.values()].some(timer => timer.ms <= 180); wait++) await flush();
          assert.equal(h.errors.length, 0);
          assert.equal(proposals.at(-1)?.regions.length, 1, 'the actual analyzer finds one small label region');
          if (frame < 3 || !automaticRecovery) {
            assert.equal(decodes.length, frame + 1);
            assert.equal(decodes.at(-1).width, 1920);
            assert.equal(h.results.length, 0, 'balanced pixels cannot read this fixture');
          }
          if (automaticRecovery && frame === 2) assert.equal(h.statuses.at(-1).reason, 'detail_recovery');
          if (automaticRecovery && frame === 3) {
            assert.equal(h.results.length, 0, 'the first actual source-crop read cannot confirm alone');
            assert.equal(h.statuses.at(-1).reason, 'insufficient_confirmation');
          }
        }
        assert.equal(h.state.calls, 1, 'recovery keeps the existing camera stream');
        if (automaticRecovery) {
          assert.equal(h.results.length, 1);
          assert.equal(h.results[0].text, fixture.expected[0].text);
          assert.equal(h.results[0].format, 'ean13');
          const crops = decodes.filter(call => !call.enhanceLive);
          assert.equal(crops.length, 2, 'two distinct frames use native-resolution source crops');
          assert.notEqual(crops[0].frame, crops[1].frame);
          assert.equal(crops[0].retryIndex, crops[1].retryIndex, 'the actual successful method is retained');
          assert.ok(crops.every(call => call.width < 600));
          assert.ok(h.results[0].position.topLeft.x >= fixture.label.x);
          assert.ok(h.results[0].position.topLeft.y >= fixture.label.y);
        } else assert.equal(h.results.length, 0, 'opting out keeps the bounded balanced workflow');
      } finally { h.scanner.destroy(); }
    }
  });
  await t.test('a real clear padded barcode decodes immediately but still needs distinct agreeing frames',async()=>{
    const label=fixtures.find(f=>f.name==='Code 128'), pixels=inflateSync(Buffer.from(label.rgba_zlib_base64,'base64'));
    const width=label.width+400,height=label.height+300,large=Buffer.alloc(width*height*4,255);
    for(let y=0;y<label.height;y++) pixels.copy(large,((y+150)*width+200)*4,y*label.width*4,(y+1)*label.width*4);
    const fixture=()=>({width,height,rgba_zlib_base64:deflateSync(large).toString('base64')});
    const h=harness({preferClearFrames:true});h.state.fixture=fixture();h.video.videoWidth=width;h.video.videoHeight=height;
    let decodes=0;
    h.env.Worker=class extends NativeWorker {postMessage(data){if(data.type==='decode')decodes++;super.postMessage(data);}};
    await h.scanner.start();await h.tick({advance:80});assert.equal(decodes,1,'clear first sample bypasses burst wait');
    await flush();assert.equal(h.results.length,0,'one frame is insufficient');
    await h.tick({advance:80});await flush();assert.equal(decodes,2);assert.equal(h.results.length,0,'identical pixels add no vote');
    for(let y=0;y<25;y++)for(let x=0;x<25;x++){
      const offset=(y*width+x)*4;large[offset]=large[offset+1]=large[offset+2]=254;
    }
    h.state.fixture=fixture();await h.tick({advance:80});
    for(let attempt=0;attempt<50&&!h.results.length;attempt++)await flush();
    assert.equal(h.results[0]?.text,label.expected[0].text);h.scanner.destroy();
    const buffered=harness({preferClearFrames:true,adaptiveFrameSelection:false});
    buffered.state.fixture=fixture();buffered.video.videoWidth=width;buffered.video.videoHeight=height;
    await buffered.scanner.start();await buffered.tick({advance:80});assert.equal(buffered.waiting.length,0);buffered.scanner.destroy();
  });
  await t.test('same-frame detail crops retain conflicting identities instead of selecting the first',async()=>{
    const width=3840,height=2160,large=Buffer.alloc(width*height*4,255);
    for(const [name,left] of [['Code 128',350],['EAN-13',2500]]){
      const label=fixtures.find(f=>f.name===name),pixels=inflateSync(Buffer.from(label.rgba_zlib_base64,'base64'));
      for(let y=0;y<label.height;y++)pixels.copy(large,((y+900)*width+left)*4,y*label.width*4,(y+1)*label.width*4);
    }
    const h=harness({confirmationFrames:1,captureMode:'detail'});h.state.fixture={width,height,rgba_zlib_base64:deflateSync(large).toString('base64')};
    h.video.videoWidth=width;h.video.videoHeight=height;let decodes=0;
    h.env.Worker=class extends NativeWorker {postMessage(data){if(data.type==='decode'&&++decodes===1){queueMicrotask(()=>this.onmessage({data:{id:data.id,type:'result',results:[]}}));return;}super.postMessage(data);}};
    await h.scanner.start();await h.tick();
    for(let attempt=0;attempt<100&&h.statuses.at(-1)?.state!=='ambiguous';attempt++)await flush();
    assert.equal(decodes,3);assert.equal(h.results.length,0);assert.equal(h.statuses.at(-1).state,'ambiguous');h.scanner.destroy();
    const slow=harness({confirmationFrames:1,captureMode:'detail'});
    slow.state.fixture=h.state.fixture;slow.video.videoWidth=width;slow.video.videoHeight=height;
    await slow.scanner.start();await slow.tick();await slow.reply([]);
    assert.equal(slow.waiting.length,1,'first source crop is attempted');
    slow.state.now+=351;await slow.reply([item]);
    assert.equal(slow.waiting.length,0,'remaining crop does not start after the recovery budget');
    assert.equal(slow.results.length,0,'partial recovery cannot accept one label while another crop remains unchecked');
    assert.equal(slow.statuses.at(-1).reason,'no_code');slow.scanner.destroy();
  });
});


test('async analysis keeps only one pending frame and cannot publish stale target proposals', async () => {
  let proposals = 0;
  const h = harness({ confirmationFrames: 1, onCandidates() { proposals++; } });
  h.state.holdAnalysis = true;
  await h.scanner.start(); await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.waiting.length, 1, 'capture cannot queue behind pending analysis');
  const pending = h.waiting.shift(); assert.equal(pending.message.type, 'analyze');
  assert.equal(pending.message.returnImage, true);
  h.scanner.setOptions({ targetRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } });
  pending.worker.onmessage({ data: { id: pending.message.id, type: 'analysis', image: pending.message.image,
    analysis: Analysis.analyze(pending.message.image) } });
  await flush();
  assert.equal(proposals, 0); assert.equal(h.waiting.length, 0); assert.equal(h.results.length, 0);
  h.state.holdAnalysis = false; await h.tick(); await h.reply();
  assert.equal(proposals, 1); assert.equal(h.results.length, 1); h.scanner.destroy();
});

test('stopping during analysis settles the loop and ignores late pixel buffers', async () => {
  const h = harness({ confirmationFrames: 1 }); h.state.holdAnalysis = true;
  await h.scanner.start(); await h.tick();
  const pending = h.waiting.shift(); h.scanner.stop(); await flush();
  pending.worker.onmessage({ data: { id: pending.message.id, type: 'analysis', image: pending.message.image,
    analysis: Analysis.analyze(pending.message.image) } });
  await flush(); assert.equal(h.results.length, 0); assert.equal(h.errors.length, 0);
  assert.equal(h.canvas.width, 0); assert.equal(h.waiting.length, 0);
  h.state.holdAnalysis = false; await h.scanner.start(); await h.tick(); await h.reply();
  assert.equal(h.results.length, 1); h.scanner.destroy();
});


test('offscreen capture submits one bounded bitmap with only a tiny main-thread evidence readback', async () => {
  const h = harness({ confirmationFrames: 1, captureMode: 'detail' }); h.state.offscreen = true;
  h.video.videoWidth = 7680; h.video.videoHeight = 4320;
  await h.scanner.start(); await h.tick(); await h.tick();
  assert.equal(h.waiting.length, 1); assert.equal(h.state.readbacks, 1);
  assert.deepEqual(h.state.readbackSizes, [{ width: 320, height: 180 }]);
  const pending = h.waiting.shift(); assert.equal(pending.message.type, 'prepare');
  assert.equal(pending.message.bitmap.width, 3840); assert.equal(pending.message.bitmap.height, 2160);
  assert.equal(h.captures.filter(draw => draw[0] === h.video && draw[7] > 320).length, 1);
  h.scanner.stop(); await flush();
  assert.ok(h.bitmaps[0].closed > 0); assert.equal(h.waiting.length, 0); assert.equal(h.errors.length, 0);
  h.scanner.destroy();
});

test('offscreen source crops cannot confirm a unique value while a third region remains unchecked', async () => {
  for (const second of [[], [other]]) {
    const h = harness({ confirmationFrames: 1, captureMode: 'detail' }); h.state.offscreen = true;
    await h.scanner.start(); await h.tick();
    const pending = h.waiting.shift(); assert.equal(pending.message.type, 'prepare');
    const image = () => ({ width: 64, height: 48, data: new Uint8Array(64 * 48 * 4).fill(255).buffer });
    const plan = { x: 0, y: 0, cropWidth: 64, cropHeight: 48, width: 64, height: 48 };
    const analysis = { score: 90, hint: null, fingerprint: 'controlled-source-exposure', regionsComplete: true,
      regions: [0, 20, 40].map(x => ({ x, y: 8, width: 16, height: 30, kind: 'matrix' })) };
    pending.worker.onmessage({ data: { id: pending.message.id, type: 'prepared', sample: {
      image: image(), plan, analysis, proposals: analysis.regions, recoveryComplete: false,
      recovery: [{ image: image(), plan }, { image: image(), plan }], sourceWidth: 64, sourceHeight: 48,
    } } });
    await flush(); await h.reply([]); await h.reply([item]); await h.reply(second);
    assert.equal(h.waiting.length, 0); assert.equal(h.results.length, 0);
    assert.equal(h.statuses.at(-1).reason, second.length ? 'conflicting_values' : 'no_code');
    h.scanner.destroy();
  }
});

test('cancelled bitmap creation closes its late result and cannot submit a stale worker request', async () => {
  const h = harness(); h.state.offscreen = true; h.state.bitmapRequest = deferred();
  await h.scanner.start(); await h.tick();
  h.scanner.stop(); await flush();
  const bitmap = { width: 64, height: 48, closed: 0, close() { this.closed++; } };
  h.state.bitmapRequest.resolve(bitmap); await flush();
  assert.equal(bitmap.closed, 1); assert.equal(h.waiting.length, 0); assert.equal(h.results.length, 0);
  assert.equal(h.errors.length, 0); h.scanner.destroy();
});

test('withheld worker evidence cannot be forgotten before another source crop is accepted', async () => {
  for (const phase of ['broad', 'crop', 'conflict']) {
    const h = harness({ confirmationFrames: 1, captureMode: 'detail' }); h.state.offscreen = true;
    await h.scanner.start(); await h.tick();
    const pending = h.waiting.shift(); assert.equal(pending.message.type, 'prepare');
    const image = () => ({ width: 64, height: 48, data: new Uint8Array(64 * 48 * 4).fill(255).buffer });
    const plan = { x: 0, y: 0, cropWidth: 64, cropHeight: 48, width: 64, height: 48 };
    const analysis = { score: 90, hint: null, fingerprint: 'partial-qr-evidence', regionsComplete: true,
      regions: [0, 32].map(x => ({ x, y: 8, width: 20, height: 30, kind: 'matrix' })) };
    pending.worker.onmessage({ data: { id: pending.message.id, type: 'prepared', sample: {
      image: image(), plan, analysis, proposals: analysis.regions, recoveryComplete: true,
      recovery: [{ image: image(), plan }, { image: image(), plan }], sourceWidth: 64, sourceHeight: 48,
    } } });
    await flush();
    const incomplete = { diagnostics: { incompleteEvidence: true } };
    if (phase === 'broad') await h.reply([], incomplete);
    else {
      await h.reply([]);
      await h.reply(phase === 'conflict' ? [item, other] : [], incomplete);
      await h.reply([item]);
    }
    assert.equal(h.waiting.length, 0);
    assert.equal(h.results.length, 0, 'no partial observation may reach the POS callback');
    assert.equal(h.statuses.at(-1).reason, phase === 'conflict' ? 'conflicting_values' : 'no_code');
    assert.equal(h.messages.filter(message => message.type === 'decode').length, phase === 'broad' ? 1 : 3);
    h.scanner.destroy();
  }
});


test('failed bitmap preparation falls back to bounded canvas capture and worker analysis', async () => {
  const h = harness({ confirmationFrames: 1 }); h.state.offscreen = true;
  h.env.createImageBitmap = async () => { throw new Error('Canvas bitmaps unsupported'); };
  await h.scanner.start(); await h.tick();
  assert.equal(h.waiting[0].message.type, 'decode'); assert.equal(h.state.readbacks, 2);
  assert.ok(h.messages.some(message => message.type === 'analyze'));
  await h.reply(); assert.equal(h.results.length, 1); assert.equal(h.errors.length, 0); h.scanner.destroy();
});

test('stalled bitmap preparation has a bounded fallback and closes the late bitmap', async () => {
  const h = harness({ confirmationFrames: 1 }); h.state.offscreen = true; h.state.bitmapRequest = deferred();
  await h.scanner.start(); await h.tick();
  const [id, deadline] = [...h.timers].find(([, value]) => value.ms === 2000);
  h.timers.delete(id); h.state.now += 2000; deadline.fn(); await flush();
  assert.equal(h.waiting[0].message.type, 'decode');
  const bitmap = { closed: 0, close() { this.closed++; } }; h.state.bitmapRequest.resolve(bitmap); await flush();
  assert.equal(bitmap.closed, 1); await h.reply();
  assert.equal(h.results.length, 0); assert.equal(h.statuses.at(-1).reason, 'stale_frame');
  await h.tick(); await h.reply(); assert.equal(h.results.length, 1); h.scanner.destroy();
});
