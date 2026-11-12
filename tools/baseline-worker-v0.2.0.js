/* Decode off the UI thread. All executable assets are hosted with this app. */
importScripts('./vendor/zxing-reader.js');

let decoder;
function initialize() {
  if (!decoder) {
    decoder = ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (path) => new URL('./vendor/' + path, self.location.href).href },
      fireImmediately: true,
    }).catch((error) => { decoder = null; throw error; });
  }
  return decoder;
}

self.onmessage = async ({ data: message }) => {
  const { id, type } = message;
  try {
    await initialize();
    if (type === 'init') {
      self.postMessage({ id, type: 'ready' });
      return;
    }
    if (type !== 'decode') throw new Error('Unknown decoder request.');
    const { width, height, data } = message.image;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width * height > 4_000_000 || data.byteLength !== width * height * 4) {
      throw new Error('Image is too large or invalid.');
    }
    const image = new ImageData(new Uint8ClampedArray(data), width, height);
    const results = await ZXingWASM.readBarcodes(image, {
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      maxNumberOfSymbols: 12,
    });
    self.postMessage({ id, type: 'result', results: results.filter((r) => r.isValid !== false).map((r) => ({
      text: r.text, format: r.format, position: r.position,
      bytes: Array.from(r.bytes || []),
    })) });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message || 'Could not read this image.' });
  }
};
