import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { compare, identity, parseReport, report, summarize, trialMetrics } from '../web/benchmark/metrics.mjs';
import { createRecorder } from '../web/benchmark/recorder.mjs';
import { createScanbotAdapter, createWorkerAdapter, localUrl } from '../web/benchmark/adapters.mjs';
const require = createRequire(import.meta.url), PosPolicy = require('../web/pos-policy.js'), FrameAnalysis = require('../web/frame-analysis.js');
const root = new URL('../', import.meta.url);
const code = (text = '00123', format = 'code128') => ({ format, text });
function trial(overrides = {}) {
  return { runId: 'run-a', sessionId: 'simulated-session', deviceId: 'simulated-device', caseId: 'synthetic-case', repeat: 1,
    source: 'synthetic', expected: code(), engine: { id: 'engine-a', version: 'simulation', configuration: 'worker-image-recovery' },
    protocol: { mode: 'shared-camera-image-v1', policy: 'pos-v1', formats: ['code128', 'qr'], confirmationFrames: 2,
      trialMs: 5000, intervalMs: 120, width: 640, height: 480, sourceWidth: 640, sourceHeight: 480,
      camera: { facingMode: 'environment', focusMode: 'unknown', exposureMode: 'unknown', zoom: null, frameRate: 30 } },
    outcome: { status: 'completed', elapsedMs: 5000, frames: 6, confirmations: [] }, ...overrides };
}
const outcome = (confirmations, status = 'completed') => ({ status, elapsedMs: status === 'completed' ? 5000 : 300, frames: 6, confirmations });
const event = (atMs, text = '00123', format = 'code128') => ({ atMs, text, format });

