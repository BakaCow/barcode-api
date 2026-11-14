import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),signal=require('../web/linear-signal.js');
const root=new URL('../',import.meta.url),fixtures=JSON.parse(readFileSync(new URL('tests/fixtures/damage-stress-qr-upgrade.json',root))).cases;
const pixels=f=>({width:f.width,height:f.height,data:new Uint8ClampedArray(inflateSync(Buffer.from(f.rgba_zlib_base64,'base64')))});
const base='https://offline.test/scan/';
const native=vm.createContext({console,URL,WebAssembly,Response,TextDecoder,TextEncoder,performance,ArrayBuffer,Uint8Array,Uint8ClampedArray,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array,Blob,
  ImageData:class{constructor(data,width,height){Object.assign(this,{data,width,height});}},
  async fetch(url){assert.equal(String(url),base+'vendor/zxing_reader.wasm');return new Response(readFileSync(new URL('web/vendor/zxing_reader.wasm',root)),{headers:{'Content-Type':'application/wasm'}});}});
vm.runInContext(readFileSync(new URL('web/vendor/zxing-reader.js',root),'utf8'),native);
native.ZXingWASM.setZXingModuleOverrides({locateFile:name=>base+'vendor/'+name});
await native.ZXingWASM.getZXingModule();
const readNative=image=>native.ZXingWASM.readBarcodes(image,{formats:['EAN13','Code128'],tryHarder:true,returnErrors:false,minLineCount:2});
const recover=(image,options={})=>signal.recover(image,{readNative,timeBudgetMs:1200,...options});
const targeted=fixtures.filter(f=>/^(ean13|code128)\//.test(f.name)&&/\/(motion-blur|small-in-frame)-2$/.test(f.name));
for(const fixture of targeted)test('source grayscale model recovers '+fixture.name,async()=>{
  const image=pixels(fixture),before=Buffer.from(image.data),result=await recover(image);
  assert.equal(result.complete,true);assert.equal(result.results.length,1);
  assert.equal(result.results[0].text,fixture.expected[0].text);
  assert.deepEqual(Array.from(result.results[0].bytes),Array.from(new TextEncoder().encode(fixture.expected[0].text)));
  assert.ok(result.results[0].signalProof.rows>=3);assert.ok(result.results[0].signalProof.rmse<=.045);
  assert.deepEqual(Buffer.from(image.data),before);
  for(const point of Object.values(result.results[0].position))assert.ok(point.x>=0&&point.x<=image.width&&point.y>=0&&point.y<=image.height);
});

test('all development damage negatives reject without canonicalizing guessed payloads',async()=>{
  for(const fixture of fixtures.filter(f=>!f.expected.length)){
    const result=await recover(pixels(fixture));assert.deepEqual(result.results,[],fixture.name);
  }
});
test('clipped source symbols cannot manufacture their missing quiet zones or guard bars',async()=>{
  for(const fixture of fixtures.filter(f=>/^(ean13|code128)\//.test(f.name)&&f.name.endsWith('/clipping-2'))){
    const result=await recover(pixels(fixture));assert.deepEqual(result.results,[],fixture.name);
  }
});
test('format allowlists suppress both grayscale candidate families before native calls',async()=>{
  for(const format of ['EAN13','Code128']){
    const fixture=targeted.find(f=>f.expected[0].formats[0]===format&&f.name.endsWith('/motion-blur-2'));
    const result=await recover(pixels(fixture),{formats:[format==='EAN13'?'Code128':'EAN13']});assert.deepEqual(result.results,[]);
  }
  let calls=0;const result=await recover(pixels(targeted[0]),{formats:['QRCode'],readNative:()=>{calls++;return [];}});
  assert.equal(calls,0);assert.deepEqual(result.results,[]);
});
function stacked(first,second,thin=false){
  const width=Math.max(first.width,second.width),height=first.height+40+(thin?2:second.height),data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=0;y<first.height;y++)data.set(first.data.subarray(y*first.width*4,(y+1)*first.width*4),y*width*4);
  for(let y=0;y<(thin?2:second.height);y++){
    const sourceY=thin?Math.floor(second.height/2):y;
    data.set(second.data.subarray(sourceY*second.width*4,(sourceY+1)*second.width*4),(first.height+40+y)*width*4);
  }
  return {width,height,data};
}
test('equal payloads at separate positions remain separate source observations',async()=>{
  const label=pixels(targeted.find(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/motion-blur-2'))),result=await recover(stacked(label,label));
  assert.equal(result.complete,true);assert.equal(result.results.length,2);
  assert.equal(result.results[0].text,result.results[1].text);
  assert.ok(result.results[0].position.bottomLeft.y<result.results[1].position.topLeft.y);
});
test('separate conflicting labels remain visible and are never selected by fit score',async()=>{
  const labels=targeted.filter(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/motion-blur-2')).slice(0,2);
  const result=await recover(stacked(...labels.map(pixels)));
  assert.equal(result.complete,true);assert.deepEqual(result.results.map(r=>r.text).sort(),labels.map(f=>f.expected[0].text).sort());
});
test('a credible second value with too few original rows vetoes unique acceptance',async()=>{
  const labels=targeted.filter(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/motion-blur-2')).slice(0,2);
  const result=await recover(stacked(...labels.map(pixels),true));
  assert.equal(result.complete,false);assert.equal(result.incompleteEvidence,true);assert.deepEqual(result.results,[]);
});
test('native bytes, validity and errors must agree with the source-fitted candidate',async()=>{
  const image=pixels(targeted.find(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/motion-blur-2')));
  for(const change of [code=>({...code,bytes:[1,2,3]}),code=>({...code,isValid:false}),code=>({...code,error:'checksum'})]){
    const result=await recover(image,{readNative:async candidate=>(await readNative(candidate)).map(change)});
    assert.deepEqual(result.results,[]);assert.equal(result.incompleteEvidence,true);
  }
});
test('zero budgets and invalid sizes never call native decoding',async()=>{
  let calls=0;const readNative=()=>{calls++;return [];};
  const result=await recover(pixels(targeted[0]),{timeBudgetMs:0,readNative});assert.deepEqual(result.results,[]);assert.equal(calls,0);
  await assert.rejects(()=>recover({width:1,height:1,data:new Uint8Array(3)}),/Invalid linear signal image/);
  await assert.rejects(()=>recover(pixels(targeted[0]),{timeBudgetMs:1201}),/Invalid linear signal options/);
});
test('deadline after a credible source fit preserves withheld evidence for callers',async()=>{
  let ticks=0,calls=0;
  const context=vm.createContext({ArrayBuffer,Uint8Array,Uint8ClampedArray,Float64Array,performance:{now:()=>++ticks<12?0:1000}});
  vm.runInContext(readFileSync(new URL('web/linear-signal.js',root),'utf8'),context);
  const fixture=targeted.find(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/motion-blur-2'));
  const result=await context.LinearSignal.recover(pixels(fixture),{formats:['EAN13'],timeBudgetMs:100,readNative:()=>{calls++;return [];}});
  assert.equal(result.complete,false);assert.equal(result.incompleteEvidence,true);assert.equal(calls,0);
  assert.equal(result.results.length,0);
});

test('competing valid EAN templates with poor source fit cannot be resolved by checksum',async()=>{
  const labels=targeted.filter(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/motion-blur-2')).slice(0,2).map(pixels);
  assert.equal(labels[0].width,labels[1].width);assert.equal(labels[0].height,labels[1].height);
  for(const weight of [.4,.5,.6]){
    const mixed={...labels[0],data:Uint8ClampedArray.from(labels[0].data,(value,i)=>Math.round(value*weight+labels[1].data[i]*(1-weight)))};
    let calls=0;const result=await recover(mixed,{readNative:async image=>{calls++;return readNative(image);}});
    assert.deepEqual(result.results,[]);assert.equal(calls,0);
  }
});

test('old Code128 semantic controls either retain exact encoder bytes or abstain',async()=>{
  const cases=JSON.parse(readFileSync(new URL('tests/fixtures/independent-code128-safety.json',root))).cases;
  let reads=0;
  for(const fixture of cases){
    const result=await recover(pixels(fixture));
    for(const code of result.results){
      assert.ok(fixture.expected.some(want=>want.formats.includes(code.format)&&Buffer.from(want.bytes).equals(Buffer.from(code.bytes))),fixture.name);
      reads++;
    }
  }
  assert.ok(reads>0,'Exercise successful source-fitted controls as well as abstentions.');
});

test('leading-zero EAN and UPC aliases are not reassigned by this EAN13 helper',async()=>{
  const cases=JSON.parse(readFileSync(new URL('tests/fixtures/independent-byte-controls.json',root))).cases;
  for(const fixture of cases.filter(f=>f.format==='UPCE'||f.name==='leading-zero-ean')){
    const result=await recover(pixels(fixture));assert.deepEqual(result.results,[],fixture.name);
  }
});

function staggeredDamage(input, color=255, fullHeight=false) {
  const output={...input,data:new Uint8ClampedArray(input.data)};
  let left=input.width,right=0;
  for(let y=0;y<input.height;y++)for(let x=0;x<input.width;x++)if(input.data[(y*input.width+x)*4]<100){left=Math.min(left,x);right=Math.max(right,x+1);}
  const span=right-left,patch=Math.max(18,Math.round(span*.075));
  for(let y=0;y<input.height;y++){
    const part=fullHeight?1:Math.floor(y*9/input.height)%3,center=Math.round(left+span*(.25+.25*part));
    for(let x=center-Math.floor(patch/2);x<center+Math.ceil(patch/2);x++){
      const p=(y*input.width+x)*4;output.data[p]=output.data[p+1]=output.data[p+2]=color;
    }
  }
  return output;
}
for(const family of ['ean13','code128'])for(const color of [0,255])test(`cross-row source reconstruction recovers ${family} with staggered ${color?'white':'black'} patches`,async()=>{
  const fixture=fixtures.find(f=>f.name.startsWith(family+'/')&&f.name.endsWith('/clean-0'));
  const damaged=staggeredDamage(pixels(fixture),color),before=Buffer.from(damaged.data);
  assert.equal((await readNative(damaged)).length,0,'The whole native image must actually need the new recovery.');
  const result=await recover(damaged);
  assert.equal(result.complete,true);assert.equal(result.results.length,1);
  assert.equal(result.results[0].text,fixture.expected[0].text);
  assert.deepEqual(Array.from(result.results[0].bytes),Array.from(new TextEncoder().encode(fixture.expected[0].text)));
  assert.equal(result.results[0].signalProof.strategy,'cross-row-source');
  assert.ok(result.results[0].signalProof.rows>=5);assert.deepEqual(Buffer.from(damaged.data),before);
});
test('source-supported full EAN is recovered from the known native false-UPC-E development image',async()=>{
  const cases=JSON.parse(readFileSync(new URL('tests/fixtures/damage-stress-signal-upgrade.json',root))).cases;
  const fixture=cases.find(f=>f.name==='ean13/signal-upgrade-ean13-label-1/missing-patch-1');
  const result=await recover(pixels(fixture));
  assert.equal(result.complete,true);assert.equal(result.results.length,1);
  assert.equal(result.results[0].format,'EAN13');assert.equal(result.results[0].text,fixture.expected[0].text);
  assert.equal(result.results[0].signalProof.strategy,'cross-row-source');
});
test('a missing full-height stripe cannot be supplied by row reconstruction',async()=>{
  for(const family of ['ean13','code128'])for(const color of [0,255]){
    const fixture=fixtures.find(f=>f.name.startsWith(family+'/')&&f.name.endsWith('/clean-0'));
    const result=await recover(staggeredDamage(pixels(fixture),color,true));
    assert.deepEqual(result.results,[],family+' '+color);
  }
});
test('cross-row reconstruction preserves native control and shifted Code128 bytes',async()=>{
  const cases=JSON.parse(readFileSync(new URL('tests/fixtures/independent-code128-safety.json',root))).cases;
  for(const group of [1,5]){
    const fixture=cases.find(f=>f.name===`code128/independent-code128-${group}/clean`);
    const result=await recover(staggeredDamage(pixels(fixture)));
    assert.equal(result.complete,true);assert.equal(result.results.length,1);
    assert.deepEqual(Array.from(result.results[0].bytes),fixture.expected[0].bytes);
    assert.equal(result.results[0].signalProof.strategy,'cross-row-source');
  }
});
test('cross-row reconstruction keeps separate equal and conflicting labels',async()=>{
  const labels=fixtures.filter(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/clean-0')).slice(0,2);
  for(const same of [true,false]){
    const chosen=[labels[0],labels[same?0:1]];
    const result=await recover(stacked(...chosen.map(f=>staggeredDamage(pixels(f)))));
    assert.equal(result.complete,true);assert.equal(result.results.length,2);
    assert.deepEqual(result.results.map(r=>r.text).sort(),chosen.map(f=>f.expected[0].text).sort());
    assert.ok(result.results[0].position.bottomLeft.y<result.results[1].position.topLeft.y);
  }
});
test('different valid bar structures in one activity band cannot be voted away as damage',async()=>{
  const labels=fixtures.filter(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/clean-0')).slice(0,2).map(f=>staggeredDamage(pixels(f)));
  for(const fraction of [.2,.4]){
    const mixed={...labels[0],data:new Uint8ClampedArray(labels[0].data)};
    mixed.data.set(labels[1].data.subarray(Math.floor(mixed.height*(1-fraction))*mixed.width*4),Math.floor(mixed.height*(1-fraction))*mixed.width*4);
    const result=await recover(mixed);assert.deepEqual(result.results,[]);
  }
});
test('uninspected content beside a reconstructed Code128 cannot disappear behind a singleton',async()=>{
  const fixture=fixtures.find(f=>f.name.startsWith('code128/')&&f.name.endsWith('/clean-0'));
  const label=staggeredDamage(pixels(fixture)),width=label.width*2+40,data=new Uint8ClampedArray(width*label.height*4).fill(255);
  for(let y=0;y<label.height;y++)for(const x of [0,label.width+40])data.set(label.data.subarray(y*label.width*4,(y+1)*label.width*4),(y*width+x)*4);
  const result=await recover({width,height:label.height,data});
  assert.equal(result.complete,false);assert.equal(result.incompleteEvidence,true);assert.deepEqual(result.results,[]);
});
test('a native call overrunning the deadline with reconstructed evidence cannot publish it',async()=>{
  let time=0;
  const context=vm.createContext({ArrayBuffer,Uint8Array,Uint8ClampedArray,Float64Array,performance:{now:()=>time}});
  vm.runInContext(readFileSync(new URL('web/linear-signal.js',root),'utf8'),context);
  const fixture=fixtures.find(f=>f.name.startsWith('ean13/')&&f.name.endsWith('/clean-0'));
  const result=await context.LinearSignal.recover(staggeredDamage(pixels(fixture)),{formats:['EAN13'],timeBudgetMs:100,readNative:async image=>{
    const found=await readNative(image);time=101;return found;
  }});
  assert.equal(result.complete,false);assert.equal(result.incompleteEvidence,true);assert.equal(result.results.length,0);
});
