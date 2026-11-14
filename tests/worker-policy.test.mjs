import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../web/scanner-worker.js', import.meta.url), 'utf8');
// Policy/geometry assertions must not depend on CPU contention in other test
// processes. Timing cases advance this clock explicitly instead of benchmarking
// pixel transforms against the production wall-clock deadline.
function harness(read, clock = { now: () => 0 }) {
  const calls = [], responses = [];
  const globals = {
    URL, performance: clock, ArrayBuffer, Uint8Array, Uint8ClampedArray, Uint32Array,
    location: { href: 'https://local.test/scan/scanner-worker.js' },
    ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
    importScripts() {},
    IndependentReader: { initialize: async () => {}, supportedFormats: ['Code128', 'EAN13', 'QRCode'],
      read: async () => ({ zbar: [], project: [], passes: 0, complete: true }) },
    ZXingWASM: {
      prepareZXingModule: () => Promise.resolve(),
      readBarcodes: async (image, options) => { calls.push({ image, options }); return read(image, options, calls.length); },
    },
    postMessage: (message) => responses.push(message),
  };
  const context = vm.createContext(globals); context.self = context;
  vm.runInContext(source, context);
  return {
    calls, context,
    async send(message) { await context.onmessage({ data: { id: 1, type: 'decode', ...message } }); return JSON.parse(JSON.stringify(responses.at(-1))); },
  };
}
function image(width = 120, height = 60) {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  return { width, height, data: pixels.buffer };
}
function verticalBars(width = 120, height = 60) {
  const input = image(width, height), pixels = new Uint8ClampedArray(input.data);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = Math.floor(x / 4) % 2 ? 0 : 255;
  }
  return input;
}
const valid = { isValid: true, error: '', text: 'verified', format: 'Code128', bytes: new Uint8Array([1, 2]) };

const signalResult = { isValid: true, error: '', text: '5901234123457', format: 'EAN13',
  bytes: Array.from('5901234123457', character => character.charCodeAt(0)), position: {
    topLeft: { x: 10, y: 10 }, topRight: { x: 100, y: 10 },
    bottomLeft: { x: 10, y: 40 }, bottomRight: { x: 100, y: 40 },
  } };

test('new signal recovery retains canonical bytes, source coordinates and a strict native allowlist', async () => {
  const worker = harness(() => []);
  let called = 0;
  worker.context.LinearSignal = { async recover(input, options) {
    called++; assert.ok(options.timeBudgetMs > 0 && options.timeBudgetMs <= 700);
    await options.readNative(input, { formats: ['Code39'], returnErrors: true });
    assert.deepEqual(Array.from(worker.calls.at(-1).options.formats), ['EAN13', 'Code128']);
    assert.equal(worker.calls.at(-1).options.returnErrors, false);
    return { results: [signalResult], complete: true, passes: 1 };
  } };
  const result = await worker.send({ image: image() });
  assert.equal(called, 1); assert.equal(result.results[0].text, signalResult.text);
  assert.deepEqual(result.results[0].bytes, signalResult.bytes);
  assert.deepEqual(result.results[0].position, signalResult.position);
  assert.equal(result.diagnostics.signalComplete, true);
});

test('source recovery can finish before an expensive full-image enlargement consumes the deadline', async () => {
  let time = 0;
  const worker = harness(candidate => {
    if (candidate.width === 240 && candidate.height === 120) time = 2501;
    else time += 10;
    return [];
  }, { now: () => time });
  worker.context.LinearSignal = { recover: async () => ({ results: [signalResult], complete: true, passes: 1 }) };
  worker.context.QRSignal = { recover: async () => ({ results: [], complete: true, passes: 0 }) };
  const result = await worker.send({ image: image() });
  assert.equal(result.results[0].text, signalResult.text);
  assert.ok(time < 2500);
});

