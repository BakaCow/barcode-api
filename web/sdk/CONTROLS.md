# Optional camera controls

`controls.js` adds a compact **Camera and targeting** disclosure around a headless scanner. It does not open a camera, make API requests or change matching-frame requirements. Keep `controls.css` next to it and include that stylesheet in your page. All controls use the scanner SDK's public methods.

```html
<link rel="stylesheet" href="/scanner-assets/sdk/controls.css">
<div style="position:relative;aspect-ratio:4/3">
  <video id="video" muted playsinline style="width:100%;height:100%"></video>
</div>
<div id="camera-controls"></div>
<script type="module">
  import { createScanner } from '/scanner-assets/sdk/scanner.js';
  import { attachScannerControls } from '/scanner-assets/sdk/controls.js';
  let controls;
  const scanner = createScanner({
    video: document.querySelector('#video'),
    onScan: scan => console.log(scan),
    onStatus: status => controls?.updateStatus(status),
    onCandidates: areas => controls?.updateCandidates(areas),
  });
  controls = attachScannerControls({
    video: document.querySelector('#video'),
    container: document.querySelector('#camera-controls'),
    scanner,
  });
  // Your Start button awaits scanner.start(); your Stop button calls scanner.stop().
  // On component removal: controls.destroy(); scanner.destroy();
</script>
```

The controls show available cameras after permission, enable flashlight/zoom only when the current browser and camera expose them, and offer Balanced or More detail capture. Changing detail restarts an active camera through `setCaptureMode`; it never opens a stopped camera. Unsupported controls remain disabled with an explanation. Capability detection does not guarantee every advertised hardware operation succeeds; failures are shown inline.

**Read clear frames immediately** changes the adaptive frame-selection option. Two-frame confirmation remains the default and must still be satisfied. For comparison, disable this option to retain the bounded frame-selection burst.

**Aim at centre** selects a starting area. **Adjust scan area** exposes four native, keyboard-accessible sliders for its left edge, top edge, width and height. Arrow keys adjust each value by 0.1% of the image; limits keep the rectangle inside the frame. This can select any off-centre area without a pointer. The status announces its position and size. A tap inside the displayed video selects a suggested rectangle or an area around the tap; **Scan full view** clears the target. The video uses `object-fit: contain`, so letterbox bars are excluded from target coordinates. The selected area has a solid green border; suggestions have dashed blue borders. Suggestions are image heuristics, not accepted barcode readings. Codes outside the selected region are excluded; conflicting values inside it remain ambiguous.

Supported controls retain keyboard focus while a camera adjustment runs. They expose `aria-disabled="true"` while busy, and their handlers reject additional operations until the current one settles. Unsupported controls remain natively disabled. Stopping or destroying the scanner cancels the operation without showing an error for expected cancellation.

`attachScannerControls` returns `refresh()`, `setTargetRegion(region|null)`, `updateStatus(status)`, `updateCandidates(payload)` and `destroy()`. Wire the two update methods to the corresponding scanner callbacks. Effective target/adaptive settings are read from `scanner.getOptions()`, including options supplied before attachment or changed by the host. `refresh()` re-reads camera capabilities and the device list. `destroy()` removes listeners, overlays and the control content, cancels pending UI updates, and restores the video fit styles. It does not destroy the scanner; the host owns that lifecycle.

Use a dedicated controls container. The video should sit in its own positioned stage. CSS uses the existing `--ink`, `--green`, `--secondary`, `--line`, `--focus` and error-color variables when available, with matching fallback values. TypeScript declarations are included in `controls.d.ts`.

These controls are exercised in the plain JavaScript, POS and React examples. Hardware behavior still requires checking on the actual phones and browsers you intend to use.
