import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../web/embed.js', import.meta.url), 'utf8');
const scan = (scanId = 'test-scan-1') => ({ scanId, text: '00123 <tag>', format: 'code128', bytesBase64: 'MDAxMjM=', position: null });
function harness(attributes = {}, { secure = true, loading = false, src = 'https://scanner.test/scan/embed.js' } = {}) {
  const frames = [], observers = [], timeouts = new Map(), selectors = new Map(); let timer = 0, nonce = 0;
  class Events {
    constructor() { this.events = new Map(); }
    addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(handler); }
    removeEventListener(type, handler) { this.events.get(type)?.delete(handler); }
    fire(type, payload = {}) { for (const handler of [...this.events.get(type) || []]) handler(payload); }
  }
  class Element extends Events {
    constructor(tag, ownerDocument) { super(); this.tagName = tag; this.ownerDocument = ownerDocument; this.nodeType = 1; this.childNodes = []; this.attributes = new Map(); this.style = {}; this.dispatched = []; this.hidden = false; }
    get isConnected() { return this === doc.documentElement || Boolean(this.parentNode?.isConnected); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.childNodes.push(node); if (node.tagName === 'iframe') node.urlOnInsertion = node.src || 'about:blank'; } }
    insertBefore(node, reference) { node.remove(); node.parentNode = this; const index = this.childNodes.indexOf(reference); this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node); }
    remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; } }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    dispatchEvent(event) { this.dispatched.push(event); if (event.bubbles) this.parentNode?.dispatchEvent(event); return true; }
  }
  const doc = new Events();
  Object.assign(doc, { baseURI: 'https://customer.test/checkout', hidden: false, readyState: loading ? 'loading' : 'complete', querySelector: selector => selectors.get(selector) || null,
    createElement(tag) { const node = new Element(tag, doc); if (tag === 'iframe') { node.sent = []; node.contentWindow = { postMessage: (message, origin) => node.sent.push({ message, origin }) }; frames.push(node); } return node; },
  });
  doc.documentElement = doc.createElement('html'); doc.body = doc.createElement('body'); doc.documentElement.append(doc.body);
  const target = doc.createElement('section'); doc.body.append(target); selectors.set('#scanner', target);
  const script = doc.createElement('script'); script.src = src; Object.entries(attributes).forEach(([key, value]) => script.setAttribute(key, value)); doc.body.append(script); doc.currentScript = script;
  const root = new Events();
  Object.assign(root, { isSecureContext: secure, location: new URL('https://customer.test/checkout'),
    crypto: { getRandomValues(array) { array.fill(++nonce); return array; } },
    setTimeout(fn, delay) { const id = ++timer; timeouts.set(id, { fn, delay }); return id; }, clearTimeout(id) { timeouts.delete(id); },
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    MutationObserver: class { constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
  });
  const context = vm.createContext({ window: root, document: doc, URL, URLSearchParams, Uint8Array, console });
  const execute = () => vm.runInContext(source, context);
  execute();
  function message(type, payload = {}, index = frames.length - 1, override = {}) {
    const frame = frames[index], url = new URL(frame.src), channel = new URLSearchParams(url.hash.slice(1)).get('channel');
    root.fire('message', { source: frame.contentWindow, origin: url.origin,
      data: { protocol: 'barcode-camera-embed', version: 1, channel, revision: frame.sent.at(-1)?.message.revision ?? 0, type, payload }, ...override });
  }
  const mount = options => root.BarcodeCamera.mount(target, options);
  const ready = index => { message('hello', {}, index); message('ready', {}, index); };
  return { root, doc, script, target, frames, observers, timeouts, execute, mount, message, ready,
    mutate() { observers.filter(observer => !observer.disconnected).forEach(observer => observer.callback()); },
    timeout() { for (const [id, item] of [...timeouts]) { timeouts.delete(id); item.fn(); } },
  };
}

