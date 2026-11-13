import React, { useEffect, useRef, useState } from 'react';

const DEFAULT_FORMATS = ['ean13', 'upca', 'code128', 'qr'];

/** Owns camera and worker lifetimes; intentionally does not start the camera on mount. */
export function BarcodeScanner({ onScan, formats = DEFAULT_FORMATS, confirmationFrames = 2, assetBaseUrl }) {
  const video = useRef(null), scanner = useRef(null), callback = useRef(onScan);
  const [ready, setReady] = useState(false), [status, setStatus] = useState({ state: 'idle', message: 'Loading the scanner…' });
  const [error, setError] = useState('');
  const formatsKey = JSON.stringify(formats);
  const currentOptions = useRef({ formats, confirmationFrames });
  currentOptions.current = { formats, confirmationFrames };
  useEffect(() => { callback.current = onScan; }, [onScan]);

  useEffect(() => {
    let disposed = false, instance;
    setReady(false);
    let resolvedAssets, sdkUrl;
    try {
      resolvedAssets = assetBaseUrl || new URL('./scanner-assets/', document.baseURI).href;
      sdkUrl = new URL('sdk/scanner.js', resolvedAssets).href;
    } catch (reason) { setError(`Invalid scanner asset directory: ${reason.message}`); return; }
    import(/* @vite-ignore */ sdkUrl).then(({ createScanner }) => {
      if (disposed) return;
      instance = createScanner({
        video: video.current, assetBaseUrl: resolvedAssets, ...currentOptions.current,
        onScan: (result) => { if (!disposed) callback.current?.(result); },
        onStatus: (next) => { if (!disposed) setStatus(next); },
        onError: (reason) => { if (!disposed) setError(reason.message); },
      });
      scanner.current = instance; setReady(true);
      setStatus({ state: 'idle', message: 'Ready. Start the camera to scan.' });
    }).catch((reason) => { if (!disposed) setError(`Scanner could not load: ${reason.message}`); });
    return () => {
      disposed = true; instance?.destroy();
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
    const instance = scanner.current; if (!instance) return; setError('');
    try { await instance.start(); }
    catch (reason) { if (scanner.current === instance) setError(reason.message); }
  };
  const running = Boolean(video.current?.srcObject), starting = status.state === 'starting';
  return <section aria-label="React camera scanner">
    <div className="example-stage" data-running={running}><video ref={video} muted playsInline aria-label="Camera preview" /><p>Start the camera and hold one complete code in view.</p></div>
    <div className="example-actions">
      <button className="button primary" disabled={!ready || starting || running} onClick={start}>Start camera</button>
      <button className="button secondary" disabled={!ready || (!running && !starting)} onClick={() => scanner.current?.stop()}>Stop camera</button>
      <button className="button secondary" disabled={!ready || starting} onClick={() => { setError(''); scanner.current?.rescan(); }}>Scan another</button>
    </div>
    <p className="example-status" data-state={status.state} role="status">{status.message}</p>
    {error && <p className="example-error" role="alert">{error}</p>}
  </section>;
}
