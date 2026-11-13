# Add scanning to your project

Version 0.9.0 provides a browser camera SDK with optional camera/target controls, JavaScript/TypeScript and Python backend clients, three working integration examples, a versioned OpenAPI contract, and customer access controls. These are source packages in this repository, not a published npm/PyPI service or a hosted subscription.

For camera-only POS integration, use `createScanner` and its confirmed `onScan` callback. The optional `attachScannerControls` UI adds supported flashlight/zoom controls, camera switching, balanced/detail capture, an aiming area and tap targeting. All three examples include it. Keep the complete `web/` asset tree together; copying only `scanner.js` is insufficient. See [SDK.md](SDK.md) for imports and options, and [COMPARISON.md](COMPARISON.md) for repeatable device trials.

For a camera panel loaded from your server with one classic script, use the [hosted embed](EMBEDDING.md). It works across website origins by hosting the scanner in its own iframe and passing confirmed events to the surrounding app. See `/scan/examples/embed/` for a working checkout demonstration.

## Pick the integration

| Need | Use | Runs offline? |
| --- | --- | --- |
| One script from your scanner server | [Hosted embed](EMBEDDING.md) | Local decoding after load; offline reload is not guaranteed |
| Live camera scanning inside a website | [Browser SDK](SDK.md) | Yes, after your app caches its page and all decoder assets |
| Plain HTML/JavaScript starting point | `/scan/examples/plain/` on the API host | Yes after its offline status reports ready |
| A POS catalogue/cart example | `/scan/examples/pos/` on the API host | Demo catalogue and cart run locally; production data/sync are your responsibility |
| React camera component | [React example](examples/react/README.md) | Decoder runs locally; host app supplies offline caching |
| Decode uploaded images or generate codes | [JavaScript backend client](clients/javascript/README.md) or [Python client](clients/python/README.md) | Requires a reachable running API server |
| Another programming language | `/docs`, `/openapi.json` or the committed [OpenAPI contract](openapi.json) | Same API network requirement |

The static examples also work when you publish the contents of `web/` directly: use `/examples/` instead of `/scan/examples/`. Keep the SDK, helpers, worker, vendor files and license notices together. The SDK has no external CDN requirement. The browser never needs a customer API key.

## Try a working example

From the project root, run `python -m http.server 8000 --bind 127.0.0.1 --directory web`, then open `http://127.0.0.1:8000/examples/`. This needs no API key or Python application dependencies. For a phone, serve the site over HTTPS; a plain HTTP LAN address does not provide camera/offline secure-context requirements.

The JavaScript example can import the included `web/examples/pos/labels/tea.png`. Choose one matching frame for this single-image check. With the normal two-frame setting, one image is correctly left unconfirmed. The POS example has printable labels and a manual-entry fallback. Its catalogue and prices are explicitly demonstration data. No payment is taken.

## Browser SDK contract

```html
<video id="camera" muted playsinline></video>
<button id="start">Start camera</button>
<button id="next">Scan next item</button>
<output id="result"></output>
<script type="module">
  import { createScanner } from '/scanner-assets/sdk/scanner.js';
  const scanner = createScanner({
    video: document.querySelector('#camera'),
    formats: ['ean13', 'upca', 'code128'],
    confirmationFrames: 2,
    onScan(scan) {
      document.querySelector('#result').textContent = scan.text;
      // Send scan.scanId, scan.format and scan.text to YOUR authenticated backend.
    },
    onError(error) { document.querySelector('#result').textContent = error.message; },
  });
  document.querySelector('#start').onclick = () => scanner.start().catch(() => {});
  document.querySelector('#next').onclick = () => scanner.rescan();
  window.addEventListener('pagehide', () => scanner.stop());
</script>
```

Copy `web/` to `/scanner-assets/` for this snippet. It is an example of SDK wiring; the complete plain/React examples also handle loading, stopped, cancelled, ambiguous and unavailable-camera states. Destroy the instance when removing it from a single-page application. See [SDK.md](SDK.md) for full API and lifecycle details.

Only one confirmed event is emitted per attempt. Call `rescan()` for the next item. An event has `scanId`, exact `text`, canonical `format`, `bytesBase64` and source-pixel `position`. It does not contain a product name or price. A `scanId` identifies an event, not a customer or permission to change stock.

## Connect a real POS, warehouse or ticket system

1. Restrict scanning to the barcode formats used by that workflow.
2. Accept a confirmed result and send it to your own authenticated business backend.
3. Match the exact format and identifier to one catalogue/record. Preserve leading zeros. Handle EAN/UPC equivalences only through explicit catalogue mappings.
4. Validate the requested business action and current record state. Unknown, expired, conflicting or multiple matches need a visible resolution path.
5. Store the scan event ID with the transaction in your database and enforce uniqueness in the relevant business scope. Retrying a request reuses the same ID; intentionally scanning a second item creates a new ID. Complete lookup/action/idempotency together as an appropriate database transaction.
6. Return the authoritative result to the UI. Server-side prices, stock and ticket state must not be trusted from browser-supplied values.

The POS demo uses bounded session memory for event deduplication and integer cents for demonstration totals. It is not a persistent cart, inventory ledger, payment system or cross-device duplicate detector. Offline business data, authorization and synchronization are separate from offline decoding. For a hosted barcode API, use each customer's own key on their backend; see [HOSTING.md](HOSTING.md).

## API compatibility and distribution

The API preserves `/v1` endpoints. Clients send exact multipart fields and return the server's confirmation/ambiguity response without guessing a winner. Errors expose HTTP status and available request IDs; no automatic retries are made. Server-side limits return `429` and `Retry-After`. Keep retries bounded and separate API processing from business transaction idempotency.

Run `python tools/export-openapi.py` after changing server models/routes. CI runs it with `--check` to detect a stale committed contract. Other-language clients can be generated from this OpenAPI schema using a compatible generator; the included hand-written clients have focused multipart and error-handling tests. [FastAPI client-generation guidance](https://fastapi.tiangolo.com/advanced/generate-clients/).

Original project code is distributed under the [MIT license](LICENSE), as selected by the owner. Copies of that notice accompany the browser assets and client packages. Third-party decoder, WebAssembly and font files keep their own notices in `web/vendor/`; experimental-engine attribution remains under `web/engine/`. Preserve those notices when redistributing a copied asset directory.

## Validation limits

See [TESTING.md](TESTING.md) for reproducible checks. Camera simulations and synthetic labels do not establish physical Android/iPhone performance. The deployment templates require validation on the intended Docker/nginx host. Per-customer limits and usage counters are single-process and reset on restart; they are not a distributed billing system. Use representative labels, devices and business workflows before relying on an integration operationally.
