'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');
const frame = document.createElement('canvas');
const context = frame.getContext('2d', { willReadFrequently: true });
const HISTORY_KEY = 'barcode-camera.history.v1';
const REMEMBER_KEY = 'barcode-camera.remember.v1';
let stream = null, active = false, starting = false, generation = 0, torchOn = false;
let cameraControls = null;
let worker = null, workerReady = null, requestId = 0;
const pending = new Map();
let history = [], latest = null, soundContext = null, installPrompt = null, registration = null;
let storageWarning = '', durableRemember = false;
let offlineReady = false, updateRequested = false, lastAnnouncement = '', importBusy = false;
const confirmation = ScanPolicy.createConfirmation();
let scanRevision = 0, lastVideoFrame = null, misses = 0, retryIndex = 0, candidateCrop = null, lastAcceptedAt = 0;
let videoFrameCallbackId = null, presentedFrame = null, trackingPresentedFrames = false;
const POS_NAMES = ['ean13', 'upca', 'code128', 'qr', 'ean8', 'upce', 'datamatrix', 'aztec', 'pdf417', 'code93'];
let posConfirmation = null, frameSelection = null;

function posOptions() {
  if (!$('pos-mode').checked) return undefined;
  return PosPolicy.validateOptions({
    allowedFormats: POS_NAMES.filter(name => $(`pos-format-${name}`).checked),
    confirmationFrames: Number($('pos-confirmation').value),
  });
}

function applyScanOptions() {
  resetScanEvidence(); dismissError();
  $('pos-settings').hidden = !$('pos-mode').checked;
  $('pos-status').hidden = !$('pos-mode').checked;
  $('rescan').hidden = !$('pos-mode').checked;
  try {
    const options = posOptions();
    posConfirmation = options ? PosPolicy.createConfirmation(options) : null;
    if (options) setPosStatus('rescan', options.confirmationFrames === 1
      ? 'Single-frame POS mode. Conflicting codes still require a rescan.'
      : `Waiting for one code to agree across ${options.confirmationFrames} distinct frames.`);
  } catch {
    posConfirmation = null;
    stopCamera('Choose at least one POS format, then start the camera.');
    setPosStatus('rescan', 'Choose at least one barcode format in Scanning options.');
    showError('Choose at least one barcode format in Scanning options.');
  }
}

function setPosStatus(state, message) {
  $('pos-status').setAttribute('data-state', state);
  $('pos-status').textContent = message;
}

function qualityHint(analysis) {
  return {
    dark: 'Add light or try the flashlight.',
    'low-detail': 'Hold still and let the camera focus on the code.',
    glare: 'Try a slight tilt to reduce possible glare.',
    small: 'Move closer while keeping the whole code and its border visible.',
    clipped: 'Move back slightly to include the entire code and its border.',
  }[analysis?.hint] || 'Hold the code steady in view';
}

function resetScanEvidence() {
  scanRevision += 1; confirmation.reset(); lastVideoFrame = null;
  posConfirmation?.reset(); frameSelection?.reset();
  misses = 0; retryIndex = 0; candidateCrop = null; lastAcceptedAt = performance.now();
}

function stopFrameTracking() {
  if (videoFrameCallbackId !== null) video.cancelVideoFrameCallback?.(videoFrameCallbackId);
  videoFrameCallbackId = null; presentedFrame = null; trackingPresentedFrames = false;
}

function startFrameTracking(token) {
  stopFrameTracking();
  if (typeof video.requestVideoFrameCallback !== 'function') return;
  trackingPresentedFrames = true;
  let callbackCount = 0;
  const observe = (_now, metadata) => {
    if (!active || token !== generation) return;
    callbackCount += 1;
    presentedFrame = Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : callbackCount;
    videoFrameCallbackId = video.requestVideoFrameCallback(observe);
  };
  videoFrameCallbackId = video.requestVideoFrameCallback(observe);
}

function currentVideoFrame() {
  if (trackingPresentedFrames) return presentedFrame === null ? null : `presented:${presentedFrame}`;
  try {
    const count = video.getVideoPlaybackQuality?.().totalVideoFrames;
    if (Number.isFinite(count)) return `decoded:${count}`;
  } catch { /* Older camera implementations may not expose frame counters. */ }
  // Compatibility fallback only: a playback clock cannot prove a new frame was presented.
  return `clock:${video.currentTime}`;
}

