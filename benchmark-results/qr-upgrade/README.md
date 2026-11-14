# QR update: independent paired evaluation

On the new synthetic damage corpus, QR exact reads improved from **41 to 42 of 57 in the browser**, **38 to 41 on the server**, and **34 to 36 in a live retry-zero worker request**. These gains were stronger defocus-blur cases. There were **zero unexpected values, zero runtime errors and zero lost exact cases** across all six paired profiles. The update does not read every damaged QR code.

The new recovery code detects and samples photographed QR grids before passing them to the existing ZXing decoder. It is not a new independent QR payload decoder. These fixed-image scores do not measure a complete camera session, real Android/iPhone performance or a comparison with Scanbot.

## Fresh damage results

Each profile uses the same 171 positive images: 57 QR, 57 Code 128 and 57 EAN-13. Every profile also uses the same 48 negatives. Those negative counts must not be added together as if they were different images.

| Profile | All formats before → after | QR before → after | Newly exact | Lost exact | Unexpected values before → after | Negatives rejected before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Browser image | 136 → 137/171 | 41 → 42/57 | 1 | 0 | 0 → 0 | 48/48 → 48/48 |
| Server reader | 133 → 136/171 | 38 → 41/57 | 3 | 0 | 0 → 0 | 48/48 → 48/48 |
| Browser POS image | 136 → 137/171 | 41 → 42/57 | 1 | 0 | 0 → 0 | 48/48 → 48/48 |
| Browser POS live, retry 0 | 129 → 131/171 | 34 → 36/57 | 2 | 0 | 0 → 0 | 48/48 → 48/48 |

Code 128 remained **48/57** and EAN-13 **47/57** in every profile. POS profiles enable frame analysis and restrict formats to `ean13,upca,code128,qr`. Each case makes one worker request, which may perform several internal decoding passes. The live profile uses only retry index zero; it does not run subsequent camera frames, source-resolution selection or confirmation.

The browser image and POS image gain is `qr/qr-upgrade-qr-label-2/blur-2`, with `qr-grid-deblur` diagnostics. The server gains all three `blur-2` QR images. Live retry zero gains `qr-upgrade-qr-label-1/blur-2` and `qr-upgrade-qr-label-3/blur-2`, also through `qr-grid-deblur`. These fresh payloads and outcomes were not used to tune the implementation. Full case names and before/after results are retained in [summary.json](summary.json) and the twelve profile reports.

Remaining QR misses are retained in the denominators:

| Damage condition | Browser image | Server reader | Live retry 0 |
| --- | ---: | ---: | ---: |
| Strong clipping | 3 | 3 | 3 |
| Missing patch, milder | 1 | 1 | 1 |
| Missing patch, stronger | 3 | 3 | 3 |
| Strong motion blur | 3 | 3 | 3 |
| Scratches, milder | 0 | 1 | 1 |
| Scratches, stronger | 3 | 3 | 3 |
| Smallest in frame | 2 | 2 | 3 |
| Strong defocus blur | 0 | 0 | 1 |
| Strong uneven lighting | 0 | 0 | 3 |
| **Total QR misses** | **15** | **16** | **21** |

The POS image misses match browser image. Including the unchanged linear-format misses, browser image still misses 34 positives, the server 35 and live retry zero 40. Missing finder/data pixels, motion blur and inadequate optical detail remain limits; enlarging or filtering an image cannot guarantee reconstruction of absent information.

## Raw-byte, format and multiple-label safety

Both browser and API retain **54/54 positive images and 8/8 negative images** before and after, with zero unexpected values or errors. That comprises 40 QR images, eight other-format images and six two-label scenes.

The ten QR payload groups cover printable ASCII, numeric/alphanumeric content, UTF-8 byte sequences, Latin-1 bytes, controls including NUL/group separator, high bytes, all 256 byte values, a dense URL and mixed binary content. Each group has clean, rotated, small-in-frame and mildly blurred variants; all four QR error-correction levels appear. Other-format controls cover Code 128 ASCII/control/extended bytes and EAN-13. Negative cases are blank images and finder-like marks with no encoded QR data.

Ground truth is the encoder input bytes and format. Ordinary printable ASCII also requires exact displayed text. Non-ASCII displayed text is recorded, while raw bytes remain authoritative; no byte transcoding is used to fit reader predictions. A correct result accompanied by an incorrect extra fails. This is targeted coverage, not exhaustive QR compatibility: explicit ECI, GS1 QR, structured append and UPC aliases are not covered by this fresh corpus.

The baseline already reads these compatibility images, so this preservation result alone does not prove that every value exercised new recovery. Separate development regressions force earlier native passes to miss and verify that QR grid recovery retains native bytes and presentation for binary/control/Latin-1/UTF-8 inputs.

## Camera and generation evidence, kept separate

The real-WASM [SDK tests](../../tests/scanner-sdk.test.mjs) exercise newly recovered blurred QR images through `scanImage`, and a live simulation requires two distinct simulated frames before the POS callback. Only a background corner changes between those frames; the QR pixels retain known encoder truth. They verify byte output, reuse of the successful recovery method, and no confirmation after the first exposure.

