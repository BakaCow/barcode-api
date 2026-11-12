"""Actual native-decoder recovery and original-coordinate API regressions."""

import base64
from io import BytesIO
import json
import math
from pathlib import Path
import zlib

from fastapi.testclient import TestClient
from PIL import Image
import pytest
import zxingcpp


ROOT = Path(__file__).resolve().parents[1]
CASES = {case["name"]: case for case in json.loads(
    (ROOT / "tests/fixtures/accuracy-pixels.json").read_text(encoding="utf-8"))["cases"]}
API_KEY = "test-only-accuracy-api-key"


@pytest.fixture
def reader(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    import barcode_reader
    return barcode_reader


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BARCODE_API_KEY", API_KEY)
    monkeypatch.syspath_prepend(str(ROOT))
    from app import app
    with TestClient(app, headers={"X-API-Key": API_KEY}) as client:
        yield client


def fixture_image(name):
    case = CASES[name]
    return Image.frombytes("RGBA", (case["width"], case["height"]),
                           zlib.decompress(base64.b64decode(case["rgba_zlib_base64"]))).convert("RGB")


def upload(client, image):
    encoded = BytesIO()
    image.save(encoded, "PNG")
    response = client.post("/v1/barcodes/read", files={"file": ("challenge.png", encoded.getvalue(), "image/png")})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


@pytest.mark.parametrize("name", ["qr/clean", "code128/clean", "ean13/clean", "datamatrix/clean"])
def test_native_successes_keep_bytes_format_and_coordinates_without_retries(reader, monkeypatch, name):
    native_read = zxingcpp.read_barcodes
    calls = []
    with fixture_image(name) as image:
        original = native_read(image)
        assert original

        def observed_read(candidate, **options):
            calls.append(candidate.size)
            return native_read(candidate, **options)

        monkeypatch.setattr(zxingcpp, "read_barcodes", observed_read)
        improved = reader.read_barcodes(image)
        assert len(calls) == 1
        assert len(improved) == len(original)
        for actual, expected in zip(improved, original):
            position = expected.position
            assert (actual.text, actual.bytes, actual.format) == (expected.text, expected.bytes, expected.format)
            assert actual.points == tuple((p.x, p.y) for p in (
                position.top_left, position.top_right, position.bottom_right, position.bottom_left))


@pytest.mark.parametrize("name", ["qr/weak-contrast", "code128/weak-contrast", "datamatrix/weak-contrast",
                                  "code128/inverted", "ean13/inverted"])
def test_api_recovers_known_cases_that_the_original_decoder_misses(client, name):
    with fixture_image(name) as image:
        assert zxingcpp.read_barcodes(image) == [], "fixture must exercise a fallback"
        response = upload(client, image)
        expected = CASES[name]["expected"][0]["text"]
        assert [code["text"] for code in response["barcodes"]] == [expected]
        assert base64.b64decode(response["barcodes"][0]["bytes_base64"]) == expected.encode()
        assert response["image"] == {"width": image.width, "height": image.height}
        for point in response["barcodes"][0]["position"]:
            assert 0 <= point["x"] <= image.width
            assert 0 <= point["y"] <= image.height


def test_rotated_fallback_coordinates_land_on_the_original_label(client):
    name = "code128/rotate-37"
    with fixture_image(name) as image, fixture_image("code128/clean") as clean:
        assert zxingcpp.read_barcodes(image) == []
        original = zxingcpp.read_barcodes(clean)[0]
        response = upload(client, image)
        assert [code["text"] for code in response["barcodes"]] == [original.text]
        corners = original.position
        original_points = [corners.top_left, corners.top_right, corners.bottom_right, corners.bottom_left]
        left, right = min(p.x for p in original_points), max(p.x for p in original_points)
        top, bottom = min(p.y for p in original_points), max(p.y for p in original_points)
        c, s = math.cos(math.radians(37)), math.sin(math.radians(37))
        # The fixture was made by Pillow.rotate(37, expand=True). Invert that
        # known fixture transform independently of the recovery implementation.
        for point in response["barcodes"][0]["position"]:
            dx, dy = point["x"] + 0.5 - image.width / 2, point["y"] + 0.5 - image.height / 2
            x = c * dx - s * dy + clean.width / 2 - 0.5
            y = s * dx + c * dy + clean.height / 2 - 0.5
            assert left - 3 <= x <= right + 3
            assert top - 3 <= y <= bottom + 3


@pytest.mark.parametrize("name", [name for name in CASES if name.startswith("negative/")])
def test_recovery_does_not_invent_codes_in_negative_images(reader, name):
    with fixture_image(name) as image:
        assert reader.read_barcodes(image) == []


def test_elapsed_budget_prevents_starting_fallback_work(reader, monkeypatch):
    calls = []
    times = iter([0.0, 3.0])
    monkeypatch.setattr(reader, "monotonic", lambda: next(times))
    monkeypatch.setattr(zxingcpp, "read_barcodes", lambda image, **options: calls.append(image.size) or [])
    with Image.new("L", (100, 100), 255) as image:
        assert reader.read_barcodes(image) == []
    assert calls == [(100, 100)]


@pytest.mark.parametrize("size", [(4200, 1100), (1, 4_100_000), (4_100_000, 1)])
def test_every_fallback_allocation_stays_within_four_megapixels(reader, monkeypatch, size):
    calls = []
    monkeypatch.setattr(reader, "monotonic", lambda: 0.0)
    monkeypatch.setattr(zxingcpp, "read_barcodes", lambda image, **options: calls.append(image.size) or [])
    with Image.new("L", size, 255) as image:
        assert reader.read_barcodes(image) == []
    assert calls[0] == size, "original full-resolution pass is preserved"
    assert 1 < len(calls) <= 5
    assert all(width * height <= 4_000_000 for width, height in calls[1:])
