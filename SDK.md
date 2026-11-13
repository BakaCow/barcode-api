# Embed the camera scanner

`web/sdk/scanner.js` is a browser ES module. It supplies camera lifecycle and controls, confirmed scan events, selected formats, adaptive frame selection and source-region retries without requiring the standalone scanner's HTML or history. It uses the same bundled ZXing worker and POS policy. It does not call the Python API, upload camera frames, or need a secret key.

Need a camera panel from your server without copying assets into the customer site? Use the [one-script hosted embed](EMBEDDING.md). The headless SDK documented below still requires its assets on the same origin as its own page.

## Install the assets

Copy the `web/` directory to a same-origin static directory such as `/scanner-assets/`. Preserve its filenames and `vendor/` license notices. Serve `.js` as JavaScript and `.wasm` as `application/wasm`. No npm install or external CDN is required for the SDK itself.

The required runtime files are `sdk/scanner.js`, `sdk/capture-tools.js`, `scan-policy.js`, `pos-policy.js`, `frame-analysis.js`, `capture-selection.js`, `capture-geometry.js`, `scanner-worker.js`, `vendor/zxing-reader.js` and `vendor/zxing_reader.wasm`. Keeping the full `web/` folder also supplies the existing app, examples and offline assets. `scanner.d.ts` provides TypeScript declarations. The optional [reusable controls](web/sdk/CONTROLS.md) supply camera, flashlight, zoom, capture-profile and target controls for plain JavaScript or React hosts.

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
| `setOptions(partial)` | Validates settings and clears old confirmation evidence while preserving the pause after an accepted scan. Use `setCaptureMode()` to change the profile while a camera is active or starting. |
| `getOptions()` | Returns a copy of the effective settings, including independent format and target copies. |
| `rescan()` | Starts a fresh acceptance attempt. Required after each confirmed live scan. It does not reopen a stopped camera. |
| `scanImage(blob)` | Stops the camera and reads one PNG/JPEG/WebP image. Resolves to a confirmed result or `null`; operational failures reject. |
| `listCameras()` | Returns a promise of `{ deviceId, label }[]` without opening a camera. Permission may be needed before the browser reveals names or additional cameras. |
| `getCameraCapabilities()` | Returns the current profile, dimensions, camera ID and available torch/zoom controls. |
| `setTorch(enabled)` | Requests a supported flashlight setting; resolves to refreshed capabilities. |
| `setZoom(value)` | Clamps and rounds a finite value to the reported zoom range and step; resolves to refreshed capabilities. |
| `switchCamera(deviceId)` | Stops the current camera and starts the chosen device. Requires an active or starting camera. |
| `setCaptureMode('balanced' \| 'detail')` | Updates the profile and restarts an active camera with new ideal dimensions. An idle scanner stays idle. |

Options and defaults are:

| Option | Default | Behavior |
| --- | --- | --- |
| `formats` | `['ean13', 'upca', 'code128', 'qr']` | Allowed formats. Also supports `ean8`, `upce`, `datamatrix`, `aztec`, `pdf417` and `code93`. |
| `confirmationFrames` | `2` | Requires 1–3 distinct agreeing frames. |
| `preferClearFrames` | `true` | Selects a clearer frame from a bounded burst. |
| `adaptiveFrameSelection` | `true` | With frame selection enabled, immediately decodes a sufficiently clear frame with one useful-sized proposal; weaker frames still use the burst. |
| `cropBarcodes` | `true` | Enables heuristic region retries. Explicit targets still apply when this is false. |
| `captureMode` | `'balanced'` | `'detail'` requests higher source dimensions and enables bounded source-pixel recovery. |
| `targetRegion` | `null` | Full view, or a normalized source rectangle `{ x, y, width, height }`. |

Unknown options, empty format lists and invalid settings are rejected. Changing a setting clears earlier confirmation evidence. Adaptive selection changes when decoding begins; it does not lower the confirmation requirement.

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

Keep the same `scanId` if you retry sending that scan to your backend. The backend must enforce transaction idempotency; an ID alone does not prevent a duplicate database update. Calling `rescan()` creates a new attempt, so deliberately scanning the same label again creates a different event. Accepted live scans pause further decoding while leaving the camera preview on. Flashlight, zoom, target and option changes, camera switching and capture-profile restarts preserve that pause; they cannot emit another product scan by themselves. Use `rescan()` for the next item. Explicitly calling `start()` after stopping the camera or importing an image begins a new live attempt; each explicit `scanImage()` also begins its own attempt.

`onStatus({ state, message, reason? })` reports lifecycle and decision changes. States are `idle`, `starting`, `scanning`, `confirmed`, `ambiguous`, `rescan`, `error`, `stopped` and `destroyed`. Display `message` for users; use `state`/`reason` for application logic. `onError(error)` reports operational failures. Await and handle `start()` and `scanImage()` promises, including `AbortError` when another action cancels them. Validation errors can throw before a camera operation starts. Callback exceptions are sent to `onError` without restarting scanning.

`onCandidates({ regions, sourceWidth, sourceHeight, frameId })` reports heuristic regions for an aiming overlay. Each region has normalized source coordinates and a `kind` of `linear` or `matrix`. These are proposals, not decoded identities or confirmed scans. A region can contain no barcode or several barcodes. Only `onScan` reports acceptance.

## Camera controls and targeting

Inspect capabilities after `start()` and after switching cameras. The shape is:

```js
{
  active: true, deviceId: 'browser-camera-id', width: 1920, height: 1080,
  captureMode: 'balanced',
  torch: { supported: true, enabled: false },
  zoom: { supported: true, min: 1, max: 4, step: 0.1, value: 1 }
}
```

