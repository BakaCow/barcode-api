/* One-script hosted scanner. Camera pixels remain inside the scanner frame. */
(function (root, doc) {
  'use strict';
  const script = doc.currentScript;
  const PROTOCOL = 'barcode-camera-embed', VERSION = 1;
  const registryKey = Symbol.for('BarcodeCamera.embed.v1');
  const FORMATS = ['ean13', 'upca', 'code128', 'qr', 'ean8', 'upce', 'datamatrix', 'aztec', 'pdf417', 'code93'];
  const STATES = ['idle', 'starting', 'scanning', 'confirmed', 'ambiguous', 'rescan', 'error', 'stopped', 'destroyed'];
  const CORNERS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const boundedText = (value, max) => typeof value === 'string' && value.length <= max;
  function assetBase() {
    if (!script?.src) throw new Error('Load BarcodeCamera from its hosted embed.js script.');
    const url = new URL(script.src, doc.baseURI);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
    if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new Error('Host the scanner script on HTTPS, or localhost for development.');
    return new URL('./', url);
  }
  function optionsFor(input = {}) {
    if (!object(input) || Reflect.ownKeys(input).some(key => !['formats', 'confirmationFrames', 'controls', 'onScan', 'onStatus', 'onError'].includes(key))) throw new TypeError('Unknown BarcodeCamera option.');
    const formats = input.formats ?? ['ean13', 'upca', 'code128', 'qr'];
    if (!Array.isArray(formats) || !formats.length || formats.length > FORMATS.length || new Set(formats).size !== formats.length || formats.some(format => !FORMATS.includes(format))) throw new TypeError('Choose one or more different supported barcode formats.');
    const confirmationFrames = input.confirmationFrames ?? 2, controls = input.controls ?? true;
    if (![1, 2, 3].includes(confirmationFrames) || typeof controls !== 'boolean') throw new TypeError('Use one to three confirmation frames and a boolean controls option.');
    for (const callback of ['onScan', 'onStatus', 'onError']) if (input[callback] !== undefined && typeof input[callback] !== 'function') throw new TypeError(`${callback} must be a function.`);
    return { ...input, formats: [...formats], confirmationFrames, controls };
  }
  function scanResult(value, formats) {
    if (!object(value) || !boundedText(value.scanId, 128) || !/^[A-Za-z0-9._:-]+$/.test(value.scanId) ||
        !boundedText(value.text, 10000) || !formats.includes(value.format) || !boundedText(value.bytesBase64, 65536) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytesBase64) ||
        (!value.text.length && !value.bytesBase64.length)) return null;
    let position = null;
    if (value.position !== null) {
      if (!object(value.position)) return null;
      position = {};
      for (const corner of CORNERS) {
        const point = value.position[corner];
        if (!object(point) || ![point.x, point.y].every(coordinate => Number.isFinite(coordinate) && Math.abs(coordinate) <= 10000000)) return null;
        position[corner] = { x: point.x, y: point.y };
      }
    }
    return { scanId: value.scanId, text: value.text, format: value.format, bytesBase64: value.bytesBase64, position };
  }
  function createRegistry(defaultBase) {
    const mountedScripts = new WeakSet();
    function mount(target, input, base = defaultBase, ownTarget = false) {
      if (!root.isSecureContext || !/^https?:$/.test(root.location.protocol) || root.location.origin === 'null') throw new Error('Open the website over HTTPS, or localhost for development, to use its camera.');
      if (!target || target.nodeType !== 1 || target.ownerDocument !== doc || !target.isConnected) throw new TypeError('Mount the scanner in a connected element on this page.');
      const options = optionsFor(input);
      const random = new Uint8Array(16); root.crypto.getRandomValues(random);
      const channel = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
      const frameURL = new URL('embed/', base);
      frameURL.hash = new URLSearchParams({ parentOrigin: root.location.origin, channel }).toString();
      const origin = frameURL.origin;
      const wrapper = doc.createElement('div'), note = doc.createElement('p'), frame = doc.createElement('iframe');
      note.textContent = 'Loading barcode scanner…'; note.setAttribute('role', 'status');
      frame.title = 'Barcode Camera scanner'; frame.setAttribute('allow', 'camera');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox'); frame.referrerPolicy = 'no-referrer';
      frame.style.width = '100%'; frame.style.height = '520px'; frame.style.border = '0'; frame.style.display = 'block';
      frame.hidden = true;
      let disposed = false, connected = false, sequence = 0, revision = 0, loads = 0, timeout;
      let resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      // Auto mounts need visible failure feedback even when nobody awaits ready.
      ready.catch(() => {});
      function dispatch(name, detail) { target.dispatchEvent(new root.CustomEvent(name, { bubbles: true, detail })); }
      function report(error) {
        if (disposed) return;
        try { options.onError?.(error); } catch { /* A host error handler must not break cleanup. */ }
        dispatch('barcode:error', error);
      }
      function callback(name, value) {
        try { options[name]?.(value); }
        catch { report(new Error(`The website's ${name} callback failed. Check its integration code.`)); }
      }
      function send(type, payload = {}) {
        if (!disposed) frame.contentWindow?.postMessage({ protocol: PROTOCOL, version: VERSION, channel, revision, type, payload }, origin);
      }
      function cleanup(keepError = false) {
        if (disposed) return;
        revision++; send('destroy'); disposed = true;
        root.clearTimeout(timeout); observer?.disconnect();
        root.removeEventListener('message', receive); root.removeEventListener('pagehide', stop);
        doc.removeEventListener('visibilitychange', visibility); frame.removeEventListener('load', loaded);
        if (!connected) { const error = new Error('Scanner mount cancelled.'); error.name = 'AbortError'; rejectReady(error); }
        frame.remove();
        if (!keepError) { wrapper.remove(); if (ownTarget && !target.childNodes.length) target.remove(); }
      }
      function fail(message) {
        if (disposed) return;
        const error = new Error(message);
        note.textContent = message; note.hidden = false; note.setAttribute('role', 'alert');
        if (!connected) rejectReady(error);
        report(error); cleanup(true);
      }
      function configure() { send('configure', { formats: [...options.formats], confirmationFrames: options.confirmationFrames, controls: options.controls }); }
      function loaded() {
        if (++loads > 1) { fail('The scanner frame reloaded. Reload this page or mount a new scanner.'); return; }
        configure();
      }
      function receive(event) {
        if (disposed || !target.isConnected || !frame.isConnected) { if (!disposed) cleanup(); return; }
        if (event.source !== frame.contentWindow || event.origin !== origin) return;
        const message = event.data;
        if (!object(message) || message.protocol !== PROTOCOL || message.version !== VERSION || message.channel !== channel) return;
        const payload = message.payload;
        if (message.type === 'hello') { configure(); return; }
        if (message.type === 'ready' && !connected) {
          connected = true; root.clearTimeout(timeout); note.hidden = true; frame.hidden = false;
          resolveReady(instance); dispatch('barcode:ready', instance);
          if (doc.hidden) stop();
          return;
        }
        if (message.type === 'error' && message.revision === revision && object(payload) && boundedText(payload.message, 2000) && payload.message) {
          if (!connected) fail(payload.message); else report(new Error(payload.message));
          return;
        }
        if (!connected) return;
        if (message.type === 'resize' && object(payload) && Number.isFinite(payload.height) && payload.height >= 240 && payload.height <= 4096) frame.style.height = `${Math.ceil(payload.height)}px`;
        else if (message.type === 'status' && message.revision === revision && object(payload) && STATES.includes(payload.state) && boundedText(payload.message, 1000) &&
                 (payload.reason === undefined || boundedText(payload.reason, 100))) {
          const status = { state: payload.state, message: payload.message, ...(payload.reason === undefined ? {} : { reason: payload.reason }) };
          const currentRevision = revision;
          callback('onStatus', status); if (!disposed && revision === currentRevision) dispatch('barcode:status', status);
        } else if (message.type === 'scan' && message.revision === revision && object(payload) && Number.isSafeInteger(payload.sequence) && payload.sequence > sequence) {
          const result = scanResult(payload.result, options.formats);
          if (!result) return;
          sequence = payload.sequence;
          const currentRevision = revision;
          callback('onScan', result); if (!disposed && revision === currentRevision) dispatch('barcode:scan', result);
        }
      }
      function stop() { if (!disposed) { revision++; send('stop'); } }
      function visibility() { if (doc.hidden) stop(); }
      const observer = root.MutationObserver ? new root.MutationObserver(() => {
        if (!target.isConnected || !frame.isConnected) cleanup();
      }) : null;
      const instance = Object.freeze({ ready, stop, rescan() { if (connected && !disposed) { revision++; send('rescan'); } }, destroy() { cleanup(); } });
      root.addEventListener('message', receive); root.addEventListener('pagehide', stop); doc.addEventListener('visibilitychange', visibility);
      frame.addEventListener('load', loaded); observer?.observe(doc.documentElement, { childList: true, subtree: true });
      timeout = root.setTimeout(() => fail('The scanner could not load. Check the connection and allow this scanner server in the website’s script-src and frame-src policies.'), 20000);
      // Set the navigation before insertion so an initial about:blank load
      // cannot be mistaken for a later reload of the configured scanner.
      frame.src = frameURL.href;
      wrapper.append(note, frame); target.append(wrapper);
      return instance;
    }
    function autoMount(tag, base) {
      if (!tag || !tag.hasAttribute('data-barcode-scanner') || mountedScripts.has(tag)) return;
      mountedScripts.add(tag);
      const run = () => {
        let target, ownTarget = false;
        try {
          const selector = tag.getAttribute('data-target');
          if (selector) { target = doc.querySelector(selector); if (!target) throw new Error('The scanner data-target does not match an element on this page.'); }
          else { target = doc.createElement('div'); tag.parentNode.insertBefore(target, tag); ownTarget = true; }
          const input = {};
          if (tag.hasAttribute('data-formats')) input.formats = tag.getAttribute('data-formats').split(',').map(value => value.trim());
          if (tag.hasAttribute('data-confirmation-frames')) input.confirmationFrames = Number(tag.getAttribute('data-confirmation-frames'));
          if (tag.hasAttribute('data-controls')) {
            const value = tag.getAttribute('data-controls');
            if (!['true', 'false'].includes(value)) throw new TypeError('data-controls must be true or false.');
            input.controls = value === 'true';
          }
          mount(target, input, base, ownTarget);
        } catch (error) {
          const note = doc.createElement('p'); note.setAttribute('role', 'alert'); note.textContent = error.message;
          if (target?.isConnected) target.append(note); else tag.parentNode?.insertBefore(note, tag);
        }
      };
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', run, { once: true }); else run();
    }
    return { mount, autoMount };
  }
  const base = assetBase();
  let registry = root[registryKey];
  if (!registry) {
    if (root.BarcodeCamera !== undefined) throw new Error('window.BarcodeCamera already exists. Resolve the global name conflict before loading the scanner.');
    registry = createRegistry(base);
    Object.defineProperty(root, registryKey, { value: registry });
    root.BarcodeCamera = Object.freeze({ version: '1.0.0', mount: (target, options) => registry.mount(target, options) });
  }
  registry.autoMount(script, base);
})(window, document);
