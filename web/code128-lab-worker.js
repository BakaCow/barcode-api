/* Lab comparison: both engines receive identical pixels; labels stay in the UI. */
importScripts('./engine/code128-decoder.js','./engine/code128-detector.js','./engine/code128-engine.js','./vendor/zxing-reader.js');
let initialized,busy=false;
function initialize(){
  initialized ||= ZXingWASM.prepareZXingModule({overrides:{locateFile:path=>new URL('./vendor/'+path,self.location.href).href},fireImmediately:true}).catch(error=>{initialized=null;throw error;});
  return initialized;
}
async function baseline(image){
  const found=await ZXingWASM.readBarcodes(image,{formats:['Code128'],tryHarder:true,tryRotate:true,tryInvert:true,minLineCount:2,returnErrors:false,maxNumberOfSymbols:8});
  return found.filter(r=>r.isValid===true&&!r.error).map(r=>({text:r.text,format:r.format,bytes:Array.from(r.bytes||[]),position:r.position}));
}
self.onmessage=async({data:message})=>{
  const {id,type}=message||{};
  if(busy){self.postMessage({id,type:'error',message:'The previous frame is still being read.'});return;}
  busy=true;
  try{
    if(type==='init'){await initialize();self.postMessage({id,type:'ready'});return;}
    if(type!=='decode')throw new Error('Unknown lab request.');
    const engine=message.engine??'both';if(!['custom','zxing','both'].includes(engine))throw new Error('Unknown engine.');
    const {width,height,data}=message.image||{};
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>4_000_000||!(data instanceof ArrayBuffer)||data.byteLength!==width*height*4)throw new Error('Invalid or oversized frame.');
    if(engine!=='custom')await initialize();
    const image=new ImageData(new Uint8ClampedArray(data),width,height),timings={};
    let customResults=[],baselineResults=[];
    const custom=()=>{const start=performance.now();customResults=Code128Engine.read(image);timings.customMs=performance.now()-start;};
    const zxing=async()=>{const start=performance.now();baselineResults=await baseline(image);timings.zxingMs=performance.now()-start;};
    // Alternate order to reduce a consistent warm-cache advantage in live comparisons.
    if(engine==='both'&&id%2===0){await zxing();custom();}
    else{if(engine!=='zxing')custom();if(engine!=='custom')await zxing();}
    self.postMessage({id,type:'result',customResults,baselineResults,timings,results:engine==='zxing'?baselineResults:customResults,diagnostics:engine==='zxing'?{}:Code128Engine.getDiagnostics()});
  }catch(error){self.postMessage({id,type:'error',message:error.message||'Could not read this frame.'});}
  finally{busy=false;}
};
