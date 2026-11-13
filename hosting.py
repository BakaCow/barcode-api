"""Bounded, single-process admission and metadata-only usage accounting.

This is not a distributed quota or billing system. Configuration is immutable
for the lifetime of the process; restart the service after key rotation.
"""

from collections import Counter
import asyncio
from dataclasses import dataclass, field
import hashlib
import json
import logging
import math
import os
import re
import secrets
import threading
import time

from starlette.responses import JSONResponse


LOGGER = logging.getLogger("barcode.requests")
CUSTOMER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
OPERATIONS = {
    ("GET", "/v1/formats"): "formats",
    ("POST", "/v1/barcodes/read"): "read",
    ("POST", "/v1/barcodes/generate"): "generate",
    ("POST", "/v1/pos/decode"): "pos_decode",
}


def _integer(value, name, *, maximum, default=None):
    if value is None and default is not None:
        return default
    if isinstance(value, str) and value.isascii() and value.isdecimal():
        value = int(value)
    if type(value) is not int or not 1 <= value <= maximum:
        raise RuntimeError(f"{name} must be an integer from 1 to {maximum}.")
    return value


def _key(value, name):
    if (not isinstance(value, str) or not 24 <= len(value) <= 256
            or not value.isascii() or any(ord(char) < 33 or ord(char) > 126 for char in value)):
        raise RuntimeError(f"{name} must contain 24–256 printable ASCII characters without spaces.")
    return hashlib.sha256(value.encode("ascii")).digest()


