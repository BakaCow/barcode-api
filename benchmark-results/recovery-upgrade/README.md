# Recovery update: independent synthetic evaluation

The updated browser reader recovered one additional scratched QR image on a
new, frozen dataset. No case regressed in the six profiles below. The fresh
evaluation still contains incorrect values, including one Code128 substitution
and one extra UPC-E detection in a separate compatibility set. These results
do not establish error-free scanning, Scanbot parity, or accuracy on physical
Android/iPhone cameras.

Baseline: `aeef1929790bbc3febcd65147388fbde1f78d288`. Before runs used the
complete archived baseline, including its benchmark tools and all JavaScript
dependencies. Updated source hashes were captured before evaluation and checked
after every run. See [summary.json](summary.json) for exact hashes, comparisons,
case names, and command exit codes.

## Fresh damage results

The same 219 synthetic images were used for each before/after pair: 171
positive images derived from nine disjoint payload groups, plus 48 negatives.
An exact read requires every expected identifier and no unexpected identifier.
A correct result accompanied by an incorrect extra value fails the case.

| Profile | Exact positives before | Exact positives after | Negatives rejected, both versions | Unexpected results, both versions | Regressed cases |
| --- | ---: | ---: | ---: | ---: | ---: |
| Browser image, unrestricted formats | 133/171 | 134/171 | 48/48 | 1 | 0 |
| API image, unrestricted formats | 132/171 | 132/171 | 48/48 | 1 | 0 |
| Browser image, default POS formats and enhancement | 133/171 | 134/171 | 48/48 | 1 | 0 |
| Browser live worker, default POS formats and enhancement, retry index 0 | 113/171 | 113/171 | 48/48 | 1 | 0 |

Every profile had zero execution errors. The nonzero benchmark exit codes are
intentional: the evaluator fails a command when it detects an unexpected value.
Misses remain misses; they are not counted as successful negative rejection.

| Profile | QR before → after, of 57 | Code128 before → after, of 57 | EAN13 before → after, of 57 |
| --- | ---: | ---: | ---: |
| Browser image | 39 → 40 | 47 → 47 | 47 → 47 |
| API image | 39 → 39 | 47 → 47 | 46 → 46 |
| POS image | 39 → 40 | 47 → 47 | 47 → 47 |
| POS live worker, retry index 0 | 34 → 34 | 36 → 36 | 43 → 43 |

The only newly exact case was
`qr/recovery-qr-label-3/scratches-1`, in browser image and POS image mode.

The fixed-image POS profiles exercise worker options only. They do not exercise
camera acquisition, frame selection, automatic detail capture, confirmation,
or all live retry phases. In particular, the single live retry-index-0 result
does not measure the new later QR retry phase or the eventual live success rate.

## Valid UPC-E and multiple-label preservation

An additional frozen set contains 42 synthetic positive images from 14 UPC-E
payloads. It covers number systems 0 and 1 and every zero-suppression branch,
with each payload clean, rotated, and beside a separately placed EAN13 label.
Expected identifiers come from encoder inputs and independent expansion/check
digit arithmetic; no decoder predictions defined the ground truth.

| Profile | Exact before | Exact after | Isolated/rotated UPC-E exact, both | Separate-label images exact, both | Unexpected results, both |
| --- | ---: | ---: | ---: | ---: | ---: |
| Browser image | 41/42 | 41/42 | 28/28 | 13/14 | 1 |
| API image | 41/42 | 41/42 | 28/28 | 13/14 | 1 |

No valid expected label was lost in any of these 42 cases. The failing
multiple-label image contains both correct labels and an extra false UPC-E.
This compatibility set has no negatives and is not an estimate of false-positive
frequency in general business traffic.

## Remaining incorrect values

Both errors below existed in the baseline and persisted after the update.
They are retained as failures, rather than normalized away or excluded.

1. **A small Code128 returns a wrong payload.**
   `code128/recovery-code128-label-3/small-in-frame-1` should read
   `bx:r-439508/aZ`. The browser returns `bx:r-439508\u00c2\u00beZ`
   and the API returns `bx:r-439508\u00beZ` (shown using Unicode escapes).
   Both differ from the original ASCII encoder input; this is a genuine wrong
   value, not an equivalent formatting of the expected identifier. The clean
   version of this same payload reads exactly. Browser diagnostics show one
   `original` pass in all three browser profiles: the incorrect native result
   appears before fallback recovery. An allowed-format list does not reject it
   because Code128 is allowed. Agreement across repeated frames cannot by itself
   establish that a consistently wrong value is correct.
