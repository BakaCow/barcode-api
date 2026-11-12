# Barcode API

A Python API that reads barcodes from uploaded images and generates barcode or QR-code images. Built with [FastAPI](https://fastapi.tiangolo.com/) and [ZXing-C++](https://github.com/zxing-cpp/zxing-cpp).

## What it does

| Endpoint | Input | Result |
| --- | --- | --- |
| `POST /v1/barcodes/generate` | JSON with `format`, `text`, optional `output` and `scale` | PNG or SVG image |
| `POST /v1/barcodes/read` | Multipart upload in the `file` field | JSON with decoded values, formats, raw bytes, and four corner positions |
| `GET /v1/formats` | None | Available generation formats |
| `GET /health` | None | Public health check |

Generation supports `qr`, `code128`, `ean13`, and `upca`. Reading uses ZXing-C++'s supported formats, including QR and common retail barcodes. Each `/v1` endpoint requires an `X-API-Key` header.

This is a starter service for uploaded images. It does not include live camera scanning, user accounts, billing, product lookup, or a hosting subscription. A barcode's value is usually an identifier; product names and prices require a separate data source.

## Run locally on Windows

Install Python 3.14. Open PowerShell in this project folder, then run:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
$env:BARCODE_API_KEY = (& .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))")
.\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Keep the terminal open. Visit <http://127.0.0.1:8000/docs> for the interactive API documentation. Use **Authorize** to enter the key generated above. To see the key, stop the server with Ctrl+C, run `$env:BARCODE_API_KEY`, copy it, and restart the same server command. Keep that key private.

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

## Tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

The included tests exercise real generation and decoding, all four output symbologies, SVG output, authentication, image limits, EXIF rotation, and invalid inputs. The test suite passed locally on Python 3.14. GitHub Actions runs it on pushes and pull requests.

## Docker

```bash
docker build -t barcode-api .
docker run --rm -p 8000:8000 -e BARCODE_API_KEY barcode-api
```

Set and export `BARCODE_API_KEY` in the host shell first. The container runs as a non-root user. Docker packaging is included but has not been tested locally.

For a public service, deploy behind HTTPS and add rate limits, per-customer keys, usage accounting, concurrency limits, and resource/time limits appropriate to your hosting platform. Test recognition quality against your own real photos; the included tests do not establish Scanbot-equivalent performance.

## Upload to GitHub manually

1. Extract the project ZIP.
2. Go to <https://github.com/new>, choose a repository name such as `barcode-api`, and choose **Private** or **Public**.
3. Leave the README, `.gitignore`, and license initialization options off, then create the repository.
4. On the empty repository page, choose **uploading an existing file**. In an existing repository, use **Add file → Upload files**.
5. Open the extracted project folder and drag its contents into GitHub. Include `.github`, `.gitignore`, `.dockerignore`, `app.py`, `README.md`, requirements files, `Dockerfile`, `examples`, and `tests`. Upload the contents, not the ZIP or an enclosing folder.
6. Enter `Initial barcode API` as the commit message and choose **Commit changes**.
7. Check that `app.py` and `README.md` appear at the repository root. The **Actions** tab shows the test workflow.

Keep secret keys, `.env` files, virtual environments, caches, and personal images out of the upload. Saving the source to GitHub does not host the API; run it locally or deploy the service separately.
