import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { keyFor, createConfirmation, capturePlan, remapResults, cropFraction } = require('../web/scan-policy.js');
const qr = { format: 'QRCode', text: 'camera-test', bytes: [99, 97, 109, 101, 114, 97] };

test('a single camera frame cannot confirm a code, even with duplicated decoder results', () => {
  const policy = createConfirmation();
  assert.deepEqual(policy.observe([qr, qr, qr], 1, 100), []);
  assert.deepEqual(policy.observe([qr], 1, 200), []);
  assert.deepEqual(policy.observe([qr], 2, 300), [qr]);
});

test('formats with optional or missing checksums require three distinct frames', () => {
  for (const format of ['Code39', 'ITF', 'Codabar', 'UnrecognizedFormat']) {
    const policy = createConfirmation();
    const result = { ...qr, format };
    assert.deepEqual(policy.observe([result], 1, 0), []);
    assert.deepEqual(policy.observe([result], 2, 200), []);
    assert.deepEqual(policy.observe([result], 3, 400), [result]);
  }
});

test('equal display text cannot combine differing raw bytes or barcode formats', () => {
  const policy = createConfirmation();
  const otherBytes = { ...qr, bytes: [200, 201] };
  const otherFormat = { ...qr, format: 'DataMatrix' };
  assert.notEqual(keyFor(qr), keyFor(otherBytes));
  assert.notEqual(keyFor(qr), keyFor(otherFormat));
  assert.deepEqual(policy.observe([qr], 1, 0), []);
  assert.deepEqual(policy.observe([otherBytes, otherFormat], 2, 200), []);
  assert.deepEqual(policy.observe([otherBytes], 3, 400), [otherBytes]);
});

test('raw-byte identity remains stable across decoder text rendering differences', () => {
  assert.equal(keyFor(qr), keyFor({ ...qr, text: 'another encoding representation', bytes: new Uint8Array(qr.bytes) }));
  assert.notEqual(keyFor({ format: 'QRCode', text: 'old saved value' }), keyFor(qr));
});

test('stale evidence expires and cannot confirm an isolated later reading', () => {
  const policy = createConfirmation();
  assert.deepEqual(policy.observe([qr], 1, 0), []);
  assert.deepEqual(policy.observe([], 2, 1500), []);
  assert.deepEqual(policy.observe([qr], 3, 2600), []);
  assert.deepEqual(policy.observe([qr], 4, 2800), [qr]);
});

test('camera or setting resets discard unconfirmed evidence', () => {
  const policy = createConfirmation();
  policy.observe([qr], 1, 0);
  policy.reset();
  assert.deepEqual(policy.observe([qr], 2, 100), []);
  assert.deepEqual(policy.observe([qr], 3, 200), [qr]);
});

test('one-off false readings separated by empty frames never become accepted', () => {
  const policy = createConfirmation();
  for (let frame = 0; frame < 30; frame += 1) {
    const results = frame % 5 === 0 ? [{ ...qr, bytes: [frame] }] : [];
    assert.deepEqual(policy.observe(results, frame, frame * 200), []);
  }
});

test('candidate memory stays bounded during a changing noisy video stream', () => {
  const policy = createConfirmation({ maxEntries: 2 });
  policy.observe([qr], 1, 0);
  policy.observe([{ ...qr, bytes: [1] }, { ...qr, bytes: [2] }], 2, 200);
  assert.deepEqual(policy.observe([qr], 3, 400), []);
});

test('full frames preserve more detail while respecting decoder and side limits', () => {
  assert.deepEqual(capturePlan(1920, 1080), { x: 0, y: 0, cropWidth: 1920, cropHeight: 1080, fraction: 1, width: 1920, height: 1080 });
  for (const [width, height] of [[8000, 6000], [6000, 8000], [12000, 1000], [1, 20000], [1, 1]]) {
    const plan = capturePlan(width, height, { maxSide: 3072 });
    assert.ok(plan.width >= 1 && plan.height >= 1);
    assert.ok(plan.width * plan.height <= 4_000_000);
    assert.ok(Math.max(plan.width, plan.height) <= 3072);
    assert.ok(plan.width <= width && plan.height <= height, 'capture never manufactures resolution by upscaling');
  }
});

test('crop overlays map back to the original video coordinates without mutating results', () => {
  const plan = capturePlan(3840, 2160, { fraction: 0.5, maxSide: 960 });
  const result = { ...qr, position: {
    topLeft: { x: 0, y: 0 }, topRight: { x: 960, y: 0 },
    bottomRight: { x: 960, y: 540 }, bottomLeft: { x: 0, y: 540 },
  } };
  const [mapped] = remapResults([result], plan);
  assert.deepEqual(mapped.position, {
    topLeft: { x: 960, y: 540 }, topRight: { x: 2880, y: 540 },
    bottomRight: { x: 2880, y: 1620 }, bottomLeft: { x: 960, y: 1620 },
  });
  assert.equal(result.position.topLeft.x, 0);
  assert.equal(mapped.bytes, result.bytes);
});

test('malformed positions do not produce invalid overlays', () => {
  const [mapped] = remapResults([{ ...qr, position: { topLeft: { x: NaN, y: 0 } } }], capturePlan(100, 100));
  assert.equal(mapped.position, null);
});

