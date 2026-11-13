import test from 'node:test';
import assert from 'node:assert/strict';
import { attachScannerControls, containedVideoRect, pointToVideo, targetAtPoint } from '../web/sdk/controls.js';

test('contain geometry handles landscape video inside a square without targeting letterboxing', () => {
  const rect = { left: 10, top: 20, width: 400, height: 400 };
  assert.deepEqual(containedVideoRect(rect, 1920, 1080), { left: 10, top: 107.5, width: 400, height: 225 });
  assert.equal(pointToVideo({ x: 210, y: 60 }, rect, 1920, 1080), null);
  assert.deepEqual(pointToVideo({ x: 210, y: 220 }, rect, 1920, 1080), { x: .5, y: .5 });
});

test('portrait camera mapping rejects side bars and preserves source coordinates', () => {
  const rect = { left: 0, top: 0, width: 600, height: 400 };
  assert.equal(pointToVideo({ x: 50, y: 200 }, rect, 1080, 1920), null);
  assert.deepEqual(pointToVideo({ x: 300, y: 200 }, rect, 1080, 1920), { x: .5, y: .5 });
  assert.equal(containedVideoRect(rect, 0, 0), null);
});

test('target selection uses a containing proposal and never leaves image bounds', () => {
  const proposed = { x: .2, y: .3, width: .15, height: .1, kind: 'linear' };
  assert.deepEqual(targetAtPoint({ x: .25, y: .35 }, [proposed]), { x: .2, y: .3, width: .15, height: .1 });
  assert.deepEqual(targetAtPoint({ x: 1, y: 1 }), { x: .4, y: .6, width: .6, height: .4 });
  assert.equal(targetAtPoint({ x: -1, y: .5 }), null);
  assert.equal(targetAtPoint({ x: NaN, y: .5 }), null);
});

