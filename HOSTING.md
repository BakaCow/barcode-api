# Hosting for business integrations

Version 0.8.0 adds customer keys, per-customer admission limits, metadata-only request logs and operator usage metrics. These controls run before the application buffers upload bodies. The browser camera SDK still runs locally without an API key; use the HTTP API from your own backend and keep its credentials there.

## Configure access

The existing `BARCODE_API_KEY` remains supported. It represents customer `default`. Alternatively, set `BARCODE_API_CUSTOMERS` to a JSON array:

```json
[
  {
    "id": "shop-a",
    "keys": ["REPLACE_CUSTOMER_KEY"],
    "requests_per_minute": 600,
    "max_concurrent": 2
  }
]
```

Generate independent secrets using `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Replace every placeholder; the shipped placeholders are deliberately too short to pass startup validation. Keys must contain 24–256 printable ASCII characters without spaces; the application validates shape, not entropy. Keep configuration in your deployment's secret store or a restricted environment file. The app does not automatically load `.env` files. Docker Compose loads the explicitly configured `deploy/runtime.env` file.

Customer IDs use 1–64 ASCII letters, digits, underscores or hyphens and start with a letter or digit. They appear in operator metrics and logs: use internal account aliases rather than personal data. Each customer has one to four keys. All keys for that customer share the same limits and usage counts. Keys must be unique across all customers. There can be up to 1000 JSON customer entries; combining these with the legacy key adds the `default` customer. Duplicate IDs/keys, unknown fields, malformed JSON and invalid settings stop startup.

For rotation, add a new key to the same customer's `keys` list and restart the service. Update the customer's backend, remove the old key, then restart again. For revocation, remove that key/customer and restart. Every process or replica must receive the new configuration. This project has no public key-management endpoint.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `BARCODE_API_KEY` | Unset | Existing single-customer key; at least this or customer JSON is required |
| `BARCODE_API_CUSTOMERS` | Unset | JSON array of customer IDs, keys and optional limits |
| `BARCODE_REQUESTS_PER_MINUTE` | `600` | Default limit per customer; 1–60000 |
| `BARCODE_MAX_CONCURRENT` | `2` | Default simultaneous admitted API requests per customer; 1–128 |
| `BARCODE_GLOBAL_CONCURRENT` | `4` | Simultaneous admitted API requests across customers in this process; 1–128 |
| `BARCODE_ADMIN_KEY` | Unset | Separate operator secret enabling `/ops/metrics`; must differ from every API key |
| `BARCODE_REQUEST_LOGGING` | `true` | Emit structured request metadata; exactly `true` or `false` |

An explicit empty `BARCODE_API_CUSTOMERS` value is invalid; omit it when using only the legacy key. Customer-specific limits override defaults. All authenticated `/v1` requests, including format queries and failed uploads, consume the minute budget. Rate-limited requests increment rejection counters without adding to that window's consumed budget. A concurrency rejection consumes one minute-budget request. Invalid keys receive `401` before upload consumption. Duplicate authentication headers are rejected.

## Rate and resource limits

The limiter uses monotonic, per-customer 60-second windows. Exhaustion or concurrency saturation returns `429` with a numeric `Retry-After` header. Clients should wait at least that long and use bounded retry/backoff; scanning results still need application-level duplicate transaction protection. This is a fixed-window limiter, so bursts around a window boundary can exceed a rolling-minute count.

Admission reserves a slot before image buffering and releases it after the response, failure or cancellation. Upload reading has a 15-second idle limit and a 30-second total limit; body timeouts return `408`. Existing limits still apply: up to 10 MiB of image data and 20 million decoded pixels per decode request, with bounded multipart overhead. API request body sizes are separately enforced before parsing. Generation JSON is capped at 16 KiB.

**All customer limits and usage counters are in memory in one API process.** Restarting resets them. Multiple Uvicorn workers or replicas each have independent budgets: do not advertise a shared quota by multiplying this deployment. Use one worker as configured here, or replace admission/accounting with a shared store/gateway before scaling out. These counters are operational telemetry, not durable billing records or an audit ledger.

An in-process decoder call is not forcibly interrupted by an HTTP/proxy timeout. A client or proxy timeout does not prove that native decoding stopped. CPU/memory/container limits and worker supervision provide the separate process boundary. Choose limits with real load measurements; the provided one-process defaults are a starting configuration, not a capacity promise.

## Observe without logging barcode content

Every API admission attempt receives a generated `X-Request-ID` on ordinary responses. Caller-supplied IDs are ignored. Structured log records contain only the generated request ID, configured customer ID, fixed operation label, status, elapsed milliseconds and rejection category. They contain no API keys, headers, query strings, raw URLs, uploaded image data, decoded values or IP addresses. `read`, `generate`, `pos_decode`, `formats` and `other` are bounded labels; unknown paths do not grow a label map. Framework/proxy logging is separate; the supplied deployment disables Uvicorn access logs and configures nginx with a metadata-only log format. Configure your own platform's request/error logging accordingly.

`GET /health` remains a public liveness response. It does not prove that a camera, barcode or external business database works.

`GET /ops/metrics` requires `X-Admin-Key: <operator secret>` and is disabled (`404`) without `BARCODE_ADMIN_KEY`. API customer keys cannot read metrics; the operator key cannot decode barcodes. The response reports process uptime, active requests, unauthorized API requests and per-customer admissions, completions, rate/concurrency rejections, status-class counts, operation counts and cumulative duration. Its scope is explicitly `single_process_since_start`. No key hashes or barcode values are included. Metrics use `Cache-Control: no-store` and should be collected only over a trusted private connection or HTTPS.

The supplied public nginx configuration blocks `/ops/metrics`. Operators can query it through localhost on the server. Example from a trusted PowerShell session, with the operator key already supplied securely:

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/ops/metrics" -Headers @{"X-Admin-Key"=$env:BARCODE_ADMIN_KEY}
```

