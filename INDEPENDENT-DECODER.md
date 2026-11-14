# Independent barcode decoding — 14 November 2026

This records the previous linear-decoder update. The subsequent
[QR capture and recovery update](QR-UPDATE.md) has its own paired evaluation;
the measurements below remain the historical results of this release.

The scanner now combines different decoding implementations to address a known
wrong Code 128 reading and some small or difficult linear barcodes. The browser
uses ZXing, ZBar and the project's Code 128 matcher. The API uses ZXing and
native ZBar through pyzbar. QR decoding remains with the existing ZXing path.
This update includes synthetic evaluation and camera simulations, not a
physical-phone or Scanbot comparison.

## Measured results

On the new frozen damage corpus, exact reads improved without losing any
previously exact case:

| Profile | Before | After | Incorrect readings before → after |
| --- | ---: | ---: | ---: |
| Browser image | 133/171 | 137/171 | 1 → 0 |
| API image | 129/171 | 131/171 | 0 → 0 |
| POS image | 133/171 | 137/171 | 1 → 0 |
| POS live, one worker call at retry zero | 110/171 | 128/171 | 0 → 0 |

All four profiles rejected **48/48 negatives** and returned no runtime errors.
The browser's Code 128 image reads improved **47→51/57**; the API's new gains
were two EAN-13 reads. The live worker gained twelve Code 128 and six EAN-13
reads. QR scores did not change. The independent semantic suite remained
**52/52 positives and 8/8 negatives** in both browser and API, with exact raw
bytes and no incorrect results. These are related synthetic transformations,
not hundreds of independent camera photographs.

The added processing has a cost: warmed browser image median latency increased
from **11.82 to 27.59 ms**, and the live worker median increased from **6.80 to
14.97 ms**. Browser image p95 decreased from 740.21 to 493.06 ms, while live p95
increased from 64.57 to 87.86 ms. These single-run host timings exclude engine
startup, HTTP, cameras and confirmation and cannot predict phone performance.

The older problem set is now development evidence: browser reads improved
**134→138/171**, API reads **132→135/171**, and the demonstrated wrong Code 128
reading disappeared in both. All earlier exact reads were retained. The
original development set stayed at browser **137/171** and API **136/171**.
See [development evidence](benchmark-results/independent-upgrade/development/README.md)
and the [fresh paired report](benchmark-results/independent-upgrade/README.md).

Verification passed **568 JavaScript tests**, **383 Python tests** with one
platform skip, TypeScript declarations, OpenAPI validation, the React production
build and all existing CI development benchmarks. The standalone custom engine
still reads 44/57 Code 128 development images; combining complementary engines
does not make that prototype a complete replacement. **171/171 has not been
achieved.** No production tuning followed inspection of the new evaluation.

## The project's own decoder

The code under `web/engine/` measures bar/space runs, matches Code 128 patterns,
validates its checksum and requires agreement across source rows. It does not
call ZXing or ZBar to perform that decoding. Pattern-table data is attributed
to ZXing-C++ under Apache-2.0; matching, validation, sampling and agreement logic
are project code. Existing notices remain in `web/engine/THIRD-PARTY.txt`.

The lab prototype supports Code Sets A/B/C, switching, SHIFT, ASCII controls and
leading GS1 FNC1. It deliberately rejects unsupported FNC2/FNC3/FNC4 and some
other semantic cases. The new production fallback is narrower: printable,
non-GS1 ASCII only, because native GS1/control display formatting must stay
consistent across frames. Existing native support for those cases is retained.
This is an independently implemented Code 128 reader, not a complete proprietary
replacement for every barcode format. The lab remains available for further
engine development.

## How results are combined

The original full-view ZXing read still runs first. A different implementation
does not automatically win a disagreement.

For a conflicting browser Code 128 result, ZBar and the project matcher must
agree on the exact bytes and the same physical symbol before replacing the
native interpretation. A native identity independently supported at its own
location stays intact. Width, reading direction and unique spatial association
prevent a larger neighbouring label from absorbing another result. Unresolved
credible project conflicts remain visible to the POS policy. Missing or timed-out
corroboration does not by itself invalidate native GS1, controls or extended bytes.

On a native miss, the project matcher can provide a checked Code 128 result;
ZBar can provide a checked non-leading-zero EAN-13 result. Unverified ZBar
Code 128 observations prevent an otherwise unique independent batch from being
accepted. Existing native full-view recovery retains its earlier semantics:
an unverified observation is not promoted to a false label or confirmation vote.
Barcode location heuristics cannot prove that no other physical label exists.

