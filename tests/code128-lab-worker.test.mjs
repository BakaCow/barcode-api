import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import vm from 'node:vm';
const web=new URL('../web/',import.meta.url);
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/accuracy-pixels.json',import.meta.url),'utf8')).cases;
function harness(){
  const messages=[],requests=[];let context;
  const globals={URL,WebAssembly,Response,TextDecoder,TextEncoder,performance,ArrayBuffer,Uint8Array,Uint8ClampedArray,Uint16Array,Uint32Array,Float64Array,Float32Array,Int8Array,Int16Array,Int32Array,BigInt64Array,BigUint64Array,Blob,
    ImageData:class{constructor(data,width,height){Object.assign(this,{data,width,height});}},
    location:{href:'https://offline.test/scan/code128-lab-worker.js'},
    importScripts(...paths){for(const path of paths){assert.ok(path.startsWith('./')&&!path.includes('..'));vm.runInContext(readFileSync(new URL(path,web),'utf8'),context,{filename:path});}},
    async fetch(url){requests.push(String(url));assert.equal(String(url),'https://offline.test/scan/vendor/zxing_reader.wasm');return new Response(readFileSync(new URL('vendor/zxing_reader.wasm',web)),{headers:{'Content-Type':'application/wasm'}});},
    postMessage:message=>messages.push(message)};
  context=vm.createContext(globals);context.self=context;vm.runInContext(readFileSync(new URL('code128-lab-worker.js',web),'utf8'),context);
  return {requests,async send(message){await context.onmessage({data:{id:1,...message}});return JSON.parse(JSON.stringify(messages.at(-1)));}};
}
function pixels(name){const c=fixtures.find(c=>c.name===name),data=inflateSync(Buffer.from(c.rgba_zlib_base64,'base64'));return{width:c.width,height:c.height,data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)};}
test('custom mode decodes independently without loading the external WASM decoder',async()=>{
  const worker=harness(),reply=await worker.send({type:'decode',engine:'custom',image:pixels('code128/rotate-37')});
  assert.equal(reply.type,'result',reply.message);assert.equal(reply.customResults[0].text,'ACCURACY-421913-BOX');assert.deepEqual(worker.requests,[]);
});
test('paired engines return actual results and nonnegative timings for identical pixels',async()=>{
  const worker=harness();assert.equal((await worker.send({type:'init'})).type,'ready');
  const reply=await worker.send({type:'decode',engine:'both',image:pixels('code128/clean')});
  assert.equal(reply.type,'result',reply.message);
  assert.equal(reply.customResults[0].text,reply.baselineResults[0].text);
  assert.deepEqual(reply.customResults[0].bytes,reply.baselineResults[0].bytes);
  assert.ok(reply.timings.customMs>=0&&reply.timings.zxingMs>=0);assert.equal(worker.requests.length,1);
});
test('Code128 comparison excludes other symbologies rather than reporting them as Code128',async()=>{
  const reply=await harness().send({type:'decode',engine:'both',image:pixels('qr/clean')});
  assert.equal(reply.type,'result',reply.message);assert.deepEqual(reply.customResults,[]);assert.deepEqual(reply.baselineResults,[]);
});
test('lab worker rejects invalid dimensions and unknown engines',async()=>{
  for(const message of [{engine:'custom',image:{width:9000,height:1,data:new ArrayBuffer(36000)}},{engine:'custom',image:{width:5,height:5,data:new ArrayBuffer(4)}},{engine:'guess',image:pixels('code128/clean')}]){
    const worker=harness(),reply=await worker.send({type:'decode',...message});assert.equal(reply.type,'error');assert.deepEqual(worker.requests,[]);
  }
});
