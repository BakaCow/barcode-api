"""Backend client. No automatic retries; POS agreement is stateless per request."""
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
import secrets
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

__all__ = ["BarcodeClient", "BarcodeApiError", "ImageUpload", "GeneratedImage"]
MAX_BYTES = 10 * 1024 * 1024
POS_FORMATS = {"qr", "code128", "ean13", "ean8", "upca", "upce", "datamatrix", "aztec", "pdf417", "code93"}


class BarcodeApiError(Exception):
    def __init__(self, status, request_id=None, retry_after=None, details=None):
        super().__init__(f"Barcode API request failed (HTTP {status}).")
        self.status = status
        self.request_id = request_id
        self.retry_after = retry_after
        self.details = details


@dataclass(frozen=True)
class ImageUpload:
    data: bytes
    filename: str = "image"
    content_type: str = "application/octet-stream"

    def __post_init__(self):
        if not isinstance(self.data, bytes) or not self.data or len(self.data) > MAX_BYTES:
            raise ValueError("Image data must be nonempty bytes of at most 10 MiB.")
        if not isinstance(self.filename, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", self.filename):
            raise ValueError("Use a short ASCII filename containing letters, digits, dots, hyphens or underscores.")
        if self.content_type not in {"application/octet-stream", "image/png", "image/jpeg", "image/webp"}:
            raise ValueError("Upload a PNG, JPEG or WebP image.")

    @classmethod
    def from_path(cls, path):
        path = Path(path)
        with path.open("rb") as source:
            data = source.read(MAX_BYTES + 1)
        # Do not embed caller-provided path names into multipart headers.
        return cls(data)


@dataclass(frozen=True)
class GeneratedImage:
    data: bytes
    content_type: str | None
    request_id: str | None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BarcodeClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 15):
        try:
            url = urlsplit(base_url)
            port = url.port
        except (ValueError, TypeError) as exc:
            raise ValueError("Provide an absolute HTTP(S) base URL.") from exc
        if not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment:
            raise ValueError("Base URL must have a host and no credentials, query or fragment.")
        if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}):
            raise ValueError("Use HTTPS, or HTTP on localhost for development.")
        if not isinstance(api_key, str) or not 24 <= len(api_key) <= 256 or not re.fullmatch(r"[!-~]+", api_key):
            raise ValueError("Provide an API key of 24–256 printable ASCII characters.")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 300:
            raise ValueError("Timeout must be between 0 and 300 seconds.")
        self._base = urlunsplit((url.scheme, url.netloc, url.path.rstrip("/") + "/", "", ""))
        self._key, self._timeout = api_key, timeout
        self._opener = build_opener(_NoRedirect())

    def _request(self, path, *, body=None, content_type=None, binary=False, authenticated=True):
        headers = {"X-API-Key": self._key} if authenticated else {}
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(self._base + path, data=body, headers=headers, method="POST" if body is not None else "GET")
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                data = response.read()
                if binary:
                    return GeneratedImage(data, response.headers.get("Content-Type"), response.headers.get("X-Request-ID"))
                return json.loads(data)
        except HTTPError as exc:
            with exc:
                try:
                    details = json.loads(exc.read()).get("detail")
                except (ValueError, AttributeError):
                    details = None
                raise BarcodeApiError(exc.code, exc.headers.get("X-Request-ID"), exc.headers.get("Retry-After"), details) from None

    def health(self):
        return self._request("health", authenticated=False)

    def formats(self):
        return self._request("v1/formats")

    def generate(self, *, format, text, output="png", scale=4):
        body = json.dumps({"format": format, "text": text, "output": output, "scale": scale}).encode()
        return self._request("v1/barcodes/generate", body=body, content_type="application/json", binary=True)

    def read(self, image: ImageUpload):
        return self._images("v1/barcodes/read", "file", [image])

    def decode_pos(self, frames: list[ImageUpload], *, allowed_formats=None, confirmation_frames=2):
        options = {"confirmation_frames": confirmation_frames}
        if type(confirmation_frames) is not int or confirmation_frames not in {1, 2, 3}:
            raise ValueError("confirmation_frames must be 1, 2 or 3.")
        if allowed_formats is not None:
            if not isinstance(allowed_formats, list) or not 1 <= len(allowed_formats) <= 10 or any(not isinstance(f, str) or f not in POS_FORMATS for f in allowed_formats) or len(set(allowed_formats)) != len(allowed_formats):
                raise ValueError("allowed_formats must contain unique supported POS formats.")
            options["allowed_formats"] = allowed_formats
        return self._images("v1/pos/decode", "frames", frames, options)

    def _images(self, path, field, images, options=None):
        if not isinstance(images, list) or not 1 <= len(images) <= 5 or any(not isinstance(image, ImageUpload) for image in images):
            raise ValueError("Provide one to five ImageUpload instances.")
        if sum(len(image.data) for image in images) > MAX_BYTES:
            raise ValueError("Combined image data exceeds 10 MiB.")
        boundary = "barcode-" + secrets.token_hex(24)
        parts = []
        for image in images:
            parts.extend([
                f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{image.filename}"\r\nContent-Type: {image.content_type}\r\n\r\n'.encode(),
                image.data, b"\r\n",
            ])
        if options is not None:
            parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n'.encode(), json.dumps(options).encode(), b"\r\n"])
        parts.append(f"--{boundary}--\r\n".encode())
        return self._request(path, body=b"".join(parts), content_type=f"multipart/form-data; boundary={boundary}")
