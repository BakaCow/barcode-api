import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const engine = require('../web/engine/code128-engine.js');
const detector = require('../web/engine/code128-detector.js');
const decoder = require('../web/engine/code128-decoder.js');
const fixtures = (filename) => JSON.parse(readFileSync(new URL(`./fixtures/${filename}`, import.meta.url), 'utf8')).cases;
const original = fixtures('accuracy-pixels.json');
const development = fixtures('damage-stress-dev.json'); // Never import held-out evaluation here.
const imageFor = (fixture) => ({ width: fixture.width, height: fixture.height,
  data: new Uint8ClampedArray(inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'))) });
function exact(fixture) {
  const results = engine.read(imageFor(fixture));
  assert.deepEqual(results.map(({ text, format }) => ({ text, format })),
    fixture.expected.map(({ text }) => ({ text, format: 'Code128' })), fixture.name);
  for (const result of results) assert.ok(result.lineCount >= 2, 'multiple distinct sampled rows must agree');
  return results;
}

test('shaded labels with three independent development payloads decode exactly', () => {
  const shaded = development.filter((item) => item.name.startsWith('code128/') && item.name.includes('/shading-lowcontrast-'));
  assert.equal(shaded.length, 6);
  for (const fixture of shaded) exact(fixture);
  exact(original.find((item) => item.name === 'code128/weak-shaded'));
});

test('small bars survive sampling retries with coordinates in the original image', () => {
  for (const name of ['code128/downsampled', 'code128/small-in-frame']) {
    const fixture = original.find((item) => item.name === name), [result] = exact(fixture);
    for (const point of Object.values(result.position)) {
      assert.ok(point.x >= 0 && point.x <= fixture.width);
      assert.ok(point.y >= 0 && point.y <= fixture.height);
    }
    if (name.endsWith('small-in-frame')) {
      // The independently created label occupies the center 261 x 58 pixels.
      for (const point of Object.values(result.position)) {
        assert.ok(point.x >= 669 && point.x <= 931);
        assert.ok(point.y >= 420 && point.y <= 480);
      }
    }
  }
});

test('every development challenge either reads its exact value or declines to read', () => {
  const challenges = development.filter((item) => !item.expected.length || item.expected.every((expected) => expected.formats.includes('Code128')));
  assert.equal(challenges.length, 105);
  for (const fixture of challenges) {
    for (const result of engine.read(imageFor(fixture))) {
      assert.ok(fixture.expected.some((expected) => expected.text === result.text && expected.formats.includes(result.format)), fixture.name);
    }
  }
});

test('clipped quiet zones remain unreadable even after the recovery retries', () => {
  const clipped = development.filter((item) => item.name.startsWith('code128/') && item.name.includes('/clipping-'));
  assert.equal(clipped.length, 6);
  for (const fixture of clipped) assert.deepEqual(engine.read(imageFor(fixture)), [], fixture.name);
});

// Independently specified START-B, A, B, CHECK102, STOP symbol.
function shadedSymbol({ invalidChecksum = false, obstructLeft = false, obstructRight = false } = {}) {
  const row = Array(30).fill(255);
  for (const pattern of ['211214', '111323', '131123', invalidChecksum ? '212222' : '411131', '2331112']) {
    let black = true;
    for (const run of pattern) { row.push(...Array(Number(run) * 3).fill(black ? 0 : 255)); black = !black; }
  }
  row.push(...Array(30).fill(255));
  if (obstructLeft) row.fill(0, 0, 27);
  if (obstructRight) row.fill(0, row.length - 27);
  return Uint8Array.from(row, (value, x) => Math.round(90 + value / 255 * 21 + 95 * x / (row.length - 1)));
}

test('adaptive thresholding still verifies checksum and real quiet-zone contrast', () => {
  const good = shadedSymbol();
  assert.equal(decoder.decodeScanline(good, { tryLocalThreshold: false }), null, 'global thresholds lose one end of this gradient');
  assert.equal(decoder.decodeScanline(good)?.text, 'AB');
  for (const options of [{ invalidChecksum: true }, { obstructLeft: true }, { obstructRight: true }, { obstructLeft: true, obstructRight: true }]) {
    assert.equal(decoder.decodeScanline(shadedSymbol(options)), null, JSON.stringify(options));
  }
  const oneRow = new Uint8Array(good.length * 15).fill(255);
  oneRow.set(good, good.length * 7);
  assert.equal(decoder.decodeRows(oneRow, good.length, 15), null);
});

test('horizontal sampling preserves vertical independence and allocation limits', () => {
  const width = 200, height = 80, gray = new Uint8Array(width * height);
  const corners = [{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 70 }, { x: 10, y: 70 }];
  const normal = detector.rectify(gray, width, height, corners);
  const sampled = detector.rectify(gray, width, height, corners, 500_000, 2);
  assert.equal(sampled.width, normal.width * 2);
  assert.equal(sampled.height, normal.height);
  const bottom = sampled.map({ x: sampled.width - 1, y: sampled.height - 1 });
  assert.deepEqual(bottom, corners[2]);
  for (const budget of [4, 64, 1_000]) {
    const bounded = detector.rectify(gray, width, height, corners, budget, 2);
    assert.ok(bounded.width * bounded.height <= budget);
  }
  for (const scale of [0, 3, NaN, Infinity]) assert.throws(() => detector.rectify(gray, width, height, corners, 500_000, scale), /crop|geometry/i);
});
