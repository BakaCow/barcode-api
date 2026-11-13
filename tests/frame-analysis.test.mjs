import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const analysis = require('../web/frame-analysis.js');
const fixtures = JSON.parse(readFileSync(new URL('fixtures/barcode-pixels.json', import.meta.url), 'utf8')).cases;
const fixture = (name) => {
  const item = fixtures.find((entry) => entry.name === name);
  return { width: item.width, height: item.height,
    data: new Uint8ClampedArray(inflateSync(Buffer.from(item.rgba_zlib_base64, 'base64'))) };
};
function blank(width, height, value = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255; }
  return { width, height, data };
}
function paste(canvas, image, x, y) {
  for (let row = 0; row < image.height; row++) canvas.data.set(image.data.subarray(row * image.width * 4,
    (row + 1) * image.width * 4), ((y + row) * canvas.width + x) * 4);
  return canvas;
}
function boxBlur(image, radius) {
  const data = new Uint8ClampedArray(image.data.length), { width, height } = image;
  // Independent test-only spatial averaging, not the implementation's analysis.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0, count = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const sx = Math.max(0, Math.min(width - 1, x + dx)), sy = Math.max(0, Math.min(height - 1, y + dy));
      sum += image.data[(sy * width + sx) * 4]; count++;
    }
    const p = (y * width + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = Math.round(sum / count); data[p + 3] = 255;
  }
  return { width, height, data };
}
function contains(region, x, y) {
  return x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height;
}

for (const name of ['QR code', 'Code 128', 'EAN-13', 'Inverted QR code', 'Rotated QR code']) {
  test(`finds an off-centre real encoded label and retains its ink: ${name}`, () => {
    const label = fixture(name), x = 70, y = 50;
    const image = paste(blank(label.width + 450, label.height + 270), label, x, y);
    const before = Buffer.from(image.data);
    const result = analysis.analyze(image);
    assert.deepEqual(image.data, new Uint8ClampedArray(before), 'analysis cannot modify source pixels');
    const region = result.regions.find((entry) => contains(entry, x + label.width / 2, y + label.height / 2));
    assert.ok(region, JSON.stringify(result));
    assert.ok(region.width * region.height < image.width * image.height * 0.90);
    assert.equal(region.kind, name.includes('QR') ? 'matrix' : 'linear');
    for (let ly = 0; ly < label.height; ly++) for (let lx = 0; lx < label.width; lx++) {
      // For inverted labels the outer black background is part of the actual image;
      // the white modules remain essential and must not be fabricated by padding.
      if (label.data[(ly * label.width + lx) * 4] < 50 && name !== 'Inverted QR code') {
        assert.ok(contains(region, x + lx, y + ly), `lost ink at ${lx},${ly}`);
      }
    }
    const cropped = analysis.crop(image, region);
    assert.equal(cropped.image.width, region.width);
    assert.equal(cropped.image.height, region.height);
    const croppedPixels = new Uint8Array(cropped.image.data);
    for (let row = 0; row < region.height; row++) {
      assert.deepEqual(croppedPixels.subarray(row * region.width * 4, (row + 1) * region.width * 4),
        new Uint8Array(image.data.buffer, ((region.y + row) * image.width + region.x) * 4, region.width * 4));
    }
    assert.deepEqual(cropped.mapPoint({ x: 0, y: 0 }), { x: region.x, y: region.y });
  });
}

test('keeps two separated QR search regions without overlapping duplicates', () => {
  const label = fixture('QR code');
  const image = paste(paste(blank(600, 300), label, 40, 40), label, 420, 130);
  const regions = analysis.analyze(image).regions;
  assert.equal(regions.length, 2);
  assert.ok(regions.some((region) => contains(region, 98, 98)));
  assert.ok(regions.some((region) => contains(region, 478, 188)));
});

test('ranks a sharp fresh label ahead of an independently blurred capture', () => {
  const label = fixture('QR code'), sharp = paste(blank(420, 260), label, 40, 50);
  const blurred = paste(blank(420, 260), boxBlur(label, 4), 40, 50);
  const a = analysis.analyze(sharp), b = analysis.analyze(blurred);
  assert.ok(a.score > b.score + 15, JSON.stringify({ sharp: a, blurred: b }));
});

test('white backgrounds do not cause a glare warning, while a central erased highlight can', () => {
  const white = analysis.analyze(blank(320, 240));
  assert.equal(white.hint, 'low-detail');
  assert.equal(white.score, 0);
  assert.deepEqual(white.regions, []);
  const label = fixture('QR code');
  const clean = paste(blank(420, 260), label, 40, 50);
  assert.notEqual(analysis.analyze(clean).hint, 'glare');
  const damaged = paste(blank(420, 260), label, 40, 50);
  paste(damaged, blank(42, 42), 77, 87);
  assert.equal(analysis.analyze(damaged).hint, 'glare');
});

