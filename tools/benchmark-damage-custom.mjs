/** Benchmark the actual custom Code128 engine against fixed labelled RGBA pixels. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node tools/benchmark-damage-custom.mjs --corpus tests/fixtures/damage-stress-dev.json --output benchmark-results/custom-dev.json [--engine-dir web/engine]');
  process.exit(0);
}
const values = new Map();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!['--corpus', '--output', '--engine-dir'].includes(name) || values.has(name) || !value || value.startsWith('--')) {
    throw new Error(`Unknown, duplicated or incomplete argument: ${name}`);
  }
  values.set(name, value);
}
const corpusPath = values.get('--corpus'), outputPath = values.get('--output');
if (!corpusPath || !outputPath) throw new Error('Supply --corpus and --output. Only Code128 positives and all negative images are measured.');
const engineDir = resolve(values.get('--engine-dir') || resolve(project, 'web/engine'));
if (statSync(corpusPath).size > 70 * 1024 * 1024) throw new Error('Corpus JSON exceeds 70 MiB.');
const corpusBytes = readFileSync(corpusPath), corpus = JSON.parse(corpusBytes);
if (corpus.version !== 1 || !Array.isArray(corpus.cases) || !corpus.cases.length || corpus.cases.length > 500) {
  throw new Error('A nonempty version 1 stress or accuracy pixel corpus is required (maximum 500 cases).');
}
const names = new Set();
for (const item of corpus.cases) {
  if (!item || typeof item.name !== 'string' || !item.name || names.has(item.name) ||
      !Array.isArray(item.expected) || item.expected.some(truth => !truth || typeof truth.text !== 'string' ||
        !Array.isArray(truth.formats) || !truth.formats.length || truth.formats.some(format => typeof format !== 'string'))) {
    throw new Error(`Invalid or duplicate case truth: ${item?.name || '(unnamed)'}`);
  }
  names.add(item.name);
}
const selected = corpus.cases.filter(item => !item.expected.length || item.expected.every(truth => truth.formats.includes('Code128')));
if (!selected.length) throw new Error('Corpus has no Code128 positives or negative images.');

const engineHash = createHash('sha256'), engineFiles = {};
for (const filename of ['code128-decoder.js', 'code128-detector.js', 'code128-engine.js']) {
  const source = readFileSync(resolve(engineDir, filename), 'utf8').replace(/\r\n/g, '\n');
  engineHash.update(filename + '\0').update(source);
  engineFiles[filename] = createHash('sha256').update(source).digest('hex');
}
const require = createRequire(import.meta.url);
const engine = require(resolve(engineDir, 'code128-engine.js'));
assert.equal(typeof engine.read, 'function', 'custom engine exposes read(image)');
const results = [];
for (const fixture of selected) {
  const { width, height } = fixture;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 8192 || height > 8192 || width * height > 4_000_000 || typeof fixture.rgba_zlib_base64 !== 'string') {
    throw new Error(`Invalid dimensions or compressed pixels: ${fixture.name}`);
  }
  const rgba = inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'), { maxOutputLength: width * height * 4 });
  if (rgba.length !== width * height * 4) throw new Error(`Invalid RGBA pixel buffer: ${fixture.name}`);
  const image = { width, height, data: new Uint8ClampedArray(rgba) };
  let found = [], error;
  const started = performance.now();
  try {
    const decoded = engine.read(image);
    if (!Array.isArray(decoded)) throw new Error('Reader did not return an array.');
    for (const result of decoded) {
      if (typeof result.text !== 'string' || result.format !== 'Code128') throw new Error('Reader returned an invalid result tuple.');
      if (!result.position || ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].some(key => {
        const point = result.position[key];
        return !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > width || point.y > height;
      })) throw new Error('Reader returned invalid source coordinates.');
    }
    found = decoded.map(({ text, format }) => ({ text, format }));
  } catch (failure) { error = failure.message || String(failure); }
  const durationMs = +(performance.now() - started).toFixed(3);
  const matches = (actual, truth) => actual.text === truth.text && truth.formats.includes(actual.format);
  const missing = fixture.expected.filter(truth => !found.some(actual => matches(actual, truth))).map(truth => truth.text);
  const unexpected = found.filter(actual => !fixture.expected.some(truth => matches(actual, truth)));
  results.push({ name: fixture.name, expectedCount: fixture.expected.length,
    expected: fixture.expected, source: fixture.source || 'unspecified',
    ...(fixture.groupId ? { groupId: fixture.groupId } : {}),
    ...(fixture.condition ? { condition: fixture.condition } : {}),
    ...(fixture.severity !== undefined ? { severity: fixture.severity } : {}),
    exact: !error && !missing.length && !unexpected.length, missing, unexpected, results: found, durationMs,
    ...(typeof engine.getDiagnostics === 'function' ? { diagnostics: engine.getDiagnostics() } : {}),
    ...(error ? { error } : {}),
  });
}
const positives = results.filter(item => item.expectedCount), negatives = results.filter(item => !item.expectedCount);
const times = results.map(item => item.durationMs).sort((a, b) => a - b);
const report = {
  description: 'Actual experimental Code128 engine on labelled pixels; selects Code128 positives and all negatives. Strict text/format tuples come from the corpus, never predictions. Host times exclude image import, HTTP, camera capture and UI confirmation. Synthetic examples do not establish phone accuracy or Scanbot parity.',
  engineDir, split: corpus.split || null, corpusVersion: corpus.version,
  selection: { corpusCases: corpus.cases.length, includedCases: selected.length, excludedOtherFormatCases: corpus.cases.length - selected.length },
  engineSha256: engineHash.digest('hex'), engineFiles,
  engineHashMethod: 'SHA256 of ordered filename + NUL + UTF-8 source for decoder, detector and engine, with CRLF normalized to LF',
  corpusSha256: createHash('sha256').update(corpusBytes).digest('hex'),
  provenance: corpus.provenance || null, nodeVersion: process.version,
  summary: { total: results.length, positives: positives.length, exactPositiveReads: positives.filter(item => item.exact).length,
    negatives: negatives.length, negativesCorrectlyRejected: negatives.filter(item => item.exact).length,
    unexpectedResults: results.reduce((sum, item) => sum + item.unexpected.length, 0), errors: results.filter(item => item.error).length,
    medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1] },
  cases: results,
};
mkdirSync(dirname(resolve(outputPath)), { recursive: true });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
console.log('Unsuccessful positive cases:', positives.filter(item => !item.exact).map(item => item.name).join(', ') || 'none');
if (report.summary.unexpectedResults || report.summary.errors) process.exitCode = 1;
