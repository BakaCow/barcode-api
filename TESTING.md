# Verification

## Business integration update (0.8.0)

Verified on 13 November 2026:

- **331 Node tests passed; 280 Python tests passed, 1 skipped** (the existing Windows symlink-creation restriction). Python retains the upstream Starlette HTTPX test-adapter warning.
- The camera SDK has 27 tests covering cancellation during permission/image loading, camera/worker cleanup, option changes, callback reentrancy, stale replies, distinct frames/pixels, ambiguity, and explicit rescan. Tests also run the bundled WASM on actual synthetic Code 128 and QR images. Camera lifecycle tests simulate browser capabilities; they do not operate physical Android/iPhone cameras.
- The examples add 18 Node checks for exact catalogue matches, duplicate scan-event IDs, legitimate quantity increments, integer-cent totals, and offline readiness/update handling. Three Python checks decode the included demo-label PNG files with the actual native reader.
- The JavaScript client has 10 HTTP transport checks; the Python client has 11 checks including real loopback HTTP requests forwarded into the production FastAPI app. A separate JavaScript integration run against Uvicorn generated and read a label, confirmed one POS image with an explicit one-frame policy, and rejected conflicting images. Redirect refusal, cancellation/timeouts, raw multipart bytes, leading zeros and HTTP error metadata are covered.
- Hosting checks exercise malformed configuration, customer isolation and key rotation, shared per-customer limits, rate-window reset/Retry-After, concurrency reservation and cleanup, admission before body reads, upload timeouts, private metrics and metadata-only logging. Public non-API POSTs bypass upload buffering. Deployment examples contain deliberately invalid placeholder keys and no live credentials.
- TypeScript checked the SDK and API client declarations plus valid/invalid usage examples. The committed OpenAPI export is current. The pinned React/Vite production build passed without warnings. The JavaScript package dry run includes its entry point, declarations, README and license; the Python client wheel built successfully.
- Browser verification checked desktop and phone-width layouts, imported-image rejection at two-frame confirmation, exact SDK callbacks at one frame, unknown POS catalogue rejection, and React mount/unmount/remount. With the local API/static preview server stopped and its port verified closed, the cached JavaScript example reloaded and decoded `DEMO-TEA-01`; the cached POS example also reloaded and accepted intentional manual catalogue entries. The screenshot is evidence of the demo UI, not a real financial transaction.
- Offline cache **1.5.0** includes the SDK and static integration examples. Example readiness requires the `integration-examples` feature. SDK imports alone do not cache a host app; React and other host applications supply their own service worker and offline business-data behavior.
- All four existing CI benchmark commands passed. Synthetic development results remain browser **128/171**, unrestricted API **126/171**, custom Code 128 **44/57** exact positive images; each rejects all **48/48** negatives with zero unexpected results/errors. The eight-image Code 128 demonstration also passes. No increased recognition rate is claimed for this integration release.

Docker and nginx executables were unavailable here, so deployment templates were inspected and configuration-tested but not launched. Physical phones, production load, distributed quotas, durable billing and business-specific workflows remain outside this verification. Admission counters are documented as single-process and reset on restart. See [INTEGRATION.md](INTEGRATION.md), [SDK.md](SDK.md) and [HOSTING.md](HOSTING.md).

From the project root, reproduce the integration checks with the existing full test commands, plus:

```powershell
python tools/export-openapi.py --check
npm exec --yes --package=typescript@5.9.3 -- tsc --strict --noEmit --lib ES2022,DOM --module NodeNext --moduleResolution NodeNext tests/client-types.mts
cd examples/react
npm ci --no-audit --no-fund
npm run build
```

## Live scanner update (0.7.0)

Verified on 13 November 2026:

