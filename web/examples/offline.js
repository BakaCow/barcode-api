// Reuse the main app's bounded, versioned offline cache. Never activate an update silently.
const statusElement = document.getElementById('offline-status');
const button = document.getElementById('offline-check');
const updateLink = document.getElementById('offline-update');
const scope = new URL('../', import.meta.url);
updateLink.href = scope.href;
let registration, busy = false, needsUpdate = false, disposed = false;
function updateNotice() { updateLink.hidden = !registration?.waiting && !needsUpdate; }
function message(text, state = '') { if (disposed) return; statusElement.textContent = text; statusElement.dataset.state = state; }
function ask(target, type) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (value) => { clearTimeout(timeout); channel.port1.close(); resolve(value); };
    const timeout = setTimeout(() => finish({ ready: false, error: 'Offline check timed out. Connect and try again.' }), type === 'REPAIR_OFFLINE' ? 45000 : 4000);
    channel.port1.onmessage = ({ data }) => finish(data || {});
    try { target.postMessage({ type }, [channel.port2]); }
    catch { finish({ ready: false, error: 'Offline cache could not be checked. Reload and try again.' }); }
  });
}
async function check(repair = false) {
  if (busy || disposed) return;
  const target = navigator.serviceWorker.controller || registration?.active;
  if (!target) { message('Downloading offline files…'); return; }
  busy = true; button.disabled = true;
  try {
    let response = await ask(target, 'OFFLINE_STATUS');
    needsUpdate = !response.features?.includes('integration-examples') || !response.features?.includes('camera-controls');
    updateNotice();
    if (needsUpdate) { message('An app update is needed for offline examples. Open the main scanner to finish updating.'); return; }
    if (repair && !response.ready) {
      message('Downloading missing offline files…');
      response = await ask(target, 'REPAIR_OFFLINE');
    }
    const ready = response.ready === true && response.features?.includes('integration-examples') === true && response.features?.includes('camera-controls') === true;
    message(ready ? (navigator.onLine ? 'Offline examples ready on this browser.' : 'Offline · Examples ready.') : (response.error || 'Offline files are incomplete. Connect and check again.'), ready ? 'ready' : 'error');
  } finally { busy = false; if (!disposed) button.disabled = false; }
}
function watch(worker) {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (disposed) return;
    updateNotice();
    if (worker.state === 'activated') check();
    if (worker.state === 'installed') { setTimeout(updateNotice, 0); if (registration.active) check(); }
    if (worker.state === 'redundant' && !registration.active) { message('Offline download failed. Connect and reload to try again.', 'error'); button.disabled = false; }
  });
}
async function setup() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) { message('Offline caching is unavailable here. Use HTTPS or localhost.'); return; }
  try {
    registration = await navigator.serviceWorker.register(new URL('sw.js', scope), { scope: scope.href });
    if (disposed) return;
    updateNotice(); watch(registration.installing);
    registration.addEventListener('updatefound', () => watch(registration.installing));
    button.disabled = false;
    if (registration.active) await check();
    navigator.serviceWorker.ready.then(() => { if (!disposed) check(); }).catch(() => {});
  } catch { message('Offline setup failed. Connect and reload to try again.', 'error'); }
}
button.addEventListener('click', () => {
  registration?.update().catch(() => {});
  check(true);
});
navigator.serviceWorker?.addEventListener('controllerchange', () => { needsUpdate = false; updateNotice(); check(); });
window.addEventListener('online', () => check());
window.addEventListener('offline', () => check());
window.addEventListener('pagehide', () => { disposed = true; });
window.addEventListener('pageshow', () => { disposed = false; check(); });
setup();
