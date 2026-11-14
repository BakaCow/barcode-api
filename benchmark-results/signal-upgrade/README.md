# Motion-blur and tiny-code evaluation

Measured on 14 November 2026. The complete baseline is commit
`bc0ed027bb4358237b029993d7db18b6e0aa2537`. Both sides use the same
byte-aware scorers and complete isolated runtimes. All production source
hashes were frozen before updated fresh results were inspected and remained
unchanged throughout evaluation. No fixtures were changed or removed.
Baseline aggregates were available earlier; fresh per-case baseline outcomes
remained uninspected until the production freeze.

These are fixed synthetic image tests, not physical-phone camera tests or
a Scanbot comparison. A correct value accompanied by a wrong extra fails.

## Existing development images

The previous QR-update corpus has 171 positive images and 48 negatives.
It was used during implementation, so its gains are development evidence.

| Profile | Exact positives before → after | Motion before → after | Tiny before → after | Wrong outputs after |
| --- | --- | --- | --- | ---: |
| Browser image | 137 → 154/171 | 9 → 18/18 | 10 → 18/18 | 0 |
| Server image | 136 → 153/171 | 9 → 18/18 | 10 → 18/18 | 0 |

Both development profiles reject 48/48 negatives with zero runtime errors.
The severe subset is included in those counts: 9 motion plus 9 tiny images.
The actual SDK callback and production upload regressions exercise these
18 severe images; an additional Uvicorn HTTP smoke run reads all 18 exactly.
All four existing CI benchmark commands pass; their separate original
development-corpus results are preserved in [development/summary.json](development/summary.json).

## Fresh evaluation

The fresh damage corpus has 171 transformed positives from nine new payload
groups plus 48 negatives. The independent byte/label suite has 54 positive
scenes and eight negatives. Earlier corpora are excluded from fresh claims.

| Profile | Exact positives before → after | Negatives rejected after | Wrong outputs before → after | Lost exact cases |
| --- | --- | --- | --- | ---: |
| Browser image | 133 → 148/171 | 48/48 | 1 → 1 | 0 |
| Server image | 133 → 149/171 | 48/48 | 1 → 1 | 0 |
| Browser POS image | 134 → 149/171 | 48/48 | 0 → 0 | 0 |
| Browser POS live, retry 0 | 129 → 142/171 | 48/48 | 0 → 0 | 0 |
| Browser byte/label controls | 54 → 54/54 | 8/8 | 0 → 0 | 0 |
| Server byte/label controls | 54 → 54/54 | 8/8 | 0 → 0 | 0 |

All runtime errors and command exit codes remain in [summary.json](summary.json).
A zero command exit permits unread positives; it does not mean every image
was read. Commands with incorrect values retain their nonzero exit.

### Motion and tiny conditions on fresh images

| Profile | Motion before → after | Tiny before → after | Severe combined before → after |
| --- | --- | --- | --- |
| Browser image | 9 → 18/18 | 11 → 17/18 | 2 → 17/18 |
| Server image | 9 → 18/18 | 10 → 17/18 | 1 → 17/18 |
| Browser POS image | 9 → 18/18 | 11 → 17/18 | 2 → 17/18 |
| Browser POS live, retry 0 | 9 → 18/18 | 10 → 14/18 | 1 → 14/18 |

All/severe groups overlap; do not add their denominators. Full per-format
and per-condition counts are in [conditions.json](conditions.json).

### Incorrect outputs and remaining failures

- Browser image: `ean13/signal-upgrade-ean13-label-1/missing-patch-1`; the same incorrect output was present in the baseline. Correct and incorrect outputs together are scored as a failed image.
- Server image: `ean13/signal-upgrade-ean13-label-1/missing-patch-1`; the same incorrect output was present in the baseline. Correct and incorrect outputs together are scored as a failed image.

Remaining unsuccessful positive images by condition:

| Profile | Remaining conditions (image counts) |
| --- | --- |
| Browser image | blur-2: 3, clipping-2: 9, missing-patch-1: 4, missing-patch-2: 3, scratches-2: 3, small-in-frame-2: 1 |
| Server image | blur-2: 2, clipping-2: 9, missing-patch-1: 4, missing-patch-2: 3, scratches-2: 3, small-in-frame-2: 1 |
| Browser POS image | blur-2: 3, clipping-2: 9, missing-patch-1: 3, missing-patch-2: 3, scratches-2: 3, small-in-frame-2: 1 |
| Browser POS live, retry 0 | angled-2: 1, blur-2: 3, clipping-2: 9, missing-patch-1: 3, missing-patch-2: 3, scratches-2: 3, shading-lowcontrast-2: 3, small-in-frame-2: 4 |

## Timing and scope

| Fresh profile | Median ms before → after | p95 ms before → after |
| --- | --- | --- |
| Browser image | 33.11 → 33.62 | 478.58 → 495.61 |
| Server image | 7.43 → 7.647 | 97.031 → 518.566 |
| Browser POS image | 34.37 → 34.46 | 457.06 → 490.47 |
| Browser POS live, retry 0 | 17.8 → 19.52 | 97.35 → 106.01 |

Timings are sequential single-run Windows-host measurements over all cases.
They exclude startup, HTTP upload, camera capture, UI and confirmation.
Extra successful recovery can increase tail latency. Live retry zero is one
worker request per still image; it is not the full camera retry sequence.

The source models cover bounded uniform exposure blur and eligible tiny
front-facing symbols. Arbitrary shake, perspective, glare, missing content
and detail absent from the sensor can still require another capture.
Native decoding of a derived candidate preserves payload semantics; it is
not an independent second observation. Repeated crops of one exposure do
not add POS confirmation frames.

The byte/label suite covers binary/control/UTF-8/Latin-1 QR data and all
four QR correction levels, other format controls and multiple labels.
It does not establish explicit ECI, GS1 QR or structured-append coverage.
Raw byte identity is authoritative; printable ASCII also requires exact text.

## Reproduce and inspect

- [Frozen-fixture and baseline protocol](../../tools/baselines/signal-upgrade/README.md)
- [Complete fresh summaries, regressions, versions and source hashes](summary.json)
- [Fresh condition counts](conditions.json)
- [Development paired reports and CI command results](development/summary.json)
- [Implementation and integration notes](../../MOTION-TINY-UPDATE.md)
- [Software test evidence and limits](../../TESTING.md)

Original and updated runtime paths are recorded for provenance. Recreate
the baseline checkout locally as described in the protocol. Physical Android
and iPhone devices, Docker/Linux execution and a licensed vendor comparison
were unavailable. Recognition scores are separate from passing software tests.
