# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Extend the existing barcode API with live camera scanning that decodes locally and remains usable offline after its files have been cached. Preserve barcode reading and generation API endpoints.

## Capabilities and Constraints

The user requested a Scanbot-like live, offline scanning experience. No claim of Scanbot-equivalent performance is established. Camera access requires a secure origin and user permission. Offline readiness depends on successful initial caching; browser storage can be evicted. Existing distribution is the user's GitHub repository and manually uploaded project ZIPs. No new hosting provider is authorized by this feature request.

## Operating Context

Existing Python/FastAPI backend. This addition uses plain browser HTML/CSS/JavaScript and a locally bundled WebAssembly reader. The interface targets phone and desktop browsers; the specific user's target device is not yet known. Scanner frames and imported images are processed on-device. Scan history is session-only unless the user opts into storage on that device.