test('signal recovery cannot publish malformed or out-of-frame helper observations', async () => {
  for (const result of [{ ...signalResult, isValid: false }, { ...signalResult, error: 'checksum' },
    { ...signalResult, bytes: [256] }, { ...signalResult, position: { ...signalResult.position, topLeft: { x: -1, y: 0 } } },
    { ...signalResult, format: 'Code39' }]) {
    const worker = harness(() => []);
    worker.context.LinearSignal = { recover: async () => ({ results: [result], complete: true, passes: 0 }) };
    assert.deepEqual((await worker.send({ image: image() })).results, []);
  }
});

test('partial signal observations veto later recovery while observed conflicts remain visible', async () => {
  for (const conflict of [false, true]) {
    const worker = harness(() => []);
    worker.context.LinearSignal = { recover: async () => ({ results: conflict ? [signalResult,
      { ...signalResult, text: '4006381333931', bytes: Array.from('4006381333931', c => c.charCodeAt(0)) }] : [signalResult],
      complete: false, passes: 1 }) };
    worker.context.QRSignal = { recover: async () => {
      assert.equal(conflict, true, 'withheld unique evidence must stop later acceptance');
      return { results: [], complete: true, passes: 0 };
    } };
    const result = await worker.send({ image: image() });
    assert.equal(result.results.length, conflict ? 2 : 0);
    assert.equal(result.diagnostics.incompleteEvidence, !conflict);
  }
});

test('signal recovery checks its candidate pixel budget before calling a native decoder', async () => {
  const worker = harness(() => []);
  worker.context.LinearSignal = { async recover(_input, { readNative }) {
    await readNative({ width: 4_000_001, height: 1, data: new Uint8Array(4) });
  } };
  const result = await worker.send({ image: image() });
  assert.equal(result.type, 'error'); assert.match(result.message, /signal-recovery image/);
});

test('malformed neighbouring signal evidence and native overruns cannot leave an accepted singleton', async () => {
  const invalid = [
    { ...signalResult, bytes: [256] },
    { ...signalResult, position: { ...signalResult.position, topLeft: { x: -1, y: 0 } } },
    { ...signalResult, format: 'Code39' },
  ];
  for (const bad of invalid) {
    const worker = harness(() => []);
    worker.context.LinearSignal = { recover: async () => ({ results: [signalResult, bad], complete: true }) };
    const result = await worker.send({ image: image() });
    assert.deepEqual(result.results, []); assert.equal(result.diagnostics.incompleteEvidence, true);
  }
  let time = 0;
  const worker = harness(() => [], { now: () => time });
  worker.context.QRSignal = { recover: async () => {
    time = 2501;
    return { results: [{ ...signalResult, format: 'QRCode' }], complete: true };
  } };
  const result = await worker.send({ image: image() });
  assert.deepEqual(result.results, []); assert.equal(result.diagnostics.incompleteEvidence, true);
});

test('complete linear and QR recovery observations are both retained for ambiguity handling', async () => {
  const worker = harness(() => []);
  worker.context.LinearSignal = { recover: async () => ({ results: [signalResult], complete: true, passes: 1 }) };
  worker.context.QRSignal = { recover: async () => ({ results: [{ ...signalResult, format: 'QRCode', text: 'QR-B', bytes: [81, 82, 45, 66] }], complete: true, passes: 1 }) };
  const result = await worker.send({ image: image() });
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map(item => item.format), ['EAN13', 'QRCode']);
  assert.equal(result.diagnostics.incompleteEvidence, false);
});

test('a later incomplete or timed-out helper cannot leave an accepted unique signal result', async () => {
  for (const timeout of [false, true]) {
    let time = 0;
    const worker = harness(() => [], { now: () => time });
    worker.context.LinearSignal = { recover: async () => {
      if (timeout) time = 2501;
      return { results: [signalResult], complete: true, passes: 1 };
    } };
    worker.context.QRSignal = { recover: async () => {
      assert.equal(timeout, false, 'no native work should start after the deadline');
      return { results: [], complete: false, passes: 0 };
    } };
    const result = await worker.send({ image: image() });
    assert.deepEqual(result.results, []); assert.equal(result.diagnostics.incompleteEvidence, true);
  }
});

