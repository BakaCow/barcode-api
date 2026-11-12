# Recognition improvements and measured limits

Measured on 12 November 2026. This update improves the bundled ZXing-based scanner; it does not demonstrate parity with Scanbot. Scanbot was not run in these tests.

## What changed

The worker first tries the unchanged image. When that fails, image scanning can try contrast normalization with an alternative thresholding method, sharpening, a 45-degree rotation, and explicit light/dark inversion. The number of passes and the retry start time are bounded. Results must pass the decoder's validity checks. Rotation coordinates are mapped back to the original image for overlays.

Live scanning spreads these retries across camera frames to keep the interface responsive. Camera capture and repeated-result confirmation are tested separately. The benchmark below measures image decoding in the worker, not the full live camera pipeline.

## Results

Each positive case contains one known barcode. An exact success requires the correct payload and format, with no additional unexpected code. Any unexpected result is counted as a wrong result, including one returned alongside a correct code.

| Fixed synthetic set | Original worker | Updated worker | Wrong results, original / updated |
| --- | ---: | ---: | ---: |
| Development: 64 barcode images | 40 / 64 | 52 / 64 | 0 / 0 |
| Development: 8 images without a complete barcode | 8 / 8 correctly rejected | 8 / 8 correctly rejected | 0 / 0 |
| Separate validation: 32 barcode images | 20 / 32 | 28 / 32 | 0 / 0 |
| Separate validation: 8 images without a complete barcode | 8 / 8 correctly rejected | 8 / 8 correctly rejected | 0 / 0 |

Every positive image readable by the original worker remained readable. No worker errors occurred. The new development reads include weak-contrast codes, certain diagonal and blurred labels, and inverted linear barcodes.

The 72-case development set was frozen before changing the worker, then used to inspect which retry strategies helped. The 40-case separate validation set was generated and evaluated after the four final retry strategies were chosen. It uses a different random seed, payloads, and degradation values; no strategies were changed to improve its results. Future work that tunes against this set should no longer describe it as untouched validation data.

## Speed tradeoff

The original first pass is retained, but unsuccessful images can take longer because the updated worker makes more attempts. These are one-run measurements on the development Windows computer with the decoder already loaded:

| Set / decoder | Median | 95th percentile |
| --- | ---: | ---: |
| Development / original | 1.68 ms | 13.85 ms |
| Development / updated | 4.65 ms | 186.63 ms |
| Separate validation / original | 2.11 ms | 12.65 ms |
| Separate validation / updated | 11.77 ms | 207.54 ms |

These timings exclude camera capture, WebAssembly startup, file import, and live-result confirmation. They are not phone performance estimates. Live mode uses at most one fallback per frame instead of running all four on each frame. Slow individual decoder calls cannot be interrupted by the elapsed-time check; the app also has a worker timeout.

## What is not established

- These are generated images, not photographs from real phones. They cover QR, Code 128, EAN-13, and Data Matrix with rotation, low contrast, blur, inversion, shading, scratches, missing regions, downsampling, and small codes in larger images.
- Some difficult images still fail, including severe blur, missing information, and several shaded or very small labels. Sharpening and normalization cannot recreate every lost bar or module.
- Sixteen negative samples without wrong detections do not establish a production false-positive rate. More real non-barcode and ambiguous images are needed.
- These numbers are not an accuracy percentage for customers, not a live-camera scan rate, and not a comparison against Scanbot. Comparable field performance requires a shared photo/video set, real-device tests, and testing both products under the same conditions.

## Reproduce

The raw pixel fixtures, original worker snapshot, generator scripts, and per-case reports are included. The tests and benchmarks load the project's bundled JavaScript and WebAssembly files and make no external network requests.

From the project directory, with Node 22 or newer:

```powershell
node tools/benchmark-accuracy.mjs --worker tools/baseline-worker-v0.2.0.js --output baseline.json
node tools/benchmark-accuracy.mjs --output enhanced.json
node tools/benchmark-accuracy.mjs --worker tools/baseline-worker-v0.2.0.js --corpus tests/fixtures/accuracy-holdout.json --output holdout-baseline.json
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/accuracy-holdout.json --output holdout-enhanced.json
node --test tests/accuracy.test.mjs
```

For a particular live retry, use `--mode live --retry-index 0` through `3`. That performs one retry selection on each still image; it does not simulate a moving camera or multiple-frame confirmation.

To regenerate the byte-for-byte deterministic fixtures using the pinned Python dependencies:

```powershell
.\.venv\Scripts\python.exe tools/generate-accuracy-fixtures.py
.\.venv\Scripts\python.exe tools/generate-accuracy-holdout.py
```

Both generators optionally accept `--images PATH` to save inspectable PNGs. Reports in `benchmark-results/` include hashes of the worker and corpus used for the recorded run. Latency will vary when rerun.
