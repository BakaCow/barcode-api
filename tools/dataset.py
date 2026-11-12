"""Local, human-labelled Code 128 datasets. Never derives truth from a decoder."""

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import zlib

from PIL import Image, ImageOps


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_VIDEO_BYTES = 256 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_EXPORT_BYTES = 64 * 1024 * 1024
IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
SPLITS = {"train", "dev", "test"}


class DatasetError(ValueError):
    pass


def safe_path(root, relative):
    """Reject traversal, alternate separators, drive letters and escaping links."""
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative or "\0" in relative:
        raise DatasetError("Media paths must be normalized relative paths using '/'.")
    path = PurePosixPath(relative)
    if path.is_absolute() or any(part in {"..", "."} for part in path.parts) or path.as_posix() != relative:
        raise DatasetError("Media paths must stay inside the dataset folder.")
    root = Path(root).resolve()
    result = (root / path).resolve()
    if not result.is_relative_to(root) or result == root:
        raise DatasetError("Media path escapes the dataset folder.")
    return result


def validate_manifest(manifest, root, require_files=True):
    if not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1 or not isinstance(manifest.get("entries"), list):
        raise DatasetError("Expected a version 1 manifest with an entries array.")
    if len(manifest["entries"]) > 5000:
        raise DatasetError("A dataset is limited to 5,000 entries.")
    ids, paths, groups = set(), set(), {}
    for entry in manifest["entries"]:
        if not isinstance(entry, dict):
            raise DatasetError("Each dataset entry must be an object.")
        identifier, group = entry.get("id"), entry.get("groupId")
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier):
            raise DatasetError("Each id needs 1–128 letters, digits, underscores or hyphens.")
        if identifier in ids:
            raise DatasetError(f"Duplicate id: {identifier}")
        ids.add(identifier)
        if not isinstance(group, str) or not IDENTIFIER.fullmatch(group):
            raise DatasetError(f"{identifier}: a physical-label/session groupId is required.")
        split = entry.get("split")
        if split not in SPLITS:
            raise DatasetError(f"{identifier}: split must be train, dev or test.")
        if group in groups and groups[group] != split:
            raise DatasetError(f"Group {group} appears in multiple splits. Keep one physical label/session together.")
        groups[group] = split
        path = safe_path(root, entry.get("path"))
        # Windows is case insensitive; reject aliases on all platforms for portability.
        if entry["path"].casefold() in paths:
            raise DatasetError(f"Duplicate media path: {entry['path']}")
        paths.add(entry["path"].casefold())
        if entry.get("mediaType") not in {"image", "video"}:
            raise DatasetError(f"{identifier}: mediaType must be image or video.")
        if entry.get("source") not in {"real", "synthetic"}:
            raise DatasetError(f"{identifier}: source must be explicitly real or synthetic.")
        if not isinstance(entry.get("device"), str) or not entry["device"].strip() or len(entry["device"]) > 256:
            raise DatasetError(f"{identifier}: device description is required (maximum 256 characters).")
        conditions = entry.get("conditions")
        if not isinstance(conditions, list) or len(conditions) > 20 or any(not isinstance(c, str) or not c or len(c) > 64 for c in conditions):
            raise DatasetError(f"{identifier}: conditions must be an array of short labels.")
        expected = entry.get("expected")
        if not isinstance(expected, list) or len(expected) > 12:
            raise DatasetError(f"{identifier}: supply expected values, or [] for an explicitly negative image.")
        truths = set()
        for truth in expected:
            if not isinstance(truth, dict) or truth.get("format") != "Code128" or not isinstance(truth.get("text"), str) or not 1 <= len(truth["text"]) <= 4096:
                raise DatasetError(f"{identifier}: each expected value needs format Code128 and nonempty text.")
            if truth["text"] in truths:
                raise DatasetError(f"{identifier}: duplicate expected value.")
            truths.add(truth["text"])
        if "negative" in entry and (type(entry["negative"]) is not bool or entry["negative"] != (not expected)):
            raise DatasetError(f"{identifier}: negative must agree with the expected array.")
        if "reviewRequired" in entry and type(entry["reviewRequired"]) is not bool:
            raise DatasetError(f"{identifier}: reviewRequired must be a boolean.")
        if len(json.dumps(entry, ensure_ascii=False)) > 32_768:
            raise DatasetError(f"{identifier}: metadata is too large.")
        if require_files:
            if not path.is_file():
                raise DatasetError(f"Missing media: {entry['path']}")
            validate_media(path, entry["mediaType"])
    return manifest


