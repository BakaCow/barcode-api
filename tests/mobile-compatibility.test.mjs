/** Capability/lifecycle simulations of shipped UI scripts; not Android/WebKit or camera tests. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const android = {
  name: 'Android Chrome-like', frames: 'presented',
  capabilities: { focusMode: ['continuous'], exposureMode: ['continuous'], torch: true, zoom: { min: 1, max: 10, step: 0.1 } },
  recorderTypes: ['video/webm;codecs=vp8', 'video/webm'], constraints: 'apply',
};
const iphone = {
  name: 'iPhone Safari-like', frames: 'decoded', capabilities: null,
  recorderTypes: ['video/mp4'], constraints: 'ignore',
};
const pages = ['scanner', 'lab'];
const profiles = [android, iphone];
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const result = { text: 'BOX-1042', format: 'Code128', bytes: [66, 79, 88, 45, 49, 48, 52, 50] };

function harness(page, profile, overrides = {}) {
  const options = { ...profile, ...overrides };
  const nodes = new Map(), timers = new Map(), intervals = new Map(), frameCallbacks = new Map();
  const events = new Map(), streams = [], canvasStreams = [], workers = [], messages = [], unresolvedDecodes = [];
  const objectURLs = new Map(), revokedURLs = [], recorders = [], requestedConstraints = [], optionalConstraints = [];
  const state = { permission: options.permission || 'allow', now: 1000, frame: 1, photoCalls: 0, drawCalls: 0 };
  let identifier = 0, context;
  const nextId = () => ++identifier;
  const html = readFileSync(new URL(page === 'lab' ? '../web/lab/index.html' : '../web/index.html', import.meta.url), 'utf8');

  class Element {
    constructor(id = '') {
      this.id = id; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
      this.textContent = ''; this.children = []; this.attributes = {}; this.listeners = new Map(); this.dataset = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    querySelector() { return this.span ||= new Element(); }
    querySelectorAll() {
      if (this.id === 'sample-form') return ['expected', 'negative', 'group-id', 'split', 'device', 'condition-clean'].map(get);
      if (this.id === 'conditions') return [get('condition-clean')];
      return [];
    }
    click() { return this.listeners.get('click')?.({ target: this, preventDefault() {} }); }
    remove() {}
  }
  function get(id) {
    if (!nodes.has(id)) {
      const element = new Element(id);
      const tag = [...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].find((match) => match[1] === id)?.[0] || '';
      element.hidden = /\bhidden\b/.test(tag); element.disabled = /\bdisabled\b/.test(tag);
      nodes.set(id, element);
    }
    return nodes.get(id);
  }
  function track(kind = 'camera') {
    const listeners = new Map(), settings = { deviceId: 'rear-camera', width: 320, height: 180, zoom: 1 };
    const item = { kind, stopped: 0, settings, listeners,
      stop() { this.stopped++; },
      addEventListener(type, callback) { listeners.set(type, callback); },
      getSettings: () => ({ ...settings }),
    };
    if (options.capabilities) item.getCapabilities = () => plain(options.capabilities);
    if (options.capabilities || options.constraints !== 'ignore') item.applyConstraints = async (value) => {
      optionalConstraints.push(plain(value));
      if (options.constraints === 'reject') throw Object.assign(new Error('Optional constraint rejected'), { name: 'OverconstrainedError' });
      if (options.constraints === 'apply') Object.assign(settings, ...(value.advanced || []));
    };
    return item;
  }
  function stream(kind = 'camera') {
    const videoTrack = track(kind);
    const item = { track: videoTrack, getTracks: () => [videoTrack], getVideoTracks: () => [videoTrack] };
    (kind === 'camera' ? streams : canvasStreams).push(item);
    return item;
  }
  function createElement(tag) {
    const node = new Element();
    if (tag === 'canvas') {
      node.width = 0; node.height = 0;
      node.getContext = () => ({ fillRect() {}, drawImage() { state.drawCalls++; },
        getImageData: () => ({ width: node.width, height: node.height, data: new Uint8ClampedArray(node.width * node.height * 4).fill(255) }),
      });
      node.toBlob = (callback, mime) => { state.photoCalls++; queueMicrotask(() => callback(new Blob(['simulated-photo-bytes'], { type: mime }))); };
      if (options.captureStream !== false) node.captureStream = (fps) => { const captured = stream('canvas'); captured.requestedFPS = fps; return captured; };
    }
    return node;
  }
  const video = get('video');
  Object.assign(video, { readyState: 4, videoWidth: 320, videoHeight: 180, currentTime: 0, srcObject: null, play: async () => {} });
  if (options.frames === 'presented') {
    video.requestVideoFrameCallback = (callback) => { const id = nextId(); frameCallbacks.set(id, callback); return id; };
    video.cancelVideoFrameCallback = (id) => frameCallbacks.delete(id);
  } else if (options.frames === 'decoded') video.getVideoPlaybackQuality = () => ({ totalVideoFrames: state.frame });
  get('expected').value = result.text; get('group-id').value = 'simulation-label'; get('split').value = 'dev';
  get('device').value = options.name; get('condition-clean').value = 'clean'; get('condition-clean').checked = true;
  class LocalURL extends URL {
    static createObjectURL(blob) { const url = `blob:simulation-${nextId()}`; objectURLs.set(url, blob); return url; }
    static revokeObjectURL(url) { revokedURLs.push(url); objectURLs.delete(url); }
  }
  class Worker {
    constructor(url) { this.url = String(url); this.terminated = false; workers.push(this); }
    postMessage(message) {
      messages.push(message);
      if (message.type === 'init') queueMicrotask(() => this.onmessage({ data: { id: message.id, type: 'ready' } }));
      else unresolvedDecodes.push({ message, worker: this });
    }
    terminate() { this.terminated = true; }
  }
  class MediaRecorder {
    static isTypeSupported(mime) { return options.recorderTypes.includes(mime); }
    constructor(mediaStream, config) {
      if (options.recorderConstructorFails) throw new Error('Recorder initialization failed');
      this.stream = mediaStream; this.mimeType = config.mimeType; this.config = config; this.state = 'inactive';
      recorders.push(this);
    }
    start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; }
    stop() {
      assert.equal(this.state, 'recording'); this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['simulated-video-bytes'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  const document = { hidden: false, getElementById: get, createElement, createElementNS: () => new Element(), body: new Element(),
    addEventListener(type, callback) { events.set(`document:${type}`, callback); } };
  const globals = {
    console, Blob, URL: LocalURL, ArrayBuffer, Uint8Array, Uint8ClampedArray, Uint32Array, Map, Set,
    performance: { now: () => state.now }, Worker, document,
    crypto: { getRandomValues(values) { values[0] = nextId(); return values; } },
    navigator: { userAgent: `Node simulated ${options.name}; not a mobile browser`, onLine: true,
      mediaDevices: {
        async getUserMedia(constraints) {
          requestedConstraints.push(plain(constraints));
          if (state.permission === 'deny') throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
          if (state.permission === 'defer') return new Promise((resolve) => { state.grantPermission = () => resolve(stream()); });
          return stream();
        },
        async enumerateDevices() {
          if (options.enumerationFails) throw new Error('Enumeration unavailable');
          return [{ kind: 'videoinput', deviceId: 'rear-camera', label: 'Simulated rear camera' }];
        },
      },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: `https://simulation.invalid/scan/${page === 'lab' ? 'lab/' : ''}`, reload() {} },
    setTimeout(callback, delay) { const id = nextId(); timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { const id = nextId(); intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    addEventListener(type, callback) { events.set(`window:${type}`, callback); },
    isSecureContext: options.secure !== false,
  };
  if (options.recorderTypes !== null) globals.MediaRecorder = MediaRecorder;
  context = vm.createContext(globals); context.window = context;
  vm.runInContext(readFileSync(new URL(page === 'lab' ? '../web/lab/lab-policy.js' : '../web/scan-policy.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../web/camera-constraints.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL(page === 'lab' ? '../web/lab/lab.js' : '../web/app.js', import.meta.url), 'utf8'), context);
  const evaluate = (expression) => vm.runInContext(expression, context);
  async function click(id) {
    assert.equal(get(id).disabled, false, `${id} must be enabled before a simulated user click`);
    await get(id).click(); await flush();
  }
  async function event(target, type) { await events.get(`${target}:${type}`)?.(); await flush(); }
  async function runTimer(delay) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `Expected a scheduled ${delay} ms callback`);
    timers.delete(entry[0]); state.now += delay; entry[1].callback(); await flush();
  }
  return {
    context, options, nodes, get, state, streams, canvasStreams, workers, recorders, frameCallbacks,
    messages, unresolvedDecodes, requestedConstraints, optionalConstraints, objectURLs, revokedURLs, timers, intervals,
    evaluate, click, event, runTimer,
    get active() { return evaluate(page === 'lab' ? 'camera !== null' : 'active'); },
    get error() { return get(page === 'lab' ? 'error-message' : 'error-text').textContent; },
    async open() { await click(page === 'lab' ? 'camera-toggle' : 'start'); },
    present(count) {
      state.frame = count; video.currentTime += 0.2;
      const entry = frameCallbacks.entries().next().value;
      if (entry) { frameCallbacks.delete(entry[0]); entry[1](state.now, { presentedFrames: count }); }
    },
    async reply(values = [result]) {
      const request = unresolvedDecodes.shift(); assert.ok(request, 'A real UI decode request must exist');
      const { message, worker } = request;
      assert.equal(message.type, 'decode'); assert.ok(message.image.width * message.image.height <= 4_000_000);
      assert.equal(message.image.data.byteLength, message.image.width * message.image.height * 4);
      const payload = page === 'lab' ? { customResults: values, baselineResults: values, timings: { customMs: 4, zxingMs: 2 } } : { results: values };
      worker.onmessage({ data: { id: message.id, type: 'result', ...payload } }); await flush();
    },
    async cleanup() { await event('window', 'pagehide'); },
  };
}

for (const profile of profiles) for (const page of pages) {
  const label = `${profile.name} ${page}`;
  test(`${label}: permission is deferred to a click and optional controls match capabilities`, async () => {
    const app = harness(page, profile);
    assert.equal(app.requestedConstraints.length, 0); assert.equal(app.workers.length, 0);
    assert.equal(app.active, false);
    await app.open();
    assert.equal(app.active, true); assert.equal(app.requestedConstraints.length, 1);
    const request = app.requestedConstraints[0];
    assert.equal(request.audio, false); assert.equal(request.video.facingMode.ideal, 'environment');
    assert.deepEqual([request.video.width.ideal, request.video.height.ideal], [1920, 1080]);
    assert.equal(app.get('video').videoWidth, 320, 'Ignored ideal resolution does not prevent camera startup');
    if (profile === android) {
      assert.ok(app.optionalConstraints.some((value) => value.advanced.some(entry => entry.focusMode === 'continuous')));
      assert.equal(app.optionalConstraints.some((value) => value.advanced.some(entry => entry.exposureMode === 'continuous')), page === 'lab');
      assert.equal(page === 'lab' ? app.get('torch').hidden : app.get('torch').disabled, false);
      assert.equal(app.get(page === 'lab' ? 'zoom-wrap' : 'zoom-control').hidden, false);
      assert.equal(Number(app.get('zoom').max), 6);
      await app.click('torch'); assert.equal(app.streams[0].track.settings.torch, true);
      app.get('zoom').value = '2';
      await app.get('zoom').listeners.get(page === 'lab' ? 'change' : 'input')();
      assert.equal(app.streams[0].track.settings.zoom, 2);
    } else {
      assert.equal(app.optionalConstraints.length, 0);
      assert.equal(page === 'lab' ? app.get('torch').hidden : app.get('torch').disabled, true);
      assert.equal(app.get(page === 'lab' ? 'zoom-wrap' : 'zoom-control').hidden, true);
    }
    await app.cleanup();
  });

  test(`${label}: denied permission reports recovery and can be retried`, async () => {
    const app = harness(page, profile, { permission: 'deny' });
    await app.open();
    assert.equal(app.active, false); assert.equal(app.get('error').hidden, false);
    assert.match(app.error, /permission|access/i); assert.equal(app.streams.length, 0);
    app.state.permission = 'allow'; await app.open();
    assert.equal(app.active, true); assert.equal(app.get('error').hidden, true);
    assert.equal(app.requestedConstraints.length, 2); await app.cleanup();
  });

  test(`${label}: close, background, disconnect and page exit release tracks`, async () => {
    for (const reason of ['close', 'background', 'disconnect', 'pagehide']) {
      const app = harness(page, profile); await app.open();
      const lateFrame = app.frameCallbacks.values().next().value;
      if (reason === 'close') await app.click(page === 'lab' ? 'camera-toggle' : 'start');
      if (reason === 'background') { app.context.document.hidden = true; await app.event('document', 'visibilitychange'); }
      if (reason === 'disconnect') { app.streams[0].track.listeners.get('ended')(); await flush(); }
      if (reason === 'pagehide') await app.event('window', 'pagehide');
      assert.equal(app.active, false, reason); assert.ok(app.streams[0].track.stopped >= 1, reason);
      assert.equal(app.get('video').srcObject, null); assert.equal(app.frameCallbacks.size, 0);
      lateFrame?.(app.state.now, { presentedFrames: 99 }); assert.equal(app.frameCallbacks.size, 0);
      const count = app.messages.length;
      for (const [id, timer] of [...app.timers]) if (timer.delay === 180) { app.timers.delete(id); timer.callback(); }
      await flush(); assert.equal(app.messages.length, count, 'Stopped scanning cannot schedule another decode');
      if (reason === 'pagehide') assert.ok(app.workers.every((worker) => worker.terminated));
      await app.cleanup();
    }
  });

  test(`${label}: leaving during the permission prompt discards a late camera grant`, async () => {
    const app = harness(page, profile, { permission: 'defer' });
    const opening = app.open(); await flush();
    assert.equal(app.requestedConstraints.length, 1); assert.equal(app.streams.length, 0);
    app.context.document.hidden = true; await app.event('document', 'visibilitychange');
    app.state.grantPermission(); await opening;
    assert.equal(app.active, false); assert.equal(app.get('video').srcObject, null);
    assert.equal(app.streams[0].track.stopped, 1); assert.equal(app.frameCallbacks.size, 0);
    await app.cleanup();
  });

  test(`${label}: advancing time on one frame cannot confirm; a second frame can`, async () => {
    const app = harness(page, profile); await app.open();
    if (profile.frames === 'presented') app.present(1);
    if (page === 'lab') await app.click('trial-toggle');
    else if (profile.frames === 'presented') await app.runTimer(180);
    assert.equal(app.unresolvedDecodes.length, 1); await app.reply();
    const observations = () => page === 'lab' ? app.evaluate('trial.snapshot().custom.frames') : app.evaluate('history.length');
    assert.equal(observations(), page === 'lab' ? 1 : 0);
    if (page === 'lab') assert.equal(app.evaluate('trial.snapshot().custom.timeToFirstConfirmedMs'), null);
    app.get('video').currentTime += 0.5;
    await app.runTimer(180); assert.equal(app.unresolvedDecodes.length, 0);
    assert.equal(observations(), page === 'lab' ? 1 : 0);
    app.present(2); await app.runTimer(180); await app.reply();
    if (page === 'lab') {
      const snapshot = plain(app.evaluate('trial.snapshot()'));
      assert.equal(snapshot.custom.frames, 2); assert.equal(snapshot.zxing.frames, 2);
      assert.ok(snapshot.custom.timeToFirstConfirmedMs >= 0); assert.ok(snapshot.zxing.timeToFirstConfirmedMs >= 0);
    } else {
      assert.equal(app.evaluate('history.length'), 1); assert.equal(app.get('result-text').textContent, result.text);
    }
    await app.cleanup();
  });
}

for (const page of pages) for (const behavior of ['ignore', 'reject']) {
  test(`${page}: advertised optional focus/exposure may be ${behavior === 'ignore' ? 'ignored' : 'rejected'} without blocking capture`, async () => {
    const app = harness(page, iphone, { capabilities: { focusMode: ['continuous'], exposureMode: ['continuous'] }, constraints: behavior, enumerationFails: true });
    await app.open(); assert.equal(app.active, true); assert.equal(app.get('error').hidden, true);
    assert.equal(app.optionalConstraints.length, page === 'lab' ? 2 : 1);
    assert.equal(app.streams[0].track.settings.focusMode, undefined);
    assert.equal(app.streams[0].track.settings.exposureMode, undefined);
    if (page === 'lab') { await app.click('capture-photo'); assert.equal(app.evaluate('prepared.length'), 1); }
    await app.cleanup();
  });
}

for (const profile of profiles) {
  test(`${profile.name} lab: saves photo and negotiated recording with labels, then releases object URLs`, async () => {
    const app = harness('lab', profile); await app.open(); await app.click('capture-photo');
    assert.equal(app.state.photoCalls, 1); assert.equal(app.evaluate('prepared.length'), 1);
    const photo = plain(app.evaluate('prepared[0].metadata'));
    assert.equal(photo.mediaType, 'image'); assert.equal(photo.metadata.mimeType, 'image/png');
    assert.deepEqual(photo.expected, [{ text: result.text, format: 'Code128' }]);
    assert.equal(photo.groupId, 'simulation-label'); assert.equal(photo.split, 'dev');
    await app.click('capture-video'); assert.equal(app.recorders.length, 1);
    const recorder = app.recorders[0];
    const expectedMime = profile === android ? 'video/webm;codecs=vp8' : 'video/mp4';
    assert.equal(recorder.mimeType, expectedMime); assert.equal(recorder.state, 'recording');
    assert.equal(recorder.config.videoBitsPerSecond, 2_500_000); assert.equal(recorder.stream.requestedFPS, 15);
    assert.equal(app.get('capture-photo').disabled, true); assert.equal(app.get('expected').disabled, true);
    await app.runTimer(10000);
    assert.equal(recorder.state, 'inactive'); assert.equal(app.evaluate('recording'), null);
    assert.equal(app.evaluate('prepared.length'), 2); assert.equal(app.canvasStreams[0].track.stopped, 1);
    const clip = plain(app.evaluate('prepared[0].metadata'));
    assert.equal(clip.mediaType, 'video'); assert.equal(clip.metadata.durationMs, 10000);
    assert.equal(clip.metadata.mimeType, expectedMime); assert.match(clip.path, profile === android ? /\.webm$/ : /\.mp4$/);
    assert.deepEqual(clip.expected, photo.expected); assert.equal(clip.groupId, photo.groupId);
    assert.equal(app.get('capture-photo').disabled, false);
    assert.equal(app.objectURLs.size, 4); await app.cleanup();
    assert.equal(app.objectURLs.size, 0); assert.equal(app.revokedURLs.length, 4); assert.equal(app.evaluate('prepared.length'), 0);
  });

  test(`${profile.name} lab: camera interruption discards an active recording and stops its canvas track`, async () => {
    for (const reason of ['close', 'background', 'disconnect', 'pagehide']) {
      const app = harness('lab', profile); await app.open(); await app.click('capture-video');
      if (reason === 'close') await app.click('camera-toggle');
      if (reason === 'background') { app.context.document.hidden = true; await app.event('document', 'visibilitychange'); }
      if (reason === 'disconnect') { app.streams[0].track.listeners.get('ended')(); await flush(); }
      if (reason === 'pagehide') await app.cleanup();
      assert.equal(app.active, false); assert.equal(app.evaluate('recording'), null);
      assert.equal(app.evaluate('prepared.length'), 0, 'Interrupted media must not become a labelled sample');
      assert.ok(app.streams[0].track.stopped > 0); assert.equal(app.canvasStreams[0].track.stopped, 1);
      assert.equal(app.intervals.size, 0); assert.equal([...app.timers.values()].some((timer) => timer.delay === 10000), false);
      await app.cleanup();
    }
  });
}

for (const [name, options] of [['missing MediaRecorder', { recorderTypes: null }], ['no supported recording MIME', { recorderTypes: [] }], ['missing canvas captureStream', { captureStream: false }]]) {
  test(`iPhone-like lab: ${name} explains the limitation and still captures photos`, async () => {
    const app = harness('lab', iphone, options); await app.open(); await app.click('capture-video');
    assert.match(app.error, /Capture photos instead/); assert.equal(app.active, true);
    assert.equal(app.recorders.length, 0); assert.equal(app.canvasStreams.length, 0);
    assert.equal(app.get('capture-photo').disabled, false);
    await app.click('capture-photo'); assert.equal(app.evaluate('prepared.length'), 1);
    assert.equal(app.get('error').hidden, true); await app.cleanup();
  });
}

for (const page of pages) test(`${page}: insecure origins fail before requesting camera access`, async () => {
  const app = harness(page, iphone, { secure: false }); await app.open();
  assert.equal(app.active, false); assert.equal(app.requestedConstraints.length, 0); assert.match(app.error, /HTTPS|localhost/);
  await app.cleanup();
});

test('lab: missing reliable frame counters disables comparisons while photo capture remains available', async () => {
  const app = harness('lab', iphone, { frames: 'unavailable' }); await app.open(); await app.click('trial-toggle');
  assert.match(app.error, /separate camera frames/); assert.equal(app.evaluate('trial'), null);
  assert.equal(app.unresolvedDecodes.length, 0); await app.click('capture-photo');
  assert.equal(app.evaluate('prepared.length'), 1); await app.cleanup();
});

test('lab: recorder constructor failure releases the newly created canvas stream', async () => {
  const app = harness('lab', iphone, { recorderConstructorFails: true }); await app.open(); await app.click('capture-video');
  assert.match(app.error, /Recorder initialization failed/); assert.equal(app.evaluate('recording'), null);
  assert.equal(app.canvasStreams.length, 1); assert.equal(app.canvasStreams[0].track.stopped, 1);
  assert.equal(app.active, true); assert.equal(app.get('capture-photo').disabled, false);
  await app.click('capture-photo'); assert.equal(app.evaluate('prepared.length'), 1); await app.cleanup();
});