function showError(message) { $('error-text').textContent = message; $('error').hidden = false; }
function dismissError() { $('error').hidden = true; }
$('dismiss-error').addEventListener('click', dismissError);

function resetWorker(reason = 'Scanner stopped. Please try again.') {
  if (worker) worker.terminate();
  worker = null; workerReady = null;
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(reason)); }
  pending.clear();
}

function workerCall(type, extra = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => resetWorker('The scanner took too long. Try again with a smaller image or restart the camera.'), type === 'init' ? 30000 : 12000);
    pending.set(id, { resolve, reject, timer });
    try { worker.postMessage({ id, type, ...extra }, transfer); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

async function initializeScanner() {
  if (!workerReady) {
    try {
      worker = new Worker(new URL('./scanner-worker.js', location.href));
      worker.onmessage = ({ data }) => {
        const entry = pending.get(data.id);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(data.id);
        if (data.type === 'error') entry.reject(new Error(data.message));
        else entry.resolve(data);
      };
      worker.onerror = () => resetWorker('The scanner could not load. Reconnect once to prepare offline access, then try again.');
      workerReady = workerCall('init').catch((error) => { resetWorker(error.message); throw error; });
    } catch (error) { resetWorker(); throw error; }
  }
  return workerReady;
}

function renderControls() {
  $('start').disabled = importBusy;
  $('start').querySelector('span').textContent = starting ? 'Cancel camera' : active ? 'Stop camera' : 'Start camera';
  $('choose-image').disabled = starting || importBusy;
  $('camera-select').disabled = starting || importBusy;
  $('rescan').disabled = starting || importBusy;
  $('camera-state').textContent = starting ? 'Opening camera' : active ? 'Camera live' : 'Camera is off';
  $('video').hidden = !active;
  $('camera-placeholder').hidden = active;
  $('camera-stage').classList.toggle('live', active);
  for (const id of ['pos-mode', 'better-frames', 'target-crops', 'pos-confirmation', ...POS_NAMES.map(name => `pos-format-${name}`)]) {
    $(id).disabled = starting || importBusy;
  }
}

function stopCamera(description) {
  generation += 1;
  resetScanEvidence();
  active = false; starting = false; cameraControls = null;
  stopFrameTracking();
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null; video.srcObject = null;
  torchOn = false; $('torch').disabled = true; $('torch').setAttribute('aria-pressed', 'false');
  $('zoom-control').hidden = true; $('overlay').replaceChildren();
  $('scan-hint').textContent = 'QR codes, product barcodes, and more';
  if (description) $('engine-status').textContent = description;
  renderControls();
}

function cameraError(error) {
  const messages = {
    NotAllowedError: 'Camera access was not allowed. Enable camera permission for this site in your browser settings, then tap Start camera.',
    NotFoundError: 'No camera was found. Connect a camera or choose Scan image.',
    NotReadableError: 'The camera is busy or unavailable. Close other apps using it, then try again.',
    OverconstrainedError: 'This camera does not support the requested settings. Try a different camera.',
    SecurityError: 'Camera access needs HTTPS or localhost. Open the hosted HTTPS address in your browser.',
    AbortError: 'The camera was interrupted. Tap Start camera to try again.',
  };
  return messages[error.name] || error.message || 'Could not start the camera. Try again or choose Scan image.';
}

async function startCamera(deviceId) {
  if (starting || importBusy) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showError('Camera scanning needs HTTPS or localhost in a supported browser. Open your hosted HTTPS link, or choose Scan image.');
    return;
  }
  stopCamera(); dismissError(); starting = true; renderControls();
  const token = generation;
  if ($('sound').checked) enableSound();
  let acquired;
  try {
    const options = posOptions();
    posConfirmation = options ? PosPolicy.createConfirmation(options) : null;
    await initializeScanner();
    if (token !== generation) return;
    const constraints = { audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }) } };
    acquired = await navigator.mediaDevices.getUserMedia(constraints);
    if (token !== generation || document.hidden) { acquired.getTracks().forEach((track) => track.stop()); return; }
    stream = acquired; video.srcObject = stream;
    await video.play();
    if (token !== generation) { acquired.getTracks().forEach((track) => track.stop()); return; }
    active = true;
    startFrameTracking(token);
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => { if (stream?.getVideoTracks()[0] === track) stopCamera('Camera disconnected. Tap Start camera to reconnect.'); });
    cameraControls = CameraConstraints.create(track, constraints.video, () => token === generation && stream?.getVideoTracks()[0] === track);
    const controls = cameraControls, capabilities = controls.capabilities();
    if (capabilities.focusMode?.includes('continuous')) {
      try { await controls.change({ focusMode: 'continuous' }); }
      catch { /* Some browsers expose focus controls that the active camera cannot apply. */ }
      if (token !== generation) return;
    }
    $('torch').disabled = !capabilities.torch;
    if (capabilities.zoom && capabilities.zoom.max > capabilities.zoom.min) {
      const zoom = $('zoom');
      zoom.min = capabilities.zoom.min; zoom.max = Math.min(capabilities.zoom.max, Math.max(6, capabilities.zoom.min));
      zoom.step = capabilities.zoom.step || 0.1; zoom.value = controls.settings().zoom || capabilities.zoom.min;
      $('zoom-control').hidden = false;
    }
    $('engine-status').textContent = 'Scanning on this device. No camera images are uploaded.';
    $('scan-hint').textContent = 'Hold the code steady in view';
    await listCameras(controls.settings().deviceId, token);
    if (token === generation) scanFrame(token);
  } catch (error) {
    acquired?.getTracks().forEach((track) => track.stop());
    if (token === generation) { stopCamera(); showError(cameraError(error)); }
  } finally { if (token === generation) { starting = false; renderControls(); } }
}

