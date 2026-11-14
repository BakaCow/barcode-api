import { FORMATS } from './metrics.mjs';
const VENDOR_FORMATS = { qr: 'QR_CODE', code128: 'CODE_128', ean13: 'EAN_13', ean8: 'EAN_8', upca: 'UPC_A', upce: 'UPC_E', datamatrix: 'DATA_MATRIX', aztec: 'AZTEC', pdf417: 'PDF_417', code93: 'CODE_93' };
const REVERSE = Object.fromEntries(Object.entries(VENDOR_FORMATS).map(([a, b]) => [b, a]));
let pendingVendorRequests = 0;
export function localUrl(value, base) {
  const url = new URL(value, base), origin = new URL(base).origin;
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password || url.search || url.hash) throw new Error('Use a same-origin asset URL without credentials, query or fragment.');
  return url;
}
export async function createWorkerAdapter() {
  let worker = new Worker(new URL('../scanner-worker.js', import.meta.url)), sequence = 0;
  const waiting = new Map();
  function dispose() { worker?.terminate(); worker = null; for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(new Error('Decoder stopped.')); } waiting.clear(); }
  function call(type, payload = {}, transfer = []) {
    if (!worker) return Promise.reject(new Error('Initialize the decoder again.'));
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { dispose(); reject(new Error('Decoder request timed out.')); }, 15000);
      waiting.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, type, ...payload }, transfer); }
      catch { clearTimeout(timer); waiting.delete(id); reject(new Error('Unable to send pixels to the local decoder.')); }
    });
  }
  worker.onmessage = ({ data }) => { const entry = waiting.get(data.id); if (!entry) return; clearTimeout(entry.timer); waiting.delete(data.id); data.type === 'error' ? entry.reject(new Error('Local decoder failed.')) : entry.resolve(data); };
  worker.onerror = dispose;
  try { await call('init'); } catch (error) { dispose(); throw error; }
  return { metadata: { id: 'barcode-api', version: '0.9.0', configuration: 'worker-image-qr-v1' }, dispose,
    async decode(image, formats) {
      const pixels = image.data.slice();
      const result = await call('decode', { image: { width: image.width, height: image.height, data: pixels.buffer }, mode: 'image', enhanceLive: true,
        posOptions: { allowedFormats: formats, confirmationFrames: 1 } }, [pixels.buffer]);
      return result.results;
    } };
}

/** Caller supplies its licensed, locally hosted Scanbot Web SDK module. */
export async function createScanbotAdapter({ SDK, licenseKey, enginePath }) {
  if (pendingVendorRequests) throw new Error('The previous Scanbot request is still finishing. Wait before preparing another vendor trial, or reload after downloading results.');
  if (!SDK?.initialize || !SDK?.Config?.Image?.fromImageData || !SDK?.Config?.BarcodeFormatCommonConfiguration) throw new Error('The supplied module does not expose the documented Scanbot Web SDK API.');
  if (typeof licenseKey !== 'string' || licenseKey.length > 32768) throw new Error('Invalid Scanbot license input.');
  let sdk;
  pendingVendorRequests++;
  try {
    sdk = await SDK.initialize({ licenseKey, enginePath, verboseLogging: false, allowThreads: false });
    if (typeof sdk.detectBarcodes !== 'function' || typeof sdk.version !== 'string' || typeof sdk.getLicenseInfo !== 'function') throw new Error('Unsupported SDK response.');
    const license = await sdk.getLicenseInfo();
    if (typeof license?.isValid !== 'function' || !license.isValid()) throw new Error('Invalid license.');
  } catch { throw new Error('Scanbot initialization or license validation failed. Check your locally hosted SDK files and license.'); }
  finally { pendingVendorRequests--; }
  let disposed = false;
  return { metadata: { id: 'scanbot', version: sdk.version, configuration: 'scanbot-single-shot' },
    dispose() { disposed = true; sdk = null; },
    async decode(image, formats) {
      if (disposed) throw new Error('Initialize Scanbot again.');
      if (!formats.length || formats.some(format => !FORMATS.includes(format))) throw new Error('Unsupported benchmark format.');
      const config = { processingMode: 'SINGLE_SHOT', directAcceptanceAreaFraction: 1,
        extractedDocumentFormats: [], returnBarcodeImage: false,
        barcodeFormatConfigurations: [new SDK.Config.BarcodeFormatCommonConfiguration({ formats: formats.map(format => VENDOR_FORMATS[format]),
          stripCheckDigits: false, addAdditionalQuietZone: false, strictMode: true, gs1Handling: 'PARSE' })] };
      let result;
      pendingVendorRequests++;
      try { result = await sdk.detectBarcodes(SDK.Config.Image.fromImageData(image), config, 'CONSUME_IMAGE'); }
      catch { throw new Error('Scanbot decoding failed. Check its license and local deployment.'); }
      finally { pendingVendorRequests--; }
      if (disposed) throw new Error('Scanbot stopped.');
      if (!Array.isArray(result?.barcodes)) throw new Error('Unsupported Scanbot barcode response.');
      return result.barcodes.map(code => {
        const format = REVERSE[code.format];
        if (!formats.includes(format) || typeof code.text !== 'string' || !(code.rawBytes instanceof Uint8Array)) throw new Error('Scanbot returned an unsupported barcode record.');
        return { format, text: code.text, bytes: Array.from(code.rawBytes), position: null };
      });
    } };
}
