import type { BarcodeFormat, ScannerStatus, ScanResult } from './sdk/scanner.js';

export interface EmbedOptions {
  formats?: BarcodeFormat[];
  confirmationFrames?: 1 | 2 | 3;
  /** Show the optional camera and targeting controls. Defaults to true. */
  controls?: boolean;
  onScan?: (result: ScanResult) => void;
  onStatus?: (status: ScannerStatus) => void;
  onError?: (error: Error) => void;
}
export interface EmbeddedScanner {
  /** Resolves when the hosted frame is configured. It does not open the camera. */
  readonly ready: Promise<EmbeddedScanner>;
  stop(): void;
  /** Explicitly permit the next scan after a confirmed result. */
  rescan(): void;
  destroy(): void;
}
export interface BarcodeCameraAPI {
  readonly version: string;
  mount(target: HTMLElement, options?: EmbedOptions): EmbeddedScanner;
}
declare global {
  const BarcodeCamera: BarcodeCameraAPI;
  interface Window { BarcodeCamera: BarcodeCameraAPI }
}
