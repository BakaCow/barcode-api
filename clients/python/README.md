# Python backend client

Requires Python 3.10+ and uses only the standard library at runtime. Install from the repository:

```sh
python -m pip install ./clients/python
```

This package is included locally; it has not been published to PyPI.

```python
import os
from pathlib import Path
from barcode_api_client import BarcodeClient, BarcodeApiError, ImageUpload

client = BarcodeClient(os.environ['BARCODE_API_URL'], os.environ['BARCODE_API_KEY'])
image = client.generate(format='code128', text='000123')
Path('label.png').write_bytes(image.data)
decoded = client.read(ImageUpload.from_path('label.png'))
print(decoded['barcodes'])

decision = client.decode_pos(
    [ImageUpload.from_path('frame-1.jpg'), ImageUpload.from_path('frame-2.jpg')],
    allowed_formats=['ean13', 'upca', 'code128'],
    confirmation_frames=2,
)
if decision['status'] == 'confirmed':
    # Exact catalogue lookup plus transaction idempotency belongs to your app.
    identifier = decision['barcode']['text']
```

`ImageUpload(data)` accepts bytes, and `ImageUpload.from_path(path)` reads at most the file limit plus one byte before rejecting oversized input. Send a single image with `confirmation_frames=1` only when that reduced agreement policy is intentional. Repeating identical image bytes never creates additional evidence.

For QR labels, `client.generate(format='qr', text='ORDER-000123', qr_error_correction='H', qr_quiet_zone=8)` selects error correction `L`, `M`, `Q` or `H` and a white border of 4–16 modules on every side. Omitted options preserve the existing `L` level and four-module border. Higher correction can help damaged labels but can also make the symbol denser; keep printed modules large enough for your camera. These options are rejected for other barcode formats.

`health()`, `formats()`, `read()` and `decode_pos()` return dictionaries matching the API response. `generate()` returns `GeneratedImage(data, content_type, request_id)`. API failures raise `BarcodeApiError` with `status`, `request_id`, `retry_after` and optional `details`. Connection failures and socket timeouts use Python's native exceptions. The `timeout` constructor option defaults to 15 seconds and applies to blocking socket operations, not a guaranteed total wall-clock deadline. No automatic retries are performed.

Use HTTPS in production; HTTP is accepted only on localhost/loopback. Redirects are refused. Base URL paths are preserved. Keep the API key on your backend. The client does not manage customer provisioning, catalogue records, cart updates or offline camera capture.
