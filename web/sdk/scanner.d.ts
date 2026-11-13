export type BarcodeFormat = 'ean13' | 'upca' | 'code128' | 'qr' | 'ean8' | 'upce' | 'datamatrix' | 'aztec' | 'pdf417' | 'code93';
export interface Point { x: number; y: number }
export interface TargetRegion { x: number; y: number; width: number; height: number }
export interface CameraCapabilities {
  active: boolean; deviceId: string | null; width: number; height: number; captureMode: 'balanced' | 'detail';
  torch: { supported: boolean; enabled: boolean };
  zoom: { supported: true; min: number; max: number; step: number; value: number } | null;
}
export interface CandidateRegions {
  /** Heuristic proposals, not accepted or decoded barcode identities. */
  regions: (TargetRegion & {kind: 'linear' | 'matrix'})[];
  sourceWidth: number; sourceHeight: number; frameId: string;
}
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
  captureMode?: 'balanced' | 'detail';
  adaptiveFrameSelection?: boolean;
  /** Request extra source detail and briefly retry useful missed regions. Defaults to true. */
  automaticRecovery?: boolean;
  /** Normalized original-source rectangle; null scans the full view. */
  targetRegion?: TargetRegion | null;
}
export interface ScannerConfiguration extends ScannerOptions {
  video: HTMLVideoElement;
  onScan?: (result: ScanResult) => void;
  onStatus?: (status: ScannerStatus) => void;
  onError?: (error: Error) => void;
  onCandidates?: (candidates: CandidateRegions) => void;
  /** Same-origin web/ directory, including worker and vendor assets. */
  assetBaseUrl?: string | URL;
}
export interface Scanner {
  start(camera?: { deviceId?: string; facingMode?: 'environment' | 'user' | 'left' | 'right' }): Promise<void>;
  stop(): void;
  destroy(): void;
  /** Clears evidence; an already accepted scan stays paused until rescan(). */
  setOptions(options: ScannerOptions): void;
  /** Start a fresh acceptance attempt; required after each confirmed scan. */
  rescan(): void;
  /** Stops camera; one imported image cannot satisfy multi-frame confirmation. */
  scanImage(image: Blob): Promise<ScanResult | null>;
  listCameras(): Promise<{deviceId: string; label: string}[]>;
  getCameraCapabilities(): CameraCapabilities;
  /** Snapshot of effective settings; returned arrays/target are independent copies. */
  getOptions(): Required<ScannerOptions>;
  setTorch(enabled: boolean): Promise<CameraCapabilities>;
  setZoom(value: number): Promise<CameraCapabilities>;
  /** Restarts the preview, preserving the pause after an accepted scan. */
  switchCamera(deviceId: string): Promise<void>;
  /** Restarts an active camera, preserving an accepted pause; no camera opens while idle. */
  setCaptureMode(mode: 'balanced' | 'detail'): Promise<void>;
}
export declare function createScanner(configuration: ScannerConfiguration): Scanner;
