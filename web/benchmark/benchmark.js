import { createScanbotAdapter, createWorkerAdapter, localUrl } from './adapters.mjs';
import { report, summarize, trialMetrics, validateTrial } from './metrics.mjs';
import { createRecorder } from './recorder.mjs';

const $ = id => document.getElementById(id), form = $('settings'), video = $('video');
const trials = [], canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
let epoch = 0, prepared = null, active = null, latestFrame = null, callbackId = null;
const message = text => { $('status').textContent = text; };
function error(text = '') { $('error').textContent = text; $('error').hidden = !text; }
function lock(value) { for (const input of form.elements) input.disabled = value; }
function stopMedia() {
  if (callbackId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(callbackId);
  callbackId = null; latestFrame = null;
  if (video.srcObject) for (const track of video.srcObject.getTracks()) track.stop();
  video.srcObject = null; $('camera-empty').hidden = false;
  prepared?.adapter.dispose(); prepared = null;
  $('begin').disabled = true; $('cancel').disabled = true; $('stop').disabled = true;
  lock(false);
}
function closeCamera() {
  if (active) finish('cancelled');
  else { epoch++; stopMedia(); message('Camera closed. Existing results remain available to download.'); }
}
function readMetadata(engine, dimensions, camera = {}) {
  return validateTrial({ runId: 'run-' + crypto.randomUUID(), sessionId: $('session').value, deviceId: $('device').value,
    caseId: $('case').value, repeat: Number($('repeat').value), source: $('source').value,
    expected: $('negative').checked ? null : { format: $('format').value, text: $('truth').value }, engine,
    protocol: { mode: 'shared-camera-image-v1', policy: 'pos-v1', formats: $('formats').value.split(',').map(v => v.trim()),
      confirmationFrames: Number($('confirmation').value), trialMs: Number($('duration').value), intervalMs: 120,
      width: dimensions.width, height: dimensions.height, sourceWidth: video.videoWidth || dimensions.width, sourceHeight: video.videoHeight || dimensions.height,
      camera: { facingMode: camera.facingMode ?? 'unknown', focusMode: camera.focusMode ?? 'unknown', exposureMode: camera.exposureMode ?? 'unknown', zoom: camera.zoom ?? null, frameRate: camera.frameRate ?? null } },
    outcome: { status: 'cancelled', elapsedMs: 0, frames: 0, confirmations: [] } });
}
function frameId() {
  if (latestFrame !== null) return 'presented:' + latestFrame;
  const decoded = video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount;
  return Number.isSafeInteger(decoded) && decoded > 0 ? 'decoded:' + decoded : null;
}
function watchFrames(token) {
  if (!video.requestVideoFrameCallback) return;
  callbackId = video.requestVideoFrameCallback((_, frame) => {
    if (token !== epoch) return;
    latestFrame = Number.isSafeInteger(frame.presentedFrames) ? frame.presentedFrames : null;
    watchFrames(token);
  });
}
async function waitForCamera(token) {
  const started = performance.now();
  while (token === epoch) {
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && frameId() !== null) return;
    if (performance.now() - started > 10000) throw new Error('This browser did not provide fresh camera frames. Try current Safari or Chrome.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault(); error();
  if (!form.reportValidity()) return;
  let adapter = null;
  const token = ++epoch;
  stopMedia(); lock(true); $('stop').disabled = false;
  message('Preparing the engine and camera. Setup time is excluded from the trial.');
  try {
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Camera trials require HTTPS or localhost.');
    if (!$('negative').checked && !$('truth').value) throw new Error('Enter the known exact barcode text before preparing a trial.');
    // Validate labels/formats before asking for camera access or loading vendor code.
    readMetadata({ id: $('engine').value, version: 'pending', configuration: $('engine').value === 'scanbot' ? 'scanbot-single-shot' : 'worker-image-damage-v1' }, { width: 1, height: 1 });
    if ($('engine').value === 'scanbot') {
      if (!$('vendor-module').value || !$('vendor-engine').value) throw new Error('Scanbot is unconfigured. Supply your own locally hosted SDK module and engine directory.');
      const moduleUrl = localUrl($('vendor-module').value, location.href), engineUrl = localUrl($('vendor-engine').value, location.href);
      if (!engineUrl.pathname.endsWith('/')) throw new Error('The engine directory URL must end with a slash.');
      const module = await import(moduleUrl.href);
      if (token !== epoch) return;
      adapter = await createScanbotAdapter({ SDK: module.default ?? module.ScanbotSDK, licenseKey: $('vendor-license').value, enginePath: engineUrl.href });
    } else adapter = await createWorkerAdapter();
    if (token !== epoch) { adapter.dispose(); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    if (token !== epoch) { for (const track of stream.getTracks()) track.stop(); adapter.dispose(); return; }
    video.srcObject = stream; watchFrames(token); await video.play(); await waitForCamera(token);
    if (token !== epoch) { adapter.dispose(); return; }
    const plan = ScanPolicy.capturePlan(video.videoWidth, video.videoHeight, { maxPixels: 2100000 });
    const metadata = readMetadata(adapter.metadata, plan, stream.getVideoTracks()[0].getSettings());
    report([...trials, metadata]); // Reject accidental duplicate case/repetition before timing starts.
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
      if (token !== epoch) return;
      if (active) finish('error', 'The camera stopped during the trial.');
      else { closeCamera(); error('The camera stopped. Prepare it again.'); }
    }, { once: true });
    canvas.width = plan.width; canvas.height = plan.height;
    prepared = { adapter, metadata, sourceWidth: video.videoWidth, sourceHeight: video.videoHeight };
    $('camera-empty').hidden = true; $('begin').disabled = false;
    message(`Ready at ${plan.width} Ã— ${plan.height}. Place the labelled case in view, then begin the ${metadata.protocol.trialMs / 1000}-second trial.`);
  } catch (failure) {
    adapter?.dispose();
    if (token !== epoch) return;
    epoch++; stopMedia();
    error(failure instanceof Error && !['TypeError', 'NotAllowedError', 'NotFoundError'].includes(failure.name) ? failure.message : 'Unable to prepare the camera or local engine. Check camera permission and the configured files.');
    message('No trial was recorded. Correct the setup and prepare again.');
  }
});
function render() {
  $('results').replaceChildren();
  for (const trial of trials) {
    const metric = trialMetrics(trial), row = document.createElement('tr');
    const outcome = trial.outcome.status !== 'completed' ? trial.outcome.status : metric.anyWrong ? (metric.wrongFirst ? 'Wrong first' : 'Wrong confirmation') : metric.cleanCorrect ? 'Correct' : metric.correctNegative ? 'Correct negative' : 'Missed';
    for (const text of [`${trial.caseId} / ${trial.repeat}`, trial.engine.id, outcome,
      metric.firstCorrectMs === null ? 'â€”' : `${Math.round(metric.firstCorrectMs)} ms`, String(metric.wrongConfirmations)]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    $('results').append(row);
  }
  const summary = summarize(report(trials));
  $('summary').textContent = `${summary.completed} completed Â· ${summary.cleanCorrect} clean correct Â· ${summary.missed} missed Â· ${summary.trialsWithWrongConfirmation} with wrong confirmations Â· ${summary.cancelled} cancelled Â· ${summary.errors} errors (${summary.interruptedWithWrongConfirmation} interrupted trials also had wrong confirmations). Sources: ${summary.real} real, ${summary.synthetic} synthetic. Counts above combine engines; JSON downloads are separate.`;
  const selected = $('export-engine').value; $('export-engine').replaceChildren();
  for (const engine of new Set(trials.map(trial => trial.engine.id))) {
    const option = document.createElement('option'); option.value = engine; option.textContent = engine; $('export-engine').append(option);
  }
  if ([...$('export-engine').options].some(option => option.value === selected)) $('export-engine').value = selected;
  $('export-engine').disabled = trials.length === 0;
  $('export').disabled = trials.length === 0;
}
function finish(status, detail = '') {
  const trial = active;
  if (!trial) return;
  active = null; clearTimeout(trial.deadline); clearTimeout(trial.next);
  const endedAt = performance.now();
  const result = trial.recorder.finish(status, endedAt);
  epoch++; stopMedia();
  if (result) { trials.push(result); render(); }
  message(status === 'completed' ? 'Trial complete. Download the result or prepare the next case.' : status === 'cancelled' ? 'Trial cancelled. It is recorded separately and does not count as a miss.' : 'Trial stopped with an error. It does not count as a miss.');
  if (detail) error(detail);
}
$('begin').addEventListener('click', () => {
  if (!prepared || active) return;
  if (trials.length >= 2000) { error('This page has reached 2000 trials. Download them and reload for a new session.'); return; }
  const start = performance.now(), token = epoch, state = prepared, config = state.metadata.protocol;
  const policy = PosPolicy.createConfirmation({ allowedFormats: config.formats, confirmationFrames: config.confirmationFrames });
  const trial = { recorder: createRecorder(state.metadata, start), lastFrame: null, deadline: null, next: null };
  active = trial; $('begin').disabled = true; $('cancel').disabled = false;
  message(`Trial running for ${config.trialMs / 1000} seconds. Keep the case and conditions fixed until it finishes.`);
  trial.deadline = setTimeout(() => { if (active === trial) finish('completed'); }, config.trialMs);
  async function capture() {
    if (active !== trial || epoch !== token) return;
    const captureAt = performance.now();
    if (captureAt - start >= config.trialMs) { finish('completed'); return; }
    try {
      if (video.videoWidth !== state.sourceWidth || video.videoHeight !== state.sourceHeight || video.readyState < 2) throw new Error('Camera dimensions or availability changed during the trial.');
      const id = frameId();
      if (id !== null && id !== trial.lastFrame) {
        trial.lastFrame = id;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const fingerprint = FrameAnalysis.analyze({ width: pixels.width, height: pixels.height, data: pixels.data.buffer }).fingerprint;
        trial.recorder.frame();
        const results = await state.adapter.decode(pixels, config.formats);
        if (active !== trial || epoch !== token) return;
        const completedAt = performance.now();
        if (completedAt - start >= config.trialMs) { finish('completed'); return; }
        const decision = policy.observe(results, id, captureAt, fingerprint);
        if (decision.status === 'confirmed') {
          for (const code of decision.results) trial.recorder.confirmation({ format: PosPolicy.canonicalFormat(code.format), text: code.text }, completedAt);
          policy.reset(); // Continue observing; a later correct result never erases an earlier wrong acceptance.
        }
      }
      trial.next = setTimeout(capture, Math.max(0, config.intervalMs - (performance.now() - captureAt)));
    } catch {
      if (active === trial && epoch === token) finish('error', 'The camera or decoder failed. This interrupted trial is excluded from completed-trial metrics.');
    }
  }
  capture();
});
$('cancel').addEventListener('click', () => finish('cancelled'));
$('stop').addEventListener('click', closeCamera);
$('export').addEventListener('click', () => {
  const engine = $('export-engine').value;
  if (engine) {
    const data = report(trials.filter(trial => trial.engine.id === engine));
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `benchmark-${engine}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) closeCamera(); });
window.addEventListener('pagehide', closeCamera);
