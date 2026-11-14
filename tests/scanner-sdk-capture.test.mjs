import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, regionPlan, sourceRegions, clearFrame, cameraCapabilities, boundedZoom } from '../web/sdk/capture-tools.js';

test('normalized targets reject empty, outside-image and malformed rectangles', () => {
  for (const region of [{x:-0.1,y:0,width:1,height:1}, {x:0.9,y:0,width:0.2,height:1}, {x:0,y:0,width:0,height:1},
    {x:0,y:0,width:NaN,height:1}, {x:0,y:0,width:1,height:1,extra:true}]) assert.throws(() => validateTarget(region));
  const original = {x:0.2,y:0.3,width:0.4,height:0.5}; const target = validateTarget(original);
  original.x = 0; assert.equal(target.x, 0.2); assert.equal(validateTarget(null), null);
});

test('detail ROI keeps native source pixels while full-view capture remains bounded', () => {
  const target = {x:0.25,y:0.25,width:0.25,height:0.25};
  const plan = regionPlan(3840,2160,target,4_000_000,3840);
  assert.deepEqual(plan,{x:960,y:540,cropWidth:960,cropHeight:540,width:960,height:540});
  const broad = regionPlan(3840,2160,null,2_100_000);
  assert.equal(broad.width,1920); assert.equal(broad.height,1080);
  const tiny = regionPlan(100,100,{x:0.999,y:0.999,width:0.001,height:0.001},1,3840);
  assert.equal(tiny.width*tiny.height,1);
});

test('regions map from a resized target into normalized original-source coordinates', () => {
  const plan = {x:1000,y:500,cropWidth:2000,cropHeight:1000,width:1000,height:500};
  const mapped = sourceRegions({regions:[{x:100,y:50,width:400,height:200,kind:'linear'}]},plan,4000,2000)[0];
  assert.deepEqual(mapped,{x:0.3,y:0.3,width:0.2,height:0.2,kind:'linear'});
});

test('early decode requires a clear unique useful-sized proposal', () => {
  const good = {score:90,hint:null,regions:[{width:300,height:100}]};
  assert.equal(clearFrame(good,1000,500),true);
  for (const bad of [{...good,score:60},{...good,hint:'glare'},{...good,regions:[]},
    {...good,regionsComplete:false}, {...good,qr:{complete:false}},
    {...good,regions:[...good.regions,...good.regions]}, {...good,regions:[{width:2,height:2}]}]) assert.equal(clearFrame(bad,1000,500),false);
});

test('capability probes tolerate browser exceptions and reject invalid zoom ranges', () => {
  const throwing = {getCapabilities(){throw Error();},getSettings(){throw Error();}};
  const result = cameraCapabilities(throwing,'detail');
  assert.equal(result.zoom,null); assert.equal(result.torch.supported,false); assert.equal(result.captureMode,'detail');
  assert.equal(cameraCapabilities({getCapabilities:()=>({zoom:{min:-1,max:4}})},'balanced').zoom,null);
  assert.throws(()=>boundedZoom(NaN,{supported:true,min:1,max:4,step:0.5}));
  assert.equal(boundedZoom(9,{supported:true,min:1,max:4,step:0.5}),4);
  assert.equal(boundedZoom(1.31,{supported:true,min:1,max:4,step:0.5}),1.5);
});