test('clean images return immediately without enhancement work', async () => {
  const worker = harness(() => [valid]);
  const result = await worker.send({ image: image() });
  assert.equal(result.results[0].text, 'verified');
  assert.equal(worker.calls.length, 1);
});

test('QR candidates use only the requested QR reader and retain exact raw bytes', async () => {
  const worker = harness((_image, _options, count) => count === 1 ? [] : [{ ...valid, format: 'QRCode', text: '\u00e9', bytes: [233] }]);
  worker.context.QRGeometry = { analyze: () => ({ complete: true, regions: [{}] }) };
  worker.context.QRRecovery = { *candidates(input) { yield { image: input, mapPoint: p => p, strategy: 'qr-grid-sample', options: { isPure: true } }; } };
  const result = await worker.send({ image: image() });
  assert.deepEqual(result.results[0].bytes, [233]); assert.equal(result.results[0].text, '\u00e9');
  assert.deepEqual(Array.from(worker.calls[1].options.formats), ['QRCode']);
  assert.equal(worker.calls[1].options.isPure, true);
});

test('an incomplete QR scan cannot forget a credible read and accept another retry alone', async () => {
  const worker = harness((_image, _options, count) => count === 1 ? [] : [{ ...valid, format: 'QRCode', text: count === 2 ? 'first' : 'second' }]);
  worker.context.QRGeometry = { analyze: () => ({ complete: false, regions: [{}] }) };
  worker.context.QRRecovery = { *candidates(input) { yield { image: input, mapPoint: p => p, strategy: 'qr-grid-sample' }; } };
  const result = await worker.send({ image: image() });
  assert.deepEqual(result.results, []); assert.equal(result.diagnostics.qrComplete, false);
  assert.equal(result.diagnostics.incompleteEvidence, true);
  assert.equal(worker.calls.length, 2, 'no later single value can hide the observed partial value');
});

test('an unreadable reliable QR proposal prevents publishing another region as a unique value', async () => {
  const worker = harness((_image, _options, count) => count === 2 ? [{ ...valid, format: 'QRCode', text: 'first' }] : []);
  worker.context.QRGeometry = { analyze: () => ({ complete: true, regions: [{}, {}] }) };
  worker.context.QRRecovery = { *candidates(input) { yield { image: input, mapPoint: p => p, strategy: 'qr-finder-crop' }; } };
  const reply = await worker.send({ image: image() });
  assert.deepEqual(reply.results, []); assert.equal(reply.diagnostics.incompleteEvidence, true);
  assert.equal(worker.calls.length, 3);
});

test('QR deadline truncation preserves multiple observed values but rejects a lone partial observation', async () => {
  for (const values of [['first'], ['first', 'second']]) {
    let now = 0;
    const worker = harness((_image, _options, count) => {
      if (count === 1) return [];
      now = 101; return values.map(text => ({ ...valid, format: 'QRCode', text }));
    }, { now: () => now });
    worker.context.QRGeometry = { analyze: () => ({ complete: true, regions: [{}, {}] }) };
    worker.context.QRRecovery = { *candidates(input) { yield { image: input, mapPoint: p => p, strategy: 'qr-finder-crop' }; } };
    const reply = await worker.send({ image: image(), mode: 'live' });
    assert.deepEqual(reply.results.map(item => item.text), values.length > 1 ? values : []);
    assert.equal(reply.diagnostics.qrComplete, false); assert.equal(worker.calls.length, 2);
  }
});

const box = (left, top, right, bottom) => ({ topLeft: { x: left, y: top }, topRight: { x: right, y: top },
  bottomRight: { x: right, y: bottom }, bottomLeft: { x: left, y: bottom } });
const code = (text, position, extra = {}) => ({ ...valid, text, bytes: Array.from(text, value => value.charCodeAt(0)), position, ...extra });

