# JavaScript / TypeScript backend client

Requires Node 22+. This local package is included with the repository; it has not been published to npm. Install from a checkout with `npm install /path/to/barcode-api/clients/javascript`, or import `index.js` directly. TypeScript declarations are included.

Keep the API key in backend environment variables. For a browser camera, use [the scanner SDK](../../SDK.md); it requires no API key. The client deliberately refuses browser execution.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { BarcodeClient, BarcodeApiError } from 'barcode-api-client';

const client = new BarcodeClient({
  baseUrl: process.env.BARCODE_API_URL,
  apiKey: process.env.BARCODE_API_KEY,
  timeoutMs: 15000,
});

const image = await client.generate({ format: 'code128', text: '000123' });
await writeFile('label.png', image.data);
const decoded = await client.read(new Blob([await readFile('label.png')]));
console.log(decoded.barcodes);

const decision = await client.decodePos([
  new Blob([await readFile('frame-1.jpg')]),
  new Blob([await readFile('frame-2.jpg')]),
], { allowed_formats: ['ean13', 'upca', 'code128'], confirmation_frames: 2 });
if (decision.status === 'confirmed') {
  // Look up decision.barcode.format + decision.barcode.text exactly.
  // Apply a transaction idempotency key before changing your cart or stock.
}
```

Methods: `health()`, `formats()`, `generate(payload)`, `read(Blob)`, `decodePos(Blob[], options)`.

Each method accepts a final `{signal}` option for caller cancellation (`decodePos` takes it as the third argument). The timeout covers the complete fetch and response consumption. HTTP errors throw `BarcodeApiError` with `status`, `requestId`, `retryAfter` (the header string), and optional `details`. Network errors and cancellation remain native fetch errors. Errors are never retried automatically. In particular, avoid turning a repeated successful scan into a repeated business transaction.

Use an HTTPS URL in production. HTTP is accepted only for localhost/loopback development. Base paths such as `https://example.com/barcodes/` are preserved. Redirects are refused to avoid forwarding authentication to an unintended endpoint. POS inputs retain leading zeros and raw bytes. The server validates barcode content, image types and decoded pixel limits; client-side size checks do not replace that validation.

The methods return the documented API JSON without normalizing identifiers. See [POS-DECODING.md](../../POS-DECODING.md) for the difference between confirmation, ambiguity and rescan decisions, and [HOSTING.md](../../HOSTING.md) for customer keys and limits.
