/** Headless, local-only camera scanner. Keep the adjacent web/ assets together. */
import * as posModule from '../pos-policy.js';
import * as analysisModule from '../frame-analysis.js';
import * as selectionModule from '../capture-selection.js';
import * as captureModule from '../scan-policy.js';

// The existing helpers also support classic-script users of the standalone app.
const Pos = globalThis.PosPolicy || posModule.default;
const Analysis = globalThis.FrameAnalysis || analysisModule.default;
const Selection = globalThis.CaptureSelection || selectionModule.default;
const Capture = globalThis.ScanPolicy || captureModule.default;
const DEFAULTS = { formats: ['ean13', 'upca', 'code128', 'qr'], confirmationFrames: 2,
  preferClearFrames: true, cropBarcodes: true };
const OPTION_KEYS = Object.keys(DEFAULTS);
const QUALITY = { dark: 'Add light to the label.', 'low-detail': 'Hold still and let the camera focus.',
  glare: 'Tilt the label slightly to reduce possible glare.', small: 'Move closer while keeping the full label visible.',
  clipped: 'Move back to include the barcode and its border.' };

function checkedOptions(input, previous = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).some(key => !OPTION_KEYS.includes(key))) throw new TypeError('Unknown scanner option.');
  const next = { ...previous, ...input };
  const policy = Pos.validateOptions({ allowedFormats: next.formats, confirmationFrames: next.confirmationFrames });
  if (typeof next.preferClearFrames !== 'boolean' || typeof next.cropBarcodes !== 'boolean') {
    throw new TypeError('preferClearFrames and cropBarcodes must be booleans.');
  }
  return { ...next, formats: policy.allowedFormats };
}