class Element extends EventTarget {
  constructor(tag, doc) { super(); this.tagName = tag; this.ownerDocument = doc; this.children = []; this.style = {}; this.attributes = new Map(); this.className = ''; this.value = ''; this.bounds = { left: 10, top: 20, width: 400, height: 400 }; }
  get classList() { return { contains: value => this.className.split(' ').includes(value), add: value => { if (!this.className.split(' ').includes(value)) this.className += ` ${value}`; }, remove: value => { this.className = this.className.split(' ').filter(item => item !== value).join(' '); } }; }
  append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  getBoundingClientRect() { return this.bounds; }
  contains(node) { return all(this).includes(node); }
  focus() { if (!this.disabled) { this.ownerDocument.activeElement = this; const event = new Event('focusin'); Object.defineProperty(event, 'target', { value: this }); this.ownerDocument.dispatchEvent(event); } }
  set disabled(value) { this._disabled = value; if (value && all(this).includes(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; }
  get disabled() { return this._disabled || false; }
  set textContent(value) { this._text = value; this.replaceChildren(); }
  get textContent() { return (this._text || '') + this.children.map(child => child.textContent).join(''); }
}
function all(node) { return [node, ...node.children.flatMap(all)]; }
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

function harness(t, options = {}) {
  const env = new EventTarget(); env.setTimeout = setTimeout; env.clearTimeout = clearTimeout;
  let observed = 0, disconnected = 0;
  env.ResizeObserver = class { observe() { observed++; } disconnect() { disconnected++; } };
  const doc = Object.assign(new EventTarget(), { defaultView: env, activeElement: null, createElement(tag) { return new Element(tag, doc); } }); doc.body = doc.createElement('body'); doc.activeElement = doc.body;
  const container = doc.createElement('div'), stage = doc.createElement('div'), video = doc.createElement('video');
  video.videoWidth = 1920; video.videoHeight = 1080; video.style.objectFit = 'cover'; stage.append(video);
  const caps = { active: options.active ?? true, deviceId: 'rear', torch: { supported: true, enabled: false }, zoom: { supported: true, min: 1, max: 4, step: .1, value: 1 }, width: 1920, height: 1080, captureMode: 'balanced' };
  const calls = [];
  let effective = { adaptiveFrameSelection: true, targetRegion: null, ...options.initialOptions };
  const scanner = {
    getCameraCapabilities: () => structuredClone(caps),
    getOptions: () => structuredClone(effective),
    listCameras: options.listCameras || (async () => [{ deviceId: 'rear', label: 'Rear camera' }, { deviceId: 'front', label: 'Front camera' }]),
    setOptions: value => { calls.push(['options', value]); effective = { ...effective, ...value }; },
    setCaptureMode: async value => { calls.push(['mode', value]); caps.captureMode = value; },
    setTorch: options.setTorch || (async value => { calls.push(['torch', value]); caps.torch.enabled = value; }),
    setZoom: async value => { calls.push(['zoom', value]); caps.zoom.value = value; },
    switchCamera: options.switchCamera || (async value => { calls.push(['camera', value]); caps.deviceId = value; }),
  };
  const controls = attachScannerControls({ container, video, scanner }); t.after(() => controls.destroy());
  const byId = suffix => all(container).find(node => node.id?.endsWith(`-${suffix}`));
  const button = text => all(container).find(node => node.tagName === 'button' && node.textContent === text);
  const fire = (node, type, properties = {}) => { const event = new Event(type); Object.assign(event, properties); node.dispatchEvent(event); };
  return { controls, container, stage, video, caps, calls, byId, button, fire, doc, scanner, get observed() { return observed; }, get disconnected() { return disconnected; } };
}

test('controls check capabilities without starting a camera', async t => {
  const h = harness(t, { active: false }); await settle();
  assert.equal(h.button('Turn flashlight on').disabled, true);
  assert.equal(h.byId('zoom').disabled, true);
  assert.equal(h.byId('camera').disabled, true);
  assert.equal(h.video.style.objectFit, 'contain');
  assert.deepEqual(h.calls, []);
});

test('unsupported controls remain disabled with an explanation', async t => {
  const h = harness(t); h.caps.torch.supported = false; h.caps.zoom = null; h.controls.updateStatus({ state: 'scanning' }); await settle();
  assert.equal(h.button('Turn flashlight on').disabled, true); assert.equal(h.byId('zoom').disabled, true);
  assert.match(h.container.textContent, /does not offer flashlight/); assert.match(h.container.textContent, /does not offer zoom/);
});

test('camera, torch, zoom and detail controls call the SDK instead of browser internals', async t => {
  const h = harness(t); await settle();
  h.fire(h.button('Turn flashlight on'), 'click'); await settle();
  assert.equal(h.button('Turn flashlight off').getAttribute('aria-pressed'), 'true');
  h.byId('zoom').value = '2'; h.fire(h.byId('zoom'), 'change'); await settle();
  h.byId('camera').value = 'front'; h.fire(h.byId('camera'), 'change'); await settle();
  h.byId('detail').value = 'detail'; h.fire(h.byId('detail'), 'change'); await settle();
  assert.deepEqual(h.calls, [['torch', true], ['zoom', 2], ['camera', 'front'], ['mode', 'detail']]);
});

test('keyboard-accessible aiming and full-view reset preserve confirmation settings', async t => {
  const h = harness(t); await settle();
  h.fire(h.button('Aim at centre'), 'click'); await settle();
  assert.deepEqual(h.calls[0], ['options', { targetRegion: { x: .15, y: .275, width: .7, height: .45 } }]);
  assert.match(h.container.textContent, /Conflicting codes inside it are still rejected/);
  h.fire(h.button('Scan full view'), 'click'); await settle();
  assert.deepEqual(h.calls[1], ['options', { targetRegion: null }]);
  assert.equal(h.button('Scan full view').disabled, true);
});

test('tap coordinates ignore black bars and select only a current proposal', async t => {
  const h = harness(t); await settle();
  h.controls.updateCandidates({ regions: [{ x: .4, y: .4, width: .2, height: .2 }] });
  h.fire(h.stage, 'pointerup', { clientX: 210, clientY: 40, button: 0 }); await settle(); assert.equal(h.calls.length, 0);
  h.fire(h.stage, 'pointerup', { clientX: 210, clientY: 220, button: 0 }); await settle();
  assert.deepEqual(h.calls[0], ['options', { targetRegion: { x: .4, y: .4, width: .2, height: .2 } }]);
});

test('adaptive option changes only scheduling, never confirmation policy', async t => {
  const h = harness(t); await settle();
  const checkbox = all(h.container).find(node => node.type === 'checkbox'); checkbox.checked = false; h.fire(checkbox, 'change'); await settle();
  assert.deepEqual(h.calls, [['options', { adaptiveFrameSelection: false }]]);
});

test('destroy removes overlays/listeners and ignores delayed capability enumeration', async t => {
  const request = deferred(), h = harness(t, { listCameras: () => request.promise });
  h.controls.updateCandidates({ regions: [{ x: .2, y: .2, width: .2, height: .2 }] });
  h.controls.destroy(); request.resolve([{ deviceId: 'late', label: 'Late camera' }]); await settle();
  h.fire(h.stage, 'pointerup', { clientX: 210, clientY: 220, button: 0 });
  assert.equal(h.container.children.length, 0); assert.deepEqual(h.stage.children, [h.video]);
  assert.equal(h.video.style.objectFit, 'cover'); assert.equal(h.disconnected, h.observed); assert.deepEqual(h.calls, []);
});

test('a hardware operation finishing after unmount cannot recreate controls', async t => {
  const request = deferred(), h = harness(t, { setTorch: () => request.promise }); await settle();
  h.fire(h.button('Turn flashlight on'), 'click'); h.controls.destroy(); request.resolve(); await settle();
  assert.equal(h.container.children.length, 0); assert.deepEqual(h.stage.children, [h.video]);
});

test('stale enumeration cannot replace a newer camera list', async t => {
  const request = deferred(); let count = 0;
  const h = harness(t, { listCameras: () => ++count === 1 ? request.promise : Promise.resolve([{ deviceId: 'rear', label: 'New camera list' }]) });
  await h.controls.refresh(); request.resolve([{ deviceId: 'old', label: 'Old camera list' }]); await settle();
  assert.match(h.byId('camera').textContent, /New camera list/); assert.doesNotMatch(h.byId('camera').textContent, /Old camera list/);
});

test('proposal rectangles are visual suggestions and never emit accepted scans', async t => {
  const h = harness(t); await settle();
  h.controls.updateCandidates({ regions: [{ x: .2, y: .2, width: .2, height: .2 }, { x: -1, y: 0, width: 1, height: 1 }] });
  const overlay = h.stage.children.find(node => node.className === 'scanner-target-overlay');
  assert.equal(overlay.children.length, 1); assert.deepEqual(h.calls, []);
  h.caps.active = false; h.controls.updateStatus({ state: 'stopped' });
  assert.equal(overlay.children.length, 0);
});

test('changing a slider during a status update does not reset an in-progress gesture', async t => {
  const h = harness(t); await settle();
  h.doc.activeElement = h.byId('zoom'); h.byId('zoom').value = '2.5';
  h.controls.updateStatus({ state: 'scanning' }); assert.equal(h.byId('zoom').value, '2.5');
});

test('controls reflect existing and externally changed SDK options', async t => {
  const region = { x: .1, y: .2, width: .6, height: .5 };
  const h = harness(t, { initialOptions: { adaptiveFrameSelection: false, targetRegion: region } }); await settle();
  const checkbox = all(h.container).find(node => node.type === 'checkbox');
  assert.equal(checkbox.checked, false); assert.equal(h.button('Scan full view').disabled, false);
  assert.match(h.container.textContent, /selected area only/);
  h.scanner.setOptions({ adaptiveFrameSelection: true, targetRegion: null }); h.controls.updateStatus({ state: 'scanning' });
  assert.equal(checkbox.checked, true); assert.equal(h.button('Scan full view').disabled, true);
  assert.match(h.container.textContent, /Scanning the full view/);
});

test('native keyboard sliders can select an arbitrary off-centre area and announce it', async t => {
  const h = harness(t); await settle();
  for (const [name, value] of [['width', '20'], ['height', '15'], ['x', '70'], ['y', '10']]) {
    const input = h.byId(`area-${name}`); input.focus(); input.value = value; h.fire(input, 'input'); h.fire(input, 'change'); await settle();
    assert.equal(h.doc.activeElement, input); assert.equal(input.getAttribute('aria-valuetext'), `${value}%`);
  }
  assert.deepEqual(h.scanner.getOptions().targetRegion, { x: .7, y: .1, width: .2, height: .15 });
  assert.match(h.container.textContent, /left 70%, top 10%, width 20%, height 15%/);
  assert.equal(h.byId('area-x').max, '80'); assert.equal(h.byId('area-width').max, '30');
  assert.ok(h.calls.every(([method, options]) => method === 'options' && Object.keys(options).join() === 'targetRegion'));
  h.fire(h.button('Scan full view'), 'click'); await settle(); assert.equal(h.scanner.getOptions().targetRegion, null);
});

test('busy hardware adjustments keep keyboard focus and reject duplicate actions', async t => {
  const request = deferred(); let calls = 0;
  const h = harness(t, { setTorch: () => { calls++; return request.promise; } }); await settle();
  const torch = h.button('Turn flashlight on'); torch.focus(); h.fire(torch, 'click');
  assert.equal(h.doc.activeElement, torch); assert.equal(torch.disabled, false); assert.equal(torch.getAttribute('aria-disabled'), 'true');
  h.fire(torch, 'click'); assert.equal(calls, 1);
  request.resolve(); await settle();
  assert.equal(h.doc.activeElement, torch); assert.equal(torch.getAttribute('aria-disabled'), 'false');
});

test('completing an adjustment does not steal focus from a different control', async t => {
  const request = deferred(), h = harness(t, { setTorch: () => request.promise }); await settle();
  const torch = h.button('Turn flashlight on'); torch.focus(); h.fire(torch, 'click');
  h.byId('detail').focus(); request.resolve(); await settle(); assert.equal(h.doc.activeElement, h.byId('detail'));
});

test('camera restart keeps focus while the stream is temporarily inactive', async t => {
  const request = deferred(), h = harness(t, { switchCamera: () => request.promise }); await settle();
  const camera = h.byId('camera'); camera.focus(); camera.value = 'front'; h.fire(camera, 'change');
  h.caps.active = false; h.controls.updateStatus({ state: 'starting' });
  assert.equal(camera.disabled, false); assert.equal(h.doc.activeElement, camera);
  h.caps.active = true; h.caps.deviceId = 'front'; request.resolve(); await settle();
  assert.equal(h.doc.activeElement, camera); assert.equal(camera.disabled, false);
});

test('a control that becomes unavailable returns focus to its disclosure', async t => {
  const request = deferred(), h = harness(t, { setTorch: () => request.promise }); await settle();
  const torch = h.button('Turn flashlight on'); torch.focus(); h.fire(torch, 'click');
  h.caps.torch.supported = false; request.resolve(); await settle();
  assert.equal(torch.disabled, true); assert.equal(h.doc.activeElement.tagName, 'summary'); assert.equal(h.doc.activeElement.textContent, 'Camera and targeting');
});
