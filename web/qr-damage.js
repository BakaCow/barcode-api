/* QR erasure reconstruction from observed module uncertainty; never payload guesses.
 * QR version/ECC/alignment constants adapted from jsQR 1.4.0 by Cosmo Wolfe
 * and contributors, Apache-2.0, https://github.com/cozmo/jsQR.
 * Constants are reduced to versions 1â€“10 and reformatted. See
 * vendor/THIRD-PARTY.txt and vendor/ZXING-CPP-LICENSE.txt (Apache-2.0).
 * GF equations, uncertainty checks, matrix traversal and repair are project code.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./qr-geometry.js') : root.QRGeometry);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QRDamage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (geometry) {
  'use strict';
  const layouts = [
    [null,[],[[7,1,19],[10,1,16],[13,1,13],[17,1,9]]],
    [null,[6,18],[[10,1,34],[16,1,28],[22,1,22],[28,1,16]]],
    [null,[6,22],[[15,1,55],[26,1,44],[18,2,17],[22,2,13]]],
    [null,[6,26],[[20,1,80],[18,2,32],[26,2,24],[16,4,9]]],
    [null,[6,30],[[26,1,108],[24,2,43],[18,2,15,2,16],[22,2,11,2,12]]],
    [null,[6,34],[[18,2,68],[16,4,27],[24,4,19],[28,4,15]]],
    [31892,[6,22,38],[[20,2,78],[18,4,31],[18,2,14,4,15],[26,4,13,1,14]]],
    [34236,[6,24,42],[[24,2,97],[22,2,38,2,39],[22,4,18,2,19],[26,4,14,2,15]]],
    [39577,[6,26,46],[[30,2,116],[22,3,36,2,37],[20,4,16,4,17],[24,4,12,4,13]]],
    [42195,[6,28,50],[[18,2,68,2,69],[26,4,43,1,44],[24,6,19,2,20],[28,6,15,2,16]]],
  ];
  const exp = new Uint8Array(510), log = new Uint8Array(256);
  for (let x = 1, i = 0; i < 255; i++) {
    exp[i] = x; log[x] = i; x <<= 1; if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 510; i++) exp[i] = exp[i - 255];
  const mul = (a, b) => a && b ? exp[log[a] + log[b]] : 0;
  const power = exponent => exp[((exponent % 255) + 255) % 255];
  const clock = () => typeof performance === 'object' ? performance.now() : Date.now();
  function distance(a, b) { let n = a ^ b, count = 0; while (n) { n &= n - 1; count++; } return count; }
  function formatWord(data) {
    let value = data << 10;
    for (let bit = 14; bit >= 10; bit--) if (value & (1 << bit)) value ^= 0x537 << (bit - 10);
    return ((data << 10) | value) ^ 0x5412;
  }
  function metadata(modules, dimension, uncertainty) {
    const version = (dimension - 17) / 4, layout = layouts[version - 1];
    if (!Number.isInteger(version) || !layout) return null;
    const at = (x, y) => modules[y * dimension + x];
    let first = 0, second = 0, firstUnknown = 0, secondUnknown = 0;
    const unknown=(x,y)=>uncertainty?.[y*dimension+x]||0;
    for (let x = 0; x <= 8; x++) if (x !== 6) { first = (first << 1) | at(x, 8); firstUnknown=(firstUnknown<<1)|unknown(x,8); }
    for (let y = 7; y >= 0; y--) if (y !== 6) { first = (first << 1) | at(8, y); firstUnknown=(firstUnknown<<1)|unknown(8,y); }
    for (let y = dimension - 1; y >= dimension - 7; y--) { second = (second << 1) | at(8, y); secondUnknown=(secondUnknown<<1)|unknown(8,y); }
    for (let x = dimension - 8; x < dimension; x++) { second = (second << 1) | at(x, 8); secondUnknown=(secondUnknown<<1)|unknown(x,8); }
    // At least one sampled format word must be within two BCH bits of the
    // candidate; every confident bit in both copies from this exposure agrees.
    const matches = [];
    for (let data = 0; data < 32; data++) {
      const word = formatWord(data);
      if (Math.min(distance(word,first),distance(word,second))<=2 &&
          !((word^first)&(32767^firstUnknown))&&!((word^second)&(32767^secondUnknown))) matches.push(data);
    }
    if (matches.length !== 1) return null;
    if (version > 6) {
      let a = 0, b = 0;
      for (let y = 5; y >= 0; y--) for (let x = dimension - 9; x >= dimension - 11; x--) a = (a << 1) | at(x, y);
      for (let x = 5; x >= 0; x--) for (let y = dimension - 9; y >= dimension - 11; y--) b = (b << 1) | at(x, y);
      if (distance(a, layout[0]) > 2 || distance(b, layout[0]) > 2) return null;
    }
    const data = matches[0], level = [1, 0, 3, 2][data >> 3];
    return { version, layout, level, mask: data & 7 };
  }
  function dataCoordinates(dimension, meta) {
    const reserved = new Uint8Array(dimension * dimension);
    const mark = (x, y, w, h) => {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) reserved[yy * dimension + xx] = 1;
    };
    mark(0, 0, 9, 9); mark(dimension - 8, 0, 8, 9); mark(0, dimension - 8, 9, 8);
    for (const x of meta.layout[1]) for (const y of meta.layout[1]) {
      if ((x === 6 && (y === 6 || y === dimension - 7)) || (y === 6 && x === dimension - 7)) continue;
      mark(x - 2, y - 2, 5, 5);
    }
    mark(6, 9, 1, dimension - 17); mark(9, 6, dimension - 17, 1);
    if (meta.version > 6) { mark(dimension - 11, 0, 3, 6); mark(0, dimension - 11, 6, 3); }
    const result = []; let up = true;
    for (let right = dimension - 1; right > 0; right -= 2) {
      if (right === 6) right--;
      for (let offset = 0; offset < dimension; offset++) {
        const y = up ? dimension - 1 - offset : offset;
        for (const x of [right, right - 1]) if (!reserved[y * dimension + x]) result.push(y * dimension + x);
      }
      up = !up;
    }
    return result;
  }
  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      default: return false;
    }
  }
  function syndrome(values, count) {
    const output = new Uint8Array(count);
    for (let s = 0; s < count; s++) {
      let value = 0;
      for (const byte of values) value = mul(value, power(s)) ^ byte;
      output[s] = value;
    }
    return output;
  }
  function reconstructBlock(values, uncertain, ec, expired) {
    const checks = syndrome(values, ec);
    if (!checks.some(Boolean)) return { values, repaired: 0, erased: 0 };
    const erased = Array.from(uncertain, (bits, index) => bits ? index : -1).filter(index => index >= 0);
    // Leave independent parity equations unused during solving, then require
    // all of them to hold. Filling the whole parity budget could turn arbitrary
    // measured data into a syntactically valid QR code.
    const reserved = Math.max(4, Math.ceil(ec / 4));
    if (!erased.length || expired()) return null;
    if (erased.length > ec - reserved) return reconstructBits(values, uncertain, ec, expired);
    const n = erased.length;
    const rows = Array.from({ length: n }, (_, s) => Uint8Array.from([
      ...erased.map(index => power(s * (values.length - 1 - index))), checks[s],
    ]));
    for (let col = 0; col < n; col++) {
      if (expired()) return null;
      let pivot = col; while (pivot < n && !rows[pivot][col]) pivot++;
      if (pivot === n) return null;
      [rows[pivot], rows[col]] = [rows[col], rows[pivot]];
      const inverse = power(255 - log[rows[col][col]]);
      for (let j = col; j <= n; j++) rows[col][j] = mul(rows[col][j], inverse);
      for (let row = 0; row < n; row++) if (row !== col && rows[row][col]) {
        const factor = rows[row][col];
        for (let j = col; j <= n; j++) rows[row][j] ^= mul(factor, rows[col][j]);
      }
    }
    const output = values.slice(); let repaired = 0;
    for (let col = 0; col < n; col++) {
      const index = erased[col], difference = rows[col][n];
      // Even inside an erased byte, source-observed confident bits may
      // not be changed. The caller must supply uncertainty from source pixels.
      if (difference & (255 ^ uncertain[index])) return reconstructBits(values, uncertain, ec, expired);
      output[index] ^= difference; if (difference) repaired++;
    }
    if (!repaired || syndrome(output, ec).some(Boolean) || expired()) return null;
    return { values: output, repaired, erased: n };
  }
  function reconstructBits(values, uncertain, ec, expired) {
    const variables=[];
    for(let i=0;i<uncertain.length;i++)for(let bit=0;bit<8;bit++)if(uncertain[i]&(1<<bit))variables.push([i,1<<bit]);
    const n=variables.length,m=ec*8;
    // Four full parity bytes remain as independent constraints after solving.
    if(!n||n>Math.min(192,m-32)||expired())return null;
    const checks=syndrome(values,ec),rows=[];
    for(let s=0;s<ec;s++) {
      const coefficients=variables.map(([index,bit])=>mul(bit,power(s*(values.length-1-index))));
      for(let bit=0;bit<8;bit++) {
        let row=BigInt((checks[s]>>bit)&1)<<BigInt(n);
        for(let col=0;col<n;col++)if((coefficients[col]>>bit)&1)row|=1n<<BigInt(col);
        rows.push(row);
      }
    }
    for(let col=0;col<n;col++) {
      if(expired())return null;
      const flag=1n<<BigInt(col);let pivot=col;
      while(pivot<m&&!(rows[pivot]&flag))pivot++;
      if(pivot===m)return null;
      [rows[pivot],rows[col]]=[rows[col],rows[pivot]];
      for(let row=0;row<m;row++)if(row!==col&&(rows[row]&flag))rows[row]^=rows[col];
    }
    if(rows.slice(n).some(Boolean))return null;
    const output=values.slice(),rhs=1n<<BigInt(n);let repaired=0;
    for(let col=0;col<n;col++)if(rows[col]&rhs){const [index,bit]=variables[col];output[index]^=bit;}
    for(let i=0;i<values.length;i++)if(values[i]!==output[i])repaired++;
    if(!repaired||syndrome(output,ec).some(Boolean)||expired())return null;
    return {values:output,repaired,erased:uncertain.filter(Boolean).length};
  }
  function repair({ dimension, modules, uncertainty }, { timeBudgetMs = 25 } = {}) {
    const started = clock();
    if (!Number.isInteger(dimension) || dimension < 21 || dimension > 57 || (dimension - 17) % 4 ||
      !(modules instanceof Uint8Array) || modules.length !== dimension * dimension ||
      !(uncertainty instanceof Uint8Array) || uncertainty.length !== modules.length ||
      modules.some(value => value > 1) || uncertainty.some(value => value > 1) ||
      !Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) return null;
    const expired = () => clock() - started > Math.min(60, timeBudgetMs);
    const meta = metadata(modules, dimension, uncertainty); if (!meta) return null;
    const coords = dataCoordinates(dimension, meta), spec = meta.layout[2][meta.level], ec = spec[0];
    const blocks = [];
    for (let i = 1; i < spec.length; i += 2) for (let j = 0; j < spec[i]; j++) {
      blocks.push({ data: spec[i + 1], values: new Uint8Array(spec[i + 1] + ec), uncertain: new Uint8Array(spec[i + 1] + ec), indices: [] });
    }
    const total = blocks.reduce((sum, block) => sum + block.values.length, 0);
    if (Math.floor(coords.length / 8) !== total || expired()) return null;
    const values = new Uint8Array(total), uncertain = new Uint8Array(total);
    for (let bit = 0; bit < total * 8; bit++) {
      const index = coords[bit], x = index % dimension, y = Math.floor(index / dimension), shift = 7 - bit % 8;
      values[Math.floor(bit / 8)] |= (modules[index] ^ Number(maskBit(meta.mask, x, y))) << shift;
      uncertain[Math.floor(bit / 8)] |= uncertainty[index] << shift;
    }
    let index = 0;
    const take = (block, offset) => { block.values[offset] = values[index]; block.uncertain[offset] = uncertain[index]; block.indices[offset] = index++; };
    for (let offset = 0; offset < Math.max(...blocks.map(block => block.data)); offset++) {
      for (const block of blocks) if (offset < block.data) take(block, offset);
    }
    for (let offset = 0; offset < ec; offset++) for (const block of blocks) take(block, block.data + offset);
    let repaired = 0, erased = 0;
    for (const block of blocks) {
      const result = reconstructBlock(block.values, block.uncertain, ec, expired); if (!result) return null;
      repaired += result.repaired; erased += result.erased;
      for (let offset = 0; offset < result.values.length; offset++) values[block.indices[offset]] = result.values[offset];
    }
    if (!repaired || expired()) return null;
    const corrected = modules.slice();
    for (let bit = 0; bit < total * 8; bit++) {
      const index = coords[bit], x = index % dimension, y = Math.floor(index / dimension);
      corrected[index] = ((values[Math.floor(bit / 8)] >> (7 - bit % 8)) & 1) ^ Number(maskBit(meta.mask, x, y));
    }
    return { modules: corrected, version: meta.version, errorCorrection: ['L', 'M', 'Q', 'H'][meta.level],
      // Both solvers reserve at least four parity bytes; byte solving can
      // reserve more, but bit solving guarantees this conservative minimum.
      repairedCodewords: repaired, erasedCodewords: erased, reservedParityPerBlock: 4, elapsedMs: clock() - started };
  }

  function sourceGrid(image, region, expired) {
    const d = region.dimension, q = region.quad;
    if (!region.gridReliable || region.clipped || !q || !Number.isInteger(d) || d < 21 || d > 57 ||
        region.moduleSize < 1.8 || region.moduleSize > 24) return null;
    const map = (x, y) => ({ x: q.topLeft.x + x * (q.topRight.x - q.topLeft.x) / d + y * (q.bottomLeft.x - q.topLeft.x) / d,
      y: q.topLeft.y + x * (q.topRight.y - q.topLeft.y) / d + y * (q.bottomLeft.y - q.topLeft.y) / d });
    const data = image.data instanceof ArrayBuffer ? new Uint8ClampedArray(image.data) : image.data;
    const sample = (x, y) => {
      const p = map(x, y), px = Math.round(p.x), py = Math.round(p.y);
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) return null;
      const i = (py * image.width + px) * 4, a = data[i + 3] / 255;
      return ((306 * data[i] + 601 * data[i + 1] + 117 * data[i + 2]) / 1024) * a + 255 * (1 - a);
    };
    // A photographed border is required. No missing outside pixels are filled.
    const border = [];
    for (let k = -1; k <= d; k++) for (const [x,y] of [[k+.5,-.5],[k+.5,d+.5],[-.5,k+.5],[d+.5,k+.5]]) {
      const value = sample(x,y); if (value === null) return null; border.push(value);
    }
    const values = [], lows = new Float32Array(d*d), highs = new Float32Array(d*d), medians = new Float32Array(d*d);
    for (let y=0;y<d;y++) {
      if (expired()) return null;
      for (let x=0;x<d;x++) {
        const samples=[];
        for (const dy of [-.28,0,.28]) for (const dx of [-.28,0,.28]) {
          const value=sample(x+.5+dx,y+.5+dy); if(value===null)return null; samples.push(value);
        }
        samples.sort((a,b)=>a-b); const i=y*d+x;
        lows[i]=samples[0]; highs[i]=samples[8]; medians[i]=samples[4]; values.push(...samples);
      }
    }
    values.sort((a,b)=>a-b);
    const low=values[Math.floor(values.length*.1)], high=values[Math.floor(values.length*.9)], span=high-low;
    if (span<80 || border.filter(value=>value>low+span*.8).length/border.length<.97) return null;
    const modules=Uint8Array.from(medians,value=>value<low+span*.5?1:0), uncertainty=new Uint8Array(d*d);
    // Within-cell disagreement is physical evidence of a defect or uncertain
    // sampling. Confident bits outside these cells cannot change in RS repair.
    for(let i=0;i<modules.length;i++)if(highs[i]-lows[i]>span*.5)uncertainty[i]=1;
    // Long all-white runs identify candidate occlusions. They do not assert a
    // payload: independent unused parity equations still have to agree.
    const blank=Uint8Array.from(lows,value=>value>low+span*.88?1:0);
    const minimum=Math.max(9,Math.ceil(d*.26));
    for(const vertical of [false,true])for(let line=1;line<d-1;line++) {
      let begin=0;
      while(begin<d) {
        const index=offset=>vertical?offset*d+line:line*d+offset;
        while(begin<d&&!blank[index(begin)])begin++;
        let end=begin;while(end<d&&blank[index(end)])end++;
        if(end-begin>=minimum)for(let offset=begin;offset<end;offset++)uncertainty[index(offset)]=1;
        begin=end+1;
      }
    }
    // Coherent bright strokes can erase complete cells without leaving local
    // contrast. Detect long photographed white lines, not a desired bit value.
    // A sampled line must be white almost everywhere across the symbol; only
    // already white cells along it become erasures. Dark evidence is retained.
    for(let a=1;a<d-1;a+=.5) {
      if(expired())return null;
      for(let b=1;b<d-1;b+=.5) {
        if(Math.abs(a-b)>d*.8)continue;
        let white=0,total=0;
        for(let x=1;x<d-1;x+=.5) {
          const y=a+(b-a)*(x-1)/(d-2),value=sample(x,y);total++;
          if(value!==null&&value>low+span*.94)white++;
          else if(total-white>1)break;
        }
        if(total<2*(d-2)||white/total<.98)continue;
        for(let x=1;x<d-1;x++)for(let y=Math.max(0,Math.floor(a+(b-a)*(x-.5)/(d-2)-1));y<Math.min(d,Math.ceil(a+(b-a)*(x-.5)/(d-2)+1));y++)
          if(blank[y*d+x])uncertainty[y*d+x]=1;
      }
    }
    return {dimension:d,modules,uncertainty,map,low,high,sample};
  }
  function reconstructed(grid, result) {
    const border=1, scale=4, side=(grid.dimension+2*border)*scale;
    const data=new Uint8ClampedArray(side*side*4).fill(255);
    for(let y=0;y<grid.dimension;y++)for(let x=0;x<grid.dimension;x++)if(result.modules[y*grid.dimension+x])
      for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
        const i=(((y+border)*scale+dy)*side+(x+border)*scale+dx)*4;data[i]=data[i+1]=data[i+2]=0;
      }
    return {image:{width:side,height:side,data},mapPoint:p=>grid.map(p.x/scale-border,p.y/scale-border)};
  }
  const key=result=>JSON.stringify([result.format,result.text,Array.from(result.bytes||[])]);
  const box=position=>position&&['topLeft','topRight','bottomRight','bottomLeft'].every(name=>Number.isFinite(position[name]?.x)&&Number.isFinite(position[name]?.y))?
    {left:Math.min(...Object.values(position).map(p=>p.x)),top:Math.min(...Object.values(position).map(p=>p.y)),
      right:Math.max(...Object.values(position).map(p=>p.x)),bottom:Math.max(...Object.values(position).map(p=>p.y))}:null;
  async function recover(image,{readNative,timeBudgetMs=250,mode='image'}={}) {
    const begun=clock(),budget=Math.min(mode==='live'?100:700,timeBudgetMs),expired=()=>clock()-begun>=budget;
    const results=[],identities=new Set();let passes=0,complete=true,observed=0;
    const answer=()=>({results:complete||identities.size>1?results:[],complete,observed,
      incompleteEvidence:!complete&&observed>0,passes,strategy:'qr-damage-erasure'});
    const data=image?.data instanceof ArrayBuffer?new Uint8ClampedArray(image.data):image?.data;
    if(!Number.isInteger(image?.width)||!Number.isInteger(image?.height)||image.width<1||image.height<1||image.width*image.height>4_000_000||
       !(data instanceof Uint8Array||data instanceof Uint8ClampedArray)||data.length!==image.width*image.height*4||
       typeof readNative!=='function'||!Number.isFinite(budget)||budget<=0||!geometry){complete=false;return answer();}
    const located=geometry.analyze(image,{maxScanDimension:960,maxRegions:3,timeBudgetMs:Math.min(80,budget)});
    complete=located.complete===true;
    const resolved=new Set();
    for(let regionIndex=0;regionIndex<located.regions.length;regionIndex++) {
      if(expired()){complete=false;break;}
      const region=located.regions[regionIndex],grid=sourceGrid(image,region,expired);
      if(!grid)continue;
      const fixed=repair(grid,{timeBudgetMs:Math.max(.01,Math.min(60,budget-(clock()-begun)))});
      if(!fixed)continue;
      const candidate=reconstructed(grid,fixed);
      const found=await readNative(candidate.image,{formats:['QRCode'],isPure:true,binarizer:'FixedThreshold',returnErrors:false});passes++;
      for(const result of found||[]) {
        const b=box(result?.position),side=grid.dimension*4;
        if(result?.isValid!==true||result.error||!['QRCode','QRCodeModel1','QRCodeModel2'].includes(result.format)||
           typeof result.text!=='string'||!result.bytes?.length||!b||Math.max(Math.abs(b.left-4),Math.abs(b.top-4),Math.abs(b.right-4-side),Math.abs(b.bottom-4-side))>6)continue;
        const position=Object.fromEntries(Object.entries(result.position).map(([name,p])=>[name,candidate.mapPoint(p)]));
        if(Object.values(position).some(p=>p.x<0||p.y<0||p.x>image.width||p.y>image.height))continue;
        observed++;identities.add(key(result));resolved.add(regionIndex);
        if(!results.some(old=>key(old)===key(result)&&['topLeft','topRight','bottomRight','bottomLeft'].every(name=>
          Math.abs(old.position[name].x-position[name].x)<3&&Math.abs(old.position[name].y-position[name].y)<3)))
          results.push({...result,position});
      }
    }
    if(observed&&resolved.size!==located.regions.length)complete=false;
    if(expired())complete=false;
    return answer();
  }
  return {repair,sourceGrid,recover};
});

