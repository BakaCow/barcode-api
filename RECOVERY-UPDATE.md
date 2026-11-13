# Camera recovery and retail safeguards — 13 November 2026

This update improves the standalone scanner, camera SDK, hosted one-script embed and server reader. It adds bounded automatic camera detail recovery, a QR scratch retry, and a conservative reread for a known false UPC-E interpretation. No Scanbot comparison or physical Android/iPhone accuracy test was performed.

## What changed

The SDK requests higher source resolution at startup, while continuing to process balanced-size images normally. After three useful misses over at least 400 ms, one small or blurred detected region can trigger three seconds of detailed capture. A ten-second cooldown bounds repeated escalation. Any observed identity blocks new escalation until reset, including a conflicting identity. Existing evidence is retained. The standalone app uses this behavior when **Retry detected barcode areas** is enabled. Cameras may return lower resolutions; supported continuous focus/exposure are optional requests. [SDK options and budgets](SDK.md) and [standalone behavior](LIVE-SCANNING.md) explain the controls and their costs.

Quality sampling now avoids a regular-grid alias that could label sharp bars as low-detail. Blur guidance distinguishes weak edges from a merely small label. These heuristics guide capture, never assert a decoded value. A separate, fixed-size full-view camera fingerprint supplements the original image hash. Both must be unseen for a frame to add confirmation, preventing a detail-resolution change from making frozen pixels count twice. Existing conflicts remain visible even on duplicate frames.

The browser adds a QR-only native denoising retry for isolated scratches. It is the seventh bounded fallback, still with only one fallback strategy per live worker call. The current ZXing vendor assets and native package versions are unchanged. Alternative pure-grid assumptions were investigated on development data but produced no additional reliable gain, so they were not shipped. This is not a new proprietary QR grid detector or a reconstruction of erased information.

Both browser and API readers now inspect a specific native-result conflict: UPC-E alongside EAN-13/UPC-A. One bounded, source-aligned reread must corroborate the same EAN format and exact bytes, with a footprint covering the competing UPC-E's central scan segment and no corresponding UPC-E in the reread. Only then is the overlapping UPC-E interpretation removed. Genuine separate labels, unresolved cases, unsupported geometry, expired budgets and reread errors retain the original evidence. The reread never broadens the requested formats or introduces a new value. A UPC-E-only allowlist cannot use an unrequested EAN format to resolve an interpretation.

The service-worker cache version is **1.9.0**. Deploy the complete updated `web/` tree together and apply the available offline update. SDK and hosted-embed integrations use the same updated worker. The SDK's `automaticRecovery: false` option disables automatic escalation and its higher source-resolution request when using the balanced profile.

## Evaluation rules

An exact read requires all expected payloads and formats with no incorrect extra value. A correct label plus an incorrect extra is a failure. A negative image must return no values. Nonzero benchmark exits for unexpected results are retained.

All earlier damage/accuracy fixtures, including the previous `damage-stress-accuracy-next.json`, are now development evidence. Two new corpora were frozen before final algorithms were evaluated:

- `damage-stress-recovery.json`: seed **406138731**, 171 positives and 48 negatives; SHA256 `d18d2ad1a359a8e333d9ea4a5bff7dc78656ef1c72c99a28b15b2bc64c9f9d46`.
- `recovery-format-safety.json`: 42 UPC-E/multiple-label cases in 14 positive payload groups, covering both number systems and all compression branches; SHA256 `927833a400527228540142cc70b2ea7ed1532bd16ad4182c06366f33c3f15e95`. This set has no negative cases.

The deterministic generators make no decoder calls and perform no outcome filtering. Byte-for-byte regeneration was verified. Payloads are disjoint from development examples. Related transforms of one encoded label are not independent photographs. Production and corpus hashes are checked throughout evaluation; the complete baseline checkout is commit `aeef1929790bbc3febcd65147388fbde1f78d288`. Its frame analysis and policy stay paired with its reader, rather than mixing old and new dependencies. [The evaluation manifest](benchmark-results/recovery-upgrade/summary.json) records provenance and limits.

## Fresh evaluation results

| Reader/profile | Exact positive reads, before → after | Negatives correctly rejected | Unexpected values, before → after |
| --- | ---: | ---: | ---: |
| Browser image reader | **133 → 134 / 171** | 48 / 48 | 1 → 1 |
| API image reader | **132 → 132 / 171** | 48 / 48 | 1 → 1 |
| Browser POS image, region retries enabled | **133 → 134 / 171** | 48 / 48 | 1 → 1 |
| Browser POS, one live worker call at retry 0 | **113 → 113 / 171** | 48 / 48 | 1 → 1 |
| Browser UPC-E/multiple-label safety set | **41 → 41 / 42** | No negatives in set | 1 → 1 |
| API UPC-E/multiple-label safety set | **41 → 41 / 42** | No negatives in set | 1 → 1 |