test('Code128 correction needs positive byte agreement and a uniquely comparable footprint', async () => {
  const original = code('WRONG', box(10, 10, 110, 50)), independent = code('RIGHT', box(0, 0, 120, 60), { gs1: false });
  const worker = harness(() => [original]);
  worker.context.IndependentReader.read = async () => ({ zbar: [independent], project: [independent], passes: 2, complete: true });
  const result = await worker.send({ image: image() });
  assert.deepEqual(result.results.map(value => value.text), ['RIGHT']);
  assert.equal(result.diagnostics.corrected, 1);
  assert.equal(result.results[0].gs1, undefined, 'internal project metadata stays internal');
});

test('an outer Code128 footprint cannot erase independently reproduced nested labels', async () => {
  const outer = code('OUTER', box(0, 0, 120, 60)), inner = code('INNER', box(25, 20, 85, 40));
  const worker = harness(() => [outer, inner]);
  worker.context.IndependentReader.read = async () => ({ zbar: [outer, inner], project: [{ ...outer, gs1: false }], passes: 2, complete: true });
  const result = await worker.send({ image: image() });
  assert.deepEqual(result.results.map(value => value.text).sort(), ['INNER', 'OUTER']);
  assert.equal(result.diagnostics.corrected, undefined);
});

test('corroboration preserves native positions for separate copies of the same payload', async () => {
  const first = code('SAME', box(0, 0, 120, 60)), second = code('SAME', box(160, 0, 280, 60));
  const worker = harness(() => [first, second]);
  worker.context.IndependentReader.read = async () => ({ zbar: [first, second], project: [{ ...first, gs1: false }], passes: 2, complete: true });
  const reply = await worker.send({ image: image(300, 70) });
  assert.equal(reply.results.length, 2);
  assert.deepEqual(reply.results.map(item => item.position), [first.position, second.position]);
});

test('project Code128 disagreement and genuine separate labels remain ambiguous', async () => {
  const original = code('FIRST', box(10, 10, 110, 50));
  for (const position of [box(0, 0, 120, 60), box(160, 0, 280, 60)]) {
    const other = code('SECOND', position, { gs1: false }), worker = harness(() => [original]);
    worker.context.IndependentReader.read = async () => ({ zbar: [], project: [other], passes: 2, complete: true });
    const result = await worker.send({ image: image(300, 70) });
    assert.deepEqual(result.results.map(value => value.text).sort(), ['FIRST', 'SECOND']);
  }
});

test('incomplete optional checking preserves native extended bytes and presentation', async () => {
  const original = code('A<NUL><GS>é', box(10, 10, 110, 50), { bytes: [65, 0, 29, 233] });
  const worker = harness(() => [original]);
  worker.context.IndependentReader.read = async () => ({ zbar: [], project: [], passes: 1, complete: false });
  const result = await worker.send({ image: image() });
  assert.equal(result.results[0].text, original.text);
  assert.deepEqual(result.results[0].bytes, original.bytes);
  assert.equal(result.diagnostics.strategy, 'independent-incomplete');
});

test('independent initialization failure cannot silently disable the advertised guard', async () => {
  const worker = harness(() => [valid]);
  worker.context.IndependentReader.initialize = async () => { throw new Error('Independent WASM unavailable'); };
  const reply = await worker.send({ type: 'init' });
  assert.equal(reply.type, 'error');
  assert.match(reply.message, /Independent WASM unavailable/);
  assert.equal(worker.calls.length, 0);
});

test('an optional per-image checker error preserves valid original evidence', async () => {
  const original = code('NATIVE', box(10, 10, 110, 50)), worker = harness(() => [original]);
  worker.context.IndependentReader.read = async () => { throw new Error('Per-image checker failed'); };
  const reply = await worker.send({ image: image() });
  assert.equal(reply.type, 'result');
  assert.deepEqual(reply.results.map(item => item.text), ['NATIVE']);
  assert.equal(reply.diagnostics.independentError, true);
});

