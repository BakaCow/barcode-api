/* Independent recovery engines. Local ZBar WASM and the project's Code128 matcher. */
(function (root) {
  'use strict';
  const SUPPORTED = ['Code128', 'EAN13'];
  const TYPES = { Code128: 128, EAN13: 13 };
  let ready;

  function initialize() {
    if (!ready) {
      ready = Promise.resolve().then(async () => {
        if (typeof root.zbarWasm === 'undefined') root.importScripts('./vendor/zbar/index.js');
        if (typeof root.Code128Engine === 'undefined') {
          root.importScripts('./engine/code128-decoder.js');
          root.importScripts('./engine/code128-detector.js');
          root.importScripts('./engine/code128-engine.js');
        }
        root.zbarWasm.setModuleArgs({ locateFile: name => new URL('./vendor/zbar/' + name, root.location.href).href });
        await root.zbarWasm.getInstance();
      }).catch(error => { ready = null; throw error; });
    }
    return ready;
  }

  function bounds(points, width, height, vertical) {
    if (!Array.isArray(points) || points.length < 4 || points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
      p.x < 0 || p.y < 0 || p.x > width || p.y > height)) return null;
    let left = width, right = 0, top = height, bottom = 0;
    for (const p of points) { left = Math.min(left, p.x); right = Math.max(right, p.x); top = Math.min(top, p.y); bottom = Math.max(bottom, p.y); }
    if (right - left < 1 || bottom - top < 1) return null;
    return vertical ? { topLeft: { x: left, y: top }, topRight: { x: left, y: bottom },
      bottomRight: { x: right, y: bottom }, bottomLeft: { x: right, y: top } } :
      { topLeft: { x: left, y: top }, topRight: { x: right, y: top },
        bottomRight: { x: right, y: bottom }, bottomLeft: { x: left, y: bottom } };
  }

  async function read(image, { formats = SUPPORTED, timeBudgetMs = 1200 } = {}) {
    if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 ||
      image.width * image.height > 4_000_000 || !Number.isFinite(timeBudgetMs) || timeBudgetMs < 0) throw new Error('Invalid independent-reader input.');
    const pixels = image.data instanceof ArrayBuffer ? new Uint8ClampedArray(image.data) : image.data;
    if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.byteLength !== image.width * image.height * 4) throw new Error('Invalid independent-reader pixels.');
    const allowed = SUPPORTED.filter(format => formats.includes(format));
    const output = { zbar: [], project: [], passes: 0, complete: allowed.length === 0 };
    if (!allowed.length || timeBudgetMs === 0) return output;
    await initialize();
    const started = performance.now();
    const scanner = await root.zbarWasm.ZBarScanner.create();
    try {
      scanner.enableCache(false);
      scanner.setConfig(0, 0, 0);
      for (const format of allowed) scanner.setConfig(TYPES[format], 0, 1);
      const buffer = pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength ? pixels.buffer :
        pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
      const symbols = await root.zbarWasm.scanRGBABuffer(buffer, image.width, image.height, scanner);
      output.passes++;
      for (const symbol of symbols) {
        const format = allowed.find(name => TYPES[name] === symbol.type);
        if (!format || symbol.quality < 2) continue;
        const position = bounds(symbol.points, image.width, image.height, symbol.orientation === 1 || symbol.orientation === 3);
        if (!position) continue;
        const bytes = Array.from(symbol.data, value => value & 255);
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); }
        catch { continue; } // Unsupported display encodings stay on the native path.
        if (!bytes.length || bytes.length > 8192) continue;
        // ZBar may expand a physical UPC-A/E into EAN13 even with UPC readers
        // disabled. A leading-zero fallback lacks physical-format evidence;
        // leave those values to the original native path and its allowlist.
        if (format === 'EAN13' && (!/^[1-9][0-9]{12}$/.test(text) ||
          Array.from(text, Number).reduce((sum, digit, i) => sum + digit * (i % 2 ? 3 : 1), 0) % 10 !== 0)) continue;
        output.zbar.push({ text, format, bytes, position });
      }
    } finally { scanner.destroy(); }
    if (allowed.includes('Code128')) {
      const remaining = timeBudgetMs - (performance.now() - started);
      if (remaining <= 0) return output;
      const project = root.Code128Engine.read({ ...image, data: pixels }, { timeBudgetMs: Math.min(1200, remaining) });
      output.passes++;
      // The project matcher deliberately rejects unsupported FNC2/3/4 rather
      // than dropping control symbols. Its absence never invalidates a native
      // extended-byte result. ZBar alone is NOT authoritative for Code128.
      output.project = project.map(({ text, format, bytes, position, gs1 }) => ({ text, format, bytes, position, gs1 }));
      output.complete = root.Code128Engine.getDiagnostics().complete;
    } else output.complete = true;
    return output;
  }
  root.IndependentReader = { initialize, read, supportedFormats: [...SUPPORTED] };
})(globalThis);
