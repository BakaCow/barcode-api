# Embed the camera scanner

`web/sdk/scanner.js` is a browser ES module. It supplies camera lifecycle, confirmed scan events, selected formats, frame selection and region retries without requiring the standalone scanner's HTML or history. It uses the same bundled ZXing worker and POS policy. It does not call the Python API, upload camera frames, or need a secret key.

## Install the assets

Copy the `web/` directory to a same-origin static directory such as `/scanner-assets/`. Preserve its filenames and `vendor/` license notices. Serve `.js` as JavaScript and `.wasm` as `application/wasm`. No npm install or external CDN is required for the SDK itself.

The required runtime files are `sdk/scanner.js`, `scan-policy.js`, `pos-policy.js`, `frame-analysis.js`, `capture-selection.js`, `scanner-worker.js`, `vendor/zxing-reader.js` and `vendor/zxing_reader.wasm`. Keeping the full `web/` folder also supplies the existing app, examples and offline assets. `scanner.d.ts` provides TypeScript declarations.

Use HTTPS in deployment or localhost for development. Camera permission is still required. Same-origin worker assets are required; putting only the JavaScript module on another origin does not make a cross-origin worker usable. The SDK's default asset directory is the parent of its `sdk/` directory. Set `assetBaseUrl` only when the worker/runtime files live at another same-origin directory.

## Minimal integration

```html
<video id="camera" muted playsinline></video>
<button id="start" type="button">Start camera</button>
<button id="next" type="button">Scan next item</button>
<button id="stop" type="button">Stop camera</button>
<p id="status" role="status"></p>
<output id="value"></output>
<script type="module">
  import { createScanner } from '/scanner-assets/sdk/scanner.js';

  const status = document.querySelector('#status');
  const scanner = createScanner({
    video: document.querySelector('#camera'),
    formats: ['ean13', 'upca', 'code128', 'qr'],
    confirmationFrames: 2,
    onStatus: event => { status.textContent = event.message; },
    onError: error => { status.textContent = error.message; },
    onScan: result => {
      document.querySelector('#value').textContent = result.text;
      // Pass result.scanId, result.format and the exact value to your application.
    },
  });

  document.querySelector('#start').onclick = () => {
    scanner.start().catch(() => {}); // onError displays operational errors above.
  };
  document.querySelector('#next').onclick = () => scanner.rescan();
  document.querySelector('#stop').onclick = () => scanner.stop();
  // In a component framework, call scanner.destroy() when the component unmounts.
</script>
```

Treat barcode values as data. Render text with `textContent`, and never execute a scanned URL or HTML string automatically. Product lookup, prices and cart updates belong to the host application. See the [plain JavaScript and POS examples](web/examples/README.md) and the [React example](examples/react/README.md).

## Methods and events

| Method | Behavior |
| --- | --- |
| `start({ deviceId?, facingMode? })` | Opens a camera and returns a promise. Default facing mode is `environment`. Concurrent starts share one operation. |
| `stop()` | Cancels pending work, stops camera tracks and terminates its worker. The scanner can be started again. |
| `destroy()` | Stops everything and removes page listeners. Create a new scanner to use it again. |
| `setOptions(partial)` | Validates settings and clears old confirmation evidence. |
| `rescan()` | Starts a fresh acceptance attempt. Required after each confirmed live scan. It does not reopen a stopped camera. |
| `scanImage(blob)` | Stops the camera and reads one PNG/JPEG/WebP image. Resolves to a confirmed result or `null`; operational failures reject. |

Available options are `formats`, `confirmationFrames` (1–3), `preferClearFrames` and `cropBarcodes`. The latter two default to `true`; default formats are EAN-13, UPC-A, Code 128 and QR, with two matching frames. Supported canonical format names also include `ean8`, `upce`, `datamatrix`, `aztec`, `pdf417` and `code93`. Unknown options, empty format lists and invalid settings are rejected.

`onScan(result)` delivers one result per accepted attempt:

```js
{
  scanId: 'unique-event-id',
  text: '00042',
  format: 'code128',
  bytesBase64: 'MDAwNDI=',
  position: {
    topLeft: { x: 10, y: 20 }, topRight: { x: 210, y: 20 },
    bottomRight: { x: 210, y: 90 }, bottomLeft: { x: 10, y: 90 }
  }
}
```

Positions use the source video/image pixel coordinate system, before CSS sizing; unavailable positions are `null`. Leading zeros and exact decoded text are preserved. Format names are canonical, but equivalent EAN/UPC identifiers are not silently merged. Use `bytesBase64` when the payload is binary.

Keep the same `scanId` if you retry sending that scan to your backend. The backend must enforce transaction idempotency; an ID alone does not prevent a duplicate database update. Calling `rescan()` creates a new attempt, so deliberately scanning the same label again creates a different event. Accepted live scans pause further decoding while leaving the camera preview on.

`onStatus({ state, message, reason? })` reports lifecycle and decision changes. States are `idle`, `starting`, `scanning`, `confirmed`, `ambiguous`, `rescan`, `error`, `stopped` and `destroyed`. Display `message` for users; use `state`/`reason` for application logic. `onError(error)` reports operational failures. Await and handle `start()` and `scanImage()` promises, including `AbortError` when another action cancels them. Validation errors can throw before a camera operation starts. Callback exceptions are sent to `onError` without restarting scanning.

## Confirmation, lifecycle and limits

Only a unique allowed identity can confirm. Conflicting codes remain ambiguous within the bounded attempt, even if one appears more often. Distinct frame IDs and full-capture pixel fingerprints are required; duplicate pixels add no evidence. A browser exposing only a playback clock cannot satisfy two- or three-frame confirmation. Single-frame mode is an explicit reduction of that protection.

Each image import is a separate attempt. A single image cannot meet a multi-frame requirement, and repeated imports do not accumulate votes. Select `confirmationFrames: 1` when an imported-image decision is appropriate. Import limits are 10 MiB and 20 million decoded source pixels; source dimension checking occurs after the browser decodes the file. Animated media is not a camera sequence and cannot add confirmation evidence.

The SDK samples at most three camera images. It uses the existing 240 ms selection window, drops buffered samples older than 600 ms, and rejects camera results older than 1.2 seconds. Captured live images are bounded to 2.1 million pixels and a 1920-pixel side; imported captures use four million pixels and the same side limit. Region retries preserve captured margins and do not invent sensor detail or provide exact perspective rectification. See [LIVE-SCANNING.md](LIVE-SCANNING.md) for the shared policy and decoding limits.

Stopping, hiding the page, changing options or destroying the scanner invalidates pending results. A late camera permission response has its tracks stopped. The SDK does not automatically restart when the page becomes visible. Worker initialization and decoder requests have finite timeouts; a user can leave the browser's camera permission prompt open, but `stop()`/`destroy()` cancels the SDK operation and releases any later-acquired stream.

## Offline embedding

The decoder runs locally. The SDK deliberately does not register a service worker that could take over the host business app. Your application's service worker must cache its own page, SDK/helper scripts, worker and WASM assets together. The included standalone scanner has its own offline installation flow. Its readiness label does not prove that a different application's page or product database is cached. Clearing browser data or cache eviction can require online setup again.

The SDK tests exercise camera simulations and real bundled WASM decoding of synthetic Code 128/QR images, including conflicting codes. They do not establish physical Android/iPhone camera accuracy or guarantee a correct product lookup. Evaluate target devices and labels before using the scanner for operational decisions.
