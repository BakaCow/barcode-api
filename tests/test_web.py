"""The offline scanner is public, self-contained, and separate from the API."""

from pathlib import Path
import hashlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("BARCODE_API_KEY", "test-only-barcode-api-key")
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1]))
    from app import app

    with TestClient(app) as test_client:
        yield test_client


def test_home_redirects_to_camera_app_without_a_key(client):
    response = client.get("/", follow_redirects=False)
    assert response.status_code in {302, 307}
    assert response.headers["location"] == "/scan/"


def test_independent_decoder_notices_and_matching_sources_are_distributed(client):
    manifest = client.get('/scan/vendor/zbar/provenance.json')
    assert manifest.status_code == 200
    assert manifest.json()['license'] == 'LGPL-2.1-or-later'
    for path in ['LICENSE.txt', 'sources/zbar-0.23.90.tar.gz', 'sources/zbar-wasm-c04ab596.tar.gz']:
        response = client.get('/scan/vendor/zbar/' + path)
        assert response.status_code == 200
        assert hashlib.sha256(response.content).hexdigest() == manifest.json()['sha256'][path]
        if path.endswith('.tar.gz'):
            assert response.content[:2] == b'\x1f\x8b'
    assert 'Rebuilding or modifying' in client.get('/scan/vendor/zbar/README.md').text


def test_camera_app_is_public_while_api_still_requires_a_key(client):
    page = client.get("/scan/")
    assert page.status_code == 200
    assert page.headers["content-type"].startswith("text/html")
    assert "<video" in page.text
    assert client.get("/v1/formats").status_code == 401
    assert client.post(
        "/v1/barcodes/generate", json={"format": "qr", "text": "hello"}
    ).status_code == 401


@pytest.mark.parametrize(
    ("path", "content_type"),
    [
        ("app.js", "application/javascript"),
        ("embed.js", "application/javascript"),
        ("embed/widget.js", "application/javascript"),
        ("embed/widget.css", "text/css"),
        ("examples/embed/demo.js", "application/javascript"),
        ("examples/embed/demo.css", "text/css"),
        ("sdk/scanner.js", "application/javascript"),
        ("sdk/capture-tools.js", "application/javascript"),
        ("sdk/controls.js", "application/javascript"),
        ("sdk/controls.css", "text/css"),
        ("benchmark/benchmark.js", "application/javascript"),
        ("benchmark/adapters.mjs", "application/javascript"),
        ("benchmark/metrics.mjs", "application/javascript"),
        ("benchmark/recorder.mjs", "application/javascript"),
        ("examples/plain/app.js", "application/javascript"),
        ("examples/pos/cart.mjs", "application/javascript"),
        ("scanner-worker.js", "application/javascript"),
        ("independent-reader.js", "application/javascript"),
        ("pos-policy.js", "application/javascript"),
        ("frame-analysis.js", "application/javascript"),
        ("qr-geometry.js", "application/javascript"),
        ("qr-recovery.js", "application/javascript"),
        ("linear-signal.js", "application/javascript"),
        ("qr-signal.js", "application/javascript"),
        ("qr-damage.js", "application/javascript"),
        ("frame-fusion.js", "application/javascript"),
        ("capture-selection.js", "application/javascript"),
        ("capture-geometry.js", "application/javascript"),
        ("camera-constraints.js", "application/javascript"),
        ("code128-lab-worker.js", "application/javascript"),
        ("engine/code128-engine.js", "application/javascript"),
        ("vendor/zxing-reader.js", "application/javascript"),
        ("vendor/zxing_reader.wasm", "application/wasm"),
        ("vendor/zbar/index.js", "application/javascript"),
        ("vendor/zbar/zbar.wasm", "application/wasm"),
        ("manifest.webmanifest", "application/manifest+json"),
    ],
)
def test_local_scanning_assets_have_the_expected_types(client, path, content_type):
    response = client.get(f"/scan/{path}")
    assert response.status_code == 200
    assert response.content
    assert response.headers["content-type"].split(";")[0] == content_type
    if path.endswith(".wasm"):
        assert response.content[:4] == b"\0asm"


def test_service_worker_is_revalidated_and_has_only_scanner_scope(client):
    response = client.get("/scan/sw.js")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["content-type"] == "application/javascript"
    assert "service-worker-allowed" not in response.headers
    assert client.get("/sw.js").status_code == 404


def test_unknown_asset_is_not_replaced_with_the_app_shell(client):
    response = client.get("/scan/vendor/missing.wasm")
    assert response.status_code == 404


def test_experimental_lab_is_served_independently_from_default_scanner(client):
    response = client.get("/scan/lab/")
    assert response.status_code == 200
    assert "Code 128 lab" in response.text
    assert "./lab-policy.js" in response.text
    assert "./lab/" in client.get("/scan/").text


def test_static_mount_does_not_expose_backend_source(client):
    assert client.get("/scan/app.py").status_code == 404
    assert client.get("/scan/%2e%2e/app.py").status_code == 404


def test_static_mount_is_independent_of_working_directory(client, monkeypatch):
    monkeypatch.chdir(Path(__file__).resolve().parents[3])
    response = client.get("/scan/")
    assert response.status_code == 200
    assert "<video" in response.text
