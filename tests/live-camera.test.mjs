/** Actual app lifecycle/selection tests with simulated camera pixels and decoder
 * responses. These do not run Android/iOS browsers or measure camera accuracy. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { inflateSync, deflateSync } from 'node:zlib';

const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const item = { text: 'POS-ITEM-A', format: 'Code128', bytes: [80, 79, 83, 45, 73, 84, 69, 77, 45, 65],
  position: { topLeft: { x: 64, y: 54 }, topRight: { x: 256, y: 54 },
    bottomRight: { x: 256, y: 126 }, bottomLeft: { x: 64, y: 126 } } };
const other = { ...item, text: 'POS-ITEM-B', bytes: [80, 79, 83, 45, 73, 84, 69, 77, 45, 66] };

function cameraHarness({ frames = 'decoded', pos = true, better = false, crops = false, frozen = false,
  width = 320, height = 180, exposureModes = [] } = {}) {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const nodes = new Map(), timers = new Map(), frameCallbacks = new Map(), windowEvents = new Map();
  const messages = [], awaiting = [], streams = [], constraints = [], pixels = [], cameraRequests = [], draws = [];
  const objectUrls = new Map(), revokedUrls = [];
  const state = { now: 1000, frame: 1, scene: 'sharp', frozen, drawCalls: 0 };
  let nextId = 0;

  class Element {
    constructor(id = '') {
      this.id = id; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
      this.textContent = ''; this.children = []; this.attributes = {}; this.listeners = new Map();
      this.style = {}; this.dataset = {};
      const classes = new Set();
      this.classList = { add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
        toggle(name, enabled) { const value = enabled === undefined ? !classes.has(name) : enabled;
          if (value) classes.add(name); else classes.delete(name); return value; } };
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    async dispatch(type) {
      for (const fn of this.listeners.get(type) || []) await fn({ target: this, preventDefault() {} });
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    querySelector() { return this.span ||= new Element(); }
    querySelectorAll() { return [...nodes.values()].filter(node => node.id.startsWith('pos-format-')); }
    click() { return this.dispatch('click'); }
    focus() {}
    remove() {}
  }
  function get(id) {
    if (!nodes.has(id)) {
      const node = new Element(id);
      const tag = [...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].find(match => match[1] === id)?.[0] || '';
      node.checked = /\bchecked\b/.test(tag); node.hidden = /\bhidden\b/.test(tag); node.disabled = /\bdisabled\b/.test(tag);
      node.value = tag.match(/\bvalue="([^"]*)"/)?.[1] || '';
      nodes.set(id, node);
    }
    return nodes.get(id);
  }
  function createElement(tag) {
    const node = new Element();
    if (tag === 'canvas') {
      node.width = 0; node.height = 0;
      let captured = { ...state };
      node.getContext = () => ({
        fillRect() {},
        drawImage(source, ...args) {
          captured = { ...(source.captured || state) }; node.captured = captured; state.drawCalls++;
          draws.push({ source: source.id === 'video' ? 'video' : 'canvas', frame: captured.frame, width: node.width, height: node.height, args });
        },
        getImageData() {
          const data = new Uint8ClampedArray(node.width * node.height * 4).fill(255);
          if (captured.fixture) {
            const fixture = captured.fixture, original = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'));
            for (let y = 0; y < node.height; y++) for (let x = 0; x < node.width; x++) {
              const sx = Math.min(fixture.width - 1, Math.floor((x + .5) * fixture.width / node.width));
              const sy = Math.min(fixture.height - 1, Math.floor((y + .5) * fixture.height / node.height));
              const p = (sy * fixture.width + sx) * 4;
              data.set(original.subarray(p, p + 4), (y * node.width + x) * 4);
            }
            return { width: node.width, height: node.height, data };
          }
          for (let y = 0; y < node.height; y++) for (let x = 0; x < node.width; x++) {
            const within = x > node.width * 0.2 && x < node.width * 0.8 && y > node.height * 0.3 && y < node.height * 0.7;
            let value = 245;
            if (within && captured.scene !== 'blank') {
              const dark = Math.floor(x / 3) % 2;
              value = captured.scene === 'blurred' ? (dark ? 120 : 145) : (dark ? 10 : 240);
            }
            if (captured.scene === 'blank') value = 128;
            const index = (y * node.width + x) * 4;
            data[index] = data[index + 1] = data[index + 2] = value;
          }
          if (!captured.frozen && data.length) data[0] = captured.frame % 256;
          const image = { width: node.width, height: node.height, data };
          pixels.push({ frame: captured.frame, scene: captured.scene, width: node.width, height: node.height });
          return image;
        },
      });
    }
    return node;
  }

  const video = get('video');
  Object.assign(video, { readyState: 4, videoWidth: width, videoHeight: height, currentTime: 0,
    srcObject: null, play: async () => {} });
  if (frames === 'presented') {
    video.requestVideoFrameCallback = fn => { const id = ++nextId; frameCallbacks.set(id, fn); return id; };
    video.cancelVideoFrameCallback = id => frameCallbacks.delete(id);
  } else if (frames === 'decoded') video.getVideoPlaybackQuality = () => ({ totalVideoFrames: state.frame });

  get('pos-mode').checked = pos;
  get('better-frames').checked = better;
  get('target-crops').checked = crops;
  get('pos-confirmation').value = '2';
  for (const name of ['qr', 'code128', 'ean13', 'ean8', 'upca', 'upce', 'datamatrix', 'aztec', 'pdf417', 'code93']) {
    get(`pos-format-${name}`).checked = ['qr', 'code128', 'ean13', 'upca'].includes(name);
  }
  class Worker {
    constructor(url) { this.url = String(url); this.terminated = false; }
    postMessage(message) {
      messages.push(message);
      if (message.type === 'init') queueMicrotask(() => this.onmessage({ data: { id: message.id, type: 'ready' } }));
      else awaiting.push({ message, worker: this });
    }
    terminate() { this.terminated = true; }
  }
  class LocalURL extends URL {
    static createObjectURL(blob) {
      const value = `blob:camera-test-${++nextId}`;
      objectUrls.set(value, blob); return value;
    }
    static revokeObjectURL(value) { revokedUrls.push(value); objectUrls.delete(value); }
  }
  class Image {
    constructor() { this.naturalWidth = 320; this.naturalHeight = 180; }
    set src(value) {
      this.url = value;
      queueMicrotask(() => objectUrls.has(value) ? this.onload?.() : this.onerror?.());
    }
  }
  const document = { hidden: false, getElementById: get, createElement,
    createElementNS: () => new Element(), body: new Element(),
    querySelectorAll: selector => [...nodes.values()].filter(node => selector.includes('pos') && node.id.startsWith('pos-format-')),
    addEventListener(type, fn) { windowEvents.set(`document:${type}`, fn); },
  };
  const globals = {
    console, URL: LocalURL, Blob, Image, ArrayBuffer, Uint8Array, Uint8ClampedArray, Uint32Array, Float64Array, Uint16Array,
    Map, Set, Worker, document, performance: { now: () => state.now },
    navigator: { onLine: true, mediaDevices: {
      async getUserMedia(request) {
        if (request) cameraRequests.push(plain(request));
        const track = { stopped: 0, stop() { this.stopped++; }, addEventListener() {},
          getCapabilities: () => ({ focusMode: ['continuous'], exposureMode: exposureModes,
            torch: true, zoom: { min: 1, max: 4, step: 0.1 } }),
          getSettings: () => ({ deviceId: 'simulated-camera', width, height, zoom: 1 }),
          async applyConstraints(value) { constraints.push(plain(value)); },
        };
        const stream = { track, getTracks: () => [track], getVideoTracks: () => [track] };
        streams.push(stream); return stream;
      },
      async enumerateDevices() { return [{ kind: 'videoinput', deviceId: 'simulated-camera', label: 'Simulated camera' }]; },
    } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'https://simulation.invalid/scan/', reload() {} },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { windowEvents.set(type, fn); },
    isSecureContext: true,
  };
  const context = vm.createContext(globals); context.window = context;
  for (const file of ['scan-policy.js', 'pos-policy.js', 'capture-geometry.js', 'qr-geometry.js', 'frame-analysis.js', 'capture-selection.js', 'frame-fusion.js', 'camera-constraints.js', 'app.js']) {
    vm.runInContext(readFileSync(new URL(`../web/${file}`, import.meta.url), 'utf8'), context, { filename: file });
  }
  const evaluate = code => vm.runInContext(code, context);
  let importing = null;

  return {
    context, state, nodes, get, messages, awaiting, streams, constraints, pixels, draws, timers, objectUrls, revokedUrls, cameraRequests,
    evaluate,
    get history() { return plain(evaluate('history')); },
    get hint() { return get('scan-hint').textContent; },
    async open() { await evaluate('startCamera()'); await flush(); },
    async change(id, value, type = 'change') {
      if (typeof value === 'boolean') get(id).checked = value; else get(id).value = String(value);
      await get(id).dispatch(type); await flush();
    },
    async click(id) { await get(id).click(); await flush(); },
    async event(type) { await windowEvents.get(type)?.(); await flush(); },
    async beginImport() {
      context.testImageFile = new Blob(['simulated encoded PNG; decoding is controlled by the image mock'], { type: 'image/png' });
      importing = evaluate('scanImage(testImageFile)');
      await flush();
    },
    async finishImport() { await importing; await flush(); },
    async tick({ frame = state.frame + 1, now = state.now + 100, scene = state.scene } = {}) {
      state.frame = frame; state.now = now; state.scene = scene; video.currentTime = now / 1000;
      const callback = frameCallbacks.entries().next().value;
      if (callback) { frameCallbacks.delete(callback[0]); callback[1](now, { presentedFrames: frame }); }
      for (const [id, timer] of timers) if (timer.delay < 1000) timers.delete(id);
      evaluate('void scanFrame(generation)'); await flush();
    },
    async reply(results = [item], overrides = {}) {
      const request = awaiting.shift(); assert.ok(request, 'The shipped app must have requested a decode');
      const { message, worker } = request;
      assert.equal(message.type, 'decode');
      assert.equal(message.image.data.byteLength, message.image.width * message.image.height * 4);
      const analysis = context.FrameAnalysis.analyze(message.image);
      if (typeof overrides === 'function') overrides = overrides(analysis);
      worker.onmessage({ data: { id: message.id, type: 'result', results: plain(results), analysis, ...overrides } });
      await flush(); return message;
    },
    async close() { evaluate('stopCamera()'); await flush(); },
  };
}

const fusionFixture = JSON.parse(readFileSync(new URL('fixtures/camera-fusion-development.json', import.meta.url)));
const fusionItem = { text: fusionFixture.text, format: 'QRCode', bytes: [...Buffer.from(fusionFixture.text)] };
async function fusionFrame(app, index, exposure = 0) {
  const source = fusionFixture.frames[index % 3], pixels = inflateSync(Buffer.from(source.rgba_zlib_base64, 'base64'));
  if (exposure) for (let p = 0; p < pixels.length; p += 4) if (pixels[p] < 128) pixels[p] = pixels[p + 1] = pixels[p + 2] = exposure;
  app.state.fixture = { ...source, rgba_zlib_base64: deflateSync(pixels).toString('base64') };
  await app.tick({ now: app.state.now + 150 }); await app.reply([]);
}

test('standalone POS and general camera require disjoint fused bursts, not reused source frames', async () => {
  for (const pos of [true, false]) {
    const app = cameraHarness({ pos, crops: true, width: 164, height: 164 });
    app.get('pos-confirmation').value = '1';
    try {
      await app.open(); await app.reply([]);
      for (let i = 0; i < 3; i++) await fusionFrame(app, i);
      assert.equal(app.awaiting.length, 1); await app.reply([fusionItem]); assert.equal(app.history.length, 0);
      for (let i = 0; i < 3; i++) { await fusionFrame(app, i); assert.equal(app.awaiting.length, 0); }
      for (let i = 0; i < 3; i++) await fusionFrame(app, i, 2);
      assert.equal(app.awaiting.length, 1); await app.reply([fusionItem]);
      assert.equal(app.history.length, 1); assert.equal(app.history[0].text, fusionFixture.text);
    } finally { await app.close(); }
  }
});

test('standalone incomplete fused conflicts remain ambiguous after later singleton bursts', async () => {
  const app = cameraHarness({ crops: true, width: 164, height: 164 });
  app.get('pos-confirmation').value = '1';
  try {
    await app.open(); await app.reply([]); for (let i = 0; i < 3; i++) await fusionFrame(app, i);
    await app.reply([fusionItem, { ...fusionItem, text: fusionFixture.alternateText, bytes: [...Buffer.from(fusionFixture.alternateText)] }],
      { diagnostics: { incompleteEvidence: true } });
    assert.equal(app.history.length, 0); assert.equal(app.get('pos-status').getAttribute('data-state'), 'ambiguous');
    for (let burst = 1; burst <= 2; burst++) {
      for (let i = 0; i < 3; i++) await fusionFrame(app, i, burst * 2);
      await app.reply([fusionItem]); assert.equal(app.history.length, 0); assert.equal(app.get('pos-status').getAttribute('data-state'), 'ambiguous');
    }
  } finally { await app.close(); }
});

test('standalone recovery cannot mix native votes or hide a later unsupported-format conflict', async () => {
  for (const pos of [true, false]) {
    const app = cameraHarness({ pos, crops: true, width: 164, height: 164 });
    try {
      await app.open(); await app.reply([]); for (let i = 0; i < 3; i++) await fusionFrame(app, i);
      await app.reply([fusionItem]); assert.equal(app.history.length, 0);
      app.state.fixture = fusionFixture.clean; await app.tick();
      await app.reply(pos ? [fusionItem] : [{ text: 'OTHER', format: 'Code39', bytes: [...Buffer.from('OTHER')] }]);
      assert.equal(app.history.length, 0, 'native and fused votes cannot combine');
      for (let burst = 1; burst <= 2; burst++) {
        for (let i = 0; i < 3; i++) await fusionFrame(app, i, burst * 2);
        await app.reply([fusionItem]);
      }
      assert.equal(app.history.length, pos ? 1 : 0);
      if (!pos) assert.match(app.hint, /Conflicting/);
    } finally { await app.close(); }
  }
});

test('standalone fused reply cannot outlive its oldest contributing exposure', async () => {
  const app = cameraHarness({ crops: true, width: 164, height: 164 });
  try {
    await app.open(); await app.reply([]); for (let i = 0; i < 3; i++) await fusionFrame(app, i);
    app.state.now += 1001; await app.reply([fusionItem]);
    assert.equal(app.history.length, 0); assert.match(app.get('pos-status').textContent, /too old/);
  } finally { await app.close(); }
});

test('cancelling unresolved permission unlocks import and a late stream cannot finish a newer startup', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  const original = app.context.navigator.mediaDevices.getUserMedia;
  const requests = [];
  app.context.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => requests.push(resolve));
  const first = app.evaluate('startCamera()'); await flush();
  assert.equal(app.evaluate('starting'), true);
  assert.equal(app.get('start').disabled, false, 'opening offers a working Cancel camera action');
  await app.click('start');
  assert.equal(app.evaluate('starting'), false);
  assert.equal(app.get('choose-image').disabled, false);
  const second = app.evaluate('startCamera()'); await flush();
  const stale = await original(); requests[0](stale); await first;
  assert.ok(stale.track.stopped > 0);
  assert.equal(app.evaluate('starting'), true, 'old finalizer cannot unlock a newer operation');
  const fresh = await original(); requests[1](fresh); await second;
  assert.equal(app.evaluate('active'), true);
  assert.equal(app.get('video').srcObject, fresh);
});

test('backgrounding unresolved camera permission immediately restores the main controls', async () => {
  const app = cameraHarness();
  let resolve;
  const original = app.context.navigator.mediaDevices.getUserMedia;
  app.context.navigator.mediaDevices.getUserMedia = () => new Promise(done => { resolve = done; });
  const opening = app.evaluate('startCamera()'); await flush();
  app.context.document.hidden = true; await app.event('document:visibilitychange');
  assert.equal(app.evaluate('starting'), false);
  assert.equal(app.get('choose-image').disabled, false);
  const late = await original(); resolve(late); await opening;
  assert.ok(late.track.stopped > 0);
  assert.equal(app.evaluate('active'), false);
});

for (const method of ['getCapabilities', 'getSettings']) test(`a failing optional ${method} probe keeps main scanning usable`, async t => {
  const app = cameraHarness(); t.after(() => app.close());
  const original = app.context.navigator.mediaDevices.getUserMedia;
  app.context.navigator.mediaDevices.getUserMedia = async () => {
    const stream = await original(); stream.track[method] = () => { throw new Error('Unsupported optional probe'); }; return stream;
  };
  await app.open();
  assert.equal(app.evaluate('active'), true);
  assert.equal(app.streams[0].track.stopped, 0);
  assert.equal(app.awaiting.length, 1);
  assert.equal(app.get('error').hidden, true);
  if (method === 'getCapabilities') assert.equal(app.get('torch').disabled, true);
});

function savedHistory(app, { failSet = null, failRemove = false } = {}) {
  const saved = { ...item, timestamp: 1000 };
  const values = new Map([['barcode-camera.remember.v1', 'true'], ['barcode-camera.history.v1', JSON.stringify([saved])]]);
  app.context.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (key === failSet) throw new Error('Quota exceeded'); values.set(key, value); },
    removeItem(key) { if (failRemove) throw new Error('Storage blocked'); values.delete(key); },
  };
  app.evaluate('loadHistory()');
  return values;
}

test('quota failure preserves a truthful Remember state and explains old durable history', () => {
  const app = cameraHarness();
  const values = savedHistory(app, { failSet: 'barcode-camera.history.v1' });
  app.context.newItem = { ...other, timestamp: 2000 };
  app.evaluate('history.unshift(newItem); saveHistory()');
  assert.equal(app.get('remember').checked, true);
  assert.match(app.get('storage-note').textContent, /changes could not be saved.*Previously saved scans/);
  assert.equal(JSON.parse(values.get('barcode-camera.history.v1')).length, 1);
  assert.equal(values.get('barcode-camera.remember.v1'), 'true');
});

test('failed history removal keeps saving off and explicitly reports remaining device data', async () => {
  const app = cameraHarness();
  const values = savedHistory(app, { failRemove: true });
  await app.change('remember', false);
  assert.equal(app.get('remember').checked, false);
  assert.equal(values.get('barcode-camera.remember.v1'), 'false');
  assert.ok(values.has('barcode-camera.history.v1'));
  assert.match(app.get('storage-note').textContent, /previously saved history could not be removed/);
  app.evaluate('loadHistory()');
  assert.match(app.get('storage-note').textContent, /Previously saved history is still on this device/);
});

test('failed Remember preference write restores the previously durable choice', async () => {
  const app = cameraHarness();
  savedHistory(app, { failSet: 'barcode-camera.remember.v1' });
  await app.change('remember', false);
  assert.equal(app.get('remember').checked, true);
  assert.match(app.get('storage-note').textContent, /preference could not be changed/);
});

test('clearing history reports a storage failure instead of claiming all history was removed', async () => {
  const app = cameraHarness();
  const values = savedHistory(app, { failSet: 'barcode-camera.history.v1' });
  await app.click('clear');
  assert.equal(app.history.length, 0);
  assert.equal(JSON.parse(values.get('barcode-camera.history.v1')).length, 1);
  assert.match(app.get('scan-announcement').textContent, /cleared from this page.*could not be updated/);
});

test('live POS settings reach the worker and disallowed responses cannot enter history', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  for (const name of ['qr', 'ean13', 'upca']) app.get(`pos-format-${name}`).checked = false;
  await app.open();
  const request = app.awaiting[0].message;
  assert.deepEqual(plain(request.posOptions), { allowedFormats: ['code128'], confirmationFrames: 2 });
  assert.equal(request.mode, 'live'); assert.equal(request.enhanceLive, false);
  await app.reply([{ ...item, format: 'QRCode' }]);
  assert.equal(app.history.length, 0);
  assert.match(app.get('pos-status').textContent, /No allowed code/);
  await app.tick(); await app.reply();
  assert.equal(app.history.length, 0);
  await app.tick(); await app.reply();
  assert.equal(app.history.length, 1);
  assert.equal(app.history[0].text, item.text);
});

for (const frames of ['presented', 'decoded']) test(`${frames} camera evidence requires two distinct images`, async t => {
  const app = cameraHarness({ frames }); t.after(() => app.close());
  await app.open();
  if (frames === 'presented') await app.tick({ frame: 1 });
  await app.reply(); assert.equal(app.history.length, 0);
  await app.tick({ frame: 1 });
  assert.equal(app.awaiting.length, 0, 'same camera frame is never sent twice');
  await app.tick({ frame: 2 }); await app.reply();
  assert.equal(app.history.length, 1);
  assert.match(app.get('pos-status').textContent, /distinct frames/);
});

test('a changing frame counter with frozen pixels cannot confirm a POS value', async t => {
  const app = cameraHarness({ frozen: true }); t.after(() => app.close());
  await app.open(); await app.reply();
  for (let frame = 2; frame <= 4; frame++) {
    await app.tick({ frame }); await app.reply();
    assert.equal(app.history.length, 0);
    assert.match(app.get('pos-status').textContent, /1 of 2/);
  }
});

test('full-frame conflicts remain ambiguous despite repeated agreement with one candidate', async t => {
  const app = cameraHarness({ crops: true }); t.after(() => app.close());
  await app.open();
  assert.equal(app.awaiting[0].message.enhanceLive, true);
  assert.equal(app.awaiting[0].message.image.width, 320, 'POS sends the entire frame before worker crop retries');
  await app.reply([item, other]);
  assert.equal(app.history.length, 0);
  for (let frame = 2; frame <= 4; frame++) {
    await app.tick({ frame }); await app.reply([item]);
    assert.equal(app.history.length, 0);
    assert.equal(app.get('pos-status').getAttribute('data-state'), 'ambiguous');
  }
  await app.click('rescan');
  await app.tick(); await app.reply();
  assert.equal(app.history.length, 0, 'new scan has discarded previous votes');
  await app.tick(); await app.reply();
  assert.equal(app.history.length, 1);
});

test('live QR results with equal bytes and different ECI text cannot confirm each other', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  const latin1 = { ...item, format: 'QRCode', bytes: [0xc3, 0xa4], text: '\u00c3\u00a4' };
  const utf8 = { ...latin1, text: '\u00e4' };
  await app.open(); await app.reply([latin1]);
  await app.tick(); await app.reply([utf8]);
  assert.equal(app.history.length, 0);
  assert.equal(app.get('pos-status').getAttribute('data-state'), 'ambiguous');
});

test('changing confirmation settings discards previous votes and an in-flight response', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  await app.open(); await app.reply();
  await app.tick(); assert.equal(app.awaiting.length, 1);
  await app.change('pos-confirmation', 3);
  await app.reply(); assert.equal(app.history.length, 0);
  for (let frame = 3; frame <= 5; frame++) {
    await app.tick({ frame });
    assert.equal(app.awaiting[0].message.posOptions.confirmationFrames, 3);
    await app.reply();
    assert.equal(app.history.length, frame === 5 ? 1 : 0);
  }
});

test('changing POS mode discards its pending result before returning to general scanning', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  app.get('pos-confirmation').value = '1';
  await app.open();
  await app.change('pos-mode', false);
  await app.reply(); assert.equal(app.history.length, 0);
  await app.tick();
  assert.equal('posOptions' in app.awaiting[0].message, false);
  await app.reply(); assert.equal(app.history.length, 0);
  await app.tick(); await app.reply();
  assert.equal(app.history.length, 1);
});

test('zoom changes invalidate POS evidence and pre-zoom results', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  await app.open(); await app.reply();
  await app.tick();
  await app.change('zoom', 2, 'input');
  assert.ok(app.constraints.some(value => value.advanced?.some(entry => entry.zoom === 2)));
  await app.reply(); assert.equal(app.history.length, 0);
  await app.tick(); await app.reply(); assert.equal(app.history.length, 0);
  await app.tick(); await app.reply(); assert.equal(app.history.length, 1);
});

test('clock-only browsers require explicit single-frame POS mode', async t => {
  const app = cameraHarness({ frames: 'clock' }); t.after(() => app.close());
  await app.open(); await app.reply();
  await app.tick(); await app.reply();
  assert.equal(app.history.length, 0);
  assert.match(app.get('pos-status').textContent, /Fresh frames could not be verified/);
  await app.change('pos-confirmation', 1);
  await app.tick(); await app.reply();
  assert.equal(app.history.length, 1);
});

test('quality selection sends the sharpest fresh image and confirms only across separate bursts', async t => {
  const app = cameraHarness({ better: true, crops: true }); t.after(() => app.close());
  app.state.scene = 'blurred';
  await app.open(); assert.equal(app.awaiting.length, 0);
  await app.tick({ frame: 2, now: 1080, scene: 'sharp' }); assert.equal(app.awaiting.length, 0);
  await app.tick({ frame: 3, now: 1160, scene: 'blurred' });
  assert.equal(app.awaiting.length, 1);
  const chosen = app.awaiting[0].message;
  assert.equal(new Uint8Array(chosen.image.data)[0], 2, 'decoder receives the sharp middle frame');
  assert.equal(chosen.enhanceLive, true);
  await app.reply(); assert.equal(app.history.length, 0);
  await app.tick({ frame: 4, now: 1240, scene: 'blurred' });
  await app.tick({ frame: 5, now: 1320, scene: 'sharp' });
  await app.tick({ frame: 6, now: 1400, scene: 'blurred' });
  assert.equal(new Uint8Array(app.awaiting[0].message.image.data)[0], 5);
  await app.reply(); assert.equal(app.history.length, 1);
});

test('weak-detail scenes still receive bounded decode attempts and actionable guidance', async t => {
  const app = cameraHarness({ better: true, crops: true }); t.after(() => app.close());
  app.state.scene = 'blank';
  await app.open();
  await app.tick({ frame: 2, now: 1080 });
  await app.tick({ frame: 3, now: 1160 });
  assert.equal(app.awaiting.length, 1, 'quality ranking must not starve difficult images');
  await app.reply([]);
  assert.match(app.hint, /Hold still|focus/);
  assert.equal(app.history.length, 0);
  await app.tick({ frame: 4, now: 1240 });
  await app.tick({ frame: 5, now: 1320 });
  await app.tick({ frame: 6, now: 1400 });
  assert.equal(app.awaiting.length, 1, 'another fresh burst receives another bounded attempt');
});

test('a stalled camera flushes one pending frame once without inventing extra observations', async t => {
  const app = cameraHarness({ better: true }); t.after(() => app.close());
  await app.open(); assert.equal(app.awaiting.length, 0);
  await app.tick({ frame: 1, now: 1240 });
  assert.equal(app.awaiting.length, 1);
  await app.reply(); assert.equal(app.history.length, 0);
  await app.tick({ frame: 1, now: 1480 });
  assert.equal(app.awaiting.length, 0);
  assert.equal(app.history.length, 0);
});

test('settings changes clear a partially collected quality burst', async t => {
  const app = cameraHarness({ better: true }); t.after(() => app.close());
  await app.open();
  await app.tick({ frame: 2, now: 1080 }); assert.equal(app.awaiting.length, 0);
  await app.change('target-crops', true);
  await app.tick({ frame: 3, now: 1160 }); assert.equal(app.awaiting.length, 0);
  await app.tick({ frame: 4, now: 1240 }); assert.equal(app.awaiting.length, 0);
  await app.tick({ frame: 5, now: 1320 });
  assert.equal(app.awaiting.length, 1);
  assert.ok(new Uint8Array(app.awaiting[0].message.image.data)[0] >= 3, 'old buffered frames were discarded');
  assert.equal(app.awaiting[0].message.enhanceLive, true);
});

test('quality frames older than the selection limit are dropped without decoding', async t => {
  const app = cameraHarness({ better: true }); t.after(() => app.close());
  await app.open();
  await app.tick({ frame: 1, now: 1701 });
  assert.equal(app.awaiting.length, 0);
  await app.tick({ frame: 2, now: 1800 });
  await app.tick({ frame: 3, now: 1880 });
  await app.tick({ frame: 4, now: 1960 });
  assert.equal(app.awaiting.length, 1);
  assert.notEqual(new Uint8Array(app.awaiting[0].message.image.data)[0], 1);
});

test('a delayed worker reply cannot accept an old selected POS frame', async t => {
  const app = cameraHarness({ better: true }); t.after(() => app.close());
  app.get('pos-confirmation').value = '1';
  await app.open();
  await app.tick({ frame: 2, now: 1080 });
  await app.tick({ frame: 3, now: 1160 });
  app.state.now = 2500;
  await app.reply();
  assert.equal(app.history.length, 0);
  assert.match(app.get('pos-status').textContent, /too old/);
});

test('deselecting all POS formats stops scanning with a clear validation message', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  await app.open(); await app.reply([]);
  for (const name of ['ean13', 'upca', 'qr', 'code128']) await app.change(`pos-format-${name}`, false);
  assert.equal(app.evaluate('active'), false);
  assert.match(app.get('error-text').textContent, /at least one barcode format/);
  assert.ok(app.streams[0].track.stopped > 0);
});

test('POS image import cannot borrow live evidence or accumulate separate imports into confirmation', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  await app.open(); await app.reply();
  assert.equal(app.history.length, 0, 'live camera has only one observation');
  for (let attempt = 0; attempt < 2; attempt++) {
    await app.beginImport();
    assert.equal(app.evaluate('active'), false);
    assert.equal(app.awaiting[0].message.mode, 'image');
    assert.equal(app.awaiting[0].message.posOptions.confirmationFrames, 2);
    await app.reply(); await app.finishImport();
    assert.equal(app.history.length, 0);
    assert.match(app.get('pos-status').textContent, /One image cannot confirm across frames/);
  }
  assert.equal(app.objectUrls.size, 0);
  assert.equal(app.revokedUrls.length, 2);
  assert.equal(app.evaluate('importBusy'), false);
  await app.open(); await app.reply();
  assert.equal(app.history.length, 0, 'returning to the camera starts fresh confirmation');
  await app.tick(); await app.reply();
  assert.equal(app.history.length, 1);
});

test('single-frame POS import selects only the allowed result instead of passing through raw results', async t => {
  const app = cameraHarness({ crops: true }); t.after(() => app.close());
  app.get('pos-confirmation').value = '1';
  for (const name of ['qr', 'ean13', 'upca']) app.get(`pos-format-${name}`).checked = false;
  await app.beginImport();
  assert.deepEqual(plain(app.awaiting[0].message.posOptions), { allowedFormats: ['code128'], confirmationFrames: 1 });
  assert.equal(app.awaiting[0].message.enhanceLive, true);
  await app.reply([item, { ...other, format: 'QRCode' }]); await app.finishImport();
  assert.equal(app.history.length, 1);
  assert.equal(app.history[0].text, item.text);
  assert.equal(app.get('pos-status').getAttribute('data-state'), 'confirmed');
  assert.equal(app.objectUrls.size, 0);
});

test('disallowed and malformed imported decoder results never enter POS history', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  app.get('pos-confirmation').value = '1';
  for (const name of ['qr', 'ean13', 'upca']) app.get(`pos-format-${name}`).checked = false;
  for (const results of [[{ ...item, format: 'QRCode' }], [{ ...item, bytes: undefined }]]) {
    await app.beginImport(); await app.reply(results); await app.finishImport();
    assert.equal(app.history.length, 0);
    assert.equal(app.get('pos-status').getAttribute('data-state'), 'rescan');
  }
});

test('two allowed values in one imported image stay ambiguous in single-frame mode', async t => {
  const app = cameraHarness(); t.after(() => app.close());
  app.get('pos-confirmation').value = '1';
  await app.beginImport(); await app.reply([item, other]); await app.finishImport();
  assert.equal(app.history.length, 0);
  assert.equal(app.get('pos-status').getAttribute('data-state'), 'ambiguous');
  assert.match(app.get('pos-status').textContent, /Conflicting codes/);
});

for (const trigger of ['reset', 'pagehide']) test(`an image response after ${trigger} cannot publish stale POS history`, async t => {
  const app = cameraHarness(); t.after(() => app.close());
  app.get('pos-confirmation').value = '1';
  await app.beginImport();
  assert.equal(app.get('rescan').disabled, true, 'new-scan control is unavailable during import');
  assert.equal(app.awaiting.length, 1);
  if (trigger === 'reset') app.evaluate('resetScanEvidence()');
  else await app.event('pagehide');
  await app.reply(); await app.finishImport();
  assert.equal(app.history.length, 0);
  assert.equal(app.objectUrls.size, 0);
  assert.equal(app.evaluate('importBusy'), false);
});

for (const input of ['camera', 'image']) test(`${input} history keeps distinct accepted QR text encodings across separate attempts`, async t => {
  const app = cameraHarness(); t.after(() => app.close());
  app.get('pos-confirmation').value = '1';
  const latin1 = { ...item, format: 'QRCode', bytes: [0xc3, 0xa4], text: '\u00c3\u00a4' };
  const utf8 = { ...latin1, text: '\u00e4' };
  if (input === 'camera') {
    await app.open(); await app.reply([latin1]);
    await app.tick(); await app.reply([utf8]);
    await app.tick(); await app.reply([latin1]);
  } else {
    for (const result of [latin1, utf8, latin1]) {
      await app.beginImport(); await app.reply([result]); await app.finishImport();
    }
  }
  assert.equal(app.history.length, 2, 'identical bytes do not erase a different text interpretation');
  assert.deepEqual(new Set(app.history.map(result => result.text)), new Set([latin1.text, utf8.text]));
});

// These tests control the worker's quality hint while retaining its actual pixel
// fingerprint. They exercise camera orchestration, not the accuracy of a hint.
const usefulMiss = analysis => ({ analysis: { ...analysis, hint: 'small',
  regions: [{ x: 20, y: 20, width: 80, height: 40, kind: 'linear' }] } });
const imagePixels = request => request.image.width * request.image.height;
async function startDetailAttempt(app) {
  await app.open(); await app.reply([], usefulMiss);
  await app.tick({ now: 1200 }); await app.reply([], usefulMiss);
  await app.tick({ now: 1400 }); await app.reply([], usefulMiss);
}

for (const crops of [false, true]) test(`targeted crops ${crops ? 'on requests UHD and continuous exposure' : 'off keeps HD and leaves exposure alone'}`, async t => {
  const app = cameraHarness({ crops, width: 3840, height: 2160, exposureModes: ['manual', 'continuous'] });
  t.after(() => app.close());
  await app.open();
  const request = app.cameraRequests[0];
  assert.deepEqual(request, { audio: false, video: { width: { ideal: crops ? 3840 : 1920 },
    height: { ideal: crops ? 2160 : 1080 }, facingMode: { ideal: 'environment' } } });
  const controls = app.constraints[0];
  assert.deepEqual(controls.width, request.video.width, 'optional controls retain capture dimensions');
  assert.deepEqual(controls.facingMode, request.video.facingMode, 'optional controls retain the rear-camera preference');
  assert.deepEqual(controls.advanced, [{ focusMode: 'continuous', ...(crops ? { exposureMode: 'continuous' } : {}) }]);
  assert.equal(app.awaiting[0].message.image.width, 1920, 'the first decode remains at normal detail');
  assert.ok(imagePixels(app.awaiting[0].message) <= 2_100_000);
});

test('unsupported exposure is not requested and rejected optional controls cannot disable scanning', async t => {
  const app = cameraHarness({ crops: true, exposureModes: ['manual'] }); t.after(() => app.close());
  const original = app.context.navigator.mediaDevices.getUserMedia;
  app.context.navigator.mediaDevices.getUserMedia = async request => {
    const stream = await original(request);
    stream.track.applyConstraints = async value => { app.constraints.push(plain(value)); throw new Error('Optional control unavailable'); };
    return stream;
  };
  await app.open();
  assert.deepEqual(app.constraints[0].advanced, [{ focusMode: 'continuous' }]);
  assert.equal(app.evaluate('active'), true);
  assert.equal(app.get('error').hidden, true);
  await app.reply(); await app.tick(); await app.reply();
  assert.equal(app.history.length, 1, 'a camera control failure does not prevent independent-frame confirmation');
});

test('automatic detail waits for useful misses across time, caps pixels, then expires and cools down', async t => {
  const app = cameraHarness({ crops: true, width: 3840, height: 2160 }); t.after(() => app.close());
  await app.open(); await app.reply([], usefulMiss);
  for (const now of [1100, 1200]) {
    await app.tick({ now });
    assert.ok(imagePixels(app.awaiting[0].message) <= 2_100_000);
    await app.reply([], usefulMiss);
    assert.doesNotMatch(app.hint, /Trying more image detail/, 'three rapid misses are insufficient');
  }
  await app.tick({ now: 1400 });
  assert.ok(imagePixels(app.awaiting[0].message) <= 2_100_000, 'escalation affects the next capture');
  await app.reply([], usefulMiss);
  assert.match(app.hint, /Trying more image detail/);
  await app.tick({ now: 1600 });
  const detailed = app.awaiting[0].message;
  assert.ok(imagePixels(detailed) > 2_100_000);
  assert.ok(imagePixels(detailed) <= 4_000_000);
  assert.ok(detailed.image.width <= 3840 && detailed.image.height <= 3840);
  assert.ok(Math.abs(detailed.image.width / detailed.image.height - 16 / 9) < 0.005,
    'extra detail still covers the full camera frame before worker crops');
  assert.equal(detailed.enhanceLive, true);
  await app.reply([], usefulMiss);
  for (const now of [4400, 4600, 4800, 5000]) {
    await app.tick({ now });
    assert.ok(imagePixels(app.awaiting[0].message) <= 2_100_000, 'the three-second detail window is bounded and cannot immediately restart');
    await app.reply([], usefulMiss);
  }
  assert.equal(app.history.length, 0);
});

test('turning targeted crops off prevents automatic detail even after useful misses', async t => {
  const app = cameraHarness({ crops: false, width: 3840, height: 2160 }); t.after(() => app.close());
  await app.open();
  for (let i = 0; i < 6; i++) {
    if (i) await app.tick({ now: 1000 + i * 250 });
    assert.ok(imagePixels(app.awaiting[0].message) <= 2_100_000);
    assert.equal(app.awaiting[0].message.enhanceLive, false);
    await app.reply([], usefulMiss);
    assert.doesNotMatch(app.hint, /Trying more image detail/);
  }
});

test('an automatic detail transition retains conflicts across later normal-resolution frames', async t => {
  const app = cameraHarness({ crops: true, width: 3840, height: 2160 }); t.after(() => app.close());
  await startDetailAttempt(app);
  await app.tick({ now: 3900 }); await app.reply([], usefulMiss);
  await app.tick({ now: 4200 });
  assert.ok(imagePixels(app.awaiting[0].message) > 2_100_000);
  await app.reply([item, other]);
  assert.equal(app.get('pos-status').getAttribute('data-state'), 'ambiguous');
  for (const now of [4500, 4700, 4900]) {
    await app.tick({ now });
    assert.ok(imagePixels(app.awaiting[0].message) <= 2_100_000);
    await app.reply([item]);
    assert.equal(app.history.length, 0);
    assert.equal(app.get('pos-status').getAttribute('data-state'), 'ambiguous', 'changing image detail must not erase competing identities');
  }
});

test('a late detailed response is discarded and ends the automatic detail window', async t => {
  const app = cameraHarness({ crops: true, width: 3840, height: 2160 }); t.after(() => app.close());
  app.get('pos-confirmation').value = '1';
  await startDetailAttempt(app);
  await app.tick({ now: 1600 });
  assert.ok(imagePixels(app.awaiting[0].message) > 2_100_000);
  app.state.now = 2901;
  await app.reply([item]);
  assert.equal(app.history.length, 0);
  assert.match(app.get('pos-status').textContent, /too old/);
  await app.tick({ now: 3100 });
  assert.ok(imagePixels(app.awaiting[0].message) <= 2_100_000);
});

test('detail expiration cannot turn a frozen image into a second POS observation', async t => {
  const app = cameraHarness({ crops: true, width: 3840, height: 2160 }); t.after(() => app.close());
  await startDetailAttempt(app);
  await app.tick({ now: 3900 }); await app.reply([], usefulMiss);
  app.state.frozen = true;
  await app.tick({ now: 4200 });
  assert.ok(imagePixels(app.awaiting[0].message) > 2_100_000);
  await app.reply([item]);
  assert.equal(app.history.length, 0);
  await app.tick({ now: 4500 });
  assert.ok(imagePixels(app.awaiting[0].message) <= 2_100_000);
  await app.reply([item]);
  assert.equal(app.history.length, 0, 'resampling a frozen scene cannot supply the missing independent observation');
});

function detailRegions(app, count = 2) {
  const analyze = app.context.FrameAnalysis.analyze;
  app.context.FrameAnalysis.analyze = image => ({ ...analyze(image), regionsComplete: true,
    regions: Array.from({ length: count }, (_, index) => ({ x: Math.floor(image.width * (0.1 + index * 0.25)),
      y: Math.floor(image.height * 0.3), width: Math.floor(image.width * 0.1), height: Math.floor(image.height * 0.15), kind: 'matrix', qr: true })) });
  app.evaluate('cameraRecovery.detailed = () => true');
}

test('standalone detail captures freeze one UHD exposure, inspect the full view first and remap both source crops', async t => {
  const app = cameraHarness({ crops: true, width: 3840, height: 2160 }); t.after(() => app.close());
  detailRegions(app);
  await app.open();
  const broad = app.awaiting[0].message;
  assert.ok(imagePixels(broad) <= 4_000_000 && imagePixels(broad) > 2_100_000);
  const snapshotDraw = app.draws.find(draw => draw.source === 'video' && draw.width === 3840);
  assert.ok(snapshotDraw); assert.ok(snapshotDraw.width * snapshotDraw.height <= 8_294_400);
  const captureDraws = app.draws.filter(draw => draw.source === 'canvas');
  assert.equal(captureDraws.length, 3, 'broad image and two detail crops all use the frozen canvas');
  assert.ok(captureDraws.every(draw => draw.frame === 1));
  app.state.frame = 9; // A later video frame must never supply another crop.
  const drawCount = app.state.drawCalls;
  await app.reply([]);
  assert.equal(app.awaiting.length, 1); assert.equal(app.awaiting[0].message.enhanceLive, false);
  assert.ok(imagePixels(app.awaiting[0].message) <= 1_000_000);
  await app.reply([item]);
  assert.equal(app.history.length, 0, 'one crop does not publish before the second proposal is checked');
  await app.reply([other]);
  assert.equal(app.state.drawCalls, drawCount, 'decoding never recaptures moving video');
  assert.equal(app.get('pos-status').getAttribute('data-state'), 'ambiguous');
  assert.equal(app.history.length, 0);
});

test('standalone source crops from one exposure count as one POS confirmation observation', async t => {
  const app = cameraHarness({ crops: true, width: 3840, height: 2160 }); t.after(() => app.close());
  detailRegions(app);
  await app.open(); await app.reply([]); await app.reply([item]); await app.reply([item]);
  assert.equal(app.history.length, 0); assert.match(app.get('pos-status').textContent, /1 of 2/);
  await app.tick({ frame: 2, now: 1200 }); await app.reply([]); await app.reply([item]); await app.reply([item]);
  assert.equal(app.history.length, 1);
  assert.ok(app.history[0].position.topLeft.x > item.position.topLeft.x + 300, 'crop coordinates return to the original video');
});

test('standalone source crop truncation and decode deadlines cannot publish a partial unique result', async t => {
  for (const reason of ['count', 'deadline', 'settings']) {
    const app = cameraHarness({ crops: true, width: 3840, height: 2160 }); t.after(() => app.close());
    app.get('pos-confirmation').value = '1'; detailRegions(app, reason === 'count' ? 3 : 2);
    await app.open(); await app.reply([]);
    if (reason === 'deadline') app.state.now = 1351;
    if (reason === 'settings') await app.change('pos-confirmation', '2');
    await app.reply([item]);
    if (reason === 'count') await app.reply([item]);
    assert.equal(app.history.length, 0, reason);
    assert.equal(app.awaiting.length, 0, 'no remaining crop starts after the task becomes invalid');
  }
});

test('standalone source retries cannot erase a partial value withheld by the worker', async t => {
  for (const phase of ['broad', 'crop']) {
    const app = cameraHarness({ crops: true, width: 3840, height: 2160 }); t.after(() => app.close());
    app.get('pos-confirmation').value = '1'; detailRegions(app);
    await app.open();
    if (phase === 'broad') await app.reply([], { diagnostics: { incompleteEvidence: true } });
    else {
      await app.reply([]); await app.reply([], { diagnostics: { incompleteEvidence: true } }); await app.reply([item]);
    }
    assert.equal(app.history.length, 0); assert.equal(app.awaiting.length, 0);
  }
});
