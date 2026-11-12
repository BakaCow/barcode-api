import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
// A checkout-local temporary directory also works in restricted Windows sandboxes.
const temporary = mkdtempSync(join(project, '.code128-benchmark-test-'));
after(() => {
  assert.equal(dirname(resolve(temporary)), resolve(project));
  rmSync(temporary, { recursive: true, force: true });
});
const fixture = JSON.parse(readFileSync(join(project, 'data/synthetic/dev-pixels.json'), 'utf8'));
const positive = fixture.cases.find(item => item.name === 'alpha-clean');
const negative = fixture.cases.find(item => item.name === 'negative-blank');
assert.ok(positive && negative);
let sequence = 0;
function run(corpus) {
  const input = join(temporary, `input-${++sequence}.json`);
  const output = join(temporary, `report-${sequence}.json`);
  writeFileSync(input, JSON.stringify(corpus));
  const result = spawnSync(process.execPath, [join(project, 'tools/benchmark-code128.mjs'), '--fixtures', input, '--output', output],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, report: result.status === 0 || result.status === 1 && !result.stderr ? JSON.parse(readFileSync(output, 'utf8')) : null };
}

test('benchmark CLI compares exact positive and negative results for both real engines', () => {
  const result = run({ ...fixture, cases: [positive, negative] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.sourceCounts, { real: 0, synthetic: 2 });
  for (const engine of ['experimental', 'zxing']) {
    const summary = result.report.summaries[engine];
    assert.equal(summary.positiveImages, 1);
    assert.equal(summary.exactPositiveReads, 1);
    assert.equal(summary.negativeImages, 1);
    assert.equal(summary.negativeFalsePositives, 0);
    assert.equal(summary.imagesWithWrongRead, 0);
    assert.equal(summary.errors, 0);
    assert.equal(summary.timeToConfirmedResultMs, null, 'still-image timings must not pretend to measure live confirmation');
  }
});

test('a deliberately wrong ground truth is counted as missing and wrong, with nonzero exit', () => {
  const changed = { ...positive, expected: [{ text: 'INTENTIONALLY-WRONG', formats: ['Code128'] }] };
  const result = run({ ...fixture, cases: [changed] });
  assert.equal(result.status, 1, result.stderr);
  for (const engine of ['experimental', 'zxing']) {
    const summary = result.report.summaries[engine];
    const item = result.report.cases[0].engines[engine];
    assert.equal(summary.exactPositiveReads, 0);
    assert.equal(summary.imagesWithWrongRead, 1);
    assert.deepEqual(item.missing, ['INTENTIONALLY-WRONG']);
    assert.deepEqual(item.unexpected, [{ text: 'LAB-BOX-128', format: 'Code128' }]);
  }
});

test('benchmark refuses empty datasets, mixed splits and malformed fixture schemas', () => {
  for (const invalid of [
    { ...fixture, cases: [] },
    { ...fixture, cases: [positive, { ...negative, split: 'test' }] },
    { ...fixture, version: 'unknown', cases: [positive] },
  ]) {
    const result = run(invalid);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid|nonempty version1/i);
    assert.equal(result.report, null);
  }
});
