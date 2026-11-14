/** Pure bounded geometry/camera policies shared by the SDK and its tests. */
import * as geometryModule from '../capture-geometry.js';
const Geometry = globalThis.CaptureGeometry || geometryModule.default;
export const { validateTarget, regionPlan, sourceRegions, expandSourceRegion } = Geometry;

export function clearFrame(analysis, width, height) {
  if (!analysis || analysis.regionsComplete === false || analysis.qr?.complete === false ||
      analysis.hint !== null || analysis.score < 72 || analysis.regions?.length !== 1) return false;
  const region = analysis.regions[0], area = region.width * region.height / (width * height);
  // A unique strong proposal avoids immediately decoding arbitrary sharp scene texture.
  return Number.isFinite(area) && area >= 0.015 && area <= 0.75;
}

export function cameraCapabilities(track, captureMode, fallback = {}) {
  let caps = {}, settings = {};
  try { caps = track?.getCapabilities?.() || {}; } catch { /* Some browsers expose no capabilities. */ }
  try { settings = track?.getSettings?.() || {}; } catch { /* Values remain unknown. */ }
  const range = caps.zoom;
  const zoom = range && [range.min, range.max].every(Number.isFinite) && range.min > 0 && range.max >= range.min
    ? { supported: true, min: range.min, max: range.max, step: Number.isFinite(range.step) && range.step > 0 ? range.step : 0,
      value: Number.isFinite(settings.zoom) ? settings.zoom : (fallback.zoom ?? range.min) } : null;
  if (zoom) zoom.value = Math.max(zoom.min, Math.min(zoom.max, zoom.value));
  return { active: Boolean(track), deviceId: typeof settings.deviceId === 'string' ? settings.deviceId : null,
    torch: { supported: caps.torch === true, enabled: caps.torch === true && (typeof settings.torch === 'boolean' ? settings.torch : fallback.torch === true) },
    zoom, width: Number.isFinite(settings.width) ? settings.width : 0, height: Number.isFinite(settings.height) ? settings.height : 0, captureMode };
}

export function boundedZoom(value, range) {
  if (!Number.isFinite(value)) throw new TypeError('Zoom must be a finite number.');
  if (!range?.supported) throw new Error('Zoom is not supported by this camera and browser.');
  let next = Math.max(range.min, Math.min(range.max, value));
  if (range.step) next = range.min + Math.round((next - range.min) / range.step) * range.step;
  return Math.max(range.min, Math.min(range.max, Number(next.toFixed(8))));
}
