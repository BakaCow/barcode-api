import { BarcodeClient, type PosResult } from '../clients/javascript/index.js';
import { createScanner, type ScanResult } from '../web/sdk/scanner.js';
import { attachScannerControls } from '../web/sdk/controls.js';
import type { EmbeddedScanner, EmbedOptions } from '../web/embed.js';

const api = new BarcodeClient({ baseUrl: 'https://example.com', apiKey: 'development-only-typecheck-key' });
const decision: Promise<PosResult> = api.decodePos([new Blob(['image'])], { allowed_formats: ['code128'], confirmation_frames: 1 });
void decision;
api.generate({ format: 'qr', text: '000123' });
// @ts-expect-error unsupported generation format
api.generate({ format: 'pdf417', text: 'value' });
// @ts-expect-error frame threshold is deliberately bounded
api.decodePos([new Blob(['image'])], { confirmation_frames: 4 });

const video = document.createElement('video');
const scanner = createScanner({ video, formats: ['qr'], onScan(scan: ScanResult) { scan.scanId.toUpperCase(); } });
scanner.setOptions({ confirmationFrames: 3 });
scanner.setOptions({ targetRegion: { x: 0.1, y: 0.2, width: 0.7, height: 0.4 }, adaptiveFrameSelection: true });
scanner.getOptions().formats.includes('qr');
scanner.listCameras().then(cameras => cameras[0]?.label.toUpperCase());
scanner.setTorch(true);
scanner.setZoom(2);
scanner.setCaptureMode('detail');
scanner.getCameraCapabilities().zoom?.max.toFixed(1);
const controls = attachScannerControls({ container: document.createElement('div'), video, scanner });
controls.updateCandidates({ regions: [{ x: 0, y: 0, width: 0.5, height: 0.5, kind: 'linear' }] });
controls.setTargetRegion(null);
controls.destroy();
// @ts-expect-error capture modes are deliberately bounded
scanner.setCaptureMode('unbounded');
scanner.start({ facingMode: 'environment' });
// @ts-expect-error unsupported barcode family
scanner.setOptions({ formats: ['unknown'] });
// @ts-expect-error live scanner does not accept API credentials
createScanner({ video, apiKey: 'secret' });
scanner.destroy();

const embedOptions: EmbedOptions = { formats: ['code128'], confirmationFrames: 2, controls: true,
  onScan(scan) { scan.scanId.toUpperCase(); scan.text.toUpperCase(); } };
const embed: EmbeddedScanner = window.BarcodeCamera.mount(document.createElement('div'), embedOptions);
embed.ready.then(instance => instance.stop());
embed.rescan(); embed.destroy();
// @ts-expect-error the hosted embed has no secret API key
window.BarcodeCamera.mount(document.createElement('div'), { apiKey: 'secret' });
// @ts-expect-error camera opening requires the widget's explicit user control
embed.start();