def validate_media(path, media_type):
    limit = MAX_IMAGE_BYTES if media_type == "image" else MAX_VIDEO_BYTES
    if not 0 < path.stat().st_size <= limit:
        raise DatasetError(f"{path.name}: file is empty or exceeds the {limit // (1024 * 1024)} MiB limit.")
    if media_type == "image":
        try:
            with Image.open(path) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"} or getattr(image, "n_frames", 1) != 1:
                    raise DatasetError(f"{path.name}: use a single PNG, JPEG or WebP image.")
                if image.width * image.height > MAX_IMAGE_PIXELS:
                    raise DatasetError(f"{path.name}: image exceeds 20 megapixels.")
                image.verify()
        except DatasetError:
            raise
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            raise DatasetError(f"{path.name}: invalid image.") from error
    elif path.suffix.lower() not in {".mp4", ".webm", ".mov", ".avi", ".mkv"}:
        raise DatasetError(f"{path.name}: unsupported video extension.")


def read_json(path):
    path = Path(path)
    if path.stat().st_size > 4 * 1024 * 1024:
        raise DatasetError("Metadata JSON exceeds 4 MiB.")
    try:
        def invalid_constant(value):
            raise ValueError(f"Non-finite JSON value: {value}")
        return json.loads(path.read_text(encoding="utf-8-sig"), parse_constant=invalid_constant)
    except (UnicodeError, ValueError) as error:
        raise DatasetError(f"Invalid JSON: {path}") from error


def load(root, require_files=True):
    return validate_manifest(read_json(Path(root) / "manifest.json"), root, require_files)


def save(root, manifest):
    root = Path(root)
    validate_manifest(manifest, root)
    temporary = root / "manifest.json.tmp"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(root / "manifest.json")


