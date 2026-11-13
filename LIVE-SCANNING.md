# Live POS scanning, clearer frames and barcode crops

Version 0.7.0 adds an optional POS mode to the browser camera scanner, short-burst frame selection, and retries around detected barcode regions. All three run on the device. Camera images are not sent to the Python API, and these features work offline after the updated files have been cached.

## Use the controls

1. Open `/scan/` on the API host, or the scanner's address on your static host. Apply **Update app** if offered and wait for **Offline ready**.
2. Enable **POS mode** above the camera when scanning one product at a time.
3. Open **Scanning options**. Keep only the barcode formats your products use and choose **Matching frames**: two is the default, three asks for more agreement, and one explicitly disables confirmation across frames.
4. Choose **Start camera**, allow access, and keep one complete label and its blank border in view.
5. Follow the status message. If readings conflict, isolate the intended label and choose **Start a new scan**. Use the confirmed value for an exact product lookup in your own POS.

The defaults are:

| Control | Default | Effect |
| --- | --- | --- |
| POS mode | Off | Turn on the single-product acceptance policy |
| Prefer clearer camera frames | On | Decode the best-scoring fresh image from a short camera burst |
| Retry detected barcode areas | On | After an unsuccessful whole-image read, retry likely barcode regions |
| Matching frames, in POS mode | 2 | Require agreement across distinct frame IDs and pixel fingerprints |
| POS formats | EAN-13, UPC-A, Code 128, QR code | Restrict the native decoder before it reads the image |

Additional POS formats are EAN-8, UPC-E, Data Matrix, Aztec, PDF417 and Code 93. At least one format must remain selected. These settings apply to the current page session; reloading returns them to their defaults. Camera selection, flashlight and zoom remain available where the browser and camera support them.

## What POS mode checks

The worker passes the selected formats to the native reader on its original, cropped and enhanced passes, then filters the returned results defensively. Unsupported families are not candidates for confirmation.

A candidate identity includes its canonical format, raw payload bytes **and exact decoded text**. QR character-encoding differences can give identical bytes different meanings; those readings cannot confirm each other. EAN-13 and UPC-A remain different identities. Native UPC-A and UPC-E representations may include a leading zero or expanded identifier. The scanner does not silently remove digits or merge those formats.

- **Confirmed:** exactly one observed identity reaches the selected agreement threshold. Only confirmed POS results enter history or trigger the new-scan sound.
- **Conflicting codes:** multiple identities were observed in the current attempt. A majority does not select a winner.
- **Rescan / waiting:** no allowed result, insufficient agreement, stale evidence, or frame freshness that cannot be verified.

Attempts expire as a whole after 2.5 seconds. Conflicts remain attached to their attempt until it expires or you explicitly start a new scan. Camera stops and changes to scanning settings, camera, zoom or flashlight clear buffered images and confirmation evidence. Replies from before a settings change are discarded. A successful confirmation begins a fresh attempt for the next scan.

Repeated frame IDs, repeated pixel fingerprints and duplicate detections within one image cannot add confirmation evidence. A blank decoded frame does not create a match or reset existing agreement, but cannot itself trigger acceptance. Pixel fingerprints and browser frame counters reduce repeated-frame mistakes; they do not prove separate physical camera exposures. A persistently wrong reading can still satisfy the agreement policy.

When the browser supplies only a playback clock, POS confirmation across two or three frames is unavailable. The status explains this limitation. Use a browser with presented-frame callbacks or decoded-frame counters, or explicitly choose single-frame mode. That fallback removes the multi-frame protection.

### Imported images

**Scan image** respects the POS allowlist and ambiguity checks. A single image cannot satisfy a two- or three-frame requirement, and separate imports do not accumulate agreement. Use the camera for multi-frame confirmation, or explicitly select one matching frame when you want a single-image decision. Importing two conflicting codes remains ambiguous even in single-frame mode.

## How clearer-frame selection works

