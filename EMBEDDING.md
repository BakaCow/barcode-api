# Add the hosted scanner with one script

Host the complete `web/` directory over HTTPS. The existing Python server publishes it at `/scan/`. Customers can then load the camera panel from your server without copying the SDK, worker or WebAssembly files into their own project.

## Paste the scanner into a page

Replace the example domain with your deployed server. Put this tag in the page body where the scanner should appear:

```html
<script src="https://scanner.example.com/scan/embed.js"
        data-barcode-scanner defer></script>
```

The panel contains an explicit Start camera button, Stop, Scan another, confirmed value and optional camera/targeting controls. It uses the available container width. It never opens the camera on load. Camera frames are decoded on the visitor's device, not uploaded to the server. No API key is needed.

For a static deployment that publishes the contents of `web/` at the domain root, the URL is `https://scanner.example.com/embed.js`. Paths are resolved from the loader's URL, so subdirectory deployments work too. Keep the adjacent `embed/`, `sdk/`, helper and `vendor/` files in place. The loader is a classic script; do not add `type="module"`.

Open `/scan/examples/embed/` on the API host (or `/examples/embed/` on a static host) for a working camera and demonstration POS cart. Its Copy script button uses that deployment's actual address.

## Connect the result to a POS or other application

The script installs the camera panel. Your application still supplies product lookup, prices and transaction handling:

```html
<div id="product-scanner"></div>
<script src="https://scanner.example.com/scan/embed.js"
        data-barcode-scanner data-target="#product-scanner"
        data-formats="ean13,upca,code128,qr"
        data-confirmation-frames="2" defer></script>
<script>
  document.getElementById('product-scanner').addEventListener('barcode:scan', event => {
    const { scanId, format, text, bytesBase64, position } = event.detail;
    // Look up the exact format + text in your own catalogue.
    // Send scanId to your authenticated backend for transaction deduplication.
    // Render arbitrary values with textContent, not innerHTML.
  });
</script>
```

The events bubble from the mount element. A single auto-created panel can be observed with `document.addEventListener('barcode:scan', handler)`. With multiple panels, listen on each dedicated mount element. Results contain the same fields as [SDK ScanResult](SDK.md): a unique scan ID, exact text, canonical format, base64 bytes and source-pixel corners (or null). An empty text may represent a binary payload. A confirmed value is not proof of a product match or authority to modify stock.

Accepted scanning pauses until the user selects Scan another or the host explicitly calls `rescan()`. Camera settings do not silently rearm an accepted scan. Do not automatically rescan on every callback unless your application has deliberately designed that repeated-item workflow. Keep the scan ID when retrying a business request; enforce deduplication on your backend.

| Script attribute | Default | Purpose |
| --- | --- | --- |
| `data-barcode-scanner` | Absent | Opt into automatic mounting; omit for manual mounting |
| `data-target` | New container before this script | CSS selector for an existing element |
| `data-formats` | `ean13,upca,code128,qr` | Comma-separated SDK format allowlist |
| `data-confirmation-frames` | `2` | One, two or three matching frames |
| `data-controls` | `true` | Set `false` to hide optional camera/targeting controls |

| Event | `event.detail` |
| --- | --- |
| `barcode:ready` | Mounted instance; the camera is still off |
| `barcode:scan` | Confirmed ScanResult |
| `barcode:status` | SDK status: state, message and optional reason |
| `barcode:error` | Error with a readable message |

## Manual mounting and component cleanup

Load the classic script once, without `data-barcode-scanner`. After it loads, use the global `window.BarcodeCamera`:

```javascript
const embedded = window.BarcodeCamera.mount(document.querySelector('#product-scanner'), {
  formats: ['ean13', 'upca', 'code128'],
  confirmationFrames: 2,
  controls: true,
  onScan(result) { /* Your application handles this confirmed event. */ },
  onStatus(status) { /* Optional host status display. */ },
  onError(error) { /* Optional host error display. */ },
});
await embedded.ready; // Configured, not permission granted or camera started.
// embedded.stop();    // Cancel camera work.
// embedded.rescan();  // Permit the next item after a confirmed result.
// embedded.destroy();// Unmount, release the camera and remove listeners.
```

Use either the callback or event as the transaction handler, or deduplicate the scan ID if you intentionally use both. Call `destroy()` when removing a React/Vue/other component. Removing the mount/frame also triggers cleanup. Hiding the host page stops the camera; returning does not automatically restart it. Reloaded or navigated frames require a new mount. Repeated script tags are supported without installing duplicate global listeners for the same tag.

`web/embed.d.ts` supplies `EmbedOptions`, `EmbeddedScanner` and `BarcodeCameraAPI` types and augments `Window`. Include its declaration in a TypeScript integration; it does not turn the classic loader into an ES module. The first loader establishes the default server for manual mounts; auto-mounted tags resolve their own script server.

## HTTPS, permissions and site policies

Both the customer's website and scanner server must use HTTPS (localhost is allowed for development). The loader creates an iframe on the scanner server and delegates camera access through its `allow` attribute. The iframe runs the existing SDK with worker files on its own origin, while validated messages carry confirmed results back to the host. The underlying headless SDK's same-origin asset requirement remains unchanged.

The parent website can still block camera access with its response headers. If it uses a restrictive `Permissions-Policy`, its camera policy must include the scanner origin, for example `camera=(self "https://scanner.example.com")`. If it uses CSP, allow the scanner origin in the relevant `script-src` and `frame-src` directives. Merge these entries into the site's existing policy; do not replace or remove its other protections. Nested frames need delegation through every ancestor. Strict cross-origin-isolation policies may need additional deployment-specific integration. See [camera permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) and [iframe permissions](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).

Your scanner server must allow its widget to be framed by customer origins: do not put `X-Frame-Options: DENY`/`SAMEORIGIN` or an incompatible CSP `frame-ancestors` on the widget page. The supplied application/nginx template adds no such block. No broad API CORS setting or browser-visible API secret is required. The ordinary `/v1` HTTP APIs keep their existing authentication and backend-only usage.

The widget provides Open scanner separately as a recovery link. That opens the standalone scanner; results in that separate page are not automatically returned to the original POS. Website builders that strip scripts or disallow camera frames cannot install this by pasting the tag into ordinary text content.

## Hosting, offline behavior and limits

Deploy the complete updated `web/` tree together. The loader, iframe page and decoder must be compatible versions. The hosted loader executes in the customer's page, so customers should use a scanner server they trust and test updates. The bridge validates the exact origin, sending window, protocol version and per-instance channel, rejects stale/replayed results, and never treats barcode text as executable markup. See [postMessage security guidance](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage).

The embed does not install a service worker on the customer's site. Once loaded, decoding runs locally, but opening/reloading a third-party embed without a connection is not guaranteed. Browser storage partitioning and eviction differ. Use the [self-hosted SDK](SDK.md) and your application's controlled cache for dependable offline startup. The existing standalone scanner's Offline ready status does not prove a different customer's site is cached.

There is no signup, subscription or license enforcement in this public embed. Original project code remains MIT, with third-party notices retained. Customer catalogue data, business authorization, payments and durable transaction records belong to the host application. Cross-origin loading and simulated camera scanning have been checked locally; physical Android/iPhone permission and recognition behavior still needs target-device testing.