Unsupported zoom is `null`; unsupported torch has `supported: false`. Dimensions are zero and the device ID is `null` when unavailable. Support comes from the active track's runtime capabilities, not an Android/iPhone name assumption. Camera settings report actual values where the browser exposes them; otherwise controls use their last successful request. Browser zoom may be digital. Requesting a control can reject, so handle the promise and refresh the displayed capabilities. Control requests serialize, suspend decoding, preserve other camera constraints, and reset evidence before and after the change. An already accepted scan remains paused until explicitly rearmed. Stop, destroy and camera changes cancel pending requests.

```js
const capabilities = scanner.getCameraCapabilities();
if (capabilities.torch.supported) await scanner.setTorch(true);
if (capabilities.zoom) await scanner.setZoom(2);
await scanner.setCaptureMode('detail');
scanner.setOptions({ targetRegion: { x: 0.2, y: 0.3, width: 0.6, height: 0.4 } });
// To return to the full view:
scanner.setOptions({ targetRegion: null });
```

Targets are normalized against the original video/image, before CSS scaling, letterboxing or mirroring. All four values must be finite; widths/heights must be positive and the entire rectangle must fit within 0–1. A target applies to both live and imported images. It deliberately excludes labels outside the rectangle; multiple values detected inside it remain ambiguous. Result positions still refer to the original source. Clear or update a target when changing your application's framing. The reusable controls handle a contained video layout and map taps through its letterboxing; custom layouts must supply their own equivalent mapping.

## Confirmation, lifecycle and limits

Only a unique allowed identity can confirm. Conflicting codes remain ambiguous within the bounded attempt, even if one appears more often. Distinct frame IDs and full-capture pixel fingerprints are required; duplicate pixels add no evidence. A browser exposing only a playback clock cannot satisfy two- or three-frame confirmation. Single-frame mode is an explicit reduction of that protection.

Live recovery chooses one enhancement method per captured frame, including its detail crops. When a method reads a code, the SDK reuses it on the next fresh frame to collect confirmation promptly. A miss advances the search; a new scan or settings change resets it. Each frame still starts with a full-view decode, all planned crops retain ambiguity checks, and repeated pixels never count as another matching frame. Reusing a method is not another vote for its previous result.

Each image import is a separate attempt. A single image cannot meet a multi-frame requirement, and repeated imports do not accumulate votes. Select `confirmationFrames: 1` when an imported-image decision is appropriate. Import limits are 10 MiB and 20 million decoded source pixels; source dimension checking occurs after the browser decodes the file. Animated media is not a camera sequence and cannot add confirmation evidence.

The SDK buffers at most three camera samples. Weak frames use a 240 ms selection window, buffered samples older than 600 ms are dropped, and camera results older than 1.2 seconds are rejected. Balanced mode requests ideal 1920×1080 video, bounds live captures to 2.1 million pixels and a 1920-pixel side, and bounds imported captures to four million pixels with the same side limit.

Detail mode requests ideal 3840×2160 video; the browser chooses available dimensions, so this does not guarantee 4K. It snapshots a live frame once (at most 3840 pixels per side and 8,294,400 pixels), prepares the broad pass plus at most two one-million-pixel source crops, then releases the large snapshot before buffering. The broad pass runs first. Only an empty broad result allows source-crop recovery; observed full-view conflicts are retained. Crops come from that same snapshot and contribute at most one frame of confirmation evidence. A detail-mode explicit target can retain up to four million pixels with a 3840-pixel side. Source recovery starts no new retry after its 350 ms live/2.5 s image budget; a partial recovery cannot accept a unique value while another planned crop remains unchecked. Individual worker calls still have their own timeout. Higher source resolution increases capture cost and memory, so benchmark it on the target devices.

Quality and fingerprint analysis runs in the decoder worker. Where worker OffscreenCanvas and canvas ImageBitmap are available, scaling, pixel readback and source-crop preparation also run there. The UI thread still makes one bounded snapshot. Unsupported or failed bitmap capture falls back to canvas capture/crops on the UI thread while transferring buffers for worker analysis. Only one capture is prepared at a time; cancellation and freshness checks apply to both paths. Run `node tools/benchmark-analysis-thread.mjs` for a synthetic desktop measurement of CPU placement; this excludes browser capture/rendering and does not establish phone FPS or recognition accuracy.

Region retries preserve captured margins and do not invent sensor detail or provide exact perspective rectification. See [LIVE-SCANNING.md](LIVE-SCANNING.md) for the shared policy and decoding limits.

Stopping, hiding the page, changing options or destroying the scanner invalidates pending results. A late camera permission response has its tracks stopped. The SDK does not automatically restart when the page becomes visible. Worker initialization and decoder requests have finite timeouts; a user can leave the browser's camera permission prompt open, but `stop()`/`destroy()` cancels the SDK operation and releases any later-acquired stream.

## Offline embedding

The decoder runs locally. The SDK deliberately does not register a service worker that could take over the host business app. Your application's service worker must cache its own page, SDK/helper scripts, worker and WASM assets together. The included standalone scanner has its own offline installation flow. Its readiness label does not prove that a different application's page or product database is cached. Clearing browser data or cache eviction can require online setup again.

The SDK tests exercise camera simulations and real bundled WASM decoding of synthetic Code 128/QR/EAN images, including conflicting codes, source-coordinate mapping and selected targets. A forced broad-pass miss verifies high-resolution recovery routing; that test is not evidence of a measured accuracy improvement. Tests do not establish physical Android/iPhone camera accuracy or guarantee a correct product lookup. Evaluate target devices and labels before using the scanner for operational decisions.