async function listCameras(selected, token = generation) {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === 'videoinput');
    if (token !== generation) return;
    const select = $('camera-select'); select.replaceChildren();
    devices.forEach((device, index) => { const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `Camera ${index + 1}`; select.append(option); });
    if (selected) select.value = selected;
    $('camera-settings').hidden = !devices.length;
  } catch { /* Scanning can continue when device enumeration is unavailable. */ }
}

function capture(source, width, height, options = {}) {
  const plan = ScanPolicy.capturePlan(width, height, options);
  frame.width = plan.width; frame.height = plan.height;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, frame.width, frame.height);
  context.drawImage(source, plan.x, plan.y, plan.cropWidth, plan.cropHeight, 0, 0, frame.width, frame.height);
  const image = context.getImageData(0, 0, frame.width, frame.height);
  return { image: { width: image.width, height: image.height, data: image.data.buffer }, plan };
}

async function scanFrame(token) {
  if (!active || token !== generation) return;
  try {
    const frameId = currentVideoFrame();
    const revision = scanRevision;
    const options = posOptions();
    const better = $('better-frames').checked;
    const crops = $('target-crops').checked;
    let selected = null;
    if (video.readyState >= 2 && video.videoWidth && frameId !== null && frameId !== lastVideoFrame) {
      const capturedAt = performance.now();
      const width = video.videoWidth, height = video.videoHeight;
      lastVideoFrame = frameId;
      // POS and region retries always see the full image before any crop.
      const fraction = options || better || crops ? 1 : candidateCrop ?? ScanPolicy.cropFraction(misses);
      const { image, plan } = capture(video, width, height, { fraction, maxPixels: 2_100_000 });
      // Analysis bounds its internal thumbnail but measures source-image detail
      // and fingerprints all captured pixels. Never analyze a later video frame.
      const analysis = better || options ? FrameAnalysis.analyze(image) : null;
      const candidate = { image, plan, width, height, frameId, capturedAt, analysis, revision };
      if (better) {
        frameSelection ||= CaptureSelection.create();
        selected = frameSelection.push(candidate);
        $('scan-hint').textContent = qualityHint(analysis);
      } else selected = candidate;
    } else if (better) selected = frameSelection?.flush(performance.now());
    if (selected) {
      const { image, plan, width, height, frameId, capturedAt, analysis } = selected;
      const reply = await workerCall('decode', { image, mode: 'live', retryIndex,
        enhanceLive: crops, ...(options ? { posOptions: options } : {}) }, [image.data]);
      const { results } = reply;
      if (!active || token !== generation) return;
      // Discard captures from before settings changes, including buffered frames.
      if (revision === scanRevision && selected.revision === scanRevision) {
        const mapped = ScanPolicy.remapResults(results, plan);
        let accepted, conflictHint = null;
        if (options) {
          if (performance.now() - capturedAt > 1200) {
            posConfirmation.reset();
            accepted = [];
            setPosStatus('rescan', 'That frame is too old. Hold still for a fresh scan.');
          } else {
            const decision = posConfirmation.observe(mapped, frameId, capturedAt, reply.analysis?.fingerprint || analysis?.fingerprint);
            accepted = decision.results;
            const messages = {
              conflicting_values: 'Conflicting codes. Isolate one label, then start a new scan.',
              unreliable_frames: 'Fresh frames could not be verified. Try another browser or choose single-frame confirmation.',
              insufficient_confirmation: `Hold steady: ${decision.matchedFrames} of ${decision.requiredFrames} matching frames.`,
              no_code: 'No allowed code found. Keep one complete label in view.',
              single_match: 'One code confirmed. Check its product in your POS catalogue.',
              frame_agreement: 'Code confirmed across distinct frames. Check its product in your POS catalogue.',
            };
            setPosStatus(decision.status, messages[decision.reason] || 'Rescan this label.');
            if (decision.status === 'ambiguous') conflictHint = 'Conflicting readings. Isolate one label and rescan.';
          }
        } else accepted = confirmation.observe(mapped, frameId, capturedAt);
        drawPositions(accepted, width, height);
        if (accepted.length) {
          handleResults(accepted); lastAcceptedAt = performance.now();
          posConfirmation?.reset();
          misses = 0; retryIndex = 0; candidateCrop = null;
          $('scan-hint').textContent = `${accepted.length > 1 ? accepted.length + ' codes' : 'Code'} confirmed. Ready for the next.`;
        } else if (results.length) {
          // Keep the successful crop and retry strategy for the next independent camera frame.
          candidateCrop = plan.fraction;
          $('scan-hint').textContent = 'Hold steady to confirm the code';
        } else {
          misses += 1; retryIndex += 1; candidateCrop = null;
          const elapsed = performance.now() - lastAcceptedAt;
          if ((reply.analysis || analysis)?.hint) $('scan-hint').textContent = qualityHint(reply.analysis || analysis);
          else if (elapsed > 8000) $('scan-hint').textContent = 'Try another angle or more light. Keep the whole code visible.';
          else if (elapsed > 3500) $('scan-hint').textContent = 'Move closer and hold steady, keeping the code’s border visible.';
          else $('scan-hint').textContent = 'Hold the code steady in view';
        }
        if (conflictHint) $('scan-hint').textContent = conflictHint;
      }
    }
  } catch (error) {
    if (token === generation) { stopCamera(); showError(error.message); }
    return;
  }
  if (active && token === generation) setTimeout(() => scanFrame(token), $('better-frames').checked ? 80 : 180);
}