2. **A rotated UPC-E beside an EAN13 produces an extra UPC-E.**
   `multiple/recovery-format-1-4/upce-ean13` contains UPC-E encoder input
   `15766746`, expected expanded identifier `0157660000076`, plus EAN13
   `9998384654029`. Both expected values are returned, together with false UPC-E
   `0117100000677`. The extra identifier is neither an equivalent representation
   nor a third encoded label. API points for the false detection are
   `(93,108), (252,108), (249,117), (90,117)`, inside the rotated UPC-E label area
   at `(16,16)` with size `285×263`; the EAN13 label starts at x=349. The new
   EAN13-local corroboration does not establish that this extra value inside the
   UPC-E label is safe to discard. Browser diagnostics changed from one
   `original` pass to two passes with `retail-corroboration`, while preserving
   the conflicting evidence. A POS configuration permitting both genuine labels
   should keep this scene ambiguous instead of selecting one result.

## Runtime measurements

Times are milliseconds per image on this host, with profiles run sequentially.
These single-run measurements exclude process startup, HTTP, camera acquisition,
frame buffering, UI work, and time to confirmation. They are not phone-speed
measurements or statistically controlled performance claims.

| Profile | Median before → after | p95 before → after |
| --- | ---: | ---: |
| Browser image, damage | 11.17 → 10.61 | 473.49 → 477.58 |
| API image, damage | 6.937 → 6.922 | 66.044 → 66.648 |
| POS image, damage | 16.42 → 16.32 | 458.24 → 453.22 |
| POS live worker, retry index 0, damage | 4.53 → 5.98 | 48.01 → 50.19 |
| Browser image, UPC-E compatibility | 1.74 → 1.76 | 6.22 → 144.65 |
| API image, UPC-E compatibility | 1.445 → 1.418 | 5.179 → 17.983 |

The compatibility-set tail became slower because conservative corroboration
does additional work when UPC-E and EAN13 coexist. This tradeoff remains visible
even though all valid labels were preserved. The unresolved mixed-label browser
case itself increased from 5.62 to 144.65 ms in this run.

## Freeze and reproduction

The new damage fixture was frozen before implementation choices and compared
against all six earlier accuracy/damage sets for disjoint payloads and groups.
The additional compatibility fixture was also frozen before updated outcomes
were inspected. Per-case evaluation outputs were withheld from implementation
agents until all production source was frozen and every profile finished.
No algorithm or corpus changes were made in response to these fresh results.
Earlier corpora, including `damage-stress-accuracy-next.json`, are development
evidence for this iteration.

| Fixture | Seed | SHA256 |
| --- | ---: | --- |
| `tests/fixtures/damage-stress-recovery.json` | 406138731 | `d18d2ad1a359a8e333d9ea4a5bff7dc78656ef1c72c99a28b15b2bc64c9f9d46` |
| `tests/fixtures/recovery-format-safety.json` | 618092437 | `927833a400527228540142cc70b2ea7ed1532bd16ad4182c06366f33c3f15e95` |

The generators are `tools/generate-recovery-verification.py` and
`tools/generate-recovery-format-safety.py`. Both refuse to overwrite a changed
frozen fixture. See [RECOVERY-UPDATE.md](../../RECOVERY-UPDATE.md) and
[baseline reproduction notes](../../tools/baselines/recovery-upgrade/README.md)
for benchmark commands. Use a complete baseline checkout for enhanced POS
comparisons so its frame-analysis and policy dependencies are also the baseline.

Automatic source-detail recovery has separate, deliberately selected development
regression coverage in `tests/scanner-sdk.test.mjs`. An independently encoded
distant EAN13 in `automatic-capture-recovery.json` naturally fails balanced
downsampling, yields one actual analyzer proposal, and decodes through a real
native-resolution crop after three misses. It confirms only after a second
distinct successful frame, without reopening the camera. Opting out leaves that
same scene unread. This test uses the real local WASM decoder with simulated
nearest-neighbor camera sampling; it is not part of the fresh accuracy count.