test('one hosted script creates an isolated camera frame with exact-origin configuration', async () => {
  const h = harness({ 'data-barcode-scanner': '', 'data-target': '#scanner', 'data-formats': 'code128,qr', 'data-confirmation-frames': '3', 'data-controls': 'false' });
  assert.equal(h.frames.length, 1); const frame = h.frames[0], url = new URL(frame.src);
  assert.equal(url.origin, 'https://scanner.test'); assert.equal(url.pathname, '/scan/embed/');
  assert.equal(frame.urlOnInsertion, frame.src, 'set the real navigation before inserting the iframe');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('parentOrigin'), 'https://customer.test');
  assert.match(new URLSearchParams(url.hash.slice(1)).get('channel'), /^[a-f0-9]{32}$/);
  assert.equal(frame.getAttribute('allow'), 'camera'); assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  assert.equal(frame.referrerPolicy, 'no-referrer'); assert.equal(frame.title, 'Barcode Camera scanner');
  assert.equal(frame.sent.length, 0, 'loading the script must not request camera access');
  h.message('hello'); assert.equal(frame.sent[0].origin, 'https://scanner.test');
  assert.equal(JSON.stringify(frame.sent[0].message.payload), JSON.stringify({ formats: ['code128', 'qr'], confirmationFrames: 3, controls: false }));
  h.message('ready'); assert.equal(frame.hidden, false); assert.equal(h.timeouts.size, 0);
  assert.equal(h.target.dispatched.at(-1).type, 'barcode:ready');
  assert.equal(typeof h.target.dispatched.at(-1).detail.start, 'undefined');
});

test('manual mount resolves readiness without starting a camera and exposes lifecycle commands', async () => {
  const h = harness(), instance = h.mount(); h.ready(); assert.equal(await instance.ready, instance);
  instance.stop(); instance.rescan();
  assert.deepEqual(h.frames[0].sent.slice(-2).map(entry => entry.message.type), ['stop', 'rescan']);
  instance.destroy(); assert.equal(h.frames[0].sent.at(-1).message.type, 'destroy'); assert.equal(h.frames[0].isConnected, false);
});

test('forged origin, window, channel, protocol, version and pre-ready scans are ignored', () => {
  const accepted = [], h = harness(); h.mount({ onScan: result => accepted.push(result) });
  h.message('scan', { sequence: 1, result: scan() }); assert.equal(accepted.length, 0); h.ready();
  const frame = h.frames[0], base = { protocol: 'barcode-camera-embed', version: 1, revision: 0, channel: new URLSearchParams(new URL(frame.src).hash.slice(1)).get('channel'), type: 'scan', payload: { sequence: 1, result: scan() } };
  for (const overrides of [{ origin: 'https://attacker.test' }, { source: {} }, ...[{ channel: 'wrong' }, { protocol: 'wrong' }, { version: 2 }].map(change => ({ data: { ...base, ...change } }))]) h.message('scan', base.payload, 0, overrides);
  assert.equal(accepted.length, 0); h.message('scan', base.payload); assert.equal(accepted.length, 1);
});

test('confirmed values preserve exact text and formats, with replay protection and typed message limits', () => {
  const accepted = [], h = harness(); h.mount({ formats: ['code128'], onScan: result => accepted.push(result) }); h.ready();
  for (const invalid of [{ ...scan(), text: 'x'.repeat(10001) }, { ...scan(), format: 'qr' }, { ...scan(), bytesBase64: 'bad@@' }, { ...scan(), scanId: '' }, { ...scan(), position: { topLeft: { x: NaN, y: 1 } } }, { ...scan(), text: 123 }]) h.message('scan', { sequence: 1, result: invalid });
  assert.equal(accepted.length, 0);
  h.message('scan', { sequence: 1, result: scan() }); h.message('scan', { sequence: 1, result: scan('replayed') }); h.message('scan', { sequence: 0, result: scan() });
  assert.equal(accepted.length, 1); assert.equal(accepted[0].text, '00123 <tag>');
  assert.equal(h.target.dispatched.filter(event => event.type === 'barcode:scan').length, 1);
  h.message('scan', { sequence: 2, result: scan('intentional-next') }); assert.equal(accepted.length, 2);
});