function drawPositions(results, width, height) {
  const overlay = $('overlay'); overlay.setAttribute('viewBox', `0 0 ${width} ${height}`); overlay.replaceChildren();
  for (const { position } of results) {
    if (!position) continue;
    const corners = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'].map((key) => position[key]);
    if (corners.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue;
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', corners.map(({ x, y }) => `${x},${y}`).join(' '));
    polygon.setAttribute('vector-effect', 'non-scaling-stroke'); overlay.append(polygon);
  }
}

function formatName(value) { return ({ QRCode: 'QR code', Code128: 'Code 128', EAN13: 'EAN-13', UPCA: 'UPC-A', DataMatrix: 'Data Matrix' })[value] || value; }
function displayValue(result) { return result.text || `Binary barcode (${result.bytes?.length || 0} bytes)`; }
function keyFor(result) { return JSON.stringify([ScanPolicy.keyFor(result), result.text]); }
function timeLabel(timestamp) { return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

function handleResults(results) {
  let changed = false;
  for (const result of results) {
    const key = keyFor(result);
    if (history.some((item) => keyFor(item) === key)) continue;
    history.unshift({ ...result, timestamp: Date.now() }); changed = true;
  }
  history = history.slice(0, 100);
  const first = results[0];
  const entry = history.find((item) => keyFor(item) === keyFor(first));
  if (entry && (!latest || keyFor(latest) !== keyFor(entry))) showLatest(entry);
  if (changed) {
    renderHistory(); saveHistory(); playSound();
    const message = `Scanned ${formatName(first.format)}: ${displayValue(first)}`;
    if (message !== lastAnnouncement) { $('scan-announcement').textContent = message; lastAnnouncement = message; }
    $('scan-hint').textContent = `${results.length > 1 ? results.length + ' codes' : 'Code'} found. Ready for the next.`;
  }
}

function showLatest(entry) {
  latest = entry; $('result-empty').hidden = true; $('result-data').hidden = false;
  $('result-format').hidden = false; $('result-format').textContent = formatName(entry.format);
  $('result-text').textContent = displayValue(entry); $('result-time').textContent = `Scanned at ${timeLabel(entry.timestamp)}`;
  $('copy-latest').textContent = 'Copy value';
}

function renderHistory() {
  $('scan-count').textContent = history.length;
  $('history-empty').hidden = history.length > 0;
  $('clear').disabled = $('export').disabled = !history.length;
  const list = $('history-list'); list.replaceChildren();
  for (const entry of history) {
    const item = document.createElement('li'), button = document.createElement('button');
    button.className = 'history-item'; button.type = 'button';
    const value = document.createElement('span'); value.className = 'history-value'; value.textContent = displayValue(entry);
    const meta = document.createElement('span'); meta.className = 'history-meta';
    const format = document.createElement('span'); format.textContent = formatName(entry.format);
    const time = document.createElement('span'); time.textContent = timeLabel(entry.timestamp);
    meta.append(format, time); button.append(value, meta); button.addEventListener('click', () => showLatest(entry));
    item.append(button); list.append(item);
  }
}

function saveHistory() {
  if (!$('remember').checked) return;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); storageWarning = ''; }
  catch { storageWarning = 'History changes could not be saved. Previously saved scans may remain on this device. Export to keep the history shown here.'; }
  updateStorageNote();
}