test('wrong first and eventual correct are separate; exact text and format retain leading zeroes', () => {
  const data = report([trial({ outcome: outcome([event(200, '123'), event(400, '00123', 'qr'), event(600)]) })]);
  const metric = trialMetrics(data.trials[0]);
  assert.equal(metric.firstConfirmationMs, 200); assert.equal(metric.firstCorrectMs, 600);
  assert.equal(metric.wrongFirst, true); assert.equal(metric.wrongConfirmations, 2);
  assert.equal(metric.cleanCorrect, false); assert.equal(metric.missed, false);
  assert.throws(() => identity({ format: 'code128', text: 123 }));
});
test('negative cases, cancellation and errors have correct denominators and source counts', () => {
  const data = report([
    trial({ runId: 'a', repeat: 1, source: 'real', outcome: outcome([event(250)]) }),
    trial({ runId: 'b', repeat: 2 }),
    trial({ runId: 'c', repeat: 3, outcome: outcome([], 'cancelled') }),
    trial({ runId: 'd', repeat: 4, outcome: outcome([], 'error') }),
    trial({ runId: 'e', repeat: 5, expected: null }),
    trial({ runId: 'f', repeat: 6, expected: null, outcome: outcome([event(100)]) }),
  ]);
  assert.deepEqual(summarize(data), { total: 6, completed: 4, cancelled: 1, errors: 1, real: 1, synthetic: 5,
    positives: 2, negatives: 2, cleanCorrect: 1, missed: 1, correctNegatives: 1, trialsWithWrongConfirmation: 1,
    wrongFirst: 1, interruptedWithWrongConfirmation: 0, interruptedWrongFirst: 0, medianFirstCorrectMs: 250 });
});
test('cancelling does not erase wrong confirmations already observed', () => {
  const data = report([trial({ outcome: outcome([event(100, 'wrong')], 'cancelled') })]);
  const summary = summarize(data);
  assert.equal(summary.completed, 0); assert.equal(summary.missed, 0);
  assert.equal(summary.interruptedWithWrongConfirmation, 1); assert.equal(summary.interruptedWrongFirst, 1);
});
test('bounded recorder ignores late results and repeated completion', () => {
  const recorder = createRecorder(trial(), 1000); recorder.frame();
  assert.equal(recorder.confirmation(code(), 6000), false);
  assert.equal(recorder.confirmation(code(), 2000), true);
  const result = recorder.finish('completed', 6000);
  assert.equal(result.outcome.confirmations.length, 1);
  assert.equal(result.outcome.confirmations[0].atMs, 1000);
  assert.equal(recorder.confirmation(code(), 3000), false);
  assert.equal(recorder.finish('completed', 6001), null);
});
test('fail closed on fabricated incomplete completion, malformed schema and duplicates', () => {
  const malformed = [
    trial({ expected: { format: 'code128', text: 123 } }),
    trial({ licenseKey: 'must-not-export' }),
    trial({ outcome: outcome([event(5001)]) }),
    trial({ outcome: outcome([event(400), event(200)]) }),
    trial({ outcome: { ...outcome([event(100)]), frames: 0 } }),
    trial({ outcome: { ...outcome([]), elapsedMs: 4999 } }),
    trial({ protocol: { ...trial().protocol, confirmationFrames: 0 } }),
    trial({ protocol: { ...trial().protocol, width: 4000 } }),
    trial({ protocol: { ...trial().protocol, formats: ['qr', 'qr'] } }),
  ];
  for (const value of malformed) assert.throws(() => report([value]));
  assert.throws(() => report([trial(), trial({ runId: 'different-run' })]), /Duplicate/);
  assert.throws(() => report([trial(), trial({ repeat: 2 })]), /Duplicate/);
  assert.throws(() => parseReport({ ...report([]), image: 'pixels' }));
  assert.throws(() => report(Array(2001).fill(trial())));
});
function opposite(original = trial()) { return { ...original, runId: 'run-b', engine: { id: 'engine-b', version: 'simulation', configuration: 'scanbot-single-shot' } }; }
test('independent decoder reports retain their configuration and cannot mix with older trials', () => {
  const old = trial(), updated = trial({ runId: 'new-run', repeat: 2,
    engine: { ...trial().engine, configuration: 'worker-image-independent-v1' } });
  assert.equal(parseReport(report([updated])).trials[0].engine.configuration, 'worker-image-independent-v1');
  assert.equal(parseReport(report([old])).trials[0].engine.configuration, 'worker-image-recovery');
  assert.throws(() => compare(report([old, updated]), report([opposite(old), { ...opposite(updated), runId: 'run-c' }])), /configuration/);
  assert.throws(() => report([trial({ engine: { ...old.engine, configuration: 'unknown-reader' } })]), /metadata/);
});
test('paired comparison ignores JSON property order and allowlist order', () => {
  const a = trial(), b = opposite();
  b.protocol = Object.fromEntries(Object.entries(b.protocol).reverse()); b.protocol.formats.reverse();
  b.engine = Object.fromEntries(Object.entries(b.engine).reverse());
  assert.equal(compare(report([a]), report([b])).pairs.length, 1);
});
test('paired comparison rejects mismatched devices, truth, options and mixed engine versions', () => {
  const left = report([trial()]);
  for (const changed of [
    { sessionId: 'different' }, { deviceId: 'another-phone' }, { caseId: 'another-case' }, { repeat: 2 }, { source: 'real' },
    { expected: code('123') }, { protocol: { ...trial().protocol, confirmationFrames: 3 } },
    { protocol: { ...trial().protocol, camera: { ...trial().protocol.camera, zoom: 2 } } },
  ]) assert.throws(() => compare(left, report([{ ...opposite(), ...changed }])));
  const first = trial(), second = trial({ runId: 'new-run', repeat: 2, engine: { ...trial().engine, version: 'other' } });
  assert.throws(() => compare(report([first, second]), report([opposite(first), { ...opposite(second), runId: 'run-c' }])), /version/);
  assert.throws(() => compare(left, left), /different engine/);
  assert.throws(() => compare(left, report([])));
});
test('CLI emits a validated local JSON result, refuses incompatible reports and overwriting inputs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'barcode-comparison-'));
  const left = path.join(directory, 'a.json'), right = path.join(directory, 'b.json'), output = path.join(directory, 'out.json');
  try {
    fs.writeFileSync(left, JSON.stringify(report([trial()]))); fs.writeFileSync(right, JSON.stringify(report([opposite()])));
    const run = target => spawnSync(process.execPath, [new URL('tools/compare-scanners.mjs', root).pathname.replace(/^\/(.:)/, '$1'), '--left', left, '--right', right, '--output', target], { encoding: 'utf8' });
    assert.equal(run(output).status, 0); assert.equal(JSON.parse(fs.readFileSync(output)).pairs.length, 1);
    assert.equal(run(output).status, 1); assert.equal(run(left).status, 1);
    fs.writeFileSync(right, JSON.stringify(report([{ ...opposite(), deviceId: 'mismatched' }])));
    const invalidOutput = path.join(directory, 'invalid.json');
    assert.equal(run(invalidOutput).status, 1); assert.equal(fs.existsSync(invalidOutput), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('vendor URLs stay on the local origin without credentials or query strings', () => {
  const base = 'https://scanner.example/project/benchmark/';
  assert.equal(localUrl('../scanbot/entry.js', base).href, 'https://scanner.example/project/scanbot/entry.js');
  for (const url of ['https://cdn.example/engine.js', 'https://user:password@scanner.example/a.js', '/a.js?key=secret', '/a.js#key', 'data:text/javascript,alert(1)']) assert.throws(() => localUrl(url, base));
});
test('Scanbot adapter uses the official image contract, explicit formats and exact identity', async () => {
  const calls = [], key = 'runtime-secret-only';
  const SDK = { Config: { Image: { fromImageData: image => ({ image }) }, BarcodeFormatCommonConfiguration: class { constructor(options) { Object.assign(this, options); } } },
    async initialize(options) { calls.push(options); return { version: '10.0.0', async getLicenseInfo() { return { isValid: () => true }; }, async detectBarcodes(image, config, consume) {
      calls.push({ image, config, consume }); return { barcodes: [{ format: 'UPC_A', text: '001234567895', rawBytes: new TextEncoder().encode('001234567895') }] };
    } }; } };
  const adapter = await createScanbotAdapter({ SDK, licenseKey: key, enginePath: 'https://scanner.example/scanbot/bin/' });
  const result = await adapter.decode({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, ['upca', 'ean13']);
  assert.equal(result[0].text, '001234567895'); assert.equal(result[0].format, 'upca');
  assert.equal(calls[0].verboseLogging, false); assert.equal(calls[0].allowThreads, false);
  assert.deepEqual(calls[1].config.barcodeFormatConfigurations[0].formats, ['UPC_A', 'EAN_13']);
  assert.equal(calls[1].config.processingMode, 'SINGLE_SHOT'); assert.equal(calls[1].config.directAcceptanceAreaFraction, 1);
  assert.equal(calls[1].consume, 'CONSUME_IMAGE'); assert.equal(JSON.stringify(adapter.metadata).includes(key), false);
  adapter.dispose(); await assert.rejects(adapter.decode({}, ['upca']));
});
test('Scanbot is explicitly unconfigured without its SDK; vendor failures do not echo license values', async () => {
  await assert.rejects(createScanbotAdapter({ SDK: null, licenseKey: '', enginePath: '/' }), /supplied module/);
  const SDK = { Config: { Image: { fromImageData() {} }, BarcodeFormatCommonConfiguration: class {} }, initialize: async () => { throw new Error('secret-key-value'); } };
  await assert.rejects(createScanbotAdapter({ SDK, licenseKey: 'secret-key-value', enginePath: '/' }), error => !error.message.includes('secret-key-value'));
});
test('expired vendor license blocks setup and an unfinished vendor decode blocks overlapping trials', async () => {
  let valid = false, complete;
  const SDK = { Config: { Image: { fromImageData: image => image }, BarcodeFormatCommonConfiguration: class {} },
    initialize: async () => ({ version: '10.0.0', getLicenseInfo: async () => ({ isValid: () => valid }),
      detectBarcodes: () => new Promise(resolve => { complete = resolve; }) }) };
  const settings = { SDK, licenseKey: 'runtime-license', enginePath: '/' };
  await assert.rejects(createScanbotAdapter(settings), /license validation/);
  valid = true;
  const adapter = await createScanbotAdapter(settings), pending = adapter.decode({}, ['qr']);
  adapter.dispose();
  await assert.rejects(createScanbotAdapter(settings), /previous Scanbot request/);
  complete({ barcodes: [] }); await assert.rejects(pending, /stopped/);
  const next = await createScanbotAdapter(settings); next.dispose();
});
test('our actual bundled WASM goes through the benchmark adapter, two-frame policy and recorder', async () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('tests/fixtures/barcode-pixels.json', root))).cases;
  const fixture = fixtures.find(item => item.expected?.some(item => item.formats.includes('QRCode')));
  assert.ok(fixture);
  const wasm = fs.readFileSync(new URL('web/vendor/zxing_reader.wasm', root));
  const originalWorker = globalThis.Worker;
  class LocalWorker {
    constructor() {
      this.closed = false;
      const worker = this;
      const context = vm.createContext({ console, URL, WebAssembly, Response, TextDecoder, TextEncoder, performance,
        ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, Blob,
        ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
        location: { href: 'https://local.test/scanner-worker.js' },
        importScripts(filename) { assert.ok(['./vendor/zxing-reader.js', './pos-policy.js', './frame-analysis.js',
          './qr-geometry.js', './qr-recovery.js', './linear-signal.js', './qr-signal.js', './qr-damage.js',
          './independent-reader.js', './vendor/zbar/index.js', './engine/code128-decoder.js', './engine/code128-detector.js', './engine/code128-engine.js'].includes(filename)); vm.runInContext(fs.readFileSync(new URL('web/' + filename.slice(2), root), 'utf8'), context); },
        async fetch(url) {
          const paths = new Map(['vendor/zxing_reader.wasm', 'vendor/zbar/zbar.wasm'].map(path => ['https://local.test/' + path, path]));
          assert.ok(paths.has(String(url)), 'all decoder dependencies are local');
          return new Response(fs.readFileSync(new URL('web/' + paths.get(String(url)), root)), { headers: { 'Content-Type': 'application/wasm' } });
        },
        postMessage(data) { if (!worker.closed) queueMicrotask(() => worker.onmessage?.({ data })); },
      });
      context.self = context;
      vm.runInContext(fs.readFileSync(new URL('web/scanner-worker.js', root), 'utf8'), context); this.context = context;
    }
    postMessage(data) { Promise.resolve(this.context.onmessage({ data })).catch(() => this.onerror?.()); }
    terminate() { this.closed = true; }
  }
  globalThis.Worker = LocalWorker;
  let adapter;
  try {
    adapter = await createWorkerAdapter();
    const expected = code(fixture.expected.find(item => item.formats.includes('QRCode')).text, 'qr');
    const meta = trial({ expected, engine: adapter.metadata });
    const recorder = createRecorder(meta, 0), policy = PosPolicy.createConfirmation({ allowedFormats: ['qr'], confirmationFrames: 2 });
    for (let frame = 0; frame < 2; frame++) {
      const pixels = new Uint8ClampedArray(inflateSync(Buffer.from(fixture.rgba_zlib_base64, 'base64'))); pixels[0] = 254 - frame;
      const image = { width: fixture.width, height: fixture.height, data: pixels };
      const fingerprint = FrameAnalysis.analyze(image).fingerprint;
      recorder.frame(); const result = await adapter.decode(image, ['qr']);
      const decision = policy.observe(result, 'presented:' + frame, 100 + frame * 200, fingerprint);
      if (frame === 0) assert.equal(decision.status, 'rescan');
      else {
        assert.equal(decision.status, 'confirmed');
        recorder.confirmation(code(decision.results[0].text, PosPolicy.canonicalFormat(decision.results[0].format)), 600);
      }
    }
    const result = recorder.finish('completed', 5000);
    assert.equal(trialMetrics(result).cleanCorrect, true); assert.equal(result.source, 'synthetic');
  } finally { adapter?.dispose(); globalThis.Worker = originalWorker; }
});