test('unverified independent Code128 blocks a unique fallback and preserves the remaining native retry budget', async () => {
  const worker = harness(() => []);
  const ean = code('7512429728388', box(2, 2, 118, 58), { format: 'EAN13' });
  worker.context.IndependentReader.read = async (_image, options) => {
    assert.ok(options.timeBudgetMs <= 120, 'leave live time for the original recovery path');
    return { zbar: [ean, code('UNTRUSTED', box(2, 2, 118, 58))], project: [], passes: 1, complete: true };
  };
  const reply = await worker.send({ image: verticalBars(), mode: 'live' });
  assert.deepEqual(reply.results, []);
  assert.equal(worker.calls.length, 2, 'the original live fallback still runs');
  worker.context.IndependentReader.read = async () => ({ zbar: [ean], project: [], passes: 1, complete: true });
  const unopposed = await worker.send({ image: verticalBars(), mode: 'live' });
  assert.deepEqual(unopposed.results.map(item => item.text), [ean.text], 'the same source-supported EAN is available when no unverified competing label was observed');
});

test('independent linear fallback still requires coherent source bars and valid bytes/geometry', async () => {
  const candidate = code('7512429728388', box(2, 2, 118, 58), { format: 'EAN13' });
  for (const [input, value] of [[image(), candidate], [verticalBars(), { ...candidate, bytes: [-1] }],
    [verticalBars(), { ...candidate, position: box(-5, 2, 118, 58) }]]) {
    const worker = harness(() => []);
    worker.context.IndependentReader.read = async () => ({ zbar: [value], project: [], passes: 1, complete: true });
    const reply = await worker.send({ image: input, mode: 'live' });
    assert.deepEqual(reply.results, []);
  }
});

test('an invalid/error result cannot short-circuit retries or reach the app', async () => {
  const worker = harness(() => [{ ...valid, isValid: false }, { ...valid, error: 'ChecksumError' }, { ...valid, isValid: undefined }]);
  const result = await worker.send({ image: image(), mode: 'live' });
  assert.deepEqual(result.results, []);
  assert.equal(worker.calls.length, 2, 'live work is bounded to original plus one retry');
  for (const { options } of worker.calls) {
    assert.equal(options.returnErrors, false);
    assert.equal(options.isPure, false);
    assert.ok(options.minLineCount >= 2);
  }
});

test('empty still images use a finite retry budget', async () => {
  const worker = harness(() => []);
  await worker.send({ image: image(), mode: 'image' });
  assert.ok(worker.calls.length <= 8, 'at most one primary and seven recovery attempts');
});

test('QR denoising is one bounded live retry and rejects non-QR output', async () => {
  const worker = harness((_image, _options, call) => call === 1 ? [] : [valid]);
  const result = await worker.send({ image: image(), mode: 'live', retryIndex: 6 });
  assert.equal(worker.calls.length, 2);
  assert.equal(worker.calls[1].options.tryDenoise, true);
  assert.equal(worker.calls[1].options.isPure, false);
  assert.deepEqual(Array.from(worker.calls[1].options.formats), ['QRCode', 'MicroQRCode', 'RMQRCode']);
  assert.deepEqual(result.results, [], 'a native response outside the QR recovery family must not escape');
});

test('sharpening tiny flat frames preserves dimensions and introduces no edge contrast', async () => {
  for (const [width, height] of [[1, 1], [2, 1], [1, 2], [3, 3]]) {
    const input = image(width, height), pixels = new Uint8ClampedArray(input.data);
    for (let i = 0; i < pixels.length; i += 4) pixels[i] = pixels[i + 1] = pixels[i + 2] = 127;
    const worker = harness((candidate, options, call) => {
      assert.equal(candidate.width, width); assert.equal(candidate.height, height);
      if (call === 2) assert.deepEqual(Array.from(candidate.data), Array.from(pixels));
      return [];
    });
    const result = await worker.send({ image: input, mode: 'live', retryIndex: 1 });
    assert.equal(worker.calls.length, 2);
    assert.deepEqual(result.results, []);
  }
});

