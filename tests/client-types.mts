import { BarcodeClient, type PosResult } from '../clients/javascript/index.js';
import { createScanner, type ScanResult } from '../web/sdk/scanner.js';

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
scanner.start({ facingMode: 'environment' });
// @ts-expect-error unsupported barcode family
scanner.setOptions({ formats: ['unknown'] });
// @ts-expect-error live scanner does not accept API credentials
createScanner({ video, apiKey: 'secret' });
scanner.destroy();
