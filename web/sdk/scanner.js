/** Headless, local-only camera scanner. Keep the adjacent web/ assets together. */
import * as posModule from '../pos-policy.js';
import * as selectionModule from '../capture-selection.js';
import * as captureModule from '../scan-policy.js';
import { validateTarget, regionPlan, sourceRegions, clearFrame, cameraCapabilities, boundedZoom } from './capture-tools.js';

// The existing helpers also support classic-script users of the standalone app.
const Pos = globalThis.PosPolicy || posModule.default;
const Selection = globalThis.CaptureSelection || selectionModule.default;
const Capture = globalThis.ScanPolicy || captureModule.default;
const DEFAULTS = { formats: ['ean13', 'upca', 'code128', 'qr'], confirmationFrames: 2,
  preferClearFrames: true, cropBarcodes: true, captureMode: 'balanced', adaptiveFrameSelection: true, automaticRecovery: true, targetRegion: null };
const OPTION_KEYS = Object.keys(DEFAULTS);
const MAX_FRAME_AGE = 1200;
const QUALITY = { dark: 'Add light to the label.', 'low-detail': 'Hold still and let the camera focus.',
  blurred: 'Hold still and add light so the barcode edges become clearer.',
  glare: 'Tilt the label slightly to reduce possible glare.', small: 'Move closer while keeping the full label visible.',
  clipped: 'Move back to include the barcode and its border.' };

