"""Dataset isolation, human truth, safe paths, review and export behavior."""
import base64
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import zlib

from PIL import Image
import pytest


spec = importlib.util.spec_from_file_location("barcode_dataset", Path(__file__).resolve().parents[1] / "tools/dataset.py")
dataset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dataset)


def sample(identifier="sample-1", **changes):
    return {"id": identifier, "path": identifier + ".png", "mediaType": "image",
            "expected": [{"text": "BOX-123", "format": "Code128"}], "groupId": "label-1",
            "split": "dev", "conditions": ["angled"], "device": "Test phone", "source": "synthetic", **changes}


def picture(folder, name="sample-1.png", color=(0, 0, 0, 0)):
    path = folder / name
    with Image.new("RGBA", (16, 10), color) as image:
        image.save(path)
    return path


def setup_dataset(tmp_path):
    root = tmp_path / "dataset"
    media = tmp_path / "incoming"
    media.mkdir()
    dataset.initialize(root)
    return root, media


def test_init_is_empty_ignored_and_does_not_overwrite(tmp_path):
    dataset.initialize(tmp_path)
    assert dataset.load(tmp_path)["entries"] == []
    assert (tmp_path / ".gitignore").read_text() == "*\n"
    with pytest.raises(dataset.DatasetError, match="already exists"):
        dataset.initialize(tmp_path)


@pytest.mark.parametrize("path", ["../outside.png", "/outside.png", "C:/outside.png", "a\\outside.png", "a/../outside.png", "a//b.png", "./a.png", "a/./b.png", "."])
def test_media_paths_cannot_escape_or_use_ambiguous_spellings(tmp_path, path):
    with pytest.raises(dataset.DatasetError):
        dataset.safe_path(tmp_path, path)


def test_symlink_cannot_escape_dataset_root(tmp_path):
    root, outside = tmp_path / "root", tmp_path / "outside"
    root.mkdir(); outside.mkdir()
    try:
        (root / "linked").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("Creating symlinks is unavailable for this Windows account")
    with pytest.raises(dataset.DatasetError, match="escapes"):
        dataset.safe_path(root, "linked/image.png")


def test_browser_sidecar_import_preserves_manual_truth_and_metadata(tmp_path):
    root, media = setup_dataset(tmp_path)
    picture(media)
    entry = sample(expected=[{"text": "  BOX-123  ", "format": "Code128"}], capturedAt="2026-11-12T00:00:00Z")
    assert dataset.import_metadata(root, {"version": 1, **entry}, media) == 1
    imported = dataset.load(root)["entries"][0]
    assert imported["expected"] == entry["expected"]
    assert imported["capturedAt"] == entry["capturedAt"]
    assert imported["path"] == "media/sample-1.png"
    assert (root / imported["path"]).read_bytes() == (media / entry["path"]).read_bytes()


def test_ground_truth_is_required_and_negative_must_be_explicit(tmp_path):
    entry = sample()
    del entry["expected"]
    with pytest.raises(dataset.DatasetError, match="expected values"):
        dataset.validate_manifest({"version": 1, "entries": [entry]}, tmp_path, False)
    with pytest.raises(dataset.DatasetError, match="negative must agree"):
        dataset.validate_manifest({"version": 1, "entries": [sample(negative=True)]}, tmp_path, False)
    assert dataset.validate_manifest({"version": 1, "entries": [sample(expected=[], negative=True)]}, tmp_path, False)


def test_group_leakage_is_rejected_before_any_media_is_copied(tmp_path):
    root, media = setup_dataset(tmp_path)
    picture(media)
    picture(media, "sample-2.png")
    dataset.import_metadata(root, {"version": 1, **sample()}, media)
    with pytest.raises(dataset.DatasetError, match="multiple splits"):
        dataset.import_metadata(root, {"version": 1, **sample("sample-2", split="test")}, media)
    assert len(dataset.load(root)["entries"]) == 1
    assert not (root / "media/sample-2.png").exists()


def test_group_assignment_is_order_independent_and_keeps_existing_test_groups(tmp_path):
    entries = [sample(f"sample-{i}", groupId=f"label-{i // 2}", split="test" if i < 2 else "dev") for i in range(20)]
    one = dataset.split_groups({"version": 1, "entries": entries}, "seed")
    two = dataset.split_groups({"version": 1, "entries": list(reversed(entries))}, "seed")
    mapping = lambda manifest: {entry["id"]: entry["split"] for entry in manifest["entries"]}
    assert mapping(one) == mapping(two)
    assert all(entry["split"] == "test" for entry in one["entries"][:2])
    dataset.validate_manifest(one, tmp_path, require_files=False)


def test_duplicate_media_path_aliases_and_ids_are_rejected(tmp_path):
    for entries in [[sample(), sample(path="different.png")],
                    [sample(path="media/Photo.png"), sample("sample-2", path="media/photo.png")]]:
        with pytest.raises(dataset.DatasetError, match="Duplicate"):
            dataset.validate_manifest({"version": 1, "entries": entries}, tmp_path, False)


