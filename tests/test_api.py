"""Exercise the public API with real generated images and the actual decoder."""

import base64
import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image


API_KEY = "test-only-barcode-api-key"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BARCODE_API_KEY", API_KEY)
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1]))
    from app import app

    with TestClient(app, headers={"X-API-Key": API_KEY}) as test_client:
        yield test_client


def image_bytes(size=(128, 128), image_format="PNG", **save_options):
    output = io.BytesIO()
    Image.new("RGB", size, "white").save(
        output, format=image_format, **save_options
    )
    return output.getvalue()


def read_image(client, content, filename="barcode.png", mime="image/png"):
    return client.post(
        "/v1/barcodes/read", files={"file": (filename, content, mime)}
    )


def assert_position_inside_image(barcode, width, height):
    points = barcode["position"]
    assert len(points) == 4
    for point in points:
        assert 0 <= point["x"] <= width
        assert 0 <= point["y"] <= height
    # The API documents TL, TR, BR, BL order for these axis-aligned fixtures.
    assert points[0]["x"] <= points[1]["x"]
    assert points[0]["y"] <= points[3]["y"]
    assert points[1]["y"] <= points[2]["y"]
    assert points[3]["x"] <= points[2]["x"]


def test_health_is_public_but_v1_requires_key(client):
    client.headers.pop("X-API-Key")
    assert client.get("/health").status_code == 200
    for method, path, kwargs in [
        ("get", "/v1/formats", {}),
        (
            "post",
            "/v1/barcodes/generate",
            {"json": {"format": "qr", "text": "hello"}},
        ),
        (
            "post",
            "/v1/barcodes/read",
            {"files": {"file": ("blank.png", image_bytes(), "image/png")}},
        ),
    ]:
        response = getattr(client, method)(path, **kwargs)
        assert response.status_code in {401, 403}, response.text


def test_wrong_key_is_rejected(client):
    response = client.get("/v1/formats", headers={"X-API-Key": "wrong-key"})
    assert response.status_code in {401, 403}


def test_supported_generation_formats(client):
    response = client.get("/v1/formats")
    assert response.status_code == 200
    assert set(response.json()["generate"]) == {"qr", "code128", "ean13", "upca"}


@pytest.mark.parametrize(
    ("barcode_format", "text"),
    [
        ("qr", "https://example.test/items/42?name=coffee"),
        ("code128", "ORDER-12345"),
        ("ean13", "5901234123457"),
        ("upca", "036000291452"),
    ],
)
def test_generated_png_roundtrips_through_reader(client, barcode_format, text):
    generated = client.post(
        "/v1/barcodes/generate", json={"format": barcode_format, "text": text}
    )
    assert generated.status_code == 200, generated.text
    assert generated.headers["content-type"].startswith("image/png")
    with Image.open(io.BytesIO(generated.content)) as image:
        width, height = image.size

    response = read_image(client, generated.content)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["image"] == {"width": width, "height": height}
    matches = [
        barcode
        for barcode in result["barcodes"]
        if (barcode["format"], barcode["text"]) == (barcode_format, text)
        or (
            barcode_format == "upca"
            and (barcode["format"], barcode["text"]) == ("ean13", "0" + text)
        )
    ]
    assert matches, result
    for barcode in matches:
        assert base64.b64decode(barcode["bytes_base64"]) == barcode["text"].encode()
        assert_position_inside_image(barcode, width, height)


def test_svg_generation_returns_an_svg_document(client):
    from xml.etree import ElementTree

    response = client.post(
        "/v1/barcodes/generate",
        json={"format": "qr", "text": "SVG example", "output": "svg", "scale": 8},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("image/svg+xml")
    root = ElementTree.fromstring(response.content)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert len(root) > 0


def test_blank_supported_images_have_no_barcodes(client):
    for image_format, extension, mime in [
        ("PNG", "png", "image/png"),
        ("JPEG", "jpg", "image/jpeg"),
        ("WEBP", "webp", "image/webp"),
    ]:
        response = read_image(
            client,
            image_bytes((180, 120), image_format),
            filename=f"blank.{extension}",
            mime=mime,
        )
        assert response.status_code == 200, response.text
        assert response.json() == {
            "barcodes": [],
            "image": {"width": 180, "height": 120},
        }


def test_invalid_image_is_a_client_error(client):
    response = read_image(client, b"this is not a PNG image")
    assert response.status_code in {400, 415, 422}, response.text


@pytest.mark.parametrize(
    "overrides", [{"format": "unknown"}, {"scale": 0}, {"scale": 9}]
)
def test_invalid_generation_options_are_rejected(client, overrides):
    response = client.post(
        "/v1/barcodes/generate",
        json={"format": "qr", "text": "hello", **overrides},
    )
    assert response.status_code == 422, response.text


@pytest.mark.parametrize(
    ("barcode_format", "text"),
    [("ean13", "5901234123458"), ("upca", "036000291453")],
)
def test_incorrect_retail_check_digits_are_rejected(client, barcode_format, text):
    response = client.post(
        "/v1/barcodes/generate", json={"format": barcode_format, "text": text}
    )
    assert response.status_code in {400, 422}, response.text


def test_twenty_megapixel_boundary(client):
    accepted = read_image(client, image_bytes((5000, 4000)))
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["image"] == {"width": 5000, "height": 4000}
    assert accepted.json()["barcodes"] == []

    rejected = read_image(client, image_bytes((5001, 4000)))
    assert rejected.status_code in {400, 413, 422}, rejected.text


def test_upload_over_ten_mebibytes_is_rejected(client):
    # Valid image data plus trailing bytes exercises the upload limit itself.
    png = image_bytes()
    oversized = png + b"\0" * (10 * 1024 * 1024 + 1 - len(png))
    response = read_image(client, oversized)
    assert response.status_code == 413, response.text


def test_exif_orientation_is_applied_to_dimensions_and_coordinates(client):
    text = "https://example.test/rotated"
    generated = client.post(
        "/v1/barcodes/generate", json={"format": "qr", "text": text, "scale": 4}
    )
    assert generated.status_code == 200, generated.text
    with Image.open(io.BytesIO(generated.content)) as image:
        qr = image.convert("RGB")

    canvas = Image.new("RGB", (800, 600), "white")
    left, top = 40, 100
    canvas.paste(qr, (left, top))
    exif = Image.Exif()
    exif[274] = 6  # Display the stored pixels rotated 90 degrees clockwise.
    output = io.BytesIO()
    canvas.save(output, "JPEG", quality=100, subsampling=0, exif=exif)

    response = read_image(client, output.getvalue(), "rotated.jpg", "image/jpeg")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["image"] == {"width": 600, "height": 800}
    barcode = next(item for item in result["barcodes"] if item["text"] == text)
    assert_position_inside_image(barcode, 600, 800)
    # The decoded corners must lie in the QR's rotated destination rectangle.
    for point in barcode["position"]:
        assert 600 - top - qr.height - 2 <= point["x"] <= 600 - top + 2
        assert left - 2 <= point["y"] <= left + qr.width + 2
