import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const policy = require('../web/lab/lab-policy.js');
const base = { text: 'BOX-1042', negative: false, groupId: 'box-1042-session-1', split: 'dev', conditions: ['clean'], device: 'Test camera' };
const correct = [{ text: 'BOX-1042', format: 'Code128', bytes: [66, 79, 88, 45, 49, 48, 52, 50] }];
const expected = [{ text: 'BOX-1042', format: 'Code128' }];
const timings = { customMs: 4, zxingMs: 2 };

test('collection requires independently entered ground truth and session details', () => {
  assert.deepEqual(policy.label(base).expected, expected);
  assert.throws(() => policy.label({ ...base, text: '' }), /exact Code 128/);
  assert.throws(() => policy.label({ ...base, text: 'é' }), /ASCII/);
  assert.throws(() => policy.label({ ...base, groupId: '../test' }), /group/);
  assert.throws(() => policy.label({ ...base, device: '' }), /camera name/);
  assert.throws(() => policy.label({ ...base, split: 'validation' }), /split/);
  assert.throws(() => policy.label({ ...base, conditions: [] }), /condition/);
});

test('negative capture requires an explicit choice and clears positive expected values', () => {
  const result = policy.label({ ...base, negative: true, text: 'old label' });
  assert.deepEqual(result.expected, []);
  assert.equal(result.negative, true);
});

test('ground truth preserves meaningful whitespace and conditions are canonical', () => {
  const result = policy.label({ ...base, text: ' BOX ', conditions: ['blur', 'blur', 'angled'] });
  assert.equal(result.expected[0].text, ' BOX ');
  assert.deepEqual(result.conditions, ['blur', 'angled']);
  assert.throws(() => policy.label({ ...base, conditions: ['unknown'] }));
});

test('sidecars contain portable relative paths and reject path/type/dimension mismatches', () => {
  const fields = { id: 'sample-1', path: 'sample-1.png', mediaType: 'image', capturedAt: '2026-11-12T00:00:00Z', width: 1920, height: 1080, mimeType: 'image/png', userAgent: 'test' };
  const output = policy.metadata(policy.label(base), fields);
  assert.equal(output.version, 1); assert.equal(output.path, 'sample-1.png'); assert.equal(output.source, 'real');
  assert.equal(output.metadata.width, 1920); assert.deepEqual(output.expected, expected);
  assert.throws(() => policy.metadata(policy.label(base), { ...fields, path: '../secret.png' }));
  assert.throws(() => policy.metadata(policy.label(base), { ...fields, path: 'sample-1.webm' }));
  assert.throws(() => policy.metadata(policy.label(base), { ...fields, width: 4000, height: 4000 }));
  assert.throws(() => policy.metadata(policy.label(base), { ...fields, mediaType: 'video', path: 'sample-1.webm', durationMs: 12000 }));
});

test('capture dimensions stay bounded and do not enlarge small images', () => {
  assert.deepEqual(policy.captureSize(100, 40), { width: 100, height: 40 });
  for (const [width, height] of [[8000, 6000], [1, 4000000], [4000000, 1]]) {
    const size = policy.captureSize(width, height);
    assert.ok(size.width * size.height <= 4_000_000);
    assert.ok(size.width <= 1920 && size.height <= 1920);
  }
  assert.throws(() => policy.captureSize(0, 100));
});

test('a correct code plus an unexpected code counts as a wrong frame', () => {
  assert.equal(policy.classify(correct, expected), 'exact');
  assert.equal(policy.classify([...correct, { text: 'wrong', format: 'Code128' }], expected), 'wrong');
  assert.equal(policy.classify([{ text: 'BOX-1042', format: 'QRCode' }], expected), 'wrong');
  assert.equal(policy.classify([], expected), 'miss');
  assert.equal(policy.classify([], []), 'exact');
  assert.equal(policy.classify(correct, []), 'wrong');
});

test('one shared video frame cannot confirm twice or inflate either engine count', () => {
  const trial = policy.createTrial(expected, 1000);
  assert.equal(trial.observe(1, 1100, correct, correct, timings), true);
  assert.equal(trial.observe(1, 1400, correct, correct, timings), false);
  assert.equal(trial.snapshot().custom.frames, 1);
  assert.equal(trial.snapshot().custom.timeToFirstConfirmedMs, null);
  trial.observe(2, 1500, correct, correct, timings);
  assert.equal(trial.snapshot().custom.timeToFirstConfirmedMs, 500);
});