test('status and height messages are bounded and callbacks cannot derail the bridge', () => {
  const errors = [], statuses = [], h = harness(); h.mount({ onScan() { throw new Error('Host lookup failed'); }, onError: error => errors.push(error.message), onStatus: status => statuses.push(status) }); h.ready();
  h.message('status', { state: 'confirmed', message: 'Ready for next item' }); h.message('status', { state: 'invented', message: 'bad' });
  assert.equal(statuses.length, 1);
  for (const height of [NaN, -1, 0, 4097, '640']) h.message('resize', { height });
  assert.equal(h.frames[0].style.height, '520px'); h.message('resize', { height: 660.4 }); assert.equal(h.frames[0].style.height, '661px');
  h.message('scan', { sequence: 1, result: scan() }); assert.equal(errors.length, 1);
  assert.equal(h.target.dispatched.at(-1).type, 'barcode:scan');
});

test('hidden pages stop scanning and repeated configuration does not request automatic start', () => {
  const h = harness(); h.mount(); h.doc.hidden = true; h.ready();
  assert.equal(h.frames[0].sent.at(-1).message.type, 'stop');
  h.doc.fire('visibilitychange'); h.root.fire('pagehide');
  assert.equal(h.frames[0].sent.slice(-2).every(entry => entry.message.type === 'stop'), true);
  h.message('hello'); assert.equal(h.frames[0].sent.at(-1).message.type, 'configure');
  assert.equal(h.frames[0].sent.some(entry => entry.message.type === 'start'), false);
});

for (const command of ['stop', 'rescan']) test(`${command} rejects already queued scan/status/error messages while allowing a later explicit attempt`, () => {
  const accepted = [], statuses = [], errors = [], h = harness();
  const instance = h.mount({ onScan: value => accepted.push(value), onStatus: value => statuses.push(value), onError: error => errors.push(error) }); h.ready();
  const oldEnvelope = { ...h.frames[0].sent[0].message };
  instance[command](); assert.equal(h.frames[0].sent.at(-1).message.revision, 1);
  for (const [type, payload] of [['scan', { sequence: 1, result: scan() }], ['status', { state: 'confirmed', message: 'Stale confirmation' }], ['error', { message: 'Stale error' }]]) h.message(type, payload, 0, { data: { ...oldEnvelope, type, payload } });
  assert.equal(accepted.length, 0); assert.equal(statuses.length, 0); assert.equal(errors.length, 0);
  h.message('scan', { sequence: 2, result: scan('next-attempt') }); assert.equal(accepted.length, 1);
});

test('a host stopping in the confirmed status callback rejects the child scan already queued behind that status', () => {
  const accepted = [], h = harness(); let instance;
  instance = h.mount({ onScan: value => accepted.push(value), onStatus: status => { if (status.state === 'confirmed') instance.stop(); } }); h.ready();
  const oldEnvelope = { ...h.frames[0].sent[0].message };
  h.message('status', { state: 'confirmed', message: 'Confirmed' });
  h.message('scan', {}, 0, { data: { ...oldEnvelope, type: 'scan', payload: { sequence: 1, result: scan() } } });
  assert.equal(accepted.length, 0);
  assert.equal(h.target.dispatched.filter(event => event.type === 'barcode:status').length, 0, 'callback cancellation also prevents stale DOM status delivery');
});

test('a pre-ready stop is included in subsequent configuration handshakes', async () => {
  const h = harness(), instance = h.mount(); instance.stop(); h.message('hello');
  assert.equal(h.frames[0].sent.at(-1).message.type, 'configure'); assert.equal(h.frames[0].sent.at(-1).message.revision, 1);
  h.message('ready'); assert.equal(await instance.ready, instance);
});

