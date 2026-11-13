import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { FORMATS, DEFAULT_OPTIONS, canonicalFormat, validateOptions, nativeFormats, keyFor, createConfirmation } = require('../web/pos-policy.js');
const qr = { format: 'QRCode', text: 'ITEM-A', bytes: [73, 84, 69, 77, 45, 65] };
const other = { ...qr, text: 'ITEM-B', bytes: [73, 84, 69, 77, 45, 66] };
const observe = (policy, results, frame = 1, now = frame * 100, pixel = `pixels-${frame}`) =>
  policy.observe(results, frame, now, pixel);

test('POS policy loads as a local browser global without a module loader', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../web/pos-policy.js', import.meta.url), 'utf8'), context);
  assert.equal(context.PosPolicy.canonicalFormat('QRCode'), 'qr');
});

test('default options are immutable, independent, and map to native decoder formats', () => {
  assert.deepEqual(DEFAULT_OPTIONS.allowedFormats, ['ean13', 'upca', 'code128', 'qr']);
  const first = validateOptions(), second = validateOptions();
  first.allowedFormats.pop();
  assert.equal(second.allowedFormats.length, 4);
  assert.equal(DEFAULT_OPTIONS.allowedFormats.length, 4);
  assert.deepEqual(nativeFormats(), ['EAN13', 'UPCA', 'Code128', 'QRCode']);
  assert.deepEqual(nativeFormats({ allowedFormats: ['qr', 'code93'], confirmationFrames: 3 }), ['QRCode', 'Code93']);
  assert.equal(Object.keys(FORMATS).length, 10);
});

for (const options of [null, [], true, new Date(), { extra: true }, { allowedFormats: [] },
  { allowedFormats: ['qr', 'qr'] }, { allowedFormats: ['QR'] }, { allowedFormats: ['Code39'] },
  { allowedFormats: 'qr' }, { allowedFormats: [1] }, { allowedFormats: undefined },
  { confirmationFrames: 0 }, { confirmationFrames: 4 }, { confirmationFrames: 1.5 },
  { confirmationFrames: '2' }, { confirmationFrames: true }, { confirmationFrames: undefined }]) {
  test(`invalid POS options fail closed: ${JSON.stringify(options)}`, () => {
    assert.throws(() => validateOptions(options));
    assert.throws(() => nativeFormats(options));
    assert.throws(() => createConfirmation(options));
  });
}

test('native family aliases are recognized without merging retail identifier families', () => {
  for (const native of ['qr', 'QRCode', 'QR Code', 'QRCodeModel1', 'QRCodeModel2', 'BarcodeFormat.QRCode']) assert.equal(canonicalFormat(native), 'qr');
  assert.equal(canonicalFormat('EAN-13'), 'ean13');
  assert.equal(canonicalFormat('UPC_A'), 'upca');
  assert.equal(canonicalFormat('UPC E'), 'upce');
  assert.equal(canonicalFormat('AztecCode'), 'aztec');
  assert.equal(canonicalFormat('CompactPDF417'), 'pdf417');
  for (const name of ['MicroQRCode', 'RMQRCode', 'MicroPDF417', 'Code39', 'constructor', 'toString', null, 1]) assert.equal(canonicalFormat(name), null);
});

test('one frame only confirms when the option explicitly selects one', () => {
  const pending = observe(createConfirmation(), [qr], 0, 0);
  assert.equal(pending.status, 'rescan');
  assert.equal(pending.reason, 'insufficient_confirmation');
  assert.deepEqual(pending.results, []);
  assert.equal(pending.matchedFrames, 1);
  const accepted = observe(createConfirmation({ confirmationFrames: 1 }), [qr], 0, 0);
  assert.equal(accepted.status, 'confirmed');
  assert.equal(accepted.reason, 'single_match');
  assert.deepEqual(accepted.results, [qr]);
});

test('two or three distinct matching images meet only the configured threshold', () => {
  for (const required of [2, 3]) {
    const policy = createConfirmation({ confirmationFrames: required });
    for (let frame = 1; frame <= required; frame++) {
      const result = observe(policy, [qr], frame);
      assert.equal(result.status, frame === required ? 'confirmed' : 'rescan');
      assert.equal(result.matchedFrames, frame);
      assert.equal(result.requiredFrames, required);
    }
  }
});

test('duplicate detections, frame IDs and pixel identities add no extra evidence', () => {
  const policy = createConfirmation();
  assert.equal(observe(policy, [qr, qr, qr], 1, 0, 'same').matchedFrames, 1);
  assert.equal(observe(policy, [qr], 1, 100, 'different').matchedFrames, 1);
  assert.equal(observe(policy, [qr], 2, 200, 'same').matchedFrames, 1);
  assert.equal(observe(policy, [qr], 3, 300, 'different').matchedFrames, 1);
  const accepted = observe(policy, [qr], 4, 400, 'actually-new');
  assert.equal(accepted.status, 'confirmed');
  assert.deepEqual(accepted.candidates[0].frameIds, [1, 4]);
});

