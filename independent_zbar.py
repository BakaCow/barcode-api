"""Bounded independent linear observations; these are not final API results.

ZBar is deliberately restricted to the two families evaluated here. Its Code128
FNC4 handling differs across implementations: never publish a Code128 observation
without separate byte-level corroboration. See barcode_reader.py for arbitration.
"""
from dataclasses import dataclass

from PIL import Image

try:
    from pyzbar.pyzbar import decode, ZBarSymbol
except (ImportError, OSError) as error:
    raise RuntimeError(
        "Independent barcode decoding requires pyzbar and the ZBar shared library. "
        "Install requirements.txt plus libzbar0 on Debian/Ubuntu, brew install zbar "
        "on macOS, or use the supplied Docker image. Windows wheels include ZBar."
    ) from error


@dataclass(frozen=True, slots=True)
class Observation:
    family: str
    data: bytes
    points: tuple[tuple[int, int], ...]


SYMBOLS = {'code128': ZBarSymbol.CODE128, 'ean13': ZBarSymbol.EAN13}
FAMILIES = {'CODE128': 'code128', 'EAN13': 'ean13'}


def observations(image: Image.Image, families) -> list[Observation]:
    """Read supplied pixels once, preserving bytes and enforcing a native mask."""
    selected = [name for name in SYMBOLS if name in families]
    if not selected:
        return []  # ZBar's empty mask would otherwise enable every symbology.
    if image.mode != 'L' or min(image.size) < 1 or image.width * image.height > 4_000_000:
        raise ValueError('Independent decoding requires bounded grayscale pixels.')
    found = []
    for code in decode(image, symbols=[SYMBOLS[name] for name in selected]):
        family = FAMILIES.get(code.type)
        if family not in selected or not isinstance(code.data, bytes) or len(code.data) > 4096:
            continue
        # Require a conservative native quality threshold and valid geometry.
        # ZBar quality is relative, not calibrated confidence or camera evidence.
        if code.quality < 2:
            continue
        x, y, width, height = code.rect
        if width < 1 or height < 1:
            continue
        left, top = max(0, x), max(0, y)
        right, bottom = min(image.width, x + width), min(image.height, y + height)
        if right <= left or bottom <= top:
            continue
        if family == 'ean13':
            data = code.data
            if len(data) != 13 or any(value < 48 or value > 57 for value in data):
                continue
            # With EAN13 enabled, ZBar can expand a compressed UPC-E and report
            # it as EAN13 even when UPC-E is disabled. Leading-zero GTINs are
            # therefore not independent evidence of the physical symbology.
            # Leave those observations to the native format-aware path, whose
            # existing EAN13/UPC-A/UPC-E reads remain fully supported.
            if data.startswith(b'0'):
                continue
            check = sum((value - 48) * (1 if index % 2 == 0 else 3)
                        for index, value in enumerate(data[:12]))
            if (10 - check % 10) % 10 != data[12] - 48:
                continue
        found.append(Observation(family, code.data, ((left, top), (right, top),
                                                     (right, bottom), (left, bottom))))
    return found