- **276 Node tests passed; 222 Python tests passed, 1 skipped** (Windows symlink creation unavailable). The Python test client emits its existing upstream HTTPX adapter warning.
- New tests include 42 browser POS-policy checks, 25 actual-app camera/import integration checks, 14 quality/region tests, 16 worker checks and 5 benchmark CLI checks. They cover raw-byte/text identity, conflicts despite a majority, duplicate pixels, stale replies, setting changes, image-import isolation, sharpest-frame selection, bounded buffering, image coordinates, allowed formats on native passes, and offline-only dependencies. Camera integration uses generated pixels and controlled worker results; real decoder behavior is tested separately with the bundled WASM.
- Actual bundled-decoder regressions preserve the known EAN-13/UPC-E conflict for the policy to reject and restrict formats before the first native pass. Two off-centre crop-routing tests deliberately force the first full-image attempt to miss; they verify real crop decoding and coordinates, not an improvement over an unreadable original.
- Development benchmarks for the enhanced worker, both unrestricted and with the default POS format allowlist, each read **128/171** positive images exactly, reject **48/48** negatives, and return **zero unexpected values or errors**. They retain every previously exact read. These runs show **no additional exact reads** on this synthetic set. Reports: [enhanced](benchmark-results/live-scanning/worker-enhanced-dev.json), [POS formats](benchmark-results/live-scanning/worker-pos-dev.json). Each records the worker and helper hashes. These are worker image tests, not live confirmation or frame-selection accuracy measurements.
- The actual browser UI was checked at desktop and 390px phone widths. A generated image could not satisfy the default two-frame POS requirement; explicitly selecting one frame accepted its exact Code 128 value. After stopping the preview server and reloading from cache, a two-code image produced a conflict without adding a history entry. Existing history survived the service-worker update. This verifies local browser/offline behavior, not physical Android/iPhone cameras.
- The offline bundle is **1.4.2**, including `pos-policy.js`, `frame-analysis.js` and `capture-selection.js`. The app requires the `live-pos` capability before reporting its updated offline files ready.

The controls, defaults, time/pixel limits and remaining limitations are explained in [LIVE-SCANNING.md](LIVE-SCANNING.md). POS mode starts off; frame selection and detected-region retries start on. Quality scores and region proposals are heuristics, and agreement does not guarantee a correct product identifier. No real-phone recognition-rate or Scanbot-parity claim is established.

Reproduce the new development measurements from the project folder:

```powershell
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-stress-dev.json --enhance-live --output data/local/enhanced-worker.json
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-stress-dev.json --enhance-live --pos-formats ean13,upca,code128,qr --output data/local/pos-worker.json
```

Create `data/local` first if needed. The default benchmark mode is still-image decoding. `--mode live --retry-index 0` evaluates one live retry profile on each still fixture; it does not simulate a camera burst. Historical verification sets already examined during development are not fresh held-out evidence for this update.

## POS decoding update (0.6.0)

Verified on 13 November 2026:

- **219 Python tests passed, 1 skipped** (Windows symlink creation unavailable), and **174 Node tests passed**. Python emitted an upstream Starlette warning about its current HTTPX test-client adapter.
- The added checks comprise **67 POS HTTP tests**, **40 decision-policy tests**, and **24 reader-format tests**. They cover native format restrictions on the first and recovery passes, strict options, two- and three-image agreement, single-image mode, duplicate pixel detection, same-label multiple detections, conflicts despite a majority, request isolation, image normalization, authentication, shared byte/pixel budgets, and resource cleanup on success and failure.
- Actual decoder fixtures verify the known angled EAN-13 image: an EAN-13 allowlist returns its correct value; explicitly enabling UPC-E as well returns `ambiguous` with no selected value. A separate invalid-checksum regression returns `rescan` with no candidate. These are targeted regressions, not a new overall accuracy measurement.
- Two actual QR codes with identical payload bytes but different ECI text encodings cannot confirm each other. Agreement requires exact canonical format, raw bytes **and decoded text**; encoding disagreements return `ambiguous`.
- The existing CI development benchmarks also pass: browser 128/171 exact positives, unrestricted API 126/171, and custom Code 128 44/57. Each rejects all 48 development negatives without unexpected results. The eight-image Code 128 development demo also passes. These are synthetic development checks, not fresh held-out evaluation or a test of real cameras.
- The new endpoint is stateless. Its tests use generated images, including near-identical pixel variants to test evidence counting. Distinct pixels do not establish separate physical camera captures. Repeated wrong readings can still agree, and the POS must perform its own catalogue lookup.

