# Development checks

These older corpora were used during implementation. They are not the fresh
evaluation for this update; see [the paired fresh report](../README.md).
Exact means every expected value and format, with no incorrect extra.

| Corpus/profile | Previous release | Current | Incorrect readings before → after |
| --- | ---: | ---: | ---: |
| Original development, browser | 137/171 | 137/171 | 0 → 0 |
| Original development, API | 136/171 | 136/171 | 0 → 0 |
| Former recovery, browser | 134/171 | 138/171 | 1 → 0 |
| Former recovery, API | 132/171 | 135/171 | 1 → 0 |

All four current reports reject 48/48 negatives, have no runtime errors and
retain every previously exact case. Current reports are
[browser development](browser-dev-after.json),
[API development](api-dev-after.json),
[browser recovery](browser-recovery-after.json) and
[API recovery](api-recovery-after.json). They record the final frozen reader
hashes; the API recovery run was repeated after the last production safeguards.

The matching previous-release reports are
[browser development](../../recovery-upgrade/development/worker-damage-stress-dev-after.json),
[API development](../../recovery-upgrade/development/api-dev-after.json),
[browser recovery](../../recovery-upgrade/browser-after.json) and
[API recovery](../../recovery-upgrade/api-after.json). Their historical timing
runs were not paired with these current runs, so this table makes no speed claim.

The known wrong image is
`code128/recovery-code128-label-3/small-in-frame-1`. Its correct payload is
`bx:r-439508/aZ`. Both updated readers return that exact value and bytes.
The browser additionally recovers three severe small-in-frame Code 128 images;
the API additionally recovers two shaded low-contrast EAN-13 images. No expected
payload is hard-coded in production. Regression tests use those examples as
labelled fixtures, separate from the new evaluation corpus.

## Standalone project engine and other candidates

The existing CI benchmarks also passed. The [custom engine development run](custom-dev-after.json)
reads 44/57 Code 128 images and rejects 48/48 negatives, with zero unexpected
values/errors. The [eight-image custom demo](custom-demo-after.json) reads 6/6
positives and rejects 2/2 negatives. Those are unchanged recognition counts,
not evidence of a complete standalone replacement.

Additional QR implementations were tried on the original development and former
recovery corpora. These probes received unchanged source pixels, without new
image preprocessing. They were exploratory tests, not exhaustive evaluations
of either library's potential:

| Candidate | Original QR exact /57 | Recovery QR exact /57 | Additional QR reads beyond existing full reader |
| --- | ---: | ---: | ---: |
| jsQR 1.4.0, `inversionAttempts: attemptBoth` | 32 | 32 | 0 |
| OpenCV 5.0, grayscale `QRCodeDetector.detectAndDecode` | 30 | 27 | 0 |

Both probes rejected all 48 negatives in each corpus and returned no wrong
values. Reports are [jsQR original](damage-stress-dev-jsqr.json),
[jsQR recovery](damage-stress-recovery-jsqr.json),
[OpenCV original](damage-stress-dev-opencv.json) and
[OpenCV recovery](damage-stress-recovery-opencv.json). `priorExact` is the
previous complete browser reader for jsQR and API reader for OpenCV; none of
the new correct observations recovered a previously missed QR image. These
libraries were not added to the production decoding path.

To repeat the final development readers from the repository, create `data/local`
and run:

```powershell
New-Item -ItemType Directory -Force data/local | Out-Null
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-stress-dev.json --output data/local/browser-dev.json
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-stress-recovery.json --output data/local/browser-recovery.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/damage-stress-dev.json --output data/local/api-dev.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/damage-stress-recovery.json --output data/local/api-recovery.json
node tools/benchmark-code128.mjs --fixtures data/synthetic/dev-pixels.json --output data/local/custom-demo.json
node tools/benchmark-damage-custom.mjs --corpus tests/fixtures/damage-stress-dev.json --output data/local/custom-dev.json
```

Install the documented dependencies, including native ZBar for the API, first.
Native ZBar here was the Windows wheel's 0.10 build. Real phone images and
Linux/Docker execution were not tested in this update.