[Capture-policy tests](../../tests/capture-recovery.test.mjs) verify that a complete tiny-QR proposal can request source detail after two distinct timed misses, while repeated exposure IDs, incomplete geometry, multiple proposals and cooldowns cannot trigger that shortcut. Existing end-to-end source-resolution recovery tests use a distant EAN scene; they verify real source crops, coordinate mapping and separate-frame confirmation. These different simulations must not be combined into a claim that the new QR pipeline was tested on an actual phone camera.

SDK, standalone and worker regressions also verify that truncated searches or withheld positive evidence cannot be forgotten before accepting a different source crop. Multiple observed identities remain conflicts. The new QR generation options are tested separately in [generation tests](../../tests/test_qr_generation.py); changing error correction or quiet margins does not improve an already printed symbol. The damage benchmark does not test the generation HTTP endpoint.

The root verification run completed **604 JavaScript tests**, **431 Python tests with one platform skip**, TypeScript/OpenAPI checks and the React production build. These are functional/build checks, not additional independent accuracy examples.

## Host timing

The six before/after pairs ran sequentially with other project CPU work paused. Values cover all positive and negative requests and exclude startup, image import, HTTP, camera capture and UI confirmation. One native decoder call can exceed an outer retry-start deadline.

| Profile | Median ms before → after | p95 ms before → after |
| --- | ---: | ---: |
| Browser image, damage | 24.67 → 26.02 | 490.41 → 464.47 |
| Server reader, damage | 6.430 → 7.232 | 86.650 → 84.866 |
| Browser POS image, damage | 25.70 → 27.03 | 468.43 → 454.65 |
| Browser POS live retry 0, damage | 13.17 → 15.69 | 87.33 → 89.12 |
| Browser image, byte safety | 2.10 → 2.10 | 428.27 → 440.46 |
| Server reader, byte safety | 1.627 → 1.568 | 27.771 → 44.405 |

Additional search costs some requests more time, while earlier successful recovery shortens others. These are single-run observations on Windows 11 with Node 24.14.0 and Python 3.14.3, not statistical speed claims or Android/iPhone frame-rate measurements.

## Protocol, source identity and limits

The baseline is the complete 356-file archive of commit `1821c9324b492af5f42024a1e7efb7345e7942ac`. Both versions use the same current byte-aware scoring tools and separate complete runtimes. The final run checked all 51 frozen source/scorer hashes after each profile. No production code was tuned after fresh outcomes were inspected.

The damage corpus contains nine positive payload groups with 19 related transformations each, plus eight negative families with six variants each. Its payloads and group identifiers are disjoint from all eight prior accuracy/damage sets. It is not 171 independent camera photographs. The QR-heavy safety corpus contains fourteen payload groups plus combinations of them. Both generators use known encoder inputs, call no decoder, filter no cases by outcome, and regenerated byte for byte.

| Frozen fixture | SHA256 |
| --- | --- |
| `damage-stress-qr-upgrade.json` | `3b92f583c15b9ced1bb21bd6175dbea6a6f41bfca2f42f056c6cee00b6157749` |
| `qr-byte-safety.json` | `abfba6371019bb16938817f8eff9c0add43bb7701f67757bd4fcb49c254f0c9a` |

A specification-driven safety-fixture revision replaced one leading-zero EAN-13 with an unambiguous nonzero prefix because its bars otherwise admit UPC-A representation. Initial baseline aggregates had already been observed (54/54 positives and 8/8 negatives); no per-case or updated-algorithm outcomes had been inspected. This was not prompted by a failing case. Both baseline safety profiles were rerun. The [revision record](../../tools/baselines/qr-upgrade/fixture-revision.json) preserves the initial/final hashes and reason, and is embedded in the summary.

Key frozen implementation hashes:

| File | SHA256 |
| --- | --- |
| `web/scanner-worker.js` | `52742b04038dc737c6e18febc132d4f46025cad7122345eb48070cd8e379bbba` |
| `web/qr-geometry.js` | `d62bc0b1288c418e804a269c708fc3be65f2f47621847b7631108e6e9692f1a6` |
| `web/qr-recovery.js` | `02fe70bb3354932c42e59b9ad15aea95382ddbde349e65bc1a9acde3c2887a01` |
| `barcode_reader.py` | `397783cd87730f3e8cae2bec46019206c2f650e70816ca321da1dcd8e551d71c` |
| `qr_recovery.py` | `b76ac26f4e0be378bdb32559e8c5ac47c2f2813b85e4f1a392c3a5c9fdd3b9b1` |

[summary.json](summary.json) includes the complete baseline manifest, all frozen helper/capture/scorer hashes, paired gains/losses, exit codes and host/dependency metadata. Browser reports record loaded JS/WASM hashes; API reports record loaded source and native-library hashes. All twelve commands exited zero, which means no unexpected output or runtime error; unread positives still count as failures.

No dependencies were added for QR recovery. Both Python runtimes used ZXing-C++ 3.1.1, Pillow 12.3.0 and pyzbar 0.1.9 with the same Windows ZBar 0.10 DLL. The existing browser ZBar wrapper 0.11.0/core 0.23.90 remains the independent Code 128/EAN path. Linux Docker and real Android/iPhone hardware were not run in this evaluation.

See the [reproduction protocol](../../tools/baselines/qr-upgrade/README.md) and [implementation notes](../../QR-UPDATE.md). Files prefixed `development-` in this directory report earlier corpora and CI checks separately; they are not fresh validation. This newly published corpus likewise becomes development evidence if future algorithms are tuned on its failures.
