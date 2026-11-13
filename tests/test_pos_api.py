"""POS burst contract tests with independently encoded images and real decoding."""

import base64
from functools import lru_cache
from io import BytesIO
import json
from pathlib import Path
import zlib

from fastapi.testclient import TestClient
from PIL import Image, ImageOps, PngImagePlugin
import pytest
from starlette.datastructures import UploadFile as StarletteUploadFile
import zxingcpp


ROOT = Path(__file__).resolve().parents[1]
API_KEY = "test-only-pos-api-key-keep-private"
DEFAULT_FORMATS = ["ean13", "upca", "code128", "qr"]


@pytest.fixture
def api(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    monkeypatch.setenv("BARCODE_API_KEY", API_KEY)
    import app
    return app


@pytest.fixture
def client(api):
    with TestClient(api.app, headers={"X-API-Key": API_KEY}) as client:
        yield client


@pytest.fixture
def tracked_resources(api, monkeypatch):
    """Observe real parser files and normalized images without replacing cleanup."""
    uploads, images = [], []
    upload_init = StarletteUploadFile.__init__
    load_image = api.load_image

    def observed_upload(self, *args, **kwargs):
        upload_init(self, *args, **kwargs)
        uploads.append(self.file)

    def observed_image(*args, **kwargs):
        image = load_image(*args, **kwargs)
        images.append(image)
        return image

    monkeypatch.setattr(StarletteUploadFile, "__init__", observed_upload)
    monkeypatch.setattr(api, "load_image", observed_image)
    return uploads, images


def encode(image, image_format="PNG", **options):
    output = BytesIO()
    image.save(output, image_format, **options)
    return output.getvalue()


def label(text="POS-ITEM-A", barcode_format=zxingcpp.BarcodeFormat.Code128):
    code = zxingcpp.create_barcode(text, barcode_format)
    return Image.fromarray(code.to_image(scale=4, add_quiet_zones=True)).convert("RGB")


def changed_pixel(image, amount=1):
    changed = image.copy()
    changed.putpixel((0, 0), (255 - amount,) * 3)
    return changed


def upload(client, images, options=None, raw_options=None, mime="image/png"):
    files = [("frames", (f"frame-{index}.png", content, mime)) for index, content in enumerate(images)]
    data = {}
    if options is not None:
        data["options"] = json.dumps(options)
    if raw_options is not None:
        data["options"] = raw_options
    return client.post("/v1/pos/decode", files=files, data=data)


def result(response):
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    return response.json()


def assert_candidate(candidate, text, barcode_format, indices):
    assert candidate["text"] == text
    assert candidate["format"] == barcode_format
    assert base64.b64decode(candidate["bytes_base64"]) == text.encode()
    assert candidate["frame_indices"] == indices


@lru_cache
def fixture_png(filename, name):
    corpus = json.loads((ROOT / "tests" / "fixtures" / filename).read_text(encoding="utf-8"))
    case = next(case for case in corpus["cases"] if case["name"] == name)
    with Image.frombytes("RGBA", (case["width"], case["height"]),
                         zlib.decompress(base64.b64decode(case["rgba_zlib_base64"]))) as image:
        return encode(image), case["expected"]


@pytest.mark.parametrize("key", [None, "wrong-pos-api-key"])
def test_pos_requires_the_existing_api_key(client, key):
    client.headers.pop("X-API-Key")
    if key is not None:
        client.headers["X-API-Key"] = key
    response = upload(client, [encode(label())])
    assert response.status_code == 401


def test_default_single_frame_is_a_rescan_with_an_unconfirmed_candidate(client):
    image = label()
    payload = result(upload(client, [encode(image)]))
    assert payload["status"] == "rescan"
    assert payload["reason"] == "insufficient_confirmation"
    assert payload["barcode"] is None
    assert payload["allowed_formats"] == DEFAULT_FORMATS
    assert payload["confirmation"] == {"required_frames": 2, "distinct_frames": 1, "matched_frames": 1}
    assert len(payload["candidates"]) == 1
    assert_candidate(payload["candidates"][0], "POS-ITEM-A", "code128", [0])
    frame = payload["frames"][0]
    assert frame["index"] == 0
    assert frame["duplicate_of"] is None
    assert frame["image"] == {"width": image.width, "height": image.height}
    assert [barcode["text"] for barcode in frame["barcodes"]] == ["POS-ITEM-A"]
    for point in frame["barcodes"][0]["position"]:
        assert 0 <= point["x"] <= image.width
        assert 0 <= point["y"] <= image.height


def test_two_distinct_images_of_the_same_code_confirm(client):
    image = label()
    payload = result(upload(client, [encode(image), encode(changed_pixel(image))]))
    assert payload["status"] == "confirmed"
    assert payload["reason"] == "frame_agreement"
    assert payload["confirmation"] == {"required_frames": 2, "distinct_frames": 2, "matched_frames": 2}
    assert_candidate(payload["barcode"], "POS-ITEM-A", "code128", [0, 1])
    assert payload["candidates"] == [payload["barcode"]]
    assert [frame["duplicate_of"] for frame in payload["frames"]] == [None, None]


def test_confirmation_is_stateless_across_http_requests(client):
    image = label()
    for content in [encode(image), encode(changed_pixel(image))]:
        payload = result(upload(client, [content]))
        assert payload["status"] == "rescan"
        assert payload["confirmation"]["matched_frames"] == 1


def test_confirmation_one_explicitly_allows_a_single_match(client):
    payload = result(upload(client, [encode(label())], {"confirmation_frames": 1}))
    assert payload["status"] == "confirmed"
    assert payload["reason"] == "single_match"
    assert payload["confirmation"] == {"required_frames": 1, "distinct_frames": 1, "matched_frames": 1}
    assert_candidate(payload["barcode"], "POS-ITEM-A", "code128", [0])


def test_three_frame_policy_requires_three_distinct_matching_images(client):
    image = label()
    frames = [encode(changed_pixel(image, amount)) for amount in [0, 1, 2]]
    insufficient = result(upload(client, frames[:2], {"confirmation_frames": 3}))
    assert insufficient["status"] == "rescan"
    assert insufficient["reason"] == "insufficient_confirmation"
    assert insufficient["confirmation"]["matched_frames"] == 2
    confirmed = result(upload(client, frames, {"confirmation_frames": 3}))
    assert confirmed["status"] == "confirmed"
    assert confirmed["confirmation"] == {"required_frames": 3, "distinct_frames": 3, "matched_frames": 3}
    assert_candidate(confirmed["barcode"], "POS-ITEM-A", "code128", [0, 1, 2])


def test_five_frames_are_accepted_and_all_evidence_indices_are_retained(client):
    image = label()
    payload = result(upload(client, [encode(changed_pixel(image, amount)) for amount in range(5)]))
    assert payload["status"] == "confirmed"
    assert payload["confirmation"] == {"required_frames": 2, "distinct_frames": 5, "matched_frames": 5}
    assert_candidate(payload["barcode"], "POS-ITEM-A", "code128", list(range(5)))


@pytest.mark.parametrize("reencoded", [False, True])
def test_duplicate_pixels_never_count_as_independent_confirmation(client, api, monkeypatch, reencoded):
    image = label()
    first = encode(image)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Test", "Same RGB pixels, different PNG bytes")
    second = encode(image, compress_level=0, pnginfo=metadata) if reencoded else first
    assert (first != second) is reencoded
    calls = []
    actual_read = api.read_barcodes

    def observed_read(candidate, *args, **kwargs):
        calls.append(candidate.size)
        return actual_read(candidate, *args, **kwargs)

    monkeypatch.setattr(api, "read_barcodes", observed_read)
    payload = result(upload(client, [first, second]))
    assert payload["status"] == "rescan"
    assert payload["reason"] == "insufficient_confirmation"
    assert payload["confirmation"] == {"required_frames": 2, "distinct_frames": 1, "matched_frames": 1}
    assert_candidate(payload["candidates"][0], "POS-ITEM-A", "code128", [0])
    assert payload["frames"][1]["duplicate_of"] == 0
    assert payload["frames"][1]["barcodes"] == payload["frames"][0]["barcodes"]
    assert len(calls) == 1, "a duplicate must reuse the first frame's decoding"


def test_transparency_is_composited_before_duplicate_identity(client):
    image = label()
    transparent = Image.new("RGBA", image.size, (0, 0, 0, 0))
    transparent.putalpha(ImageOps.invert(image.convert("L")))
    payload = result(upload(client, [encode(image), encode(transparent)]))
    assert payload["status"] == "rescan"
    assert payload["confirmation"]["distinct_frames"] == 1
    assert payload["frames"][1]["duplicate_of"] == 0
    assert payload["frames"][1]["barcodes"][0]["text"] == "POS-ITEM-A"


def test_dimensions_are_part_of_normalized_pixel_identity(client):
    # These have identical RGB byte streams, but different image shapes.
    first = Image.new("RGB", (40, 20), "white")
    second = Image.new("RGB", (20, 40), "white")
    assert first.tobytes() == second.tobytes()
    payload = result(upload(client, [encode(first), encode(second)]))
    assert payload["status"] == "rescan"
    assert payload["reason"] == "no_code"
    assert payload["confirmation"] == {"required_frames": 2, "distinct_frames": 2, "matched_frames": 0}
    assert [frame["duplicate_of"] for frame in payload["frames"]] == [None, None]


def test_blank_frame_counts_as_distinct_but_does_not_confirm_a_label(client):
    image = label()
    payload = result(upload(client, [encode(image), encode(Image.new("RGB", image.size, "white"))]))
    assert payload["status"] == "rescan"
    assert payload["reason"] == "insufficient_confirmation"
    assert payload["confirmation"] == {"required_frames": 2, "distinct_frames": 2, "matched_frames": 1}


def test_conflicting_values_are_ambiguous_even_with_a_two_of_three_majority(client):
    image = label()
    payload = result(upload(client, [encode(image), encode(changed_pixel(image)), encode(label("POS-ITEM-B"))]))
    assert payload["status"] == "ambiguous"
    assert payload["reason"] == "conflicting_values"
    assert payload["barcode"] is None
    candidates = {candidate["text"]: candidate for candidate in payload["candidates"]}
    assert set(candidates) == {"POS-ITEM-A", "POS-ITEM-B"}
    assert_candidate(candidates["POS-ITEM-A"], "POS-ITEM-A", "code128", [0, 1])
    assert_candidate(candidates["POS-ITEM-B"], "POS-ITEM-B", "code128", [2])
    assert payload["confirmation"]["matched_frames"] == 2


def test_two_different_codes_in_one_frame_are_ambiguous(client):
    first = label("POS-QR-A", zxingcpp.BarcodeFormat.QRCode)
    second = label("POS-QR-B", zxingcpp.BarcodeFormat.QRCode)
    combined = Image.new("RGB", (first.width + second.width + 80, max(first.height, second.height) + 40), "white")
    combined.paste(first, (20, 20))
    combined.paste(second, (first.width + 60, 20))
    payload = result(upload(client, [encode(combined)], {"confirmation_frames": 1}))
    assert payload["status"] == "ambiguous"
    assert payload["reason"] == "conflicting_values"
    assert payload["barcode"] is None
    assert {candidate["text"] for candidate in payload["candidates"]} == {"POS-QR-A", "POS-QR-B"}
    assert all(candidate["frame_indices"] == [0] for candidate in payload["candidates"])


def test_equal_text_in_different_formats_does_not_merge_into_confirmation(client):
    first = label("POS-ITEM-A", zxingcpp.BarcodeFormat.Code128)
    second = label("POS-ITEM-A", zxingcpp.BarcodeFormat.QRCode)
    payload = result(upload(client, [encode(first), encode(second)]))
    assert payload["status"] == "ambiguous"
    assert payload["reason"] == "conflicting_values"
    assert payload["barcode"] is None
    assert {(candidate["format"], tuple(candidate["frame_indices"])) for candidate in payload["candidates"]} == {
        ("code128", (0,)), ("qr", (1,)),
    }
    assert payload["confirmation"]["matched_frames"] == 1


def test_qr_eci_interpretations_with_equal_bytes_do_not_merge_into_confirmation(client):
    raw = bytes([0xC3, 0xA4])
    frames = []
    for eci in [3, 26]:
        code = zxingcpp.create_barcode(raw, zxingcpp.BarcodeFormat.QRCode, eci=eci)
        with Image.fromarray(code.to_image(scale=4, add_quiet_zones=True)).convert("RGB") as image:
            frames.append(encode(image))
    assert frames[0] != frames[1]
    payload = result(upload(client, frames))
    assert payload["status"] == "ambiguous"
    assert payload["reason"] == "conflicting_values"
    assert payload["barcode"] is None
    assert payload["confirmation"] == {"required_frames": 2, "distinct_frames": 2, "matched_frames": 1}
    assert len(payload["candidates"]) == 2
    candidates = {candidate["text"]: candidate for candidate in payload["candidates"]}
    assert set(candidates) == {"\u00c3\u00a4", "\u00e4"}
    for text, index in [("\u00c3\u00a4", 0), ("\u00e4", 1)]:
        assert candidates[text]["format"] == "qr"
        assert base64.b64decode(candidates[text]["bytes_base64"]) == raw
        assert candidates[text]["frame_indices"] == [index]


def test_restricted_formats_reach_the_native_decoder_and_remove_the_known_extra_upce(client, monkeypatch):
    content, expected = fixture_png("damage-stress-verify.json", "ean13/verify-ean13-label-2/angled-2")
    native_read = zxingcpp.read_barcodes
    calls = []

    def observed_read(image, **options):
        calls.append(options)
        return native_read(image, **options)

    monkeypatch.setattr(zxingcpp, "read_barcodes", observed_read)
    payload = result(upload(client, [content], {"allowed_formats": ["ean13"], "confirmation_frames": 1}))
    assert payload["status"] == "confirmed"
    assert len(payload["candidates"]) == 1
    assert_candidate(payload["barcode"], expected[0]["text"], "ean13", [0])
    assert calls and all(call.get("formats") is not None for call in calls), "formats must be set before native decoding"
    for call in calls:
        configured = zxingcpp.BarcodeFormats(call["formats"])
        assert configured == zxingcpp.BarcodeFormats(zxingcpp.BarcodeFormat.EAN13)


def test_explicit_upce_opt_in_rejects_the_corroborated_same_symbol_alias(client):
    content, expected = fixture_png("damage-stress-verify.json", "ean13/verify-ean13-label-2/angled-2")
    payload = result(upload(client, [content], {"allowed_formats": ["ean13", "upce"], "confirmation_frames": 1}))
    assert payload["status"] == "confirmed"
    assert {(candidate["format"], candidate["text"]) for candidate in payload["candidates"]} == {
        ("ean13", expected[0]["text"]),
    }


def test_real_separate_ean_and_upce_remain_ambiguous_when_both_requested(client):
    with label('04252614', zxingcpp.BarcodeFormat.UPCE) as upce, \
         label('4006381333931', zxingcpp.BarcodeFormat.EAN13) as ean, \
         Image.new('RGB', (upce.width + ean.width + 80, max(upce.height, ean.height) + 40), 'white') as scene:
        scene.paste(upce, (10, 10)); scene.paste(ean, (upce.width + 60, 10))
        content = encode(scene)
    payload = result(upload(client, [content], {"allowed_formats": ["ean13", "upce"], "confirmation_frames": 1}))
    assert payload['status'] == 'ambiguous' and payload['barcode'] is None
    assert {(candidate['format'], candidate['text']) for candidate in payload['candidates']} == {
        ('ean13', '4006381333931'), ('upce', '0042100005264')}


def test_known_invalid_checksum_negative_has_no_pos_candidate(client):
    content, expected = fixture_png("damage-regressions.json", "regression/invalid-ean13-oblique-upce")
    assert expected == []
    payload = result(upload(client, [content], {"allowed_formats": ["ean13", "upce"], "confirmation_frames": 1}))
    assert payload["status"] == "rescan"
    assert payload["reason"] == "no_code"
    assert payload["barcode"] is None
    assert payload["candidates"] == []


def test_disallowed_format_is_not_a_pos_candidate(client):
    payload = result(upload(client, [encode(label())], {"allowed_formats": ["qr"], "confirmation_frames": 1}))
    assert payload["reason"] == "no_code"
    assert payload["candidates"] == []
    assert payload["frames"][0]["barcodes"] == []


def test_all_documented_pos_format_names_are_accepted(client):
    allowed = ["qr", "code128", "ean13", "ean8", "upca", "upce", "datamatrix", "aztec", "pdf417", "code93"]
    payload = result(upload(client, [encode(Image.new("RGB", (40, 30), "white"))], {"allowed_formats": allowed}))
    assert payload["allowed_formats"] == allowed
    assert payload["reason"] == "no_code"


@pytest.mark.parametrize("raw_options", ["", "{", "null", "[]", "1", "true", '"qr"'])
def test_malformed_or_nonobject_options_are_422_before_decoding(client, api, monkeypatch, raw_options):
    monkeypatch.setattr(api, "read_barcodes", lambda *args, **kwargs: pytest.fail("invalid options reached decoding"))
    response = upload(client, [encode(label())], raw_options=raw_options)
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("options", [
    {"allowed_formats": []}, {"allowed_formats": ["qr", "qr"]}, {"allowed_formats": ["unknown"]},
    {"allowed_formats": ["QR"]}, {"allowed_formats": "qr"}, {"allowed_formats": None},
    {"allowed_formats": [1]}, {"unexpected": True},
    {"confirmation_frames": 0}, {"confirmation_frames": 4}, {"confirmation_frames": 1.5},
    {"confirmation_frames": "2"}, {"confirmation_frames": True}, {"confirmation_frames": None},
])
def test_invalid_option_values_are_strictly_rejected(client, options):
    response = upload(client, [encode(label())], options)
    assert response.status_code == 422, response.text


def test_options_field_has_a_bounded_utf8_size(client, api, monkeypatch):
    monkeypatch.setattr(api, "read_barcodes", lambda *args, **kwargs: pytest.fail("oversized options reached decoding"))
    for raw_options in ["{}" + " " * 8191, '{"unknown":"' + "é" * 4096 + '"}']:
        assert len(raw_options.encode("utf-8")) > 8192
        assert upload(client, [encode(label())], raw_options=raw_options).status_code == 422


def test_empty_options_object_uses_defaults(client):
    payload = result(upload(client, [encode(label())], {}))
    assert payload["allowed_formats"] == DEFAULT_FORMATS
    assert payload["confirmation"]["required_frames"] == 2


def test_frames_are_required_and_no_more_than_five_are_allowed(client):
    assert client.post("/v1/pos/decode", data={"options": "{}"}).status_code == 422
    assert upload(client, [encode(label())] * 6).status_code == 422
    assert client.post("/v1/pos/decode", files={"file": ("wrong-field.png", encode(label()), "image/png")}).status_code == 422


@pytest.mark.parametrize("field,value", [("confirmation_frames", "1"), ("allowed_formats", '["qr"]')])
def test_direct_option_fields_cannot_silently_override_the_json_contract(client, field, value, tracked_resources):
    response = client.post("/v1/pos/decode", files=[
        ("frames", ("frame.png", encode(label()), "image/png")),
        (field, (None, value)),
    ])
    assert response.status_code == 422, response.text
    uploads, images = tracked_resources
    assert len(uploads) == 1 and uploads[0].closed
    assert images == [], "unknown fields must be rejected before opening images"


def test_repeated_options_are_rejected_instead_of_selecting_one(client, tracked_resources):
    response = client.post("/v1/pos/decode", files=[
        ("frames", ("frame.png", encode(label()), "image/png")),
        ("options", (None, '{"confirmation_frames":2}')),
        ("options", (None, '{"confirmation_frames":1}')),
    ])
    assert response.status_code == 422, response.text
    uploads, images = tracked_resources
    assert len(uploads) == 1 and uploads[0].closed
    assert images == []


def test_options_must_be_a_form_string_not_an_uploaded_json_file(client, tracked_resources):
    response = client.post("/v1/pos/decode", files=[
        ("frames", ("frame.png", encode(label()), "image/png")),
        ("options", ("options.json", b'{"confirmation_frames":1}', "application/json")),
    ])
    assert response.status_code == 422, response.text
    uploads, images = tracked_resources
    assert len(uploads) == 2 and all(handle.closed for handle in uploads)
    assert images == []


@pytest.mark.parametrize("case,expected_images", [("valid", 2), ("invalid_options", 0), ("corrupt_later", 1), ("decoder_error", 2)])
def test_pos_closes_uploads_and_normalized_images_on_every_exit(client, api, monkeypatch, tracked_resources, case, expected_images):
    image = label()
    frames = [encode(image), encode(changed_pixel(image))]
    raw_options = None
    if case == "invalid_options":
        raw_options = "{"
    elif case == "corrupt_later":
        frames[1] = b"corrupt later image"
    elif case == "decoder_error":
        def broken_decoder(*args, **kwargs):
            raise RuntimeError("intentional decoder failure for cleanup test")
        monkeypatch.setattr(api, "read_barcodes", broken_decoder)

    if case == "decoder_error":
        with pytest.raises(RuntimeError, match="intentional decoder failure"):
            upload(client, frames)
    else:
        response = upload(client, frames, raw_options=raw_options)
        expected_status = {"valid": 200, "invalid_options": 422, "corrupt_later": 400}[case]
        assert response.status_code == expected_status, response.text

    uploads, images = tracked_resources
    assert len(uploads) == 2
    assert all(handle.closed for handle in uploads), "request-owned multipart handles must always close"
    assert len(images) == expected_images
    for normalized in images:
        with pytest.raises(ValueError, match="closed image"):
            normalized.getpixel((0, 0))


@pytest.mark.parametrize(("image_format", "mime"), [("PNG", "image/png"), ("JPEG", "image/jpeg"), ("WEBP", "image/webp")])
def test_supported_encodings_return_no_code_for_blank_images(client, image_format, mime):
    payload = result(upload(client, [encode(Image.new("RGB", (60, 40), "white"), image_format)], mime=mime))
    assert payload["status"] == "rescan"
    assert payload["reason"] == "no_code"
    assert payload["barcode"] is None
    assert payload["candidates"] == []
    assert payload["frames"][0]["image"] == {"width": 60, "height": 40}


def test_exif_orientation_is_normalized_before_dimensions_and_decoding(client):
    code = label("POS-ROTATED-QR", zxingcpp.BarcodeFormat.QRCode)
    canvas = Image.new("RGB", (500, 300), "white")
    canvas.paste(code, (50, 60))
    exif = Image.Exif()
    exif[274] = 6
    payload = result(upload(client, [encode(canvas, "JPEG", quality=100, subsampling=0, exif=exif)],
                            {"confirmation_frames": 1}, mime="image/jpeg"))
    assert payload["status"] == "confirmed"
    assert payload["frames"][0]["image"] == {"width": 300, "height": 500}
    assert_candidate(payload["barcode"], "POS-ROTATED-QR", "qr", [0])
    for point in payload["frames"][0]["barcodes"][0]["position"]:
        assert 300 - 60 - code.height - 2 <= point["x"] <= 300 - 60 + 2
        assert 50 - 2 <= point["y"] <= 50 + code.width + 2


@pytest.mark.parametrize("content", [b"", b"not an image", b"\x89PNG\r\n\x1a\ntruncated"])
def test_corrupt_images_return_400(client, content):
    assert upload(client, [content]).status_code == 400


def test_unsupported_and_animated_images_return_415(client):
    blank = Image.new("RGB", (40, 30), "white")
    assert upload(client, [encode(blank, "BMP")]).status_code == 415
    animated = encode(blank, save_all=True, append_images=[Image.new("RGB", blank.size, "black")], duration=100, loop=0)
    assert upload(client, [animated]).status_code == 415


def test_invalid_later_frame_prevents_partial_decoding(client, api, monkeypatch):
    monkeypatch.setattr(api, "read_barcodes", lambda *args, **kwargs: pytest.fail("invalid burst reached decoding"))
    assert upload(client, [encode(label()), b"corrupt later frame"]).status_code == 400


def test_total_upload_bytes_limit_is_shared_across_frames(client, api, monkeypatch):
    content = encode(Image.new("RGB", (30, 30), "white"))
    monkeypatch.setattr(api, "MAX_FILE_BYTES", len(content) + 10)
    monkeypatch.setattr(api, "read_barcodes", lambda *args, **kwargs: pytest.fail("oversized burst reached decoding"))
    response = upload(client, [content, content])
    assert response.status_code == 413, response.text


def test_each_file_is_bounded_even_if_its_encoded_image_is_valid(client, api, monkeypatch):
    content = encode(Image.new("RGB", (30, 30), "white"))
    monkeypatch.setattr(api, "MAX_FILE_BYTES", len(content) + 10)
    monkeypatch.setattr(api, "read_barcodes", lambda *args, **kwargs: pytest.fail("oversized file reached decoding"))
    response = upload(client, [content + b"\0" * 11])
    assert response.status_code == 413, response.text


def test_total_decoded_pixel_limit_includes_duplicate_frames(client, api, monkeypatch):
    content = encode(Image.new("RGB", (100, 100), "white"))
    monkeypatch.setattr(api, "MAX_PIXELS", 20_000)
    accepted = result(upload(client, [content, content]))
    assert accepted["confirmation"]["distinct_frames"] == 1
    monkeypatch.setattr(api, "read_barcodes", lambda *args, **kwargs: pytest.fail("over-budget pixels reached decoding"))
    response = upload(client, [content, content, content])
    assert response.status_code == 413, response.text


def test_request_body_limit_applies_before_multipart_parsing(client, api, monkeypatch):
    monkeypatch.setattr(api, "MAX_REQUEST_BYTES", 512)
    monkeypatch.setattr(api, "read_barcodes", lambda *args, **kwargs: pytest.fail("oversized request reached decoding"))
    response = client.post("/v1/pos/decode", content=iter([b"x" * 300, b"y" * 300]),
                           headers={"Content-Type": "multipart/form-data; boundary=bounded-test"})
    assert response.status_code == 413, response.text
