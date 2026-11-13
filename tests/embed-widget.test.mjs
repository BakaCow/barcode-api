import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/embed/widget.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const CHANNEL = '12'.repeat(16), ORIGIN = 'https://shop.example';
const options = { formats: ['code128', 'qr'], confirmationFrames: 2, controls: true };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness({ origin = ORIGIN, channel = CHANNEL, embedded = true, policyAllowsCamera = true } = {}) {
  const elements = new Map(), windowEvents = new Map(), documentEvents = new Map(), frames = new Map(), calls = [], sent = [], starts = [];
  let callbacks, creates = 0, controlsCreates = 0, destroyed = 0, controlsDestroyed = 0, disconnected = 0, frameId = 0, hostRevision = 0;
  const element = () => ({ hidden: false, disabled: false, srcObject: null, textContent: '', dataset: {}, events: new Map(),
    addEventListener(type, fn) { this.events.set(type, fn); }, removeEventListener(type, fn) { if (this.events.get(type) === fn) this.events.delete(type); },
    getBoundingClientRect: () => ({ height: 620 }) });
  const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  $('start').disabled = $('stop').disabled = $('next').disabled = true; $('error').hidden = $('format').hidden = $('camera-controls').hidden = true;
  const parent = { postMessage(packet, target) { sent.push({ packet, target }); } };
  const window = { parent, location: { hash: `#parentOrigin=${encodeURIComponent(origin)}&channel=${channel}` },
    addEventListener(type, fn) { windowEvents.set(type, fn); }, removeEventListener(type, fn) { if (windowEvents.get(type) === fn) windowEvents.delete(type); },
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class { observe() {} disconnect() { disconnected++; } },
  };
  if (!embedded) window.parent = window;
  const document = { hidden: false, getElementById: $, permissionsPolicy: { allowsFeature: () => policyAllowsCamera },
    addEventListener(type, fn) { documentEvents.set(type, fn); }, removeEventListener(type, fn) { if (documentEvents.get(type) === fn) documentEvents.delete(type); } };
  function status(state) { callbacks.onStatus({ state, message: state + ' message' }); }
  const scanner = {
    start() { calls.push('start'); status('starting'); const request = deferred(); starts.push(request); return request.promise.then(() => { $('video').srcObject = {}; status('scanning'); }); },
    stop() { calls.push('stop'); $('video').srcObject = null; status('stopped'); },
    destroy() { destroyed++; $('video').srcObject = null; status('destroyed'); },
    rescan() { calls.push('rescan'); status('scanning'); },
  };
  const context = vm.createContext({ window, document, URL, URLSearchParams,
    createScanner(value) { callbacks = value; creates++; return scanner; },
    attachScannerControls() { controlsCreates++; return { updateStatus() {}, updateCandidates() {}, destroy() { controlsDestroyed++; } }; },
  });
  vm.runInContext(source, context);
  const packet = (type, payload = {}, revision = hostRevision) => ({ protocol: 'barcode-camera-embed', version: 1, channel: CHANNEL, revision, type, payload });
  const message = (type, payload, extra = {}) => {
    if (['stop', 'rescan', 'destroy'].includes(type)) hostRevision++;
    windowEvents.get('message')?.({ data: packet(type, payload), source: parent, origin: ORIGIN, ...extra });
  };
  return { $, parent, window, document, calls, sent, starts, status, message, packet,
    configure(value = options) { message('configure', value); },
    fire(id) { return $(id).events.get('click')?.(); },
    flushResize() { const values = [...frames.values()]; frames.clear(); values.forEach(fn => fn()); },
    hide() { document.hidden = true; documentEvents.get('visibilitychange')?.(); },
    pagehide() { windowEvents.get('pagehide')?.(); },
    get callbacks() { return callbacks; }, get counts() { return { creates, controlsCreates, destroyed, controlsDestroyed, disconnected, frames: frames.size, listeners: windowEvents.size }; },
  };
}

