# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Extend the existing barcode API with live camera scanning that decodes locally and remains usable offline after its files have been cached. Preserve barcode reading and generation API endpoints. Provide a separate experimental Code 128 lab for collecting independently labelled camera samples and measuring a custom engine against the bundled ZXing baseline.

## Capabilities and Constraints

The user requested a Scanbot-like live, offline scanning experience. No claim of Scanbot-equivalent performance is established. Camera access requires a secure origin and user permission. Offline readiness depends on successful initial caching; browser storage can be evicted. Existing distribution is the user's GitHub repository and manually uploaded project ZIPs. No new hosting provider is authorized by this feature request.

The custom engine is limited to an experimental Code 128 subset and does not replace ZXing in the normal scanner or API. Its detector proposes heuristic oriented regions, not exact label corners or learned detections. Supplied development images are synthetic; there is no included real-phone evaluation. Support, source attribution and measurement limits are documented in [CODE128-LAB.md](CODE128-LAB.md).

The regular browser scanner now offers an optional POS mode with native format restrictions, ambiguity handling and one-to-three-frame confirmation. Its default-on capture options select from a bounded fresh-frame burst and retry heuristic barcode regions after a whole-image miss. These features remain local and offline; they do not perform product lookup or cart updates. Region crops are axis-aligned captured pixels, not exact perspective correction. See [LIVE-SCANNING.md](LIVE-SCANNING.md) for limits and defaults.

## Operating Context

Version 0.9.0 extends the embedded SDK and integration examples with supported torch/zoom controls, camera selection, optional bounded high-resolution source capture, normalized target selection, and adaptive clear-frame scheduling. Candidate outlines are heuristic proposals; selection changes the explicit scan area and resets confirmation. Camera control changes discard old evidence. The legacy standalone app retains its existing capture controls. The separate comparison page runs controlled capture trials using the bundled reader or a user-supplied, separately licensed Scanbot image decoder. It does not benchmark the complete SDK camera pipelines against each other. No physical-phone or Scanbot head-to-head results are included.

Version 0.8.0 adds a headless browser SDK with explicit scan callbacks and lifecycle management, plain JavaScript/POS/React integration examples, typed JavaScript and standard-library Python backend clients, and an exported OpenAPI contract. The POS example is a demonstration catalogue/cart with event deduplication, not a payment or persistent stock system. Business hosting adds per-customer keys, bounded single-process admission and operational metrics. MIT applies to original project code while third-party notices are preserved. See [INTEGRATION.md](INTEGRATION.md).

Existing Python/FastAPI backend. This addition uses plain browser HTML/CSS/JavaScript and a locally bundled WebAssembly reader. The interface targets phone and desktop browsers; the specific user's target device is not yet known. Scanner frames and imported images are processed on-device. Scan history is session-only unless the user opts into storage on that device.

The lab lives at `/scan/lab/` under the API or `/lab/` under a static deployment. It adds local JavaScript detection/decoding and uses the existing offline bundle. Users enter verified truth and a physical-label group, capture media, save paired metadata, and import it with the dataset CLI. They keep evaluation groups separate and manually review extracted video frames. Prepared captures remain temporary until explicitly downloaded; they are not uploaded automatically. Optional OpenCV is only needed by the local video extraction tools.

Live comparisons evaluate both engines on the same frames and export exact/wrong/missed reads and timing. Two separate correct frames confirm a result. Confirmation time includes paired processing, while decoding time excludes capture/startup/UI. Reports describe the measured scene and device, not a general accuracy guarantee. The stable scanner remains one click away from the lab.
