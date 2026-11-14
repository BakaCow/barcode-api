# Motion blur and tiny-code recovery

This update adds source-signal recovery to the existing browser worker and
Python image reader. The camera app, embedded scanner, SDK image import and
server upload endpoints use the production paths; no test-server-only decoder
or fixture lookup is involved. Deploy the complete updated project, or the
complete `web/` tree for browser-only hosting. No integration API changes are
required. Apply offline cache update **1.12.0** to replace older assets.

## What changed

Original and earlier recovery reads keep their path. The new bounded helpers
examine the original captured grayscale values after those attempts fail. The
browser tries the signal batch before its costly full-image enlargement, so
that enlargement cannot consume the entire budget before signal recovery:

- **Motion blur:** invert short, uniform horizontal or vertical exposure models
  where eligible, then check the reconstructed symbol against the original
  pixels. Linear symbols require complete bar structure, source margins,
  checksum validation and agreement from multiple image rows. QR recovery
  requires measured finder geometry and a forward-model residual check.
- **Tiny linear codes:** fit EAN-13 and supported Code 128 bar patterns at
  fractional pixel positions using pixel-area and windowed-sinc sampling
  models. A valid payload must explain the complete observed source pattern;
  enlarging an image alone does not supply missing optical detail.
- **Tiny QR codes:** estimate the grid from measured finder/timing structure,
  model square-cell sampling and recover cell intensities from the captured
  grayscale samples. Native QR error correction validates derived candidates.
- **Ambiguity:** retain competing identities and separate physical labels.
  Incomplete planned searches cannot publish a unique reading. Native format
  restrictions, exact bytes and source-coordinate validation still apply.

The code never reads benchmark labels or expected payloads. Native decoding of
a reconstructed candidate preserves canonical text/bytes; it is not an
independent second observation of the original symbol. Multiple derived images
from one exposure still count as one frame for POS confirmation.

## Scope and limits

These models are deliberately bounded. The strongest synthetic improvements
come from images consistent with the tested exposure and sampling models.
Arbitrary camera shake, changing blur within one label, perspective, clutter,
glare, severe clipping and information lost below the camera's sampling limit
can still require a clearer capture. No method can guarantee every damaged
barcode is readable. This release does not add multi-frame fusion or a
proprietary replacement for every native decoder.

The added linear recovery targets EAN-13 and a guarded subset of Code 128;
other supported formats retain their existing decoding paths. QR uses its own
reconstruction pipeline. Pixel, proposal and time limits restrict work, and
partial evidence is withheld. Actual phone camera performance must be measured
on physical devices; desktop synthetic tests do not establish Scanbot parity.

## Verification

On the existing 171-image QR-update development set:

| Profile | Before | After | Motion-blur images | Tiny-code images |
| --- | ---: | ---: | ---: | ---: |
| Browser image decoder | 137/171 | 154/171 | 18/18 | 18/18 |
| Server image decoder | 136/171 | 153/171 | 18/18 | 18/18 |

Both profiles reject all 48 negatives with no incorrect readings. The severe
subset is 9/9 motion plus 9/9 tiny; those 18 are included in the 36-condition
total, not extra examples. These development images were used while building
the algorithms. The overall score still includes unread images with other
damage, including clipping, missing sections, scratches and defocus blur.

On the separate fresh set, browser/API image decoding reads **18/18 motion**
and **17/18 tiny** images; one new tiny QR remains unread. The browser POS image
profile has the same targeted counts. The first live retry reads 18/18 motion
and 14/18 tiny on that set; this is a still-image worker profile, not a phone
camera session. No exact case regressed in any of the six evaluation profiles.
One pre-existing false UPC-E output on a damaged EAN-13 remains in unrestricted
browser/API reading. The tested EAN-13/UPC-A/Code-128/QR POS allowlist excludes
that output; all tested POS profiles have zero incorrect values.

Recognition results, paired baselines and reproducible commands are recorded
in [the evaluation report](benchmark-results/signal-upgrade/README.md).
[TESTING.md](TESTING.md) records software checks separately from recognition
scores. Existing images used while developing these methods are explicitly
development evidence; a separate frozen corpus evaluates new payloads.

The added SDK/API regressions pass actual image pixels through the shipped
worker/native reader and production upload/POS endpoints. Tests cover exact
values and bytes, rejected negatives, incomplete evidence, allowed formats,
competing labels, source coordinates and duplicate-frame confirmation.
