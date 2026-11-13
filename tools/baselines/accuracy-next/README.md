# Baseline for the 13 November recognition update

These are unchanged source files from commit `e6aa266f70fd25cc8e300d8a61703a79b16af6e4`, exported before recognition changes. They intentionally retain the earlier behavior. They are benchmark inputs, not application assets.

The native decoder packages, browser JavaScript/WebAssembly vendor files, frame-analysis helper and POS policy are unchanged by this update. Their hashes are recorded in `benchmark-results/accuracy-next/summary.json`.

To compare the earlier reader against the frozen fresh fixture, run from the repository with its dependencies installed:

```powershell
node tools/benchmark-accuracy.mjs --worker tools/baselines/accuracy-next/scanner-worker.js --corpus tests/fixtures/damage-stress-accuracy-next.json --output data/local/accuracy-browser-before.json
python tools/benchmark-damage-api.py --reader tools/baselines/accuracy-next/barcode_reader.py --corpus tests/fixtures/damage-stress-accuracy-next.json --output data/local/accuracy-api-before.json
```

Create `data/local` first. Unexpected readings deliberately produce a nonzero exit code. See `ACCURACY-UPDATE.md` for the exact results and limitations.