The additional browser image read is one scratched QR. QR improves 39→40/57; Code 128 and EAN-13 remain 47/57 each. API totals remain QR: 39/57, Code 128: 47/57 and EAN-13: 46/57. No previously exact case was lost in any profile, and no decoder errors occurred. Both readers preserve all 28 isolated UPC-E cases and 13/14 complete mixed-label cases.

The remaining damage-set error is a genuine wrong Code 128 value, present before and after this update, including with default POS formats. The mixed-label safety failure returns both real labels plus an incorrect third UPC-E value. Neither is an equivalent-format normalization issue. These results do **not** establish zero false readings, 171/171 performance or improved server accuracy on this fresh set. A systematic wrong interpretation can survive repeated frames; software confirmation is not a guarantee of ground truth. The algorithms and frozen fixtures were not changed after inspecting these outcomes.

Damage-set timings stay similar: browser median/p95 are 10.61/477.58 ms after the update versus 11.17/473.49 ms before; API timings are 6.922/66.648 ms versus 6.937/66.044 ms. The additional retail reread has a material cost on the separate 42-case format-safety set: browser p95 rises 6.22→144.65 ms and API p95 rises 5.179→17.983 ms. These are single-run host measurements, not phone timings or a time-to-confirm metric. See [detailed reports and remaining errors](benchmark-results/recovery-upgrade/README.md).

## Development evidence

Earlier images helped develop these changes and cannot measure generalization. On the browser's original development set, exact reads improve **136→137/171**; former verification improves 134→136 and the previous accuracy-next set 136→138. Known overlapping UPC-E extras disappear in those two older sets. Across five old browser corpora, no exact read was lost and all 200 negative samples were rejected. The API keeps 136/171 on development and improves the older verification 131→132 and prior accuracy-next 134→135. [Retained development reports](benchmark-results/recovery-upgrade/development/) distinguish these results from the fresh evaluation above.

## Camera regression evidence

An independently encoded small EAN-13 label is placed in a 2560×1440 synthetic camera scene. Nearest-sampled 1920×1080 processing misses every balanced fallback phase. The actual bundled WASM decoder reads the native-resolution crop. The SDK test exercises three useful misses, automatic detail escalation, a real exact read, and confirmation on a separate simulated frame whose background changes slightly. With automatic recovery disabled the same scene remains unread. Camera permission is requested once.

This demonstrates one real recovery through the full SDK under simulated canvas sampling. It is not a measured success rate at a physical distance, a phone benchmark, or proof that real camera interpolation behaves identically. Additional tests preserve conflicts, handle stale/cancelled results, retain supported constraints, and reject frozen pixels when the detail window expires. Android Chrome-like and iPhone Safari-like capability/lifecycle simulations test optional exposure, ignored UHD requests, permissions and camera cleanup; actual mobile browser engines and hardware were not used.

## Software verification

**532 JavaScript tests** and **337 Python tests** pass, with one platform-specific Python skip. TypeScript declarations, React production build, OpenAPI contract and Git whitespace checks pass. The existing FastAPI/HTTPX deprecation warning remains. Passing software tests do not imply perfect barcode recognition.

## Reproduce

Use Node 22+ and the pinned Python dependencies. From the repository with its Python environment active:

```powershell
node --test tests/*.test.mjs
python -m pytest -q
python tools/generate-recovery-verification.py
python tools/generate-recovery-format-safety.py
python tools/generate-capture-recovery-fixture.py
New-Item -ItemType Directory -Force data/local | Out-Null
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-stress-recovery.json --output data/local/recovery-browser.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/damage-stress-recovery.json --output data/local/recovery-api.json
node tools/benchmark-accuracy.mjs --enhance-live --pos-formats ean13,upca,code128,qr --corpus tests/fixtures/damage-stress-recovery.json --output data/local/recovery-pos-image.json
node tools/benchmark-accuracy.mjs --mode live --enhance-live --pos-formats ean13,upca,code128,qr --corpus tests/fixtures/damage-stress-recovery.json --output data/local/recovery-pos-live.json
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/recovery-format-safety.json --output data/local/recovery-formats-browser.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/recovery-format-safety.json --output data/local/recovery-formats-api.json
```

Baseline instructions are in [tools/baselines/recovery-upgrade/README.md](tools/baselines/recovery-upgrade/README.md). POS image/live benchmark profiles operate on fixed images; live means one worker request at retry index zero, not a full camera retry cycle, adaptive capture or confirmation. Reported host latency excludes startup, camera, HTTP and UI. Future tuning on these new fixtures must treat them as development data and reserve another independent evaluation.