test('elapsed live and image deadlines prevent starting additional recovery passes', async () => {
  for (const [mode, budget] of [['live', 350], ['image', 2500]]) {
    let now = 0;
    const worker = harness(() => { now += budget + 1; return []; }, { now: () => now });
    const result = await worker.send({ image: verticalBars(), mode, retryIndex: 2 });
    assert.deepEqual(result.results, []);
    assert.equal(worker.calls.length, 1, `${mode} recovery is skipped after the original pass exhausts its budget`);
    assert.deepEqual(result.diagnostics, { passes: 1, strategy: 'original' });
  }
});

test('rotated results map precisely back to the supplied image coordinates', async () => {
  const width = 120, height = 60;
  const points = { topLeft: { x: 20, y: 15 }, topRight: { x: 100, y: 15 }, bottomRight: { x: 100, y: 45 }, bottomLeft: { x: 20, y: 45 } };
  const worker = harness((candidate, options, call) => {
    if (call === 1) return [];
    const c = Math.SQRT1_2;
    const position = Object.fromEntries(Object.entries(points).map(([key, { x, y }]) => {
      const dx = x - (width - 1) / 2, dy = y - (height - 1) / 2;
      return [key, { x: c * dx - c * dy + (candidate.width - 1) / 2, y: c * dx + c * dy + (candidate.height - 1) / 2 }];
    }));
    return [{ ...valid, position }];
  });
  const result = await worker.send({ image: verticalBars(width, height), mode: 'live', retryIndex: 2 });
  for (const [key, point] of Object.entries(result.results[0].position)) {
    assert.ok(Math.abs(point.x - points[key].x) < 1e-9);
    assert.ok(Math.abs(point.y - points[key].y) < 1e-9);
  }
});

test('missing or invalid buffers and scanning modes fail without decoding', async () => {
  for (const request of [ { image: null }, { image: { width: 4, height: 4, data: { byteLength: 64 } } }, { image: image(), mode: 'unknown' } ]) {
    const worker = harness(() => [valid]);
    const result = await worker.send(request);
    assert.equal(result.type, 'error');
    assert.equal(worker.calls.length, 0);
  }
});

test('unchecked formats remain available on the original pass only', async () => {
  for (const format of ['ITF', 'Code39', 'Codabar']) {
    const unchecked = { ...valid, format };
    const original = harness(() => [unchecked]);
    assert.equal((await original.send({ image: image() })).results[0].format, format);
    assert.equal(original.calls.length, 1);
    const recovery = harness((candidate, options, call) => call === 1 ? [] : [unchecked]);
    const result = await recovery.send({ image: image(), mode: 'image' });
    assert.deepEqual(result.results, [], 'result filtering must work even if the decoder ignores its format option');
    for (const { options } of recovery.calls.slice(1)) {
      assert.ok(options.tryDenoise ? options.formats.every(format => ['QRCode', 'MicroQRCode', 'RMQRCode'].includes(format)) : options.formats.includes('Code128'));
      assert.ok(!options.formats.includes(format));
    }
  }
});

test('upscaled corners return to the original pixel centers', async () => {
  const points = { topLeft: { x: 12.25, y: 8.5 }, topRight: { x: 90.75, y: 8.5 }, bottomRight: { x: 90.75, y: 51.25 }, bottomLeft: { x: 12.25, y: 51.25 } };
  const worker = harness((candidate, options, call) => {
    if (call === 1) return [];
    assert.equal(candidate.width, 240); assert.equal(candidate.height, 120);
    const position = Object.fromEntries(Object.entries(points).map(([key, { x, y }]) =>
      [key, { x: 2 * x + 0.5, y: 2 * y + 0.5 }]));
    return [{ ...valid, position }];
  });
  const result = await worker.send({ image: verticalBars(), mode: 'live', retryIndex: 5 });
  assert.equal(result.diagnostics.strategy, 'upscale');
  assert.deepEqual(result.results[0].position, points);
  assert.equal(worker.calls.length, 2);
});

