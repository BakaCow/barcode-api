import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const decoder = require('../web/engine/code128-decoder.js');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/code128-core.json', import.meta.url), 'utf8')).cases;
const image = (fixture) => new Uint8Array(inflateSync(Buffer.from(fixture.gray_zlib_base64, 'base64')));

for (const fixture of fixtures) {
  test(`independently generated Code128 pixels: ${fixture.name}`, () => {
    const result = decoder.decodeRows(image(fixture), fixture.width, fixture.height);
    if (!fixture.supported) { assert.equal(result, null); return; }
    assert.ok(result, fixture.name);
    assert.equal(result.format, 'Code128');
    assert.deepEqual(result.bytes, fixture.expectedBytes);
    assert.equal(result.text, String.fromCharCode(...fixture.expectedBytes));
    assert.equal(result.gs1, fixture.gs1);
    assert.ok(result.lineCount >= 2);
    assert.ok(result.position.topLeft.x < result.position.topRight.x);
    assert.ok(result.position.topLeft.y < result.position.bottomLeft.y);
    for (const point of Object.values(result.position)) {
      assert.ok(point.x >= 0 && point.x <= fixture.width);
      assert.ok(point.y >= 0 && point.y < fixture.height);
    }
  });
}

// Small independently specified Code128 vectors: START-B, A, B, CHECK=102, STOP.
// Codeword patterns are standard symbol data, not read from the implementation.
const table = new Map([[104, '211214'], [33, '111323'], [34, '131123'], [102, '411131'], [106, '2331112'],
  [0, '212222'], [96, '114311'], [97, '411113'], [100, '114131'], [19, '221132'], [21, '213212'], [27, '312212']]);
function symbol(words, quiet = 10) {
  const pixels = Array(quiet * 3).fill(255);
  for (const word of words) {
    let black = true;
    for (const run of table.get(word)) { pixels.push(...Array(Number(run) * 3).fill(black ? 0 : 255)); black = !black; }
  }
  pixels.push(...Array(quiet * 3).fill(255));
  return Uint8Array.from(pixels);
}

test('known codeword vector validates the weighted modulo103 checksum', () => {
  const result = decoder.decodeScanline(symbol([104, 33, 34, 102, 106]));
  assert.equal(result?.text, 'AB');
  assert.deepEqual(result.codewords, [104, 33, 34, 102, 106]);
  assert.equal(result.gs1, false, 'checksum102 is not interpreted as payload FNC1');
});

test('valid-looking symbols with a bad checksum are rejected', () => {
  assert.equal(decoder.decodeScanline(symbol([104, 33, 34, 0, 106])), null);
});

test('truncated stop bars and missing quiet zones are rejected', () => {
  const full = symbol([104, 33, 34, 102, 106]);
  assert.equal(decoder.decodeScanline(full.subarray(0, full.length - 36)), null);
  assert.equal(decoder.decodeScanline(symbol([104, 33, 34, 102, 106], 2)), null);
  assert.equal(decoder.decodeScanline(full.subarray(27)), null);
});

test('unsupported FNC2/FNC3/FNC4 fail instead of dropping or changing data', () => {
  for (const [fnc, checksum] of [[96, 19], [97, 21], [100, 27]]) {
    assert.equal(decoder.decodeScanline(symbol([104, 33, fnc, 34, checksum, 106])), null);
  }
});

test('single scanline decode is never enough for image acceptance', () => {
  const row = symbol([104, 33, 34, 102, 106]);
  assert.equal(decoder.decodeRows(row, row.length, 1), null);
  const pixels = new Uint8Array(row.length * 15).fill(255);
  pixels.set(row, row.length * 7);
  assert.equal(decoder.decodeRows(pixels, row.length, 15), null);
  pixels.set(row, row.length * 8);
  assert.equal(decoder.decodeRows(pixels, row.length, 15)?.text, 'AB');
});

test('competing valid values in one crop are rejected as ambiguous', () => {
  const a = fixtures.find((item) => item.name === 'set-b');
  const b = fixtures.find((item) => item.name === 'set-c');
  const width = Math.max(a.width, b.width), height = 30;
  const pixels = new Uint8Array(width * height).fill(255);
  const rowA = image(a).subarray(0, a.width), rowB = image(b).subarray(0, b.width);
  for (let y = 0; y < height; y++) pixels.set(y < height / 2 ? rowA : rowB, y * width);
  assert.equal(decoder.decodeRows(pixels, width, height), null);
});

test('blank, gradient, repeated stripes and deterministic noise do not decode', () => {
  const width = 640, height = 30;
  let state = 0x1c0128;
  const noise = new Uint8Array(width * height);
  for (let i = 0; i < noise.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; noise[i] = state >>> 24; }
  const patterns = [new Uint8Array(width * height), new Uint8Array(width * height).fill(255), noise,
    Uint8Array.from({ length: width * height }, (_, i) => Math.floor((i % width) * 255 / width)),
    Uint8Array.from({ length: width * height }, (_, i) => Math.floor((i % width) / 3) % 2 ? 0 : 255)];
  for (const pixels of patterns) assert.equal(decoder.decodeRows(pixels, width, height), null);
});

test('invalid dimensions and signed samples are rejected before scan work', () => {
  assert.throws(() => decoder.decodeRows(new Uint8Array(4), 4, 2), /dimensions/);
  assert.throws(() => decoder.decodeRows(new Int8Array(4), 4, 1), /unsigned/);
  assert.throws(() => decoder.decodeRows(new Uint8Array(8193), 8193, 1), /dimensions/);
  assert.throws(() => decoder.decodeRows(new Uint8Array(4), 4001, 1000), /dimensions/);
});