def _unique_fields(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("Duplicate JSON field.")
        result[name] = value
    return result


@dataclass(frozen=True)
class Customer:
    id: str
    requests_per_minute: int
    max_concurrent: int


@dataclass(frozen=True)
class HostingConfig:
    customers: tuple[Customer, ...]
    key_owners: dict[bytes, str] = field(repr=False)
    admin_digest: bytes | None = field(repr=False)
    global_concurrent: int = 4
    request_logging: bool = True

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        rate = _integer(env.get("BARCODE_REQUESTS_PER_MINUTE"), "BARCODE_REQUESTS_PER_MINUTE", maximum=60000, default=600)
        concurrency = _integer(env.get("BARCODE_MAX_CONCURRENT"), "BARCODE_MAX_CONCURRENT", maximum=128, default=2)
        total = _integer(env.get("BARCODE_GLOBAL_CONCURRENT"), "BARCODE_GLOBAL_CONCURRENT", maximum=128, default=4)
        logging_value = env.get("BARCODE_REQUEST_LOGGING", "true")
        if logging_value not in {"true", "false"}:
            raise RuntimeError("BARCODE_REQUEST_LOGGING must be true or false.")
        customers = []
        owners = {}
        customer_ids = set()

        def add_customer(item):
            if not isinstance(item, dict) or set(item) - {"id", "keys", "requests_per_minute", "max_concurrent"}:
                raise RuntimeError("Each BARCODE_API_CUSTOMERS entry must contain only id, keys and optional limits.")
            identity = item.get("id")
            if not isinstance(identity, str) or CUSTOMER_ID.fullmatch(identity) is None or identity in customer_ids:
                raise RuntimeError("Customer IDs must be unique, 1–64 ASCII letters/digits/underscores/hyphens, starting with a letter or digit.")
            keys = item.get("keys")
            if not isinstance(keys, list) or not 1 <= len(keys) <= 4:
                raise RuntimeError("Each customer must have between one and four keys.")
            customer = Customer(identity,
                _integer(item.get("requests_per_minute"), "Customer requests_per_minute", maximum=60000, default=rate),
                _integer(item.get("max_concurrent"), "Customer max_concurrent", maximum=128, default=concurrency))
            for key in keys:
                digest = _key(key, "Customer key")
                if digest in owners:
                    raise RuntimeError("API keys must be unique across all customer entries.")
                owners[digest] = identity
            customer_ids.add(identity)
            customers.append(customer)

        legacy = env.get("BARCODE_API_KEY", "")
        if legacy:
            add_customer({"id": "default", "keys": [legacy]})
        raw = env.get("BARCODE_API_CUSTOMERS")
        if raw is not None:
            if len(raw) > 1024 * 1024:
                raise RuntimeError("BARCODE_API_CUSTOMERS exceeds the 1 MiB configuration limit.")
            try:
                entries = json.loads(raw, object_pairs_hook=_unique_fields)
            except (TypeError, ValueError, RecursionError) as exc:
                raise RuntimeError("BARCODE_API_CUSTOMERS must be a valid JSON array with unique fields.") from None
            if not isinstance(entries, list) or not 1 <= len(entries) <= 1000:
                raise RuntimeError("BARCODE_API_CUSTOMERS must contain between one and 1000 customers.")
            for item in entries:
                add_customer(item)
        if not customers:
            raise RuntimeError("Set BARCODE_API_KEY to a secret of at least 24 characters or configure BARCODE_API_CUSTOMERS.")
        admin = env.get("BARCODE_ADMIN_KEY", "")
        admin_digest = _key(admin, "BARCODE_ADMIN_KEY") if admin else None
        if admin_digest in owners:
            raise RuntimeError("BARCODE_ADMIN_KEY must be different from every customer API key.")
        return cls(tuple(customers), owners, admin_digest, total, logging_value == "true")


@dataclass
class Usage:
    window_started: float
    window_requests: int = 0
    active: int = 0
    admitted: int = 0
    rate_limited: int = 0
    concurrency_limited: int = 0
    completed: int = 0
    duration_ms: float = 0
    operations: Counter = field(default_factory=Counter)
    statuses: Counter = field(default_factory=Counter)


class HostingState:
    def __init__(self, config, *, clock=time.monotonic):
        self.config = config
        self.clock = clock
        self.started = clock()
        self.customers = {customer.id: customer for customer in config.customers}
        self.usage = {customer.id: Usage(self.started) for customer in config.customers}
        self.active = 0
        self.unauthorized = 0
        self.lock = threading.Lock()
        if config.request_logging:
            LOGGER.setLevel(logging.INFO)
            if not LOGGER.handlers:
                LOGGER.addHandler(logging.StreamHandler())

    def authenticate(self, key):
        if not isinstance(key, bytes) or not 24 <= len(key) <= 256:
            return None
        return self.config.key_owners.get(hashlib.sha256(key).digest())

    def authenticate_admin(self, key):
        return (isinstance(key, bytes) and 24 <= len(key) <= 256
                and self.config.admin_digest is not None
                and secrets.compare_digest(hashlib.sha256(key).digest(), self.config.admin_digest))

    def admit(self, customer_id):
        """Reserve before reading the body. All keys of a customer share limits."""
        with self.lock:
            now = self.clock()
            customer = self.customers[customer_id]
            usage = self.usage[customer_id]
            if now - usage.window_started >= 60:
                usage.window_started = now
                usage.window_requests = 0
            if usage.window_requests >= customer.requests_per_minute:
                usage.rate_limited += 1
                return "rate_limit", max(1, math.ceil(60 - (now - usage.window_started)))
            usage.window_requests += 1
            if usage.active >= customer.max_concurrent or self.active >= self.config.global_concurrent:
                usage.concurrency_limited += 1
                return "concurrency_limit", 1
            usage.active += 1
            self.active += 1
            usage.admitted += 1
            return None, None

    def finish(self, customer_id, operation, status, elapsed_ms):
        with self.lock:
            usage = self.usage[customer_id]
            usage.active -= 1
            self.active -= 1
            usage.completed += 1
            usage.duration_ms += max(0, elapsed_ms)
            usage.operations[operation] += 1
            bucket = f"{status // 100}xx" if 100 <= status <= 599 else "other"
            usage.statuses[bucket] += 1

    def reject_authentication(self):
        with self.lock:
            self.unauthorized += 1

    def snapshot(self):
        with self.lock:
            return {
                "scope": "single_process_since_start",
                "uptime_seconds": round(max(0, self.clock() - self.started), 3),
                "active_requests": self.active,
                "global_concurrent_limit": self.config.global_concurrent,
                "unauthorized_requests": self.unauthorized,
                "customers": {
                    identity: {
                        "requests_per_minute": self.customers[identity].requests_per_minute,
                        "max_concurrent": self.customers[identity].max_concurrent,
                        "active": usage.active,
                        "admitted": usage.admitted,
                        "completed": usage.completed,
                        "rate_limited": usage.rate_limited,
                        "concurrency_limited": usage.concurrency_limited,
                        "duration_ms_total": round(usage.duration_ms, 3),
                        "operations": dict(usage.operations),
                        "statuses": dict(usage.statuses),
                    } for identity, usage in self.usage.items()
                },
            }


def _single_header(scope, name):
    values = [value for key, value in scope.get("headers", ()) if key.lower() == name]
    return values[0] if len(values) == 1 else None


class BusinessControls:
    """Pure ASGI middleware: auth and admission precede upload buffering."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        is_api = path == "/v1" or path.startswith("/v1/")
        is_metrics = path == "/ops/metrics"
        if scope["type"] != "http" or not (is_api or is_metrics):
            return await self.app(scope, receive, send)
        state = getattr(scope["app"].state, "hosting", None)
        if state is None:
            return await JSONResponse({"detail": "Service is not ready."}, status_code=503)(scope, receive, send)
        request_id = secrets.token_hex(16)  # Do not trust an inbound ID or forward it to logs.
        scope.setdefault("state", {})["barcode_request_id"] = request_id
        customer_id = None
        operation = "metrics" if is_metrics else OPERATIONS.get((scope.get("method"), path), "other")
        admitted = False
        status = 500
        started = state.clock()
        reason = None

        async def instrumented_send(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                message = dict(message)
                message["headers"] = [(key, value) for key, value in message.get("headers", ())
                                      if key.lower() not in {b"x-request-id", b"cache-control"}]
                message["headers"].extend([(b"x-request-id", request_id.encode("ascii")),
                                           (b"cache-control", b"no-store")])
            await send(message)

        async def reject(code, detail, *, retry_after=None):
            headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
            await JSONResponse({"detail": detail}, status_code=code, headers=headers)(scope, receive, instrumented_send)

        try:
            if is_metrics:
                if state.config.admin_digest is None:
                    reason = "disabled"
                    return await reject(404, "Not found.")
                if not state.authenticate_admin(_single_header(scope, b"x-admin-key")):
                    reason = "unauthorized"
                    return await reject(401, "Invalid or missing operator key.")
                scope["state"]["barcode_operator"] = True
                return await self.app(scope, receive, instrumented_send)
            customer_id = state.authenticate(_single_header(scope, b"x-api-key"))
            if customer_id is None:
                state.reject_authentication()
                reason = "unauthorized"
                return await reject(401, "Invalid or missing API key.")
            reason, retry_after = state.admit(customer_id)
            if reason:
                return await reject(429, "Request limit reached. Retry later.", retry_after=retry_after)
            admitted = True
            scope["state"]["barcode_customer_id"] = customer_id
            await self.app(scope, receive, instrumented_send)
        except asyncio.CancelledError:
            status = 499
            raise
        finally:
            elapsed = max(0, (state.clock() - started) * 1000)
            if admitted:
                state.finish(customer_id, operation, status, elapsed)
            if state.config.request_logging:
                LOGGER.info(json.dumps({
                    "event": "barcode_request", "request_id": request_id,
                    "customer_id": customer_id, "operation": operation,
                    "status": status, "duration_ms": round(elapsed, 3), "rejection": reason,
                }, separators=(",", ":")))