test('confirmation requires equal raw payloads and timely consecutive correct frames', () => {
  const trial = policy.createTrial(expected, 0);
  trial.observe(1, 100, correct, correct, timings);
  trial.observe(2, 300, [{ ...correct[0], bytes: [1, 2] }], [], timings);
  assert.equal(trial.snapshot().custom.timeToFirstConfirmedMs, null);
  assert.equal(trial.snapshot().zxing.timeToFirstConfirmedMs, null);
  trial.observe(3, 4000, correct, correct, timings);
  assert.equal(trial.snapshot().custom.timeToFirstConfirmedMs, null);
  trial.observe(4, 4200, correct, correct, timings);
  assert.equal(trial.snapshot().custom.timeToFirstConfirmedMs, 4200);
});

test('negative trials report false readings but never invent confirmation time', () => {
  const trial = policy.createTrial([], 0);
  trial.observe(1, 100, [], correct, timings);
  trial.observe(2, 200, [], [], timings);
  assert.equal(trial.snapshot().custom.exact, 2);
  assert.equal(trial.snapshot().zxing.wrong, 1);
  assert.equal(trial.snapshot().custom.timeToFirstConfirmedMs, null);
});

test('latency quantiles are reproducible and invalid measurements are rejected', () => {
  const values = [10, 2, 9, 3];
  assert.equal(policy.quantile(values, 0.5), 3); assert.equal(policy.quantile(values, 0.95), 10);
  assert.deepEqual(values, [10, 2, 9, 3]);
  const trial = policy.createTrial(expected, 0);
  assert.throws(() => trial.observe(1, 100, correct, correct, { customMs: NaN, zxingMs: 2 }), /timings/);
  assert.equal(trial.snapshot().custom.frames, 0);
});

test('lab offline readiness rejects older scanner-only service workers', () => {
  assert.equal(policy.isLabOfflineReady({ ready: true, version: '1.1.0' }), false);
  assert.equal(policy.isLabOfflineReady({ ready: true, features: ['scanner'] }), false);
  assert.equal(policy.isLabOfflineReady({ ready: true, features: 'code128-lab' }), false);
  assert.equal(policy.isLabOfflineReady({ ready: false, features: ['code128-lab'] }), false);
  assert.equal(policy.isLabOfflineReady(null), false);
  assert.equal(policy.isLabOfflineReady({ ready: true, features: ['code128-lab'] }), true);
});

test('a trial bounds retained observations and ignores clock values before its start', () => {
  const trial = policy.createTrial(expected, 100);
  assert.equal(trial.observe(1, 99, correct, correct, timings), false);
  for (let i = 0; i < 350; i++) trial.observe(i, 100 + i, correct, correct, timings);
  assert.equal(trial.snapshot().custom.frames, 300);
});

function appHarness() {
  const nodes = new Map(), handlers = new Map(), timers = new Map(), messages = [];
  const urls = new Map(), revoked = [];
  let timerId = 0, stopped = false, instance;
  class LocalURL extends URL {
    static createObjectURL(blob) { const url = `blob:sample-${++timerId}`; urls.set(url, blob); return url; }
    static revokeObjectURL(url) { revoked.push(url); urls.delete(url); }
  }
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', checked: false, hidden: false, textContent: '', children: [], disabled: false, dataset: {},
      addEventListener(name, fn) { handlers.set(`${id}:${name}`, fn); },
      querySelectorAll(selector) { if (id === 'sample-form') return ['expected', 'negative', 'group-id', 'split', 'device'].map(node); if (id === 'conditions') return [{ value: 'clean' }]; return []; },
      replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); }, setAttribute() {},
      getContext() { return { drawImage() {}, getImageData() { return { data: new Uint8ClampedArray(64 * 32 * 4) }; } }; },
      toBlob(done) { queueMicrotask(() => done(new Blob(['photo'], { type: 'image/png' }))); },
      captureStream() { return { getTracks: () => [{ stop() {} }] }; },
    });
    return nodes.get(id);
  }
  Object.assign(node('video'), { readyState: 2, videoWidth: 64, videoHeight: 32, play: async () => {}, getVideoPlaybackQuality: () => ({ totalVideoFrames: 1 }) });
  node('expected').value = base.text; node('group-id').value = base.groupId; node('split').value = 'dev'; node('device').value = base.device;
  const track = { stop() { stopped = true; }, getSettings: () => ({ deviceId: 'test' }), getCapabilities: () => ({}), addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const globals = {
    Code128LabPolicy: policy, CameraConstraints: require('../web/camera-constraints.js'), URL: LocalURL, Blob, Uint8ClampedArray, Uint32Array, ArrayBuffer, performance, console, crypto: globalThis.crypto,
    document: { hidden: false, getElementById: node, createElement: (tag) => node(`created-${tag}-${nodes.size}`), addEventListener(name, fn) { handlers.set(`document:${name}`, fn); } },
    navigator: { userAgent: 'test', mediaDevices: { getUserMedia: async () => stream, enumerateDevices: async () => [] } },
    location: { href: 'https://test.example/scan/lab/', reload() {} },
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    setInterval() { return 1; }, clearInterval() {},
    Worker: class { constructor() { instance = this; } postMessage(message) { messages.push(message); if (message.type === 'init') queueMicrotask(() => this.onmessage({ data: { id: message.id, type: 'ready' } })); } terminate() {} },
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    },
    addEventListener(name, fn) { handlers.set(`window:${name}`, fn); }, isSecureContext: true,
  };
  const context = vm.createContext(globals); context.window = context;
  vm.runInContext(readFileSync(new URL('../web/lab/lab.js', import.meta.url), 'utf8'), context);
  return { context, nodes, messages, timers, handlers, urls, revoked, track, stream, get worker() { return instance; }, get stopped() { return stopped; } };
}