function checkedOptions(input, previous = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).some(key => !OPTION_KEYS.includes(key))) throw new TypeError('Unknown scanner option.');
  const next = { ...previous, ...input };
  const policy = Pos.validateOptions({ allowedFormats: next.formats, confirmationFrames: next.confirmationFrames });
  if (typeof next.preferClearFrames !== 'boolean' || typeof next.cropBarcodes !== 'boolean' || typeof next.adaptiveFrameSelection !== 'boolean' || typeof next.automaticRecovery !== 'boolean') {
    throw new TypeError('Frame-selection and crop options must be booleans.');
  }
  if (!['balanced', 'detail'].includes(next.captureMode)) throw new TypeError('captureMode must be balanced or detail.');
  return { ...next, formats: policy.allowedFormats, targetRegion: validateTarget(next.targetRegion) };
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
  const { video, onScan, onStatus, onError, onCandidates, assetBaseUrl, ...settings } = configuration;
  if (!video || typeof video.play !== 'function' || !video.ownerDocument?.createElement) {
    throw new TypeError('Provide a video element owned by a browser document.');
  }
  for (const callback of [onScan, onStatus, onError, onCandidates]) {
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
  const snapshot = doc.createElement('canvas'), snapshotContext = snapshot.getContext('2d');
  if (!context) throw new Error('This browser cannot capture camera images.');
  let selection = Selection.create(), recovery = Selection.createRecovery(), stream = null, active = false, destroyed = false, accepted = false;
  let generation = 0, revision = 0, retry = 0, timer = null, loop = null, startPromise = null;
  let operation = null, worker = null, ready = null, requestId = 0, lastFrame = null, offscreenCapture = false;
  let frameCallback = null, presented = null, trackCleanup = null;
  let cameraChoice = {}, cameraAbort = null, controlQueue = Promise.resolve(), controlValues = {}, controlConstraints = {};
  const controlsPending = new Set();
  const pending = new Map(), emittingStatuses = new Set();
  const now = () => env.performance.now();
  const later = (fn, ms) => env.setTimeout(fn, ms);
  const clear = id => env.clearTimeout(id);
  function policyOptions() { return { allowedFormats: options.formats, confirmationFrames: options.confirmationFrames }; }

  function ensureUsable() { if (destroyed) throw new Error('This scanner has been destroyed. Create a new scanner.'); }
  function report(error) { try { onError?.(error); } catch { /* Host callback errors never restart scanning. */ } }
  function emit(callback, value) { try { callback?.(value); } catch (error) { report(error); } }
  function status(state, message, reason) {
    // A host may synchronously update options from a status callback. Deliver
    // changed states, but never recursively redispatch that same state.
    if (emittingStatuses.has(state)) return;
    emittingStatuses.add(state);
    try { emit(onStatus, { state, message, ...(reason ? { reason } : {}) }); }
    finally { emittingStatuses.delete(state); }
  }
  function readyStatus(message) {
    if (accepted && active) status('confirmed', 'Code already confirmed. Start a new scan for the next item.');
    else status(active ? 'scanning' : 'idle', message);
  }
  function resetEvidence(rearm = false) {
    revision++; policy = Pos.createConfirmation(policyOptions()); selection.reset(); recovery.reset();
    if (rearm) accepted = false;
    lastFrame = null; retry = 0;
  }
  function resetWorker(error = aborted()) {
    worker?.terminate(); worker = null; ready = null; offscreenCapture = false;
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
      ready = call('init').then(response => {
        if (worker === current) offscreenCapture = response.capabilities?.offscreenCapture === true;
        return response;
      }).catch(error => { if (worker === current) resetWorker(error); throw error; });
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
    cameraAbort?.abort(); cameraAbort = null; controlsPending.clear(); controlQueue = Promise.resolve(); controlValues = {}; controlConstraints = {};
    if (timer !== null) clear(timer);
    timer = null; cancelTracking(); trackCleanup?.(); trackCleanup = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    video.srcObject = null; resetEvidence(); resetWorker();
    canvas.width = canvas.height = 0;
    snapshot.width = snapshot.height = 0;
  }
  function stop() { if (destroyed) return; stopInternal(); status('stopped', 'Camera stopped.'); }
  function pauseWhenHidden() { if (doc.hidden) stop(); }
  doc.addEventListener('visibilitychange', pauseWhenHidden);
  env.addEventListener('pagehide', stop);

  function capture(source, width, height, maxPixels, region = null, maxSide = 1920, scale = { x: 1, y: 1 }) {
    const plan = regionPlan(width, height, region, maxPixels, maxSide);
    canvas.width = plan.width; canvas.height = plan.height;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, plan.x * scale.x, plan.y * scale.y, plan.cropWidth * scale.x, plan.cropHeight * scale.y, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return { image: { width: pixels.width, height: pixels.height, data: pixels.data.buffer }, plan };
  }
  async function captureSample(source, width, height, imported = false) {
    const token = generation, currentRevision = revision;
    const detail = options.captureMode === 'detail' || (!imported && options.automaticRecovery && recovery.detailed(now())), target = options.targetRegion;
    const valid = () => token === generation && currentRevision === revision && !destroyed && !controlsPending.size;
    let input = source, scale = { x: 1, y: 1 };
    if (offscreenCapture && typeof env.createImageBitmap === 'function' && snapshotContext && (detail || !target || imported)) {
      // Freeze exactly one bounded exposure. Readback, analysis, resizing and
      // recovery crops then run in the worker, not on the interaction thread.
      const sizing = regionPlan(width, height, null, imported ? 20_000_000 : detail ? 8_294_400 : 2_100_000,
        imported ? 20_000_000 : detail ? 3840 : 1920);
      snapshot.width = sizing.width; snapshot.height = sizing.height;
      snapshotContext.drawImage(source, 0, 0, width, height, 0, 0, snapshot.width, snapshot.height);
      let bitmap, bitmapDeadline, expired = false, submitted = false;
      try {
        const signal = (imported ? operation : cameraAbort)?.signal;
        const request = env.createImageBitmap(snapshot);
        request.then(value => { if (expired || !valid()) value.close(); }, () => {});
        const timeout = new Promise((_resolve, reject) => {
          bitmapDeadline = later(() => { expired = true; reject(new Error('Camera image preparation timed out.')); }, 2000);
        });
        const prepared = Promise.race([request, timeout]);
        bitmap = signal ? await abortable(prepared, signal) : await prepared;
        if (!valid()) { bitmap.close(); throw aborted(); }
        clear(bitmapDeadline); submitted = true;
        const response = await call('prepare', { bitmap, sourceWidth: width, sourceHeight: height,
          imported, captureMode: detail ? 'detail' : 'balanced', targetRegion: target, cropBarcodes: options.cropBarcodes }, [bitmap]);
        if (!valid()) throw aborted();
        return response.sample;
      } catch (error) {
        if (!valid() || error.name === 'AbortError') throw aborted();
        if (submitted) throw error;
        // A partial createImageBitmap implementation must not disable an
        // otherwise usable camera. Keep worker analysis with canvas capture.
        offscreenCapture = false;
      } finally {
        clear(bitmapDeadline);
        // Transferred bitmaps are closed by the worker. close() is also safe
        // when a failed transfer left ownership here.
        bitmap?.close();
        if (token === generation) snapshot.width = snapshot.height = 0;
      }
    }
    if (detail && !imported) {
      // Compatibility path: freeze the source before async analysis so every
      // source crop still belongs to the same exposure as its broad image.
      if (!snapshotContext) throw new Error('This browser cannot capture detailed frames.');
      const sizing = regionPlan(width, height, null, 8_294_400, 3840);
      snapshot.width = sizing.width; snapshot.height = sizing.height;
      snapshotContext.drawImage(source, 0, 0, width, height, 0, 0, snapshot.width, snapshot.height);
      input = snapshot; scale = { x: snapshot.width / width, y: snapshot.height / height };
    }
    try {
      const sample = capture(input, width, height, imported || (detail && target) ? 4_000_000 : 2_100_000,
        target, detail && target ? 3840 : 1920, scale);
      // Transfer ownership both ways: no 4M-pixel clone and no full-image
      // fingerprint/region analysis on the UI thread, even without OffscreenCanvas.
      const response = await call('analyze', { image: sample.image, returnImage: true }, [sample.image.data]);
      if (!valid()) throw aborted();
      sample.image = response.image;
      const analysis = response.analysis;
      const proposals = sourceRegions(analysis, sample.plan, width, height);
      const recovery = [];
      if (detail && !target && options.cropBarcodes && sample.plan.width < width * scale.x) {
        for (const region of proposals.slice(0, 2)) {
          const { kind, ...rectangle } = region;
          const crop = capture(input, width, height, 1_000_000, rectangle, 3840, scale);
          if (crop.plan.width / crop.plan.cropWidth > sample.plan.width / sample.plan.cropWidth * 1.05) recovery.push(crop);
        }
      }
      return { ...sample, analysis, proposals, recovery,
        recoveryComplete: proposals.length <= 2 && analysis.regionsComplete !== false,
        sourceWidth: width, sourceHeight: height };
    } finally {
      if (token === generation) snapshot.width = snapshot.height = 0;
    }
  }
  async function decodeSample(sample, mode) {
    const { image, plan } = sample, started = now(), token = generation, currentRevision = revision;
    const valid = () => token === generation && currentRevision === revision && !destroyed && !controlsPending.size;
    // Choose a recovery method per camera frame, including its detail crops.
    // A successful method should see the next independent frame promptly rather
    // than waiting for a full retry cycle to complete matching-frame evidence.
    const retryIndex = retry++;
    const retainMethod = () => {
      // A result too old to confirm must not pin the camera to a slow method.
      if (mode === 'live' && now() - sample.capturedAt <= MAX_FRAME_AGE) retry = retryIndex;
    };
    const first = await call('decode', { image, mode, retryIndex, enhanceLive: options.cropBarcodes,
      posOptions: policyOptions() }, [image.data]);
    if (!valid()) throw aborted();
    const results = Capture.remapResults(first.results, plan);
    if (results.length) {
      retainMethod();
      return results; // Observed full-view conflicts are never hidden by a crop.
    }
    if (first.diagnostics?.incompleteEvidence) return [];
    let coverageComplete = sample.recoveryComplete !== false;
    const identities = new Set();
    for (const crop of sample.recovery) {
      // A timed-out remaining region may contain a conflicting label. Do not
      // accept the first crop merely because it was decoded before the budget.
      if (now() - started > (mode === 'live' ? 350 : 2500)) return identities.size > 1 ? results : [];
      const response = await call('decode', { image: crop.image, mode, retryIndex, enhanceLive: false,
        posOptions: policyOptions() }, [crop.image.data]);
      if (!valid()) throw aborted();
      if (response.diagnostics?.incompleteEvidence) coverageComplete = false;
      for (const result of Capture.remapResults(response.results, crop.plan)) {
        const key = JSON.stringify([result.format, result.text, result.bytes]);
        if (!identities.has(key)) { identities.add(key); results.push(result); }
      }
    }
    if (identities.size === 1 && !coverageComplete) return [];
    if (results.length) retainMethod();
    return results;
  }
  function publish(decision, analysis) {
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
      no_code: QUALITY[analysis?.hint] || 'No allowed code found. Keep one complete label in view.',
    };
    status(decision.status, messages[decision.reason] || 'Rescan the label.', decision.reason);
    return null;
  }
  function schedule(token, delay = 80) {
    if (!active || accepted || controlsPending.size || token !== generation || timer !== null || loop?.generation === token) return;
    timer = later(() => { timer = null; void scanFrame(token); }, delay);
  }
  async function scanFrame(token) {
    if (!active || accepted || controlsPending.size || generation !== token) return;
    const running = { generation: token }; loop = running;
    const currentRevision = revision;
    try {
      const id = frameId(); let selected = null;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight && id !== null && id !== lastFrame) {
        lastFrame = id;
        const capturedAt = now();
        const cameraFingerprint = Selection.cameraIdentity(video, video.videoWidth, video.videoHeight, canvas, context);
        const sample = await captureSample(video, video.videoWidth, video.videoHeight);
        if (!active || token !== generation || currentRevision !== revision || controlsPending.size) return;
        const { analysis } = sample;
        const candidate = { ...sample, analysis, capturedAt, frameId: id, revision: currentRevision, cameraFingerprint };
        emit(onCandidates, { regions: sample.proposals, sourceWidth: video.videoWidth, sourceHeight: video.videoHeight, frameId: id });
        if (!active || token !== generation || currentRevision !== revision || controlsPending.size) return;
        if (options.preferClearFrames && options.adaptiveFrameSelection && clearFrame(analysis, sample.image.width, sample.image.height)) {
          selection.reset(); selected = candidate;
        } else selected = options.preferClearFrames ? selection.push(candidate) : candidate;
        if (!selected && analysis.hint) status('scanning', QUALITY[analysis.hint] || 'Hold the label steady.');
      } else if (options.preferClearFrames) selected = selection.flush(now());
      if (selected) {
        const { analysis, capturedAt } = selected;
        const results = await decodeSample(selected, 'live');
        if (!active || accepted || token !== generation || revision !== currentRevision || selected.revision !== revision) return;
        const stale = now() - capturedAt > MAX_FRAME_AGE;
        const moreDetail = options.automaticRecovery && recovery.observe({ now: now(), frameId: selected.frameId, analysis,
          hasResults: results.length > 0, stale });
        if (stale) {
          policy.reset(); status('rescan', 'That image is too old. Hold still for a fresh scan.', 'stale_frame');
        } else {
          publish(policy.observe(results, selected.frameId, capturedAt, analysis.fingerprint, selected.cameraFingerprint), analysis);
          if (moreDetail && active && !accepted && token === generation && revision === currentRevision) {
            status('scanning', 'Trying more image detail. Keep the full label steady.', 'detail_recovery');
          }
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

  function startCamera(camera = {}, rearm = true) {
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
    if (rearm) resetEvidence(true);
    cameraChoice = { ...camera };
    const token = generation, abort = new AbortController(); operation = abort; cameraAbort = abort;
    const promise = Promise.resolve().then(async () => {
      let acquired;
      try {
        if (token !== generation || abort.signal.aborted) throw aborted();
        if (!env.isSecureContext || !env.navigator.mediaDevices?.getUserMedia) throw new Error('Camera scanning requires HTTPS or localhost and camera permission.');
        if (doc.hidden) throw new Error('Open the page before starting the camera.');
        await abortable(initialize(), abort.signal);
        // Keep normal decoding bounded, but retain source detail for occasional
        // recovery without reopening the camera or clearing confirmation.
        const highResolution = options.captureMode === 'detail' || options.automaticRecovery;
        const videoConstraints = { width: { ideal: highResolution ? 3840 : 1920 }, height: { ideal: highResolution ? 2160 : 1080 },
          ...(camera.deviceId ? { deviceId: { exact: camera.deviceId } } : { facingMode: { ideal: camera.facingMode || 'environment' } }) };
        const request = env.navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
        request.then(value => { if (token !== generation) value.getTracks().forEach(track => track.stop()); }, () => {});
        acquired = await abortable(request, abort.signal);
        controlConstraints = videoConstraints;
        stream = acquired; video.srcObject = stream; video.muted = true; video.playsInline = true;
        await abortable(video.play(), abort.signal);
        if (token !== generation) throw aborted();
        const track = stream.getVideoTracks()[0];
        const ended = () => { if (generation === token) stop(); };
        track?.addEventListener('ended', ended); trackCleanup = () => track?.removeEventListener('ended', ended);
        let cameraModes = {};
        try { cameraModes = track?.getCapabilities?.() || {}; } catch { /* Capability probing must not disable a usable camera. */ }
        const automaticModes = {};
        if (cameraModes.focusMode?.includes('continuous')) automaticModes.focusMode = 'continuous';
        if (options.automaticRecovery && cameraModes.exposureMode?.includes('continuous')) automaticModes.exposureMode = 'continuous';
        if (Object.keys(automaticModes).length) {
          try {
            const constraints = withConstraints(track, automaticModes);
            await abortable(track.applyConstraints(constraints), abort.signal);
            if (token === generation) controlConstraints = constraints;
          }
          catch (error) { if (error.name === 'AbortError') throw error; }
        }
        if (token !== generation || doc.hidden) throw aborted();
        active = true; trackFrames(token); readyStatus('Keep one complete label in view.'); schedule(token, 0);
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
  function start(camera = {}) { return startCamera(camera, true); }

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
    resetEvidence(true);
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
      const sample = await captureSample(loaded.source, loaded.width, loaded.height, true);
      if (token !== generation || currentRevision !== revision) throw aborted();
      emit(onCandidates, { regions: sample.proposals, sourceWidth: loaded.width, sourceHeight: loaded.height, frameId: 'import:1' });
      if (token !== generation || currentRevision !== revision) throw aborted();
      const results = await decodeSample(sample, 'image');
      if (token !== generation || currentRevision !== revision) throw aborted();
      return publish(policy.observe(results, 'import:1', now(), sample.analysis.fingerprint));
    } catch (error) {
      if (token === generation && error.name !== 'AbortError') { status('error', error.message); report(error); }
      throw error;
    } finally {
      loaded?.close();
      if (operation === abort) { operation = null; resetWorker(); canvas.width = canvas.height = 0; snapshot.width = snapshot.height = 0; }
    }
  }

  async function listCameras() {
    ensureUsable();
    if (!env.navigator.mediaDevices?.enumerateDevices) return [];
    const token = generation;
    const devices = await env.navigator.mediaDevices.enumerateDevices();
    if (destroyed || token !== generation) throw aborted();
    return devices.filter(device => device.kind === 'videoinput' && typeof device.deviceId === 'string' && device.deviceId)
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Camera ${index + 1}` }));
  }
  function getCameraCapabilities() {
    ensureUsable();
    return cameraCapabilities(active ? stream?.getVideoTracks()[0] : null, options.captureMode, controlValues);
  }
  function getOptions() {
    ensureUsable(); return { ...options, formats: [...options.formats], targetRegion: options.targetRegion ? { ...options.targetRegion } : null };
  }
  function withConstraints(track, update) {
    let reported = {};
    try { reported = track.getConstraints?.() || {}; } catch { /* Keep our last successfully applied constraints. */ }
    const saved = { ...controlConstraints, ...reported };
    const advanced = (Array.isArray(saved.advanced) ? saved.advanced : []).map(item => {
      const copy = { ...item }; for (const name of Object.keys(update)) delete copy[name]; return copy;
    }).filter(item => Object.keys(item).length);
    for (const name of Object.keys(update)) delete saved[name];
    return { ...saved, advanced: [...advanced, { ...update }] };
  }
  function changeConstraint(name, requested) {
    ensureUsable();
    const track = active ? stream?.getVideoTracks()[0] : null;
    if (!track || !cameraAbort) return Promise.reject(new Error('Start the camera before changing camera controls.'));
    const token = generation, abort = cameraAbort, entry = {};
    const caps = getCameraCapabilities();
    let value = requested;
    if (name === 'torch') {
      if (typeof requested !== 'boolean') return Promise.reject(new TypeError('Torch state must be true or false.'));
      if (!caps.torch.supported) return Promise.reject(new Error('Flashlight is not supported by this camera and browser.'));
    } else {
      try { value = boundedZoom(requested, caps.zoom); } catch (error) { return Promise.reject(error); }
    }
    controlsPending.add(entry); resetEvidence();
    const command = controlQueue.catch(() => {}).then(async () => {
      if (token !== generation || abort.signal.aborted) throw aborted();
      const constraints = withConstraints(track, { [name]: value });
      await abortable(track.applyConstraints(constraints), abort.signal);
      if (token !== generation || abort.signal.aborted) throw aborted();
      controlValues[name] = value;
      controlConstraints = constraints;
      return getCameraCapabilities();
    }).finally(() => {
      controlsPending.delete(entry);
      if (token === generation && !destroyed) {
        resetEvidence();
        readyStatus('Camera ready for a fresh scan.');
        schedule(token, 0);
      }
    });
    controlQueue = command.catch(() => {});
    return command;
  }
  function setTorch(enabled) { return changeConstraint('torch', enabled); }
  function setZoom(value) { return changeConstraint('zoom', value); }
  async function switchCamera(deviceId) {
    ensureUsable();
    if (typeof deviceId !== 'string' || !deviceId) throw new TypeError('Provide a camera deviceId.');
    if (!active && !startPromise) throw new Error('Start the camera before switching cameras.');
    stopInternal();
    await startCamera({ deviceId }, false);
  }
  async function setCaptureMode(mode) {
    ensureUsable();
    const next = checkedOptions({ captureMode: mode }, options);
    if (next.captureMode === options.captureMode) return;
    const reopen = active || Boolean(startPromise), choice = { ...cameraChoice };
    stopInternal(); options = next; resetEvidence();
    if (reopen) await startCamera(choice, false);
    else status('idle', 'Capture profile updated. Start the camera when ready.');
  }

  function setOptions(partial) {
    ensureUsable(); const next = checkedOptions(partial, options);
    if ((active || startPromise) && next.captureMode !== options.captureMode) throw new Error('Use await scanner.setCaptureMode() to change an active camera profile.');
    options = next; resetEvidence();
    readyStatus('Scanning options updated. Start a fresh scan.'); schedule(generation, 0);
  }
  function rescan() {
    ensureUsable(); resetEvidence(true); status(active ? 'scanning' : 'idle', 'Ready for a new scan.'); schedule(generation, 0);
  }
  function destroy() {
    if (destroyed) return;
    stopInternal(); destroyed = true;
    doc.removeEventListener('visibilitychange', pauseWhenHidden); env.removeEventListener('pagehide', stop);
    status('destroyed', 'Scanner closed.');
  }
  return Object.freeze({ start, stop, destroy, setOptions, rescan, scanImage,
    listCameras, getCameraCapabilities, getOptions, setTorch, setZoom, switchCamera, setCaptureMode });
}
