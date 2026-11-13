# Recognition update — 13 November 2026

This is the earlier recognition update. The subsequent [camera recovery and retail safeguard update](RECOVERY-UPDATE.md) has newer results and treats this report's verification images as development data.

This update improves the browser scanner used by the standalone app, camera SDK and hosted embed, plus the server-side image reader. It also fixes how the SDK schedules difficult reads for multi-frame confirmation. No Scanbot comparison or physical Android/iPhone accuracy measurement was performed.

## Changes

The browser still decodes the original image first. After a miss, normalized midpoint thresholding gives blurred modules another sampling path. A wider 5×5 unsharp mask recovers some QR boundaries missed by the earlier four-neighbour sharpening. Sliding sums keep processing linear in the number of pixels. There are still at most six fallback methods, with only one method attempted per live worker request. Existing crop, checksum, source-bar geometry, allowlist and pixel-budget checks remain.

The API adds stronger sharpening, a fixed-threshold retry, gradient-directed rotation and a small median filter for isolated scratches/noise. Its maximum rises from six to nine fallbacks after the original pass. The four-million-pixel retry allocation cap and 2.5-second retry-start deadline remain. Individual native calls cannot be interrupted by that deadline, and hard images can take longer.

The SDK now keeps the successful recovery method for the next fresh camera frame. Previously it advanced the method after every decode, so a difficult label could wait a whole cycle before another matching read. Full-view and detail-crop requests share a method for each frame. Misses resume the search; stale results do not pin a slow method. Resetting a scan or settings resets the search. Full-view decoding, crop-conflict checks, frame IDs, pixel fingerprints and confirmation requirements are unchanged. Reusing a method never reuses its previous result as evidence.

The service-worker cache version is 1.8.0. Deploy the whole updated `web/` tree together, then apply the available offline update. Existing SDK and one-script integrations pick up the same improved worker; no new integration option is required.

## Measurement rules

An exact read requires every expected payload and format with no unexpected extra value. A correct code plus an incorrect extra code is a failure. Negative samples must return no codes. Results below are generated-image evidence, not customer accuracy percentages.

All previous accuracy/damage sets, including `damage-stress-verify.json`, are now development or debugging evidence. The new `damage-stress-accuracy-next.json` was frozen before implementation choices, with seed 134973017, nine disjoint positive payload groups, 171 positive images and 48 negatives. Its generator makes no decoder calls and filters no outcomes. Byte-for-byte regeneration was verified. The implementation agents did not inspect its per-case results before algorithms were frozen.

The 19 transformations of each positive payload are related examples, not independent photographs. This test does not cover the variety of real packaging, camera optics, motion or illumination in production. Detailed source, corpus and dependency hashes are included in [the evaluation manifest](benchmark-results/accuracy-next/summary.json). The baseline is commit `e6aa266`.

## Fresh evaluation

| Reader/profile | Exact positive reads, before → after | Negatives correctly rejected | Unexpected values, before → after |
| --- | ---: | ---: | ---: |
| Browser image reader | **130 → 136 / 171** | 48 / 48 | 1 → 1 |
| API image reader | **125 → 134 / 171** | 48 / 48 | 1 → 1 |
| Browser POS, one live worker call at retry 0 | **109 → 116 / 171** | 48 / 48 | 0 → 0 |

No previously exact case was lost in any of these comparisons, and no decoder errors occurred. Algorithms remained unchanged throughout evaluation. The POS row uses the default `ean13,upca,code128,qr` allowlist and region retries; it does not measure an entire camera scan or confirmation sequence.

Each format has 57 positive cases:

| Format | Browser image reader, before → after | API image reader, before → after |
| --- | ---: | ---: |
| QR | 38 → 41 | 38 → 39 |
| Code 128 | 48 → 48 | 45 → 48 |
| EAN-13 | 44 → 47 | 42 → 47 |

One earlier native-decoder ambiguity remains on the new payload in `ean13/next-ean13-label-2/angled-2`: the unrestricted readers return the correct EAN-13 `7359676019025` plus an incorrect UPC-E `0135967000067`. This happens on the original pass, before recovery. It is counted as a failure; both unrestricted benchmark commands still exit with status 1. The default POS allowlist excludes UPC-E, and the tested POS profile returned no unexpected values. That is not proof that allowed formats can never be misread or that repeated-frame agreement guarantees correctness.

Sequential, single-run host decode timings were:

| Profile | Median before → after, ms | p95 before → after, ms |
| --- | ---: | ---: |
| Browser image reader | 22.34 → 10.38 | 451.87 → 478.25 |
| API image reader | 4.327 → 7.287 | 55.658 → 71.555 |
| Browser POS, one live worker call | 5.13 → 4.57 | 44.46 → 41.24 |

The stronger retries cost more time on some hard images. These observations exclude camera acquisition, WASM startup, HTTP/uploads and multi-frame confirmation; they are not phone speed estimates. Raw before/after reports are in [benchmark-results/accuracy-next/](benchmark-results/accuracy-next/).

## Development results

| Reader | Development, before → after | Existing debugging set, before → after | Legacy challenge set, before → after |
| --- | ---: | ---: | ---: |
| Browser | 128 → 136 / 171 | 131 → 138 / 171 | 59 → 59 / 64 |
| API | 126 → 136 / 171 | 130 → 136 / 171 | 57 → 59 / 64 |

No previously exact reads were lost on these sets, and no new unexpected values were returned. Each reader rejected all 48 development negatives. The new browser reads include five blurred/motion-blurred QR cases and three EAN-13 cases. API regressions also cover scratched QR and oblique Code 128 labels, with source-coordinate checks using independently rotated labels.

Development reports are retained in [the development evidence folder](benchmark-results/accuracy-next/development/). Some browser report hashes precede the final source's CRLF-to-LF normalization; the manifest records and verifies that byte-only change. The fresh evaluation uses the final LF source.

## Confirmation and verification

The real bundled WebAssembly decoder now confirms a shaded development QR through the SDK by reusing whichever method actually reads it on the next distinct frame. Controlled slow-frame tests cover the scheduling improvement within the 2.5-second attempt window. Frozen pixels, competing codes, cancellation, rescan and stale-frame rejection remain tested. These are simulations, not phone camera measurements.

The complete suites pass 471 JavaScript tests and 305 Python tests, with one platform-specific Python skip. TypeScript declarations, the React production build and the OpenAPI contract check pass. An existing FastAPI/HTTPX deprecation warning remains.

## Reproduce

Use Node 22+ and the project's pinned Python dependencies. From the repository, with your Python environment active:

```powershell
node --test tests/*.test.mjs
python -m pytest -q
python tools/generate-accuracy-next-verification.py
New-Item -ItemType Directory -Force data/local
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-stress-accuracy-next.json --output data/local/accuracy-browser.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/damage-stress-accuracy-next.json --output data/local/accuracy-api.json
node tools/benchmark-accuracy.mjs --mode live --enhance-live --pos-formats ean13,upca,code128,qr --corpus tests/fixtures/damage-stress-accuracy-next.json --output data/local/accuracy-pos.json
```

The POS benchmark makes one worker call per fixed image, at retry index 0, with default POS formats and region retries. It does not run camera capture, frame selection, a full retry cycle or multi-frame confirmation. Decoder reports count all unexpected values and return a nonzero exit status when any occur. Do not suppress those failures or interpret the unit-test result as proof of perfect recognition.

Earlier source snapshots and before-comparison commands are in [tools/baselines/accuracy-next/](tools/baselines/accuracy-next/README.md). The generator refuses to overwrite a changed frozen fixture. Further tuning using this new set must treat it as development data and reserve another independent evaluation.
