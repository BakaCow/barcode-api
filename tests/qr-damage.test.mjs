import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), signal = require('../web/qr-damage.js');
const root = new URL('../', import.meta.url);
const load = file => JSON.parse(readFileSync(new URL('tests/fixtures/' + file, root))).cases;
const cases = ['damage-stress-dev.json', 'damage-stress-signal-upgrade.json', 'damage-stress-qr-upgrade.json'].flatMap(load);
const targetNames=['qr/qr-upgrade-qr-label-2/missing-patch-1', ...[1,2,3].map(n=>`qr/signal-upgrade-qr-label-${n}/missing-patch-1`), 'qr/dev-qr-label-2/scratches-2', 'qr/dev-qr-label-2/missing-patch-2'];
const targets=targetNames.map(name=>cases.find(f=>f.name===name));
const pixels = f => ({ width: f.width, height: f.height, data: new Uint8ClampedArray(inflateSync(Buffer.from(f.rgba_zlib_base64, 'base64'))) });
const native = vm.createContext({ console, URL, WebAssembly, Response, TextDecoder, TextEncoder, performance,
  ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array, Blob,
  async fetch(url) { assert.equal(String(url), 'https://offline.test/zxing_reader.wasm');
    return new Response(readFileSync(new URL('web/vendor/zxing_reader.wasm', root)), { headers: { 'Content-Type': 'application/wasm' } }); }
});
vm.runInContext(readFileSync(new URL('web/vendor/zxing-reader.js', root), 'utf8'), native);
await native.ZXingWASM.prepareZXingModule({ overrides: { locateFile: name => 'https://offline.test/' + name }, fireImmediately: true });
const readNative = (image, options = {}) => native.ZXingWASM.readBarcodes(image, { formats: ['QRCode'], tryHarder: true, returnErrors: false, ...options });
const recover = (image, options = {}) => signal.recover(image, { readNative, timeBudgetMs: 700, ...options });

for (const fixture of targets) test('source-supported QR erasures recover '+fixture.name,async()=>{
  const image=pixels(fixture),before=Buffer.from(image.data),found=await recover(image);
  assert.equal(found.complete,true);assert.equal(found.results.length,1);
  assert.equal(found.results[0].text,fixture.expected[0].text);
  assert.deepEqual(Array.from(found.results[0].bytes),Array.from(new TextEncoder().encode(fixture.expected[0].text)));
  assert.deepEqual(Buffer.from(image.data),before);
  for(const p of Object.values(found.results[0].position))assert.ok(p.x>=0&&p.y>=0&&p.x<=image.width&&p.y<=image.height);
});

test('all three old negative sets and cut QR symbols abstain',async()=>{
  for(const fixture of cases.filter(f=>!f.expected.length||f.name.startsWith('qr/')&&f.name.endsWith('/clipping-2')))
    assert.deepEqual((await recover(pixels(fixture))).results,[],fixture.name);
});

const geometry=require('../web/qr-geometry.js');
function stripe(image){
  const region=geometry.analyze(image,{timeBudgetMs:500}).regions[0];assert.ok(region);
  const grid=signal.sourceGrid(image,region,()=>false);assert.ok(grid);
  const col=Math.floor(region.dimension/2),a=grid.map(col,0),b=grid.map(col+1,region.dimension);
  const data=new Uint8ClampedArray(image.data);
  for(let y=Math.round(a.y);y<Math.round(b.y);y++)for(let x=Math.round(a.x);x<Math.round(b.x);x++){
    const i=(y*image.width+x)*4;data[i]=data[i+1]=data[i+2]=255;
  }
  return {...image,data};
}

test('damaged binary/control/Latin1/UTF8 QR preserves native canonical bytes and text',async()=>{
  for(const fixture of load('independent-byte-controls.json').filter(f=>f.format==='QRCode')){
    const original=pixels(fixture),canonical=(await readNative(original))[0],found=await recover(stripe(original));
    assert.equal(found.complete,true);assert.equal(found.results.length,1,fixture.name);
    assert.equal(found.results[0].text,canonical.text);
    assert.deepEqual(Array.from(found.results[0].bytes),fixture.encoderBytes);
  }
});

test('erasure correction cannot change confident bits or spend the entire parity budget',()=>{
  const input=pixels(targets[0]),region=geometry.analyze(input,{timeBudgetMs:500}).regions[0],grid=signal.sourceGrid(input,region,()=>false);
  assert.ok(signal.repair(grid,{timeBudgetMs:60}));
  assert.equal(signal.repair({...grid,uncertainty:new Uint8Array(grid.uncertainty.length)},{timeBudgetMs:60}),null);
  assert.equal(signal.repair({...grid,uncertainty:new Uint8Array(grid.uncertainty.length).fill(1)},{timeBudgetMs:60}),null);
  const repaired=signal.repair(grid,{timeBudgetMs:60});
  for(let i=0;i<grid.modules.length;i++)if(!grid.uncertainty[i])assert.equal(repaired.modules[i],grid.modules[i]);
});

test('native invalidity, disallowed formats and unrelated footprints cannot escape',async()=>{
  for(const change of [r=>({...r,isValid:false}),r=>({...r,error:'invalid'}),r=>({...r,format:'Code128'}),
    r=>({...r,position:Object.fromEntries(Object.entries(r.position).map(([k,p])=>[k,{x:p.x+1000,y:p.y}]))})]){
    assert.deepEqual((await recover(pixels(targets[0]),{readNative:async(image,options)=>(await readNative(image,options)).map(change)})).results,[]);
  }
});

function joined(first,second){
  const offset=Math.max(first.width,first.height)+25,side=offset+Math.max(second.width,second.height),data=new Uint8ClampedArray(side*side*4).fill(255);
  for(const [image,shift] of [[first,0],[second,offset]])for(let y=0;y<image.height;y++)
    data.set(image.data.subarray(y*image.width*4,(y+1)*image.width*4),((y+shift)*side+shift)*4);
  return {width:side,height:side,data};
}
test('separate equal labels remain separate, and distinct identities stay ambiguous',async()=>{
  for(const second of [targets[0],targets[1]]){
    const found=await recover(joined(pixels(targets[0]),pixels(second)));
    assert.equal(found.complete,true);assert.equal(found.results.length,2);
    assert.ok(Math.abs(found.results[0].position.topLeft.x-found.results[1].position.topLeft.x)>100);
  }
});

test('unresolved neighbouring QR geometry and native deadline overruns preserve withheld evidence',async()=>{
  const unread=cases.find(f=>f.name==='qr/qr-upgrade-qr-label-2/missing-patch-2');
  const partial=await recover(joined(pixels(targets[0]),pixels(unread)));
  assert.equal(partial.complete,false);assert.ok(partial.observed>0);assert.deepEqual(partial.results,[]);
  let time=0;const module={exports:{}};
  vm.runInNewContext(readFileSync(new URL('web/qr-damage.js',root),'utf8'),{
    module,require:()=>geometry,performance:{now:()=>time},ArrayBuffer,Uint8Array,Uint8ClampedArray,Float32Array});
  const overrun=await module.exports.recover(pixels(targets[0]),{timeBudgetMs:700,readNative:async(image,options)=>{
    const found=await readNative(image,options);time=701;return found;
  }});
  assert.equal(overrun.complete,false);assert.equal(overrun.observed,1);assert.equal(overrun.incompleteEvidence,true);assert.equal(overrun.results.length,0);
});

