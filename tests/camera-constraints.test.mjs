import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Camera = require('../web/camera-constraints.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const flatten = constraints => Object.assign({}, constraints, ...(constraints.advanced || []));

test('serialized focus, exposure, zoom and torch changes preserve camera selection and capture size', async () => {
  let constraints = {}, settings = { zoom: 1, torch: false };
  const calls = [], releases = [];
  const track = {
    getConstraints: () => constraints,
    getSettings: () => settings,
    applyConstraints(next) {
      calls.push(next);
      return new Promise(resolve => releases.push(() => {
        constraints = next;
        settings = { ...settings, ...flatten(next) };
        if (typeof settings.zoom === 'number') settings.zoom = Math.round(settings.zoom * 2) / 2;
        resolve();
      }));
    },
  };
  const controls = Camera.create(track, { width: { ideal: 1920 }, height: { ideal: 1080 }, deviceId: { exact: 'rear-camera' } });
  const requests = [controls.change({ focusMode: 'continuous' }), controls.change({ exposureMode: 'continuous' }),
    controls.change({ zoom: 2.2 }), controls.change(current => ({ torch: !current.torch }))];
  for (let index = 0; index < requests.length; index++) {
    await flush(); assert.equal(calls.length, index + 1, 'only one hardware update may be in flight');
    releases[index](); await requests[index];
  }
  const final = flatten(calls.at(-1));
  assert.deepEqual(final.width, { ideal: 1920 }); assert.deepEqual(final.height, { ideal: 1080 });
  assert.deepEqual(final.deviceId, { exact: 'rear-camera' });
  assert.equal(final.focusMode, 'continuous'); assert.equal(final.exposureMode, 'continuous');
  assert.equal(final.zoom, 2.2); assert.equal(final.torch, true);
  assert.equal(controls.settings().zoom, 2, 'UI receives actual rounded device settings');
});

test('optional probe failures use remembered constraints and do not block basic control operations', async () => {
  const calls = [];
  const track = { getConstraints() { throw Error(); }, getCapabilities() { throw Error(); }, getSettings() { throw Error(); },
    async applyConstraints(value) { calls.push(value); } };
  const controls = Camera.create(track, { width: { ideal: 1920 } });
  assert.deepEqual(controls.capabilities(), {});
  await controls.change({ zoom: 2 }); await controls.change({ torch: true });
  assert.equal(flatten(calls[1]).zoom, 2);
  assert.deepEqual(calls[1].width, { ideal: 1920 });
  assert.deepEqual(controls.settings(), { zoom: 2, torch: true });
});

test('camera replacement rejects queued changes and prevents a late operation from updating saved state', async () => {
  let current = true, release, calls = 0;
  const controls = Camera.create({ applyConstraints() { calls++; return new Promise(resolve => { release = resolve; }); } }, {}, () => current);
  const first = controls.change({ torch: true }), second = controls.change({ zoom: 2 });
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const secondRejected = assert.rejects(second, { name: 'AbortError' });
  await flush(); current = false; release();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(calls, 1); assert.deepEqual(controls.settings(), {});
});

test('a rejected adjustment does not discard earlier constraints or poison the operation queue', async () => {
  const calls = [];
  const controls = Camera.create({ async applyConstraints(value) {
    calls.push(value); if (flatten(value).torch === true) throw new Error('Unsupported torch');
  } }, { width: { ideal: 1920 } });
  await controls.change({ zoom: 2 });
  await assert.rejects(controls.change({ torch: true }), /Unsupported torch/);
  await controls.change({ exposureMode: 'continuous' });
  assert.equal(flatten(calls.at(-1)).zoom, 2);
  assert.equal(flatten(calls.at(-1)).torch, undefined);
});
