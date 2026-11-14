/* Source-signal recovery for EAN13 and supported Code128 symbols.
 * Project code. It models a bounded uniform exposure blur, then checks the
 * entire decoded template against ORIGINAL grayscale samples. Native decoding
 * of a derived candidate supplies canonical bytes/text, not additional votes.
 * A second path combines aligned source rows with independently located flat
 * defects; every reconstructed column still needs three original observations.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./engine/code128-decoder.js') : null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LinearSignal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCode128) {
  'use strict';
  const { abs, ceil, floor, max, min, round, sqrt } = Math;
  const now = () => performance.now();
  const LEFT = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const ODD = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const RIGHT = LEFT.map(bits => [...bits].map(bit => bit === '0' ? '1' : '0').join(''));
  const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
  const sinc=x=>abs(x)<1e-9?1:Math.sin(Math.PI*x)/(Math.PI*x);
  const samplingIntegral=new Float64Array(385);
  for(let i=1;i<samplingIntegral.length;i++){const x=(i-.5)/64-3;samplingIntegral[i]=samplingIntegral[i-1]+sinc(x)*sinc(x/3)/64;}
  const samplingMass=samplingIntegral.at(-1);
  for(let i=0;i<samplingIntegral.length;i++)samplingIntegral[i]/=samplingMass;
  function samplingCDF(x){const index=(x+3)*64;if(index<=0)return 0;if(index>=384)return 1;const k=floor(index);return samplingIntegral[k]+(index-k)*(samplingIntegral[k+1]-samplingIntegral[k]);}

  function pixels(image) {
    const data = image?.data instanceof ArrayBuffer ? new Uint8ClampedArray(image.data) : image?.data;
    if (!Number.isInteger(image?.width) || !Number.isInteger(image?.height) || image.width < 1 || image.height < 1 ||
        image.width > 8192 || image.width * image.height > 4_000_000 ||
        !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== image.width * image.height * 4) throw new Error('Invalid linear signal image.');
    return data;
  }
  function sourceRow(data, width, y) {
    const row = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4, a = data[p + 3] / 255;
      row[x] = ((306 * data[p] + 601 * data[p + 1] + 117 * data[p + 2]) / 1024) * a + 255 * (1 - a);
    }
    return row;
  }
  function inverse(row, length) {
    const output = new Float64Array(row.length).fill(255), half = floor(length / 2);
    let previous = 255;
    for (let x = 0; x < row.length; x++) {
      const target = x + half;
      if (target < row.length) output[target] = max(0,min(255,(target >= length ? output[target - length] : 255) + length * (row[x] - previous)));
      previous = row[x];
    }
    return Uint8Array.from(output, value => value < 128 ? 0 : 255);
  }
  function eanBits(text) {
    const first = Number(text[0]);
    return '101' + [...text.slice(1,7)].map((digit,i) => (PARITY[first][i] === 'L' ? LEFT : ODD)[Number(digit)]).join('') +
      '01010' + [...text.slice(7)].map(digit => RIGHT[Number(digit)]).join('') + '101';
  }
  function checksum(text) { return /^\d{13}$/.test(text) && [...text].reduce((sum,digit,i)=>sum+Number(digit)*(i%2?3:1),0)%10===0; }
  function eanLine(row) {
    let left = 0, right = row.length;
    while (left < right && row[left] > 128) left++;
    while (right > left && row[right-1] > 128) right--;
    const unit = (right-left)/95;
    if (unit < 0.7 || unit > 24 || left < 11*unit || row.length-right < 7*unit) return null;
    const bits = Array.from({length:95},(_,i)=>row[min(row.length-1,floor(left+(i+.5)*unit))]<128?'1':'0').join('');
    if (!bits.startsWith('101') || bits.slice(45,50)!=='01010' || !bits.endsWith('101')) return null;
    let parity = '', text = '';
    for (let i=0;i<6;i++) {
      const symbol=bits.slice(3+i*7,10+i*7), odd=LEFT.indexOf(symbol), even=ODD.indexOf(symbol);
      if (odd<0 && even<0) return null;
      parity+=odd>=0?'L':'G';text+=String(odd>=0?odd:even);
    }
    const first=PARITY.indexOf(parity); if(first<0) return null;
    text=String(first)+text;
    for(let i=0;i<6;i++){const digit=RIGHT.indexOf(bits.slice(50+i*7,57+i*7));if(digit<0)return null;text+=digit;}
    if (!checksum(text) || text[0]==='0') return null; // UPC/EAN alias needs native physical-format evidence elsewhere.
    return { format:'EAN13',text,bytes:Array.from(text,c=>c.charCodeAt(0)),left,right,unit,bits,
      quietLeft:11*unit,quietRight:7*unit };
  }
  function signalEan(row) {
    let low=255,high=0;for(const value of row){low=min(low,value);high=max(high,value);}if(high-low<70)return [];
    const threshold=(low+high)/2;let first=0,last=row.length;
    while(first<last&&row[first]>threshold)first++;while(last>first&&row[last-1]>threshold)last--;
    const scale=(last-first)/95;if(scale<.72||scale>2.2)return [];
    const output=new Map();
    function digitCost(bits,origin,unit){
      const previous=bits[0]==='0'?'1':'0',next=bits[0];
      bits=previous+bits+next;
      let error=0,count=0;
      for(let x=floor(origin);x<ceil(origin+7*unit);x++){
        let darkness=0;
        for(let k=0;k<9;k++)if(bits[k]==='1')darkness+=max(0,min(x+1,origin+k*unit)-max(x,origin+(k-1)*unit));
        const delta=(row[x]-low)/(high-low)-(1-darkness);error+=delta*delta;count++;
      }
      return count>=3?error/count:Infinity;
    }
    for(const phase of [-.75,-.5,-.25,0,.25,.5,.75])for(const spread of [-1,-.5,0,.5,1]){
      const left=first+phase,unit=(last-first+spread)/95;
      if(left<11*unit||row.length-left-95*unit<7*unit)continue;
      const leftFits=Array.from({length:6},(_,i)=>[LEFT,ODD].map(table=>table.map((bits,digit)=>({digit,error:digitCost(bits,left+(3+7*i)*unit,unit)})).sort((a,b)=>a.error-b.error)));
      const rightFits=Array.from({length:6},(_,i)=>RIGHT.map((bits,digit)=>({digit,error:digitCost(bits,left+(50+7*i)*unit,unit)})).sort((a,b)=>a.error-b.error));
      const hypotheses=[];
      for(let leading=1;leading<=9;leading++){
        const fits=[...leftFits.map((fits,i)=>fits[PARITY[leading][i]==='L'?0:1]),...rightFits];
        const text=String(leading)+fits.map(fit=>fit[0].digit).join('');
        hypotheses.push({text,error:fits.reduce((s,fit)=>s+fit[0].error,0)/12,margin:min(...fits.map(fit=>fit[1].error-fit[0].error))});
      }
      hypotheses.sort((a,b)=>a.error-b.error);const best=hypotheses[0];
      // The best unconstrained sequence must already have a valid checksum.
      // Never substitute a second-best digit merely to satisfy it.
      if(!checksum(best.text)||best.margin<.012||hypotheses[1].error-best.error<.004)continue;
      const bits=eanBits(best.text);
      const candidate={format:'EAN13',text:best.text,bytes:Array.from(best.text,c=>c.charCodeAt(0)),left,right:left+95*unit,unit,bits,quietLeft:11*unit,quietRight:7*unit};
      const proof=bestFit(row,candidate,1);if(!proof)continue;
      const previous=output.get(best.text);if(!previous||proof.rmse<previous.proof.rmse)output.set(best.text,{candidate,proof});
    }
    return [...output.values()];
  }
  function activeRows(data,width,height) {
    const step=max(1,floor(height/128)),bands=[];let current=null;
    for(let y=0;y<height;y+=step){
      const row=sourceRow(data,width,y);let low=255,high=0,edges=0;
      for(let x=1;x<width;x++){low=min(low,row[x]);high=max(high,row[x]);if(abs(row[x]-row[x-1])>5)edges++;}
      if(high-low>=45&&edges>=12){if(current&&y-current.bottom<=step*2)current.bottom=y;else{current={top:y,bottom:y};bands.push(current);}}
    }
    if(bands.length>4)return {rows:[],complete:false};
    const rows=[];
    for(let band=0;band<bands.length;band++){
      const {top,bottom}=bands[band];
      for(const y of new Set(Array.from({length:9},(_,i)=>round(top+(bottom-top)*i/8))))rows.push({y,band});
    }
    return {rows,complete:true};
  }
  function signalCode128(row,decoder) {
    if(!decoder)return [];
    let low=255,high=0;for(const value of row){low=min(low,value);high=max(high,value);}if(high-low<70)return [];
    let first=0,last=row.length;const threshold=(low+high)/2;
    while(first<last&&row[first]>threshold)first++;while(last>first&&row[last-1]>threshold)last--;
    const span=last-first;if(span<50||span>600)return [];
    function cost(bits,origin,unit){
      const body=bits.length;bits='0'+bits+(bits.endsWith('1')?'0':'1');let error=0,count=0;
      for(let x=floor(origin);x<ceil(origin+body*unit);x++){
        let dark=0;const a=max(0,floor((x-origin)/unit)+1),b=min(bits.length-1,floor((x+1-origin)/unit)+1);
        for(let k=a;k<=b;k++)if(bits[k]==='1')dark+=max(0,min(x+1,origin+k*unit)-max(x,origin+(k-1)*unit));
        const delta=(row[x]-low)/(high-low)-(1-dark);error+=delta*delta;count++;
      }
      return error/count;
    }
    const guards=[];
    for(let count=3;count<=min(70,floor(span/(.72*11)));count++)for(const phase of [-.75,-.5,-.25,0,.25,.5,.75])for(const spread of [-1,-.5,0,.5,1]){
      const left=first+phase,unit=(span+spread)/(count*11+13);
      if(unit<.72||unit>1.8||left<10*unit||row.length-left-(count*11+13)*unit<10*unit)continue;
      for(let start=103;start<=105;start++){
        const startError=cost(CODEBITS[start],left,unit),stopError=cost(CODEBITS[106],left+count*11*unit,unit);
        if(max(startError,stopError)<.035)guards.push({left,unit,count,start,error:(startError+stopError)/2});
      }
    }
    guards.sort((a,b)=>a.error-b.error);
    const output=new Map();
    for(const guard of guards.slice(0,12)){
      const words=[guard.start];let margin=Infinity,complete=true;
      for(let i=1;i<guard.count;i++){
        const fits=CODEBITS.slice(0,103).map((bits,word)=>({word,error:cost(bits,guard.left+i*11*guard.unit,guard.unit)})).sort((a,b)=>a.error-b.error);
        if(fits[0].error>.035||fits[1].error-fits[0].error<.008){complete=false;break;}
        margin=min(margin,fits[1].error-fits[0].error);words.push(fits[0].word);
      }
      if(!complete||words.slice(0,-1).reduce((sum,word,i)=>sum+word*(i||1),0)%103!==words.at(-1))continue;
      const bits=words.map(word=>CODEBITS[word]).join('')+CODEBITS[106];
      const rendered=Uint8Array.from(idealRow(bits,(bits.length+24)*3,36,3),value=>round(value*255));
      const decoded=decoder.decodeScanline(rendered,{tryInvert:false,tryLocalThreshold:false});if(!decoded)continue;
      const candidate={...decoded,left:guard.left,right:guard.left+bits.length*guard.unit,unit:guard.unit,bits,quietLeft:10*guard.unit,quietRight:10*guard.unit};
      const proof=bestFit(row,candidate,1);if(!proof)continue;
      const key=JSON.stringify(candidate.bytes),previous=output.get(key);
      if(!previous||proof.rmse<previous.proof.rmse)output.set(key,{candidate,proof});
    }
    return [...output.values()];
  }
  function idealRow(bits, width, left, unit, aperture=1) {
    const output = new Float64Array(width).fill(1);
    if(aperture===0){
      // A bounded windowed-sinc sampling model covers resized camera/import
      // pixels. It predicts from the whole symbol; it does not sharpen input.
      for(let x=max(0,floor(left-3));x<min(width,ceil(left+bits.length*unit+3));x++){
        const center=x+.5;let dark=0;
        const a=max(0,floor((center-3-left)/unit)),b=min(bits.length-1,floor((center+3-left)/unit));
        for(let module=a;module<=b;module++)if(bits[module]==='1')dark+=samplingCDF(left+(module+1)*unit-center)-samplingCDF(left+module*unit-center);
        output[x]=max(0,min(1,1-dark));
      }
      return output;
    }
    // Pixel-area sampling retains subpixel module boundaries.
    for(let x=max(0,floor(left-aperture));x<min(width,ceil(left+bits.length*unit+aperture));x++){
      let dark=0;
      const pixelLeft=x+.5-aperture/2,pixelRight=x+.5+aperture/2;
      const a=max(0,floor((pixelLeft-left)/unit)),b=min(bits.length-1,floor((pixelRight-left)/unit));
      for(let module=a;module<=b;module++)if(bits[module]==='1')dark+=max(0,min(pixelRight,left+(module+1)*unit)-max(pixelLeft,left+module*unit));
      output[x]=1-dark/aperture;
    }
    return output;
  }
  function fit(row,bits,left,unit,length,quietLeft,quietRight,aperture=1) {
    const from=floor(left-quietLeft),to=ceil(left+bits.length*unit+quietRight),half=floor(length/2);
    if(from-half<0||to+half>row.length)return null;
    const ideal=idealRow(bits,row.length,left,unit,aperture),prediction=new Float64Array(row.length);
    let sx=0,sy=0,sxx=0,sxy=0;
    for(let x=from;x<to;x++){
      let value=0;for(let k=-half;k<=half;k++)value+=ideal[x+k];value/=length;
      prediction[x]=value;sx+=value;sy+=row[x];sxx+=value*value;sxy+=value*row[x];
    }
    const n=to-from,variance=sxx-sx*sx/n;if(variance<1)return null;
    const contrast=(sxy-sx*sy/n)/variance,black=(sy-contrast*sx)/n;
    if(contrast<55||contrast>320||black< -60||black>120||black+contrast<150||black+contrast>310)return null;
    let error=0,maxBlock=0;
    for(let start=from;start<to;start+=max(1,round(7*unit))){
      const end=min(to,start+max(1,round(7*unit)));let block=0;
      for(let x=start;x<end;x++){const residual=(row[x]-black-contrast*prediction[x])/contrast;block+=residual*residual;}
      error+=block;maxBlock=max(maxBlock,sqrt(block/(end-start)));
    }
    const rmse=sqrt(error/n);
    return {rmse,maxBlock,contrast,black};
  }
  function bestFit(row, result, length) {
    let best=null;
    for(const aperture of length===1?[.7,.85,1,1.15,1.3,0]:[1]){
      let local=null;
      for(const shift of [-.5,0,.5])for(const stretch of [-.5,0,.5]){
        const left=result.left+shift,unit=(result.right-result.left+stretch)/result.bits.length;
        const proof=fit(row,result.bits,left,unit,length,result.quietLeft,result.quietRight,aperture);
        if(proof&&(!local||proof.rmse<local.rmse))local={...proof,left,unit,aperture};
      }
      if(local&&length===1)for(const step of [.2,.08,.032,.0128]){
        const center=local;
        for(const shift of [-step,0,step])for(const stretch of [-step,0,step]){
          const left=center.left+shift,unit=center.unit+stretch/result.bits.length;
          const proof=fit(row,result.bits,left,unit,length,result.quietLeft,result.quietRight,aperture);
          if(proof&&proof.rmse<local.rmse)local={...proof,left,unit,aperture};
        }
      }
      if(local&&(!best||local.rmse<best.rmse))best=local;
    }
    return best&&best.rmse<=.045&&best.maxBlock<=.095?best:null;
  }
  function templateImage(result) {
    const width=(result.bits.length+24)*3,height=12,data=new Uint8ClampedArray(width*height*4).fill(255);
    for(let y=0;y<height;y++)for(let i=0;i<result.bits.length;i++)if(result.bits[i]==='1')for(let k=0;k<3;k++){
      const p=(y*width+(i+12)*3+k)*4;data[p]=data[p+1]=data[p+2]=0;
    }
    return {width,height,data};
  }
  function compositeProof(rows, candidate, proof) {
    const unit=proof.unit,left=proof.left,right=left+candidate.bits.length*unit;
    if(unit<1.4||unit>16||right-left>1800||rows.length<5)return null;
    const from=floor(left-candidate.quietLeft),to=ceil(right+candidate.quietRight);
    if(from<0||to>rows[0].values.length)return null;
    const ideal=idealRow(candidate.bits,rows[0].values.length,left,unit,proof.aperture);
    const guards=candidate.format==='EAN13'?idealRow('101'+'0'.repeat(42)+'01010'+'0'.repeat(42)+'101',rows[0].values.length,left,unit,proof.aperture):null;
    const support=new Uint8Array(to-from),sourceRows=[];let squared=0,count=0,damage=0,outerInk=false;
    for(const {y,values:row} of rows){
      let low=255,high=0;for(let x=from;x<to;x++){low=min(low,row[x]);high=max(high,row[x]);}
      if(high-low<100)return null;
      for(let x=0;x<row.length;x++)if((x<from||x>=to)&&row[x]<high-12)outerInk=true;
      // EAN guard bars may extend below the data bars. Such rows contain no
      // data evidence and are excluded only when the whole guard-only image
      // agrees with measured source geometry; arbitrary short rows are not.
      if(guards&&row.subarray(from,to).every((value,i)=>abs((value-low)/(high-low)-guards[from+i])<=.16))continue;
      sourceRows.push(y);
      const threshold=(low+high)/2,mask=new Uint8Array(to-from);let masked=0,regions=0;
      // Only a flat run longer than any valid EAN/Code128 element can be
      // treated as a local defect. Different valid bar patterns stay visible.
      for(let x=max(from,ceil(left));x<min(to,floor(right));){
        const start=x,dark=row[x]<threshold;
        while(x<min(to,floor(right))&&(row[x]<threshold)===dark)x++;
        if(x-start<4.75*unit)continue;
        if(start<left+7*unit||x>right-7*unit||x-start>(right-left)*.25)return null;
        const a=max(from,start-1),b=min(to,x+1);regions++;
        for(let k=a;k<b;k++)if(!mask[k-from]){mask[k-from]=1;masked++;}
      }
      if(regions>4||masked>(right-left)*.35)return null;
      let rowSquared=0,rowCount=0;
      for(let x=from;x<to;x++){
        const error=(row[x]-low)/(high-low)-ideal[x];
        if(mask[x-from]){if(abs(error)>.3)damage++;continue;}
        if(abs(error)>.16)return null;
        support[x-from]++;rowSquared+=error*error;rowCount++;
      }
      if(!rowCount||sqrt(rowSquared/rowCount)>.055)return null;
      squared+=rowSquared;count+=rowCount;
    }
    // A full-height missing stripe has no original-pixel support and cannot
    // be filled even if a rendered hypothesis happens to have a checksum.
    if(!damage||sourceRows.length<5||support.some(value=>value<3))return null;
    return {...proof,rmse:sqrt(squared/count),sourceRows,outerInk,strategy:'cross-row-source'};
  }
  function compositeCandidates(data,width,sampled,allowed,decoder,expired) {
    if(sampled.length<5||width>2048)return {candidates:[],complete:true};
    const rows=sampled.map(({y})=>({y,values:sourceRow(data,width,y)})),output=new Map();
    if(rows.at(-1).y-rows[0].y<4)return {candidates:[],complete:true};
    for(const quantile of [.5,.15,.85]){
      if(expired())return {candidates:[...output.values()],complete:false};
      const profile=new Float64Array(width);
      for(let x=0;x<width;x++){
        const values=rows.map(row=>row.values[x]).sort((a,b)=>a-b);
        profile[x]=values[floor((values.length-1)*quantile)];
      }
      let low=255,high=0;for(const value of profile){low=min(low,value);high=max(high,value);}
      if(high-low<100)continue;
      const binary=Uint8Array.from(profile,value=>value<(low+high)/2?0:255),candidates=[];
      if(allowed.has('EAN13')){const candidate=eanLine(binary);if(candidate)candidates.push(candidate);}
      if(allowed.has('Code128')&&decoder){
        const decoded=decoder.decodeScanline(binary,{tryInvert:false,tryLocalThreshold:false});
        if(decoded&&!decoded.reversed&&!decoded.inverted&&Array.isArray(decoded.codewords)){
          const bits=decoded.codewords.map(word=>CODEBITS[word]).join('');
          candidates.push({...decoded,bits,unit:(decoded.right-decoded.left)/bits.length});
        }
      }
      for(const candidate of candidates){
        const exact=fit(profile,candidate.bits,candidate.left,candidate.unit,1,candidate.quietLeft,candidate.quietRight);
        const fitted=exact&&exact.rmse<=.045&&exact.maxBlock<=.095?{...exact,left:candidate.left,unit:candidate.unit,aperture:1}:bestFit(profile,candidate,1);
        if(!fitted)continue;
        const proof=compositeProof(rows,candidate,fitted);if(!proof)continue;
        const key=JSON.stringify([candidate.format,candidate.bytes,candidate.left,candidate.right]);
        const previous=output.get(key);if(!previous||proof.rmse<previous.proof.rmse)output.set(key,{candidate,proof});
        if(output.size>8)return {candidates:[...output.values()].slice(0,8),complete:false};
      }
    }
    return {candidates:[...output.values()],complete:!expired()&&![...output.values()].some(entry=>entry.proof.outerInk)};
  }
  async function recover(image,{formats=['EAN13','Code128'],timeBudgetMs=250,readNative}={}) {
    const data=pixels(image);
    if(!Array.isArray(formats)||formats.some(format=>typeof format!=='string')||!Number.isFinite(timeBudgetMs)||timeBudgetMs<0||timeBudgetMs>1200||typeof readNative!=='function')throw new Error('Invalid linear signal options.');
    const started=now(),allowed=new Set(formats),groups=new Map();let passes=0,complete=true;
    if(!timeBudgetMs||(!allowed.has('EAN13')&&!allowed.has('Code128')))return {results:[],complete:timeBudgetMs>0,passes,elapsedMs:now()-started};
    const decoder=nodeCode128||(typeof globalThis==='object'?globalThis.Code128Decoder:null);
    const sampling=activeRows(data,image.width,image.height),rows=sampling.rows;
    if(!sampling.complete)return {results:[],complete:false,passes,elapsedMs:now()-started};
    function collect(candidate,proof,y,length,band){
      const identity=JSON.stringify([candidate.format,candidate.bytes]);
      const old=[...groups.values()].find(group=>group.identity===identity&&group.band===band&&
        abs(group.candidate.left-candidate.left)<max(2,(candidate.right-candidate.left)*.08)&&
        abs(group.candidate.right-candidate.right)<max(2,(candidate.right-candidate.left)*.08));
      if(!old)groups.set(groups.size,{identity,band,candidate,rows:new Set([y]),top:y,bottom:y,proof,models:new Set([length])});
      else {old.rows.add(y);old.top=min(old.top,y);old.bottom=max(old.bottom,y);old.models.add(length);if(proof.rmse<old.proof.rmse){old.proof=proof;old.candidate=candidate;}}
    }
    for(const {y,band} of rows){
      if(now()-started>=timeBudgetMs){complete=false;break;}
      const row=sourceRow(data,image.width,y);
      let low=255,high=0;for(const value of row){low=min(low,value);high=max(high,value);}if(high-low<45)continue;
      if(allowed.has('EAN13'))for(const {candidate,proof} of signalEan(row))collect(candidate,proof,y,1,band);
      if(allowed.has('Code128'))for(const {candidate,proof} of signalCode128(row,decoder))collect(candidate,proof,y,1,band);
      for(const length of [3,5,7,9,11,13,15]){
        if(now()-started>=timeBudgetMs){complete=false;break;}
        const recovered=inverse(row,length),candidates=[];
        if(allowed.has('EAN13')){const ean=eanLine(recovered);if(ean)candidates.push(ean);}
        if(allowed.has('Code128')&&decoder){
          const code=decoder.decodeScanline(recovered,{tryInvert:false,tryLocalThreshold:false});
          if(code&&!code.reversed&&!code.inverted&&Array.isArray(code.codewords)){
            // The pattern sequence comes from the source-derived candidate,
            // including its original checksum. No checksum digit is repaired.
            let bits='';for(const word of code.codewords){let dark=true;for(const run of CODE128[word]){bits+=(dark?'1':'0').repeat(run);dark=!dark;}}
            candidates.push({...code,bits,unit:(code.right-code.left)/bits.length});
          }
        }
        for(const candidate of candidates){
          const proof=bestFit(row,candidate,length);if(!proof)continue;
          collect(candidate,proof,y,length,band);
          if(groups.size>8){complete=false;break;}
        }
        if(!complete)break;
      }
      if(!complete)break;
    }
    if(complete)for(const band of new Set(rows.map(row=>row.band))){
      // Existing complete source evidence stays on its fast path. Do not merge
      // separate activity bands or replace a short/competing observed symbol.
      if([...groups.values()].some(group=>group.band===band))continue;
      const reconstructed=compositeCandidates(data,image.width,rows.filter(row=>row.band===band),allowed,decoder,()=>now()-started>=timeBudgetMs);
      for(const {candidate,proof} of reconstructed.candidates)for(const y of proof.sourceRows)collect(candidate,proof,y,1,band);
      if(!reconstructed.complete||groups.size>8){complete=false;break;}
    }
    const results=[];
    if(complete)for(const group of groups.values()){
      if(group.rows.size<3||group.bottom-group.top<2){complete=false;continue;}
      if(now()-started>=timeBudgetMs){complete=false;break;}
      const candidate=group.candidate,native=await readNative(templateImage(candidate));passes++;
      let matched=false;
      for(const code of native||[]){
        if(code.isValid===false||code.error||code.format!==candidate.format||!Array.isArray(code.bytes)&&!ArrayBuffer.isView(code.bytes)||
           code.bytes.length!==candidate.bytes.length||!Array.from(code.bytes).every((value,i)=>value===candidate.bytes[i]))continue;
        matched=true;
        const left=group.proof.left,right=left+group.proof.unit*candidate.bits.length;
        results.push({...code,position:{topLeft:{x:left,y:group.top},topRight:{x:right,y:group.top},bottomRight:{x:right,y:group.bottom},bottomLeft:{x:left,y:group.bottom}},
          signalProof:{strategy:group.proof.strategy||'grayscale-template',rows:group.rows.size,rmse:group.proof.rmse,blurLengths:[...group.models]}});
      }
      if(!matched)complete=false;
    }
    if(now()-started>=timeBudgetMs)complete=false;
    const identities=new Set(results.map(result=>JSON.stringify([result.format,Array.from(result.bytes)])));
    return {results:complete||identities.size>1?results:[],complete,incompleteEvidence:!complete&&groups.size>0,passes,elapsedMs:now()-started};
  }
  // Code128 widths are standard pattern data already vendored by this project:
  // Apache-2.0, ZXing-C++ ODCode128Patterns.h (Nu-book 2016 / ZXing authors 2016).
  const CODE128 = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112',
  ].map(pattern => Array.from(pattern, Number));
  const CODEBITS=CODE128.map(pattern=>{let dark=true,bits='';for(const run of pattern){bits+=(dark?'1':'0').repeat(run);dark=!dark;}return bits;});
  return {recover,version:'grayscale-signal-v2'};
});
