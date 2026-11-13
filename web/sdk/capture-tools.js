/** Pure bounded geometry/camera policies shared by the SDK and its tests. */
export function validateTarget(region) {
  if (region === null) return null;
  if (!region || typeof region !== 'object' || Array.isArray(region) ||
      Object.keys(region).some(key => !['x', 'y', 'width', 'height'].includes(key)) ||
      !['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key])) ||
      region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
      region.x + region.width > 1 || region.y + region.height > 1) throw new TypeError('targetRegion must be null or a normalized rectangle inside the image.');
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

export function regionPlan(width, height, region, maxPixels, maxSide = 1920) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      !Number.isInteger(maxPixels) || maxPixels < 1 || !Number.isFinite(maxSide) || maxSide < 1) throw new TypeError('Invalid capture dimensions.');
  const target = validateTarget(region) || { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.floor(target.x * width), y = Math.floor(target.y * height);
  const right = Math.min(width, Math.ceil((target.x + target.width) * width));
  const bottom = Math.min(height, Math.ceil((target.y + target.height) * height));
  const cropWidth = right - x, cropHeight = bottom - y;
  const scale = Math.min(1, maxSide / Math.max(cropWidth, cropHeight), Math.sqrt(maxPixels / (cropWidth * cropHeight)));
  const outputWidth = Math.max(1, Math.floor(cropWidth * scale));
  const outputHeight = Math.max(1, Math.min(Math.floor(cropHeight * scale), Math.floor(maxPixels / outputWidth)));
  return { x, y, cropWidth, cropHeight, width: outputWidth, height: outputHeight };
}

export function sourceRegions(analysis, plan, width, height) {
  return analysis.regions.map(region => ({
    x: Math.max(0, (plan.x + region.x * plan.cropWidth / plan.width) / width),
    y: Math.max(0, (plan.y + region.y * plan.cropHeight / plan.height) / height),
    width: region.width * plan.cropWidth / plan.width / width,
    height: region.height * plan.cropHeight / plan.height / height,
    kind: region.kind,
  })).map(region => ({ ...region, width: Math.min(region.width, 1 - region.x), height: Math.min(region.height, 1 - region.y) }));
}

export function clearFrame(analysis, width, height) {
  if (!analysis || analysis.hint !== null || analysis.score < 72 || analysis.regions?.length !== 1) return false;
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
