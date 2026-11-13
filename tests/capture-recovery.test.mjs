import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const { createRecovery } = createRequire(import.meta.url)('../web/capture-selection.js');
const small = { hint: 'small', regions: [{ x: 10, y: 10, width: 50, height: 30 }] };
const miss = (recovery, now, frameId, extra = {}) => recovery.observe({ now, frameId, analysis: small, ...extra });

test('recovery needs separate fresh misses over time, then expires and cools down', () => {
  const recovery = createRecovery();
  assert.equal(miss(recovery, 1000, 'a'), false);
  assert.equal(miss(recovery, 1250, 'b'), false);
  assert.equal(miss(recovery, 1500, 'c'), true);
  assert.equal(recovery.detailed(1500), true);
  assert.equal(recovery.detailed(4499), true);
  assert.equal(recovery.detailed(4500), false);
  for (let time = 5000; time < 11500; time += 500) assert.equal(miss(recovery, time, String(time)), false);
  assert.equal(miss(recovery, 11500, 'd'), false);
  assert.equal(miss(recovery, 11750, 'e'), false);
  assert.equal(miss(recovery, 12000, 'f'), true);
});

test('duplicates, backwards clocks and rapid misses cannot accelerate recovery', () => {
  const recovery = createRecovery();
  assert.equal(miss(recovery, 1000, 'a'), false);
  assert.equal(miss(recovery, 1500, 'a'), false);
  assert.equal(miss(recovery, 900, 'b'), false);
  assert.equal(miss(recovery, 1001, 'b'), false);
  assert.equal(miss(recovery, 1002, 'c'), false);
  assert.equal(recovery.detailed(1002), false);
  assert.equal(miss(recovery, 1501, 'd'), true);
});

test('blank, multiple, clipped, dark and glare scenes do not escalate', () => {
  for (const analysis of [null, { hint: 'small', regions: [] },
    { hint: 'small', regions: [small.regions[0], small.regions[0]] },
    ...['clipped', 'dark', 'glare', null].map(hint => ({ ...small, hint }))]) {
    const recovery = createRecovery();
    for (let i = 0; i < 8; i++) assert.equal(miss(recovery, 1000 + i * 250, i, { analysis }), false);
    assert.equal(recovery.detailed(3000), false);
  }
});

test('any observed identity blocks new escalation until reset without interrupting confirmation', () => {
  const recovery = createRecovery();
  miss(recovery, 1000, 'a'); miss(recovery, 1250, 'b');
  assert.equal(miss(recovery, 1500, 'c'), true);
  assert.equal(miss(recovery, 1750, 'd', { hasResults: true }), false);
  assert.equal(recovery.detailed(2000), true);
  for (let i = 0; i < 8; i++) assert.equal(miss(recovery, 12000 + i * 250, i), false);
  recovery.reset();
  miss(recovery, 15000, 'x'); miss(recovery, 15250, 'y');
  assert.equal(miss(recovery, 15500, 'z'), true);
});

test('stale results end the detail window and reset clears all recovery state', () => {
  const recovery = createRecovery();
  miss(recovery, 1000, 'a'); miss(recovery, 1250, 'b'); miss(recovery, 1500, 'c');
  assert.equal(miss(recovery, 2000, 'd', { stale: true }), false);
  assert.equal(recovery.detailed(2000), false);
  assert.equal(miss(recovery, 2500, 'e'), false);
  recovery.reset();
  miss(recovery, 3000, 'f'); miss(recovery, 3250, 'g');
  assert.equal(miss(recovery, 3500, 'h'), true);
  assert.equal(recovery.detailed(NaN), false);
});
