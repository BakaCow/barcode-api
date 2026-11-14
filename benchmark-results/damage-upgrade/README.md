# Damaged-code evaluation

Measured on 14 November 2026. Baseline: `ddfacf0d8465ca5020a5efe13b5ca79cf62d9980`. Both sides use the same byte-aware scorers and isolated complete runtimes. Updated production hashes were frozen before fresh outputs were inspected and stayed unchanged throughout evaluation. All earlier corpora are development data.

These are synthetic fixed images, not actual Android/iPhone captures or a Scanbot comparison. Passing software tests is separate from recognition accuracy. A correct reading accompanied by a wrong extra fails.

## Previous development set

The previous signal-update corpus contains 171 positives and 48 negatives. It was available for implementation and must not be called unseen.

| Profile | Correct before → after | Wrong outputs before → after | Lost exact cases |
| --- | --- | --- | ---: |
| Browser image | 148 → 151/171 | 1 → 0 | 0 |
| Server image | 149 → 152/171 | 1 → 0 | 0 |

All negative controls and runtime errors are reported in [development/summary.json](development/summary.json). The known false UPC-E output now causes unrestricted decoding to abstain; restricted EAN-only POS decoding can return the source-supported EAN. Abstention is not counted as a correct read.

## Fresh evaluation

The damage set has 171 transformations from nine new payload groups plus 48 negatives. The separate byte/label set has 54 positive scenes and eight negatives. Both were generated without decoder calls or outcome filtering, before fresh evaluation.

| Profile | Correct before → after | Negatives rejected after | Wrong outputs before → after | Lost exact cases |
| --- | --- | --- | --- | ---: |
| Browser image | 151 → 154/171 | 48/48 | 0 → 0 | 0 |
| Server image | 150 → 153/171 | 48/48 | 0 → 0 | 0 |
| Browser POS image | 151 → 154/171 | 48/48 | 0 → 0 | 0 |
| Browser POS live, retry 0 | 143 → 146/171 | 48/48 | 0 → 0 | 0 |
| Browser byte/label controls | 54 → 54/54 | 8/8 | 0 → 0 | 0 |
| Server byte/label controls | 54 → 54/54 | 8/8 | 0 → 0 | 0 |

Runtime errors and command exit codes are preserved in [summary.json](summary.json). A zero exit permits unread positives; it does not mean 100% recognition. No decoder source or fixture changes followed inspection of this fresh evaluation.

## Remaining positive failures

| Profile | Remaining conditions |
| --- | --- |
| Browser image | clipping-2: 9, missing-patch-2: 3, scratches-2: 3, small-in-frame-2: 2 |
| Server image | blur-2: 1, clipping-2: 9, missing-patch-2: 3, scratches-2: 3, small-in-frame-2: 2 |
| Browser POS image | clipping-2: 9, missing-patch-2: 3, scratches-2: 3, small-in-frame-2: 2 |
| Browser POS live, retry 0 | angled-2: 1, blur-2: 1, clipping-2: 9, missing-patch-2: 3, scratches-1: 1, scratches-2: 3, shading-lowcontrast-2: 3, small-in-frame-2: 4 |

Complete gains, lost cases, per-format counts, unexpected outputs and per-condition comparisons are in [summary.json](summary.json) and [conditions.json](conditions.json).

## Host timing

| Profile | Median ms before → after | p95 ms before → after |
| --- | --- | --- |
| Browser image | 24.36 → 24.8 | 490.56 → 494.1 |
| Server image | 7.429 → 7.563 | 566.73 → 593.761 |
| Browser POS image | 25.94 → 25.65 | 476.16 → 483.16 |
| Browser POS live, retry 0 | 21.59 → 22.5 | 93.86 → 100.47 |

Sequential single-run Windows host timings exclude startup, HTTP, camera and UI. The live profile is one worker call at retry zero; it does not measure acquisition, adaptive retries, frame fusion or time to confirmed result. Expensive recovery can increase tail latency.

## Camera and byte safety

Separate camera tests use three source exposures with moving white occlusions, actual production-worker misses for each individual image, exact clean source reconstruction and real WASM decoding. They test disjoint burst confirmation, stale contributors, source reuse, switched labels, explicit targets and conflict retention. This is a deterministic development sequence, not a broad camera recognition benchmark.

Byte/label controls cover binary, control, UTF-8 and Latin-1 QR bytes, all four QR correction levels, other-format controls and multiple labels. Raw bytes are authoritative; printable ASCII also requires exact text. Explicit ECI, GS1 QR and structured append are not covered by this suite.

Recovery uses observed source support and bounded QR redundancy. Permanently clipped content, missing finders, severe blur, insufficient pixels and damage beyond correction capacity can remain unreadable. No claim of complete recovery or commercial SDK equivalence is made.

- [Implementation and integration](../../DAMAGE-RECOVERY-UPDATE.md)
- [Software validation](../../TESTING.md)
- [Reproduction and fixture protocol](../../tools/baselines/damage-upgrade/README.md)
