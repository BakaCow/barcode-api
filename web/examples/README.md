# Browser integration examples

Serve the `web/` directory on localhost or an HTTPS host, preserving its directory layout. From the project root:

```powershell
py -m http.server 8000 --bind 127.0.0.1 --directory web
```

Open `http://127.0.0.1:8000/examples/`. With the Python API server, use `/scan/examples/` instead. No API key is used by these examples.

## Plain JavaScript

`plain/` imports `createScanner` from `../../sdk/scanner.js`, attaches a video element, and renders the `onScan` result. It has explicit camera start/stop, rescan, confirmation settings and image import. Imported PNG/JPEG/WebP files require the single-frame setting to produce a confirmation; an imported image cannot count as multiple independent frames. Arbitrary barcode content is rendered with `textContent` and is never opened as a URL or inserted as HTML.

## POS checkout

`pos/` supplies a small, fictional catalogue with Code 128 and QR labels. The included SVG files have real quiet zones and can be printed or displayed on a second screen. Their known values are:

| Item | Format | Exact value | Illustrative price, AUD |
| --- | --- | --- | --- |
| Breakfast tea | Code 128 | `DEMO-TEA-01` | $6.50 |
| Rolled oats | Code 128 | `DEMO-OATS-02` | $4.20 |
| Reusable bag | QR | `DEMO:BAG:03` | $2.50 |

The scanner requires two matching camera frames. Once it confirms, it pauses decoding until **Scan next item**. The cart performs an exact `(format, text)` lookup and accepts each `scanId` at most once. A new intentional scan of the same label increments its quantity. Unknown values, format differences, whitespace changes and altered leading zeros do not match. The example does not interpret arbitrary GS1 fields or silently merge UPC/EAN identifiers.

Manual entry stops the camera, uses the same exact catalogue lookup and generates a new event ID for each intentional submission. Removing an item or clearing the cart retains consumed IDs, so delayed retries cannot re-add it. The demo stores up to 1,000 event IDs and rejects further events until a new page session. It does not persist a cart, take payments, adjust stock or provide a production transaction service.

Production integrations should validate the submitted identifier and price against their server catalogue, scope event IDs to a checkout, and enforce idempotency in the transaction database. Browser-only duplicate tracking cannot enforce these rules across devices, page reloads or network retries. A barcode check or multi-frame agreement is not proof of authenticity.

These static examples register the main scanner's shared service worker and check that its cache includes the `integration-examples` feature. Wait for **Offline examples ready** before disconnecting. **Check offline files** checks the cache and attempts to repair missing files while connected. An older installed version links to the main scanner's explicit update flow; the examples never activate a waiting update silently. Offline readiness applies to this browser, and browser storage eviction can remove it. The demo catalogue is bundled locally; a real application's catalogue and transaction synchronization remain its responsibility.

The camera SDK itself does not register a service worker or upload frames. When embedding it in another app, cache the app shell, SDK, helpers, worker and decoder through that host application's offline mechanism before claiming offline readiness.

The source project also includes a runnable React example under `examples/react/`.