test('blank frames retain agreement but can never return a confirmed old result', () => {
  const policy = createConfirmation();
  observe(policy, [qr], 1, 0);
  assert.equal(observe(policy, [], 2, 100).reason, 'no_code');
  assert.equal(observe(policy, [qr], 3, 200).status, 'confirmed');
  const blank = observe(policy, [], 4, 300);
  assert.equal(blank.status, 'rescan');
  assert.equal(blank.reason, 'no_code');
  assert.equal(blank.matchedFrames, 2);
  assert.deepEqual(blank.results, []);
});

test('conflicting values latch ambiguity even when one has a majority', () => {
  const policy = createConfirmation();
  observe(policy, [qr], 1, 0);
  assert.equal(observe(policy, [other], 2, 100).status, 'ambiguous');
  for (let frame = 3; frame <= 6; frame++) {
    const result = observe(policy, [qr], frame, frame * 100);
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.reason, 'conflicting_values');
    assert.deepEqual(result.results, []);
  }
});

test('two values in one image are ambiguous even with single-frame acceptance enabled', () => {
  const result = observe(createConfirmation({ confirmationFrames: 1 }), [qr, other]);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.results, []);
});

test('a different decode from duplicate pixels is still a conflict, never another vote', () => {
  const policy = createConfirmation();
  observe(policy, [qr], 1, 0, 'identical-image');
  const conflict = observe(policy, [other], 2, 100, 'identical-image');
  assert.equal(conflict.status, 'ambiguous');
  assert.deepEqual(conflict.candidates.map(value => value.frameIds), [[1], []]);
});

test('only allowed formats contribute candidates and agreement', () => {
  const policy = createConfirmation({ allowedFormats: ['code128'] });
  const code128 = { ...qr, format: 'Code128' };
  assert.equal(observe(policy, [qr], 1, 0).reason, 'no_code');
  assert.equal(observe(policy, [qr, code128], 2, 100).matchedFrames, 1);
  assert.equal(observe(policy, [qr, code128], 3, 200).status, 'confirmed');
});

test('equal text with different payloads or formats cannot combine into confirmation', () => {
  for (const candidate of [{ ...qr, bytes: [1, 2] }, { ...qr, format: 'Code128' }]) {
    const policy = createConfirmation();
    assert.notEqual(keyFor(qr), keyFor(candidate));
    observe(policy, [qr], 1, 0);
    assert.equal(observe(policy, [candidate], 2, 100).status, 'ambiguous');
  }
});

test('QR ECI text disagreement is ambiguous even when the native bytes are identical', () => {
  // ECI 3 (ISO-8859-1) and ECI 26 (UTF-8) interpretations of C3 A4.
  const latin1 = { format: 'QRCode', bytes: [0xc3, 0xa4], text: '\u00c3\u00a4' };
  const utf8 = { ...latin1, bytes: new Uint8Array(latin1.bytes), text: '\u00e4' };
  assert.notEqual(keyFor(latin1), keyFor(utf8));
  const policy = createConfirmation();
  observe(policy, [latin1], 1, 0);
  assert.equal(observe(policy, [utf8], 2, 100).status, 'ambiguous');
  assert.notEqual(keyFor(qr), keyFor({ ...qr, text: `${qr.text} ` }));
});

test('UPC-A, EAN-13 and UPC-E values remain distinct without stripping zeros', () => {
  const bytes = Array.from(new TextEncoder().encode('0036000291452'));
  const ean = { format: 'EAN13', text: '0036000291452', bytes };
  const upc = { ...ean, format: 'UPCA' };
  assert.notEqual(keyFor(ean), keyFor(upc));
  assert.equal(observe(createConfirmation(), [ean, upc]).status, 'ambiguous');
});

test('equivalent native family spelling preserves exact raw and text identity', () => {
  assert.equal(keyFor(qr), keyFor({ ...qr, format: 'QRCodeModel2', bytes: new Uint8ClampedArray(qr.bytes) }));
  const policy = createConfirmation();
  observe(policy, [qr], 1, 0);
  assert.equal(observe(policy, [{ ...qr, format: 'qr' }], 2, 100).status, 'confirmed');
});

test('conflict expiry resets the whole attempt together, never individual candidates', () => {
  const policy = createConfirmation();
  observe(policy, [other], 1, 0);
  observe(policy, [qr], 2, 100);
  assert.equal(observe(policy, [qr], 3, 2499).status, 'ambiguous');
  const expired = observe(policy, [qr], 4, 2500);
  assert.equal(expired.status, 'rescan');
  assert.equal(expired.matchedFrames, 1);
  assert.equal(expired.candidates.length, 1);
  assert.equal(observe(policy, [qr], 5, 2600).status, 'confirmed');
});

