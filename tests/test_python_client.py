"""Real HTTP multipart client round-trips through the production FastAPI app."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clients" / "python"))
from barcode_api_client import BarcodeClient, BarcodeApiError, ImageUpload
from app import app

KEY = "python-client-test-key-not-a-secret"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BARCODE_API_KEY", KEY)
    with TestClient(app) as target:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/redirect":
                    self.send_response(307); self.send_header("Location", "/health"); self.end_headers(); return
                self.forward()

            def do_POST(self):
                self.forward()

            def forward(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                response = target.request(self.command, self.path, headers=dict(self.headers), content=body)
                self.send_response(response.status_code)
                for name, value in response.headers.items():
                    self.send_header(name, value)
                self.end_headers(); self.wfile.write(response.content)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            yield BarcodeClient(f"http://127.0.0.1:{server.server_port}", KEY)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_generation_and_read_roundtrip(client):
    image = client.generate(format="qr", text="0000123 日本語")
    assert image.content_type == "image/png"
    result = client.read(ImageUpload(image.data))
    assert result["barcodes"][0]["text"] == "0000123 日本語"
    assert client.health() == {"status": "ok"}
    assert "qr" in client.formats()["pos"]["formats"]


def test_pos_roundtrip_preserves_duplicate_image_policy(client):
    image = ImageUpload(client.generate(format="code128", text="000123").data)
    accepted = client.decode_pos([image], allowed_formats=["code128"], confirmation_frames=1)
    assert accepted["status"] == "confirmed"
    assert accepted["barcode"]["text"] == "000123"
    duplicate = client.decode_pos([image, image], allowed_formats=["code128"])
    assert duplicate["status"] == "rescan"
    assert duplicate["confirmation"]["distinct_frames"] == 1


def test_pos_ambiguity_roundtrip(client):
    images = [ImageUpload(client.generate(format="qr", text=value).data) for value in ("ONE", "TWO")]
    assert client.decode_pos(images, confirmation_frames=1)["status"] == "ambiguous"


def test_typed_server_errors_and_redirect_rejection(client):
    with pytest.raises(BarcodeApiError) as invalid:
        client.generate(format="ean13", text="bad")
    assert invalid.value.status == 422
    assert KEY not in str(invalid.value)
    with pytest.raises(BarcodeApiError) as redirect:
        client._request("redirect")
    assert redirect.value.status == 307


@pytest.mark.parametrize("base", ["http://example.com", "ftp://localhost", "https://x:y@example.com", "https://example.com/?secret=x", "bogus"])
def test_bad_base_urls(base):
    with pytest.raises(ValueError):
        BarcodeClient(base, KEY)


def test_image_boundaries_and_injection_prevention(tmp_path):
    for filename in ['bad"name', "x\r\nInjected: true", "../secret"]:
        with pytest.raises(ValueError):
            ImageUpload(b"x", filename)
    for data in [b"", b"x" * (10 * 1024 * 1024 + 1)]:
        with pytest.raises(ValueError):
            ImageUpload(data)
    path = tmp_path / "non-ascii 名前.png"; path.write_bytes(b"test")
    assert ImageUpload.from_path(path).data == b"test"


def test_invalid_pos_inputs_fail_locally():
    client = BarcodeClient("https://example.com", KEY)
    for frames in [[], [ImageUpload(b"x")] * 6, [b"x"]]:
        with pytest.raises(ValueError):
            client.decode_pos(frames)
    for confirmation in [True, 0, 4]:
        with pytest.raises(ValueError):
            client.decode_pos([ImageUpload(b"x")], confirmation_frames=confirmation)
    with pytest.raises(ValueError):
        client.decode_pos([ImageUpload(b"x")], allowed_formats=["qr", "qr"])