The existing unrestricted endpoint and browser scanner retain their decoding behavior, including the known broader-verification ambiguity described below. The POS mode adds a conservative decision policy; it does not remove every native-decoder failure. Docker's file list now includes `pos_decoding.py`; a Docker image build and physical-phone testing were not run locally for this backend update.

See [POS-DECODING.md](POS-DECODING.md) for configuration and request examples. Reproduce both suites from the project folder with the commands below; GitHub Actions discovers the added Python tests automatically.

## Damage-testing update (0.5.0)

Version 0.5.0, verified on 12 November 2026:

- **88 Python tests passed, 1 skipped** (Windows symlink creation unavailable).
- **174 Node tests passed**, including **35 Android/iPhone capability simulations** and actual bundled-decoder regressions.
- Generated and tested **657 synthetic images** across development, debugging and fresh verification sets. The final fresh verification contains 171 positives and 48 negatives. Browser exact reads improved 107 → 124; API reads improved 109 → 121. The custom Code 128 subset improved 39 → 46 of 57. All final readers rejected all 48 verification negatives.
- **The broader verification still fails on one known ambiguity**: both the browser and API's unchanged first decoder pass return a correct EAN-13 plus a wrong UPC-E on one angled image. That case is counted as unsuccessful, and the benchmark exits nonzero. Passing unit/regression tests does not mean the stress suite is error-free. See [DAMAGE-TESTING.md](DAMAGE-TESTING.md) for the full results and per-case reports.
- Simulations execute the shipped app/lab event handlers with specified browser capabilities; they do not run actual Android Chrome, iPhone Safari or mobile camera hardware. They found and now cover cleanup of a canvas stream when MediaRecorder construction throws. Details: [MOBILE-TESTING.md](MOBILE-TESTING.md).
- New recovery checks cover shaded and small codes, source-coordinate mapping, checked-format restrictions, source-bar direction, bounded sampling and allocation, and the two demonstrated false-reading families. The offline cache version is 1.3.0 so browsers can receive the changed worker and lab code. Its asset/update lifecycle is covered by the automated service-worker tests; no new physical-device or browser-rendering claim is made for this update.

GitHub Actions runs the development damage benchmarks for browser, API and custom readers after the suites. The separate final-verification commands are documented with their known failing result rather than quietly reclassifying that image or removing it.

## Previous Code 128 lab verification (0.4.0)

Verified on 12 November 2026.

- 75 Python tests pass; one Windows symlink test is skipped because this environment cannot create symlinks. Coverage includes the existing API, browser assets, dataset import, independent label groups, protected test splits, frame review, safe paths, image limits, and actual OpenCV video extraction.
- 107 Node tests pass. These include the existing scanner checks plus the custom Code 128 decoder, detector/rectifier, engine worker, capture lifecycle, exact benchmark accounting, and offline lab compatibility. The final core run passed all 102 then-existing Node tests and 75 Python tests; the three subsequently added benchmark tests and updated 24-test lab/service-worker subset passed separately.
- Custom-engine tests use independently encoded barcode pixels. They cover Code Sets A/B/C, ASCII 0–127, switching, SHIFT, GS1 FNC1, reverse/inverted labels, low contrast, rotated labels, checksum corruption, quiet zones, malformed/unsupported symbols, and rejection of other formats and negative images. Geometry tests cover projective sampling, returned coordinates, invalid quadrilaterals and pixel limits.
- The included eight-image **synthetic development demo** gives the custom engine 6/6 positive reads and ZXing 5/6; both reject 2/2 negatives without unexpected values. These are a tiny programming smoke test, not real-world accuracy evidence or an untouched evaluation set. See [the report](benchmark-results/code128-prototype-synthetic.json). The benchmark records normalized source hashes, exact results, wrong reads and host decode latency. Deliberately incorrect truth is tested to produce a wrong-read count and failing exit status.
- An isolated browser harness supplied a 1920×1080 synthetic canvas stream to the shipped lab code. Both actual engines read 16/16 shared Code 128 frames and reached confirmation across separate frames. Both rejected all 17 frames in a blank-scene trial. Camera stop, photo preparation and short video preparation worked, with separate media/label download links. This verifies the browser pipeline; it does not test physical camera hardware. These harness samples are not distributed as real data.
- The production lab accepted its offline update, reported its files ready, and reopened with its local preview server stopped. The new cache includes the lab, custom engine, worker, and existing WASM baseline. Older service workers cannot claim lab readiness without advertising the lab capability. Local-only worker loading is also covered by tests. Desktop and 390px layouts were visually checked.
- OpenCV extracted four frames from a generated test video. Export was blocked until their inherited labels were reviewed; both engines then read all four. This was generated video, not phone footage. Video codec support and capture behavior still need testing on the target phones.