function loadHistory() {
  try {
    durableRemember = localStorage.getItem(REMEMBER_KEY) === 'true';
    $('remember').checked = durableRemember;
    if ($('remember').checked) {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (Array.isArray(saved)) history = saved.filter((item) => item && typeof item.text === 'string' && typeof item.format === 'string' && Number.isFinite(item.timestamp) && item.text.length <= 10000 && (!item.bytes || (Array.isArray(item.bytes) && item.bytes.length <= 10000))).slice(0, 100);
    }
    else if (localStorage.getItem(HISTORY_KEY)) storageWarning = 'Saving new scans is off. Previously saved history is still on this device; turn Remember on, then off to retry removing it.';
  } catch { history = []; storageWarning = 'Saved history could not be read. Previous scans may still be stored on this device.'; }
  if (history.length) showLatest(history[0]);
  renderHistory(); updateStorageNote();
}
function updateStorageNote() { $('storage-note').textContent = storageWarning || ($('remember').checked ? 'History is saved only in this browser.' : 'History clears when you close this page.'); }

function enableSound() {
  try { soundContext ||= new (window.AudioContext || window.webkitAudioContext)(); soundContext.resume().catch(() => {}); } catch { /* Sound is optional. */ }
}
function playSound() {
  if (!$('sound').checked || !soundContext || soundContext.state !== 'running') return;
  const oscillator = soundContext.createOscillator(), gain = soundContext.createGain();
  oscillator.connect(gain); gain.connect(soundContext.destination); oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.06, soundContext.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, soundContext.currentTime + 0.1);
  oscillator.start(); oscillator.stop(soundContext.currentTime + 0.12);
}

