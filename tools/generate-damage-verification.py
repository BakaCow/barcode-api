"""Create a fresh, frozen synthetic verification split without decoding it.

Uses the unchanged damage-stress generator and a new seed/payload group prefix.
The earlier evaluation set became debugging data after its failures informed
fixes. Keep this verification set's decoding results unopened until fixes freeze.
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
SEED = 86214377
GENERATOR = Path(__file__).with_name("generate-damage-stress.py")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def identity_sets(document):
    return ({case["groupId"] for case in document["cases"]},
            {expected["text"] for case in document["cases"] for expected in case["expected"]})


def generate(output):
    specification = importlib.util.spec_from_file_location("damage_stress_generator", GENERATOR)
    generator = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(generator)
    generator.SEEDS["verify"] = SEED
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    # Build through the original entry point. Its temporary output is removed
    # before the wrapper writes the completed provenance to the final path.
    with tempfile.TemporaryDirectory(prefix=".damage-verify-", dir=output.parent) as temporary:
        temporary_path = Path(temporary).resolve()
        if temporary_path.parent != output.parent or not temporary_path.name.startswith(".damage-verify-"):
            raise ValueError("Temporary directory escaped the intended fixture directory")
        with contextlib.redirect_stdout(io.StringIO()):
            document = generator.generate("verify", temporary_path / "damage-stress-verify.json")

    groups, payloads = identity_sets(document)
    assert len(document["cases"]) == 219
    assert sum(bool(case["expected"]) for case in document["cases"]) == 171
    assert sum(not case["expected"] for case in document["cases"]) == 48
    assert len(groups) == 57 and len(payloads) == 9
    prior_hashes = {}
    for split in ("dev", "eval"):
        previous_path = ROOT / "tests/fixtures" / f"damage-stress-{split}.json"
        previous_bytes = previous_path.read_bytes()
        previous = json.loads(previous_bytes)
        previous_groups, previous_payloads = identity_sets(previous)
        if groups & previous_groups or payloads & previous_payloads:
            raise ValueError(f"Verification groups or expected payloads overlap {split}")
        prior_hashes[previous_path.name] = sha256(previous_bytes)

    source = Path(__file__).read_text(encoding="utf-8").replace("\r\n", "\n")
    document["provenance"]["verificationWrapper"] = {
        "generator": "tools/generate-damage-verification.py",
        "sha256": sha256(source.encode("utf-8")),
        "hashMethod": "SHA256 of UTF-8 source with CRLF normalized to LF",
        "seed": SEED,
        "method": "Unchanged damage-stress generate() with SEEDS['verify'] assigned; no decoder calls or outcome filtering.",
        "reason": "Fresh verification groups after earlier evaluation failures informed debugging.",
        "earlierCorpusSha256": prior_hashes,
    }
    document["provenance"]["evaluationPolicy"] = "Frozen verification split. Do not inspect decoding results until algorithm fixes are frozen. Earlier eval is now debugging data."
    encoded = (json.dumps(document, separators=(",", ":")) + "\n").encode("utf-8")
    if output.exists() and output.read_bytes() != encoded:
        raise ValueError(f"Refusing to overwrite changed frozen verification fixture: {output}")
    if not output.exists():
        output.write_bytes(encoded)
    print(json.dumps({"split": "verify", "seed": SEED, "cases": len(document["cases"]),
                      "positives": 171, "negatives": 48, "bytes": len(encoded),
                      "sha256": sha256(encoded), "output": str(output)}))
    return document


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "tests/fixtures/damage-stress-verify.json")
    generate(parser.parse_args().output)
