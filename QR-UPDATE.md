# QR capture and recovery — 14 November 2026

This update adds QR-specific search and sampling to the browser scanner, camera
SDK, hosted embed and API. It also exposes QR generation error correction and
blank-border settings. ZXing still performs QR payload decoding and error
correction. The project supplies additional geometry, source sampling and
capture decisions; this is not a new complete QR decoder or a Scanbot comparison.

## Measured results

The frozen update improves a small number of blurred QR images on a fresh
synthetic set, with no previously exact case lost:

| Profile | QR before → after | All formats before → after |
| --- | ---: | ---: |
| Browser image | 41/57 → 42/57 | 136/171 → 137/171 |
| API image | 38/57 → 41/57 | 133/171 → 136/171 |
| POS image | 41/57 → 42/57 | 136/171 → 137/171 |
| POS live, one worker request at retry zero | 34/57 → 36/57 | 129/171 → 131/171 |

Every profile rejects **48/48 negative images**, with **zero incorrect values or
runtime errors**. Code 128 and EAN-13 counts are unchanged. Both browser and API
also retain **54/54 exact positive cases and 8/8 negative rejections** on the
separate byte/mixed-label safety set. This includes 40 QR images; it is not a
damaged-QR read-rate measurement.

All fresh gains are in the stronger blur cases. The new crop, scratch and
sampling paths do not establish additional fresh scratch, clipping or tiny-code
gains on this set. The camera detail and separate-frame safeguards are tested
through simulations and reported separately from these still-image counts.
The [full report](benchmark-results/qr-upgrade/README.md) includes retained
failures, individual changed cases, host latency, source hashes and commands.

The software suite passes **604 JavaScript tests and 431 Python tests**, with
one existing Windows platform skip. TypeScript, OpenAPI, the React build and
the existing development benchmark commands also pass. See [TESTING.md](TESTING.md).

## Reading difficult QR images

`web/qr-geometry.js` searches observed black/white runs for finder patterns and
checks candidate grids against finder and timing patterns. Three consistent
finder observations can authorize bounded grid sampling. The detector estimates
cell size and returns source-image coordinates. It does not draw a missing
finder pattern or insert expected payload data. The new fitted grid is an affine
proposal, not a general perspective or curved-surface reconstruction; the
original native reader retains its existing detection paths.

`web/qr-recovery.js` tries source-only crops, module-centre samples, small sampling
offsets, thresholds, scratch-resistant median samples and bounded inverse
filtering of measured cell intensities. Directional scratch filters are scaled
to observed cells. Source margins are preserved; grid sampling keeps only border
pixels actually present in the image. If symbol cells fall outside the source,
the grid retry abstains. All accepted outputs still require valid native QR
decoding and retain the native bytes and text.

In live mode a source crop plus one QR sampling candidate is tried per detected
region; inverse filtering is tried early. Image mode can inspect more bounded
candidates. QR-specific work has a 100 ms live / 400 ms image retry-start share
inside the existing 350 ms / 2.5 s worker budget. Individual synchronous decoder
calls can exceed these outer deadlines. The original full-image pass and the
independent Code 128/EAN safeguards remain ahead of new QR recovery.

The API uses the separate `qr_recovery.py` helper after its existing full-view
retries miss, within the existing 2.5-second retry-start budget. Its finder-based
crops and sampled grids use the same original grayscale working image. It adds
no production dependency. Docker includes the new helper.

Incomplete or capped searches cannot publish a unique cropped result. Different
payloads remain conflicting, and equal payloads at separate physical positions
remain separate reader observations. Multiple transformations or crops of one
image never count as separate camera confirmations. Existing full-view successful
reads retain their behavior.

## Camera capture and focus

Frame analysis can now measure clarity inside an observed QR grid rather than
letting surrounding texture dominate its score. It estimates whether cells are
too small for the balanced preview. A complete single-QR proposal below 2.5
captured pixels per cell can request source detail after two distinct misses over
at least 150 ms. Other useful small/blurred-region misses retain the three-miss,
400 ms rule. The detail window lasts three seconds with a ten-second cooldown.
Any observed identity blocks further escalation until reset; stale images end
the window. These thresholds are heuristics, not decoded evidence.

Detailed camera capture retains a bounded source exposure and at most two
higher-resolution crops from it. The broad view is read first, crop coordinates
map back to the original source, and an unchecked additional proposal prevents
unique cropped acceptance. QR proposals merge with matching generic proposals
by taking the union of their source crops, preserving the earlier margins.

Supported autofocus and exposure requests remain optional browser capabilities.
The scanner cannot claim the camera has reached focus when the browser exposes
no such status. Frame selection and blur guidance remain necessary. Requested
4K dimensions are ideals; actual source resolution depends on the camera and
browser. Real Android/iPhone cameras were not available for this update.

## QR generation

`POST /v1/barcodes/generate` accepts two QR-only options:

| Field | Values | Default |
| --- | --- | --- |
| `qr_error_correction` | `L`, `M`, `Q`, `H` | Omitted: existing native default, currently L |
| `qr_quiet_zone` | Integer 4–16 QR cells on each side | 4 |

For example, send this JSON with your existing server API authentication:

```json
{
  "format": "qr",
  "text": "POS-ITEM-001",
  "output": "png",
  "scale": 6,
  "qr_error_correction": "H",
  "qr_quiet_zone": 4
}
```

Both PNG and SVG generation retain the requested border. Existing requests keep
their previous output; explicit QR options on other formats are rejected.
JavaScript/TypeScript and Python clients expose these fields, and the committed
OpenAPI document describes their validation.

Higher error correction adds redundancy and can increase symbol size. Keep the
printed cells large enough and retain a clear border. Changing generation
settings does not upgrade error correction in an already printed QR code.
[DENSO correction guidance](https://www.qrcode.com/en/about/error_correction.html)
and [border requirements](https://www.qrcode.com/en/howto/code.html) explain those
tradeoffs.

## Limits and verification

Missing sections, cropped-off symbol data, severe motion blur and cells below
the captured resolution can still be unreadable. Small horizontal/vertical
inverse-filter experiments on old severe-motion-blur cases added no reads with
a verified grid, so those extra filters were not shipped. The scanner does not
guess a grid when the required finder evidence is absent. Larger digital images
do not create new optical information.

The development and fresh evaluation reports distinguish image decoding from
camera simulations. Real-WASM SDK tests exercise newly recovered blurred QR
images, exact bytes and confirmation across separate simulated frames. Capture
and lifecycle simulations are not tests on actual Android/iPhone hardware.

The paired evaluation uses the full baseline commit
`1821c9324b492af5f42024a1e7efb7345e7942ac` with the same current scorer on both
versions. All earlier corpora are now development evidence. The new damage and
byte-safety corpora are frozen before updated outcomes are inspected; the
[protocol](tools/baselines/qr-upgrade/README.md) records their hashes, independent
input truth and the specification-driven fixture revision. The
[evaluation report](benchmark-results/qr-upgrade/README.md) records exact reads,
wrong values, retained misses, latency and source hashes.

Deploy the complete updated `web/` tree together, including `qr-geometry.js` and
`qr-recovery.js`. Offline cache version is **1.11.0**. The React asset-copy step
includes both new modules. The benchmark adapter records
`worker-image-qr-v1`; older report configurations remain readable but cannot be
silently mixed into one paired run.
