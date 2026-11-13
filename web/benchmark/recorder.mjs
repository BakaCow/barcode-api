import { identity, validateTrial } from './metrics.mjs';

// A bounded recorder keeps late asynchronous results out of measured outcomes.
export function createRecorder(metadata, startedAt) {
  const template = validateTrial({ ...metadata, outcome: { status: 'cancelled', elapsedMs: 0, frames: 0, confirmations: [] } });
  if (!Number.isFinite(startedAt) || startedAt < 0) throw new Error('Invalid trial clock.');
  let closed = false, frames = 0;
  const confirmations = [];
  return {
    frame() { if (!closed) frames++; },
    confirmation(code, completedAt) {
      const elapsed = completedAt - startedAt;
      if (closed || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= template.protocol.trialMs) return false;
      if (confirmations.length >= 128 || elapsed < (confirmations.at(-1)?.atMs ?? 0)) throw new Error('Invalid confirmation sequence.');
      confirmations.push({ atMs: elapsed, ...identity(code) });
      return true;
    },
    finish(status, endedAt) {
      if (closed) return null;
      const result = validateTrial({ ...template, outcome: { status, elapsedMs: endedAt - startedAt, frames, confirmations } });
      closed = true; return result;
    },
  };
}