test('dark and tiny labels yield bounded actionable hints without claiming a decoded value', () => {
  assert.equal(analysis.analyze(blank(320, 240, 12)).hint, 'dark');
  const label = fixture('QR code');
  const small = analysis.crop(label, { x: 0, y: 0, width: label.width, height: label.height }, 2500).image;
  const scene = paste(blank(320, 240), { ...small, data: new Uint8ClampedArray(small.data) }, 50, 70);
  const result = analysis.analyze(scene);
  assert.equal(result.hint, 'small');
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.equal(result.regions[0].kind, 'matrix');
});

test('whole-image random texture is not proposed as a barcode crop', () => {
  const image = blank(640, 480); let seed = 32771;
  for (let p = 0; p < image.data.length; p += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[p] = image.data[p + 1] = image.data[p + 2] = seed >>> 24;
  }
  const result = analysis.analyze(image);
  assert.deepEqual(result.regions, []);
  assert.notEqual(result.hint, 'glare');
});

test('a label clipped at the source edge requests a wider view without inventing a quiet zone', () => {
  const label = fixture('Code 128');
  const truncated = analysis.crop(label, { x: 80, y: 0, width: label.width - 80, height: label.height }).image;
  const scene = paste(blank(1000, 450), { ...truncated, data: new Uint8Array(truncated.data) }, 0, 40);
  const result = analysis.analyze(scene);
  assert.equal(result.hint, 'clipped');
  const region = result.regions[0];
  assert.equal(region.x, 0);
  const output = analysis.crop(scene, region).image;
  assert.deepEqual(Array.from(new Uint8Array(output.data).subarray(0, 4)), Array.from(scene.data.subarray(region.y * scene.width * 4, region.y * scene.width * 4 + 4)));
});

test('fingerprints use all pixels and dimensions and accept equivalent buffer representations', () => {
  const image = fixture('QR code');
  const first = analysis.analyze(image).fingerprint;
  assert.equal(analysis.analyze({ ...image, data: image.data.buffer }).fingerprint, first);
  assert.equal(analysis.analyze({ ...image, data: new Uint8Array(image.data) }).fingerprint, first);
  image.data[image.data.length - 4] ^= 1;
  assert.notEqual(analysis.analyze(image).fingerprint, first, 'a change outside the barcode still changes identity');
  const a = blank(40, 20), b = { ...a, width: 20, height: 40 };
  assert.notEqual(analysis.analyze(a).fingerprint, analysis.analyze(b).fingerprint);
  const unaligned = new Uint8Array(image.data.length + 1); unaligned.set(image.data, 1);
  assert.equal(analysis.analyze({ ...image, data: unaligned.subarray(1) }).fingerprint, analysis.analyze(image).fingerprint);
});

test('crop budgets and mappings hold for fractional coordinates and extreme aspect ratios', () => {
  const image = blank(1200, 300, 42);
  const crop = analysis.crop(image, { x: 10.2, y: 20.3, width: 1000.1, height: 200.1 }, 5000);
  assert.ok(crop.image.width * crop.image.height <= 5000);
  for (const point of [{ x: 0, y: 0 }, { x: crop.image.width - 1, y: crop.image.height - 1 }]) {
    const mapped = crop.mapPoint(point);
    assert.ok(mapped.x >= 10 && mapped.x <= 1011 && mapped.y >= 20 && mapped.y <= 221);
  }
  const thin = analysis.crop(blank(4000, 1), { x: 0, y: 0, width: 4000, height: 1 }, 20);
  assert.ok(thin.image.width * thin.image.height <= 20);
});

test('malformed dimensions, buffers, and out-of-frame crop padding fail before work', () => {
  for (const image of [null, { width: 0, height: 1 }, { width: 2001, height: 2000 },
    { width: 2, height: 2, data: new Uint8Array(15) }, { width: 2, height: 2, data: Array(16).fill(0) },
    { width: 2, height: 2, data: new Int8Array(16) }]) assert.throws(() => analysis.analyze(image));
  const image = blank(100, 50);
  for (const region of [{ x: -1, y: 0, width: 10, height: 10 }, { x: 90, y: 0, width: 11, height: 10 },
    { x: 0, y: 0, width: Infinity, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }]) {
    assert.throws(() => analysis.crop(image, region));
  }
  for (const budget of [0, 4_000_001, 1.5, NaN]) assert.throws(() => analysis.crop(image, { x: 0, y: 0, width: 10, height: 10 }, budget));
});