test('widget handshake pins the parent and does not open a camera on configure', () => {
  const h = harness(); assert.equal(h.sent[0].packet.type, 'hello'); assert.equal(h.sent[0].target, ORIGIN);
  assert.equal(h.$('start').disabled, true); h.configure();
  assert.equal(h.counts.creates, 1); assert.equal(h.counts.controlsCreates, 1); assert.deepEqual(h.calls, []);
  assert.equal(h.$('start').disabled, false); assert.ok(h.sent.some(event => event.packet.type === 'ready'));
  assert.deepEqual(Array.from(h.callbacks.formats), ['code128', 'qr']); assert.equal(h.callbacks.confirmationFrames, 2);
});

test('wrong origin, source, protocol, version or channel cannot configure or control the widget', () => {
  const h = harness();
  const bad = [{ origin: 'https://attacker.example' }, { source: {} },
    { data: { ...h.packet('configure', options), protocol: 'other' } },
    { data: { ...h.packet('configure', options), version: 2 } },
    { data: { ...h.packet('configure', options), channel: '34'.repeat(16) } }];
  for (const extra of bad) h.message('configure', options, extra);
  assert.equal(h.counts.creates, 0); h.configure();
  for (const extra of bad) h.message('stop', {}, extra);
  assert.deepEqual(h.calls, []);
});

test('invalid or non-embedded parent contexts never create a camera scanner', () => {
  for (const settings of [{ embedded: false }, { origin: 'null' }, { origin: '*' }, { origin: 'http://shop.example' },
    { origin: 'https://shop.example/path' }, { origin: 'https://user@shop.example' }, { channel: 'bad' }]) {
    const h = harness(settings); h.configure(); h.fire('start');
    assert.equal(h.counts.creates, 0); assert.equal(h.sent.length, 0); assert.equal(h.$('start').disabled, true);
  }
});

test('invalid options fail safely, and duplicate configuration cannot weaken a confirmed attempt', () => {
  const h = harness();
  for (const settings of [null, [], { formats: [] }, { formats: ['code128', 'code128'] }, { formats: ['unknown'] },
    { confirmationFrames: 0 }, { confirmationFrames: '1' }, { controls: 'true' }, { autoplay: true }]) h.configure(settings);
  assert.equal(h.counts.creates, 0); assert.equal(h.$('error').hidden, false);
  h.configure(); h.status('confirmed');
  h.configure({ formats: ['qr'], confirmationFrames: 1, controls: false });
  assert.equal(h.counts.creates, 1); assert.equal(h.callbacks.confirmationFrames, 2);
  assert.deepEqual(Array.from(h.callbacks.formats), ['code128', 'qr']); assert.equal(h.$('next').disabled, false);
});

test('host cannot remotely start the camera; explicit button activation can', async () => {
  const h = harness(); h.configure(); h.message('start'); assert.deepEqual(h.calls, []);
  const start = h.fire('start'); assert.deepEqual(h.calls, ['start']); assert.equal(h.$('stop').disabled, false);
  h.starts[0].resolve(); await start;
  assert.equal(h.$('stage').dataset.running, 'true'); assert.equal(h.$('camera-state').textContent, 'Camera live');
});

test('camera changes started by advanced controls keep Stop available', () => {
  const h = harness(); h.configure(); h.status('starting');
  assert.equal(h.$('start').disabled, true); assert.equal(h.$('stop').disabled, false);
  h.fire('stop'); assert.equal(h.$('start').disabled, false); assert.deepEqual(h.calls, ['stop']);
});

