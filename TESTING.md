# Verification for the Code 128 lab

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