Collect counters periodically with your monitoring system. Useful alerts include rising `rate_limited`/`concurrency_limited`, 5xx completions and an unhealthy process. Monitor CPU/memory and latency separately. Counters reset after restart, so a collector must handle resets.

## Container and HTTPS deployment

1. Copy `deploy/runtime.env.example` to `deploy/runtime.env`, replace every placeholder and restrict access to that file. It is ignored by Git. Select account IDs and limits for your own customers.
2. From the repository root, run `docker compose -f deploy/compose.yaml up --build -d` on a Docker host. The API listens on the host's loopback port 8000. The service runs as a non-root user with a read-only root filesystem and bounded temporary storage, memory, CPU, process count and connection admission. It runs one Uvicorn worker.
3. Install nginx (or your platform's HTTPS ingress), obtain a certificate for your own domain, and adapt `deploy/nginx.conf.example`. Replace the domain and certificate paths, validate the configuration with `nginx -t`, and reload nginx. The example is an HTTPS template, not a pre-provisioned domain or certificate.
4. Keep the application port private. Send business API calls to the HTTPS address with the customer's `X-API-Key`. Browser camera users open `/scan/` or use your embedded SDK deployment.
5. Check health, a known generated/read barcode, an invalid key, an intentional rate limit, and private metrics before admitting users. Test the target Android/iPhone hardware and representative labels separately.

No cross-origin API access is enabled by default. A web frontend should call its own authenticated backend, which holds the customer API key and forwards bounded requests. CORS does not make a browser-visible shared secret private. The local camera SDK needs no API key and does not upload camera images.

The nginx example applies an additional source-IP edge rate limit only to `/v1` API requests. Other paths use an empty limiter key, which nginx does not account. Static `/scan/` assets have no request-rate quota in this template, so a complete offline install or repair does not consume the API burst allowance. Preserve that separation when adding CDN rules: test a cold install and repair from several tills sharing an IP, and confirm **Offline ready** on each. See [nginx's limiter documentation](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) for empty-key behavior.

The proxy uses bounded body/connection timeouts and does not trust caller-supplied forwarded IP headers for application quotas. If you add a CDN or another trusted proxy, configure the edge client-address rules explicitly for that deployment; otherwise the edge limiter will see the proxy's address. See [Uvicorn's deployment guidance](https://uvicorn.dev/deployment/) and [nginx's proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) for those platform settings.

The application and admission tests exercise the Python behavior. Container/nginx templates require validation on the destination host; their inclusion does not establish uptime, throughput, failover, real-device recognition performance or a certification for a regulated workflow.
