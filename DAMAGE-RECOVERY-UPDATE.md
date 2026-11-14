# Damaged barcode recovery

This update adds three conservative recovery paths and preserves original
pixels around automatically detected source crops. It improves selected
damaged images; it cannot restore information absent from every exposure.

## Uploaded images and browser decoding

QR recovery uses measured cell uncertainty and oversized bright patches to
identify possible erasures in versions 1–10. It solves QR error-correction
constraints while retaining confident source bits, reserves at least four
parity bytes as independent constraints, and verifies all parity equations.
The bundled native decoder checks the reconstructed symbol and supplies the
canonical text and raw bytes. Decoding this derived image is not a second
independent observation. Missing finder patterns and damage beyond the
available redundancy can still prevent a read.

Linear recovery combines surviving bar/space sections from different rows
inside one measured barcode band. It requires sufficient original resolution,
real quiet margins, and support from at least three unmasked rows at every
claimed column. It handles selected staggered patches and scratches; it does
not invent full-height missing bars. Complete neighboring symbols and
conflicting evidence remain separate.

A source-supported EAN-13 that contradicts a lone native UPC-E reading now
causes unrestricted decoding to abstain. It does not replace the native value
with a guess. An explicit EAN-only POS allowlist can recover the EAN reading.
The normal allowed-format, ambiguity, deadline and exact-byte checks still
apply to all recovery paths.

## Live camera recovery

After ordinary decoding misses, the SDK and camera app can register three
different recent exposures and take an observed-pixel median. This narrowly
supports moving bright flat occlusions or glare, with measured module pitch,
one complete candidate region and small translations. Changed pixels must be
explained by damage masks detected separately in the original exposures.
Every output pixel needs agreement from two unmasked exposures. Arbitrary
motion, rotating labels, permanent holes and changing labels are rejected.

One combined burst counts as one observation. Acceptance requires at least
two disjoint agreeing bursts, even when ordinary scanning uses one matching
frame; selecting three matching frames requires three bursts. Normal and
combined observations do not share confirmation votes. Reused frame IDs,
reused pixels, stale oldest captures, conflicts and unfinished searches cannot
satisfy confirmation. Capture buffers are bounded; fusion stops collecting
after 256 eligible unique exposures until a reset. Ordinary decoding continues.

SDK fusion follows `automaticRecovery`; app fusion follows the detected-area
retry setting. Only supported QR/EAN-13/Code 128 formats enter fusion. This is
local camera processing, not a server endpoint for uploading video bursts.
Existing camera/settings/control resets revoke pending source captures.

Automatic detail crops now include a small real margin from their original
snapshot. Explicit user-selected targets remain exact. Enlarging a crop cannot
recover pixels already missing from the camera frame or uploaded file.

## Deployment and evidence

Keep the complete `web/` runtime together. New browser files are
`qr-damage.js` and `frame-fusion.js`; the server also needs `qr_damage.py`.
Docker and the React asset copier include the relevant files. Offline cache
1.13.0 requires the new browser modules before reporting readiness.

Recognition results, remaining misses and before/after runtime hashes are in
the [paired evaluation](benchmark-results/damage-upgrade/README.md).
[TESTING.md](TESTING.md) records software validation. Camera sequence tests use
synthetic separate exposures and real bundled WASM decoding, including a
sequence whose three individual images all fail the complete image worker but
whose combined observed pixels decode. They are not actual Android/iPhone
measurements or a Scanbot accuracy comparison.
