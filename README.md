# Barcode API

A live camera scanner with an optional Python API for uploaded images and barcode generation. The camera app decodes barcodes on the device using a bundled [ZXing-C++ WebAssembly decoder](https://github.com/Sec-ant/zxing-wasm). The server API uses [FastAPI](https://fastapi.tiangolo.com/) and [ZXing-C++](https://github.com/zxing-cpp/zxing-cpp).

Version 0.6.0 adds [configurable POS decoding](POS-DECODING.md): restrict formats before decoding, reject conflicting results, and optionally require agreement across uploaded frames. See [TESTING.md](TESTING.md) for verification.

Version 0.5.0 added broader damage testing and Android/iPhone capability simulations. See [DAMAGE-TESTING.md](DAMAGE-TESTING.md) for measured improvements, examples, and an extra UPC-E reading still present in the unrestricted reader on an angled EAN-13. [MOBILE-TESTING.md](MOBILE-TESTING.md) describes 35 application simulations; these do not run real Android/iPhone browsers or cameras.

An [experimental Code 128 lab](CODE128-LAB.md) adds a custom decoder, local photo/video collection, and comparison with ZXing. Open `/scan/lab/` when using the API server, or `/lab/` when hosting the `web/` contents directly. The regular scanner and API continue to use ZXing. The lab includes synthetic development examples; real-phone accuracy and Scanbot parity have not been established.

For a POS integration, [the burst decoding endpoint](POS-DECODING.md) accepts up to five images and returns `confirmed`, `ambiguous`, or `rescan`. It supports a format allowlist and configurable agreement across frames. Your POS handles catalogue lookup and cart updates.

## Scan live through the camera

Open the deployed site's `/scan/` address, or its main address, which redirects to the scanner. Choose **Start camera** and allow the browser to use the camera. Point at a barcode or QR code. The app reads the camera frames locally; it does not send camera images to the Python API or any other server.

The scanner is a separate browser app. It does not need your API key. The existing `/v1` endpoints still require that key.

### Reading difficult labels

The scanner preserves more camera detail, retries selected center crops, and asks for continuous autofocus when the camera supports it. When the initial decode fails, it can retry contrast normalization, sharpening, a diagonal rotation, light/dark inversion, local illumination correction, and bounded 2× resampling. The browser's illumination retry also straightens coherently oriented bars. The browser image reader and uploaded-image API have at most six recovery passes within their existing time and pixel limits; neither reconstructs completely missing barcode data.

Transformed recovery only accepts formats with mandatory checksums or error correction, and linear results must agree with the visible source-bar direction. Formats such as unchecked ITF, Codabar and Code 39 remain available on the untouched initial pass. This reduces specific false readings found in testing; it does not eliminate all false readings from the underlying decoder. Live scanning runs at most one recovery strategy per frame.

Live results need matching payload bytes and format in two separate video frames before appearing. Formats without a known mandatory checksum require three. This adds a short confirmation delay and helps reject transient mistakes; it cannot rule out a persistent wrong reading. Modern browsers use presented-frame callbacks or decoded-frame counters. Browsers without either use playback timestamps, which cannot reliably distinguish a frozen video image from a new frame.

Clean images use the original decoder first. Difficult images may take longer. Recovery stops when a pass finds a code, so an easy code can prevent extra recovery attempts for a harder code in the same image. Imported images do not use live-frame confirmation.

See [ACCURACY.md](ACCURACY.md) for reproducible before/after measurements and remaining limits. The measurements use generated images, not real phone footage or a Scanbot comparison.

### Use it offline

1. Open the scanner while connected to the internet and wait until it reports that offline mode is ready. That first visit downloads the page, decoder, WebAssembly engine, and other assets into this browser.
2. On a phone, use the browser's **Install app** or **Add to Home Screen** option if available. On iPhone, use Safari's Share menu and **Add to Home Screen**.
3. Turn on airplane mode, reopen the scanner at the same address or from its home-screen icon, and start the camera.

Only the camera app and its locally bundled functionality work offline. Requests to the Python barcode generation and image-upload APIs still require a running server and a network connection. The regular scanner does not store camera frames. If local scan-history saving is enabled, the browser stores decoded values and scan metadata, not photos; clear that history from the app when it is no longer needed. The lab has separate, explicit photo/video capture and download controls for collecting labelled examples locally.

Offline readiness applies to the current browser and device. Clearing site data, private-browsing restrictions, storage pressure, or browser cache eviction can remove the offline files. If that happens, open the app online again and wait for offline readiness before disconnecting. After an app update, wait for the new version to finish downloading before testing offline mode.

### Camera requirements

Use a current browser that supports camera access, WebAssembly, and service workers. The page must be served over **HTTPS**, or over `http://localhost` / `http://127.0.0.1` on the same device for development. Opening `index.html` directly as a file, or visiting a plain HTTP LAN address from your phone, does not provide the secure context needed for the full camera/offline app. Camera, flashlight, installation, and storage behavior vary by browser and device. Test with the phones and real barcode labels you intend to use; this project does not establish Scanbot-equivalent speed or recognition quality.

## Host just the camera app

The `web/` directory is self-contained. Publish its **contents** to any HTTPS static host while preserving the `vendor/` folder and filenames. No Python server, database, API key, or CDN is needed for this version of the scanner. Relative asset paths allow it to run at a subpath such as `/barcode-api/`.

For a local desktop preview without starting the API, run this command from the project folder:

```powershell
py -m http.server 8000 --bind 127.0.0.1 --directory web
```

Then open <http://127.0.0.1:8000/>. Keep the server running during the first complete download. The browser's camera permission prompt still needs your approval.

## What it does

| Endpoint | Input | Result |
| --- | --- | --- |
| `GET /scan/` | None | Live camera app; no API key needed |
| `GET /scan/lab/` | None | Experimental Code 128 collection and comparison lab; no API key needed |
| `POST /v1/barcodes/generate` | JSON with `format`, `text`, optional `output` and `scale` | PNG or SVG image |
| `POST /v1/barcodes/read` | Multipart upload in the `file` field | JSON with decoded values, formats, raw bytes, and four corner positions |
| `POST /v1/pos/decode` | Repeated `frames` image fields and an optional `options` JSON string | POS decision, candidates, confirmation counts and per-frame decoding details |
| `GET /v1/formats` | None | Generation formats, reading support, and POS formats, defaults and limits |
| `GET /health` | None | Public health check |

Generation supports `qr`, `code128`, `ean13`, and `upca`. Reading uses ZXing-C++'s supported formats, including QR and common retail barcodes. Each `/v1` endpoint requires an `X-API-Key` header.

The project does not include user accounts, billing, product lookup, or a hosting subscription. A barcode's value is usually an identifier; product names and prices require a separate data source.

## Run locally on Windows

Install Python 3.14. Open PowerShell in this project folder, then run:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
$env:BARCODE_API_KEY = (& .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))")
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Keep the terminal open. Visit <http://127.0.0.1:8000/scan/> for the camera app or <http://127.0.0.1:8000/docs> for the interactive API documentation. The API documentation has an **Authorize** button for the key generated above. To see the key, stop the server with Ctrl+C, run `$env:BARCODE_API_KEY`, copy it, and restart the same server command. Keep that key private.