test('gradient-selected deskew maps corners back without changing their origin', async () => {
  const width = 80, height = 40, input = image(width, height), pixels = new Uint8ClampedArray(input.data);
  // Equal positive x and negative y gradients give an independently known -45 degree direction.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 120 + x - y;
  }
  const points = { topLeft: { x: 20, y: 25 }, topRight: { x: 40, y: 5 }, bottomRight: { x: 45, y: 10 }, bottomLeft: { x: 25, y: 30 } };
  const worker = harness((candidate, options, call) => {
    if (call === 1) return [];
    const position = Object.fromEntries(Object.entries(points).map(([key, { x, y }]) => {
      const dx = x - (width - 1) / 2, dy = y - (height - 1) / 2;
      return [key, { x: Math.SQRT1_2 * (dx - dy) + (candidate.width - 1) / 2,
        y: Math.SQRT1_2 * (dx + dy) + (candidate.height - 1) / 2 }];
    }));
    return [{ ...valid, position }];
  });
  const result = await worker.send({ image: input, mode: 'live', retryIndex: 4 });
  assert.equal(result.diagnostics.strategy, 'local-contrast-deskew');
  for (const [key, point] of Object.entries(result.results[0].position)) {
    assert.ok(Math.abs(point.x - points[key].x) < 1e-9);
    assert.ok(Math.abs(point.y - points[key].y) < 1e-9);
  }
});

test('upscaling skips inputs that would exceed four million output pixels', async () => {
  const worker = harness(() => []);
  const result = await worker.send({ image: image(1001, 1000), mode: 'live', retryIndex: 5 });
  assert.deepEqual(result.results, []);
  assert.equal(worker.calls.length, 1);
});

test('large rotated candidates remain under the worker pixel limit', async () => {
  const worker = harness((candidate) => {
    assert.ok(candidate.width * candidate.height <= 4_000_000);
    return [];
  });
  const result = await worker.send({ image: image(2000, 1900), mode: 'live', retryIndex: 2 });
  assert.deepEqual(result.results, []);
  assert.equal(worker.calls.length, 2);
});

test('linear recovery requires coherent source bars aligned with its scanline', async () => {
  const diagonal = { topLeft: { x: 20, y: 10 }, topRight: { x: 60, y: 50 }, bottomRight: { x: 65, y: 50 }, bottomLeft: { x: 25, y: 10 } };
  const horizontal = { topLeft: { x: 20, y: 10 }, topRight: { x: 100, y: 10 }, bottomRight: { x: 100, y: 50 }, bottomLeft: { x: 20, y: 50 } };
  const read = (position, format = 'Code128') => (candidate, options, call) => call === 1 ? [] : [{ ...valid, format, position }];
  const mismatched = harness(read(diagonal));
  assert.deepEqual((await mismatched.send({ image: verticalBars(), mode: 'live' })).results, []);
  const featureless = harness(read(horizontal));
  assert.deepEqual((await featureless.send({ image: image(), mode: 'live' })).results, []);
  const missing = harness(read(undefined));
  assert.deepEqual((await missing.send({ image: verticalBars(), mode: 'live' })).results, []);
  const matrix = harness(read(diagonal, 'QRCode'));
  assert.equal((await matrix.send({ image: image(), mode: 'live' })).results[0].format, 'QRCode');
  const original = harness(() => [{ ...valid, position: diagonal }]);
  assert.equal((await original.send({ image: verticalBars(), mode: 'live' })).results[0].format, 'Code128');
});

