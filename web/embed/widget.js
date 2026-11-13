import { createScanner } from '../sdk/scanner.js';
import { attachScannerControls } from '../sdk/controls.js';

// Only confirmed values and lifecycle messages leave this frame. Pixels stay here.
const PROTOCOL = 'barcode-camera-embed', VERSION = 1;
const FORMATS = new Set(['ean13', 'upca', 'code128', 'qr', 'ean8', 'upce', 'datamatrix', 'aztec', 'pdf417', 'code93']);
const DEFAULT_FORMATS = ['ean13', 'upca', 'code128', 'qr'];
const $ = id => document.getElementById(id);
let scanner = null, cameraControls = null, configured = false, disposed = false;
let busy = false, operation = 0, state = 'idle', sequence = 0, lastError = '';
let transportRevision = 0;
let resizeFrame = null, lastHeight = 0;

function parentConnection() {
  if (window.parent === window) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.getAll('parentOrigin').length !== 1 || params.getAll('channel').length !== 1) return null;
  const parentOrigin = params.get('parentOrigin'), channel = params.get('channel');
  if (!/^[a-f0-9]{32}$/.test(channel || '')) return null;
  try {
    const origin = new URL(parentOrigin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.hostname.endsWith('.localhost');
    if (origin.origin !== parentOrigin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local))) return null;
    return { parentOrigin, channel };
  } catch { return null; }
}
const connection = parentConnection();
function send(type, payload = {}) {
  if (!connection || disposed) return;
  window.parent.postMessage({ protocol: PROTOCOL, version: VERSION, channel: connection.channel, revision: transportRevision, type, payload }, connection.parentOrigin);
}
function queueResize() {
  if (!connection || disposed || resizeFrame !== null) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null;
    if (disposed) return;
    const height = Math.min(4096, Math.max(240, Math.ceil($('widget').getBoundingClientRect().height)));
    if (height !== lastHeight) { lastHeight = height; send('resize', { height }); }
  });
}
function render() {
  const running = Boolean($('video').srcObject), opening = busy || state === 'starting';
  $('stage').dataset.running = String(running);
  $('start').disabled = !configured || disposed || opening || running;
  $('stop').disabled = disposed || (!opening && !running);
  $('next').disabled = disposed || opening || state !== 'confirmed';
  $('camera-state').textContent = opening ? 'Opening camera' : running ? 'Camera live' : 'Camera off';
  queueResize();
}
function clearError() { lastError = ''; $('error').hidden = true; }
function showError(error) {
  if (disposed || error?.name === 'AbortError') return;
  let message = error?.name === 'NotAllowedError'
    ? 'Camera access was not allowed. Allow this site to use the camera, or open the scanner separately.'
    : String(error?.message || error || 'The scanner could not continue. Try starting the camera again.');
  message = message.slice(0, 2000);
  $('error').textContent = message; $('error').hidden = false;
  if (message !== lastError) { lastError = message; send('error', { message }); }
  queueResize();
}
function checkedSettings(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(key => !['formats', 'confirmationFrames', 'controls'].includes(key))) throw new TypeError('The website supplied unsupported scanner settings.');
  const formats = payload.formats ?? DEFAULT_FORMATS;
  const confirmationFrames = payload.confirmationFrames ?? 2, controls = payload.controls ?? true;
  if (!Array.isArray(formats) || !formats.length || formats.length > FORMATS.size ||
      formats.some(value => !FORMATS.has(value)) || new Set(formats).size !== formats.length ||
      ![1, 2, 3].includes(confirmationFrames) || typeof controls !== 'boolean') throw new TypeError('The website supplied invalid formats or confirmation settings.');
  return { formats: [...formats], confirmationFrames, controls };
}
function configure(payload) {
  if (configured) { send('ready'); queueResize(); return; }
  const options = checkedSettings(payload);
  clearError();
  scanner = createScanner({
    video: $('video'), formats: options.formats, confirmationFrames: options.confirmationFrames,
    onScan(result) {
      if (disposed) return;
      $('value').textContent = result.text || 'Binary barcode'; $('value').dataset.confirmed = 'true';
      $('format').textContent = result.format; $('format').hidden = false;
      send('scan', { sequence: ++sequence, result }); render();
    },
    onStatus(status) {
      if (disposed) return;
      state = status.state; $('status').textContent = status.message; $('status').dataset.state = status.state;
      cameraControls?.updateStatus(status); send('status', status); render();
    },
    onCandidates: candidates => cameraControls?.updateCandidates(candidates),
    onError: showError,
  });
  try {
    if (options.controls) {
      $('camera-controls').hidden = false;
      cameraControls = attachScannerControls({ container: $('camera-controls'), video: $('video'), scanner });
    }
  } catch (error) {
    scanner.destroy(); scanner = null; $('camera-controls').hidden = true;
    throw error;
  }
  configured = true;
  const message = options.confirmationFrames === 1 ? 'Ready. One camera frame can confirm a barcode.' : `Ready. ${options.confirmationFrames} distinct matching camera frames confirm a barcode.`;
  $('status').textContent = message; $('status').dataset.state = 'idle';
  render(); send('ready'); send('status', { state: 'idle', message });
}
async function start() {
  if (!configured || disposed || busy || state === 'starting' || $('video').srcObject) return;
  const token = ++operation; clearError();
  try {
    const permissions = document.permissionsPolicy || document.featurePolicy;
    if (permissions?.allowsFeature?.('camera') === false) throw new Error('This website has blocked camera access. Open the scanner separately or ask the website owner to enable camera access.');
    busy = true; render();
    await scanner.start();
  } catch (error) { if (token === operation) showError(error); }
  finally { if (!disposed && token === operation) { busy = false; render(); } }
}
function stop() {
  if (!configured || disposed) return;
  operation++; busy = false; clearError(); scanner.stop(); render();
}
function rescan() {
  if (!configured || disposed || busy) return;
  clearError(); scanner.rescan(); render();
}
function destroy() {
  if (disposed) return;
  operation++; busy = false;
  scanner?.destroy(); cameraControls?.destroy();
  disposed = true; configured = false;
  if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
  resizeObserver?.disconnect();
  window.removeEventListener('message', receive);
  window.removeEventListener('pagehide', stop);
  window.removeEventListener('resize', queueResize);
  document.removeEventListener('visibilitychange', pause);
  $('start').removeEventListener('click', start); $('stop').removeEventListener('click', stop); $('next').removeEventListener('click', rescan);
  $('status').textContent = 'Scanner closed.'; $('camera-controls').hidden = true; render();
}
function receive(event) {
  if (!connection || disposed || event.source !== window.parent || event.origin !== connection.parentOrigin) return;
  const packet = event.data;
  if (!packet || typeof packet !== 'object' || packet.protocol !== PROTOCOL || packet.version !== VERSION || packet.channel !== connection.channel) return;
  if (!Number.isSafeInteger(packet.revision) || packet.revision < transportRevision || packet.revision < 0) return;
  try {
    if (packet.type === 'configure') {
      transportRevision = packet.revision; configure(packet.payload);
    } else if (['stop', 'rescan', 'destroy'].includes(packet.type) && packet.revision > transportRevision) {
      // A command invalidates already queued messages in the parent as well as
      // the SDK's local work. Never replay an equal/older rescan command.
      transportRevision = packet.revision;
      if (packet.type === 'stop') stop();
      else if (packet.type === 'rescan') rescan();
      else destroy();
    }
  } catch (error) { showError(error); }
}
function pause() { if (document.hidden) stop(); }
const resizeObserver = window.ResizeObserver ? new window.ResizeObserver(queueResize) : null;
$('start').addEventListener('click', start); $('stop').addEventListener('click', stop); $('next').addEventListener('click', rescan);
window.addEventListener('message', receive); window.addEventListener('pagehide', stop); window.addEventListener('resize', queueResize); document.addEventListener('visibilitychange', pause);
resizeObserver?.observe($('widget'));
document.fonts?.ready?.then(queueResize);
if (connection) { send('hello'); queueResize(); }
else {
  $('status').textContent = 'Open this scanner from a website using the embed script, or use the standalone scanner below.';
  render();
}