The service refuses to start unless `BARCODE_API_KEY` has at least 24 characters. The environment variable lasts for that terminal session. The app does not automatically load `.env` files.

For macOS or Linux:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
export BARCODE_API_KEY="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))')"
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

## Generate a code

Send this JSON to `POST /v1/barcodes/generate`:

```json
{
  "format": "qr",
  "text": "https://example.com",
  "output": "png",
  "scale": 4
}
```

`output` can be `png` or `svg`. `scale` is an integer from 1 to 8. Output includes the blank border needed by barcode readers.

For a command-line example, keep the server running in one PowerShell window. In another window opened in this folder, set `BARCODE_API_KEY` to the same secret, then run:

```powershell
curl.exe --fail-with-body -X POST "http://127.0.0.1:8000/v1/barcodes/generate" -H "X-API-Key: $env:BARCODE_API_KEY" -H "Content-Type: application/json" --data-binary "@examples/generate-qr.json" --output barcode.png
curl.exe --fail-with-body -X POST "http://127.0.0.1:8000/v1/barcodes/read" -H "X-API-Key: $env:BARCODE_API_KEY" -F "file=@barcode.png"
```

EAN-13 requires 13 digits, including a correct check digit; UPC-A requires 12. Example test values are `5901234123457` and `036000291452`. Generating an image does not assign ownership of a retail product identifier. Code 128 accepts up to 128 printable ASCII characters. QR accepts text up to 2,048 characters, subject to the encoder's byte capacity.

## Read an image

Upload one PNG, JPEG, or WebP image as the multipart field `file`. The file limit is 10 MiB; the decoded image limit is 20 million pixels. Animated images are rejected. PDF and SVG input are not supported.

The JSON response contains:

- `barcodes`: every decoded code, or an empty array if none is found.
- `text`: the decoder's text representation.
- `format`: `qr`, `code128`, `ean13`, `upca`, or the normalized decoder name for another format.
- `bytes_base64`: the original decoded payload as base64 for binary codes.
- `position`: four points in top-left, top-right, bottom-right, bottom-left order.
- `image`: the image's width and height after applying EXIF orientation.

Corner positions use the EXIF-normalized image's pixel coordinates. UPC-A may be returned as the equivalent leading-zero EAN-13 representation by the decoder.

