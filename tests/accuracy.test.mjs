import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'barcode-accuracy-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
function benchmark(name, extra = []) {
  const output = join(temporary, `${name}.json`);
  execFileSync(process.execPath, [join(project, 'tools/benchmark-accuracy.mjs'), '--output', output, ...extra], { timeout: 120000 });
  return JSON.parse(readFileSync(output, 'utf8'));
}
const baseline = benchmark('baseline', ['--worker', join(project, 'tools/baseline-worker-v0.2.0.js')]);
const enhanced = benchmark('enhanced');
const cases = new Map(enhanced.cases.map((item) => [item.name, item]));

test('challenge corpus checks exact results and never returns an unexpected code', () => {
  assert.equal(enhanced.corpusSha256, baseline.corpusSha256);
  assert.equal(enhanced.summary.total, 72);
  assert.equal(enhanced.summary.errors, 0);
  for (const result of enhanced.cases) assert.deepEqual(result.unexpected, [], result.name);
});

test('all eight non-barcode challenge images are rejected', () => {
  assert.equal(enhanced.summary.negatives, 8);
  assert.equal(enhanced.summary.negativesCorrectlyRejected, 8);
});

test('robust decoding retains every exact positive read from the original worker', () => {
  for (const original of baseline.cases.filter((item) => item.expectedCount && item.exact)) {
    assert.equal(cases.get(original.name)?.exact, true, original.name);
  }
});

test('weak-contrast QR, Code128, EAN13, and DataMatrix are decoded exactly', () => {
  for (const format of ['qr', 'code128', 'ean13', 'datamatrix']) {
    assert.equal(cases.get(`${format}/weak-contrast`)?.exact, true, format);
  }
});

test('diagonal Code128 and EAN13 challenge labels are decoded exactly', () => {
  for (const format of ['code128', 'ean13']) {
    assert.equal(cases.get(`${format}/rotate-37`)?.exact, true, format);
  }
});

test('recoverable blur fixtures decode without changing their payload', () => {
  for (const name of ['qr/blur-1.4', 'datamatrix/blur-1.4', 'code128/blur-2.2']) {
    assert.equal(cases.get(name)?.exact, true, name);
  }
});

test('inverted Code128 and EAN13 labels decode exactly', () => {
  for (const format of ['code128', 'ean13']) {
    assert.equal(cases.get(`${format}/inverted`)?.exact, true, format);
  }
});