test('the collection lab blocks a ninth capture without evicting any unsaved media or labels', async () => {
  const app = appHarness();
  await vm.runInContext('openCamera()', app.context);
  for (let i = 0; i < 8; i++) await vm.runInContext('capturePhoto()', app.context);
  const first = vm.runInContext('prepared[7]', app.context);
  assert.equal(app.nodes.get('capture-photo').disabled, true);
  assert.equal(app.nodes.get('capture-video').disabled, true);
  assert.match(app.nodes.get('sample-capacity').textContent, /8 of 8.*Capacity full/);
  await vm.runInContext('capturePhoto()', app.context);
  assert.equal(vm.runInContext('prepared.length', app.context), 8);
  assert.ok(app.urls.has(first.mediaURL)); assert.ok(app.urls.has(first.metadataURL));
  assert.equal(app.revoked.length, 0);
  assert.match(app.nodes.get('error-message').textContent, /Existing samples have been kept/);
  const row = app.nodes.get('samples-list').children[7];
  const remove = row.children[1].children[2];
  app.handlers.get(`${remove.id}:click`)();
  assert.equal(vm.runInContext('prepared.length', app.context), 7);
  assert.equal(app.nodes.get('capture-photo').disabled, false);
  assert.deepEqual(app.revoked, [first.mediaURL, first.metadataURL]);
  await vm.runInContext('capturePhoto()', app.context);
  assert.equal(vm.runInContext('prepared.length', app.context), 8);
});

test('an oversized sample is rejected before object URLs are created and preserves prior samples', async () => {
  const app = appHarness();
  await vm.runInContext('openCamera();', app.context);
  await vm.runInContext('capturePhoto()', app.context);
  const previous = vm.runInContext('prepared[0]', app.context);
  app.context.largeBlob = { size: 151 * 1024 * 1024 };
  assert.throws(() => vm.runInContext('prepareSample(largeBlob, prepared[0].metadata)', app.context), /exceeds the remaining.*Existing samples have been kept/);
  assert.equal(vm.runInContext('prepared.length', app.context), 1);
  assert.equal(app.urls.size, 2); assert.equal(app.revoked.length, 0);
  assert.ok(app.urls.has(previous.mediaURL));
});

test('recording reserves the remaining capacity and cannot remove earlier samples on overflow', async () => {
  const app = appHarness();
  await vm.runInContext('openCamera()', app.context);
  await vm.runInContext('capturePhoto()', app.context);
  const previous = vm.runInContext('prepared[0]', app.context);
  // Model a large previously captured file without allocating 149 MiB in a unit test.
  vm.runInContext('prepared[0].blob = { size: 149 * 1024 * 1024 }; captureVideo()', app.context);
  assert.equal(vm.runInContext('recording.byteLimit', app.context), 1024 * 1024);
  vm.runInContext('recording.recorder.ondataavailable({ data: { size: 2 * 1024 * 1024 } })', app.context);
  assert.equal(vm.runInContext('recording', app.context), null);
  assert.equal(vm.runInContext('prepared.length', app.context), 1);
  assert.ok(app.urls.has(previous.mediaURL)); assert.ok(app.urls.has(previous.metadataURL));
  assert.equal(app.revoked.length, 0);
  assert.match(app.nodes.get('error-message').textContent, /Existing samples have been kept/);
});

