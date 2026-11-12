'use strict';
const $ = (id) => document.getElementById(id);
const policy = Code128LabPolicy;
const video = $('video');
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
let camera = null, opening = false, cameraGeneration = 0, torch = false;
let worker = null, workerReady = null, sequence = 0, trial = null, trialStarting = false, trialReport = null, trialGeneration = 0;
let recording = null, capturing = false, frameCallback = null, presentedFrame = null, lastFrame = null;
let latestFrameIdentitySource = 'unavailable', workerTimer = null, loopTimer = null;
let prepared = [], registration = null, reloadForUpdate = false;
const pending = new Map();
const cameraMessages = {
  NotAllowedError: 'Camera permission was not allowed. Enable it for this site, then open the camera again.',
  NotFoundError: 'No camera was found on this device.',
  NotReadableError: 'The camera is busy. Close another app using it and try again.',
  OverconstrainedError: 'That camera cannot use the requested settings. Choose another camera.',
};
function error(message) { $('error-message').textContent = message; $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function details() {
  const label = policy.label({ text: $('expected').value, negative: $('negative').checked, groupId: $('group-id').value,
    split: $('split').value, device: $('device').value,
    conditions: Array.from($('conditions').querySelectorAll('input:checked'), (input) => input.value) });
  if (prepared.some((sample) => sample.metadata.groupId === label.groupId && sample.metadata.split !== label.split)) throw new Error('This group already has a different split in the prepared samples. Keep related samples in one split.');
  return label;
}
function labelReady() { try { details(); return true; } catch { return false; } }
function controls() {
  const locked = !!trial || trialStarting || !!recording || capturing;
  $('camera-toggle').disabled = opening || capturing;
  $('camera-toggle').textContent = opening ? 'Opening camera…' : camera ? 'Close camera' : 'Open camera';
  $('capture-photo').disabled = !camera || locked || !labelReady();
  $('capture-video').disabled = !camera || !!trial || trialStarting || capturing || (!recording && !labelReady());
  $('capture-video').textContent = recording ? 'Finish recording' : 'Record 10 seconds';
  $('trial-toggle').disabled = !camera || opening || trialStarting || !!recording || capturing || (!trial && !labelReady());
  $('trial-toggle').textContent = trialStarting ? 'Loading engines…' : trial ? 'Stop comparison' : 'Start comparison';
  for (const input of $('sample-form').querySelectorAll('input,select')) input.disabled = locked;
  $('expected').disabled = locked || $('negative').checked;
  $('camera-select').disabled = locked || opening;
  $('zoom').disabled = locked;
  $('torch').disabled = locked;
  $('camera-state').textContent = opening ? 'Opening camera' : camera ? 'Camera live' : 'Camera off';
  video.hidden = !camera; $('camera-placeholder').hidden = !!camera;
  if (camera && !locked && !trialReport) {
    try { details(); $('trial-state').textContent = 'Label details are ready. Start a comparison when the target is in view.'; }
    catch (cause) { $('trial-state').textContent = cause.message; }
  }
}
function trackFrames(token) {
  presentedFrame = null;
  if (!video.requestVideoFrameCallback) return;
  const next = (_, metadata) => {
    if (token !== cameraGeneration || !camera) return;
    presentedFrame = metadata.presentedFrames;
    frameCallback = video.requestVideoFrameCallback(next);
  };
  frameCallback = video.requestVideoFrameCallback(next);
}
function frameIdentity() {
  if (video.requestVideoFrameCallback) { latestFrameIdentitySource = 'presentedFrames'; return presentedFrame; }
  const quality = video.getVideoPlaybackQuality?.();
  if (quality && Number.isFinite(quality.totalVideoFrames)) { latestFrameIdentitySource = 'decodedFrames'; return quality.totalVideoFrames || null; }
  // A timestamp is not enough to prove distinct images. Refuse a misleading
  // comparison on older browsers; photo/video collection remains available.
  latestFrameIdentitySource = 'unavailable'; return null;
}
function stopCamera(message = 'Camera closed.') {
  cameraGeneration++;
  stopTrial('Comparison stopped when the camera closed.');
  if (trialStarting) resetWorker('Camera closed before the comparison started.');
  if (recording) finishRecording(true);
  if (frameCallback !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameCallback);
  frameCallback = null; presentedFrame = null;
  camera?.getTracks().forEach((track) => track.stop()); camera = null; video.srcObject = null; torch = false;
  $('camera-options').hidden = true; $('camera-message').textContent = message; controls();
}
async function openCamera(deviceId) {
  if (opening || capturing) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { error('Open this page over HTTPS or localhost in a browser with camera support.'); return; }
  stopCamera(); clearError(); opening = true; controls();
  const token = cameraGeneration;
  let acquired;
  try {
    acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }) } });
    if (token !== cameraGeneration || document.hidden) { acquired.getTracks().forEach((t) => t.stop()); return; }
    camera = acquired; video.srcObject = acquired; await video.play();
    if (token !== cameraGeneration) { acquired.getTracks().forEach((t) => t.stop()); return; }
    const track = camera.getVideoTracks()[0], capabilities = track.getCapabilities?.() || {};
    for (const key of ['focusMode', 'exposureMode']) {
      if (capabilities[key]?.includes('continuous')) {
        try { await track.applyConstraints({ advanced: [{ [key]: 'continuous' }] }); } catch { /* Optional camera capability. */ }
      }
    }
    if (token !== cameraGeneration) return;
    track.addEventListener('ended', () => { if (camera?.getVideoTracks()[0] === track) stopCamera('Camera disconnected. Open it again to continue.'); });
    trackFrames(token);
    $('torch').hidden = !capabilities.torch;
    $('torch').setAttribute('aria-pressed', 'false');
    $('zoom-wrap').hidden = !capabilities.zoom;
    if (capabilities.zoom) {
      const zoom = $('zoom'); zoom.min = capabilities.zoom.min; zoom.max = Math.min(capabilities.zoom.max, Math.max(6, capabilities.zoom.min));
      zoom.step = capabilities.zoom.step || 0.1; zoom.value = track.getSettings().zoom || capabilities.zoom.min;
    }
    try {
      const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((entry) => entry.kind === 'videoinput');
      $('camera-select').replaceChildren();
      cameras.forEach((entry, index) => { const option = document.createElement('option'); option.value = entry.deviceId; option.textContent = entry.label || `Camera ${index + 1}`; $('camera-select').append(option); });
      $('camera-select').value = track.getSettings().deviceId || cameras[0]?.deviceId || '';
    } catch { /* The existing camera stays usable. */ }
    $('camera-options').hidden = false;
    $('camera-message').textContent = 'Camera frames stay on this device. Enter the known value and label details before saving a sample.';
    $('trial-state').textContent = 'Complete the label details, then start a comparison.';
  } catch (cause) { acquired?.getTracks().forEach((track) => track.stop()); if (token === cameraGeneration) { stopCamera(); error(cameraMessages[cause.name] || cause.message); } }
  finally { opening = false; controls(); }
}
function paint(target = canvas, targetContext = context) {
  if (!camera || video.readyState < 2) throw new Error('Wait until the camera preview is visible.');
  const size = policy.captureSize(video.videoWidth, video.videoHeight);
  if (target.width !== size.width || target.height !== size.height) { target.width = size.width; target.height = size.height; }
  targetContext.drawImage(video, 0, 0, size.width, size.height);
  return size;
}
function sampleIdentity(extension) {
  const stamp = new Date().toISOString();
  const id = `sample-${stamp.replace(/[^0-9]/g, '')}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;
  return { id, path: `${id}.${extension}`, capturedAt: stamp };
}
function prepareSample(blob, metadata) {
  const mediaURL = URL.createObjectURL(blob);
  const metadataURL = URL.createObjectURL(new Blob([JSON.stringify(metadata, null, 2) + '\n'], { type: 'application/json' }));
  prepared.unshift({ blob, metadata, mediaURL, metadataURL });
  while (prepared.length > 8 || prepared.reduce((total, item) => total + item.blob.size, 0) > 150 * 1024 * 1024) {
    const previous = prepared.pop(); URL.revokeObjectURL(previous.mediaURL); URL.revokeObjectURL(previous.metadataURL);
  }
  renderSamples();
}
function renderSamples() {
  $('samples-empty').hidden = !!prepared.length; $('sample-count').textContent = `${prepared.length} prepared`;
  $('samples-list').replaceChildren();
  for (const sample of prepared) {
    const item = document.createElement('li'), info = document.createElement('div'), name = document.createElement('strong'), extra = document.createElement('span');
    name.textContent = sample.metadata.negative ? 'Negative scene' : sample.metadata.expected[0].text;
    extra.textContent = `${sample.metadata.mediaType} · ${sample.metadata.groupId} · ${sample.metadata.split} · ${(sample.blob.size / 1024).toFixed(0)} KB`;
    info.append(name, extra);
    const links = document.createElement('div'); links.className = 'sample-links';
    for (const [label, href, filename] of [['Save media', sample.mediaURL, sample.metadata.path], ['Save label', sample.metadataURL, `${sample.metadata.id}.json`]]) {
      const link = document.createElement('a'); link.href = href; link.download = filename; link.textContent = label; links.append(link);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => { URL.revokeObjectURL(sample.mediaURL); URL.revokeObjectURL(sample.metadataURL); prepared = prepared.filter((entry) => entry !== sample); renderSamples(); });
    links.append(remove); item.append(info, links); $('samples-list').append(item);
  }
}
async function capturePhoto() {
  if (capturing || trial || recording) return;
  clearError(); capturing = true; controls();
  try {
    const label = details(), size = paint(), identity = sampleIdentity('png');
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not capture the photo. Try again.')), 'image/png'));
    prepareSample(blob, policy.metadata(label, { ...identity, ...size, mediaType: 'image', mimeType: blob.type, userAgent: navigator.userAgent }));
    $('camera-message').textContent = 'Photo prepared. Save both the media and label files below.';
  } catch (cause) { error(cause.message); }
  finally { capturing = false; controls(); }
}
function finishRecording(discard = false) {
  if (!recording) return;
  recording.discard ||= discard;
  clearInterval(recording.paintTimer); clearTimeout(recording.stopTimer);
  if (recording.recorder.state !== 'inactive') recording.recorder.stop();
}
function captureVideo() {
  if (recording) { finishRecording(); return; }
  clearError();
  try {
    const label = details();
    if (!window.MediaRecorder || !canvas.captureStream) throw new Error('Video capture is unavailable in this browser. Capture photos instead.');
    const mime = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((value) => MediaRecorder.isTypeSupported(value));
    if (!mime) throw new Error('This browser cannot save a supported recording. Capture photos instead.');
    const recordCanvas = document.createElement('canvas'), recordContext = recordCanvas.getContext('2d');
    const size = paint(recordCanvas, recordContext), mediaStream = recordCanvas.captureStream(15);
    const recorder = new MediaRecorder(mediaStream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    const entry = { recorder, mediaStream, label, size, chunks: [], bytes: 0, started: performance.now(), discard: false,
      identity: sampleIdentity(mime.includes('mp4') ? 'mp4' : 'webm'), paintTimer: null, stopTimer: null };
    recording = entry;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      entry.bytes += event.data.size;
      if (entry.bytes > 100 * 1024 * 1024) { error('Recording exceeded the file limit and was discarded. Try a shorter clip.'); finishRecording(true); return; }
      entry.chunks.push(event.data);
    };
    recorder.onerror = () => { error('Recording failed. Try again or capture a photo.'); finishRecording(true); };
    recorder.onstop = () => {
      clearInterval(entry.paintTimer); clearTimeout(entry.stopTimer); entry.mediaStream.getTracks().forEach((track) => track.stop());
      if (recording === entry) recording = null;
      $('recording-state').hidden = true;
      const durationMs = performance.now() - entry.started;
      try {
        if (!entry.discard && entry.bytes && durationMs <= 11000) {
          const blob = new Blob(entry.chunks, { type: recorder.mimeType });
          prepareSample(blob, policy.metadata(entry.label, { ...entry.identity, ...entry.size, mediaType: 'video', durationMs: Math.round(durationMs), mimeType: blob.type, userAgent: navigator.userAgent }));
          $('camera-message').textContent = 'Video prepared. Save both the media and label files below.';
        } else if (!entry.discard) error('The recording was empty or interrupted. Please record another short clip.');
      } catch (cause) { error(cause.message); }
      controls();
    };
    recorder.start(500);
    entry.paintTimer = setInterval(() => { try { if (!camera || video.readyState < 2) throw new Error('Camera interrupted'); recordContext.drawImage(video, 0, 0, size.width, size.height); $('recording-state').textContent = `Recording · ${Math.min(10, Math.floor((performance.now() - entry.started) / 1000))} / 10 s`; } catch { finishRecording(true); } }, 67);
    entry.stopTimer = setTimeout(() => finishRecording(), 10000);
    $('recording-state').hidden = false; $('recording-state').textContent = 'Recording · 0 / 10 s'; controls();
  } catch (cause) { if (recording) { recording.mediaStream.getTracks().forEach((track) => track.stop()); recording = null; } error(cause.message); controls(); }
}
function resetWorker(reason = 'The decoder stopped. Start another comparison.') {
  worker?.terminate(); worker = null; workerReady = null;
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
  pending.clear();
}
function workerCall(type, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => resetWorker('Decoding took too long. Try a smaller or clearer barcode.'), type === 'init' ? 30000 : 12000);
    pending.set(id, { resolve, reject, timer });
    try { worker.postMessage({ id, type, ...payload }, transfer); }
    catch (cause) { clearTimeout(timer); pending.delete(id); reject(cause); }
  });
}
async function initializeWorker() {
  if (!workerReady) {
    worker = new Worker(new URL('../code128-lab-worker.js', location.href));
    worker.onmessage = ({ data }) => { const entry = pending.get(data.id); if (!entry) return; clearTimeout(entry.timer); pending.delete(data.id); if (data.type === 'error') entry.reject(new Error(data.message)); else entry.resolve(data); };
    worker.onerror = () => resetWorker('The experimental engine could not load. Reconnect once and update the lab files.');
    workerReady = workerCall('init', { engine: 'both' }).catch((cause) => { resetWorker(cause.message); throw cause; });
  }
  return workerReady;
}
function stopTrial(message = 'Comparison finished.') {
  trialGeneration++; clearTimeout(loopTimer); clearTimeout(workerTimer); loopTimer = workerTimer = null;
  if (trial) {
    trialReport = { ...trialReport, endedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - trialReport.startMs), results: trial.snapshot(), frameIdentity: latestFrameIdentitySource };
    delete trialReport.startMs; trial = null;
    $('trial-state').textContent = message; $('export-report').disabled = false;
    resetWorker('Comparison stopped.');
  }
  controls();
}
function displayMetrics(snapshot) {
  const ms = (value) => value === null ? '—' : `${value.toFixed(1)} ms`;
  const rows = [ ['Frames evaluated', 'frames'], ['Exact frames', 'exact'], ['Frames with a wrong reading', 'wrong'], ['Frames with no complete match', 'miss'], ['Median decoder time', 'medianDecodeMs'], ['95th percentile decoder time', 'p95DecodeMs'], ['Time to first confirmed correct result', 'timeToFirstConfirmedMs'] ];
  $('metrics-body').replaceChildren();
  for (const [title, key] of rows) {
    const row = document.createElement('tr'), heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = title; row.append(heading);
    for (const engine of ['custom', 'zxing']) { const cell = document.createElement('td'); cell.textContent = key.endsWith('Ms') ? ms(snapshot[engine][key]) : snapshot[engine][key]; row.append(cell); }
    $('metrics-body').append(row);
  }
}
function displayResults(id, results) { $(id).textContent = results.length ? results.map((result) => `${result.format}: ${result.text || '(binary value)'}`).join('\n') : 'No reading in this frame'; }
async function compareFrame(token) {
  if (!trial || token !== trialGeneration || !camera) return;
  try {
    const identity = frameIdentity();
    if (identity !== null && identity !== lastFrame && video.readyState >= 2) {
      lastFrame = identity;
      const size = paint(); const pixels = context.getImageData(0, 0, size.width, size.height);
      const response = await workerCall('decode', { image: { ...size, data: pixels.data.buffer }, engine: 'both' }, [pixels.data.buffer]);
      if (!trial || token !== trialGeneration) return;
      trial.observe(identity, performance.now(), response.customResults, response.baselineResults, response.timings);
      const snapshot = trial.snapshot(); displayMetrics(snapshot);
      displayResults('latest-custom', response.customResults); displayResults('latest-zxing', response.baselineResults);
      $('trial-state').textContent = `Comparing on this device · ${snapshot.custom.frames} shared frames`;
      if (snapshot.custom.frames >= 300) { stopTrial('Comparison finished after 300 shared frames.'); return; }
    }
  } catch (cause) { if (token === trialGeneration) { stopTrial('Comparison stopped. Fix the error, then start a new trial.'); error(cause.message); } return; }
  if (trial && token === trialGeneration) loopTimer = setTimeout(() => compareFrame(token), 180);
}
async function startTrial() {
  clearError();
  if (!camera || recording || trial || trialStarting) return;
  let label;
  try { label = details(); } catch (cause) { error(cause.message); return; }
  trialStarting = true; controls(); $('trial-state').textContent = 'Loading both engines before timing starts…';
  const cameraToken = cameraGeneration;
  try {
    await initializeWorker();
    if (!camera || cameraToken !== cameraGeneration) return;
    frameIdentity();
    if (latestFrameIdentitySource === 'unavailable') throw new Error('This browser cannot identify separate camera frames reliably. Use a current browser for live comparisons; photo collection still works.');
    const startMs = performance.now(); trial = policy.createTrial(label.expected, startMs); lastFrame = null;
    const token = ++trialGeneration;
    trialReport = { version: 1, kind: 'code128-live-comparison', startedAt: new Date().toISOString(), startMs, label,
      device: label.device, userAgent: navigator.userAgent, cameraSettings: camera.getVideoTracks()[0].getSettings(),
      methodology: 'Paired independent camera frames. Correct results require exact text and Code128 format with no unexpected results. Two separate consecutive correct frames with equal raw payloads within 2500ms confirm a result. Decoder timing excludes capture/startup/UI. Confirmation time starts after both engines initialize and includes paired processing of both engines, not standalone engine latency. This single trial is not an overall accuracy estimate.' };
    $('export-report').disabled = true;
    $('measurement-note').textContent = `${label.negative ? 'Negative scene' : 'Known value: ' + label.expected[0].text} · ${label.device} · ${label.groupId}`;
    displayMetrics(trial.snapshot()); controls();
    workerTimer = setTimeout(() => stopTrial('Comparison finished after 60 seconds.'), 60000);
    compareFrame(token);
  } catch (cause) { if (cameraToken === cameraGeneration) { error(cause.message); $('trial-state').textContent = 'Could not start a comparison. Fix the error and try again.'; } }
  finally { trialStarting = false; controls(); }
}
function downloadReport() {
  if (!trialReport || trial) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(trialReport, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `code128-trial-${trialReport.startedAt.replace(/[^0-9]/g, '')}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function offlineStatus() {
  try {
    registration = await navigator.serviceWorker.register('../sw.js', { scope: '../' });
    const show = async () => {
      $('refresh-lab').hidden = !registration.waiting;
      const target = registration.active || navigator.serviceWorker.controller;
      if (!target) { $('offline-status').textContent = 'Preparing offline files. Keep this page online until preparation finishes.'; return; }
      const ready = await new Promise((resolve) => { const channel = new MessageChannel(); const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 4000); channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(policy.isLabOfflineReady(data)); }; target.postMessage({ type: 'OFFLINE_STATUS' }, [channel.port2]); });
      $('offline-status').textContent = ready ? 'Offline files are ready in this browser. Clearing site data can remove them.' : 'Offline files are not ready. Reconnect and reopen the scanner to prepare them.';
    };
    const watch = () => registration.installing?.addEventListener('statechange', show);
    registration.addEventListener('updatefound', watch); watch(); await show();
  } catch { $('offline-status').textContent = 'Offline preparation is unavailable. Use HTTPS or localhost and open this page online first.'; }
}
$('camera-toggle').addEventListener('click', () => camera ? stopCamera() : openCamera());
$('camera-select').addEventListener('change', () => openCamera($('camera-select').value));
$('capture-photo').addEventListener('click', capturePhoto);
$('capture-video').addEventListener('click', captureVideo);
$('trial-toggle').addEventListener('click', () => trial ? stopTrial('Comparison stopped. Your report is ready.') : startTrial());
$('export-report').addEventListener('click', downloadReport);
$('dismiss-error').addEventListener('click', clearError);
$('sample-form').addEventListener('input', controls);
$('sample-form').addEventListener('submit', (event) => event.preventDefault());
$('torch').addEventListener('click', async () => { try { await camera.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: !torch }] }); torch = !torch; $('torch').setAttribute('aria-pressed', String(torch)); } catch { error('This camera could not change its flashlight setting.'); } });
$('zoom').addEventListener('change', async () => { try { await camera.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: Number($('zoom').value) }] }); } catch { error('This camera could not change its zoom setting.'); } });
$('refresh-lab').addEventListener('click', () => { stopCamera(); reloadForUpdate = true; registration?.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' }); });
navigator.serviceWorker?.addEventListener('controllerchange', () => { if (reloadForUpdate) location.reload(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera('Camera paused because this page is hidden. Open it again to continue.'); });
window.addEventListener('pagehide', () => { stopCamera(); resetWorker(); for (const item of prepared) { URL.revokeObjectURL(item.mediaURL); URL.revokeObjectURL(item.metadataURL); } prepared = []; });
controls();
if ('serviceWorker' in navigator && window.isSecureContext) offlineStatus();
else $('offline-status').textContent = 'Offline preparation needs HTTPS or localhost and service worker support.';
