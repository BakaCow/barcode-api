import React, { useEffect, useRef, useState } from 'react';

const DEFAULT_FORMATS = ['ean13', 'upca', 'code128', 'qr'];

/** Owns camera and worker lifetimes; intentionally does not start the camera on mount. */
export function BarcodeScanner({ onScan, formats = DEFAULT_FORMATS, confirmationFrames = 2, assetBaseUrl }) {
  const video = useRef(null), controlsHost = useRef(null), scanner = useRef(null), callback = useRef(onScan), operation = useRef(0);
  const [ready, setReady] = useState(false), [status, setStatus] = useState({ state: 'idle', message: 'Loading the scanner…' });
  const [error, setError] = useState('');
  const formatsKey = JSON.stringify(formats);
  const currentOptions = useRef({ formats, confirmationFrames });
  currentOptions.current = { formats, confirmationFrames };
  useEffect(() => { callback.current = onScan; }, [onScan]);

  useEffect(() => {
    let disposed = false, instance, cameraControls;
    setReady(false);
    let resolvedAssets, sdkUrl, controlsUrl;
    try {
      resolvedAssets = assetBaseUrl || new URL('./scanner-assets/', document.baseURI).href;
      sdkUrl = new URL('sdk/scanner.js', resolvedAssets).href;
      controlsUrl = new URL('sdk/controls.js', resolvedAssets).href;
    } catch (reason) { setError(`Invalid scanner asset directory: ${reason.message}`); return; }
    Promise.all([import(/* @vite-ignore */ sdkUrl), import(/* @vite-ignore */ controlsUrl)]).then(([{ createScanner }, { attachScannerControls }]) => {
      if (disposed) return;
      instance = createScanner({
        video: video.current, assetBaseUrl: resolvedAssets, ...currentOptions.current,
        onScan: (result) => { if (!disposed) callback.current?.(result); },
        onStatus: (next) => { if (!disposed) { cameraControls?.updateStatus(next); setStatus(next); } },
        onCandidates: (candidates) => { if (!disposed) cameraControls?.updateCandidates(candidates); },
        onError: (reason) => { if (!disposed && reason.name !== 'AbortError') setError(reason.message); },
      });
      cameraControls = attachScannerControls({ container: controlsHost.current, video: video.current, scanner: instance });
      scanner.current = instance; setReady(true);
      setStatus({ state: 'idle', message: 'Ready. Start the camera to scan.' });
    }).catch((reason) => { cameraControls?.destroy(); instance?.destroy(); if (!disposed) setError(`Scanner could not load: ${reason.message}`); });
    return () => {
      disposed = true; operation.current++; cameraControls?.destroy(); instance?.destroy();
      if (scanner.current === instance) scanner.current = null;
      // StrictMode may clean up before the dynamic import resolves. The disposed
      // check prevents that abandoned import from creating a camera controller.
    };
  }, [assetBaseUrl]);

  useEffect(() => {
    if (!ready || !scanner.current) return;
    try { scanner.current.setOptions({ formats: JSON.parse(formatsKey), confirmationFrames }); setError(''); }
    catch (reason) { setError(reason.message); }
  }, [ready, formatsKey, confirmationFrames]);

  const start = async () => {
    const instance = scanner.current; if (!instance) return; const token = ++operation.current; setError('');
    try { await instance.start(); }
    catch (reason) { if (token === operation.current && scanner.current === instance && reason.name !== 'AbortError') setError(reason.message); }
  };
  const stop = () => { operation.current++; setError(''); scanner.current?.stop(); };
  const running = Boolean(video.current?.srcObject), starting = status.state === 'starting';
  return <section aria-label="React camera scanner">
    <div className="example-stage" data-running={running}><video ref={video} muted playsInline aria-label="Camera preview" /><p>Start the camera and hold one complete code in view.</p></div>
    <div className="example-actions">
      <button className="button primary" disabled={!ready || starting || running} onClick={start}>Start camera</button>
      <button className="button secondary" disabled={!ready || (!running && !starting)} onClick={stop}>Stop camera</button>
      <button className="button secondary" disabled={!ready || starting} onClick={() => { setError(''); scanner.current?.rescan(); }}>Scan another</button>
    </div>
    <div ref={controlsHost} />
    <p className="example-status" data-state={status.state} role="status">{status.message}</p>
    {error && <p className="example-error" role="alert">{error}</p>}
  </section>;
}
