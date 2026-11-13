import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createCart, DEMO_CATALOGUE } from '../web/examples/pos/cart.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(setImmediate);
const abort = () => Object.assign(new Error('Scanner operation cancelled.'), { name: 'AbortError' });

function harness(example) {
  const elements = new Map(), windowEvents = new Map(), requests = [];
  function element() {
    return {
      hidden: true, disabled: false, value: '', files: [], srcObject: null, children: [], dataset: {}, events: new Map(),
      addEventListener(type, handler) { this.events.set(type, handler); },
      replaceChildren(...nodes) { this.children = nodes; }, append(...nodes) { this.children.push(...nodes); }, prepend(node) { this.children.unshift(node); },
      setAttribute() {}, select() {},
    };
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  let callbacks, state = 'idle', generation = 0;
  const status = next => { state = next; callbacks.onStatus({ state, message: `${state} status` }); };
  const scanner = {
    start() {
      const token = ++generation, request = deferred(); requests.push(request); status('starting');
      return request.promise.then(() => { if (generation !== token) throw abort(); $('video').srcObject = {}; status('scanning'); });
    },
    scanImage() { generation++; const request = deferred(); requests.push(request); $('video').srcObject = null; status('scanning'); return request.promise; },
    stop() { generation++; $('video').srcObject = null; status('stopped'); },
    setOptions() { status(state === 'confirmed' ? 'confirmed' : 'scanning'); },
    rescan() { status($('video').srcObject ? 'scanning' : 'idle'); },
  };
  const context = vm.createContext({
    console, crypto: { randomUUID: () => 'manual-test' }, Intl, createCart, DEMO_CATALOGUE,
    createScanner(options) { callbacks = options; return scanner; },
    attachScannerControls: () => ({ updateStatus() {}, updateCandidates() {} }),
    document: { getElementById: $, createElement: element }, window: { addEventListener(type, handler) { windowEvents.set(type, handler); } },
  });
  const source = readFileSync(new URL(`../web/examples/${example}/app.js`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  return { $, requests, callbacks, scanner, windowEvents, fire(id, type, event = {}) { return $(id).events.get(type)(event); }, confirm() { status('confirmed'); callbacks.onScan({ scanId: 'accepted-1', text: 'DEMO-TEA-01', format: 'code128' }); } };
}

test('changing confirmation settings after a confirmed live read keeps Scan another available', async () => {
  const h = harness('plain'), pending = h.fire('start', 'click'); h.requests[0].resolve(); await pending;
  h.confirm(); assert.equal(h.$('next').disabled, false);
  h.$('confirmation').value = '3'; h.fire('confirmation', 'change');
  assert.equal(h.$('next').disabled, false); assert.equal(h.$('start').disabled, true);
  h.fire('next', 'click'); assert.equal(h.$('next').disabled, true); assert.equal(h.$('status').dataset.state, 'scanning');
});

for (const example of ['plain', 'pos']) {
  test(`${example}: Stop during startup keeps stopped feedback and ignores expected cancellation`, async () => {
    const h = harness(example), pending = h.fire('start', 'click');
    h.fire('stop', 'click'); h.requests[0].reject(abort()); await pending;
    assert.equal(h.$('error').hidden, true); assert.equal(h.$('status').dataset.state, 'stopped');
    assert.equal(h.$('start').disabled, false); assert.equal(h.$('stop').disabled, true);
  });

  test(`${example}: an old failed startup cannot overwrite or unlock a newer startup`, async () => {
    const h = harness(example), first = h.fire('start', 'click'); h.fire('stop', 'click');
    const second = h.fire('start', 'click'); h.requests[0].reject(new Error('Old request failed')); await first;
    assert.equal(h.$('error').hidden, true); assert.equal(h.$('status').dataset.state, 'starting');
    assert.equal(h.$('start').disabled, true); assert.equal(h.$('stop').disabled, false);
    h.requests[1].resolve(); await second; assert.equal(h.$('status').dataset.state, 'scanning');
  });

  test(`${example}: leaving the page invalidates pending startup feedback`, async () => {
    const h = harness(example), pending = h.fire('start', 'click'); h.windowEvents.get('pagehide')();
    h.requests[0].reject(new Error('Late permission failure')); await pending;
    assert.equal(h.$('error').hidden, true); assert.equal(h.$('status').dataset.state, 'stopped');
  });
}

test('plain: an old image cancellation cannot clear a newly selected image or unlock its controls', async () => {
  const h = harness('plain'); h.$('image').files = [{ name: 'old.png' }]; h.$('image').value = 'old.png';
  const first = h.fire('image', 'change'); h.fire('stop', 'click'); assert.equal(h.$('image').value, '');
  h.$('image').files = [{ name: 'new.png' }]; h.$('image').value = 'new.png'; const second = h.fire('image', 'change');
  h.requests[0].reject(abort()); await first; await settle();
  assert.equal(h.$('error').hidden, true); assert.equal(h.$('image').disabled, true); assert.equal(h.$('image').value, 'new.png');
  h.requests[1].resolve(); await second; assert.equal(h.$('image').disabled, false); assert.equal(h.$('image').value, '');
});

test('POS manual entry invalidates an earlier startup while retaining the accepted item', async () => {
  const h = harness('pos'), pending = h.fire('start', 'click');
  h.$('manual-value').value = 'DEMO-TEA-01'; h.$('manual-format').value = 'code128'; h.fire('manual', 'submit', { preventDefault() {} });
  h.requests[0].reject(new Error('Old camera failed')); await pending;
  assert.equal(h.$('error').hidden, true); assert.equal(h.$('cart-lines').children.length, 1); assert.equal(h.$('total').textContent, '$6.50');
});
