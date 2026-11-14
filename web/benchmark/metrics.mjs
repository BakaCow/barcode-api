// Strict local report contract. No images, credentials, URLs or device fingerprints.
export const SCHEMA = 'barcode-comparison/v1';
export const FORMATS = ['ean13', 'upca', 'code128', 'qr', 'ean8', 'upce', 'datamatrix', 'aztec', 'pdf417', 'code93'];
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
const finite = (value, maximum = 1e9) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
function keys(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !allowed.includes(key))) throw new Error('Unexpected report fields.');
}
function fail(message) { throw new Error(message); }
export function identity(value) {
  keys(value, ['format', 'text']);
  if (!FORMATS.includes(value.format) || typeof value.text !== 'string' || value.text.length > 4096) fail('A barcode requires an exact supported format and text.');
  return { format: value.format, text: value.text };
}
export function same(a, b) { return a !== null && b !== null && a.format === b.format && a.text === b.text; }
export function validateProtocol(value) {
  keys(value, ['mode', 'policy', 'formats', 'confirmationFrames', 'trialMs', 'intervalMs', 'width', 'height', 'sourceWidth', 'sourceHeight', 'camera']);
  if (value.mode !== 'shared-camera-image-v1' || value.policy !== 'pos-v1') fail('Unknown benchmark protocol.');
  if (!Array.isArray(value.formats) || !value.formats.length || value.formats.some(format => !FORMATS.includes(format)) || new Set(value.formats).size !== value.formats.length) fail('Invalid format allowlist.');
  if (![1, 2, 3].includes(value.confirmationFrames) || ![5000, 10000, 15000].includes(value.trialMs) || value.intervalMs !== 120) fail('Invalid timing/confirmation protocol.');
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || Math.max(value.width, value.height) > 1920 || value.width * value.height > 2100000) fail('Invalid capture dimensions.');
  if (![value.sourceWidth, value.sourceHeight].every(n => Number.isInteger(n) && n >= 1 && n <= 16384) || value.width > value.sourceWidth || value.height > value.sourceHeight) fail('Invalid source camera dimensions.');
  keys(value.camera, ['facingMode', 'focusMode', 'exposureMode', 'zoom', 'frameRate']);
  if (!['environment', 'user', 'left', 'right', 'unknown'].includes(value.camera.facingMode) ||
      !['none', 'manual', 'single-shot', 'continuous', 'unknown'].includes(value.camera.focusMode) ||
      !['none', 'manual', 'single-shot', 'continuous', 'unknown'].includes(value.camera.exposureMode) ||
      ![value.camera.zoom, value.camera.frameRate].every(n => n === null || finite(n, 1000))) fail('Invalid camera settings.');
  return { mode: value.mode, policy: value.policy, formats: [...value.formats].sort(), confirmationFrames: value.confirmationFrames,
    trialMs: value.trialMs, intervalMs: value.intervalMs, width: value.width, height: value.height, sourceWidth: value.sourceWidth, sourceHeight: value.sourceHeight,
    camera: { facingMode: value.camera.facingMode, focusMode: value.camera.focusMode, exposureMode: value.camera.exposureMode, zoom: value.camera.zoom, frameRate: value.camera.frameRate } };
}
export function validateTrial(value) {
  keys(value, ['runId', 'sessionId', 'deviceId', 'caseId', 'repeat', 'source', 'expected', 'engine', 'protocol', 'outcome']);
  for (const name of ['runId', 'sessionId', 'deviceId', 'caseId']) if (!id(value[name])) fail(`Invalid ${name}. Use a short non-personal identifier.`);
  if (!Number.isInteger(value.repeat) || value.repeat < 1 || value.repeat > 1000 || !['real', 'synthetic'].includes(value.source)) fail('Invalid repetition or source.');
  const expected = value.expected === null ? null : identity(value.expected), protocol = validateProtocol(value.protocol);
  if (expected && !protocol.formats.includes(expected.format)) fail('Expected format must be enabled.');
  keys(value.engine, ['id', 'version', 'configuration']);
  if (!id(value.engine.id) || typeof value.engine.version !== 'string' || !value.engine.version.length || value.engine.version.length > 100 || !['worker-image-recovery', 'worker-image-independent-v1', 'worker-image-qr-v1', 'worker-image-signal-v1', 'scanbot-single-shot'].includes(value.engine.configuration)) fail('Invalid engine metadata.');
  keys(value.outcome, ['status', 'elapsedMs', 'frames', 'confirmations']);
  const outcome = value.outcome;
  if (!['completed', 'cancelled', 'error'].includes(outcome.status) || !finite(outcome.elapsedMs, 120000) || !Number.isInteger(outcome.frames) || outcome.frames < 0 || outcome.frames > 1000 || !Array.isArray(outcome.confirmations) || outcome.confirmations.length > 128) fail('Invalid trial outcome.');
  if (outcome.status === 'completed' && outcome.elapsedMs < protocol.trialMs) fail('An incomplete trial cannot be counted as completed.');
  let previous = -1;
  const confirmations = outcome.confirmations.map(event => {
    keys(event, ['atMs', 'format', 'text']);
    if (!finite(event.atMs, protocol.trialMs) || event.atMs < previous || event.atMs > outcome.elapsedMs) fail('Invalid confirmation timing.');
    previous = event.atMs;
    const code = identity({ format: event.format, text: event.text });
    if (!protocol.formats.includes(code.format)) fail('Confirmation format was not enabled.');
    return { atMs: event.atMs, ...code };
  });
  if (confirmations.length > outcome.frames) fail('Confirmations cannot exceed captured frames.');
  return { ...value, expected, engine: { id: value.engine.id, version: value.engine.version, configuration: value.engine.configuration }, protocol, outcome: { ...outcome, confirmations } };
}
export function report(trials) {
  if (!Array.isArray(trials) || trials.length > 2000) fail('A report supports at most 2000 trials.');
  const seen = new Set(), runs = new Set();
  const validated = trials.map(value => {
    const trial = validateTrial(value), key = trialKey(trial) + ':' + trial.engine.id;
    if (seen.has(key) || runs.has(trial.runId)) fail('Duplicate trial or run ID. Increment the repetition number for a new trial.');
    seen.add(key); runs.add(trial.runId); return trial;
  });
  return { schema: SCHEMA, trials: validated };
}
export function parseReport(value) { keys(value, ['schema', 'trials']); if (value.schema !== SCHEMA) fail('Unsupported report schema.'); return report(value.trials); }
export function trialKey(trial) { return JSON.stringify([trial.sessionId, trial.deviceId, trial.caseId, trial.repeat]); }
export function trialMetrics(trial) {
  const events = trial.outcome.confirmations, correct = events.filter(event => same(event, trial.expected));
  const wrong = events.filter(event => !same(event, trial.expected));
  return { completed: trial.outcome.status === 'completed', firstConfirmationMs: events[0]?.atMs ?? null,
    firstCorrectMs: correct[0]?.atMs ?? null, wrongFirst: events.length > 0 && !same(events[0], trial.expected),
    wrongConfirmations: wrong.length, anyWrong: wrong.length > 0,
    missed: trial.outcome.status === 'completed' && trial.expected !== null && !correct.length,
    cleanCorrect: trial.outcome.status === 'completed' && trial.expected !== null && correct.length > 0 && wrong.length === 0,
    correctNegative: trial.outcome.status === 'completed' && trial.expected === null && events.length === 0 };
}
export function summarize(value) {
  const data = parseReport(value), times = [], summary = { total: data.trials.length, completed: 0, cancelled: 0, errors: 0, real: 0, synthetic: 0,
    positives: 0, negatives: 0, cleanCorrect: 0, missed: 0, correctNegatives: 0, trialsWithWrongConfirmation: 0, wrongFirst: 0,
    interruptedWithWrongConfirmation: 0, interruptedWrongFirst: 0, medianFirstCorrectMs: null };
  for (const trial of data.trials) {
    summary[trial.source]++;
    if (trial.outcome.status !== 'completed') {
      summary[trial.outcome.status === 'error' ? 'errors' : 'cancelled']++;
      const metric = trialMetrics(trial); summary.interruptedWithWrongConfirmation += Number(metric.anyWrong); summary.interruptedWrongFirst += Number(metric.wrongFirst); continue;
    }
    summary.completed++; summary[trial.expected === null ? 'negatives' : 'positives']++;
    const metric = trialMetrics(trial);
    summary.cleanCorrect += Number(metric.cleanCorrect); summary.missed += Number(metric.missed);
    summary.correctNegatives += Number(metric.correctNegative); summary.trialsWithWrongConfirmation += Number(metric.anyWrong); summary.wrongFirst += Number(metric.wrongFirst);
    if (metric.firstCorrectMs !== null) times.push(metric.firstCorrectMs);
  }
  times.sort((a, b) => a - b);
  if (times.length) summary.medianFirstCorrectMs = times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
  return summary;
}
export function compare(left, right) {
  left = parseReport(left); right = parseReport(right);
  const single = data => { const engines = new Set(data.trials.map(trial => JSON.stringify(trial.engine))); if (engines.size !== 1) fail('Each compared report must contain exactly one engine version and configuration.'); return data.trials[0].engine.id; };
  const leftEngine = single(left), rightEngine = single(right);
  if (leftEngine === rightEngine) fail('Compare two different engine IDs.');
  const index = new Map(right.trials.map(trial => [trialKey(trial), trial]));
  if (left.trials.length !== right.trials.length) fail('Reports must contain the same paired trials.');
  const pairs = left.trials.map(a => {
    const b = index.get(trialKey(a));
    if (!b || JSON.stringify(a.protocol) !== JSON.stringify(b.protocol) || JSON.stringify(a.expected) !== JSON.stringify(b.expected) || a.source !== b.source) fail('Case, device, session, truth, source, repetition and capture protocol must match for every pair.');
    return { sessionId: a.sessionId, deviceId: a.deviceId, caseId: a.caseId, repeat: a.repeat, leftStatus: a.outcome.status, rightStatus: b.outcome.status,
      source: a.source, protocol: a.protocol, left: trialMetrics(a), right: trialMetrics(b) };
  });
  return { schema: 'barcode-comparison-summary/v1', scope: 'paired live trials; sequential captures are not identical recordings',
    leftEngine, rightEngine, leftConfiguration: left.trials[0].engine, rightConfiguration: right.trials[0].engine,
    configurationDifferences: `${left.trials[0].engine.configuration} versus ${right.trials[0].engine.configuration}. Both use the same external POS policy. Complete SDK camera pipelines are excluded; internal decoder strategies can differ.`,
    left: summarize(left), right: summarize(right), pairs };
}
