# POS barcode decoding

`POST /v1/pos/decode` reads a small burst of uploaded images and returns `confirmed`, `ambiguous`, or `rescan`. It combines the existing native ZXing reader with an explicit agreement policy. It does not look up products, prices or stock, and it does not add anything to a cart. A `confirmed` result means the configured policy was satisfied; repeated incorrect readings can still satisfy that policy.

## Send a request

The request uses `multipart/form-data` with one to five repeated **`frames`** file fields and an optional **`options`** field containing a JSON string. Each upload must be a still PNG, JPEG or WebP image. Send captured frames as separate image files, not a video file.

Run these commands in PowerShell from the project directory after starting the API as described in [README.md](README.md#run-locally-on-windows). The request terminal's `BARCODE_API_KEY` environment variable must contain the same secret configured for the server. Replace the example image names with two actual captures of the same label.

```powershell
curl.exe --fail-with-body -X POST "http://127.0.0.1:8000/v1/pos/decode" -H "X-API-Key: $env:BARCODE_API_KEY" -F "frames=@frame-1.jpg" -F "frames=@frame-2.jpg" -F "options=<examples/pos-options.json"
```

The `<` in the `options` form argument tells curl to read the JSON file into the text field. The `@` in each `frames` argument uploads an image. Keep the form arguments quoted in PowerShell and let curl set the multipart boundary.

The [default options example](examples/pos-options.json) contains:

```json
{
  "allowed_formats": ["ean13", "upca", "code128", "qr"],
  "confirmation_frames": 2
}
```

Omitting `options`, or sending `{}`, uses those defaults. To accept one matching image without confirmation across frames, use the [single-frame options example](examples/pos-single-frame-options.json):

```powershell
curl.exe --fail-with-body -X POST "http://127.0.0.1:8000/v1/pos/decode" -H "X-API-Key: $env:BARCODE_API_KEY" -F "frames=@frame-1.jpg" -F "options=<examples/pos-single-frame-options.json"
```

Keep the API key in trusted server-side configuration or your local administrative shell. A browser POS should call its own backend, which supplies this header. Never place the shared key in browser JavaScript, client storage, or the public repository. This HTTP endpoint requires a running server and network connection; the existing browser scanner has a separate on-device offline workflow.

## Options and limits

| Setting | Accepted values |
| --- | --- |
| `allowed_formats` | A nonempty list of unique names from `qr`, `code128`, `ean13`, `ean8`, `upca`, `upce`, `datamatrix`, `aztec`, `pdf417`, `code93`; maximum ten |
| `confirmation_frames` | An integer from 1 to 3; default 2. Setting 1 disables confirmation across frames |
| Uploaded `frames` | One to five images in one request |
| Combined image file size | At most 10 MiB across all uploads, including duplicate uploads |
| Combined decoded image size | At most 20 million pixels across all uploads, including duplicate uploads |
| `options` JSON | At most 8,192 UTF-8 bytes |

Unknown option keys, duplicate format names, unsupported names and non-integer confirmation values are rejected with HTTP 422. Only the multipart fields `frames` and `options` are accepted; supply `options` once as text, not as an uploaded JSON file. The entire multipart request is also bounded to 10 MiB plus 64 KiB of overhead. Authentication failures return 401, invalid images 400, unsupported or animated images 415, and exceeded byte or pixel budgets 413. All images and options are validated before decoding starts.

The allowlist is passed to the native reader on its initial pass and respected by recovery passes; it is not merely a filter on the final response. Recovery remains bounded and follows the format-specific checks in the existing image reader. `GET /v1/formats` includes a `pos` object with the supported formats, defaults and image budgets.

## How the decision works

Every request is independent. Upload the frames for one attempt together: two one-frame requests do not accumulate into a confirmed result. There is no server-side scan session or memory of previous attempts.

A candidate identity is its canonical format, native raw payload bytes and decoded text together. Different character encodings can give the same bytes different meanings, so a disagreement in decoded text also makes candidates distinct. Identical display text with different bytes or formats remains different identities. Repeated copies of one identity at several positions in one image contribute one frame of evidence, not several products or units.

| Status | Reason | Meaning |
| --- | --- | --- |
| `confirmed` | `single_match` | Exactly one candidate identity and confirmation is set to 1 |
| `confirmed` | `frame_agreement` | Exactly one identity reaches the requested number of distinct matching frames |
| `ambiguous` | `conflicting_values` | More than one candidate identity appears anywhere in the burst |
| `rescan` | `no_code` | No allowed candidate was decoded |
| `rescan` | `insufficient_confirmation` | One candidate exists, but too few distinct frames match |

Any conflict makes the whole burst ambiguous, even if one candidate has a majority or already reached the confirmation threshold. Blank frames add no matching evidence, but do not reset agreement: `[A, blank, A]` can confirm at the default threshold. All three outcomes are normal decision responses; inspect `status` before using `barcode`.

Before duplicate detection, images receive EXIF orientation correction and transparency is composited on white. The server hashes the resulting RGB pixels and dimensions with SHA-256. Identical normalized images reuse the first image's decoding within that request and contribute no extra confirmation evidence. Re-encoding or metadata changes cannot add evidence when the normalized pixels remain identical. Different pixels, including small edits or lossy recompression, do not prove separate camera captures.

## Response fields

- `status` and `reason`: the decision and its explanation.
- `barcode`: the selected candidate when confirmed; otherwise `null`.
- `candidates`: every allowed identity, each with `text`, `format`, `bytes_base64`, and `frame_indices` identifying its nonduplicate evidence. Indices start at zero and follow upload order.
- `confirmation.required_frames`: the requested threshold. `distinct_frames`: the number of unique normalized images, including blank images. `matched_frames`: the largest candidate's evidence count, including in an ambiguous response.
- `allowed_formats`: the effective allowlist.
- `frames`: details for every upload, including `index`, normalized `image` dimensions, `duplicate_of` or `null`, and decoded `barcodes` with corner positions in the EXIF-normalized image coordinates. Duplicate uploads remain visible here.

For example, these decision fields describe two distinct images agreeing on one Code 128 value; the response's `candidates`, `allowed_formats` and `frames` fields are omitted from this excerpt:

```json
{
  "status": "confirmed",
  "reason": "frame_agreement",
  "barcode": {
    "text": "BOX-1042",
    "format": "code128",
    "bytes_base64": "Qk9YLTEwNDI=",
    "frame_indices": [0, 1]
  },
  "confirmation": {
    "required_frames": 2,
    "distinct_frames": 2,
    "matched_frames": 2
  }
}
```

Raw bytes are preserved as supplied by the native decoder. UPC-A may be reported as `ean13` with a leading-zero, thirteen-digit value; the default allowlist includes both formats. UPC-E values may be expanded by the native decoder. The API does not strip leading zeros arbitrarily or merge UPC-A and EAN-13 candidate identities. Define any retail-identifier conversion explicitly in your catalogue integration and retain the original value and format.

## Connect it to a POS

1. Capture one short burst for one scan attempt and submit it as one request.
2. Only consider adding an item when `status` is `confirmed`. On `ambiguous`, isolate the intended label and capture another burst. On `rescan`, obtain more useful frames or improve the view.
3. Look up the confirmed identifier exactly in your own catalogue, using explicit format/GTIN rules where needed. If there is no unique matching product, ask the operator instead of guessing or silently choosing a similar value.
4. Prevent request retries and repeated responses from adding the same scan attempt twice. Keep an action ID or idempotency record in your own POS backend; this decoding endpoint has no cart or cross-request deduplication. A later intentional scan of the same product can still represent another item.

The implementation and agreement policy are in [pos_decoding.py](pos_decoding.py). [DAMAGE-TESTING.md](DAMAGE-TESTING.md) records synthetic decoding results and known limitations; [MOBILE-TESTING.md](MOBILE-TESTING.md) describes capability simulations. Neither establishes physical-phone performance or Scanbot parity.