def initialize(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    if (root / "manifest.json").exists():
        raise DatasetError("A manifest already exists here; it was not overwritten.")
    (root / "media").mkdir(exist_ok=True)
    # Real photos and labels stay local unless the user deliberately changes this.
    (root / ".gitignore").write_text("*\n", encoding="utf-8")
    save(root, {"version": 1, "entries": []})


def import_metadata(root, metadata, media_dir):
    current = load(root)
    if not isinstance(metadata, dict) or type(metadata.get("version")) is not int or metadata["version"] != 1:
        raise DatasetError("Capture metadata needs version 1.")
    incoming = metadata if "entries" in metadata else {"version": 1, "entries": [{k: v for k, v in metadata.items() if k != "version"}]}
    validate_manifest(incoming, media_dir)
    prepared, copies = [], []
    for entry in incoming["entries"]:
        source = safe_path(media_dir, entry["path"])
        relative = f"media/{entry['id']}{source.suffix.lower()}"
        destination = safe_path(root, relative)
        if destination.exists():
            raise DatasetError(f"Media already exists: {relative}; choose a unique sample id.")
        prepared.append({**entry, "path": relative})
        copies.append((source, destination))
    combined = {**current, "entries": [*current["entries"], *prepared]}
    validate_manifest(combined, root, require_files=False)
    copied = []
    try:
        for source, destination in copies:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source.open("rb") as reader, destination.open("xb") as writer:
                copied.append(destination)
                shutil.copyfileobj(reader, writer)
        save(root, combined)
    except Exception:
        for destination in copied:
            destination.unlink(missing_ok=True)
        raise
    return len(prepared)


def split_groups(manifest, seed="code128-v1"):
    """Reassign development/training groups; existing test groups remain frozen."""
    assignments = {entry["groupId"]: "test" for entry in manifest["entries"] if entry["split"] == "test"}
    for entry in manifest["entries"]:
        group = entry["groupId"]
        if group not in assignments:
            value = int(hashlib.sha256(f"{seed}:{group}".encode()).hexdigest()[:16], 16) / 2**64
            assignments[group] = "train" if value < 0.7 else "dev" if value < 0.85 else "test"
    return {**manifest, "entries": [{**entry, "split": assignments[entry["groupId"]]} for entry in manifest["entries"]]}


def review_entry(root, identifier, expected):
    manifest = load(root)
    matches = [entry for entry in manifest["entries"] if entry["id"] == identifier]
    if len(matches) != 1:
        raise DatasetError(f"Unknown entry: {identifier}")
    matches[0].update(expected=expected, negative=not expected, reviewRequired=False)
    save(root, manifest)


def extract_video(root, identifier, interval=0.5, max_frames=120, cv2_module=None):
    if not math.isfinite(interval) or interval < 0.1 or not 1 <= max_frames <= 500:
        raise DatasetError("Use interval >=0.1 seconds and 1–500 frames.")
    manifest = load(root)
    matches = [entry for entry in manifest["entries"] if entry["id"] == identifier and entry["mediaType"] == "video"]
    if len(matches) != 1:
        raise DatasetError(f"Unknown video entry: {identifier}")
    entry = matches[0]
    if cv2_module is None:
        try:
            import cv2 as cv2_module
        except ImportError as error:
            raise DatasetError("Video extraction needs: python -m pip install -r requirements-research.txt") from error
    capture = cv2_module.VideoCapture(str(safe_path(root, entry["path"])))
    created, added = [], []
    try:
        if not capture.isOpened():
            raise DatasetError("OpenCV could not open this video; try an MP4 export supported by your installed codecs.")
        for index in range(max_frames):
            timestamp = index * interval * 1000
            capture.set(cv2_module.CAP_PROP_POS_MSEC, timestamp)
            ok, frame = capture.read()
            if not ok:
                break
            height, width = frame.shape[:2]
            if width * height > MAX_IMAGE_PIXELS:
                raise DatasetError("Video frame exceeds 20 megapixels.")
            frame_id = f"{identifier[:112]}-f{index:04d}"
            relative = f"media/{frame_id}.png"
            destination = safe_path(root, relative)
            if destination.exists() or any(item["id"] == frame_id for item in manifest["entries"]):
                raise DatasetError("These frames already exist; extraction does not overwrite samples.")
            rgb = cv2_module.cvtColor(frame, cv2_module.COLOR_BGR2RGB)
            with Image.fromarray(rgb) as image:
                image.save(destination, format="PNG")
            created.append(destination)
            validate_media(destination, "image")
            added.append({**entry, "id": frame_id, "path": relative, "mediaType": "image",
                          "parentId": identifier, "frameTimeMs": timestamp, "reviewRequired": True})
        if not added:
            raise DatasetError("No frames could be extracted.")
        save(root, {**manifest, "entries": [*manifest["entries"], *added]})
    except Exception:
        for destination in created:
            destination.unlink(missing_ok=True)
        raise
    finally:
        capture.release()
    return len(added)


def export_pixels(root, split, output, max_side=3072):
    if split not in SPLITS or not 64 <= max_side <= 4096:
        raise DatasetError("Select train/dev/test and a max side of 64–4096 pixels.")
    manifest = load(root)
    entries = [entry for entry in manifest["entries"] if entry["split"] == split and entry["mediaType"] == "image"]
    if not entries:
        raise DatasetError(f"No {split} images. Add real samples or extract and review video frames first.")
    if len(entries) > 500:
        raise DatasetError("Export at most 500 images per dataset.")
    if any(entry.get("reviewRequired") for entry in entries):
        raise DatasetError("Review extracted frames with the review command before exporting this split.")
    cases, compressed_size = [], 0
    for entry in entries:
        with Image.open(safe_path(root, entry["path"])) as source:
            normalized = ImageOps.exif_transpose(source).convert("RGBA")
        with normalized:
            ratio = min(1, max_side / max(normalized.size), math.sqrt(4_000_000 / (normalized.width * normalized.height)))
            size = (max(1, math.floor(normalized.width * ratio)), max(1, math.floor(normalized.height * ratio)))
            with normalized.resize(size, Image.Resampling.LANCZOS) as resized:
                with Image.new("RGBA", size, "white") as background:
                    with Image.alpha_composite(background, resized) as image:
                        encoded = base64.b64encode(zlib.compress(image.tobytes(), level=9)).decode("ascii")
                        compressed_size += len(encoded)
                        if compressed_size > MAX_EXPORT_BYTES:
                            raise DatasetError("Pixel export exceeds 64 MiB; use fewer samples or a smaller --max-side.")
                        cases.append({"name": entry["id"], "width": image.width, "height": image.height,
                                      "rgba_zlib_base64": encoded,
                                      "expected": [{"text": item["text"], "formats": ["Code128"]} for item in entry["expected"]],
                                      "groupId": entry["groupId"], "split": split, "source": entry["source"],
                                      "device": entry["device"], "conditions": entry["conditions"]})
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload = {"version": "code128-dataset-v1", "split": split,
               "manifestSha256": hashlib.sha256(canonical).hexdigest(), "cases": cases}
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    return len(cases)


def truth_arguments(parser):
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--text", action="append", help="Human-verified expected payload; repeat for multiple codes.")
    group.add_argument("--negative", action="store_true", help="Explicitly label an image with no complete barcode.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["init", "validate", "import", "add", "split", "review", "extract-video", "export"]:
        command = commands.add_parser(name)
        command.add_argument("--root", default="data/local", help="Dataset directory (default: data/local).")
        if name == "import":
            command.add_argument("--metadata", required=True)
            command.add_argument("--media-dir", required=True)
        elif name == "add":
            command.add_argument("--file", required=True)
            command.add_argument("--id", required=True)
            command.add_argument("--group", required=True)
            command.add_argument("--split", choices=sorted(SPLITS), default="dev")
            command.add_argument("--device", required=True)
            command.add_argument("--source", choices=["real", "synthetic"], required=True)
            command.add_argument("--condition", action="append", default=[])
            command.add_argument("--media-type", choices=["image", "video"], default="image")
            truth_arguments(command)
        elif name == "split":
            command.add_argument("--seed", default="code128-v1")
        elif name == "review":
            command.add_argument("--id", required=True)
            truth_arguments(command)
        elif name == "extract-video":
            command.add_argument("--id", required=True)
            command.add_argument("--interval", type=float, default=0.5)
            command.add_argument("--max-frames", type=int, default=120)
        elif name == "export":
            command.add_argument("--split", choices=sorted(SPLITS), required=True)
            command.add_argument("--output", required=True)
            command.add_argument("--max-side", type=int, default=3072)
    args = parser.parse_args(argv)
    root = Path(args.root)
    try:
        if args.command == "init":
            initialize(root); print(f"Created empty dataset: {root / 'manifest.json'}")
        elif args.command == "validate":
            manifest = load(root); print(f"Valid: {len(manifest['entries'])} labelled entries.")
        elif args.command == "import":
            print(f"Imported {import_metadata(root, read_json(args.metadata), args.media_dir)} samples.")
        elif args.command == "add":
            path = Path(args.file).resolve()
            metadata = {"version": 1, "id": args.id, "path": path.name, "mediaType": args.media_type,
                        "expected": [{"text": value, "format": "Code128"} for value in (args.text or [])],
                        "groupId": args.group, "split": args.split, "device": args.device,
                        "source": args.source, "conditions": args.condition}
            print(f"Imported {import_metadata(root, metadata, path.parent)} sample.")
        elif args.command == "split":
            manifest = split_groups(load(root), args.seed); save(root, manifest)
            print("Assigned groups deterministically; existing test groups stayed frozen.")
        elif args.command == "review":
            review_entry(root, args.id, [{"text": value, "format": "Code128"} for value in (args.text or [])])
            print("Saved human-reviewed ground truth.")
        elif args.command == "extract-video":
            print(f"Extracted {extract_video(root, args.id, args.interval, args.max_frames)} frames. Each needs review before benchmarking.")
        elif args.command == "export":
            print(f"Exported {export_pixels(root, args.split, args.output, args.max_side)} images to {args.output}.")
    except (DatasetError, OSError) as error:
        parser.exit(2, f"Dataset error: {error}\n")


if __name__ == "__main__":
    main()