test('an explicit new scan resets evidence, conflicts and camera timing', () => {
  const policy = createConfirmation();
  observe(policy, [qr, other], 1, 500);
  policy.reset();
  assert.equal(observe(policy, [qr], 1, 0, 'first').status, 'rescan');
  assert.equal(observe(policy, [qr], 2, 100, 'second').status, 'confirmed');
});

test('backwards, repeated and invalid timestamps cannot add evidence or clear a conflict', () => {
  const policy = createConfirmation();
  observe(policy, [qr], 1, 100);
  for (const now of [99, 100, -1, NaN, Infinity]) {
    const result = observe(policy, [qr], 2, now, 'second');
    assert.equal(result.status, 'rescan');
    assert.equal(result.reason, 'unreliable_frames');
    assert.equal(result.matchedFrames, 1);
  }
  assert.equal(observe(policy, [other], 3, 200).status, 'ambiguous');
  assert.equal(observe(policy, [qr], 4, 150).status, 'ambiguous');
});

test('unreliable playback clocks cannot confirm across frames but allow explicit single-frame mode', () => {
  for (const required of [2, 3]) {
    const policy = createConfirmation({ confirmationFrames: required });
    for (let frame = 1; frame <= 4; frame++) {
      const result = observe(policy, [qr], `clock:${frame}`, frame * 100);
      assert.equal(result.reason, 'unreliable_frames');
      assert.equal(result.matchedFrames, 0);
      assert.deepEqual(result.results, []);
    }
  }
  assert.equal(observe(createConfirmation({ confirmationFrames: 1 }), [qr], 'clock:0', 0).status, 'confirmed');
});

test('missing or malformed frame/pixel identities cannot confirm even in single-frame mode', () => {
  for (const frameId of [null, undefined, -1, NaN, {}, '', 'clock:NaN', 'presented:nope', 'decoded:']) {
    const result = createConfirmation({ confirmationFrames: 1 }).observe([qr], frameId, 0, 'pixels');
    assert.equal(result.status, 'rescan');
    assert.equal(result.reason, 'unreliable_frames');
  }
  for (const pixels of [null, undefined, '', 42, 'x'.repeat(257)]) {
    const result = createConfirmation({ confirmationFrames: 1 }).observe([qr], 1, 0, pixels);
    assert.equal(result.status, 'rescan');
    assert.equal(result.reason, 'unreliable_frames');
  }
});

test('a conflict seen with an unreliable frame ID still prevents accepting the other value', () => {
  const policy = createConfirmation();
  observe(policy, [qr], 1, 0);
  assert.equal(observe(policy, [other], 'clock:1', 100).status, 'ambiguous');
  assert.equal(observe(policy, [qr], 2, 200).status, 'ambiguous');
});

test('malformed allowed results never become accepted fallback text identities', () => {
  for (const malformed of [
    { ...qr, bytes: undefined }, { ...qr, bytes: [] }, { ...qr, bytes: [256] },
    { ...qr, bytes: [-1] }, { ...qr, bytes: [1.5] }, { ...qr, bytes: ['1'] },
    { ...qr, bytes: new DataView(new ArrayBuffer(1)) }, { ...qr, text: 123 },
    { ...qr, isValid: false }, { ...qr, error: 'ChecksumError' },
  ]) {
    assert.equal(keyFor(malformed), null);
    const policy = createConfirmation({ confirmationFrames: 1 });
    const result = observe(policy, [qr, malformed], 1, 0);
    assert.equal(result.status, 'rescan');
    assert.deepEqual(result.results, []);
    assert.equal(observe(policy, [qr], 2, 100).status, 'rescan', 'malformed attempt needs expiry or explicit reset');
  }
});

test('candidate and observation limits fail closed with bounded state', () => {
  const policy = createConfirmation();
  const many = Array.from({ length: 80 }, (_, index) => ({ ...qr, bytes: [index], text: String(index) }));
  const conflict = observe(policy, many, 1, 0);
  assert.equal(conflict.status, 'ambiguous');
  assert.equal(conflict.candidates.length, 48);
  const saturated = createConfirmation();
  for (let frame = 0; frame < 256; frame++) observe(saturated, [], frame, frame);
  const overflow = observe(saturated, [qr], 256, 256);
  assert.equal(overflow.status, 'rescan');
  assert.equal(overflow.matchedFrames, 0);
  assert.equal(observe(saturated, [qr], 257, 257).status, 'rescan');
});

