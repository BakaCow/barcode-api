import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createCart, DEMO_CATALOGUE } from '../web/examples/pos/cart.mjs';

const scan = (scanId = 'scan-1', text = 'DEMO-TEA-01', format = 'code128') => ({ scanId, text, format });
test('exact catalogue match adds the authoritative catalogue price', () => {
  const cart = createCart();
  assert.equal(cart.add({ ...scan(), priceCents: 1 }).status, 'added');
  assert.equal(cart.snapshot().totalCents, 650);
});
test('retrying a scan event cannot increment quantity', () => {
  const cart = createCart(); cart.add(scan());
  assert.equal(cart.add(scan()).status, 'duplicate');
  assert.equal(cart.snapshot().itemCount, 1);
});
test('a new intentional event for the same label increments quantity', () => {
  const cart = createCart(); cart.add(scan()); cart.add(scan('scan-2'));
  assert.equal(cart.snapshot().items[0].quantity, 2);
  assert.equal(cart.snapshot().totalCents, 1300);
});
test('unknown codes do not enter the cart', () => {
  const cart = createCart();
  assert.equal(cart.add(scan('unknown', 'NOT-A-PRODUCT')).status, 'unknown');
  assert.equal(cart.snapshot().itemCount, 0);
});
test('barcode identity preserves format, case and whitespace', () => {
  const cart = createCart();
  for (const [index, event] of [scan('a', 'DEMO-TEA-01', 'qr'), scan('b', 'demo-tea-01'), scan('c', ' DEMO-TEA-01')].entries()) {
    assert.equal(cart.add(event).status, 'unknown', String(index));
  }
  assert.equal(cart.snapshot().totalCents, 0);
});
test('leading zero identifiers are distinct and are never parsed as numbers', () => {
  const cart = createCart([{ id: 'zero', name: 'Zero label', format: 'code128', text: '00123', priceCents: 100 }]);
  assert.equal(cart.add(scan('a', '123')).status, 'unknown');
  assert.equal(cart.add(scan('b', '00123')).status, 'added');
});
test('removing an item retains the consumed event ID', () => {
  const cart = createCart(); cart.add(scan()); cart.remove('tea');
  assert.equal(cart.add(scan()).status, 'duplicate');
  assert.equal(cart.snapshot().itemCount, 0);
});
test('clearing a cart retains consumed event IDs but allows new scans', () => {
  const cart = createCart(); cart.add(scan()); cart.clear();
  assert.equal(cart.add(scan()).status, 'duplicate');
  assert.equal(cart.add(scan('next')).status, 'added');
  assert.equal(cart.snapshot().itemCount, 1);
});
test('event memory is bounded without evicting idempotency records', () => {
  const cart = createCart(DEMO_CATALOGUE, { maxEvents: 2 });
  cart.add(scan('a')); cart.add(scan('b'));
  assert.equal(cart.add(scan('c')).status, 'capacity');
  assert.equal(cart.add(scan('a')).status, 'duplicate');
  assert.equal(cart.snapshot().itemCount, 2);
});
test('invalid events do not mutate the cart', () => {
  const cart = createCart();
  for (const event of [null, {}, scan('', 'DEMO-TEA-01'), scan('x', ''), { scanId: 'x', text: 12, format: 'code128' }]) assert.equal(cart.add(event).status, 'invalid');
  assert.equal(cart.snapshot().itemCount, 0);
});
test('unknown event IDs cannot be reused with a different product', () => {
  const cart = createCart();
  assert.equal(cart.add(scan('same', 'MISSING')).status, 'unknown');
  assert.equal(cart.add(scan('same')).status, 'duplicate');
});
test('catalogue duplicate identities or IDs are rejected', () => {
  assert.throws(() => createCart([DEMO_CATALOGUE[0], { ...DEMO_CATALOGUE[0], id: 'new' }]), TypeError);
  assert.throws(() => createCart([DEMO_CATALOGUE[0], { ...DEMO_CATALOGUE[1], id: 'tea' }]), TypeError);
});
test('catalogue and snapshot mutation cannot change cart prices', () => {
  const source = [{ ...DEMO_CATALOGUE[0] }], cart = createCart(source);
  source[0].priceCents = 1; cart.add(scan());
  const snapshot = cart.snapshot(); snapshot.items[0].priceCents = 2; snapshot.items[0].quantity = 200;
  assert.equal(cart.snapshot().totalCents, 650);
});
test('mixed item totals are calculated in integer cents', () => {
  const cart = createCart(); cart.add(scan()); cart.add(scan('oats', 'DEMO-OATS-02')); cart.add(scan('bag', 'DEMO:BAG:03', 'qr'));
  assert.equal(cart.snapshot().totalCents, 1320); assert.equal(cart.snapshot().itemCount, 3);
});