for (const remove of ['target', 'frame']) test(`detaching the ${remove} destroys the camera frame and ignores later results`, async () => {
  const accepted = [], h = harness(), instance = h.mount({ onScan: value => accepted.push(value) }); h.ready(); await instance.ready;
  (remove === 'target' ? h.target : h.frames[0]).remove(); h.mutate();
  assert.equal(h.frames[0].sent.at(-1).message.type, 'destroy'); assert.equal(h.observers[0].disconnected, true);
  h.message('scan', { sequence: 1, result: scan() }); assert.equal(accepted.length, 0);
  assert.equal(h.root.events.get('message').size, 0);
});

test('destroy before readiness rejects with AbortError and removes only owned content', async () => {
  const h = harness(), existing = h.doc.createElement('p'); h.target.append(existing);
  const instance = h.mount(); instance.destroy();
  await assert.rejects(instance.ready, error => error.name === 'AbortError');
  assert.deepEqual(h.target.childNodes, [existing]); assert.equal(h.timeouts.size, 0);
});

test('loading failure is visible, rejects ready, and removes the unreachable frame', async () => {
  const errors = [], h = harness(), instance = h.mount({ onError: error => errors.push(error.message) }); h.timeout();
  await assert.rejects(instance.ready, /could not load/); assert.equal(errors.length, 1);
  assert.equal(h.frames[0].isConnected, false); assert.equal(h.target.childNodes[0].childNodes[0].getAttribute('role'), 'alert');
  h.message('ready'); assert.equal(h.frames[0].isConnected, false);
});

test('frame reloads invalidate the accepted message sequence instead of accepting a replayed session', async () => {
  const h = harness(), instance = h.mount(); h.frames[0].fire('load'); h.ready(); await instance.ready;
  h.frames[0].fire('load'); assert.equal(h.frames[0].isConnected, false);
  assert.match(h.target.childNodes[0].childNodes[0].textContent, /reloaded/);
});

test('multiple tags initialize once and multiple instances cannot receive each other’s events', () => {
  const h = harness({ 'data-barcode-scanner': '' }); assert.equal(h.frames.length, 1); h.execute(); assert.equal(h.frames.length, 1);
  const secondScript = h.doc.createElement('script'); secondScript.src = h.script.src; secondScript.setAttribute('data-barcode-scanner', ''); h.doc.body.append(secondScript); h.doc.currentScript = secondScript;
  h.execute(); assert.equal(h.frames.length, 2); h.ready(0); h.ready(1);
  h.message('scan', { sequence: 1, result: scan() }, 1);
  assert.equal(h.doc.body.dispatched.filter(event => event.type === 'barcode:scan').length, 1);
});

test('auto mount waits for parsing and reports invalid attributes without changing page content', () => {
  const h = harness({ 'data-barcode-scanner': '', 'data-controls': 'maybe' }, { loading: true });
  assert.equal(h.frames.length, 0); h.doc.fire('DOMContentLoaded'); assert.equal(h.frames.length, 0);
  assert.equal(h.doc.body.childNodes.some(node => node.childNodes.some(child => child.textContent?.includes('data-controls'))), true);
});

test('insecure pages and invalid options fail before creating a frame', () => {
  const insecure = harness({}, { secure: false }); assert.throws(() => insecure.mount(), /HTTPS/); assert.equal(insecure.frames.length, 0);
  const h = harness();
  for (const options of [{ formats: [] }, { formats: ['qr', 'qr'] }, { formats: ['unknown'] }, { confirmationFrames: 4 }, { controls: 'false' }, { onScan: 'execute me' }, { apiKey: 'never needed' }]) assert.throws(() => h.mount(options));
  assert.equal(h.frames.length, 0);
  assert.throws(() => harness({}, { src: 'http://untrusted.test/embed.js' }), /HTTPS/);
});
