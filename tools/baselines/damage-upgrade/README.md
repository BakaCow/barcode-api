# Baseline protocol for the damaged-symbol update

The complete baseline is commit `ddfacf0d8465ca5020a5efe13b5ca79cf62d9980`.
Both sides use the same current byte-aware scoring tools and isolated full
runtimes. Never combine a previous worker with new helpers or WASM assets.

From the current repository, with Node and the Python environment active:

```powershell
$damageBaselineRepository = Join-Path (Split-Path (Get-Location).Path -Parent) 'barcode-damage-baseline'
git worktree add --detach $damageBaselineRepository ddfacf0d8465ca5020a5efe13b5ca79cf62d9980
if ($LASTEXITCODE -ne 0) { throw 'Could not create the baseline checkout.' }
New-Item -ItemType Directory -Force data/local | Out-Null

node tools/benchmark-accuracy.mjs --runtime-root $damageBaselineRepository --corpus tests/fixtures/damage-stress-damage-upgrade.json --output data/local/damage-browser-before.json
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-stress-damage-upgrade.json --output data/local/damage-browser-after.json
python tools/benchmark-damage-api.py --reader (Join-Path $damageBaselineRepository 'barcode_reader.py') --corpus tests/fixtures/damage-stress-damage-upgrade.json --output data/local/damage-api-before.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/damage-stress-damage-upgrade.json --output data/local/damage-api-after.json

node tools/benchmark-accuracy.mjs --runtime-root $damageBaselineRepository --corpus tests/fixtures/damage-byte-safety.json --output data/local/damage-semantics-browser-before.json
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-byte-safety.json --output data/local/damage-semantics-browser-after.json
python tools/benchmark-damage-api.py --reader (Join-Path $damageBaselineRepository 'barcode_reader.py') --corpus tests/fixtures/damage-byte-safety.json --output data/local/damage-semantics-api-before.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/damage-byte-safety.json --output data/local/damage-semantics-api-after.json
```

For each POS image profile add
`--enhance-live --pos-formats ean13,upca,code128,qr` to the browser damage command.
For live retry zero also add `--mode live`. Each command makes one worker request
per fixed image; internal retries are permitted. These are not camera sessions,
frame-selection/fusion tests or confirmation across separate exposures.

| Fixture | Seed | SHA256 |
| --- | ---: | --- |
| `damage-stress-damage-upgrade.json` | 871204639 | `a7e43033813ed77a3f67da2b50c45e360717ae71f6001e43d752a7d85aa83cb0` |
| `damage-byte-safety.json` | 605713298 | `e2064cbb97701594ef9c138250302802cc74a99f75a7539de7ddcd6e03ac2fcf` |

The damage corpus has 171 positive transformations of nine payload groups and
48 negative controls. Positive payloads and group identifiers are disjoint from
all ten earlier accuracy/damage corpora, including the source-signal update. The damage
generator and its transformation families are unchanged. The 171 positives
are not independent phone photographs.

The byte/multiple-label corpus has 40 QR images from ten fresh payload groups,
eight other-format images from four fresh groups, six combinations containing
two labels, and eight unencoded negative controls. The negative control families
remain blank images and finder-only marks, as in the prior safety corpus; they
are not new independent damage examples. QR coverage includes raw binary,
controls, UTF-8 byte sequences, Latin-1 bytes and all four error-correction levels.
There is no explicit ECI, GS1 QR, structured-append or UPC-alias coverage. Input
bytes and format are authoritative; ordinary printable ASCII additionally
requires exact displayed text.

Both generators call no decoder, filter no images by decoder outcome and reject
overwriting a changed frozen fixture. Generator/source hashes and byte-identical
regeneration are recorded in [fixture-freeze.json](fixture-freeze.json). The byte fixture case identifiers were renamed before any evaluation; pixels
and truth were unchanged. No fixture was changed in response to decoder results. All previous fixture sets
are development evidence for this update. Fresh per-case outcomes remain hidden
from implementation until production is frozen, and no current decoder is run
on these fixtures before that freeze. After publication, tuning on these cases
requires a new unseen evaluation split.

A correct value accompanied by a wrong extra fails. Preserve nonzero command
exits for unexpected values or runtime errors. A zero exit allows unread
positives and does not imply a perfect read rate. Report per-format gains and
lost exact cases, negative rejections, raw-byte identity, loaded runtime/source
hashes and native dependency versions. Run before/after pairs sequentially with
other project benchmarks paused. Host timings exclude startup, HTTP, camera and
UI confirmation and must not be presented as Android/iPhone speed.