test('a concurrent photo/video request cannot bypass the single capture slot', async () => {
  const app = appHarness();
  await vm.runInContext('openCamera()', app.context);
  let finish;
  app.context.photoEncoder = done => { finish = done; };
  const first = vm.runInContext('canvas.toBlob = photoEncoder; capturePhoto()', app.context);
  await vm.runInContext('capturePhoto(); captureVideo()', app.context);
  assert.equal(vm.runInContext('recording', app.context), null);
  finish(new Blob(['photo'], { type: 'image/png' })); await first;
  assert.equal(vm.runInContext('prepared.length', app.context), 1);
});

test('cancelling lab permission restores controls and ignores a late startup finalizer', async () => {
  const app = appHarness(), requests = [];
  app.context.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => requests.push(resolve));
  const first = vm.runInContext('openCamera()', app.context);
  assert.equal(app.nodes.get('camera-toggle').disabled, false);
  app.handlers.get('camera-toggle:click')();
  assert.equal(vm.runInContext('opening', app.context), false);
  const second = vm.runInContext('openCamera()', app.context);
  requests[0](app.stream); await first;
  assert.equal(vm.runInContext('opening', app.context), true);
  assert.equal(app.stopped, true);
  requests[1](app.stream); await second;
  assert.equal(vm.runInContext('opening', app.context), false);
});

test('lab camera controls preserve resolution, focus and exposure and display actual settings', async () => {
  const app = appHarness(), calls = [];
  let settings = { deviceId: 'test', zoom: 1, torch: false };
  app.track.getCapabilities = () => ({ focusMode: ['continuous'], exposureMode: ['continuous'], torch: true, zoom: { min: 1, max: 5, step: 0.5 } });
  app.track.getSettings = () => settings;
  app.track.applyConstraints = async constraints => {
    calls.push(constraints);
    const updated = Object.assign({}, ...constraints.advanced);
    settings = { ...settings, ...updated };
    if (updated.zoom) settings.zoom = Math.round(updated.zoom * 2) / 2;
  };
  await vm.runInContext('openCamera()', app.context);
  app.nodes.get('zoom').value = '2.2'; await app.handlers.get('zoom:change')();
  await app.handlers.get('torch:click')();
  const result = calls.at(-1), values = Object.assign({}, ...result.advanced);
  assert.equal(result.width.ideal, 1920); assert.equal(result.height.ideal, 1080);
  assert.equal(values.focusMode, 'continuous'); assert.equal(values.exposureMode, 'continuous');
  assert.equal(values.zoom, 2.2); assert.equal(values.torch, true);
  assert.equal(Number(app.nodes.get('zoom').value), 2);
});

test('the actual lab sends pixels without labels and discards a decode returned after stop', async () => {
  const app = appHarness();
  await vm.runInContext('openCamera()', app.context);
  await vm.runInContext('startTrial()', app.context);
  const request = app.messages.find((message) => message.type === 'decode');
  assert.ok(request); assert.equal(request.engine, 'both');
  assert.deepEqual(Object.keys(request).sort(), ['engine', 'id', 'image', 'type']);
  vm.runInContext('stopTrial()', app.context);
  app.worker.onmessage({ data: { id: request.id, type: 'result', customResults: correct, baselineResults: correct, timings } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('trialReport.results.custom.frames', app.context), 0);
  vm.runInContext('stopCamera()', app.context);
  assert.equal(app.stopped, true);
});

test('hiding the actual lab stops camera tracks and cancels the active comparison', async () => {
  const app = appHarness();
  await vm.runInContext('openCamera()', app.context);
  await vm.runInContext('startTrial()', app.context);
  app.context.document.hidden = true;
  app.handlers.get('document:visibilitychange')();
  assert.equal(app.stopped, true);
  assert.equal(vm.runInContext('trial', app.context), null);
  const request = app.messages.find((message) => message.type === 'decode');
  app.worker.onmessage({ data: { id: request.id, type: 'result', customResults: correct, baselineResults: correct, timings } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('trialReport.results.custom.frames', app.context), 0);
});
