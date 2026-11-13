export type BarcodeFormat = 'ean13' | 'upca' | 'code128' | 'qr' | 'ean8' | 'upce' | 'datamatrix' | 'aztec' | 'pdf417' | 'code93';
export interface Point { x: number; y: number }
export interface BarcodePosition { topLeft: Point; topRight: Point; bottomRight: Point; bottomLeft: Point }
export interface ScanResult {
  /** Unique per confirmed scan. Reuse this ID when retrying a business request. */
  scanId: string;
  text: string;
  format: BarcodeFormat;
  bytesBase64: string;
  /** Corners in source video/image pixels, before CSS display scaling. */
  position: BarcodePosition | null;
}
export interface ScannerStatus {
  state: 'idle' | 'starting' | 'scanning' | 'confirmed' | 'ambiguous' | 'rescan' | 'error' | 'stopped' | 'destroyed';
  message: string;
  reason?: string;
}
export interface ScannerOptions {
  formats?: BarcodeFormat[];
  confirmationFrames?: 1 | 2 | 3;
  preferClearFrames?: boolean;
  cropBarcodes?: boolean;
}
export interface ScannerConfiguration extends ScannerOptions {
  video: HTMLVideoElement;
  onScan?: (result: ScanResult) => void;
  onStatus?: (status: ScannerStatus) => void;
  onError?: (error: Error) => void;
  /** Same-origin web/ directory, including worker and vendor assets. */
  assetBaseUrl?: string | URL;
}
export interface Scanner {
  start(camera?: { deviceId?: string; facingMode?: 'environment' | 'user' | 'left' | 'right' }): Promise<void>;
  stop(): void;
  destroy(): void;
  setOptions(options: ScannerOptions): void;
  /** Start a fresh acceptance attempt; required after each confirmed scan. */
  rescan(): void;
  /** Stops camera; one imported image cannot satisfy multi-frame confirmation. */
  scanImage(image: Blob): Promise<ScanResult | null>;
}
export declare function createScanner(configuration: ScannerConfiguration): Scanner;
