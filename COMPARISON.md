# Controlled camera comparison

Open `/benchmark/` on your scanner's HTTPS site to run labelled trials on Android Chrome or iPhone Safari. The included framework is runnable with our bundled decoder. **No physical-phone or Scanbot head-to-head results are included.** Scanbot is explicitly unconfigured until you supply its SDK files and an appropriate license. Its adapter has contract tests against the published API, not an integration test against the licensed binary.

This is a shared-camera **image-decoder** benchmark. It compares our worker's image recovery with Scanbot's single-shot image decoder, using the same browser capture and external POS confirmation policy. It does **not** compare their complete live camera SDKs, autofocus strategies, targeting interfaces or adaptive frame selection. Sequential camera trials have different frames. Never describe results from this harness as proof of Scanbot parity or superiority.

## Run a study

1. Use a separate evaluation set with known exact text and symbology, checked independently before testing. Include ordinary product labels, distance, blur, oblique angles, glare, low light, damaged labels and negative scenes. Keep tuning/development images out of this set. `examples/benchmark/cases.example.json` is a planning template, not results or an automatically imported corpus.
2. Record phone model, OS/browser versions, label dimensions, lighting, distance and angle in a local study log. Use a short non-personal device ID in the page. Real packaging belongs to `real`; generated labels and screen-displayed fixtures belong to `synthetic`, even if filmed with a physical phone. Do not relabel simulation data as real.
3. Choose one session, case ID and repetition number. Enter truth **before** preparing the trial. Text remains an exact string: leading zeros, casing, whitespace, UPC-A versus EAN-13 and QR text differences are not merged. Choose the negative-case checkbox only when no accepted barcode should exist in view.
4. Select allowed formats, one-to-three matching frames and a 5/10/15-second horizon. Prepare the engine/camera, place the case in the full view and press **Begin timed trial**. Settings and truth are locked until the trial ends. Hold conditions fixed for the entire horizon, including after a first result. Camera permission, SDK initialization and initial frame readiness are excluded from timing.
5. Repeat with the other engine using identical session/device/case/repetition/format/confirmation settings. Alternate engine order across repetitions. Reuse labels and a fixed phone support where possible. Do not allow a first result from one engine to reveal the truth for the other.
6. Select each export engine and download its local JSON report. Reports disappear on reload; download before leaving. Repeat on an actual Android phone and iPhone, keeping their device IDs distinct. A desktop browser emulating a phone viewport is still a simulation.

Capture uses the browser's preferred rear camera at an ideal 1920×1080. The entire frame is bounded to 1920 pixels per side and 2.1 million pixels. The report records delivered source/capture dimensions and available camera facing/focus/exposure/zoom/frame-rate settings; unknown settings stay explicitly unknown. No manual torch/zoom/targeting is used. Browser camera auto adjustments and unknown controls remain an experimental limitation.

Frames require a browser presentation/decoded-frame counter and fresh whole-pixel fingerprints. One decode runs at a time, with at least 120 ms between capture starts. Slow decoders consequently see fewer frames. Timing includes canvas capture, fingerprinting, decoding, recovery and external confirmation. An acceptance needs the configured number of matching fresh observations within the existing POS policy's 2.5-second attempt; conflicts fail closed for that attempt. After acceptance the policy resets and continues, allowing the report to retain a wrong first result followed by a correct result. Repeated accepted observations can therefore generate multiple confirmation events; these are **not cart additions**.

Trial deadlines stop accepting results, including work that began before the deadline but completed afterward. Cancel, close-camera, tab hiding and camera/decoder errors create interrupted outcomes, not misses. Camera and our worker stop after the trial. A native vendor decode already running might finish after closure; its result is discarded. The published vendor API used here has no verified instance-destruction method: disposing our adapter drops its reference and rejects later results, but does not claim immediate cancellation/release of vendor internals. Download and reload between extended vendor batches if resource usage accumulates.

## Optional Scanbot setup

Use a trusted copy of the official Web SDK, hosted on the **same origin** as this page. Do not upload a license to GitHub or place it in a URL. This repository does not fetch a CDN, bundle proprietary files or store a license. The page accepts its license in a password field for runtime use only; reports use a strict allowlist that excludes keys, paths, URLs and pixels. Browser-injected third-party code still runs with your page's privileges; use only the trusted package and check its deployment/network requirements.

