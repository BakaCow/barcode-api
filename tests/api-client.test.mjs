import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BarcodeClient, BarcodeApiError } from '../clients/javascript/index.js';

const KEY = 'test-client-key-not-a-real-secret';
async function server(t, handler) {
  const requests = [];
  const http = createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) });
    try { await handler(requests.at(-1), res); }
    catch (error) { res.writeHead(500); res.end(JSON.stringify({ detail: error.message })); }
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${http.address().port}/prefix`;
  return { client: new BarcodeClient({ baseUrl, apiKey: KEY }), baseUrl, requests };
}
function json(res, data, code = 200, headers = {}) { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); }

test('client preserves deployment prefix and authenticates only API requests', async t => {
  const { client, requests } = await server(t, (_, res) => json(res, { status: 'ok' }));
  await client.health(); await client.formats();
  assert.deepEqual(requests.map(r => r.path), ['/prefix/health', '/prefix/v1/formats']);
  assert.equal(requests[0].headers['x-api-key'], undefined);
  assert.equal(requests[1].headers['x-api-key'], KEY);
});

test('generation preserves Unicode text, zeros and binary response', async t => {
  const bytes = Buffer.from([0, 137, 80, 255]);
  const { client, requests } = await server(t, (_, res) => { res.writeHead(200, { 'Content-Type': 'image/png', 'X-Request-ID': 'req-1' }); res.end(bytes); });
  const result = await client.generate({ format: 'qr', text: '0000123 日本語' });
  assert.equal(JSON.parse(requests[0].body).text, '0000123 日本語');
  assert.deepEqual(Buffer.from(result.data), bytes); assert.equal(result.requestId, 'req-1');
});

test('POS multipart sends exact bytes, every frame and strict options', async t => {
  const { client } = await server(t, async (request, res) => {
    const data = await new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': request.headers['content-type'] }, body: request.body }).formData();
    const frames = data.getAll('frames');
    assert.equal(frames.length, 2);
    assert.deepEqual([...new Uint8Array(await frames[0].arrayBuffer())], [0, 255, 1]);
    assert.equal(await frames[1].text(), 'second');
    assert.deepEqual(JSON.parse(data.get('options')), { allowed_formats: ['code128'], confirmation_frames: 2 });
    json(res, { status: 'rescan' });
  });
  assert.equal((await client.decodePos([new Blob([new Uint8Array([0, 255, 1])]), new Blob(['second'])], { allowed_formats: ['code128'], confirmation_frames: 2 })).status, 'rescan');
});

test('read uses file field and no invented content-type boundary', async t => {
  const { client } = await server(t, async (request, res) => {
    const data = await new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': request.headers['content-type'] }, body: request.body }).formData();
    assert.equal(await data.get('file').text(), 'example'); assert.equal(data.get('frames'), null);
    json(res, { barcodes: [] });
  });
  assert.deepEqual(await client.read(new Blob(['example'])), { barcodes: [] });
});

test('429 exposes request metadata and never retries automatically', async t => {
  const { client, requests } = await server(t, (_, res) => json(res, { detail: 'Try later' }, 429, { 'Retry-After': '12', 'X-Request-ID': 'abc' }));
  await assert.rejects(client.formats(), error => error instanceof BarcodeApiError && error.status === 429 && error.requestId === 'abc' && error.retryAfter === '12' && error.details === 'Try later' && !error.message.includes(KEY));
  assert.equal(requests.length, 1);
});

test('non-JSON proxy failures remain typed API errors', async t => {
  const { client } = await server(t, (_, res) => { res.writeHead(502); res.end('<html>gateway down</html>'); });
  await assert.rejects(client.formats(), error => error instanceof BarcodeApiError && error.status === 502 && error.details === undefined);
});

test('redirects cannot forward API key to another endpoint', async t => {
  const { client, requests } = await server(t, (_, res) => { res.writeHead(307, { Location: '/stolen' }); res.end(); });
  await assert.rejects(client.formats()); assert.equal(requests.length, 1);
});

test('timeout aborts a stalled response', async t => {
  const { baseUrl } = await server(t, () => {});
  const client = new BarcodeClient({ baseUrl, apiKey: KEY, timeoutMs: 30 });
  await assert.rejects(client.formats(), error => error.name === 'TimeoutError');
});

test('caller cancellation does not start an HTTP request', async t => {
  const { client, requests } = await server(t, (_, res) => json(res, {}));
  const signal = AbortSignal.abort(); await assert.rejects(client.formats({ signal }), { name: 'AbortError' });
  assert.equal(requests.length, 0);
});

test('invalid configuration and oversized/invalid images fail locally', () => {
  for (const baseUrl of ['http://public.example', 'ftp://localhost', 'https://user:pass@example.com', 'https://example.com/?secret=x', 'not a url']) assert.throws(() => new BarcodeClient({ baseUrl, apiKey: KEY }));
  const client = new BarcodeClient({ baseUrl: 'https://example.com', apiKey: KEY });
  for (const frames of [[], Array(6).fill(new Blob(['x'])), [new Blob()], ['x']]) assert.throws(() => client.decodePos(frames));
  assert.throws(() => client.read(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])), RangeError);
  for (const options of [{ confirmation_frames: true }, { allowed_formats: [] }, { allowed_formats: ['qr', 'qr'] }, { bogus: true }]) assert.throws(() => client.decodePos([new Blob(['x'])], options));
});
