/** Server-side only. Browser camera integrations should use web/sdk/scanner.js. */
const MAX_BYTES = 10 * 1024 * 1024;
const FORMATS = new Set(['qr', 'code128', 'ean13', 'ean8', 'upca', 'upce', 'datamatrix', 'aztec', 'pdf417', 'code93']);

export class BarcodeApiError extends Error {
  constructor(status, requestId, retryAfter, details) {
    super(`Barcode API request failed (HTTP ${status}).`);
    this.name = 'BarcodeApiError';
    this.status = status;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

export class BarcodeClient {
  #base; #key; #timeout;
  constructor({ baseUrl, apiKey, timeoutMs = 15000 }) {
    if (typeof window !== 'undefined') throw new Error('Use this API client on your backend; do not expose the API key in browser code.');
    let base;
    try { base = new URL(baseUrl); } catch { throw new TypeError('baseUrl must be an absolute HTTP(S) URL.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) throw new TypeError('Use HTTPS, or HTTP on localhost for development.');
    if (base.username || base.password || base.search || base.hash) throw new TypeError('baseUrl cannot contain credentials, a query, or a fragment.');
    if (typeof apiKey !== 'string' || apiKey.length < 24 || apiKey.length > 256 || /[^\x21-\x7e]/.test(apiKey)) throw new TypeError('Provide an API key of 24–256 printable ASCII characters.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('timeoutMs must be an integer from 1 to 300000.');
    base.pathname = base.pathname.replace(/\/*$/, '/');
    this.#base = base; this.#key = apiKey; this.#timeout = timeoutMs;
  }

  async #request(path, { body, json, signal, binary = false, authenticated = true } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException('Barcode API request timed out.', 'TimeoutError')), this.#timeout);
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    try {
      const headers = authenticated ? { 'X-API-Key': this.#key } : {};
      if (json !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(new URL(path, this.#base), {
        method: body !== undefined || json !== undefined ? 'POST' : 'GET', headers,
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: controller.signal, redirect: 'error',
      });
      const requestId = response.headers.get('X-Request-ID');
      if (!response.ok) {
        let details;
        try { details = (await response.json()).detail; } catch { /* Proxy errors may not be JSON. */ }
        throw new BarcodeApiError(response.status, requestId, response.headers.get('Retry-After'), details);
      }
      if (binary) return { data: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('Content-Type'), requestId };
      return await response.json();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  health(options) { return this.#request('health', { ...options, authenticated: false }); }
  formats(options) { return this.#request('v1/formats', options); }
  generate(payload, options) { return this.#request('v1/barcodes/generate', { ...options, json: payload, binary: true }); }
  read(image, options) {
    validateImages([image]);
    const body = new FormData(); body.append('file', image, 'image');
    return this.#request('v1/barcodes/read', { ...options, body });
  }
  decodePos(frames, options = {}, requestOptions) {
    validateImages(frames);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['allowed_formats', 'confirmation_frames'].includes(key))) throw new TypeError('Use only allowed_formats and confirmation_frames for POS options.');
    if (options.confirmation_frames !== undefined && ![1, 2, 3].includes(options.confirmation_frames)) throw new TypeError('confirmation_frames must be 1, 2, or 3.');
    const formats = options.allowed_formats;
    if (formats !== undefined && (!Array.isArray(formats) || formats.length < 1 || formats.length > 10 || new Set(formats).size !== formats.length || formats.some(format => !FORMATS.has(format)))) throw new TypeError('allowed_formats must contain unique supported POS formats.');
    const body = new FormData(); frames.forEach((frame, index) => body.append('frames', frame, `frame-${index}`));
    body.append('options', JSON.stringify(options));
    return this.#request('v1/pos/decode', { ...requestOptions, body });
  }
}

function validateImages(images) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 5 || images.some(image => !(image instanceof Blob) || image.size === 0)) throw new TypeError('Provide one to five nonempty image Blobs.');
  if (images.reduce((sum, image) => sum + image.size, 0) > MAX_BYTES) throw new RangeError('Combined image data exceeds 10 MiB.');
}
