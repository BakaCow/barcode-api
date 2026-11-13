import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(project, '.live-benchmark-test-'));
after(() => {
  assert.equal(dirname(resolve(temporary)), resolve(project));
  rmSync(temporary, { recursive: true, force: true });
});
const base = JSON.parse(readFileSync(join(project, 'tests/fixtures/barcode-pixels.json'), 'utf8'));
const damaged = JSON.parse(readFileSync(join(project, 'tests/fixtures/damage-stress-verify.json'), 'utf8'));
const qr = base.cases.find((item) => item.name === 'QR code');
const blank = base.cases.find((item) => item.name === 'Blank image');
const ambiguous = damaged.cases.find((item) => item.name === 'ean13/verify-ean13-label-2/angled-2');
assert.ok(qr && blank && ambiguous);
let sequence = 0;
function run(cases, flags = []) {
  const input = join(temporary, `input-${++sequence}.json`), output = join(temporary, `report-${sequence}.json`);
  writeFileSync(input, JSON.stringify({ version: 1, cases }));
  const result = spawnSync(process.execPath, [join(project, 'tools/benchmark-accuracy.mjs'),
    '--corpus', input, '--output', output, ...flags], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  return { ...result, report: existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null };
}

test('default worker benchmark keeps its existing options and report shape', () => {
  const result = run([qr, blank]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.summary.exactPositiveReads, 1);
  assert.equal(result.report.summary.negativesCorrectlyRejected, 1);
  assert.equal(result.report.summary.unexpectedResults, 0);
  assert.equal(result.report.mode, 'image');
  assert.equal(result.report.retryIndex, 0);
  assert.ok(!Object.hasOwn(result.report, 'settings'));
  assert.ok(!Object.hasOwn(result.report, 'dependencySha256'));
});

test('enhanced POS worker benchmark applies formats and records exact source hashes without claiming confirmation', () => {
  const result = run([qr, ambiguous, blank], ['--enhance-live', '--pos-formats', 'ean13,qr']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.settings, {
    enhanceLive: true, posOptions: { allowedFormats: ['ean13', 'qr'], confirmationFrames: 1 },
    cameraFrameSelection: false, posConfirmation: false,
  });
  assert.equal(result.report.summary.exactPositiveReads, 2);
  assert.equal(result.report.summary.negativesCorrectlyRejected, 1);
  assert.equal(result.report.summary.unexpectedResults, 0);
  assert.match(result.report.description, /does not exercise camera capture, frame selection or POS confirmation/);
  for (const filename of ['frame-analysis.js', 'pos-policy.js']) {
    const normalized = readFileSync(join(project, 'web', filename), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(result.report.dependencySha256[filename], createHash('sha256').update(normalized).digest('hex'));
  }
});

test('enabling UPC-E preserves the known native ambiguity as a failing exact-read benchmark', () => {
  const result = run([ambiguous], ['--enhance-live', '--pos-formats', 'ean13,upce']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.report.summary.exactPositiveReads, 0);
  assert.equal(result.report.summary.unexpectedResults, 1);
  assert.deepEqual(result.report.cases[0].missing, []);
  assert.deepEqual(result.report.cases[0].unexpected, [{ text: '0169100005107', format: 'UPCE' }]);
  assert.equal(result.report.settings.posConfirmation, false, 'the separate policy is not run by this worker-only benchmark');
});

test('enhancement alone keeps the unrestricted format behavior and hashes only its dependency', () => {
  const result = run([qr, blank], ['--enhance-live', '--mode', 'live']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.mode, 'live');
  assert.equal(result.report.settings.posOptions, null);
  assert.deepEqual(Object.keys(result.report.dependencySha256), ['frame-analysis.js']);
});

test('malformed or empty format profiles fail before reading images or producing a report', () => {
  for (const flags of [['--pos-formats', ''], ['--pos-formats'], ['--pos-formats', 'QR'],
    ['--pos-formats', 'qr,qr'], ['--pos-formats', 'qr,'], ['--pos-formats', 'unknown'],
    ['--enhance-live', 'false'], ['--enhance-live', '--enhance-live'],
    ['--pos-formats', 'qr', '--pos-formats', 'code128']]) {
    const output = join(temporary, `invalid-${++sequence}.json`);
    const result = spawnSync(process.execPath, [join(project, 'tools/benchmark-accuracy.mjs'),
      '--corpus', join(temporary, 'must-not-be-read.json'), '--output', output, ...flags],
    { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0, flags.join(' '));
    assert.match(result.stderr, /POS formats|--pos-formats|--enhance-live/);
    assert.doesNotMatch(result.stderr, /ENOENT/, 'option validation runs before any corpus read');
    assert.ok(!existsSync(output));
  }
});
