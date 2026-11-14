import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
const require = createRequire(import.meta.url);
const geometry = require('../web/qr-geometry.js'), recovery = require('../web/qr-recovery.js');
const fixtures = JSON.parse(readFileSync(new URL('fixtures/damage-stress-recovery.json', import.meta.url))).cases;
function imageFor(suffix, number = 1) {
  const fixture = fixtures.find(item => item.name === `qr/recovery-qr-label-${number}/${suffix}`);
  return { width: fixture.width, height: fixture.height, data: new Uint8ClampedArray(inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'))) };
}
const options = { timeBudgetMs: 120, maxScanDimension: 2048 };

test('three observed finder patterns produce source coordinates and the measured module pitch', () => {
  const image = imageFor('clean-0'), original = Buffer.from(image.data), found = geometry.analyze(image, options);
  assert.equal(found.complete, true); assert.equal(found.regions.length, 1);
  const region = found.regions[0];
  assert.equal(region.kind, 'matrix'); assert.equal(region.qr, true); assert.equal(region.gridReliable, true);
  assert.equal(region.dimension, 29); assert.equal(region.moduleSize, 3);
  assert.equal(region.clipped, false); assert.deepEqual(region.finders.topLeft, { x: 34, y: 34 });
  for (const corner of Object.values(region.quad)) assert.ok(corner.x >= 0 && corner.y >= 0 && corner.x < image.width && corner.y < image.height);
  assert.deepEqual(Buffer.from(image.data), original);
});

test('tiny finder geometry uses original source coordinates without guessing a decoded value', () => {
  const image = imageFor('small-in-frame-1'), found = geometry.analyze(image, options);
  assert.equal(found.regions.length, 1);
  const region = found.regions[0];
  assert.ok(region.moduleSize < 2); assert.ok(region.x > 100 && region.y > 100);
  assert.equal(region.text, undefined); assert.equal(region.bytes, undefined);
});

test('rotated QR geometry preserves orientation and copies the complete source crop', () => {
  const image = imageFor('angled-2'), region = geometry.analyze(image, options).regions[0];
  assert.ok(region); assert.notEqual(region.quad.topLeft.y, region.quad.topRight.y);
  const candidate = recovery.crop(image, region);
  assert.deepEqual(candidate.mapPoint({ x: 0, y: 0 }), { x: Math.floor(region.x), y: Math.floor(region.y) });
  const sourcePixel = (Math.floor(region.y) * image.width + Math.floor(region.x)) * 4;
  assert.deepEqual(Array.from(candidate.image.data.slice(0, 4)), Array.from(image.data.slice(sourcePixel, sourcePixel + 4)));
});

test('zero budget and too-small inputs never claim a completed locator search', () => {
  assert.equal(geometry.analyze(imageFor('clean-0'), { timeBudgetMs: 0 }).complete, false);
  assert.deepEqual(geometry.analyze({ width: 3, height: 3, data: new Uint8Array(36) }).regions, []);
});

test('blank and narrow finder-lookalike textures do not become reliable QR grids', () => {
  const data = new Uint8ClampedArray(180 * 140 * 4).fill(255);
  assert.deepEqual(geometry.analyze({ data, width: 180, height: 140 }, options).regions, []);
  for (let y = 10; y < 130; y++) for (let x = 10; x < 170; x++) if (Math.floor(x / 5) % 2) {
    const i = (y * 180 + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  }
  assert.deepEqual(geometry.analyze({ data, width: 180, height: 140 }, options).regions, []);
});

test('clipped or unsupported grids cannot produce an invented white quiet zone', () => {
  const image = imageFor('clean-0'), region = geometry.analyze(image, options).regions[0];
  assert.equal(recovery.grid(image, { ...region, clipped: true }), null);
  assert.equal(recovery.grid(image, { ...region, gridReliable: false }), null);
  assert.equal(recovery.grid(image, { ...region, quad: Object.fromEntries(Object.entries(region.quad).map(([key, point]) => [key, { x: point.x - 40, y: point.y }])) }), null);
  assert.equal(Array.from(recovery.candidates(image, { ...region, clipped: true })).length, 1, 'only the real source crop remains');
});

test('candidate count and allocation remain bounded and transformations never change the source', () => {
  const image = imageFor('blur-2'), original = Buffer.from(image.data), region = geometry.analyze(image, options).regions[0];
  const imageCandidates = Array.from(recovery.candidates(image, region));
  assert.ok(imageCandidates.length <= 14);
  assert.equal(Array.from(recovery.candidates(image, region, { mode: 'live', retryIndex: 0 })).length, 2);
  for (const candidate of imageCandidates) {
    assert.ok(candidate.image.width * candidate.image.height <= 1_000_000);
    assert.equal(candidate.image.data.length, candidate.image.width * candidate.image.height * 4);
  }
  assert.deepEqual(Buffer.from(image.data), original);
});

test('a locator region cap reports incomplete work when separate symbols remain', () => {
  const source = imageFor('clean-0'), width = source.width * 2 + 40, height = source.height;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (const x of [0, source.width + 40]) data.set(source.data.subarray(y * source.width * 4, (y + 1) * source.width * 4), (y * width + x) * 4);
  const found = geometry.analyze({ data, width, height }, { ...options, maxRegions: 1 });
  assert.equal(found.regions.length, 1); assert.equal(found.complete, false);
});
