/** Session-only checkout example. Production systems must enforce idempotency on their server. */
export const DEMO_CATALOGUE = Object.freeze([
  Object.freeze({ id: 'tea', name: 'Breakfast tea', format: 'code128', text: 'DEMO-TEA-01', priceCents: 650 }),
  Object.freeze({ id: 'oats', name: 'Rolled oats', format: 'code128', text: 'DEMO-OATS-02', priceCents: 420 }),
  Object.freeze({ id: 'bag', name: 'Reusable bag', format: 'qr', text: 'DEMO:BAG:03', priceCents: 250 }),
]);
const key = (format, text) => JSON.stringify([format, text]);
export function createCart(catalogue = DEMO_CATALOGUE, { maxEvents = 1000 } = {}) {
  if (!Array.isArray(catalogue) || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 10000) throw new TypeError('Invalid catalogue or event limit.');
  const lookup = new Map(), ids = new Set(), seen = new Set(), lines = new Map();
  for (const item of catalogue) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name ||
        typeof item.format !== 'string' || !item.format || typeof item.text !== 'string' || !item.text ||
        !Number.isSafeInteger(item.priceCents) || item.priceCents < 0 || item.priceCents > 1e9 ||
        lookup.has(key(item.format, item.text)) || ids.has(item.id)) throw new TypeError('Catalogue entries need unique IDs and exact code identities.');
    const copy = Object.freeze({ id: item.id, name: item.name, format: item.format, text: item.text, priceCents: item.priceCents });
    lookup.set(key(copy.format, copy.text), copy); ids.add(copy.id);
  }
  function snapshot() {
    const items = Array.from(lines.values(), (line) => ({ ...line, lineTotalCents: line.priceCents * line.quantity }));
    return { items, itemCount: items.reduce((sum, item) => sum + item.quantity, 0), totalCents: items.reduce((sum, item) => sum + item.lineTotalCents, 0) };
  }
  return Object.freeze({
    add(event) {
      if (!event || typeof event.scanId !== 'string' || !event.scanId || event.scanId.length > 200 || typeof event.text !== 'string' || !event.text || event.text.length > 4096 || typeof event.format !== 'string' || !event.format) return { status: 'invalid', message: 'The scan event is incomplete.' };
      if (seen.has(event.scanId)) return { status: 'duplicate', message: 'This scan event was already handled.' };
      if (seen.size >= maxEvents) return { status: 'capacity', message: 'This demo session reached its event limit. Reload to start a new session.' };
      seen.add(event.scanId);
      const item = lookup.get(key(event.format, event.text));
      if (!item) return { status: 'unknown', message: 'No exact match in the demo catalogue. Nothing was added.' };
      const previous = lines.get(item.id), quantity = (previous?.quantity || 0) + 1;
      if (quantity > 999 || !Number.isSafeInteger(snapshot().totalCents + item.priceCents)) return { status: 'capacity', message: 'The cart quantity limit was reached. Nothing was added.' };
      lines.set(item.id, { ...item, quantity });
      return { status: 'added', message: `${item.name} added.`, item: { ...item, quantity } };
    },
    remove(id) { return lines.delete(id); },
    // Keep consumed event IDs so a delayed retry cannot re-add a removed item.
    clear() { lines.clear(); },
    snapshot,
  });
}
