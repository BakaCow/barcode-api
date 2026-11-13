# Baseline for camera recovery and retail corroboration

The baseline is commit `aeef1929790bbc3febcd65147388fbde1f78d288`, frozen before this update. Use a detached checkout of that commit so its worker, frame analysis, POS policy, benchmark harness and native assets stay together. The Python reader also requires the installed `Pillow` and `zxing-cpp` versions recorded in each benchmark report.

The browser benchmark's `--worker` option replaces only the worker. Its imports still come from the current `web` directory. **Do not use that substitution alone to benchmark an enhanced baseline**, because this update changes `frame-analysis.js`.

Run from the current repository with Node and Python dependencies installed. The fixture and output paths point into the current repository even when running the baseline harness:

```powershell
$currentRepository = (Get-Location).Path
$baselineRepository = Join-Path (Split-Path $currentRepository -Parent) 'barcode-recovery-baseline'
$freshFixture = Join-Path $currentRepository 'tests/fixtures/damage-stress-recovery.json'
$plainBeforeReport = Join-Path $currentRepository 'data/local/recovery-browser-before.json'
$apiBeforeReport = Join-Path $currentRepository 'data/local/recovery-api-before.json'
$beforeReport = Join-Path $currentRepository 'data/local/recovery-enhanced-before.json'
New-Item -ItemType Directory -Path data/local -Force | Out-Null
git worktree add --detach $baselineRepository aeef1929790bbc3febcd65147388fbde1f78d288
if ($LASTEXITCODE -ne 0) { throw 'Could not create the baseline checkout.' }
Push-Location $baselineRepository
try {
    node tools/benchmark-accuracy.mjs --corpus $freshFixture --output $plainBeforeReport
    python tools/benchmark-damage-api.py --corpus $freshFixture --output $apiBeforeReport
    node tools/benchmark-accuracy.mjs --corpus $freshFixture --mode live --enhance-live --pos-formats ean13,upca,code128,qr --output $beforeReport
} finally {
    Pop-Location
}
node tools/benchmark-accuracy.mjs --corpus $freshFixture --output data/local/recovery-browser-after.json
python tools/benchmark-damage-api.py --corpus $freshFixture --output data/local/recovery-api-after.json
node tools/benchmark-accuracy.mjs --corpus $freshFixture --mode live --enhance-live --pos-formats ean13,upca,code128,qr --output data/local/recovery-enhanced-after.json
```

Use an unused worktree directory, or reuse a previously created baseline checkout after verifying its commit. Reports may return a nonzero exit code for unexpected reads; that is an evaluation result, not a reason to omit the case. Keep the corpus hash identical in paired reports.

These are fixed-pixel decoding measurements. They exclude camera capture, automatic capture recovery, frame selection, POS confirmation and physical Android/iPhone hardware. Former verification fixtures used while developing this update are regression data; only the separately frozen recovery fixture provides new evaluation evidence.
