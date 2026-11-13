/* Optional camera controls must not replace capture constraints or disable video. */
(function (root) {
  'use strict';
  function probe(track, method) {
    try { return track?.[method]?.() || {}; } catch { return {}; }
  }
  function cancelled() { const error = new Error('Camera operation cancelled.'); error.name = 'AbortError'; return error; }
  function create(track, initial = {}, isCurrent = () => true) {
    let saved = { ...initial }, values = {}, queue = Promise.resolve();
    const settings = () => ({ ...values, ...probe(track, 'getSettings') });
    function change(update) {
      const command = queue.catch(() => {}).then(async () => {
        if (!isCurrent()) throw cancelled();
        const next = typeof update === 'function' ? update(settings()) : update;
        const base = { ...saved, ...probe(track, 'getConstraints') };
        const advanced = (Array.isArray(base.advanced) ? base.advanced : []).map(entry => {
          const copy = { ...entry }; for (const key of Object.keys(next)) delete copy[key]; return copy;
        }).filter(entry => Object.keys(entry).length);
        for (const key of Object.keys(next)) delete base[key];
        const constraints = { ...base, advanced: [...advanced, { ...next }] };
        await track.applyConstraints(constraints);
        if (!isCurrent()) throw cancelled();
        saved = constraints; values = { ...values, ...next };
        return settings();
      });
      queue = command.catch(() => {});
      return command;
    }
    return { change, settings, capabilities: () => probe(track, 'getCapabilities') };
  }
  const api = { create, probe };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CameraConstraints = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
