/** Optional camera controls. Import controls.css separately; no camera starts on attachment. */
let nextControlsId = 0;
const CENTER = Object.freeze({ x: .15, y: .275, width: .7, height: .45 });

export function containedVideoRect(rect, sourceWidth, sourceHeight) {
  if (![rect?.left, rect?.top, rect?.width, rect?.height, sourceWidth, sourceHeight].every(Number.isFinite) ||
      rect.width <= 0 || rect.height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return null;
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
  const width = sourceWidth * scale, height = sourceHeight * scale;
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
}

export function pointToVideo(point, rect, sourceWidth, sourceHeight) {
  const bounds = containedVideoRect(rect, sourceWidth, sourceHeight);
  if (!bounds || !Number.isFinite(point?.x) || !Number.isFinite(point?.y) ||
      point.x < bounds.left || point.y < bounds.top || point.x > bounds.left + bounds.width || point.y > bounds.top + bounds.height) return null;
  return { x: (point.x - bounds.left) / bounds.width, y: (point.y - bounds.top) / bounds.height };
}

function validRegion(region) {
  return region && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(region[key])) &&
    region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 &&
    region.x + region.width <= 1.000000001 && region.y + region.height <= 1.000000001;
}

export function targetAtPoint(point, regions = []) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  const containing = regions.filter(validRegion).filter(r => point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height);
  const region = containing.sort((a, b) => a.width * a.height - b.width * b.height)[0];
  if (region) return { x: region.x, y: region.y, width: region.width, height: region.height };
  return { x: Math.max(0, Math.min(.4, point.x - .3)), y: Math.max(0, Math.min(.6, point.y - .2)), width: .6, height: .4 };
}

