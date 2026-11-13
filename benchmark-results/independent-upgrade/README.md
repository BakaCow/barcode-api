# Independent decoder evaluation

The frozen update improved the browser image score from **133 to 137 of 171** and the server reader from **129 to 131 of 171** on a new synthetic damage corpus. The browser's incorrect Code 128 reading became an exact read. The updated readers emitted **zero unexpected values** on either new corpus, with no previously exact case lost in any of the six profiles.

These are fixed-image recognition results. They do not measure a complete live camera session, accuracy on real Android/iPhone hardware, or performance relative to Scanbot. The QR scores did not improve in this update.

## Damage results

Every row uses the same 171 positive images and 48 negative images. Do not add the negative counts across profiles: they are repeated evaluations of the same 48 images.

| Profile | Exact positive reads before | After | Newly exact | Lost exact | Unexpected values before → after | Negatives rejected before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Browser image | 133/171 | 137/171 | 4 | 0 | 1 → 0 | 48/48 → 48/48 |
| Server reader | 129/171 | 131/171 | 2 | 0 | 0 → 0 | 48/48 → 48/48 |
| Browser POS image | 133/171 | 137/171 | 4 | 0 | 1 → 0 | 48/48 → 48/48 |
| Browser POS live, retry index 0 | 110/171 | 128/171 | 18 | 0 | 0 → 0 | 48/48 → 48/48 |

All profiles had zero runtime errors. POS profiles enable frame analysis and allow `ean13,upca,code128,qr`. The live profile makes one worker request at retry index zero; it does not exercise acquisition, frame selection, later retries, adaptive camera resolution, POS acceptance or confirmation across frames. Each request can execute several internal decoding passes.

Each format has 57 positive images:

| Profile | QR before → after | Code 128 before → after | EAN-13 before → after |
| --- | ---: | ---: | ---: |
| Browser image | 39 → 39 | 47 → 51 | 47 → 47 |
| Server reader | 36 → 36 | 48 → 48 | 45 → 47 |
| Browser POS image | 39 → 39 | 47 → 51 | 47 → 47 |
| Browser POS live, retry index 0 | 33 → 33 | 39 → 51 | 38 → 44 |

The browser image gains are four small-in-frame Code 128 images. One is `code128/independent-code128-label-2/small-in-frame-1`: the baseline returned `0417875877739534S6(` instead of the encoder input `041787107773953415062248`. The updated worker returns the exact input, with the `independent-recovery` strategy. This fresh example was not used to choose the implementation. The same correction occurs in the POS image profile. These are two evaluations of one image, not two distinct incorrect examples.

The server gains are two strongly shaded, low-contrast EAN-13 images. The live worker gains are 12 Code 128 images involving small size, angles or low contrast, plus six low-contrast EAN-13 images. All 18 use the independent recovery path. The full case names and paired outcomes are in [summary.json](summary.json) and the individual reports.

Remaining misses are explicit failures, not removed cases. Browser image still misses 34 positives: 18 QR, six Code 128 and ten EAN-13. Its six Code 128 misses are the stronger motion-blur and clipping variants. The API still misses 40 positives: 21 QR, nine Code 128 and ten EAN-13. Its nine Code 128 misses also include the three smallest-in-frame variants. The live retry-zero profile misses 43 positives. Damaged QR, severe motion blur, clipping and insufficient pixel detail remain substantial limits; a second engine cannot reconstruct information absent from the image.

## Code 128 byte and format compatibility

| Profile | Exact positive images before → after | Negative images rejected before → after | Unexpected values | Runtime errors |
| --- | ---: | ---: | ---: | ---: |
| Browser image | 52/52 → 52/52 | 8/8 → 8/8 | 0 → 0 | 0 → 0 |
| Server reader | 52/52 → 52/52 | 8/8 → 8/8 | 0 → 0 | 0 → 0 |

This separate corpus covers 12 known encoder-input groups: Code Sets A/B/C, latches, SHIFT in both directions, ordinary printable punctuation, control bytes, initial GS1 FNC1, internal FNC1, single FNC4 upper-byte shifts and double-FNC4 latching. Each group has clean, rotated, small and mildly blurred versions. Four additional images contain two separate labels. Six deliberately invalid checksums and two blank images are negative cases. Both runtimes preserve all 48 single-label images and all four two-label images.

Ground truth comes from input bytes and explicit codewords with the Code 128 checksum, never decoder output. Raw bytes and format must match exactly. Ordinary printable ASCII also requires exact text. For GS1, controls and extended bytes, each runtime's displayed text is recorded separately because native HRI and character-set presentation differ; no bytes are normalized to fit a reader. A correct value accompanied by an unexpected extra is a failure. This corpus is a targeted compatibility check, not exhaustive coverage of all legal Code 128 strings or overlapping-label scenes.

## Timing and cost

These are single paired runs on the same Windows host, with profiles run sequentially while other project CPU work was paused. Times cover all positive and negative requests. They exclude decoder startup, camera capture, image import, HTTP and UI confirmation. Browser and Python reader numbers describe different execution paths and are not interchangeable.