async function offlineHarness({ reply, waiting = false } = {}) {
  const events = new Map(), messages = [], registrations = [];
  const elements = Object.fromEntries(['offline-status', 'offline-check', 'offline-update'].map((id) => [id, { textContent: '', dataset: {}, hidden: true, disabled: true, addEventListener(name, callback) { events.set(`${id}:${name}`, callback); } }]));
  const target = { postMessage(data, ports) {
    messages.push(data.type);
    const value = reply?.(data.type) ?? { ready: true, features: ['integration-examples'] };
    queueMicrotask(() => ports[0].peer.onmessage?.({ data: value }));
  } };
  const registration = { active: target, waiting: waiting ? target : null, installing: null, addEventListener() {}, async update() {} };
  const context = vm.createContext({
    URL, setTimeout, clearTimeout, console,
    document: { getElementById: (id) => elements[id] },
    window: { isSecureContext: true, addEventListener(name, callback) { events.set(name, callback); } },
    navigator: { onLine: true, serviceWorker: {
      controller: target, ready: Promise.resolve(registration),
      async register(url, options) { registrations.push([String(url), options.scope]); return registration; },
      addEventListener(name, callback) { events.set(name, callback); },
    } },
    MessageChannel: class { constructor() { this.port1 = { close() {} }; this.port2 = { peer: this.port1 }; } },
  });
  const source = readFileSync(new URL('../web/examples/offline.js', import.meta.url), 'utf8').replaceAll('import.meta.url', JSON.stringify('https://example.test/scan/examples/offline.js'));
  vm.runInContext(source, context);
  const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  await flush();
  return { elements, messages, registrations, events, flush };
}
test('example offline registration shares the correct nested scanner scope', async () => {
  const state = await offlineHarness();
  assert.deepEqual(state.registrations, [['https://example.test/scan/sw.js', 'https://example.test/scan/']]);
  assert.equal(state.elements['offline-status'].dataset.state, 'ready');
});
test('an older cache cannot claim readiness for integration examples', async () => {
  const state = await offlineHarness({ reply: () => ({ ready: true, features: ['live-pos'] }) });
  assert.match(state.elements['offline-status'].textContent, /update is needed/);
  assert.notEqual(state.elements['offline-status'].dataset.state, 'ready');
  assert.equal(state.elements['offline-update'].hidden, false);
});
test('a waiting update is offered without silently activating it', async () => {
  const state = await offlineHarness({ waiting: true });
  assert.equal(state.elements['offline-update'].hidden, false);
  assert.equal(state.elements['offline-update'].href, 'https://example.test/scan/');
  assert.ok(!state.messages.includes('ACTIVATE_UPDATE'));
});
test('explicit offline check repairs an incomplete current cache', async () => {
  const state = await offlineHarness({ reply: (type) => ({ ready: type === 'REPAIR_OFFLINE', features: ['integration-examples'] }) });
  assert.equal(state.elements['offline-status'].dataset.state, 'error');
  state.events.get('offline-check:click')(); await state.flush();
  assert.ok(state.messages.includes('REPAIR_OFFLINE'));
  assert.equal(state.elements['offline-status'].dataset.state, 'ready');
});
