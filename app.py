"""Small HTTP API for barcode generation and image decoding."""

import base64
import asyncio
from contextlib import asynccontextmanager
import hashlib
from io import BytesIO
from pathlib import Path
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.security import APIKeyHeader
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse, RedirectResponse
import zxingcpp
from barcode_reader import canonical_format_name, read_barcodes
from pos_decoding import POS_FORMATS, PosOptions, PosResponse, decide_pos
from hosting import BusinessControls, HostingConfig, HostingState

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 20_000_000
MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024
MAX_POS_FRAMES = 5
MAX_POS_OPTIONS_BYTES = 8192
MAX_BODY_SECONDS = 30
BODY_IDLE_SECONDS = 15
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
        path = scope.get("path", "")
        if (scope["type"] != "http" or scope["method"] != "POST"
                or not (path == "/v1" or path.startswith("/v1/"))):
            return await self.app(scope, receive, send)
        limit = 16 * 1024 if scope["path"].endswith("/generate") else MAX_REQUEST_BYTES
        body = bytearray()
        deadline = time.monotonic() + MAX_BODY_SECONDS
        while True:
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                message = await asyncio.wait_for(receive(), min(BODY_IDLE_SECONDS, remaining))
            except TimeoutError:
                response = JSONResponse({"detail": "Request body timed out."}, status_code=408)
                return await response(scope, receive, send)
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
    app.state.hosting = HostingState(HostingConfig.from_env())
    try:
        yield
    finally:
        app.state.hosting = None


app = FastAPI(
    title="Barcode API",
    version="0.9.0",
    description="Read codes from images and generate QR, Code 128, EAN-13, and UPC-A images.",
    lifespan=lifespan,
)
app.add_middleware(RequestSizeLimit)
# Starlette wraps later middleware around earlier middleware. Authentication
# and admission therefore run before RequestSizeLimit reads an upload body.
app.add_middleware(BusinessControls)
key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def require_key(request: Request, key: Annotated[str | None, Depends(key_header)]):
    if not getattr(request.state, "barcode_customer_id", None):
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


@app.get("/ops/metrics", include_in_schema=False)
def operational_metrics(request: Request):
    """Operator-only, in-memory usage; enabled by BARCODE_ADMIN_KEY."""
    if not getattr(request.state, "barcode_operator", False):
        raise HTTPException(status_code=401, detail="Invalid or missing operator key.")
    return request.app.state.hosting.snapshot()


@app.get("/", include_in_schema=False)
def scanner_home():
    return RedirectResponse(url="/scan/")


@router.get("/formats")
def formats():
    return {
        "generate": list(FORMATS), "read": "All formats supported by ZXing-C++",
        "pos": {
            "formats": list(POS_FORMATS), "defaults": PosOptions().model_dump(),
            "max_frames": MAX_POS_FRAMES, "max_total_file_bytes": MAX_FILE_BYTES,
            "max_total_pixels": MAX_PIXELS,
        },
    }


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


