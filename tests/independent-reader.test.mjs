import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('tests/fixtures/independent-byte-controls.json', root))).cases;
const older = JSON.parse(readFileSync(new URL('tests/fixtures/damage-stress-recovery.json', root))).cases;
const imageFor = fixture => ({ width: fixture.width, height: fixture.height,
  data: new Uint8ClampedArray(inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'))) });
const nativeOptions = { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true,
  returnErrors: false, isPure: false, minLineCount: 2, maxNumberOfSymbols: 12 };
function worker() {
  const replies = [], paths = [], fetches = [];
  const context = vm.createContext({ console, URL, WebAssembly, Response, TextDecoder, TextEncoder, Blob,
    performance: { now: () => 0 }, ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array,
    Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    location: { href: 'https://offline.test/nested/scanner-worker.js' },
    importScripts(path) {
      assert.ok(path.startsWith('./') && !path.includes('..'));
      paths.push(path);
      vm.runInContext(readFileSync(new URL('web/' + path.slice(2), root), 'utf8'), context, { filename: path });
    },
    async fetch(url) {
      const relative = new URL(String(url)).pathname.replace('/nested/', '');
      assert.ok(['vendor/zxing_reader.wasm', 'vendor/zbar/zbar.wasm'].includes(relative));
      fetches.push(relative);
      return new Response(readFileSync(new URL('web/' + relative, root)), { headers: { 'Content-Type': 'application/wasm' } });
    },
    postMessage: reply => replies.push(reply),
  });
  context.self = context;
  vm.runInContext(readFileSync(new URL('web/scanner-worker.js', root), 'utf8'), context);
  return { context, paths, fetches,
    async send(message) {
      if (ArrayBuffer.isView(message.image?.data)) {
        const { data } = message.image;
        message = { ...message, image: { ...message.image, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } };
      }
      await context.onmessage({ data: { id: replies.length + 1, type: 'decode', ...message } });
      return JSON.parse(JSON.stringify(replies.at(-1)));
    },
  };
}
const actual = worker();
await actual.send({ type: 'init' });

test('known incorrect Code128 first pass is corrected by actual independent byte and spatial agreement', async () => {
  const fixture = older.find(item => item.name === 'code128/recovery-code128-label-3/small-in-frame-1');
  const image = imageFor(fixture), expected = fixture.expected[0].text;
  const original = await actual.context.ZXingWASM.readBarcodes(image, nativeOptions);
  assert.equal(original.length, 1);
  assert.notEqual(original[0].text, expected, 'reproduce the original native error');
  const result = await actual.send({ image, mode: 'live', posOptions: { allowedFormats: ['code128'] } });
  assert.equal(result.type, 'result', result.message);
  assert.equal(result.diagnostics.strategy, 'independent-code128-corroboration');
  assert.deepEqual(result.results.map(item => item.text), [expected]);
  assert.deepEqual(result.results[0].bytes, Array.from(new TextEncoder().encode(expected)));
  for (const p of Object.values(result.results[0].position)) assert.ok(p.x > 300 && p.x < 650 && p.y > 260 && p.y < 410);
});

for (const number of [1, 2, 3]) test(`project reader recovers an actual tiny Code128 missed by the original engine: ${number}`, async () => {
  const fixture = older.find(item => item.name === `code128/recovery-code128-label-${number}/small-in-frame-2`);
  const image = imageFor(fixture), original = Buffer.from(image.data);
  assert.equal((await actual.context.ZXingWASM.readBarcodes(image, nativeOptions)).length, 0);
  const result = await actual.send({ image, mode: 'image', posOptions: { allowedFormats: ['code128'] } });
  assert.deepEqual(result.results.map(item => item.text), [fixture.expected[0].text]);
  assert.equal(result.diagnostics.strategy, 'independent-recovery');
  assert.deepEqual(Buffer.from(image.data), original);
});

for (const fixture of fixtures.filter(item => item.format === 'Code128')) {
  test(`native Code128 bytes and presentation survive independent checking: ${fixture.name}`, async () => {
    const image = imageFor(fixture), native = await actual.context.ZXingWASM.readBarcodes(image, nativeOptions);
    assert.equal(native.length, 1);
    assert.deepEqual(Array.from(native[0].bytes), fixture.encoderBytes);
    const reply = await actual.send({ image, mode: 'live', posOptions: { allowedFormats: ['code128'] } });
    assert.equal(reply.results.length, 1, reply.message);
    assert.deepEqual(reply.results[0].bytes, fixture.encoderBytes);
    assert.equal(reply.results[0].text, native[0].text);
  });
}

for (const name of ['controls', 'fnc4', 'fnc4-mixed']) test(`an unsupported independent observation cannot replace native recovery: ${name}`, async () => {
  const fixture = fixtures.find(item => item.name === name), image = imageFor(fixture), isolated = worker();
  await isolated.send({ type: 'init' });
  const read = isolated.context.ZXingWASM.readBarcodes;
  const expected = (await read(image, nativeOptions))[0];
  let calls = 0;
  isolated.context.ZXingWASM.readBarcodes = async (...args) => ++calls === 1 ? [] : read(...args);
  const reply = await isolated.send({ image, mode: 'image', posOptions: { allowedFormats: ['code128'] } });
  assert.equal(reply.results.length, 1, reply.message);
  assert.deepEqual(reply.results[0].bytes, fixture.encoderBytes);
  assert.equal(reply.results[0].text, expected.text);
});

test('GS1 native bytes and human-readable presentation remain identical across the independent path', async () => {
  const fixture = JSON.parse(readFileSync(new URL('tests/fixtures/code128-core.json', root))).cases.find(item => item.name === 'gs1');
  const gray = inflateSync(Buffer.from(fixture.gray_zlib_base64, 'base64'));
  const data = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) { data.fill(gray[i], i * 4, i * 4 + 3); data[i * 4 + 3] = 255; }
  const image = { width: fixture.width, height: fixture.height, data };
  const native = await actual.context.ZXingWASM.readBarcodes(image, nativeOptions);
  const reply = await actual.send({ image, mode: 'live', posOptions: { allowedFormats: ['code128'] } });
  assert.deepEqual(reply.results[0].bytes, fixture.expectedBytes);
  assert.equal(reply.results[0].text, native[0].text);
  assert.ok(reply.results[0].text.includes('(01)'), 'native HRI representation is retained');
});

for (const name of ['upce-system-0', 'upce-system-1']) test(`EAN-only fallback cannot expand an excluded physical UPC-E: ${name}`, async () => {
  const image = imageFor(fixtures.find(item => item.name === name));
  const independent = await actual.context.IndependentReader.read(image, { formats: ['EAN13'] });
  assert.deepEqual(Array.from(independent.zbar), []);
  const reply = await actual.send({ image, posOptions: { allowedFormats: ['ean13'] } });
  assert.deepEqual(reply.results, []);
});

test('leading-zero physical EAN remains available through the original allowed native format', async () => {
  const fixture = fixtures.find(item => item.name === 'leading-zero-ean'), image = imageFor(fixture);
  const native = await actual.context.ZXingWASM.readBarcodes(image, { ...nativeOptions, formats: ['EAN13'] });
  const independent = await actual.context.IndependentReader.read(image, { formats: ['EAN13'] });
  assert.deepEqual(Array.from(independent.zbar), []);
  const reply = await actual.send({ image, posOptions: { allowedFormats: ['ean13'] } });
  assert.equal(reply.results[0].text, native[0].text);
  assert.deepEqual(reply.results[0].bytes, fixture.encoderBytes);
});

test('both independent runtime assets are local and warmed exactly once', () => {
  assert.deepEqual(actual.fetches, ['vendor/zxing_reader.wasm', 'vendor/zbar/zbar.wasm']);
  assert.equal(actual.paths.filter(path => path === './independent-reader.js').length, 1);
});

test('prototype budget can stop recovery without manufacturing a complete search', () => {
  const image = imageFor(fixtures.find(item => item.name === 'ascii'));
  assert.deepEqual(Array.from(actual.context.Code128Engine.read(image, { timeBudgetMs: 0 })), []);
  assert.equal(actual.context.Code128Engine.getDiagnostics().complete, false);
});