function retailOverlap() {
  const input = image(), pixels = new Uint8ClampedArray(input.data);
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
    const offset = (y * input.width + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = Math.floor((x + y) / 6) % 2 ? 0 : 255;
  }
  const box = (left, top, right, bottom) => ({ topLeft: { x: left, y: top }, topRight: { x: right, y: top },
    bottomRight: { x: right, y: bottom }, bottomLeft: { x: left, y: bottom } });
  const upce = { ...valid, format: 'UPCE', text: 'upce', bytes: new Uint8Array([1]), position: box(30, 29, 90, 31) };
  const ean = { ...valid, format: 'EAN13', text: 'ean', bytes: new Uint8Array([2]), position: box(20, 10, 100, 50) };
  const transformed = (record, candidate) => ({ ...record, position: Object.fromEntries(Object.entries(record.position).map(([key, point]) => {
    const x = point.x - (input.width - 1) / 2, y = point.y - (input.height - 1) / 2, c = Math.SQRT1_2;
    return [key, { x: c * (x + y) + (candidate.width - 1) / 2, y: c * (-x + y) + (candidate.height - 1) / 2 }];
  })) });
  return { input, box, upce, ean, transformed };
}

test('retail corroboration only removes an unreproduced UPC-E inside an exactly reproduced EAN footprint', async () => {
  const { input, upce, ean, transformed } = retailOverlap();
  const worker = harness((candidate, options, call) => call === 1 ? [upce, ean] : [
    transformed(ean, candidate), { ...valid, format: 'QRCode', text: 'new candidate' },
  ]);
  const response = await worker.send({ image: input, mode: 'live' });
  assert.deepEqual(response.results.map(value => value.text), ['ean']);
  assert.equal(worker.calls.length, 2);
  assert.deepEqual(worker.calls[1].options, worker.calls[0].options, 'never broaden or narrow the original native request');
  assert.equal(response.diagnostics.strategy, 'retail-corroboration');
  assert.ok(worker.calls[1].image.width * worker.calls[1].image.height <= 4_000_000);
  assert.deepEqual(response.results[0].position, ean.position, 'retain original coordinates for surviving results');
});

test('uncertain retail corroboration preserves original evidence and genuine separate labels', async () => {
  for (const scenario of ['no-check', 'repeat-upce', 'different-bytes', 'separate-label', 'degenerate', 'exception']) {
    const { input, box, upce, ean, transformed } = retailOverlap();
    const worker = harness((candidate, options, call) => {
      if (call === 1) return [upce, ean];
      if (scenario === 'exception') throw new Error('optional reread failed');
      if (scenario === 'no-check') return [];
      if (scenario === 'repeat-upce') return [transformed(ean, candidate), transformed(upce, candidate)];
      const check = scenario === 'different-bytes' ? { ...ean, bytes: new Uint8Array([3]) } :
        scenario === 'separate-label' ? { ...ean, position: box(0, 0, 15, 15) } :
          { ...ean, position: box(20, 30, 100, 30) };
      return [transformed(check, candidate)];
    });
    const response = await worker.send({ image: input, mode: 'live' });
    assert.equal(response.type, 'result', scenario);
    assert.deepEqual(response.results.map(value => value.text), ['upce', 'ean'], scenario);
    assert.equal(worker.calls.length, 2, scenario);
  }
});

test('retail corroboration skips lone UPC-E, featureless or invalid geometry, and exhausted deadlines', async () => {
  for (const scenario of ['upce-alone', 'flat', 'missing-position', 'deadline']) {
    const { input, upce, ean } = retailOverlap();
    let now = 0;
    const original = scenario === 'upce-alone' ? [upce] : scenario === 'missing-position' ? [{ ...upce, position: undefined }, ean] : [upce, ean];
    const worker = harness(() => { if (scenario === 'deadline') now = 350; return original; }, { now: () => now });
    const response = await worker.send({ image: scenario === 'flat' ? image() : input, mode: 'live' });
    assert.deepEqual(response.results.map(value => value.text), original.map(value => value.text), scenario);
    assert.equal(worker.calls.length, 1, scenario);
  }
});
