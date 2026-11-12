import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/accuracy-pixels.json')));
const selected = ['code128/clean', 'qr/clean', 'negative/white'];
const corpus = { version: 1, split: 'dev', cases: fixture.cases.filter(item => selected.includes(item.name)) };
assert.equal(corpus.cases.length, 3);

function temporaryRun(run) {
  const directory = mkdtempSync(join(tmpdir(), 'barcode-custom-benchmark-'));
  try { run(directory); }
  finally {
    // Cleanup is restricted to the concrete temporary directory created above.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('barcode-custom-benchmark-'));
    rmSync(directory, { recursive: true, force: true });
  }
}
function execute(directory, engineDir) {
  const corpusPath = join(directory, 'corpus.json'), output = join(directory, 'report.json');
  writeFileSync(corpusPath, JSON.stringify(corpus));
  const args = [join(root, 'tools/benchmark-damage-custom.mjs'), '--corpus', corpusPath, '--output', output];
  if (engineDir) args.push('--engine-dir', engineDir);
  const processResult = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20_000 });
  assert.equal(processResult.error, undefined);
  return { processResult, report: JSON.parse(readFileSync(output)), corpusPath };
}

test('standalone custom benchmark filters formats and records source and corpus hashes', () => temporaryRun(directory => {
  const { processResult, report, corpusPath } = execute(directory);
  assert.equal(processResult.status, 0, processResult.stderr);
  assert.deepEqual(report.selection, { corpusCases: 3, includedCases: 2, excludedOtherFormatCases: 1 });
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.positives, 1);
  assert.equal(report.summary.exactPositiveReads, 1);
  assert.equal(report.summary.negatives, 1);
  assert.equal(report.summary.negativesCorrectlyRejected, 1);
  assert.equal(report.summary.unexpectedResults, 0);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.corpusSha256, createHash('sha256').update(readFileSync(corpusPath)).digest('hex'));
  const sourceHash = createHash('sha256');
  for (const filename of ['code128-decoder.js', 'code128-detector.js', 'code128-engine.js']) {
    const source = readFileSync(join(root, 'web/engine', filename), 'utf8').replace(/\r\n/g, '\n');
    sourceHash.update(filename + '\0').update(source);
    assert.equal(report.engineFiles[filename], createHash('sha256').update(source).digest('hex'));
  }
  assert.equal(report.engineSha256, sourceHash.digest('hex'));
  assert.deepEqual(report.cases.find(item => item.expectedCount).expected, corpus.cases.find(item => item.name === 'code128/clean').expected);
}));

test('unexpected tuples on positives and negatives both fail the custom benchmark', () => temporaryRun(directory => {
  const engineDir = join(directory, 'engine');
  mkdirSync(engineDir);
  writeFileSync(join(engineDir, 'code128-decoder.js'), '// unused stub\r\n');
  writeFileSync(join(engineDir, 'code128-detector.js'), '// unused stub\r\n');
  writeFileSync(join(engineDir, 'code128-engine.js'), `module.exports = { read() { return [{ text: 'WRONG', format: 'Code128', position: {
    topLeft:{x:0,y:0}, topRight:{x:1,y:0}, bottomRight:{x:1,y:1}, bottomLeft:{x:0,y:1}
  } }]; } };\r\n`);
  const { processResult, report } = execute(directory, engineDir);
  assert.equal(processResult.status, 1, processResult.stderr);
  assert.equal(report.summary.exactPositiveReads, 0);
  assert.equal(report.summary.negativesCorrectlyRejected, 0);
  assert.equal(report.summary.unexpectedResults, 2);
  assert.equal(report.summary.errors, 0);
  assert.ok(report.cases.every(item => !item.exact && item.unexpected[0].text === 'WRONG'));
  assert.deepEqual(report.cases.find(item => item.expectedCount).missing, corpus.cases.find(item => item.name === 'code128/clean').expected.map(item => item.text));
}));
