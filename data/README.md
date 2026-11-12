# Build a real Code 128 dataset

No real phone photos or videos are included. The existing synthetic fixtures help find programming regressions; they do not establish field accuracy. Use this workflow to collect and label your own evidence.

To try the complete tooling before collecting media, eight generated examples are included in `data/synthetic`. They are development smoke tests, not untouched evaluation data:

```powershell
node tools/benchmark-code128.mjs --fixtures data/synthetic/dev-pixels.json --output data/local/example-report.json
```

Regenerate them with `.\.venv\Scripts\python.exe tools/generate-code128-example.py`. The independent ZXing encoder supplies known Code 128 labels; the experimental decoder does not generate its own test truth.

## Capture and label

Open the experimental capture lab on your phone over HTTPS. Enter the barcode value from the printed label or a trusted source, give that physical label a group ID, and record the phone/browser and conditions. Save both the media file and its JSON sidecar. The expected value must come from you, not from the scanner's prediction. An explicitly negative sample has `expected: []`.

Collect different labels, devices, distances, orientations, glare, blur, scratches and lighting conditions. Include images with no barcode and barcode-like textures. Keep all views and video frames of the same physical label/session under one `groupId`. If the same label appears in several sessions, reuse its label group ID. This prevents near-identical images appearing in both development and evaluation.

The local CLI works with either one browser sidecar or a version 1 manifest containing `entries`. Each entry has `id`, relative `path`, `mediaType` (`image` or `video`), human-labelled `expected`, `groupId`, `split` (`train`, `dev` or `test`), `conditions`, `device`, and `source` (`real` or `synthetic`). `manifest.example.json` demonstrates the shape and is not a collected sample.

## Set up and import

Run these commands from the project directory, with its Python dependencies installed. Replace the example Downloads filenames with the actual downloaded files. The metadata path refers to the matching media filename; keep both downloads together.

```powershell
.\.venv\Scripts\python.exe tools/dataset.py init --root data/local
.\.venv\Scripts\python.exe tools/dataset.py import --root data/local --metadata "C:\path\to\Downloads\sample-001.json" --media-dir "C:\path\to\Downloads"
.\.venv\Scripts\python.exe tools/dataset.py validate --root data/local
```

`data/local` is ignored by Git, and initialization adds a local ignore file too. Captures are not uploaded. Import rejects duplicate IDs/paths, files outside the media directory, groups spanning multiple splits, oversized images, and malformed labels.

You can also add an existing photograph with a known value:

```powershell
.\.venv\Scripts\python.exe tools/dataset.py add --root data/local --file "C:\path\to\label.jpg" --id phone1-label1-angle --group label1 --split dev --device "Phone model / browser version" --source real --condition angled --text "BOX-12345"
```

Use `--negative` instead of `--text` for a verified image with no Code 128 label. Keep damaged or difficult Code 128 labels as positive examples when their true values are known. A generated image must use `--source synthetic`.

## Keep evaluation separate

Assign `train`, `dev` and `test` in the lab or when adding a sample. Development is for debugging and tuning. The test split is for final evaluation. Do not change algorithms in response to the final test set and continue calling it untouched.

If you want deterministic group assignment, run:

```powershell
.\.venv\Scripts\python.exe tools/dataset.py split --root data/local --seed code128-v1
```

This assigns previously non-test groups using a 70/15/15 hash partition and preserves existing test groups. It does not guarantee exact proportions in small datasets or balance conditions automatically. Review that each split has sufficient independent labels, device variety and negatives. Group leakage checks depend on you using consistent physical-label IDs.

## Video frames

The lab exports a resampled camera clip, subject to the browser's supported recording formats. It records a canvas stream at approximately 15 frames per second, within a four-megapixel capture limit and a requested 2.5 Mbps bitrate. This is not the original sensor video; resolution, encoding and timing affect the evidence. Install the optional research dependencies to extract labelled frames locally:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-research.txt
.\.venv\Scripts\python.exe tools/dataset.py extract-video --root data/local --id YOUR_VIDEO_ID --interval 0.5 --max-frames 120
```

Frames inherit the video's group, split, device, conditions, source and candidate expected value. They are marked `reviewRequired` because a video label does not prove that the barcode is visible in every frame. Inspect each PNG and confirm its ground truth before exporting:

```powershell
.\.venv\Scripts\python.exe tools/dataset.py review --root data/local --id YOUR_VIDEO_ID-f0000 --text "BOX-12345"
.\.venv\Scripts\python.exe tools/dataset.py review --root data/local --id YOUR_VIDEO_ID-f0001 --negative
```

Seeking timestamps can be approximate depending on the video codec. Exported frame timings are requested sampling positions, not measurements of live time to a confirmed result. Repeated frames from one clip are correlated, not independent trials.

## Benchmark

Select a split explicitly. Export converts EXIF-normalized images to bounded RGBA pixels (up to four million pixels), compositing transparency on white. The original media files remain unchanged.

```powershell
.\.venv\Scripts\python.exe tools/dataset.py export --root data/local --split dev --output data/local/dev-pixels.json
node tools/benchmark-code128.mjs --fixtures data/local/dev-pixels.json --output data/local/dev-report.json
```

For a final evaluation, repeat with `--split test` and a separate report filename. The benchmark compares the actual experimental engine with the bundled ZXing reader restricted to Code 128, using the same pixels and exact expected values. It records exact reads, missing codes, unexpected/wrong reads, negative false positives, errors and median/95th percentile decoding time. Mixed real and synthetic data are also reported separately. Wrong reads or engine errors produce a nonzero exit code; missed codes remain visible in the report.

Source hashes normalize CRLF to LF, and fixture hashes use parsed JSON, so Git line-ending conversion does not invalidate provenance. Each report states its hash method.

This desktop benchmark measures image decoding, not phone camera performance. Use the lab's live trials on actual phones to measure time to a confirmed result. Keep the device, lighting, label and app version with every trial. Report failures and timeouts alongside successful timings. No Scanbot comparison is included.