def test_animated_and_oversized_files_are_rejected(tmp_path):
    path = tmp_path / "animated.webp"
    with Image.new("RGB", (10, 10), "red") as one, Image.new("RGB", (10, 10), "blue") as two:
        one.save(path, save_all=True, append_images=[two], format="WEBP")
    with pytest.raises(dataset.DatasetError, match="single PNG"):
        dataset.validate_media(path, "image")
    large = tmp_path / "large.png"
    with large.open("wb") as stream:
        stream.truncate(dataset.MAX_IMAGE_BYTES + 1)
    with pytest.raises(dataset.DatasetError, match="exceeds"):
        dataset.validate_media(large, "image")


def test_export_preserves_truth_and_composites_alpha_without_relabelling(tmp_path):
    root, media = setup_dataset(tmp_path)
    picture(media)
    dataset.import_metadata(root, {"version": 1, **sample()}, media)
    output = root / "dev-pixels.json"
    assert dataset.export_pixels(root, "dev", output) == 1
    fixture = json.loads(output.read_text())
    case = fixture["cases"][0]
    assert case["expected"] == [{"text": "BOX-123", "formats": ["Code128"]}]
    assert case["source"] == "synthetic"
    assert set(zlib.decompress(base64.b64decode(case["rgba_zlib_base64"]))) == {255}
    assert len(fixture["manifestSha256"]) == 64
    with pytest.raises(dataset.DatasetError, match="No test images"):
        dataset.export_pixels(root, "test", root / "test.json")


def test_video_frames_inherit_group_and_need_human_review_before_export(tmp_path, monkeypatch):
    root, media = setup_dataset(tmp_path)
    (media / "clip.webm").write_bytes(b"mock video; decoder below is a test double")
    dataset.import_metadata(root, {"version": 1, **sample("clip", path="clip.webm", mediaType="video", split="test")}, media)
    class Capture:
        released = False
        index = 0
        def isOpened(self): return True
        def set(self, key, value): return True
        def read(self):
            self.index += 1
            return (True, SimpleNamespace(shape=(10, 16, 3))) if self.index <= 2 else (False, None)
        def release(self): self.released = True
    capture = Capture()
    cv2 = SimpleNamespace(VideoCapture=lambda _: capture, CAP_PROP_POS_MSEC=1, COLOR_BGR2RGB=2, cvtColor=lambda frame, _: frame)
    monkeypatch.setattr(dataset.Image, "fromarray", lambda _: Image.new("RGB", (16, 10), "white"))
    assert dataset.extract_video(root, "clip", cv2_module=cv2) == 2
    assert capture.released
    frames = dataset.load(root)["entries"][1:]
    assert all(entry["groupId"] == "label-1" and entry["split"] == "test" and entry["source"] == "synthetic" for entry in frames)
    assert all(entry["reviewRequired"] for entry in frames)
    with pytest.raises(dataset.DatasetError, match="Review extracted"):
        dataset.export_pixels(root, "test", root / "test.json")
    dataset.review_entry(root, "clip-f0000", [{"text": "BOX-123", "format": "Code128"}])
    dataset.review_entry(root, "clip-f0001", [])
    assert dataset.export_pixels(root, "test", root / "test.json") == 2
    assert dataset.load(root)["entries"][-1]["negative"] is True


def test_invalid_import_does_not_modify_manifest(tmp_path):
    root, media = setup_dataset(tmp_path)
    picture(media)
    before = (root / "manifest.json").read_bytes()
    with pytest.raises(dataset.DatasetError):
        dataset.import_metadata(root, {"version": 1, **sample(source="guess")}, media)
    assert (root / "manifest.json").read_bytes() == before
    assert list((root / "media").iterdir()) == []


def test_boolean_schema_versions_and_nonfinite_json_are_rejected(tmp_path):
    with pytest.raises(dataset.DatasetError, match="version 1"):
        dataset.validate_manifest({"version": True, "entries": []}, tmp_path, False)
    path = tmp_path / "invalid.json"
    path.write_text('{"version":1,"entries":[],"metadata":NaN}')
    with pytest.raises(dataset.DatasetError, match="Invalid JSON"):
        dataset.read_json(path)


def test_failed_copy_rolls_back_partial_import(tmp_path, monkeypatch):
    root, media = setup_dataset(tmp_path)
    picture(media)
    def failing_copy(reader, writer):
        writer.write(b"partial")
        raise OSError("simulated interrupted copy")
    monkeypatch.setattr(dataset.shutil, "copyfileobj", failing_copy)
    with pytest.raises(OSError, match="interrupted"):
        dataset.import_metadata(root, {"version": 1, **sample()}, media)
    assert list((root / "media").iterdir()) == []
    assert dataset.load(root)["entries"] == []