The API requires exact-byte agreement between ZBar and a separately resampled
ZXing read before publishing a ZBar Code 128 observation or correcting an
existing interpretation. It publishes the corroborating native result, preserving
the API's established text formatting. There is at most one ZBar observation
pass and one cached two-times bilinear Code 128 corroboration per request.

Two library limitations are explicitly guarded. Both tested ZBar builds can
drop the high bit of some FNC4 Code 128 payloads, so ZBar alone never determines
a Code 128 answer. ZBar can also expand a physical UPC-E into a leading-zero
EAN-13 value despite UPC-E being disabled. New ZBar EAN fallback abstains on
those ambiguous representations; native EAN-13, UPC-A and UPC-E support stays
available through the original format-aware path. No known expected barcode
value is hard-coded into production.

## Budgets, loading and distribution

Both browser WASM engines initialize from local files before the worker becomes
ready. Missing required assets produce a loading error. Independent work uses
at most a 120 ms live or 500 ms image retry-start share, reserving time for
existing recovery. The worker's overall 350 ms live/2.5 s image retry-start
limits and pixel limits remain. Individual synchronous native calls cannot be
interrupted by those deadlines. Project scan loops now accept a bounded per-call
budget; cached arithmetic functions also reduce their worker execution overhead.

Independent decoder agreement is still evidence from one image, not two camera
frames. The SDK keeps its separate-frame confirmation, duplicate-image checks,
accepted-scan pause and conflict policy. A real-WASM SDK regression corrects the
previous wrong Code 128 example, then confirms only after another distinct
simulated frame with unchanged barcode pixels.

Deploy the complete updated `web/` tree together. New files include
`independent-reader.js`, the Code 128 engine modules and `vendor/zbar/`.
The offline cache is version **1.10.0** and requires both engines. The React
asset-copy script includes all runtime files. Third-party licenses remain
separate from the project's MIT license; ZBar and its wrapper retain
LGPL-2.1-or-later. Pinned corresponding source, hashes and build/replacement
instructions are bundled in [web/vendor/zbar/](web/vendor/zbar/README.md).

The server now requires `pyzbar==0.1.9` and a native ZBar library. The Dockerfile
and CI install `libzbar0`; macOS needs `brew install zbar`, and Windows wheels
bundle ZBar. Missing dependencies stop API startup with installation guidance.
Local API tests use the Windows wheel's ZBar 0.10; the browser uses ZBar 0.23.90
through `@undecaf/zbar-wasm` 0.11.0. Native platform versions can behave
differently. Docker/Linux execution was not available locally for this update.

## Independent evaluation protocol

The complete baseline is commit `a86a7d14f58eadc409ba0e8bd72d23442aba0cfa`.
All previous image corpora, including the recovery update's new set, became
development evidence for this iteration. Two new corpora were frozen before
updated outcomes were inspected:

- `damage-stress-independent.json`: seed **329478601**, 171 positives and 48
  negatives; SHA256 `bcbd1fe36eaba6f237be6ae2e4392fe5ba38624337e920312d3b4a314e60cc65`.
- `independent-code128-safety.json`: seed **923761059**, 52 positives and 8
  negatives; SHA256 `23ad79f4bd98300cac4c886aac08e527abc013e07b6fc016562d661b99769a04`.

Generators make no decoder calls and perform no outcome filtering. Values are
disjoint from older development examples, and byte-for-byte regeneration was
verified. The safety corpus uses independently constructed Code 128 patterns
for set switching, SHIFT, GS1, controls and FNC4, plus separate-label scenes and
invalid checksums. Raw encoder-input bytes are authoritative where display
formatting is ambiguous. The same byte-aware scorer evaluates both isolated
baseline and updated readers; matching displayed text with wrong bytes fails.

An exact read requires every expected value/format and no incorrect extra.
Unexpected values retain a nonzero benchmark exit status. POS image/live
profiles use fixed images, and the live profile makes one worker call at retry
zero. They do not measure full camera acquisition, all retry phases or time to
confirmation. Correlated transforms of a few generated labels are not
independent real-world photographs. Any future tuning on these new reports
must use another independent evaluation set.

## Other engines investigated

ZBar and the project matcher showed complementary linear-barcode reads on
development images. jsQR 1.4.0 and OpenCV 5.0's QRCodeDetector were also tested
on the original development and former recovery sets; neither recovered a QR
image that the existing complete reader missed. They were not added to the
runtime. ZBar QR output can also transform character encodings, so its QR path
was excluded rather than changing the API's raw-byte contract without a
demonstrated gain.

See [the detailed benchmark reports](benchmark-results/independent-upgrade/README.md)
for exact counts, retained errors, latency, source hashes and reproduction.