/** container is a dedicated empty host; video must sit inside a positioned stage. */
export function attachScannerControls({ container, video, scanner, onError } = {}) {
  if (!container?.ownerDocument || !video?.parentElement || !scanner?.getCameraCapabilities || !scanner?.getOptions) throw new TypeError('Provide a controls container, video and camera scanner.');
  const doc = container.ownerDocument, env = doc.defaultView || globalThis, stage = video.parentElement;
  const prefix = `barcode-controls-${++nextControlsId}`;
  let disposed = false, busy = false, revision = 0, target = null, regions = [], expiry = null;
  let cameras = [], capabilities = scanner.getCameraCapabilities(), adaptive = true, lastRefreshKey = '', cameraListKey = '';
  const listeners = [];
  const previousFit = video.style.objectFit, previousPosition = video.style.objectPosition;
  video.style.objectFit = 'contain'; video.style.objectPosition = 'center';
  const hadStageClass = stage.classList.contains('scanner-controls-stage'); stage.classList.add('scanner-controls-stage');
  const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  const details = element('details', 'scanner-camera-controls');
  const summary = element('summary', '', 'Camera and targeting');
  const fields = element('fieldset', 'scanner-camera-fields');
  const legend = element('legend', 'scanner-controls-sr', 'Camera settings');
  const grid = element('div', 'scanner-controls-grid');
  const field = (text, name, node) => {
    const label = element('label', 'scanner-controls-field'), caption = element('span', '', text);
    node.id = `${prefix}-${name}`; label.htmlFor = node.id; label.append(caption, node); return label;
  };
  const camera = element('select'); grid.append(field('Camera', 'camera', camera));
  const mode = element('select');
  for (const [value, text] of [['balanced', 'Balanced'], ['detail', 'More detail · where supported']]) { const option = element('option', '', text); option.value = value; mode.append(option); }
  grid.append(field('Capture detail', 'detail', mode));
  const hardware = element('div', 'scanner-controls-actions'), torch = element('button', 'scanner-control-button', 'Turn flashlight on'); torch.type = 'button';
  torch.setAttribute('aria-pressed', 'false'); hardware.append(torch);
  const zoom = element('input'); zoom.type = 'range'; zoom.min = '1'; zoom.max = '1'; zoom.step = '.1'; zoom.value = '1';
  const zoomValue = element('output', 'scanner-zoom-value', '1×'), zoomField = field('Zoom', 'zoom', zoom); zoomValue.htmlFor = zoom.id; zoomField.append(zoomValue);
  const hardwareNote = element('p', 'scanner-controls-note', 'Start the camera to check flashlight and zoom support.');
  const adaptiveBox = element('input'); adaptiveBox.type = 'checkbox'; adaptiveBox.checked = true;
  const adaptiveLabel = element('label', 'scanner-controls-check'); adaptiveLabel.append(adaptiveBox, element('span', '', 'Read clear frames immediately'));
  const adaptiveHelp = element('p', 'scanner-controls-note', 'Less-clear frames still use frame selection. Matching-frame confirmation stays enabled.');
  const targeting = element('div', 'scanner-controls-actions'), aim = element('button', 'scanner-control-button', 'Aim at centre'), clear = element('button', 'scanner-control-button', 'Scan full view'); aim.type = clear.type = 'button'; targeting.append(aim, clear);
  const targetNote = element('p', 'scanner-target-note', 'Scanning the full view. Tap a suggested area or use Aim at centre to select one label.'); targetNote.setAttribute('role', 'status');
  const proposalNote = element('p', 'scanner-controls-note', 'Outline suggestions are possible barcode areas, not confirmed readings. Keep the complete label and blank border inside your selection.');
  const error = element('p', 'scanner-controls-error'); error.hidden = true; error.setAttribute('role', 'alert');
  fields.append(legend, grid, hardware, zoomField, hardwareNote, adaptiveLabel, adaptiveHelp, targeting, targetNote, proposalNote);
  details.append(summary, fields, error); container.replaceChildren(details);
  const overlay = element('div', 'scanner-target-overlay'); overlay.setAttribute('aria-hidden', 'true'); stage.append(overlay);
  const on = (node, type, callback) => { node.addEventListener(type, callback); listeners.push(() => node.removeEventListener(type, callback)); };
  function clearSuggestions() { regions = []; if (expiry !== null) env.clearTimeout(expiry); expiry = null; draw(); }
  function showError(reason) {
    if (disposed || reason?.name === 'AbortError') return;
    error.hidden = false; error.textContent = reason?.message || 'Camera setting could not be changed. Try again.';
    try { onError?.(reason); } catch { /* Host reporting must not break cleanup. */ }
  }
  function draw() {
    if (disposed) return;
    overlay.replaceChildren();
    const bounds = containedVideoRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight), stageBounds = stage.getBoundingClientRect();
    if (!bounds || !capabilities.active) return;
    for (const region of [...regions.map(value => ({ ...value, selected: false })), ...(target ? [{ ...target, selected: true }] : [])]) {
      const box = element('div', region.selected ? 'scanner-target-box selected' : 'scanner-target-box');
      box.style.left = `${bounds.left - stageBounds.left + region.x * bounds.width}px`;
      box.style.top = `${bounds.top - stageBounds.top + region.y * bounds.height}px`;
      box.style.width = `${region.width * bounds.width}px`; box.style.height = `${region.height * bounds.height}px`;
      overlay.append(box);
    }
  }
  function render() {
    if (disposed) return;
    const effective = scanner.getOptions();
    target = effective.targetRegion ? { ...effective.targetRegion } : null;
    adaptive = effective.adaptiveFrameSelection;
    fields.disabled = busy;
    camera.disabled = busy || !capabilities.active || cameras.length < 2;
    const selectedCamera = capabilities.deviceId;
    const nextCameraListKey = JSON.stringify([capabilities.active, cameras]);
    if (cameraListKey !== nextCameraListKey) {
      cameraListKey = nextCameraListKey; camera.replaceChildren();
      if (!cameras.length) { const option = element('option', '', capabilities.active ? 'Current camera' : 'Available after camera permission'); option.value = ''; camera.append(option); }
      cameras.forEach((entry, index) => { const option = element('option', '', entry.label || `Camera ${index + 1}`); option.value = entry.deviceId; camera.append(option); });
    }
    if (selectedCamera && camera.value !== selectedCamera) camera.value = selectedCamera;
    mode.value = capabilities.captureMode || 'balanced';
    torch.disabled = busy || !capabilities.active || !capabilities.torch?.supported;
    torch.textContent = capabilities.torch?.enabled ? 'Turn flashlight off' : 'Turn flashlight on';
    torch.setAttribute('aria-pressed', String(capabilities.torch?.enabled === true));
    const supportedZoom = capabilities.active && capabilities.zoom?.supported;
    zoom.disabled = busy || !supportedZoom;
    if (supportedZoom) { zoom.min = String(capabilities.zoom.min); zoom.max = String(capabilities.zoom.max); zoom.step = String(capabilities.zoom.step); if (doc.activeElement !== zoom || busy) zoom.value = String(capabilities.zoom.value); }
    else { zoom.min = zoom.max = zoom.value = '1'; }
    zoomValue.textContent = `${Number(zoom.value).toFixed(1).replace(/\.0$/, '')}×`;
    hardwareNote.textContent = !capabilities.active ? 'Start the camera to check flashlight and zoom support.'
      : [capabilities.torch?.supported ? 'Flashlight available.' : 'This camera/browser does not offer flashlight control.', supportedZoom ? 'Zoom available.' : 'This camera/browser does not offer zoom control.'].join(' ');
    adaptiveBox.checked = adaptive;
    clear.disabled = busy || !target;
    aim.setAttribute('aria-pressed', String(Boolean(target)));
    targetNote.textContent = target ? 'Scanning the selected area only. Conflicting codes inside it are still rejected.' : 'Scanning the full view. Tap a suggested area or use Aim at centre to select one label.';
    draw();
  }
  async function refresh() {
    if (disposed) return;
    const token = ++revision;
    try {
      const next = await scanner.listCameras();
      if (disposed || token !== revision) return;
      cameras = next.filter(item => typeof item.deviceId === 'string');
      capabilities = scanner.getCameraCapabilities(); render();
    } catch (reason) { if (!disposed && token === revision) { capabilities = scanner.getCameraCapabilities(); render(); showError(reason); } }
  }
  async function run(action) {
    if (disposed || busy) return;
    busy = true; error.hidden = true; clearSuggestions(); render();
    try { await action(); }
    catch (reason) { showError(reason); }
    finally { if (!disposed) { busy = false; capabilities = scanner.getCameraCapabilities(); render(); await refresh(); } }
  }
  function setTargetRegion(region) {
    if (disposed) return;
    if (region !== null && !validRegion(region)) throw new TypeError('Target must be a normalized rectangle inside the camera image.');
    const next = region ? { x: region.x, y: region.y, width: region.width, height: region.height } : null;
    scanner.setOptions({ targetRegion: next }); target = next; clearSuggestions(); render();
  }
  on(camera, 'change', () => { const id = camera.value; void run(() => scanner.switchCamera(id)); });
  on(mode, 'change', () => { const value = mode.value; void run(() => scanner.setCaptureMode(value)); });
  on(torch, 'click', () => { const enabled = !capabilities.torch?.enabled; void run(() => scanner.setTorch(enabled)); });
  on(zoom, 'change', () => { const value = Number(zoom.value); void run(() => scanner.setZoom(value)); });
  on(zoom, 'blur', render);
  on(adaptiveBox, 'change', () => {
    const next = adaptiveBox.checked;
    void run(() => { scanner.setOptions({ adaptiveFrameSelection: next }); adaptive = next; });
  });
  on(aim, 'click', () => { void run(() => setTargetRegion(CENTER)); });
  on(clear, 'click', () => { void run(() => setTargetRegion(null)); });
  on(stage, 'pointerup', event => {
    if (disposed || busy || !capabilities.active || (event.button !== undefined && event.button !== 0)) return;
    const point = pointToVideo({ x: event.clientX, y: event.clientY }, video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
    if (point) { const selected = targetAtPoint(point, regions); void run(() => setTargetRegion(selected)); }
  });
  on(video, 'loadedmetadata', draw); on(video, 'resize', draw); on(env, 'resize', draw);
  const observer = env.ResizeObserver ? new env.ResizeObserver(draw) : null; observer?.observe(stage);
  render(); void refresh();
  return Object.freeze({
    refresh,
    setTargetRegion,
    updateStatus(status) {
      if (disposed) return;
      capabilities = scanner.getCameraCapabilities();
      if (['starting', 'stopped', 'destroyed', 'error'].includes(status.state)) clearSuggestions();
      const key = `${capabilities.active}:${capabilities.deviceId}:${capabilities.captureMode}`;
      render(); if (key !== lastRefreshKey) { lastRefreshKey = key; void refresh(); }
    },
    updateCandidates(payload) {
      if (disposed || !capabilities.active || busy) return;
      if (expiry !== null) env.clearTimeout(expiry);
      regions = Array.isArray(payload?.regions) ? payload.regions.filter(validRegion).slice(0, 3) : [];
      draw(); expiry = env.setTimeout(clearSuggestions, 900);
    },
    destroy() {
      if (disposed) return;
      disposed = true; revision++; if (expiry !== null) env.clearTimeout(expiry);
      observer?.disconnect(); listeners.forEach(remove => remove()); overlay.remove(); details.remove();
      if (!hadStageClass) stage.classList.remove('scanner-controls-stage');
      if (video.style.objectFit === 'contain') video.style.objectFit = previousFit;
      if (video.style.objectPosition === 'center') video.style.objectPosition = previousPosition;
    },
  });
}