| Profile | Median ms before → after | p95 ms before → after |
| --- | ---: | ---: |
| Browser image, damage | 11.82 → 27.59 | 740.21 → 493.06 |
| Server reader, damage | 7.017 → 7.047 | 87.637 → 68.448 |
| Browser POS image, damage | 16.97 → 27.17 | 720.54 → 478.51 |
| Browser POS live retry 0, damage | 6.80 → 14.97 | 64.57 → 87.86 |
| Browser image, Code 128 compatibility | 99.42 → 50.23 | 2914.62 → 2915.30 |
| Server reader, Code 128 compatibility | 22.407 → 24.037 | 113.946 → 124.205 |

Additional checks increase common-case browser work and the live profile's tail latency, while earlier recovery shortens some expensive image-mode failures. The compatibility corpus includes slow invalid-checksum searches; an individual native call can exceed an outer search budget. These timings are observations from one run, not statistical performance claims or phone frame-rate guarantees.

## Frozen protocol and provenance

The complete baseline was archived from commit `a86a7d14f58eadc409ba0e8bd72d23442aba0cfa` before implementation changes. Both versions use the same updated byte-aware scoring tools and separate complete runtimes. An old worker never imports new helpers or WASM. Implementation agents did not inspect the fresh fixture payloads or per-case outcomes before the final implementation was frozen; the evaluator reported only aggregate baseline counts beforehand. No decoder changes were made after the final results were inspected.

The damage corpus has nine positive payload groups, with 19 related transformations each, and eight negative families with six variants each. These are 171 positive transformations, not 171 independent photographs. Payloads and group identifiers are disjoint from all seven earlier accuracy/damage corpora, including the former recovery set. The compatibility corpus is separately generated from known input bytes. Neither generator calls a decoder or filters images by the outcome. Both fixtures were regenerated byte for byte before evaluation.

| Frozen fixture | Seed | SHA256 |
| --- | ---: | --- |
| `tests/fixtures/damage-stress-independent.json` | 329478601 | `bcbd1fe36eaba6f237be6ae2e4392fe5ba38624337e920312d3b4a314e60cc65` |
| `tests/fixtures/independent-code128-safety.json` | 923761059 | `23ad79f4bd98300cac4c886aac08e527abc013e07b6fc016562d661b99769a04` |

Source hashes were checked after every profile. [summary.json](summary.json) contains the complete baseline file manifest, frozen production/helper/scorer hashes, host metadata, exact improvement/regression lists and all exit codes. Each browser report lists loaded JS/WASM hashes. Each API report lists loaded source hashes and package/native-library versions. The baseline browser-image and POS-image commands exited 1 for the incorrect reading; those exits are preserved, not treated as successful runs. All updated profile commands exited 0, which means no unexpected result or runtime error, not that every positive was read.

Key updated runtime identities:

| File | SHA256 |
| --- | --- |
| `web/scanner-worker.js` | `d02005f6f74fba4a79b85e10d9e2fc289a2406068a657bb22efcfedf81df4511` |
| `web/independent-reader.js` | `8428bbd9ff0b391dbea21a7877684dd48e76dc1824e9c5fe86adbb6d3eb17a00` |
| `barcode_reader.py` | `3ceafeddb86f04ca8aa4fe9b9a048f47a037a252c990c1e09ab9408d30b0c2ff` |
| `independent_zbar.py` | `347e94219b4d7cfbc08069a689d717187b6f49500ada9397f13a6a905f5a355e` |

The browser adds `@undecaf/zbar-wasm` **0.11.0**, containing ZBar **0.23.90**, plus the existing project Code 128 decoder. The server adds `pyzbar` **0.1.9**; this Windows environment actually loaded native ZBar **0.10** (`libzbar-64.dll`, SHA256 `43ecda0a3e803ffadeab912f5ecaa2655a8a51c6af1c4286bf9ef21cc90a4b04`). Python ZXing-C++ **3.1.1** and Pillow **12.3.0** were identical before and after. The baseline API did not load ZBar. Linux Docker/CI native ZBar was configured but not executed for this evaluation, so these API results must not be presented as Linux results. Browser wrapper/core source archives and licenses are recorded in [vendor provenance](../../web/vendor/zbar/provenance.json).

Independent Code 128 candidates are corroborated before replacing a native read; ZBar's FNC4 high-bit behavior makes its Code 128 output unsuitable as a sole replacement authority. Browser project-only recovery is limited to printable non-GS1 values, while the original native decoder retains GS1/control/extended-byte handling. Independent QR recovery is not enabled, so the unchanged QR results are expected.

For reproduction commands, fixture generation and scoring details, see [the baseline protocol](../../tools/baselines/independent-upgrade/README.md). Results on earlier corpora, including the previously observed wrong Code 128 example, are recorded separately as [development evidence](development/README.md). All earlier corpora are development/debug evidence for this update. This newly published corpus must likewise be treated as development evidence if future changes are tuned using its failures.