The following example layout follows the official [manual package installation](https://docs.scanbot.io/web/barcode-scanner-sdk/detailed-setup-guide/installing-the-sdk/) and [engine location instructions](https://docs.scanbot.io/web/barcode-scanner-sdk/detailed-setup-guide/initializing-the-sdk/):

```text
web/scanbot/
  scanbot-entry.js          # copy examples/benchmark/scanbot-entry.example.js
  package/
    bundle/
      ScanbotSDK.min.js
      bin/barcode-scanner/  # complete directory from the same package version
```

Obtain and extract a pinned SDK package version from Scanbot using your usual package workflow. Preserve its full bundle structure. The included wrapper loads only the adjacent local bundle and exports its documented `ScanbotSDK` global. Alternatively supply an ESM build whose default export is the official SDK class. **Do not commit** your downloaded vendor package or license with this project's original source.

In **Configure Scanbot locally**, enter (adjust for a GitHub Pages project subpath):

- Module: `/scanbot/scanbot-entry.js`
- Engine directory: `/scanbot/package/bundle/bin/barcode-scanner/`
- License: your runtime license for that deployment.

Cross-origin, credential-bearing, query-string and fragment URLs are rejected. Missing/incompatible modules remain unconfigured. Initialization checks the SDK's documented license status before camera setup; invalid licenses cannot start a trial. Later decoder failures stop a trial as an error and do not count as misses. A still-pending vendor request blocks preparation of another vendor trial, preventing overlapping measurements. Vendor scripts and engine assets are deliberately excluded from the project's offline precache; configuring this adapter does not establish offline readiness for Scanbot. Hosting headers/CSP and licensing must support the supplied SDK.

The adapter calls the documented [`detectBarcodes`](https://api-docs.scanbot.io/web/classes/ScanbotSDK.html#detectBarcodes) with [`Image.fromImageData`](https://api-docs.scanbot.io/web/classes/Config.Image.html#fromImageData) and `CONSUME_IMAGE`. It maps each explicit format to the vendor's enum and retains `text`/`rawBytes`. No check digits or leading zeros are stripped. The version comes from the initialized SDK. The configuration label `scanbot-single-shot` fixes single-shot processing, full-image acceptance, document extraction off, returned images off, strict format validation, unchanged check digits, no added quiet zone, GS1 parsing, verbose logging off and threads off. Consult the [format configuration](https://api-docs.scanbot.io/web/classes/Config.BarcodeFormatCommonConfiguration.html) and [scanner configuration](https://api-docs.scanbot.io/web/classes/UIConfig.BarcodeScannerConfiguration.html) APIs. These choices make the common external policy explicit; they do not replicate vendor live-mode tuning. Our `worker-image-signal-v1` label identifies ZXing with QR geometry/grid recovery plus the guarded ZBar/project Code 128 checks and means `mode: image`, enhancement on, allowed formats forwarded, native per-image confirmation one, followed by the shared external policy.

## Compare reports or import external results

From the repository root:

```powershell
node tools/compare-scanners.mjs --left benchmark-barcode-api.json --right benchmark-scanbot.json --output comparison.json
```

The command reads local files only and refuses an existing output path. It validates the strict `barcode-comparison/v1` contract in `web/benchmark/metrics.mjs`. Unknown fields, malformed timestamps, duplicate run IDs or case/repetition/engine keys, mixed engine versions/configurations and unpaired cases are errors. Same-case pairs must match session, device, truth, source, repetition, all capture options and recorded camera settings; JSON key/format-list order does not matter. Timing horizons and configuration differences are included in the comparison. Keep original inputs alongside the summary.

An external runner can import its results by writing that exact JSON contract and using the command above. It must genuinely implement `shared-camera-image-v1` and `pos-v1`, preserve independent truth, account for all attempts and accurately identify its engine version/configuration. Other SDK live modes, stored-image corpora, recordings or different confirmation rules require a separately versioned protocol/analysis rather than relabelling them to pass validation. The current CLI intentionally rejects those as paired results. No vendor result is synthesized automatically.

Metrics have explicit denominators:

- **Clean correct:** completed positive trial with a correct confirmation and no wrong confirmations during the horizon.
- **Missed:** completed positive trial with no correct confirmation. A wrong-only trial is both a miss and a trial with wrong acceptance.
- **Wrong first / any wrong:** exact format/text disagreed with declared truth; any accepted result in a negative case is wrong. Later correctness never erases an earlier wrong result.
- **First confirmation / first correct:** separate elapsed times. First-correct median uses completed trials with a correct result; it is conditional on eventual success and must be read alongside misses and wrong-first counts. Per-pair reports retain both times.
- **Correct negative:** completed negative trial with no accepted result.
- **Cancelled / errors:** excluded from completed-trial accuracy and latency denominators. Their observed wrong confirmations remain visible in the interrupted-trial counters and raw events.
- **Real / synthetic:** separate trial source counts, including interrupted trials. Stratify results by source, device, format and condition before drawing conclusions; pooled counts are not an accuracy claim.

Automatic checks:

```powershell
node --test tests/comparison-benchmark.test.mjs
```

These test accounting, schema rejection, mixed-protocol refusal, local JSON export, the optional adapter's API contract and our actual bundled WASM through a synthetic two-frame confirmation. They are not a substitute for physical-phone trials or licensed Scanbot measurements.

## Surface brief

The comparison page is an **Operate** surface: prepare one declared case, run a bounded trial, inspect its outcome and export evidence. It follows PRODUCT.md and DESIGN.md's Public Sans, paper, green, blue-focus and amber/error vocabulary. Native labelled fields, a single primary action per phase, responsive stacking, live status, accessible errors and a horizontally scrollable results table keep the benchmark usable on phones. User-provided labels/results are inserted with `textContent`; no barcode payload is rendered as HTML.
