"""Business controls, exercised before upload parsing and across key rotations."""

import asyncio
from contextlib import contextmanager
import json
import logging
from pathlib import Path
import re
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hosting import BusinessControls, HostingConfig, HostingState


KEY_A = "customer-a-test-key-123456789"
KEY_A_ROTATED = "customer-a-rotated-test-123456789"
KEY_B = "customer-b-test-key-123456789"
ADMIN = "operator-test-key-123456789"
ENV_NAMES = ("BARCODE_API_KEY", "BARCODE_API_CUSTOMERS", "BARCODE_ADMIN_KEY",
             "BARCODE_REQUESTS_PER_MINUTE", "BARCODE_MAX_CONCURRENT",
             "BARCODE_GLOBAL_CONCURRENT", "BARCODE_REQUEST_LOGGING")


def environment(**overrides):
    return {"BARCODE_API_CUSTOMERS": json.dumps([
        {"id": "shop-a", "keys": [KEY_A, KEY_A_ROTATED]},
        {"id": "shop-b", "keys": [KEY_B]},
    ]), "BARCODE_REQUEST_LOGGING": "false", **overrides}


@contextmanager
def api_client(monkeypatch, **overrides):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    for name, value in environment(**overrides).items():
        monkeypatch.setenv(name, value)
    import app
    with TestClient(app.app) as client:
        yield client


def scope(state, key=KEY_A, path="/v1/barcodes/read", **extra):
    return {"type": "http", "http_version": "1.1", "method": "POST", "scheme": "http",
            "path": path, "raw_path": path.encode(), "query_string": b"",
            "headers": [(b"x-api-key", key.encode())] if key else [],
            "app": SimpleNamespace(state=SimpleNamespace(hosting=state)), **extra}


async def no_body():
    raise AssertionError("Rejected request body was read")