test('confirmed raw values are displayed as text and sent with increasing sequence numbers', () => {
  const h = harness(); h.configure(); h.status('confirmed');
  const result = { scanId: 'scan-1', text: '<img src=x onerror=alert(1)>', format: 'code128', bytesBase64: 'YQ==', position: null };
  h.callbacks.onScan(result); h.callbacks.onScan({ ...result, scanId: 'scan-2' });
  assert.equal(h.$('value').textContent, result.text); assert.equal(h.$('value').dataset.confirmed, 'true');
  const scans = h.sent.filter(event => event.packet.type === 'scan');
  assert.deepEqual(scans.map(event => event.packet.payload.sequence), [1, 2]);
  assert.equal(scans[0].packet.payload.result, result); assert.equal(h.$('next').disabled, false);
  h.message('rescan'); assert.deepEqual(h.calls, ['rescan']);
});

test('Stop cancels busy UI immediately and late abort cannot overwrite a newer startup', async () => {
  const h = harness(); h.configure(); const first = h.fire('start');
  h.message('stop'); assert.equal(h.$('start').disabled, false); assert.equal(h.$('stop').disabled, true);
  const second = h.fire('start');
  h.starts[0].reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); await first;
  assert.equal(h.$('status').textContent, 'starting message'); assert.equal(h.$('start').disabled, true); assert.equal(h.$('error').hidden, true);
  h.starts[1].resolve(); await second; assert.equal(h.$('camera-state').textContent, 'Camera live');
});

test('hidden document and pagehide stop scanning and ignore late startup failures', async () => {
  for (const exit of ['hide', 'pagehide']) {
    const h = harness(); h.configure(); const pending = h.fire('start'); h[exit]();
    h.starts[0].reject(new Error('Late failure')); await pending;
    assert.equal(h.$('error').hidden, true); assert.equal(h.$('status').textContent, 'stopped message');
  }
});

test('blocked camera policy provides recovery without invoking getUserMedia', async () => {
  const h = harness({ policyAllowsCamera: false }); h.configure(); await h.fire('start');
  assert.deepEqual(h.calls, []); assert.match(h.$('error').textContent, /blocked camera access/);
  assert.equal(h.$('start').disabled, false); assert.equal(h.sent.filter(event => event.packet.type === 'error').length, 1);
});

test('command revisions survive pre-configuration and reject replayed commands and old configuration', () => {
  const h = harness(); h.message('stop'); h.configure();
  assert.equal(h.sent.find(event => event.packet.type === 'ready').packet.revision, 1);
  h.status('confirmed'); h.callbacks.onScan({ scanId: 'new', text: 'code', format: 'code128' });
  assert.equal(h.sent.findLast(event => event.packet.type === 'scan').packet.revision, 1);
  h.message('rescan'); const count = h.calls.length;
  h.message('rescan', {}, { data: h.packet('rescan', {}, 2) });
  h.message('configure', options, { data: h.packet('configure', options, 0) });
  h.message('stop', {}, { data: h.packet('stop', {}, -1) });
  assert.equal(h.calls.length, count); assert.equal(h.counts.creates, 1);
  assert.equal(h.sent.findLast(event => event.packet.type === 'status').packet.revision, 2);
});

test('controls can be omitted, resize is bounded/deduplicated, and destroy removes active resources', async () => {
  const h = harness(); h.configure({ ...options, controls: false }); assert.equal(h.counts.controlsCreates, 0);
  h.flushResize(); h.configure(); h.flushResize();
  assert.deepEqual(h.sent.filter(event => event.packet.type === 'resize').map(event => event.packet.payload.height), [620]);
  const pending = h.fire('start'); h.message('destroy');
  h.starts[0].reject(new Error('Late failure')); await pending;
  assert.equal(h.counts.destroyed, 1); assert.equal(h.counts.disconnected, 1); assert.equal(h.counts.frames, 0);
  const messages = h.sent.length; h.callbacks.onScan({ text: 'stale', format: 'qr' }); h.message('configure', options);
  assert.equal(h.sent.length, messages); assert.equal(h.$('start').disabled, true); assert.equal(h.$('status').textContent, 'Scanner closed.');
});