Invalid images return 400, missing or wrong keys return 401, oversized inputs return 413, unsupported image types return 415, and invalid generation parameters return 422. Requests are bounded before multipart parsing. Uploaded images are processed for the request; the application does not archive them. The framework may spool multipart uploads to temporary disk storage during processing.

## Decode a burst for a POS

`POST /v1/pos/decode` defaults to `ean13`, `upca`, `code128` and `qr`, requiring the same decoded text, raw payload and format in two distinct images. Send one to five still images together; the combined limits are 10 MiB and 20 million decoded pixels, including duplicate uploads. Identical normalized images count only once. There is no confirmation memory between requests.

With the API running and its key in the request terminal's `BARCODE_API_KEY` variable, send two captures of the same label:

```powershell
curl.exe --fail-with-body -X POST "http://127.0.0.1:8000/v1/pos/decode" -H "X-API-Key: $env:BARCODE_API_KEY" -F "frames=@frame-1.jpg" -F "frames=@frame-2.jpg" -F "options=<examples/pos-options.json"
```

Use `confirmation_frames: 1` to disable agreement across frames. Any conflicting candidate makes the burst `ambiguous`, even if another candidate has more matching frames. Only use a `confirmed` result after an exact catalogue lookup, and prevent retried scan attempts from creating duplicate cart events. Confirmation is a decision policy, not a correctness guarantee. Keep the shared API key on your backend, never in browser code. See [POS-DECODING.md](POS-DECODING.md) for options, response fields, identifier handling and the single-frame example.

## Tests

Install `requirements-dev.txt` for the API, image tools and Python tests. The optional `requirements-research.txt` adds OpenCV for video extraction and its tests; install it to run the full CI dependency set. Neither the browser app nor the deployed API needs OpenCV.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-research.txt
.\.venv\Scripts\python.exe -m pytest -q
node --test tests/*.test.mjs
```

The Python tests exercise real API generation and decoding, all four generation symbologies, SVG output, authentication, image limits, EXIF rotation, invalid inputs, serving the camera app, and dataset import/review rules. The Node tests exercise the actual bundled decoder, custom Code 128 engine, benchmark accounting, lab confirmation policy and service worker's offline-cache lifecycle. Use Node 22 or newer for those tests. GitHub Actions installs the video dependencies and runs both test suites on pushes and pull requests, then benchmarks the eight synthetic Code 128 development examples and prints results in the Actions log. See [CODE128-LAB.md](CODE128-LAB.md) for benchmark reproduction and [TESTING.md](TESTING.md) for verification details.

Browser verification covered the desktop layout and a 390px phone layout. A simulated camera stream exercised the production scanning loop with QR and Code 128 fixtures. The cached production app also reopened with its local server unavailable and decoded a Code 128 image locally. Physical camera hardware and iPhone behavior have not been tested; complete a real phone-camera and airplane-mode check before relying on a particular device.

## Docker

```bash
docker build -t barcode-api .
docker run --rm -p 8000:8000 -e BARCODE_API_KEY barcode-api
```

Set and export `BARCODE_API_KEY` in the host shell first. The container runs as a non-root user and includes the camera app at `/scan/`. Docker packaging is included but has not been tested locally.

For a public service, deploy behind HTTPS and add rate limits, per-customer keys, usage accounting, concurrency limits, and resource/time limits appropriate to your hosting platform. Test recognition quality against your own real photos; the included tests do not establish Scanbot-equivalent performance.

## Upload to GitHub manually

1. Extract the project ZIP.
2. Go to <https://github.com/new>, choose a repository name such as `barcode-api`, and choose **Private** or **Public**.
3. Leave the README, `.gitignore`, and license initialization options off, then create the repository.
4. On the empty repository page, choose **uploading an existing file**. In an existing repository, use **Add file → Upload files**.
5. Open the extracted project folder and drag its contents into GitHub. Include `.github`, `.gitignore`, `.dockerignore`, `app.py`, `barcode_reader.py`, `pos_decoding.py`, documentation, requirements files, `Dockerfile`, `examples`, `tests`, `tools`, the shipped `data/synthetic` examples, `data/README.md`, `data/manifest.example.json`, `benchmark-results`, and the entire `web` folder. Upload the contents, not the ZIP or an enclosing folder. The workflow path must remain `.github/workflows/tests.yml`.
6. Enter `Initial barcode API` as the commit message and choose **Commit changes**.
7. Check that `app.py` and `README.md` appear at the repository root. The **Actions** tab shows the test workflow.

Keep secret keys, `.env` files, virtual environments, caches, personal images, and `data/local` out of the upload. Git ignores `data/local`, but GitHub's browser upload does not apply your local ignore rules. Saving the source to GitHub does not host the API; run it locally or deploy the service separately.

When updating an existing repository, use **Add file → Upload files** to replace the changed files and add the new `web` assets. Check the folder paths before committing. The bundled JavaScript, WebAssembly, fonts, icons, and license notices must stay together so the scanner can download everything it needs for offline use.