async function scanImage(file) {
  if (!file || importBusy || starting) return;
  stopCamera(); dismissError(); importBusy = true; renderControls();
  const token = generation, revision = scanRevision;
  $('engine-status').textContent = 'Reading the image on this device…';
  let objectUrl;
  try {
    const options = posOptions();
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB.');
    if (!/image\/(png|jpeg|webp)/.test(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
    await initializeScanner();
    if (token !== generation || revision !== scanRevision) return;
    const source = new Image(); objectUrl = URL.createObjectURL(file);
    await new Promise((resolve, reject) => { source.onload = resolve; source.onerror = () => reject(new Error('This image could not be opened. Try a PNG or JPEG.')); source.src = objectUrl; });
    if (token !== generation || revision !== scanRevision) return;
    if (source.naturalWidth * source.naturalHeight > 20_000_000) throw new Error('Choose an image under 20 megapixels.');
    const { image } = capture(source, source.naturalWidth, source.naturalHeight, { maxSide: 3072 });
    const identity = options ? FrameAnalysis.analyze(image).fingerprint : null;
    const { results } = await workerCall('decode', { image, mode: 'image', enhanceLive: $('target-crops').checked,
      ...(options ? { posOptions: options } : {}) }, [image.data]);
    if (token !== generation || revision !== scanRevision) return;
    if (options) {
      const decision = PosPolicy.createConfirmation(options).observe(results, 'image:1', performance.now(), identity);
      if (decision.status === 'confirmed') {
        handleResults(decision.results);
        setPosStatus('confirmed', 'One code confirmed from this image. Check its product in your POS catalogue.');
      } else if (decision.status === 'ambiguous') setPosStatus('ambiguous', 'Conflicting codes in this image. Isolate one label and rescan.');
      else if (decision.reason === 'insufficient_confirmation') setPosStatus('rescan', 'One image cannot confirm across frames. Use the camera, or select single-frame confirmation.');
      else setPosStatus('rescan', 'No allowed code found. Try a clearer image of the whole label.');
      $('engine-status').textContent = 'POS image check complete. Nothing was uploaded.';
    }
    else if (results.length) { handleResults(results); $('engine-status').textContent = `Found ${results.length} ${results.length === 1 ? 'code' : 'codes'} in your image. Nothing was uploaded.`; }
    else { $('engine-status').textContent = 'No barcode found. Try a sharper image with the entire code and its border visible.'; }
  } catch (error) {
    if (token === generation && revision === scanRevision) {
      showError(error.message); $('engine-status').textContent = 'Choose another image or start the camera.';
    }
  }
  finally { if (objectUrl) URL.revokeObjectURL(objectUrl); $('image-file').value = ''; importBusy = false; renderControls(); }
}

function updateOfflineLabel() {
  $('offline-state').className = 'offline-state' + (offlineReady ? ' ready' : '');
  $('offline-label').textContent = offlineReady ? (navigator.onLine ? 'Offline ready' : 'Offline · Ready to scan') : 'Preparing offline access…';
}

async function checkOffline(repair = false) {
  const target = registration?.active || navigator.serviceWorker?.controller;
  if (!target) return;
  const status = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve({ ready: false }); }, repair ? 45000 : 4000);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data); };
    target.postMessage({ type: repair ? 'REPAIR_OFFLINE' : 'OFFLINE_STATUS' }, [channel.port2]);
  });
  offlineReady = status.ready === true && status.features?.includes('live-pos') === true; updateOfflineLabel();
  if (!offlineReady) { $('offline-label').textContent = 'Offline access not ready'; $('offline-state').classList.add('failed'); }
}

function checkUpdate() { $('update-banner').hidden = !registration?.waiting; }

async function setupOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    $('offline-label').textContent = 'Offline access unavailable'; $('offline-state').classList.add('failed'); return;
  }
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    checkUpdate();
    const watch = (installing) => {
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'activated') checkOffline();
        if (installing.state === 'installed') { setTimeout(checkUpdate, 50); if (registration.active) checkOffline(); }
        if (installing.state === 'redundant' && !registration.active) { $('offline-label').textContent = 'Offline download failed'; $('offline-state').classList.add('failed'); }
      });
    };
    watch(registration.installing); registration.addEventListener('updatefound', () => watch(registration.installing));
    if (registration.active) await checkOffline();
    navigator.serviceWorker.ready.then(() => checkOffline());
  } catch { $('offline-label').textContent = 'Offline setup unavailable'; $('offline-state').classList.add('failed'); }
}

