# Experimental Code 128 lab

This project now includes a custom Code 128 prototype, a camera collection page, and tools for comparing it with ZXing. The lab is for developing and measuring the engine. The regular camera scanner and `/v1` API continue to use ZXing. No real phone dataset or physical-phone benchmark is included, and these results do not establish Scanbot-equivalent accuracy.

## Open the lab

From the project folder in PowerShell, start the self-contained browser app:

```powershell
py -m http.server 8000 --bind 127.0.0.1 --directory web
```

Open <http://127.0.0.1:8000/lab/> on that computer. When the Python API serves the same files, the address is `/scan/lab/`. A static deployment uses `/lab/` relative to the published `web/` contents, or `/barcode-api/lab/` if the app is hosted under `/barcode-api/`.

For a phone, publish the complete `web/` contents to an HTTPS host. A plain HTTP LAN address is insufficient for camera access. Open the lab online and wait for its offline-ready message before disconnecting. The custom engine, ZXing baseline, styles, fonts, and credits are bundled locally. Browser cache eviction or clearing site data can require another online visit. The lab needs no API key and sends no camera images to a server.

## 1. Start with one format

The prototype supports Code 128 Code Sets A, B and C, set switching, SHIFT, ASCII bytes 0–127, and leading GS1 FNC1. A leading FNC1 sets the result's `gs1` flag; subsequent FNC1 separators become byte 29. FNC2, FNC3, extended-byte FNC4, AIM second-position FNC1, and empty payloads are rejected. QR, EAN and other formats belong to the regular ZXing scanner, not this custom engine.

Start collection with ordinary printable ASCII Code 128 labels whose values you can verify. The lab is a one-target evaluation workflow, not a complete Code 128 standards-conformance implementation. Preserve the blank quiet zones at both ends of each label.

## 2. Collect known examples and keep evaluation separate

In the lab, open the camera, enter the independently verified value, choose a group ID, split, device name and conditions, then capture a photo or a short video. Download **both** its media file and JSON label file into the same folder. Prepared files are temporary and disappear when the page closes. Scanner predictions never become ground truth automatically.

Use one group ID for all views and frames of the same physical label, including later sessions with that label. Keep each group entirely in `train`, `dev`, or `test`. Reserve test groups before tuning. Include difficult positives and verified negatives without a Code 128 label; an unreadable positive is not a negative.