test('retry crops never exclude off-centre codes for consecutive attempts', () => {
  const sequence = Array.from({ length: 15 }, (_, misses) => cropFraction(misses));
  assert.deepEqual(sequence.slice(0, 3), [1, 1, 1]);
  assert.ok(sequence.includes(0.7) && sequence.includes(0.45));
  for (let index = 1; index < sequence.length; index += 1) {
    assert.ok(sequence[index] === 1 || sequence[index - 1] === 1);
  }
});

test('invalid dimensions fail before allocating camera pixel buffers', () => {
  for (const args of [[0, 10], [10, 0], [NaN, 10], [10, 10, { fraction: 0 }], [10, 10, { maxSide: 0 }]]) {
    assert.throws(() => capturePlan(...args), /Invalid capture/);
  }
  const narrow = capturePlan(1, 100, { maxPixels: 1 });
  assert.equal(narrow.width * narrow.height, 1);
});

for (const useCallbacks of [false, true]) test(`actual camera loop uses ${useCallbacks ? 'presented-frame callbacks' : 'playback-quality counters'} and rejects stale zoom results`, async () => {
  const elements = new Map();
  class Element {
    constructor() { this.listeners = {}; this.value = ''; this.checked = false; this.children = []; this.classList = { toggle() {}, add() {} }; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    querySelector() { return this.span ||= new Element(); }
  }
  const get = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const video = get('video');
  Object.assign(video, { videoWidth: 3840, videoHeight: 2160, currentTime: 0, readyState: 4, play: async () => {} });
  let frameCounter = 1, callbackId = 0;
  const frameCallbacks = new Map();
  if (useCallbacks) {
    video.requestVideoFrameCallback = (fn) => { const id = ++callbackId; frameCallbacks.set(id, fn); return id; };
    video.cancelVideoFrameCallback = (id) => frameCallbacks.delete(id);
  } else video.getVideoPlaybackQuality = () => ({ totalVideoFrames: frameCounter });
  const presentFrame = (count, time) => {
    frameCounter = count; video.currentTime = time;
    if (useCallbacks) {
      const [id, callback] = frameCallbacks.entries().next().value;
      frameCallbacks.delete(id); callback(performance.now(), { presentedFrames: count });
    }
  };
  const timers = new Map(); let timerId = 0;
  const track = { stop() {}, addEventListener() {}, getCapabilities: () => ({ focusMode: ['continuous'] }), getSettings: () => ({ deviceId: 'test-camera' }), applyConstraints: async () => {} };
  const requests = []; let worker;
  class Worker {
    constructor() { worker = this; }
    postMessage(message) {
      if (message.type === 'init') queueMicrotask(() => this.onmessage({ data: { id: message.id, type: 'ready' } }));
      else requests.push(message);
    }
    terminate() {}
  }
  const context = vm.createContext({
    console, URL, Uint8ClampedArray, ArrayBuffer, Map, Set, Worker, performance,
    location: { href: 'https://local.test/scan/' },
    document: { hidden: false, getElementById: get, addEventListener() {}, createElement: (name) => {
      const node = new Element();
      if (name === 'canvas') node.getContext = () => ({ fillRect() {}, drawImage() {}, getImageData: () => ({ width: node.width, height: node.height, data: new Uint8ClampedArray(node.width * node.height * 4) }) });
      return node;
    }, createElementNS: () => new Element() },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }), enumerateDevices: async () => [] } },
    window: { isSecureContext: true, addEventListener() {} },
    localStorage: { getItem: () => null },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(readFileSync(new URL('../web/scan-policy.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../web/capture-selection.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../web/camera-constraints.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), context);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  async function respond(result = qr) {
    const request = requests.shift();
    assert.equal(request.mode, 'live');
    assert.ok(request.image.width <= 1920 && request.image.width * request.image.height <= 4_000_000);
    worker.onmessage({ data: { id: request.id, type: 'result', results: [result] } });
    await tick();
  }
  async function runScanTimer() {
    const entry = [...timers].find(([, timer]) => timer.delay === 180);
    assert.ok(entry); timers.delete(entry[0]); entry[1].fn(); await tick();
  }
  await vm.runInContext('startCamera()', context); await tick();
  if (useCallbacks) { assert.equal(requests.length, 0); presentFrame(1, 0); await runScanTimer(); }
  await respond(); assert.equal(vm.runInContext('history.length', context), 0);
  video.currentTime = 0.1;
  await runScanTimer(); assert.equal(requests.length, 0, 'advancing playback time with the same displayed frame cannot confirm a result');
  presentFrame(2, 0.2); await runScanTimer(); await respond();
  assert.equal(vm.runInContext('history.length', context), 1, 'second distinct camera frame is accepted');
  presentFrame(3, 0.4); await runScanTimer();
  get('zoom').value = '2'; await get('zoom').listeners.input();
  await respond({ ...qr, text: 'stale-after-zoom', bytes: [7, 8, 9] });
  assert.equal(vm.runInContext('history.length', context), 1, 'in-flight pre-zoom result is discarded');
  const staleCallback = frameCallbacks.values().next().value;
  vm.runInContext('stopCamera()', context);
  assert.equal(frameCallbacks.size, 0, 'stop cancels any requested video-frame callback');
  staleCallback?.(performance.now(), { presentedFrames: 4 });
  assert.equal(frameCallbacks.size, 0, 'a late callback from the stopped session cannot reschedule itself');
});
