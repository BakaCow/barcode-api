import type { Scanner, ScannerStatus } from './scanner.js';
export interface VideoBounds { left: number; top: number; width: number; height: number }
export interface VideoPoint { x: number; y: number }
export interface TargetArea extends VideoPoint { width: number; height: number }
export interface CandidateAreas { regions: Array<TargetArea & {kind?: string}>; sourceWidth?: number; sourceHeight?: number; frameId?: string }
export interface ScannerControls {
  refresh(): Promise<void>;
  setTargetRegion(region: TargetArea | null): void;
  updateStatus(status: ScannerStatus): void;
  updateCandidates(candidates: CandidateAreas): void;
  destroy(): void;
}
export function containedVideoRect(rect: VideoBounds, sourceWidth: number, sourceHeight: number): VideoBounds | null;
export function pointToVideo(point: VideoPoint, rect: VideoBounds, sourceWidth: number, sourceHeight: number): VideoPoint | null;
export function targetAtPoint(point: VideoPoint, regions?: TargetArea[]): TargetArea | null;
/** Include controls.css; the dedicated container will be populated without opening a camera. */
export function attachScannerControls(options: {container: HTMLElement; video: HTMLVideoElement; scanner: Scanner; onError?: (error: unknown) => void}): ScannerControls;
