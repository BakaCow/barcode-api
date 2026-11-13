"""Stateless POS decisions over a bounded burst of already decoded images.

The caller supplies canonical base64 payloads and identifies duplicate images
from normalized pixels. Confirmation is evidence agreement, not a product lookup
or a guarantee that the decoded value is correct.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


PosFormat = Literal[
    "qr", "code128", "ean13", "ean8", "upca", "upce",
    "datamatrix", "aztec", "pdf417", "code93",
]
POS_FORMATS = ("qr", "code128", "ean13", "ean8", "upca", "upce", "datamatrix", "aztec", "pdf417", "code93")
_FORMAT_NAMES = {name: name for name in POS_FORMATS}
_FORMAT_NAMES["qrcode"] = "qr"


class PosOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allowed_formats: list[PosFormat] = Field(
        default_factory=lambda: ["ean13", "upca", "code128", "qr"],
        min_length=1, max_length=10, strict=True,
    )
    confirmation_frames: int = Field(default=2, ge=1, le=3, strict=True)

    @field_validator("allowed_formats")
    @classmethod
    def unique_formats(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("allowed_formats must contain unique formats")
        return value


class PosPoint(BaseModel):
    x: int | float
    y: int | float


class PosImageSize(BaseModel):
    width: int = Field(gt=0, strict=True)
    height: int = Field(gt=0, strict=True)


class PosFrameBarcode(BaseModel):
    text: str
    format: str
    bytes_base64: str
    position: list[PosPoint]


class PosFrame(BaseModel):
    index: int = Field(ge=0, strict=True)
    image: PosImageSize
    duplicate_of: int | None = Field(default=None, ge=0, strict=True)
    barcodes: list[PosFrameBarcode]


class PosCandidate(BaseModel):
    text: str
    format: PosFormat
    bytes_base64: str
    frame_indices: list[int]


class PosConfirmation(BaseModel):
    required_frames: int
    distinct_frames: int
    matched_frames: int


class PosResponse(BaseModel):
    status: Literal["confirmed", "ambiguous", "rescan"]
    reason: Literal["single_match", "frame_agreement", "no_code", "insufficient_confirmation", "conflicting_values"]
    barcode: PosCandidate | None
    candidates: list[PosCandidate]
    confirmation: PosConfirmation
    allowed_formats: list[PosFormat]
    frames: list[PosFrame]


def _canonical_format(value: str) -> str | None:
    """Normalize spelling only; UPC-A and EAN-13 remain separate identities."""
    return _FORMAT_NAMES.get(value.lower().replace("-", "").replace("_", "").replace(" ", ""))


def decide_pos(options: PosOptions, frames: list[dict]) -> PosResponse:
    """Choose an allowed identity only when this request's evidence agrees.

    Every different (format, raw payload, decoded text) makes the burst ambiguous.
    Equal bytes can encode different text under different QR ECI declarations;
    the selected text must therefore agree exactly, without normalization.
    Duplicate image uploads retain their diagnostics but contribute no extra
    frame evidence. Blank frames neither confirm nor interrupt agreement.
    """
    if not 1 <= len(frames) <= 5:
        raise ValueError("POS decisions require between one and five frames")
    parsed_frames = [PosFrame.model_validate(frame) for frame in frames]
    seen_indices = set()
    for frame in parsed_frames:
        if frame.index in seen_indices:
            raise ValueError("Frame indices must be unique")
        if frame.duplicate_of is not None and frame.duplicate_of not in seen_indices:
            raise ValueError("duplicate_of must identify an earlier frame")
        seen_indices.add(frame.index)

    allowed = set(options.allowed_formats)
    identities: dict[tuple[str, str, str], PosCandidate] = {}
    for frame in parsed_frames:
        seen_in_frame = set()
        for decoded in frame.barcodes:
            format_ = _canonical_format(decoded.format)
            if format_ not in allowed:
                continue
            identity = (format_, decoded.bytes_base64, decoded.text)
            if identity in seen_in_frame:
                continue
            seen_in_frame.add(identity)
            if identity not in identities:
                identities[identity] = PosCandidate(
                    text=decoded.text, format=format_, bytes_base64=decoded.bytes_base64,
                    frame_indices=[],
                )
            if frame.duplicate_of is None:
                identities[identity].frame_indices.append(frame.index)

    candidates = list(identities.values())
    matched_frames = max((len(candidate.frame_indices) for candidate in candidates), default=0)
    selected = None
    if len(candidates) > 1:
        status, reason = "ambiguous", "conflicting_values"
    elif not candidates:
        status, reason = "rescan", "no_code"
    elif matched_frames < options.confirmation_frames:
        status, reason = "rescan", "insufficient_confirmation"
    else:
        selected = candidates[0]
        status = "confirmed"
        reason = "single_match" if options.confirmation_frames == 1 else "frame_agreement"

    return PosResponse(
        status=status, reason=reason, barcode=selected, candidates=candidates,
        confirmation=PosConfirmation(
            required_frames=options.confirmation_frames,
            distinct_frames=sum(frame.duplicate_of is None for frame in parsed_frames),
            matched_frames=matched_frames,
        ),
        allowed_formats=list(options.allowed_formats), frames=parsed_frames,
    )
