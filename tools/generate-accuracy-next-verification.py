"""Freeze independent synthetic verification for the next recognition update.

This uses the existing damage generator unchanged, with a new seed and payload
prefix. No decoder is called and no outcome filtering selects the cases. The
older dev/eval/verify splits are development evidence for this update.
"""

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SEED = 134973017
SPLIT = "next"
GENERATOR = Path(__file__).with_name("generate-damage-stress.py")
BASELINE_COMMIT = "e6aa266f70fd25cc8e300d8a61703a79b16af6e4"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def identities(document):
    return ({case.get("groupId", case["name"]) for case in document["cases"]},
            {expected["text"] for case in document["cases"] for expected in case["expected"]})


def generate(output):
    specification = importlib.util.spec_from_file_location("damage_stress_generator", GENERATOR)
    generator = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(generator)
    generator.SEEDS[SPLIT] = SEED
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".accuracy-next-", dir=output.parent) as temporary:
        temporary_path = Path(temporary).resolve()
        if temporary_path.parent != output.parent or not temporary_path.name.startswith(".accuracy-next-"):
            raise ValueError("Temporary output escaped the fixture directory")
        with contextlib.redirect_stdout(io.StringIO()):
            document = generator.generate(SPLIT, temporary_path / "generated.json")

    groups, payloads = identities(document)
    assert len(document["cases"]) == 219
    assert sum(bool(case["expected"]) for case in document["cases"]) == 171
    assert sum(not case["expected"] for case in document["cases"]) == 48
    assert len(groups) == 57 and len(payloads) == 9
    prior_hashes = {}
    prior_files = ("accuracy-pixels.json", "accuracy-holdout.json",
                   "damage-stress-dev.json", "damage-stress-eval.json", "damage-stress-verify.json")
    for name in prior_files:
        previous_bytes = (ROOT / "tests/fixtures" / name).read_bytes()
        previous_groups, previous_payloads = identities(json.loads(previous_bytes))
        if groups & previous_groups or payloads & previous_payloads:
            raise ValueError(f"Fresh groups or expected payloads overlap {name}")
        prior_hashes[name] = sha256(previous_bytes)

    source = Path(__file__).read_text(encoding="utf-8").replace("\r\n", "\n")
    document["provenance"]["verificationWrapper"] = {
        "generator": "tools/generate-accuracy-next-verification.py",
        "sha256": sha256(source.encode("utf-8")),
        "hashMethod": "SHA256 of UTF-8 source with CRLF normalized to LF",
        "baselineCommit": BASELINE_COMMIT,
        "seed": SEED,
        "split": SPLIT,
        "method": "Unchanged damage-stress generate() with SEEDS['next'] assigned; no decoder calls or outcome filtering.",
        "reason": "Fresh groups for recognition update after all earlier sets, including verify, became development evidence.",
        "earlierCorpusSha256": prior_hashes,
    }
    document["provenance"]["evaluationPolicy"] = (
        "Frozen before implementation choices. Independent evaluator may run the frozen baseline, "
        "but per-case decoder outcomes remain withheld from implementation until algorithms are frozen. "
        "Prior dev/eval/verify are development evidence; no tuning on this fresh split.")
    document["provenance"]["grouping"] = (
        "All 19 transformations of each of 9 positive payloads stay in this split; "
        "positive payloads and group identifiers are disjoint from all five earlier accuracy/damage sets. "
        "The 219 images are not 219 independent camera photographs.")
    encoded = (json.dumps(document, separators=(",", ":")) + "\n").encode("utf-8")
    if output.exists() and output.read_bytes() != encoded:
        raise ValueError(f"Refusing to overwrite changed frozen fixture: {output}")
    if not output.exists():
        output.write_bytes(encoded)
    print(json.dumps({"split": SPLIT, "seed": SEED, "cases": 219, "positives": 171,
                      "negatives": 48, "bytes": len(encoded), "sha256": sha256(encoded),
                      "output": str(output)}))
    return document


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path,
                        default=ROOT / "tests/fixtures/damage-stress-accuracy-next.json")
    generate(parser.parse_args().output)