function aborted() { const error = new Error('Scanner operation cancelled.'); error.name = 'AbortError'; return error; }
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Create one scanner for one video element. No camera is opened until start(). */
export function createScanner(configuration = {}) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new TypeError('Scanner configuration is required.');
  const { video, onScan, onStatus, onError, assetBaseUrl, ...settings } = configuration;
  if (!video || typeof video.play !== 'function' || !video.ownerDocument?.createElement) {
    throw new TypeError('Provide a video element owned by a browser document.');
  }
  for (const callback of [onScan, onStatus, onError]) {
    if (callback !== undefined && typeof callback !== 'function') throw new TypeError('Scanner callbacks must be functions.');
  }
  const doc = video.ownerDocument, env = doc.defaultView || globalThis;
  const base = assetBaseUrl === undefined ? new URL('../', import.meta.url)
    : new URL(String(assetBaseUrl).replace(/\/?$/, '/'), doc.baseURI);
  if (!['https:', 'http:'].includes(base.protocol) && base.protocol !== 'file:') throw new TypeError('Use a hosted scanner asset directory.');
  if (base.search || base.hash) throw new TypeError('assetBaseUrl must be a directory without a query or fragment.');
  if (env.location && base.origin !== env.location.origin) throw new TypeError('Host scanner assets on the same origin as this page.');
  let options = checkedOptions(settings), policy = Pos.createConfirmation(policyOptions());
  const canvas = doc.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser cannot capture camera images.');
  let selection = Selection.create(), stream = null, active = false, destroyed = false, accepted = false;
  let generation = 0, revision = 0, retry = 0, timer = null, loop = null, startPromise = null;
  let operation = null, worker = null, ready = null, requestId = 0, lastFrame = null;
  let frameCallback = null, presented = null, trackCleanup = null;
  const pending = new Map();
  const now = () => env.performance.now();
  const later = (fn, ms) => env.setTimeout(fn, ms);
  const clear = id => env.clearTimeout(id);
  function policyOptions() { return { allowedFormats: options.formats, confirmationFrames: options.confirmationFrames }; }

  function ensureUsable() { if (destroyed) throw new Error('This scanner has been destroyed. Create a new scanner.'); }
  function report(error) { try { onError?.(error); } catch { /* Host callback errors never restart scanning. */ } }
  function emit(callback, value) { try { callback?.(value); } catch (error) { report(error); } }
  function status(state, message, reason) { emit(onStatus, { state, message, ...(reason ? { reason } : {}) }); }
  function resetEvidence() {
    revision++; policy = Pos.createConfirmation(policyOptions()); selection.reset();
    accepted = false; lastFrame = null; retry = 0;
  }
  function resetWorker(error = aborted()) {
    worker?.terminate(); worker = null; ready = null;
    for (const entry of pending.values()) { clear(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function call(type, extra = {}, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const deadline = later(() => resetWorker(new Error('Decoding timed out. Restart the scanner or use a smaller image.')), type === 'init' ? 30000 : 12000);
      pending.set(id, { resolve, reject, timer: deadline });
      try { worker.postMessage({ id, type, ...extra }, transfer); }
      catch (error) { clear(deadline); pending.delete(id); reject(error); }
    });
  }
  function initialize() {
    if (!ready) {
      worker = new env.Worker(new URL('scanner-worker.js', base));
      const current = worker;
      current.onmessage = ({ data }) => {
        if (worker !== current) return;
        const entry = pending.get(data?.id);
        if (!entry) return;
        clear(entry.timer); pending.delete(data.id);
        if (data.type === 'error') entry.reject(new Error(data.message || 'Could not decode this image.'));
        else entry.resolve(data);
      };
      current.onerror = () => { if (worker === current) resetWorker(new Error('Could not load scanner assets. Check the asset directory and offline cache.')); };
      ready = call('init').catch(error => { if (worker === current) resetWorker(error); throw error; });
    }
    return ready;
  }
  function cancelTracking() {
    if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
    frameCallback = null; presented = null;
  }
  function trackFrames(token) {
    cancelTracking();
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    let sequence = 0;
    const observe = (_time, metadata) => {
      if (!active || generation !== token) return;
      presented = Number.isSafeInteger(metadata.presentedFrames) ? metadata.presentedFrames : ++sequence;
      frameCallback = video.requestVideoFrameCallback(observe);
    };
    frameCallback = video.requestVideoFrameCallback(observe);
  }
  function frameId() {
    if (typeof video.requestVideoFrameCallback === 'function') return presented === null ? null : `presented:${presented}`;
    try {
      const count = video.getVideoPlaybackQuality?.().totalVideoFrames;
      if (Number.isSafeInteger(count) && count >= 0) return `decoded:${count}`;
    } catch { /* Clock-only browsers cannot prove distinct frames. */ }
    return `clock:${video.currentTime}`;
  }
  function stopInternal() {
    generation++; active = false; startPromise = null;
    operation?.abort(); operation = null;
    if (timer !== null) clear(timer);
    timer = null; cancelTracking(); trackCleanup?.(); trackCleanup = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    video.srcObject = null; resetEvidence(); resetWorker();
    canvas.width = canvas.height = 0;
  }
  function stop() { if (destroyed) return; stopInternal(); status('stopped', 'Camera stopped.'); }
  function pauseWhenHidden() { if (doc.hidden) stop(); }
  doc.addEventListener('visibilitychange', pauseWhenHidden);
  env.addEventListener('pagehide', stop);

  function capture(source, width, height, maxPixels) {
    const plan = Capture.capturePlan(width, height, { maxPixels });
    canvas.width = plan.width; canvas.height = plan.height;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return { image: { width: pixels.width, height: pixels.height, data: pixels.data.buffer }, plan };
  }
  function publish(decision) {
    if (decision.status === 'confirmed') {
      if (accepted) return null;
      accepted = true; selection.reset();
      const result = decision.results[0];
      let raw = ''; for (const byte of result.bytes) raw += String.fromCharCode(byte);
      const scan = { scanId: env.crypto.randomUUID(), text: result.text, format: Pos.canonicalFormat(result.format),
        bytesBase64: env.btoa(raw), position: result.position || null };
      const token = generation, currentRevision = revision;
      status('confirmed', 'Code confirmed. Start a new scan for the next item.', decision.reason);
      // Host callbacks can synchronously stop, destroy, or begin another attempt.
      if (destroyed || token !== generation || currentRevision !== revision || !accepted) return null;
      emit(onScan, scan);
      return scan;
    }
    const messages = {
      conflicting_values: 'Conflicting codes. Isolate one label and start a new scan.',
      unreliable_frames: 'Distinct camera frames could not be verified. Try another browser or explicitly select one-frame confirmation.',
      insufficient_confirmation: `Hold steady: ${decision.matchedFrames} of ${decision.requiredFrames} matching frames.`,
      no_code: 'No allowed code found. Keep one complete label in view.',
    };
    status(decision.status, messages[decision.reason] || 'Rescan the label.', decision.reason);
    return null;
  }
  function schedule(token, delay = 80) {
    if (!active || accepted || token !== generation || timer !== null || loop?.generation === token) return;
    timer = later(() => { timer = null; void scanFrame(token); }, delay);
  }
  async function scanFrame(token) {
    if (!active || accepted || generation !== token) return;
    const running = { generation: token }; loop = running;
    const currentRevision = revision;
    try {
      const id = frameId(); let selected = null;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight && id !== null && id !== lastFrame) {
        lastFrame = id;
        const capturedAt = now();
        const sample = capture(video, video.videoWidth, video.videoHeight, 2_100_000);
        const analysis = Analysis.analyze(sample.image);
        const candidate = { ...sample, analysis, capturedAt, frameId: id, revision: currentRevision };
        selected = options.preferClearFrames ? selection.push(candidate) : candidate;
        if (!selected && analysis.hint) status('scanning', QUALITY[analysis.hint] || 'Hold the label steady.');
      } else if (options.preferClearFrames) selected = selection.flush(now());
      if (selected) {
        const { image, plan, analysis, capturedAt } = selected;
        const response = await call('decode', { image, mode: 'live', retryIndex: retry++, enhanceLive: options.cropBarcodes,
          posOptions: policyOptions() }, [image.data]);
        if (!active || accepted || token !== generation || revision !== currentRevision || selected.revision !== revision) return;
        if (now() - capturedAt > 1200) {
          policy.reset(); status('rescan', 'That image is too old. Hold still for a fresh scan.', 'stale_frame');
        } else {
          publish(policy.observe(Capture.remapResults(response.results, plan), selected.frameId, capturedAt,
            response.analysis?.fingerprint || analysis.fingerprint));
        }
      }
    } catch (error) {
      if (token === generation && error.name !== 'AbortError') {
        stopInternal(); status('error', error.message); report(error);
      }
    } finally {
      if (loop === running) loop = null;
      schedule(token, options.preferClearFrames ? 80 : 180);
    }
  }

  function start(camera = {}) {
    ensureUsable();
    if (!camera || typeof camera !== 'object' || Array.isArray(camera) ||
        Object.keys(camera).some(key => !['deviceId', 'facingMode'].includes(key)) ||
        (camera.deviceId !== undefined && (typeof camera.deviceId !== 'string' || !camera.deviceId)) ||
        (camera.facingMode !== undefined && !['environment', 'user', 'left', 'right'].includes(camera.facingMode))) {
      return Promise.reject(new TypeError('Use a deviceId or supported facingMode.'));
    }
    if (startPromise) return startPromise;
    if (active) return Promise.resolve();
    stopInternal();
    const token = generation, abort = new AbortController(); operation = abort;
    const promise = Promise.resolve().then(async () => {
      let acquired;
      try {
        if (token !== generation || abort.signal.aborted) throw aborted();
        if (!env.isSecureContext || !env.navigator.mediaDevices?.getUserMedia) throw new Error('Camera scanning requires HTTPS or localhost and camera permission.');
        if (doc.hidden) throw new Error('Open the page before starting the camera.');
        await abortable(initialize(), abort.signal);
        const request = env.navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 },
          ...(camera.deviceId ? { deviceId: { exact: camera.deviceId } } : { facingMode: { ideal: camera.facingMode || 'environment' } }) } });
        request.then(value => { if (token !== generation) value.getTracks().forEach(track => track.stop()); }, () => {});
        acquired = await abortable(request, abort.signal);
        stream = acquired; video.srcObject = stream; video.muted = true; video.playsInline = true;
        await abortable(video.play(), abort.signal);
        if (token !== generation) throw aborted();
        const track = stream.getVideoTracks()[0];
        const ended = () => { if (generation === token) stop(); };
        track?.addEventListener('ended', ended); trackCleanup = () => track?.removeEventListener('ended', ended);
        if (track?.getCapabilities?.().focusMode?.includes('continuous')) {
          try { await abortable(track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }), abort.signal); }
          catch (error) { if (error.name === 'AbortError') throw error; }
        }
        if (token !== generation || doc.hidden) throw aborted();
        active = true; trackFrames(token); status('scanning', 'Keep one complete label in view.'); schedule(token, 0);
      } catch (error) {
        acquired?.getTracks().forEach(track => track.stop());
        if (token === generation) {
          stopInternal();
          if (error.name !== 'AbortError') { status('error', error.message); report(error); }
        }
        throw error;
      } finally {
        if (generation === token) { startPromise = null; if (operation === abort) operation = null; }
      }
    });
    startPromise = promise;
    status('starting', 'Opening the camera…');
    return promise;
  }

  async function readImage(blob, signal) {
    if (typeof env.createImageBitmap === 'function') {
      const request = env.createImageBitmap(blob);
      let expired = false, deadline;
      request.then(bitmap => { if (signal.aborted || expired) bitmap.close(); }, () => {});
      try {
        const timeout = new Promise((_resolve, reject) => {
          deadline = later(() => { expired = true; reject(new Error('Image loading timed out.')); }, 20000);
        });
        const bitmap = await abortable(Promise.race([request, timeout]), signal);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } finally { clear(deadline); }
    }
    const image = new env.Image(), url = env.URL.createObjectURL(blob);
    let deadline;
    try {
      await abortable(new Promise((resolve, reject) => {
        image.onload = resolve; image.onerror = () => reject(new Error('Could not load this image.'));
        deadline = later(() => reject(new Error('Image loading timed out.')), 20000); image.src = url;
      }), signal);
      return { source: image, width: image.naturalWidth, height: image.naturalHeight,
        close: () => { image.src = ''; env.URL.revokeObjectURL(url); } };
    } catch (error) { image.src = ''; env.URL.revokeObjectURL(url); throw error; }
    finally { clear(deadline); image.onload = image.onerror = null; }
  }

  async function scanImage(blob) {
    ensureUsable();
    if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isFinite(blob.size) || blob.size < 1 || blob.size > 10 * 1024 * 1024 ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new TypeError('Choose a PNG, JPEG, or WebP image up to 10 MiB.');
    stopInternal();
    const token = generation, currentRevision = revision, abort = new AbortController(); operation = abort;
    let loaded;
    try {
      status('scanning', 'Reading the image on this device…');
      if (token !== generation || abort.signal.aborted) throw aborted();
      loaded = await readImage(blob, abort.signal);
      if (!Number.isInteger(loaded.width) || !Number.isInteger(loaded.height) || loaded.width < 1 || loaded.height < 1 || loaded.width * loaded.height > 20_000_000) {
        throw new Error('Choose an image with no more than 20 million pixels.');
      }
      if (token !== generation || currentRevision !== revision) throw aborted();
      await abortable(initialize(), abort.signal);
      if (token !== generation || currentRevision !== revision) throw aborted();
      const { image, plan } = capture(loaded.source, loaded.width, loaded.height, 4_000_000);
      const fingerprint = Analysis.analyze(image).fingerprint;
      const response = await call('decode', { image, mode: 'image', enhanceLive: options.cropBarcodes,
        posOptions: policyOptions() }, [image.data]);
      if (token !== generation || currentRevision !== revision) throw aborted();
      return publish(policy.observe(Capture.remapResults(response.results, plan), 'import:1', now(), fingerprint));
    } catch (error) {
      if (token === generation && error.name !== 'AbortError') { status('error', error.message); report(error); }
      throw error;
    } finally {
      loaded?.close();
      if (operation === abort) { operation = null; resetWorker(); canvas.width = canvas.height = 0; }
    }
  }

  function setOptions(partial) {
    ensureUsable(); options = checkedOptions(partial, options); resetEvidence();
    status(active ? 'scanning' : 'idle', 'Scanning options updated. Start a fresh scan.'); schedule(generation, 0);
  }
  function rescan() {
    ensureUsable(); resetEvidence(); status(active ? 'scanning' : 'idle', 'Ready for a new scan.'); schedule(generation, 0);
  }
  function destroy() {
    if (destroyed) return;
    stopInternal(); destroyed = true;
    doc.removeEventListener('visibilitychange', pauseWhenHidden); env.removeEventListener('pagehide', stop);
    status('destroyed', 'Scanner closed.');
  }
  return Object.freeze({ start, stop, destroy, setOptions, rescan, scanImage });
}