With the Python environment from [README.md](README.md#run-locally-on-windows) installed, import a downloaded pair:

```powershell
.\.venv\Scripts\python.exe tools/dataset.py init --root data/local
.\.venv\Scripts\python.exe tools/dataset.py import --root data/local --metadata "C:\path\to\Downloads\sample-001.json" --media-dir "C:\path\to\Downloads"
.\.venv\Scripts\python.exe tools/dataset.py validate --root data/local
```

Replace the example filename and folder with your actual downloads. `data/local` is ignored by Git. The CLI validates labels, bounded media files, relative paths and group separation. It also supports adding existing photos and deterministic group assignment; see [the dataset guide](data/README.md).

Photos are captured through a canvas within a four-megapixel limit. Video is a resampled camera clip, approximately 15 fps with a requested 2.5 Mbps bitrate, rather than original sensor footage. Browser format support varies. To extract frames, install the optional video tools:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-research.txt
.\.venv\Scripts\python.exe tools/dataset.py extract-video --root data/local --id YOUR_VIDEO_ID --interval 0.5 --max-frames 120
```

Every extracted frame inherits its video's group and split and requires manual review before benchmark export. Inspect the PNG, then use `dataset.py review --root data/local --id YOUR_VIDEO_ID-f0000 --text "BOX-12345"`, or `--negative` for a verified negative frame. Run those commands with the same Python executable above. A video's known value does not prove that every frame contains that barcode. Extraction timestamps are approximate sampling positions, not live confirmation measurements.

## 3. Locate and straighten the barcode

[code128-detector.js](web/engine/code128-detector.js) uses image gradients and conventional geometry to propose oriented rectangles around likely bar patterns. These are heuristic search regions, not exact detected label corners. There is no trained model.

Its projective rectifier accepts valid convex quadrilaterals, samples a straightened grayscale region, and maps decoded positions back to the original image. The automatic rectangle proposals mainly address orientation; they do not establish robust perspective detection. [code128-engine.js](web/engine/code128-engine.js) tries bounded candidates and a direct-row fallback, with a four-million-pixel input limit. Quiet-zone checks prevent off-image white padding from making clipped labels appear complete.

Improve localization using development samples and inspect failures before adding more formats. A rectifier alone cannot restore bars lost to severe blur, damage or insufficient resolution.

## 4. Decode and validate the symbol

[code128-decoder.js](web/engine/code128-decoder.js) measures alternating bar and space runs, matches Code 128 module widths, interprets code-set changes, and validates start/stop patterns and the modulo-103 checksum. It requires approximately ten-module quiet zones and agreement across at least two distinct sampled image rows. Ambiguous patterns and unsupported control functions are rejected.

The scanline matching, sampling, validation, and consensus logic are project code. The module-width pattern table is adapted from ZXing-C++ under Apache-2.0; retain [engine attribution](web/engine/THIRD-PARTY.txt) and the [bundled license](web/vendor/ZXING-CPP-LICENSE.txt). Custom results do not call ZXing or another decoder. ZXing is loaded separately as the comparison baseline.

## 5. Measure the camera pipeline

The lab requests a rear camera around 1920 × 1080, asks for continuous focus and exposure when advertised, and exposes camera selection, zoom and flashlight where supported. Browsers and devices may ignore optional requests.

Enter the correct target value, keep the target unchanged, and choose **Start comparison**. Both engines receive the same pixels. A trial ends after at most 60 seconds or 300 evaluated frames. The report records exact reads, wrong reads, misses, decoding latency and time to the first confirmed correct result. Any unexpected value or format counts as wrong even when a correct result is also present.

Confirmation requires two consecutive correct readings with matching raw payloads in separate presented/decoded frames within 2.5 seconds. Browsers unable to identify separate frames cannot run live comparisons, though collection remains available. Decoder timings exclude capture, startup and UI work. Confirmation timing starts after both engines initialize and includes the paired processing of both engines; it is not either engine's standalone camera latency.

Download each trial report. Repeat on actual target phones with different labels and conditions, retaining failures and timeouts as well as successful trials. A single scene's frame counts are not an overall accuracy estimate.

## 6. Benchmark changes reproducibly

Node 22 or newer runs the bundled custom engine and the actual ZXing WebAssembly baseline against identical image pixels. Try the supplied development smoke dataset first:

```powershell
node tools/benchmark-code128.mjs --fixtures data/synthetic/dev-pixels.json --output data/local/example-report.json
```

The [included report](benchmark-results/code128-prototype-synthetic.json) contains eight generated images: six positives and two negatives. The custom prototype reads six positives, the baseline reads five, and both have zero wrong reads on these examples. This tiny development set does not demonstrate superior field accuracy; the custom engine is also substantially slower in that desktop run. There are zero real samples in the report.

Regenerate the examples with `.\.venv\Scripts\python.exe tools/generate-code128-example.py`. They use an independent ZXing encoder and fixed transformations; they are not untouched evaluation data.

For your own development data:

```powershell
.\.venv\Scripts\python.exe tools/dataset.py export --root data/local --split dev --output data/local/dev-pixels.json
node tools/benchmark-code128.mjs --fixtures data/local/dev-pixels.json --output data/local/dev-report.json
```

The CLI records exact expected-value matches, misses, wrong reads, negative false positives, errors, median/p95 decoding times and source hashes. It separates real and synthetic results. Wrong reads or engine errors produce a failing exit status; missed reads remain visible in the report. Source hashes normalize CRLF to LF so Git line-ending conversion preserves provenance. Still-image reports deliberately leave time to a confirmed result empty.

GitHub Actions runs the eight-example development benchmark after the Python and Node tests on every push and pull request. Its summary and timings appear in the Actions log; the CI report file is not uploaded as an artifact. This checks the synthetic examples, not real-phone performance.

Choose `--split test` explicitly for a final evaluation and save a separate report. Tune on development groups, freeze the change, then evaluate held-out groups. If test results guide another change, that set is no longer untouched. See [data/README.md](data/README.md) for schema, import, split, video review and export details, and [TESTING.md](TESTING.md) for the project's recorded verification and outstanding device checks.
