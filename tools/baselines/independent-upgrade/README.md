# Baseline for independent-decoder evaluation

The baseline is commit `a86a7d14f58eadc409ba0e8bd72d23442aba0cfa`. Keep its complete runtime together: old workers must not import current helpers or decoder assets.

This update adds optional raw-byte ground truth to the benchmark tools. Both sides must use the **same current scorer**, while selecting separate complete runtimes. Code 128 safety cases require exact input bytes and format. Ordinary printable ASCII also requires exact text; HRI presentation for control bytes, GS1 and extended bytes is recorded without replacing their raw-byte truth.

From the current repository with Node and the Python environment active:

```powershell
$baselineRepository = Join-Path (Split-Path (Get-Location).Path -Parent) 'barcode-independent-baseline'
git worktree add --detach $baselineRepository a86a7d14f58eadc409ba0e8bd72d23442aba0cfa
if ($LASTEXITCODE -ne 0) { throw 'Could not create the baseline checkout.' }
New-Item -ItemType Directory -Force data/local | Out-Null

node tools/benchmark-accuracy.mjs --runtime-root $baselineRepository --corpus tests/fixtures/damage-stress-independent.json --output data/local/independent-browser-before.json
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/damage-stress-independent.json --output data/local/independent-browser-after.json
python tools/benchmark-damage-api.py --reader (Join-Path $baselineRepository 'barcode_reader.py') --corpus tests/fixtures/damage-stress-independent.json --output data/local/independent-api-before.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/damage-stress-independent.json --output data/local/independent-api-after.json

node tools/benchmark-accuracy.mjs --runtime-root $baselineRepository --corpus tests/fixtures/independent-code128-safety.json --output data/local/independent-semantics-browser-before.json
node tools/benchmark-accuracy.mjs --corpus tests/fixtures/independent-code128-safety.json --output data/local/independent-semantics-browser-after.json
python tools/benchmark-damage-api.py --reader (Join-Path $baselineRepository 'barcode_reader.py') --corpus tests/fixtures/independent-code128-safety.json --output data/local/independent-semantics-api-before.json
python tools/benchmark-damage-api.py --corpus tests/fixtures/independent-code128-safety.json --output data/local/independent-semantics-api-after.json
```

For the POS image profile, add `--enhance-live --pos-formats ean13,upca,code128,qr` to each browser damage command. For one live worker request at retry index zero, also add `--mode live`. This does not run camera acquisition, a full retry cycle, adaptive capture or frame confirmation.

The frozen fixtures are:

| Fixture | SHA256 |
| --- | --- |
| `damage-stress-independent.json` | `bcbd1fe36eaba6f237be6ae2e4392fe5ba38624337e920312d3b4a314e60cc65` |
| `independent-code128-safety.json` | `23ad79f4bd98300cac4c886aac08e527abc013e07b6fc016562d661b99769a04` |

Their generators make no decoding calls or outcome-based selections and refuse to overwrite changed fixtures. The damage corpus has 171 related positive transformations and 48 negatives. The semantic corpus has 12 payload groups, 48 single-label variants, four two-label scenes and eight negatives. Neither contains real camera photographs. All previous fixtures are development data for this update.

Keep nonzero benchmark exits when wrong values or runtime errors occur. Matching an expected value together with a wrong extra remains a failure. Run paired timings sequentially on an otherwise quiet host; neither those timings nor the synthetic recognition scores measure real Android/iPhone performance.
