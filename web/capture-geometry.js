/* Shared bounded capture geometry for the SDK and its classic worker. */
(function (root) {
  'use strict';
function validateTarget(region) {
  if (region === null) return null;
  if (!region || typeof region !== 'object' || Array.isArray(region) ||
      Object.keys(region).some(key => !['x', 'y', 'width', 'height'].includes(key)) ||
      !['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key])) ||
      region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 ||
      region.x + region.width > 1 || region.y + region.height > 1) throw new TypeError('targetRegion must be null or a normalized rectangle inside the image.');
  return { x: region.x, y: region.y, width: region.width, height: region.height };
}

function regionPlan(width, height, region, maxPixels, maxSide = 1920) {
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

function sourceRegions(analysis, plan, width, height) {
  return analysis.regions.map(region => ({
    x: Math.max(0, (plan.x + region.x * plan.cropWidth / plan.width) / width),
    y: Math.max(0, (plan.y + region.y * plan.cropHeight / plan.height) / height),
    width: region.width * plan.cropWidth / plan.width / width,
    height: region.height * plan.cropHeight / plan.height / height,
    kind: region.kind,
  })).map(region => ({ ...region, width: Math.min(region.width, 1 - region.x), height: Math.min(region.height, 1 - region.y) }));
}

function expandSourceRegion(region, width, height) {
  const target = validateTarget({ x: region.x, y: region.y, width: region.width, height: region.height });
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new TypeError('Invalid source dimensions.');
  // Automatic detector boxes are estimates. Preserve surrounding ORIGINAL
  // source pixels rather than inventing a white margin around a tight crop.
  const margin = Math.max(8, Math.min(target.width * width, target.height * height) * .15);
  const left = Math.max(0, target.x - margin / width), top = Math.max(0, target.y - margin / height);
  const right = Math.min(1, target.x + target.width + margin / width);
  const bottom = Math.min(1, target.y + target.height + margin / height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

  const api = { validateTarget, regionPlan, sourceRegions, expandSourceRegion };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CaptureGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
