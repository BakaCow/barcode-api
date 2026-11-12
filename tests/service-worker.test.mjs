import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../web/sw.js', import.meta.url), 'utf8');

function harness(scope = 'https://example.test/scan/') {
  const listeners = new Map();
  const stores = new Map();
  const state = { failURL: null, offline: false, fetched: [], claimed: false, skipped: false };
  const fetch = async request => {
    const url = typeof request === 'string' ? request : request.url;
    state.fetched.push(url);
    if (state.offline || url === state.failURL) throw new Error('Network unavailable');
    return new Response(`asset:${url}`);
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const items = stores.get(name);
      return {
        async match(request) { return items.get(typeof request === 'string' ? request : request.url)?.clone(); },
        async put(request, response) { items.set(typeof request === 'string' ? request : request.url, response); },
        async addAll(requests) {
          // Match Cache.addAll's all-or-nothing semantics.
          const responses = await Promise.all(requests.map(fetch));
          requests.forEach((request, index) => items.set(request.url, responses[index]));
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    registration: { scope },
    clients: { async claim() { state.claimed = true; } },
    async skipWaiting() { state.skipped = true; },
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  vm.runInNewContext(source, { self, caches, fetch, URL, Request, Response });
  async function lifecycle(type) {
    let work;
    listeners.get(type)({ waitUntil(promise) { work = promise; } });
    await work;
  }
  async function message(type) {
    let work, answer;
    listeners.get('message')({ data: { type }, ports: [{ postMessage(value) { answer = value; } }],
      waitUntil(promise) { work = promise; } });
    await work;
    return answer;
  }
  async function request(path, options = {}) {
    let response;
    listeners.get('fetch')({ request: { url: new URL(path, scope).href, method: 'GET', mode: 'cors', ...options },
      respondWith(promise) { response = promise; } });
    return response ? await response : undefined;
  }
  return { state, stores, lifecycle, message, request };
}

test('precache is complete before offline-ready; failed install never claims readiness', async () => {
  const app = harness();
  assert.equal((await app.message('OFFLINE_STATUS')).ready, false);
  app.state.failURL = 'https://example.test/scan/vendor/zxing_reader.wasm';
  await assert.rejects(app.lifecycle('install'), /Network unavailable/);
  assert.equal((await app.message('OFFLINE_STATUS')).ready, false);
  assert.equal(app.state.claimed, false);
  assert.equal([...app.stores.values()][0].size, 0);
  app.state.failURL = null;
  await app.lifecycle('install');
  assert.equal((await app.message('OFFLINE_STATUS')).ready, true);
  assert.equal(app.state.skipped, false);
});

test('missing cached assets remove offline-ready status', async () => {
  const app = harness();
  await app.lifecycle('install');
  [...app.stores.values()][0].delete('https://example.test/scan/vendor/zxing_reader.wasm');
  assert.equal((await app.message('OFFLINE_STATUS')).ready, false);
});

test('explicit repair restores files after partial cache eviction', async () => {
  const app = harness();
  await app.lifecycle('install');
  const items = [...app.stores.values()][0];
  const total = items.size;
  items.delete('https://example.test/scan/vendor/zxing_reader.wasm');
  items.delete('https://example.test/scan/index.html');
  assert.equal((await app.message('OFFLINE_STATUS')).ready, false);
  const repaired = await app.message('REPAIR_OFFLINE');
  assert.equal(repaired.ready, true);
  assert.equal(repaired.error, undefined);
  assert.equal(items.size, total);
  app.state.offline = true;
  assert.match(await (await app.request('./', { mode: 'navigate' })).text(), /index.html/);
  assert.match(await (await app.request('./vendor/zxing_reader.wasm')).text(), /zxing_reader.wasm/);
});

test('failed repair reports incomplete status while preserving usable cached files', async () => {
  const app = harness();
  await app.lifecycle('install');
  const items = [...app.stores.values()][0];
  items.delete('https://example.test/scan/vendor/zxing_reader.wasm');
  const before = [...items.keys()];
  app.state.failURL = 'https://example.test/scan/vendor/zxing_reader.wasm';
  const repaired = await app.message('REPAIR_OFFLINE');
  assert.equal(repaired.ready, false);
  assert.match(repaired.error, /Connect to the internet/);
  assert.deepEqual([...items.keys()], before);
  app.state.offline = true;
  assert.match(await (await app.request('./', { mode: 'navigate' })).text(), /index.html/);
  assert.match(await (await app.request('./app.js')).text(), /app.js/);
});

test('offline navigation and decoder assets work at a nested scope', async () => {
  const app = harness('https://example.test/barcode-api/');
  await app.lifecycle('install');
  await app.lifecycle('activate');
  app.state.offline = true;
  const before = app.state.fetched.length;
  assert.match(await (await app.request('./', { mode: 'navigate' })).text(), /barcode-api\/index.html/);
  assert.match(await (await app.request('./vendor/zxing_reader.wasm')).text(), /zxing_reader.wasm/);
  assert.equal(app.state.fetched.length, before);
  assert.equal(app.state.claimed, true);
});

test('offline credits and license navigations return the document rather than the app shell', async () => {
  const app = harness();
  await app.lifecycle('install');
  app.state.offline = true;
  const before = app.state.fetched.length;
  for (const filename of ['THIRD-PARTY.txt', 'ZXING-WASM-LICENSE.txt',
    'ZXING-CPP-LICENSE.txt', 'ZXING-WASM-CPP-LICENSE.txt', 'PUBLIC-SANS-LICENSE.txt']) {
    const response = await app.request(`./vendor/${filename}`, { mode: 'navigate' });
    assert.equal(await response.text(), `asset:https://example.test/scan/vendor/${filename}`);
  }
  assert.equal(app.state.fetched.length, before);
});

test('unknown in-scope navigations pass through instead of displaying the app shell', async () => {
  const app = harness();
  await app.lifecycle('install');
  assert.equal(await app.request('./missing-page.html', { mode: 'navigate' }), undefined);
  app.state.offline = true;
  assert.equal(await app.request('./unrelated/', { mode: 'navigate' }), undefined);
});

test('does not intercept APIs, writes, cross-origin, out-of-scope, or unknown assets', async () => {
  const app = harness();
  await app.lifecycle('install');
  for (const [path, options] of [
    ['https://example.test/v1/barcodes/read', { method: 'POST' }],
    ['./v1/formats', {}], ['https://other.test/app.js', {}],
    ['/other/index.html', { mode: 'navigate' }], ['./private-data.json', {}],
    ['./app.js', { method: 'POST' }],
  ]) assert.equal(await app.request(path, options), undefined);
});

test('activation only removes old caches belonging to the same app scope', async () => {
  const app = harness();
  app.stores.set('barcode-camera:https://example.test/scan/:old', new Map());
  app.stores.set('barcode-camera:https://example.test/other/:old', new Map());
  app.stores.set('another-app', new Map());
  await app.lifecycle('install');
  await app.lifecycle('activate');
  assert.equal(app.stores.has('barcode-camera:https://example.test/scan/:old'), false);
  assert.equal(app.stores.has('barcode-camera:https://example.test/other/:old'), true);
  assert.equal(app.stores.has('another-app'), true);
  await app.message('ACTIVATE_UPDATE');
  assert.equal(app.state.skipped, true);
});