$('start').addEventListener('click', () => active || starting ? stopCamera('Camera stopped. Tap Start camera when you’re ready.') : startCamera($('camera-select').value || undefined));
for (const id of ['pos-mode', 'better-frames', 'target-crops', 'pos-confirmation', ...POS_NAMES.map(name => `pos-format-${name}`)]) {
  $(id).addEventListener('change', applyScanOptions);
}
$('rescan').addEventListener('click', () => {
  applyScanOptions(); $('overlay').replaceChildren();
  $('scan-hint').textContent = 'Keep one complete label in view';
});
$('camera-select').addEventListener('change', () => { if (active) startCamera($('camera-select').value); });
$('torch').addEventListener('click', async () => {
  const track = stream?.getVideoTracks()[0], controls = cameraControls; if (!track || !controls) return;
  resetScanEvidence();
  try {
    const settings = await controls.change(current => ({ torch: !current.torch }));
    if (stream?.getVideoTracks()[0] !== track) return;
    resetScanEvidence(); torchOn = settings.torch === true; $('torch').setAttribute('aria-pressed', String(torchOn));
    if (Number.isFinite(settings.zoom)) $('zoom').value = settings.zoom;
  }
  catch (error) { if (stream?.getVideoTracks()[0] === track && error.name !== 'AbortError') showError('This camera could not change its flashlight setting.'); }
});
$('zoom').addEventListener('input', async () => {
  const track = stream?.getVideoTracks()[0], controls = cameraControls; if (!track || !controls) return;
  resetScanEvidence();
  try {
    const settings = await controls.change({ zoom: Number($('zoom').value) });
    if (stream?.getVideoTracks()[0] !== track) return;
    resetScanEvidence();
    if (Number.isFinite(settings.zoom)) $('zoom').value = settings.zoom;
    torchOn = settings.torch === true; $('torch').setAttribute('aria-pressed', String(torchOn));
  }
  catch (error) { if (stream?.getVideoTracks()[0] === track && error.name !== 'AbortError') showError('This camera could not change its zoom setting.'); }
});
$('choose-image').addEventListener('click', () => { if ($('sound').checked) enableSound(); $('image-file').click(); });
$('image-file').addEventListener('change', () => scanImage($('image-file').files[0]));
$('sound').addEventListener('change', () => { if ($('sound').checked) enableSound(); });
$('remember').addEventListener('change', () => {
  const requested = $('remember').checked;
  try {
    localStorage.setItem(REMEMBER_KEY, String(requested)); durableRemember = requested;
    storageWarning = '';
    if (requested) saveHistory();
    else {
      try { localStorage.removeItem(HISTORY_KEY); }
      catch { storageWarning = 'Saving new scans is off, but previously saved history could not be removed. It remains on this device. Turn Remember on, then off to retry.'; showError(storageWarning); }
    }
  } catch {
    // A failed preference write does not erase the existing durable preference.
    try { durableRemember = localStorage.getItem(REMEMBER_KEY) === 'true'; } catch { /* Keep the last known durable state. */ }
    $('remember').checked = durableRemember;
    storageWarning = 'The Remember preference could not be changed. Previously saved scans may remain on this device.';
    showError(storageWarning);
  }
  updateStorageNote();
});
$('copy-latest').addEventListener('click', async () => {
  if (!latest) return;
  try { await navigator.clipboard.writeText(latest.text || btoa(String.fromCharCode(...(latest.bytes || [])))); $('copy-latest').textContent = 'Copied'; }
  catch { $('result-text').focus(); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents($('result-text')); selection.removeAllRanges(); selection.addRange(range); showError('Copy permission was unavailable. The value is selected so you can copy it manually.'); }
});
$('clear').addEventListener('click', () => {
  history = []; latest = null; lastAnnouncement = ''; renderHistory(); saveHistory();
  $('result-empty').hidden = false; $('result-data').hidden = true; $('result-format').hidden = true; $('scan-announcement').textContent = storageWarning ? 'History cleared from this page. Device storage could not be updated.' : 'Scan history cleared.';
});
$('export').addEventListener('click', () => {
  const cell = (value) => '"' + String(value).replace(/^[=+@\-\t\r]/, (match) => "'" + match).replaceAll('"', '""') + '"';
  const rows = [['format', 'value', 'scanned_at'], ...history.map((item) => [item.format, item.text || 'base64:' + btoa(String.fromCharCode(...(item.bytes || []))), new Date(item.timestamp).toISOString()])];
  const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map((row) => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'barcode-scans.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('retry-offline').addEventListener('click', async () => {
  $('retry-offline').disabled = true;
  $('retry-offline').textContent = 'Preparing offline files…';
  try {
    if (registration) { await registration.update().catch(() => {}); await checkOffline(navigator.onLine); }
    else await setupOffline();
  } finally { $('retry-offline').disabled = false; $('retry-offline').textContent = 'Check offline readiness'; }
});
$('update').addEventListener('click', () => { if (!registration?.waiting) return; updateRequested = true; stopCamera(); registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' }); });
navigator.serviceWorker?.addEventListener('controllerchange', () => { if (updateRequested) location.reload(); else checkOffline(); });
window.addEventListener('online', () => { updateOfflineLabel(); checkOffline(); });
window.addEventListener('offline', () => { updateOfflineLabel(); checkOffline(); });
window.addEventListener('pageshow', () => { if (registration) checkOffline(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (active || starting)) stopCamera('Camera paused while the app was in the background. Tap Start camera to resume.'); });
window.addEventListener('pagehide', () => { stopCamera(); resetWorker(); });
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').addEventListener('click', async () => { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('install').hidden = true; });
window.addEventListener('appinstalled', () => { $('install').hidden = true; installPrompt = null; });
loadHistory(); setupOffline();
