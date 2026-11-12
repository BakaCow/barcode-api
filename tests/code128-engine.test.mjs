import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const engine = require('../web/engine/code128-engine.js');
const detector = require('../web/engine/code128-detector.js');
const decoder = require('../web/engine/code128-decoder.js');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/accuracy-pixels.json', import.meta.url), 'utf8')).cases;
const byName = new Map(fixtures.map((item) => [item.name, item]));
const fixtureImage = (name) => {
  const fixture = byName.get(name);
  return { width: fixture.width, height: fixture.height,
    data: new Uint8ClampedArray(inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'))) };
};
function rgba(gray, width, height) {
  const data = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = gray[i]; data[i * 4 + 3] = 255; }
  return { data, width, height };
}

for (const name of ['clean', 'rotate-17', 'rotate-37', 'rotate-73', 'weak-contrast', 'inverted']) {
  test(`custom locate/rectify/decode pipeline: Code128 ${name}`, () => {
    const fixture = byName.get(`code128/${name}`), image = fixtureImage(fixture.name);
    const results = engine.read(image);
    assert.equal(results.length, 1);
    assert.equal(results[0].text, fixture.expected[0].text);
    assert.equal(results[0].format, 'Code128');
    assert.deepEqual(results[0].bytes, Array.from(new TextEncoder().encode(fixture.expected[0].text)));
    assert.ok(results[0].lineCount >= 2);
    assert.ok(engine.getDiagnostics().candidates > 0, 'the real locator supplies a candidate');
    for (const point of Object.values(results[0].position)) {
      assert.ok(Number.isFinite(point.x) && point.x >= 0 && point.x <= image.width);
      assert.ok(Number.isFinite(point.y) && point.y >= 0 && point.y <= image.height);
    }
  });
}

test('mapped diagonal-code corners remain on the original rotated label', () => {
  const clean = fixtureImage('code128/clean');
  let x0 = clean.width, x1 = 0, y0 = clean.height, y1 = 0;
  for (let y = 0; y < clean.height; y++) for (let x = 0; x < clean.width; x++) {
    if (clean.data[(y * clean.width + x) * 4] < 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  for (const angle of [17, 37, 73]) {
    const input = fixtureImage(`code128/rotate-${angle}`), result = engine.read(input)[0];
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    for (const point of Object.values(result.position)) {
      // Invert the independently generated Pillow.rotate(angle, expand=True) fixture.
      const dx = point.x + 0.5 - input.width / 2, dy = point.y + 0.5 - input.height / 2;
      const x = c * dx - s * dy + clean.width / 2 - 0.5;
      const y = s * dx + c * dy + clean.height / 2 - 0.5;
      assert.ok(x >= x0 - 4 && x <= x1 + 4, `angle ${angle}, x=${x}`);
      assert.ok(y >= y0 - 4 && y <= y1 + 4, `angle ${angle}, y=${y}`);
    }
  }
});

test('all negative challenge images and other clean barcode formats are rejected', () => {
  const names = fixtures.filter((item) => item.name.startsWith('negative/')).map((item) => item.name);
  names.push('qr/clean', 'ean13/clean', 'datamatrix/clean');
  for (const name of names) assert.deepEqual(engine.read(fixtureImage(name)), [], name);
});

// Standard symbol vector START-B, A, B, CHECK102, STOP; checksum0 is invalid.
function knownSymbol(checksum = true) {
  const patterns = ['211214', '111323', '131123', checksum ? '411131' : '212222', '2331112'];
  const row = Array(30).fill(255);
  for (const pattern of patterns) {
    let dark = true;
    for (const run of pattern) { row.push(...Array(Number(run) * 3).fill(dark ? 0 : 255)); dark = !dark; }
  }
  row.push(...Array(30).fill(255));
  const width = row.length, height = 80, gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) gray.set(row, y * width);
  return { gray, width, height };
}

test('locator proposals never turn checksum-corrupted bars into a result', () => {
  const input = knownSymbol(false);
  assert.ok(detector.detect(input.gray, input.width, input.height).length > 0);
  assert.deepEqual(engine.read(rgba(input.gray, input.width, input.height)), []);
});

test('out-of-frame white padding cannot manufacture missing quiet zones', () => {
  const original = knownSymbol();
  assert.equal(engine.read(rgba(original.gray, original.width, original.height))[0]?.text, 'AB');
  for (const [left, right] of [[26, 0], [0, 26], [26, 26]]) {
    const width = original.width - left - right;
    const gray = new Uint8Array(width * original.height);
    for (let y = 0; y < original.height; y++) gray.set(original.gray.subarray(y * original.width + left, (y + 1) * original.width - right), y * width);
    assert.ok(detector.detect(gray, width, original.height).length > 0, 'the clipped label still produces a locator proposal');
    assert.deepEqual(engine.read(rgba(gray, width, original.height)), [], `clipped quiet zones ${left}/${right}`);
  }
});

test('decoder reports measured quiet-zone margins for source-boundary validation', () => {
  const input = knownSymbol();
  const result = decoder.decodeRows(input.gray, input.width, input.height);
  assert.equal(result.quietLeft, 30);
  assert.equal(result.quietRight, 30);
  assert.equal(result.left - result.quietLeft, 0);
  assert.equal(result.right + result.quietRight, input.width);
});

test('perspective sampler maps all four corners and samples the corresponding pixels', () => {
  const width = 200, height = 120;
  const gray = Uint8Array.from({ length: width * height }, (_, index) => Math.floor(((index % width) + Math.floor(index / width)) / 2));
  const points = [{ x: 10, y: 20 }, { x: 180, y: 10 }, { x: 170, y: 100 }, { x: 20, y: 110 }];
  const crop = detector.rectify(gray, width, height, points);
  const corners = [{ x: 0, y: 0 }, { x: crop.width - 1, y: 0 }, { x: crop.width - 1, y: crop.height - 1 }, { x: 0, y: crop.height - 1 }];
  corners.forEach((point, index) => {
    const mapped = crop.map(point);
    assert.ok(Math.abs(mapped.x - points[index].x) < 1e-9);
    assert.ok(Math.abs(mapped.y - points[index].y) < 1e-9);
  });
  for (const point of [...corners, { x: Math.floor(crop.width / 2), y: Math.floor(crop.height / 2) }]) {
    const mapped = crop.map(point), value = crop.gray[point.y * crop.width + point.x];
    assert.ok(Math.abs(value - (mapped.x + mapped.y) / 2) <= 1);
  }
});

test('rectification respects pixel budgets even for extreme aspect ratios', () => {
  const gray = new Uint8Array(100 * 100).fill(255);
  for (const points of [
    [{ x: 0, y: 0 }, { x: 1e6, y: 0 }, { x: 1e6, y: 10 }, { x: 0, y: 10 }],
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 1e6 }, { x: 0, y: 1e6 }],
  ]) {
    for (const budget of [4, 64, 10_000]) {
      const crop = detector.rectify(gray, 100, 100, points, budget);
      assert.ok(crop.width >= 2 && crop.height >= 2);
      assert.ok(crop.width * crop.height <= budget);
      assert.equal(crop.gray.length, crop.width * crop.height);
    }
  }
});

test('degenerate, crossed and non-convex crop geometry is rejected', () => {
  const gray = new Uint8Array(100 * 100);
  const invalid = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }],
    [{ x: 0, y: 0 }, { x: 80, y: 80 }, { x: 80, y: 0 }, { x: 0, y: 80 }],
    [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 80 }],
    [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }],
  ];
  for (const points of invalid) assert.throws(() => detector.rectify(gray, 100, 100, points), /crop|geometry/i);
  assert.throws(() => detector.rectify(gray, 100, 100, [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }, { x: 0, y: 80 }], 1), /crop|geometry/i);
});

test('invalid image buffers fail before detector allocation', () => {
  assert.throws(() => engine.read({ width: 4001, height: 1000, data: new Uint8Array(4) }), /million|pixels/i);
  assert.throws(() => engine.read({ width: 20, height: 20, data: new Uint8Array(400) }), /RGBA|pixels/i);
  assert.throws(() => detector.detect(new Uint8Array(10), 10, 2), /grayscale/i);
});
