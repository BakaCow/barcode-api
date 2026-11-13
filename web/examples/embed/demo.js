import { createCart } from '../pos/cart.mjs';

const $ = id => document.getElementById(id);
const cart = createCart();
const money = value => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value / 100);
const scriptURL = document.querySelector('script[data-barcode-scanner]').src;
$('embed-snippet').textContent = `<script src="${scriptURL}" data-barcode-scanner defer></script>`;

function renderCart() {
  const snapshot = cart.snapshot();
  $('cart-empty').hidden = snapshot.items.length > 0;
  $('clear-cart').disabled = snapshot.items.length === 0;
  $('cart-total').textContent = money(snapshot.totalCents);
  $('cart-lines').replaceChildren();
  for (const item of snapshot.items) {
    const row = document.createElement('li');
    const name = document.createElement('span'); name.className = 'cart-name'; name.textContent = item.name;
    const amount = document.createElement('span'); amount.className = 'cart-amount'; amount.textContent = money(item.lineTotalCents);
    const detail = document.createElement('span'); detail.className = 'cart-detail'; detail.textContent = `${item.quantity} × ${money(item.priceCents)}`;
    const remove = document.createElement('button'); remove.className = 'cart-remove'; remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', () => { cart.remove(item.id); renderCart(); $('cart-feedback').textContent = `${item.name} removed.`; $('cart-feedback').tabIndex = -1; $('cart-feedback').focus(); });
    row.append(name, amount, detail, remove); $('cart-lines').append(row);
  }
}
$('embed-host').addEventListener('barcode:scan', event => {
  const outcome = cart.add(event.detail);
  $('cart-feedback').textContent = outcome.message;
  $('cart-feedback').dataset.state = ['added', 'duplicate'].includes(outcome.status) ? 'confirmed' : 'error';
  renderCart();
});
$('embed-host').addEventListener('barcode:error', event => { $('embed-error').textContent = event.detail?.message || 'The scanner could not load. Check the server address and try reloading.'; $('embed-error').hidden = false; });
$('embed-host').addEventListener('barcode:ready', () => { $('embed-error').hidden = true; });
$('clear-cart').addEventListener('click', () => { cart.clear(); renderCart(); $('cart-feedback').textContent = 'Demo cart cleared. Scan another label to continue.'; });
$('copy-embed').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('embed-snippet').textContent); $('copy-status').textContent = 'Script copied. Paste it into your HTTPS page.'; }
  catch { $('embed-snippet').focus(); const range = document.createRange(); range.selectNodeContents($('embed-snippet')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); $('copy-status').textContent = 'Select and copy the script above; clipboard access is unavailable.'; }
});
renderCart();
