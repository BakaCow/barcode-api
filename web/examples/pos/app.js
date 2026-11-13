import { createScanner } from '../../sdk/scanner.js';
import { attachScannerControls } from '../../sdk/controls.js';
import { createCart, DEMO_CATALOGUE } from './cart.mjs';

const $ = (id) => document.getElementById(id), cart = createCart();
const money = (cents) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
let busy = false;
let cameraControls;
function errorMessage(error) { $('error').textContent = error.message || String(error); $('error').hidden = false; }
function controls() {
  const running = Boolean($('video').srcObject);
  $('stage').dataset.running = String(running);
  $('start').disabled = busy || running; $('stop').disabled = !busy && !running;
}
function renderCart() {
  const state = cart.snapshot(); $('cart-lines').replaceChildren();
  for (const item of state.items) {
    const row = document.createElement('li'), name = document.createElement('span'), detail = document.createElement('span'), amount = document.createElement('span'), remove = document.createElement('button');
    name.className = 'cart-name'; name.textContent = item.name;
    detail.className = 'cart-detail'; detail.textContent = `${item.quantity} × ${money(item.priceCents)}`;
    amount.className = 'cart-amount'; amount.textContent = money(item.lineTotalCents);
    remove.className = 'cart-remove'; remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', () => { cart.remove(item.id); renderCart(); $('cart-message').textContent = `${item.name} removed.`; $('cart-message').dataset.state = 'confirmed'; });
    row.append(name, amount, detail, remove); $('cart-lines').append(row);
  }
  $('cart-empty').hidden = state.items.length > 0; $('clear').disabled = state.items.length === 0;
  $('total').textContent = money(state.totalCents);
}
function accept(event) {
  const decision = cart.add(event);
  $('last-scan').textContent = `${event.format}: ${event.text}`;
  $('cart-message').textContent = decision.message;
  $('cart-message').dataset.state = decision.status === 'added' || decision.status === 'duplicate' ? 'confirmed' : 'error';
  renderCart(); $('next').disabled = false;
}
const scanner = createScanner({ video: $('video'), formats: ['code128', 'qr'], confirmationFrames: 2,
  onScan: accept,
  onStatus(status) { $('status').textContent = status.message; $('status').dataset.state = status.state; cameraControls?.updateStatus(status); controls(); },
  onCandidates: (candidates) => cameraControls?.updateCandidates(candidates),
  onError: errorMessage,
});
cameraControls = attachScannerControls({ container: $('camera-controls'), video: $('video'), scanner });
$('start').addEventListener('click', async () => { $('error').hidden = true; busy = true; controls(); try { await scanner.start(); } catch (error) { errorMessage(error); } finally { busy = false; controls(); } });
$('stop').addEventListener('click', () => { scanner.stop(); busy = false; controls(); });
$('next').addEventListener('click', () => { $('error').hidden = true; scanner.rescan(); $('next').disabled = true; });
$('clear').addEventListener('click', () => { scanner.rescan(); cart.clear(); renderCart(); $('next').disabled = true; $('cart-message').textContent = 'Cart cleared. Ready for another item.'; $('cart-message').dataset.state = 'rescan'; });
$('manual').addEventListener('submit', (event) => {
  event.preventDefault(); scanner.stop(); busy = false; controls();
  accept({ scanId: `manual:${crypto.randomUUID()}`, format: $('manual-format').value, text: $('manual-value').value });
  $('manual-value').select();
});
for (const item of DEMO_CATALOGUE) {
  const row = document.createElement('li'), name = document.createElement('strong'), value = document.createElement('p'), image = document.createElement('img'), link = document.createElement('a'), price = document.createElement('p');
  name.textContent = item.name; value.className = 'catalogue-value'; value.textContent = item.text;
  image.src = `./labels/${item.id}.svg`; image.alt = `${item.format} label for ${item.name}`; image.width = 320; image.height = 90;
  link.href = `./labels/${item.id}.png`; link.download = `${item.id}-demo-label.png`; link.textContent = 'Download label';
  price.textContent = `${money(item.priceCents)} AUD · ${item.format}`;
  row.append(name, value, image, price, link); $('catalogue').append(row);
}
window.addEventListener('pagehide', () => { scanner.stop(); busy = false; controls(); });
