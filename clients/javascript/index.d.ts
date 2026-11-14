export type PosFormat = 'qr' | 'code128' | 'ean13' | 'ean8' | 'upca' | 'upce' | 'datamatrix' | 'aztec' | 'pdf417' | 'code93';
export interface Point { x: number; y: number }
export interface Barcode { text: string; format: string; bytes_base64: string; position: Point[] }
export interface ImageSize { width: number; height: number }
export interface ReadResult { barcodes: Barcode[]; image: ImageSize }
export interface PosOptions { allowed_formats?: PosFormat[]; confirmation_frames?: 1 | 2 | 3 }
export interface PosCandidate { text: string; format: PosFormat; bytes_base64: string; frame_indices: number[] }
export interface PosResult {
  status: 'confirmed' | 'ambiguous' | 'rescan';
  reason: 'single_match' | 'frame_agreement' | 'no_code' | 'insufficient_confirmation' | 'conflicting_values';
  barcode: PosCandidate | null; candidates: PosCandidate[];
  confirmation: {required_frames: number; distinct_frames: number; matched_frames: number};
  allowed_formats: PosFormat[];
  frames: {index: number; image: ImageSize; duplicate_of: number | null; barcodes: Barcode[]}[];
}
export interface GenerateOptions { format: 'qr' | 'code128' | 'ean13' | 'upca'; text: string; output?: 'png' | 'svg'; scale?: number; qr_error_correction?: 'L' | 'M' | 'Q' | 'H'; qr_quiet_zone?: number }
export interface RequestOptions { signal?: AbortSignal }
export class BarcodeApiError extends Error { status: number; requestId: string | null; retryAfter: string | null; details: unknown }
export class BarcodeClient {
  constructor(options: {baseUrl: string; apiKey: string; timeoutMs?: number});
  health(options?: RequestOptions): Promise<{status: string}>;
  formats(options?: RequestOptions): Promise<{generate: string[]; read: string; pos: {formats: PosFormat[]; defaults: Required<PosOptions>; max_frames: number; max_total_file_bytes: number; max_total_pixels: number}}>;
  generate(payload: GenerateOptions, options?: RequestOptions): Promise<{data: Uint8Array; contentType: string | null; requestId: string | null}>;
  read(image: Blob, options?: RequestOptions): Promise<ReadResult>;
  decodePos(frames: Blob[], options?: PosOptions, requestOptions?: RequestOptions): Promise<PosResult>;
}
