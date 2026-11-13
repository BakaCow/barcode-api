import { createScanner } from '../../sdk/scanner.js';
import { attachScannerControls } from '../../sdk/controls.js';

const $ = (id) => document.getElementById(id);
let busy = false;
let cameraControls;
function showError(error) { $('error').textContent = error.message || String(error); $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function controls() {
  const running = Boolean($('video').srcObject);
  $('stage').dataset.running = String(running);
  $('start').disabled = busy || running;
  $('stop').disabled = !busy && !running;
  $('image').disabled = busy;
  $('confirmation').disabled = busy;
}
const scanner = createScanner({
  video: $('video'), confirmationFrames: 2,
  onScan(result) {
    $('empty').hidden = true; $('value').hidden = false;
    $('value').textContent = result.text;
    $('format').textContent = `Format: ${result.format}`;
    $('scan-id').textContent = `Scan event: ${result.scanId}`;
    const item = document.createElement('li');
    item.textContent = `${result.format}: ${result.text}`;
    $('events').prepend(item);
    while ($('events').children.length > 10) $('events').lastElementChild.remove();
    $('next').disabled = false;
  },
  onStatus(status) { $('status').textContent = status.message; $('status').dataset.state = status.state; cameraControls?.updateStatus(status); controls(); },
  onCandidates: (candidates) => cameraControls?.updateCandidates(candidates),
  onError: showError,
});
cameraControls = attachScannerControls({ container: $('camera-controls'), video: $('video'), scanner });
$('start').addEventListener('click', async () => {
  clearError(); busy = true; controls();
  try { await scanner.start(); } catch (error) { showError(error); }
  finally { busy = false; controls(); }
});
$('stop').addEventListener('click', () => { scanner.stop(); busy = false; controls(); });
$('next').addEventListener('click', () => { clearError(); scanner.rescan(); $('next').disabled = true; });
$('confirmation').addEventListener('change', () => { clearError(); scanner.setOptions({ confirmationFrames: Number($('confirmation').value) }); $('next').disabled = true; });
$('image').addEventListener('change', async () => {
  const file = $('image').files[0]; if (!file) return;
  clearError(); busy = true; controls();
  try { await scanner.scanImage(file); } catch (error) { showError(error); }
  finally { busy = false; $('image').value = ''; controls(); }
});
window.addEventListener('pagehide', () => { scanner.stop(); busy = false; controls(); });