test('returned candidates, payloads and positions cannot mutate confirmation state', () => {
  const positioned = { ...qr, position: { topLeft: { x: 1, y: 2 }, topRight: { x: 10, y: 2 },
    bottomRight: { x: 10, y: 20 }, bottomLeft: { x: 1, y: 20 } } };
  const policy = createConfirmation();
  const first = observe(policy, [positioned], 1, 0);
  first.candidates[0].frameIds.push(900);
  first.candidates[0].result.bytes[0] = 0;
  first.candidates[0].result.position.topLeft.x = 999;
  const second = observe(policy, [positioned], 2, 100);
  assert.equal(second.status, 'confirmed');
  assert.equal(second.matchedFrames, 2);
  assert.equal(second.results[0].bytes[0], qr.bytes[0]);
  assert.equal(second.results[0].position.topLeft.x, 1);
  assert.deepEqual(second.candidates[0].frameIds, [1, 2]);
});

test('camera evidence requires both decoder pixels and stable camera pixels to be new', () => {
  const policy = createConfirmation();
  const sample = (frame, decoder, camera) => policy.observe([qr], frame, frame * 100, decoder, camera);
  assert.equal(sample(1, 'decoder-a', 'camera-a').matchedFrames, 1);
  assert.equal(sample(2, 'decoder-b', 'camera-a').matchedFrames, 1, 'resizing frozen camera pixels adds no vote');
  assert.equal(sample(3, 'decoder-b', 'camera-b').matchedFrames, 1, 'a new camera fingerprint cannot excuse repeated decoder pixels');
  assert.equal(sample(4, 'decoder-c', 'camera-b').matchedFrames, 1, 'nonvoting frames still reserve their pixel identities');
  const accepted = sample(5, 'decoder-d', 'camera-d');
  assert.equal(accepted.status, 'confirmed');
  assert.deepEqual(accepted.candidates[0].frameIds, [1, 5]);
});

test('a supplied malformed camera fingerprint cannot confirm even in single-frame mode', () => {
  for (const identity of [null, '', 42, false, {}, [], 'x'.repeat(257)]) {
    const policy = createConfirmation({ confirmationFrames: 1 });
    const result = policy.observe([qr], 1, 100, 'valid-decoder-pixels', identity);
    assert.equal(result.status, 'rescan');
    assert.equal(result.reason, 'unreliable_frames');
    assert.equal(result.matchedFrames, 0);
    assert.deepEqual(result.results, []);
  }
});

test('duplicate or malformed camera evidence still records a conflicting barcode identity', () => {
  for (const secondCamera of ['camera-a', null, '']) {
    const policy = createConfirmation();
    policy.observe([qr], 1, 100, 'decoder-a', 'camera-a');
    const conflict = policy.observe([other], 2, 200, 'decoder-b', secondCamera);
    assert.equal(conflict.status, 'ambiguous');
    assert.deepEqual(conflict.candidates.map(value => value.frameIds), [[1], []]);
    const repeated = policy.observe([qr], 3, 300, 'decoder-c', 'camera-c');
    assert.equal(repeated.status, 'ambiguous', 'new camera pixels cannot silently erase a previous conflict');
    assert.deepEqual(repeated.results, []);
  }
});

test('reset clears camera fingerprints together with votes and conflicts', () => {
  const policy = createConfirmation();
  policy.observe([qr, other], 1, 100, 'decoder-a', 'camera-a');
  policy.reset();
  const first = policy.observe([qr], 1, 0, 'decoder-a', 'camera-a');
  assert.equal(first.status, 'rescan');
  assert.equal(first.matchedFrames, 1);
  assert.equal(first.candidates.length, 1);
  assert.equal(policy.observe([qr], 2, 100, 'decoder-b', 'camera-a').matchedFrames, 1);
  assert.equal(policy.observe([qr], 3, 200, 'decoder-c', 'camera-c').status, 'confirmed');
});

test('attempt expiry clears camera fingerprints without retaining an old vote', () => {
  const policy = createConfirmation();
  policy.observe([qr, other], 1, 0, 'decoder-a', 'camera-a');
  const expired = policy.observe([qr], 2, 2500, 'decoder-a', 'camera-a');
  assert.equal(expired.status, 'rescan');
  assert.equal(expired.matchedFrames, 1);
  assert.equal(expired.candidates.length, 1);
  assert.equal(policy.observe([qr], 3, 2600, 'decoder-b', 'camera-b').status, 'confirmed');
});

test('noncamera callers may omit the additional camera fingerprint', () => {
  const policy = createConfirmation();
  assert.equal(policy.observe([qr], 1, 100, 'decoder-a').matchedFrames, 1);
  assert.equal(policy.observe([qr], 2, 200, 'decoder-b', undefined).status, 'confirmed');
});
