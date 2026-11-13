import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BarcodeScanner } from './BarcodeScanner.jsx';

function App() {
  const [mounted, setMounted] = useState(true), [result, setResult] = useState(null), [confirmation, setConfirmation] = useState(2);
  return <>
    <a className="skip-link" href="#scanner">Skip to scanner</a>
    <header className="topbar"><a className="brand" href="./"><img src="./scanner-assets/icon.svg" width="34" height="34" alt="" /><span>Barcode Camera</span></a><span>React example</span></header>
    <main><h1 className="example-heading">Scanning inside React.</h1><p className="example-intro">The component owns the camera and worker. Your application receives the confirmed result and decides what happens next.</p>
      <div className="example-layout"><div id="scanner">
        {mounted ? <BarcodeScanner onScan={setResult} confirmationFrames={confirmation} /> : <p className="example-result-empty">The scanner is unmounted. Its camera and worker have been released.</p>}
        <label className="example-field">Matching frames<select value={confirmation} onChange={(event) => setConfirmation(Number(event.target.value))}><option value={2}>2 — recommended</option><option value={3}>3 — extra confirmation</option><option value={1}>1 — no frame confirmation</option></select></label>
        <button className="button secondary" onClick={() => setMounted(!mounted)}>{mounted ? 'Unmount scanner' : 'Mount scanner'}</button>
      </div><section className="example-panel" aria-labelledby="result-heading"><h2 id="result-heading">Application result</h2>{result ? <><p className="example-result">{result.text}</p><p className="example-meta">Format: {result.format}</p><p className="example-meta">Scan event: {result.scanId}</p></> : <p className="example-result-empty">Your first confirmed value will appear here.</p>}<p className="example-help">The example displays text without opening links or making product assumptions.</p></section></div>
    </main><footer className="example-footer"><p>Camera frames stay on this device. This example does not register an offline cache; the host application must cache its own assets and business data.</p></footer>
  </>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