The app samples a bounded burst of up to three fresh camera images, with a 240 ms selection window. It ranks image detail, contrast and edges around likely barcode content and selects the highest-scoring frame; ties prefer the newer frame. Buffered images older than 600 ms are discarded. POS results from captures older than 1.2 seconds are also discarded. These are freshness limits, not a promise of a particular scan time.

Quality hints may suggest adding light, holding still, moving closer, moving back to avoid clipping, or tilting to reduce possible glare. They are image heuristics, not measurements from an autofocus or exposure sensor. The app does not reject every low-scoring frame or invent missing barcode pixels. If the scene is difficult, turn off **Prefer clearer camera frames** to compare behavior with immediate frame decoding.

Selection analyzes the captured image, not a later frame from the video. At most three live captures are retained temporarily for this selection. They are cleared on selection, stop or reset and are not saved in scan history or uploaded.

## How barcode-region retries work

The original full captured image is decoded first. If it already returns allowed codes, those results remain together for ambiguity handling. A crop cannot replace a conflict already found in that image.

When the full image has no accepted result, a bounded gradient detector proposes likely linear or matrix-code regions. It retains surrounding pixels for quiet zones, copies pixels from the captured image, and retries at most two regions per live frame or three per imported image. Different values found in those retries are retained together, not reduced to the first match. Corner positions are mapped back to the source image for the overlay.

These are axis-aligned search rectangles. They are not measured perspective corners, and this update does not add exact perspective rectification. ZXing retains its own orientation and detection handling. The image margins are real captured pixels: the crop does not fabricate a missing border beyond the image edge.

Live captures are capped at 2.1 million pixels and a 1920-pixel side; imported images use the existing four-million-pixel decoding budget. Region retries use those captured pixels, not additional raw sensor detail discarded before the canvas capture. Detection works on a smaller bounded thumbnail, while crops preserve the available source detail.

Recovery still requires checked formats and source-consistent bar geometry for linear readings. Live work is bounded to a full-image pass, up to two crop passes and one existing enhancement strategy, subject to its 350 ms retry-start deadline. Imported images have a 2.5 second retry-start deadline. An individual synchronous native decode cannot be interrupted by these checks; the app's worker timeout is separate.

The detector can miss regions or propose non-barcodes. A successful whole-image read ends retries, so a clear code can still prevent additional attempts on a harder code elsewhere. Ambiguity handling covers **observed conflicting values**, not proof that only one physical label is present. Keep one intended product in view when using POS mode.

## Offline operation and POS integration

The service worker caches the POS policy, frame analysis, frame selection and native decoder with the app. An older cache must not report these new capabilities as ready. Apply the available update and use **How to use it offline → Check offline readiness** if files are missing. Clearing browser data or storage eviction may require another online setup.

This browser mode does not call `POST /v1/pos/decode`; that remains a separate server-side option documented in [POS-DECODING.md](POS-DECODING.md). Neither path performs catalogue lookup, pricing or cart updates. Your POS should accept only a unique, exact catalogue match and prevent a retried scan attempt from adding an item twice. The scanner's history deduplicates values; it is not a cart or quantity counter.

## Evidence and remaining limits

See [TESTING.md](TESTING.md) for the verified suites and [DAMAGE-TESTING.md](DAMAGE-TESTING.md) for historical synthetic decoding results. New checks exercise real bundled decoding, format restrictions, known false-reading cases, cropped-image coordinates, quality ranking, freshness and camera lifecycle behavior. A test that deliberately forces a full-frame miss to exercise crop routing is not evidence that the original image was unreadable.

This update does not establish a higher real-phone recognition rate or Scanbot-equivalent performance. Further evaluation needs independently labelled phone captures, including reflective packaging, curved labels, motion and poor lighting, with separate evaluation products. Measure correct confirmations, wrong confirmations, missed scans and time to confirmation. The collection workflow is in [CODE128-LAB.md](CODE128-LAB.md).
