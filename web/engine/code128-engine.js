/* Own Code 128 prototype: locate oriented candidates, rectify, decode and validate. */
(function(root){
  'use strict';
  const decoder=typeof module!=='undefined'&&module.exports?require('./code128-decoder.js'):root.Code128Decoder;
  const detector=typeof module!=='undefined'&&module.exports?require('./code128-detector.js'):root.Code128Detector;
  let lastDiagnostics={};
  function grayscale(image){
    const {width,height}=image||{};
    const data=image?.data instanceof ArrayBuffer?new Uint8ClampedArray(image.data):image?.data;
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>4_000_000||
       !(data instanceof Uint8Array||data instanceof Uint8ClampedArray)||data.length!==width*height*4)throw new Error('Image must contain at most 4 million RGBA pixels.');
    const gray=new Uint8Array(width*height);let low=255,high=0;
    for(let i=0,p=0;i<gray.length;i++,p+=4){const alpha=data[p+3]/255;const value=Math.round((306*data[p]+601*data[p+1]+117*data[p+2])/1024*alpha+255*(1-alpha));gray[i]=value;low=Math.min(low,value);high=Math.max(high,value);}
    if(high-low>=8&&high-low<160)for(let i=0;i<gray.length;i++)gray[i]=Math.round((gray[i]-low)*255/(high-low));
    return gray;
  }
  function read(image){
    const started=performance.now(),gray=grayscale(image),{width,height}=image;
    const candidates=detector.detect(gray,width,height),results=[],seen=new Set();
    const add=(result,map)=>{
      if(!result)return false;
      // A warped search region may extend beyond the image. Its white fill must
      // never manufacture the required blank border of a clipped label.
      if(map){
        const p=result.position;
        const border=[{x:p.topLeft.x-(result.quietLeft||0),y:p.topLeft.y},{x:p.topRight.x+(result.quietRight||0),y:p.topRight.y},
          {x:p.bottomLeft.x-(result.quietLeft||0),y:p.bottomLeft.y},{x:p.bottomRight.x+(result.quietRight||0),y:p.bottomRight.y}].map(map);
        if(border.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<-.75||p.y<-.75||p.x>width+.75||p.y>height+.75))return false;
      }
      const key=JSON.stringify([result.bytes,result.gs1]);if(seen.has(key))return true;seen.add(key);
      const position=Object.fromEntries(Object.entries(result.position).map(([key,p])=>{const point=map?map(p):p;return[key,{x:Math.max(0,Math.min(width,point.x)),y:Math.max(0,Math.min(height,point.y))}];}));
      results.push({...result,position,engine:'custom-code128-v1'});
      return true;
    };
    let attempted=0,sourceRowRetries=0,horizontalRetries=0;
    for(const candidate of candidates){
      if(performance.now()-started>1200)break;
      const crop=detector.rectify(gray,width,height,candidate.corners);
      let accepted=add(decoder.decodeRows(crop.gray,crop.width,crop.height),crop.map);attempted++;
      if(!accepted&&Math.abs(candidate.angle)<0.05&&performance.now()-started<1200){
        // Avoid resampling thin, nearly horizontal bars. Sample distinct original
        // rows across the locator's vertical extent; retain the full real border.
        const top=Math.max(0,Math.floor(Math.min(...candidate.corners.map(p=>p.y))));
        const bottom=Math.min(height,Math.ceil(Math.max(...candidate.corners.map(p=>p.y))));
        if(bottom-top>=2){
          accepted=add(decoder.decodeRows(gray.subarray(top*width,bottom*width),width,bottom-top),p=>({x:p.x,y:p.y+top}));
          sourceRowRetries++;
        }
      }
      if(!accepted&&attempted<=3&&crop.width<600&&crop.height<=512&&performance.now()-started<1200){
        const fine=detector.rectify(gray,width,height,candidate.corners,500_000,2);
        add(decoder.decodeRows(fine.gray,fine.width,fine.height),fine.map);horizontalRetries++;
      }
      if(results.length>=8)break;
    }
    // Fallback preserves straightforward reads if the heuristic locator has no proposal.
    if(!results.length&&performance.now()-started<1200)add(decoder.decodeRows(gray,width,height));
    lastDiagnostics={version:'custom-code128-v1',candidates:candidates.length,attempted,sourceRowRetries,horizontalRetries,elapsedMs:performance.now()-started};
    return results;
  }
  const api={read,grayscale,getDiagnostics:()=>({...lastDiagnostics})};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Code128Engine=api;
})(typeof globalThis!=='undefined'?globalThis:this);