## Reproduce the new checks

From the project folder, using Python 3.14 and Node 22 or newer:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt -r requirements-research.txt
.\.venv\Scripts\python.exe -m pytest -q
node --test tests/*.test.mjs
node tools/benchmark-code128.mjs --fixtures data/synthetic/dev-pixels.json --output data/local/example-report.json
```

GitHub Actions runs both test suites and the eight-image development benchmark on pushes and pull requests. The benchmark prints its summary to the job log. Wrong reads or decoder errors fail that step; misses are reported and do not automatically fail it. Decode timings vary with the runner, so they are measurements rather than fixed performance thresholds.

## Existing scanner evidence

These previous measurements concern the enhanced ZXing image reader, not the custom Code 128 engine:

- The image worker read 52/64 development barcode images, compared with 40/64 before the update. A separate validation set produced 28/32 reads versus 20/32. All 16 negative images were rejected, with no unexpected results. See [ACCURACY.md](ACCURACY.md) for methodology, timings, limitations, and reproduction commands. These figures do not measure the API or live camera.
- The browser camera loop was exercised with a synthetic video stream containing a low-contrast QR code, a diagonal Code 128, and an inverted EAN-13. All three were confirmed and added to history. The image-import path also decoded the inverted EAN-13 locally. This used an isolated harness containing the shipped app code and test camera controls; the harness is not shipped.
- The shipped app accepted its service-worker update, preserved saved scan history, and reopened with its new scan-policy script after the preview server stopped. Decoder tests separately verify that JavaScript/WASM are loaded locally without external requests.
- During the preceding live/offline release, desktop and 390px layouts, camera stop, simulated permission denial, and image decoding after an offline reload were checked. This update changes scanning logic and guidance without changing the layout.

## Checks still needed on your device

The above does not test your physical camera, autofocus, flashlight, or an installed iPhone/Android home-screen app. Docker deployment was not run locally. It does not establish Scanbot-equivalent speed or accuracy.

1. Deploy over HTTPS and open `/scan/lab/` on your phone (or `/lab/` on a static host).
2. Open **Collecting useful evaluation data** and wait for offline readiness; apply **Update lab files** if offered.
3. Enter independently verified Code 128 values, physical-label groups, the phone name, conditions, and dataset split. Capture photos/videos across distances, angles, damage and lighting; save both files for each sample.
4. Run repeated live comparisons on the actual phones. Save reports including failures, wrong readings, and timeouts. Two agreeing frames of one label are one confirmation, not two independent evaluation samples.
5. Stop the camera, turn on airplane mode, reopen the same lab address, and repeat capture and comparison. Also check the main scanner and any installed home-screen app; their storage contexts can differ.
6. Import the media, review extracted video frames, and run the separate development and held-out evaluations described in [data/README.md](data/README.md). Keep all views of the same physical label together. The project contains no real phone dataset yet.
7. If cached files have been removed, reconnect and use the main scanner's **How to use it offline → Check offline readiness** to repair the local cache before retrying the lab.

The static scanner works offline. The `/v1` HTTP API still needs a server connection.
