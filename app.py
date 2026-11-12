"""Small HTTP API for barcode generation and image decoding."""

import base64
from contextlib import asynccontextmanager
from io import BytesIO
import os
from pathlib import Path
import secrets
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.security import APIKeyHeader
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.responses import JSONResponse, RedirectResponse
import zxingcpp
from barcode_reader import read_barcodes

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 20_000_000
MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024
FORMATS = {
    "qr": zxingcpp.BarcodeFormat.QRCode,
    "code128": zxingcpp.BarcodeFormat.Code128,
    "ean13": zxingcpp.BarcodeFormat.EAN13,
    "upca": zxingcpp.BarcodeFormat.UPCA,
}


class RequestSizeLimit:
    """Bound the request body before multipart parsing, including chunked uploads."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        limit = 16 * 1024 if scope["path"].endswith("/generate") else MAX_REQUEST_BYTES
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > limit:
                response = JSONResponse({"detail": "Request body is too large."}, status_code=413)
                return await response(scope, receive, send)
            if not message.get("more_body", False):
                break

        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


@asynccontextmanager
async def lifespan(app: FastAPI):
    key = os.environ.get("BARCODE_API_KEY", "")
    if len(key) < 24:
        raise RuntimeError("Set BARCODE_API_KEY to a secret of at least 24 characters.")
    app.state.api_key = key.encode("utf-8")
    yield


app = FastAPI(
    title="Barcode API",
    version="0.4.0",
    description="Read codes from images and generate QR, Code 128, EAN-13, and UPC-A images.",
    lifespan=lifespan,
)
app.add_middleware(RequestSizeLimit)
key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def require_key(request: Request, key: Annotated[str | None, Depends(key_header)]):
    if key is None or not secrets.compare_digest(key.encode("utf-8"), request.app.state.api_key):
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")


router = APIRouter(prefix="/v1", dependencies=[Depends(require_key)])


class GenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["qr", "code128", "ean13", "upca"] = "qr"
    text: str = Field(min_length=1, max_length=2048)
    output: Literal["png", "svg"] = "png"
    scale: int = Field(default=4, ge=1, le=8, strict=True)

    @model_validator(mode="after")
    def validate_content(self):
        if self.format in ("ean13", "upca"):
            length = 13 if self.format == "ean13" else 12
            if len(self.text) != length or not self.text.isascii() or not self.text.isdigit():
                raise ValueError(f"{self.format} requires exactly {length} ASCII digits, including the check digit.")
            checksum = sum(int(digit) * (3 if index % 2 == 0 else 1)
                           for index, digit in enumerate(reversed(self.text[:-1])))
            if (10 - checksum % 10) % 10 != int(self.text[-1]):
                raise ValueError("Invalid barcode check digit.")
        if self.format == "code128" and (
            len(self.text) > 128 or any(ord(char) < 32 or ord(char) > 126 for char in self.text)
        ):
            raise ValueError("Code 128 accepts 1 to 128 printable ASCII characters in this API.")
        return self


class Point(BaseModel):
    x: int
    y: int


class BarcodeResult(BaseModel):
    text: str
    format: str
    bytes_base64: str
    position: list[Point]


class ImageSize(BaseModel):
    width: int
    height: int


class ReadResponse(BaseModel):
    barcodes: list[BarcodeResult]
    image: ImageSize


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", include_in_schema=False)
def scanner_home():
    return RedirectResponse(url="/scan/")


@router.get("/formats")
def formats():
    return {"generate": list(FORMATS), "read": "All formats supported by ZXing-C++"}


@router.post("/barcodes/generate", response_class=Response, responses={
    200: {"content": {"image/png": {}, "image/svg+xml": {}}},
})
def generate(payload: GenerateRequest):
    """Generate an image. EAN-13 and UPC-A require a valid, complete check digit."""
    try:
        code = zxingcpp.create_barcode(payload.text, FORMATS[payload.format])
        if payload.output == "svg":
            return Response(
                code.to_svg(scale=payload.scale, add_quiet_zones=True),
                media_type="image/svg+xml",
                headers={"Content-Disposition": 'attachment; filename="barcode.svg"',
                         "Cache-Control": "no-store"},
            )
        pixels = code.to_image(scale=payload.scale, add_quiet_zones=True)
        buffer = BytesIO()
        Image.fromarray(pixels).save(buffer, format="PNG")
        return Response(buffer.getvalue(), media_type="image/png", headers={
            "Content-Disposition": 'attachment; filename="barcode.png"',
            "Cache-Control": "no-store",
        })
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(422, "Text cannot be encoded in the requested barcode format.") from exc


@router.post("/barcodes/read", response_model=ReadResponse)
def read(file: UploadFile, response: Response):
    """Read PNG, JPEG, or WebP. Positions use EXIF-normalized image coordinates."""
    try:
        content = file.file.read(MAX_FILE_BYTES + 1)
    finally:
        file.file.close()
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(413, "Image exceeds the 10 MiB file limit.")
    try:
        with Image.open(BytesIO(content)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"}:
                raise HTTPException(415, "Upload a PNG, JPEG, or WebP image.")
            if source.width * source.height > MAX_PIXELS:
                raise HTTPException(413, "Image exceeds the 20 megapixel limit.")
            if getattr(source, "n_frames", 1) != 1:
                raise HTTPException(415, "Animated and multi-frame images are not supported.")
            normalized = ImageOps.exif_transpose(source).convert("RGBA")
            # Composite transparency on white so transparent backgrounds remain readable.
            background = Image.new("RGBA", normalized.size, "white")
            image = Image.alpha_composite(background, normalized).convert("RGB")
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(413, "Image dimensions are too large.") from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(400, "File is not a valid supported image.") from exc

    with image:
        results = read_barcodes(image)
        barcodes = []
        for code in results:
            name = next((name for name, value in FORMATS.items() if code.format == value), None)
            if name is None:
                name = str(code.format).replace("BarcodeFormat.", "").lower().replace(" ", "")
            barcodes.append(BarcodeResult(
                text=code.text,
                format=name,
                bytes_base64=base64.b64encode(code.bytes).decode("ascii"),
                position=[Point(x=x, y=y) for x, y in code.points],
            ))
        response.headers["Cache-Control"] = "no-store"
        return ReadResponse(barcodes=barcodes, image=ImageSize(width=image.width, height=image.height))


app.include_router(router)


class ScannerFiles(StaticFiles):
    """Serve the independent scanner without applying API-key authentication."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Explicit MIME types are consistent across Windows and Linux hosts.
        if path.endswith(".wasm"):
            response.headers["Content-Type"] = "application/wasm"
        elif path.endswith(".js"):
            response.headers["Content-Type"] = "application/javascript"
        elif path.endswith(".webmanifest"):
            response.headers["Content-Type"] = "application/manifest+json"
        if path == "sw.js":
            response.headers["Cache-Control"] = "no-cache"
        return response


# All scanner assets, its decoder, and its service worker share the /scan/ scope.
# The folder can also be hosted by itself on an HTTPS static host.
app.mount(
    "/scan",
    ScannerFiles(directory=Path(__file__).resolve().parent / "web", html=True, check_dir=False),
    name="scanner",
)