async def ok_app(request_scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


async def invoke(middleware, request_scope, receive=no_body):
    sent = []
    async def send(message):
        sent.append(message)
    await middleware(request_scope, receive, send)
    return sent


def test_legacy_key_works_and_limits_have_defaults():
    state = HostingState(HostingConfig.from_env({"BARCODE_API_KEY": KEY_A}))
    assert state.authenticate(KEY_A.encode()) == "default"
    assert state.customers["default"].requests_per_minute == 600
    assert state.config.global_concurrent == 4


@pytest.mark.parametrize("values", [
    {}, {"BARCODE_API_KEY": "short"},
    {"BARCODE_API_KEY": " " * 24},
    environment(BARCODE_API_CUSTOMERS="no-json"),
    environment(BARCODE_API_CUSTOMERS="[]"),
    environment(BARCODE_API_CUSTOMERS="{}"),
    environment(BARCODE_API_CUSTOMERS='[{"id":"a","id":"b","keys":[]}]'),
    environment(BARCODE_API_CUSTOMERS=json.dumps([{"id": "bad\nname", "keys": [KEY_A]}])),
    environment(BARCODE_API_CUSTOMERS=json.dumps([{"id": "a", "keys": [KEY_A], "extra": True}])),
    environment(BARCODE_API_CUSTOMERS=json.dumps([{"id": "a", "keys": []}])),
    environment(BARCODE_API_CUSTOMERS=json.dumps([{"id": "a", "keys": [KEY_A, KEY_A]}])),
    environment(BARCODE_API_CUSTOMERS=json.dumps([{"id": "a", "keys": [KEY_A]}, {"id": "a", "keys": [KEY_B]}])),
    environment(BARCODE_API_CUSTOMERS=json.dumps([{"id": "a", "keys": [KEY_A]}, {"id": "b", "keys": [KEY_A]}])),
    environment(BARCODE_API_CUSTOMERS=json.dumps([{"id": "a", "keys": [KEY_A], "max_concurrent": False}])),
    environment(BARCODE_REQUESTS_PER_MINUTE="0"), environment(BARCODE_REQUESTS_PER_MINUTE="NaN"),
    environment(BARCODE_MAX_CONCURRENT="129"), environment(BARCODE_GLOBAL_CONCURRENT="0"),
    environment(BARCODE_REQUEST_LOGGING="maybe"), environment(BARCODE_ADMIN_KEY="short"),
    environment(BARCODE_ADMIN_KEY=KEY_A),
])
def test_invalid_configuration_fails_closed_without_secret_echo(values):
    with pytest.raises(RuntimeError) as caught:
        HostingConfig.from_env(values)
    assert KEY_A not in str(caught.value)
    assert KEY_B not in str(caught.value)


def test_configuration_caps_untrusted_number_of_accounts_and_keys():
    entries = [{"id": f"shop-{index}", "keys": [f"test-key-{index:024d}"]} for index in range(1001)]
    with pytest.raises(RuntimeError, match="1000"):
        HostingConfig.from_env(environment(BARCODE_API_CUSTOMERS=json.dumps(entries)))
    entries = [{"id": "shop", "keys": [f"test-key-{index:024d}" for index in range(5)]}]
    with pytest.raises(RuntimeError, match="four keys"):
        HostingConfig.from_env(environment(BARCODE_API_CUSTOMERS=json.dumps(entries)))


def test_keys_are_hashed_in_runtime_configuration():
    config = HostingConfig.from_env(environment(BARCODE_ADMIN_KEY=ADMIN))
    representation = repr(config)
    for key in [KEY_A, KEY_A_ROTATED, KEY_B, ADMIN]:
        assert key not in representation
        assert key.encode() not in config.key_owners


def test_rotated_keys_share_rate_limit_and_other_customer_is_independent():
    clock = [100.0]
    state = HostingState(HostingConfig.from_env(environment(BARCODE_REQUESTS_PER_MINUTE="2")), clock=lambda: clock[0])
    async def exercise():
        middleware = BusinessControls(ok_app)
        assert (await invoke(middleware, scope(state, KEY_A)))[0]["status"] == 200
        assert (await invoke(middleware, scope(state, KEY_A_ROTATED)))[0]["status"] == 200
        response = await invoke(middleware, scope(state, KEY_A))
        assert response[0]["status"] == 429
        assert dict(response[0]["headers"])[b"retry-after"] == b"60"
        assert (await invoke(middleware, scope(state, KEY_B)))[0]["status"] == 200
        clock[0] = 159.9
        response = await invoke(middleware, scope(state, KEY_A_ROTATED))
        assert response[0]["status"] == 429
        assert dict(response[0]["headers"])[b"retry-after"] == b"1"
        clock[0] = 160
        assert (await invoke(middleware, scope(state, KEY_A_ROTATED)))[0]["status"] == 200
    asyncio.run(exercise())
    assert state.snapshot()["customers"]["shop-a"]["rate_limited"] == 2


def test_removing_old_key_revokes_it_after_reload():
    old_state = HostingState(HostingConfig.from_env(environment()))
    new_state = HostingState(HostingConfig.from_env(environment(BARCODE_API_CUSTOMERS=json.dumps([
        {"id": "shop-a", "keys": [KEY_A_ROTATED]}
    ]))))
    assert old_state.authenticate(KEY_A.encode()) == "shop-a"
    assert new_state.authenticate(KEY_A.encode()) is None
    assert new_state.authenticate(KEY_A_ROTATED.encode()) == "shop-a"


@pytest.mark.parametrize("key", [None, "incorrect", "z" * 257])
def test_unauthorized_requests_reject_before_body_consumption(key):
    state = HostingState(HostingConfig.from_env(environment()))
    response = asyncio.run(invoke(BusinessControls(ok_app), scope(state, key)))
    assert response[0]["status"] == 401
    assert state.snapshot()["active_requests"] == 0
    assert state.snapshot()["unauthorized_requests"] == 1


def test_duplicate_auth_headers_are_not_accepted():
    state = HostingState(HostingConfig.from_env(environment()))
    request = scope(state)
    request["headers"].append((b"X-API-Key", KEY_A.encode()))
    response = asyncio.run(invoke(BusinessControls(ok_app), request))
    assert response[0]["status"] == 401


def test_concurrency_limits_cover_rotated_keys_and_are_released_on_cancellation():
    state = HostingState(HostingConfig.from_env(environment(BARCODE_MAX_CONCURRENT="1", BARCODE_GLOBAL_CONCURRENT="2")))
    async def exercise():
        started = asyncio.Event()
        parked = asyncio.Event()
        async def slow_app(request, receive, send):
            if request["state"]["barcode_customer_id"] == "shop-a":
                started.set()
                await parked.wait()
            await ok_app(request, receive, send)
        middleware = BusinessControls(slow_app)
        first = asyncio.create_task(invoke(middleware, scope(state)))
        await started.wait()
        assert state.active == 1
        assert (await invoke(middleware, scope(state, KEY_A_ROTATED)))[0]["status"] == 429
        assert (await invoke(middleware, scope(state, KEY_B)))[0]["status"] == 200
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        assert state.active == 0
        parked.set()
        assert (await invoke(middleware, scope(state, KEY_A)))[0]["status"] == 200
    asyncio.run(exercise())
    assert state.snapshot()["customers"]["shop-a"]["statuses"]["4xx"] == 1


def test_global_concurrency_limits_distinct_customers():
    state = HostingState(HostingConfig.from_env(environment(BARCODE_GLOBAL_CONCURRENT="1")))
    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()
        async def slow_app(request, receive, send):
            started.set()
            await release.wait()
            await ok_app(request, receive, send)
        middleware = BusinessControls(slow_app)
        first = asyncio.create_task(invoke(middleware, scope(state)))
        await started.wait()
        assert (await invoke(middleware, scope(state, KEY_B)))[0]["status"] == 429
        release.set()
        await first
        assert state.active == 0
    asyncio.run(exercise())


def test_exception_releases_reservation_and_records_failure():
    state = HostingState(HostingConfig.from_env(environment()))
    async def broken_app(request, receive, send):
        raise ValueError("private exception text")
    with pytest.raises(ValueError):
        asyncio.run(invoke(BusinessControls(broken_app), scope(state)))
    assert state.active == 0
    assert state.snapshot()["customers"]["shop-a"]["statuses"] == {"5xx": 1}


def test_structured_logs_and_request_ids_exclude_caller_data(caplog):
    state = HostingState(HostingConfig.from_env(environment(BARCODE_REQUEST_LOGGING="true")))
    request = scope(state, path="/v1/unknown/secret-label")
    request["headers"] += [(b"x-request-id", b"unsafe\r\nlog-injection"), (b"x-forwarded-for", b"private-client")]
    request["query_string"] = b"text=secret-product"
    with caplog.at_level(logging.INFO, logger="barcode.requests"):
        response = asyncio.run(invoke(BusinessControls(ok_app), request))
    event = json.loads(caplog.records[-1].message)
    assert event["operation"] == "other"
    assert re.fullmatch(r"[0-9a-f]{32}", event["request_id"])
    assert dict(response[0]["headers"])[b"x-request-id"].decode() == event["request_id"]
    for forbidden in [KEY_A, "secret-label", "secret-product", "unsafe", "private-client"]:
        assert forbidden not in caplog.text
        assert forbidden not in json.dumps(state.snapshot())


def test_real_api_uses_multiple_keys_and_operator_only_metrics(monkeypatch):
    with api_client(monkeypatch, BARCODE_ADMIN_KEY=ADMIN) as client:
        assert client.get("/health").status_code == 200
        for key in [KEY_A, KEY_A_ROTATED, KEY_B]:
            response = client.get("/v1/formats", headers={"X-API-Key": key})
            assert response.status_code == 200
            assert re.fullmatch(r"[0-9a-f]{32}", response.headers["x-request-id"])
            assert response.headers["cache-control"] == "no-store"
        for headers in [{}, {"X-API-Key": KEY_A}, {"X-Admin-Key": KEY_A}]:
            assert client.get("/ops/metrics", headers=headers).status_code == 401
        response = client.get("/ops/metrics", headers={"X-Admin-Key": ADMIN})
        assert response.status_code == 200
        report = response.json()
        assert report["customers"]["shop-a"]["completed"] == 2
        assert report["customers"]["shop-b"]["completed"] == 1
        assert report["scope"] == "single_process_since_start"
        assert all(key not in response.text for key in [KEY_A, KEY_B, ADMIN])
        assert client.get("/v1/formats", headers={"X-API-Key": ADMIN}).status_code == 401


def test_metrics_disabled_without_operator_key(monkeypatch):
    with api_client(monkeypatch) as client:
        assert client.get("/ops/metrics", headers={"X-Admin-Key": ADMIN}).status_code == 404


def test_real_app_authentication_precedes_body_limit(monkeypatch):
    with api_client(monkeypatch) as client:
        response = client.post("/v1/barcodes/generate", content=b"x" * 20000)
        assert response.status_code == 401
        response = client.post("/v1/barcodes/generate", content=b"x" * 20000,
                               headers={"X-API-Key": KEY_A})
        assert response.status_code == 413


def test_real_app_limit_response_and_upload_error_release_slots(monkeypatch):
    with api_client(monkeypatch, BARCODE_REQUESTS_PER_MINUTE="2", BARCODE_ADMIN_KEY=ADMIN) as client:
        assert client.post("/v1/barcodes/read", headers={"X-API-Key": KEY_A},
                           files={"file": ("bad.png", b"bad", "image/png")}).status_code == 400
        assert client.get("/v1/formats", headers={"X-API-Key": KEY_A_ROTATED}).status_code == 200
        limited = client.get("/v1/formats", headers={"X-API-Key": KEY_A})
        assert limited.status_code == 429
        assert 1 <= int(limited.headers["retry-after"]) <= 60
        report = client.get("/ops/metrics", headers={"X-Admin-Key": ADMIN}).json()
        assert report["active_requests"] == 0
        assert report["customers"]["shop-a"]["statuses"] == {"4xx": 1, "2xx": 1}


def test_body_timeout_releases_reserved_slot(monkeypatch):
    import app
    monkeypatch.setattr(app, "BODY_IDLE_SECONDS", 0.01)
    state = HostingState(HostingConfig.from_env(environment()))
    async def never_arrives():
        await asyncio.sleep(5)
    async def exercise():
        middleware = BusinessControls(app.RequestSizeLimit(ok_app))
        response = await invoke(middleware, scope(state), never_arrives)
        assert response[0]["status"] == 408
        assert state.active == 0
    asyncio.run(exercise())


def test_public_non_api_post_does_not_allocate_upload_buffer():
    import app
    state = HostingState(HostingConfig.from_env(environment()))
    response = asyncio.run(invoke(BusinessControls(app.RequestSizeLimit(ok_app)),
                                 scope(state, key=None, path="/scan/nonexistent")))
    assert response[0]["status"] == 200
    assert state.active == 0
    assert state.snapshot()["customers"]["shop-a"]["admitted"] == 0


def test_deployment_template_cannot_start_with_known_placeholder_credentials():
    template = Path(__file__).resolve().parents[1] / "deploy" / "runtime.env.example"
    values = {}
    for line in template.read_text().splitlines():
        if line and not line.startswith("#"):
            name, value = line.split("=", 1)
            values[name] = value.strip("'")
    with pytest.raises(RuntimeError, match="24"):
        HostingConfig.from_env(values)