def load_image(content: bytes, *, pixel_limit: int) -> Image.Image:
    """Validate before allocating decoded pixels; caller owns the returned RGB image."""
    try:
        with Image.open(BytesIO(content)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"}:
                raise HTTPException(415, "Upload a PNG, JPEG, or WebP image.")
            if source.width * source.height > pixel_limit:
                raise HTTPException(413, "Images exceed the available decoded pixel budget (20 megapixels per request).")
            if getattr(source, "n_frames", 1) != 1:
                raise HTTPException(415, "Animated and multi-frame images are not supported.")
            with ImageOps.exif_transpose(source) as oriented, oriented.convert("RGBA") as normalized:
                # Composite transparency on white so transparent backgrounds remain readable.
                with Image.new("RGBA", normalized.size, "white") as background:
                    with Image.alpha_composite(background, normalized) as composite:
                        return composite.convert("RGB")
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(413, "Image dimensions are too large.") from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(400, "File is not a valid supported image.") from exc


@router.post("/barcodes/read", response_model=ReadResponse)
def read(file: UploadFile, response: Response):
    """Read PNG, JPEG, or WebP. Positions use EXIF-normalized image coordinates."""
    try:
        content = file.file.read(MAX_FILE_BYTES + 1)
    finally:
        file.file.close()
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(413, "Image exceeds the 10 MiB file limit.")
    with load_image(content, pixel_limit=MAX_PIXELS) as image:
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


@router.post("/pos/decode", response_model=PosResponse)
async def pos_decode(
    request: Request,
    response: Response,
    frames: Annotated[list[UploadFile], File(description="One to five images of one target product.")],
    options: Annotated[str, Form(description="JSON object: allowed_formats and confirmation_frames (1–3).")] = "{}",
):
    """Decide one POS result from a stateless burst; conflicting identities are ambiguous.

    Confirmation defaults to two distinct images. Set confirmation_frames to 1
    to accept a single match. Identical normalized pixels never add confirmation.
    No agreement or camera state is retained between requests.
    """
    form = await request.form()
    try:
        if set(form) - {"frames", "options"}:
            raise HTTPException(422, "Use only the frames and options multipart fields.")
        raw_options = form.getlist("options")
        if len(raw_options) > 1:
            raise HTTPException(422, "Supply the options field only once.")
        # FastAPI treats an empty form field as its default; explicit empty JSON
        # must instead be rejected, so read the original cached form value.
        options = raw_options[0] if raw_options else options
        if not isinstance(options, str):
            raise HTTPException(422, "The options field must contain a JSON string.")
        result = await run_in_threadpool(decode_pos_burst, frames, options)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return result
    finally:
        await form.close()


def decode_pos_burst(frames: list[UploadFile], options: str) -> PosResponse:
    """Run bounded image work in a worker thread; the route owns upload handles."""
    images = []
    try:
        if not 1 <= len(frames) <= MAX_POS_FRAMES:
            raise HTTPException(422, "Upload between one and five frames.")
        if len(options.encode("utf-8")) > MAX_POS_OPTIONS_BYTES:
            raise HTTPException(422, "The options field exceeds 8192 UTF-8 bytes.")
        try:
            config = PosOptions.model_validate_json(options)
        except ValidationError as exc:
            # Pydantic error contexts may contain non-JSON-serializable exceptions.
            raise HTTPException(422, exc.errors(include_context=False, include_input=False)) from exc

        total_bytes = total_pixels = 0
        for frame in frames:
            content = frame.file.read(MAX_FILE_BYTES - total_bytes + 1)
            total_bytes += len(content)
            if total_bytes > MAX_FILE_BYTES:
                raise HTTPException(413, "Combined images exceed the 10 MiB file limit.")
            image = load_image(content, pixel_limit=MAX_PIXELS - total_pixels)
            images.append(image)
            total_pixels += image.width * image.height

        # Validate the entire burst before spending time decoding any frame.
        seen_images = {}
        decoded_frames = []
        for index, image in enumerate(images):
            digest = hashlib.sha256()
            digest.update(image.width.to_bytes(8, "big"))
            digest.update(image.height.to_bytes(8, "big"))
            digest.update(image.tobytes())
            fingerprint = digest.digest()
            duplicate_of = seen_images.get(fingerprint)
            if duplicate_of is not None:
                barcodes = decoded_frames[duplicate_of]["barcodes"]
            else:
                seen_images[fingerprint] = index
                barcodes = []
                for code in read_barcodes(image, allowed_formats=config.allowed_formats):
                    name = canonical_format_name(code.format)
                    if name not in config.allowed_formats:
                        continue
                    barcodes.append({
                        "text": code.text, "format": name,
                        "bytes_base64": base64.b64encode(code.bytes).decode("ascii"),
                        "position": [{"x": x, "y": y} for x, y in code.points],
                    })
            decoded_frames.append({
                "index": index, "image": {"width": image.width, "height": image.height},
                "duplicate_of": duplicate_of, "barcodes": barcodes,
            })
        return decide_pos(config, decoded_frames)
    finally:
        for image in images:
            image.close()


app.include_router(router)


class ScannerFiles(StaticFiles):
    """Serve the independent scanner without applying API-key authentication."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Explicit MIME types are consistent across Windows and Linux hosts.
        if path.endswith(".wasm"):
            response.headers["Content-Type"] = "application/wasm"
        elif path.endswith((".js", ".mjs")):
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
