/* Experimental oriented-gradient locator and projective sampler. Project code.
 * A proposal is only a search region, never evidence that a barcode is valid. */
(function (root) {
  'use strict';
  // Cache intrinsics for bounded scan loops in browser and worker realms.
  const { abs, atan2, ceil, cos, floor, hypot, max, min, round, sign, sin, sqrt } = Math;
  const finite = Number.isFinite, integer = Number.isInteger;
  const MAX_PIXELS = 4_000_000;
  function validate(gray, width, height) {
    if (!(gray instanceof Uint8Array || gray instanceof Uint8ClampedArray) ||
        !integer(width) || !integer(height) || width < 1 || height < 1 ||
        width * height > MAX_PIXELS || gray.length !== width * height) throw new Error('Invalid grayscale image.');
  }
  function detect(gray, width, height) {
    validate(gray, width, height);
    const scale = min(1, 960 / max(width, height));
    const w = max(1, floor(width * scale)), h = max(1, floor(height * scale));
    if (w < 12 || h < 12) return [];
    const pixels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      pixels[y * w + x] = gray[min(height - 1, floor((y + 0.5) * height / h)) * width + min(width - 1, floor((x + 0.5) * width / w))];
    }
    const tile = 8, cols = ceil(w / tile), rows = ceil(h / tile), count = cols * rows;
    const xx = new Float64Array(count), yy = new Float64Array(count), xy = new Float64Array(count), sizes = new Uint16Array(count);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x, i = floor(y / tile) * cols + floor(x / tile);
      const gx = pixels[p - w + 1] + 2 * pixels[p + 1] + pixels[p + w + 1] - pixels[p - w - 1] - 2 * pixels[p - 1] - pixels[p + w - 1];
      const gy = pixels[p + w - 1] + 2 * pixels[p + w] + pixels[p + w + 1] - pixels[p - w - 1] - 2 * pixels[p - w] - pixels[p - w + 1];
      xx[i] += gx * gx; yy[i] += gy * gy; xy[i] += gx * gy; sizes[i]++;
    }
    const angles = new Float64Array(count), energies = new Float64Array(count), coherence = new Float64Array(count);
    let totalEnergy = 0;
    for (let i = 0; i < count; i++) {
      const sum = xx[i] + yy[i];
      energies[i] = sum / max(1, sizes[i]); totalEnergy += energies[i];
      coherence[i] = sum ? hypot(xx[i] - yy[i], 2 * xy[i]) / sum : 0;
      angles[i] = 0.5 * atan2(2 * xy[i], xx[i] - yy[i]);
    }
    const threshold = max(150, totalEnergy / count * 0.45);
    const enabled = (i) => energies[i] >= threshold && coherence[i] >= 0.65;
    const visited = new Uint8Array(count), proposals = [];
    for (let seed = 0; seed < count; seed++) {
      if (visited[seed] || !enabled(seed)) continue;
      const component = [], stack = [seed]; visited[seed] = 1;
      while (stack.length) {
        const current = stack.pop(); component.push(current);
        const cx = current % cols, cy = floor(current / cols);
        // Bridge narrow white gaps between bars, but keep incompatible directions apart.
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const next = y * cols + x;
          if (visited[next] || !enabled(next) || cos(2 * (angles[next] - angles[current])) < 0.82) continue;
          visited[next] = 1; stack.push(next);
        }
      }
      if (component.length < 5) continue;
      let cosine = 0, sine = 0;
      for (const i of component) { cosine += cos(2 * angles[i]) * energies[i]; sine += sin(2 * angles[i]) * energies[i]; }
      const angle = atan2(sine, cosine) / 2, c = cos(angle), s = sin(angle);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const i of component) {
        const x0 = (i % cols) * tile, y0 = floor(i / cols) * tile;
        for (const [x, y] of [[x0,y0],[min(w,x0+tile),y0],[x0,min(h,y0+tile)],[min(w,x0+tile),min(h,y0+tile)]]) {
          const u = c * x + s * y, v = -s * x + c * y;
          u0 = min(u0,u); u1 = max(u1,u); v0 = min(v0,v); v1 = max(v1,v);
        }
      }
      const span = u1 - u0, depth = v1 - v0;
      if (span < 32 || depth < 8 || span / depth < 0.8) continue;
      // Preserve the real surrounding quiet zones; out-of-frame sampling is marked white.
      const horizontalMargin = max(12, span * 0.16), verticalMargin = max(3, depth * 0.08);
      u0 -= horizontalMargin; u1 += horizontalMargin; v0 -= verticalMargin; v1 += verticalMargin;
      const point = (u, v) => ({ x: (c*u-s*v) * width / w, y: (s*u+c*v) * height / h });
      proposals.push({ corners: [point(u0,v0),point(u1,v0),point(u1,v1),point(u0,v1)], angle,
        score: component.length * min(4, span / depth), tiles: component.length });
    }
    return proposals.sort((a,b)=>b.score-a.score).slice(0,10);
  }

  function rectify(gray, width, height, corners, maxPixels = 1_500_000, horizontalScale = 1) {
    validate(gray,width,height);
    if (!Array.isArray(corners) || corners.length !== 4 || corners.some(p=>!finite(p.x)||!finite(p.y)) ||
        !integer(maxPixels) || maxPixels < 4 || maxPixels > MAX_PIXELS ||
        !finite(horizontalScale) || horizontalScale < 1 || horizontalScale > 2) throw new Error('Invalid crop geometry.');
    const crosses=corners.map((p,i)=>{const q=corners[(i+1)%4],r=corners[(i+2)%4];return(q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x);});
    if(crosses.some(value=>!finite(value)||abs(value)<1e-8)||crosses.some(value=>sign(value)!==sign(crosses[0])))throw new Error('Crop corners must form a convex ordered quadrilateral.');
    const [p0,p1,p2,p3]=corners;
    const length=(a,b)=>hypot(a.x-b.x,a.y-b.y);
    const naturalWidth=max(length(p0,p1),length(p3,p2)), naturalHeight=max(length(p0,p3),length(p1,p2));
    if (naturalWidth < 2 || naturalHeight < 2) throw new Error('Crop is too small.');
    // Extra horizontal samples reduce edge quantization for narrow modules.
    // Keep vertical sampling unchanged so retries do not multiply source rows.
    const sampleWidth=naturalWidth*horizontalScale;
    const scale=min(1,4096/sampleWidth,2048/naturalHeight,sqrt(maxPixels/(sampleWidth*naturalHeight)));
    const outWidth=max(2,min(floor(maxPixels/2),floor(sampleWidth*scale)));
    const outHeight=max(2,min(floor(maxPixels/outWidth),floor(naturalHeight*scale)));
    const dx1=p1.x-p2.x, dx2=p3.x-p2.x, dx3=p0.x-p1.x+p2.x-p3.x;
    const dy1=p1.y-p2.y, dy2=p3.y-p2.y, dy3=p0.y-p1.y+p2.y-p3.y;
    let g=0,h=0;
    if (abs(dx3)+abs(dy3)>1e-8) {
      const determinant=dx1*dy2-dx2*dy1;
      if (abs(determinant)<1e-8) throw new Error('Degenerate crop geometry.');
      g=(dx3*dy2-dx2*dy3)/determinant; h=(dx1*dy3-dx3*dy1)/determinant;
    }
    if([1,1+g,1+h,1+g+h].some(value=>!finite(value)||value<=1e-8))throw new Error('Unstable crop geometry.');
    const a=p1.x-p0.x+g*p1.x, b=p3.x-p0.x+h*p3.x, c=p0.x;
    const d=p1.y-p0.y+g*p1.y, e=p3.y-p0.y+h*p3.y, f=p0.y;
    const map=({x,y})=>{
      const u=x/(outWidth-1),v=y/(outHeight-1),den=g*u+h*v+1;
      return {x:(a*u+b*v+c)/den,y:(d*u+e*v+f)/den};
    };
    const output=new Uint8Array(outWidth*outHeight).fill(255);
    for(let y=0;y<outHeight;y++) for(let x=0;x<outWidth;x++) {
      const p=map({x,y});
      if(p.x<0||p.y<0||p.x>width-1||p.y>height-1||!finite(p.x)||!finite(p.y))continue;
      const x0=floor(p.x),y0=floor(p.y),x1=min(width-1,x0+1),y1=min(height-1,y0+1),fx=p.x-x0,fy=p.y-y0;
      output[y*outWidth+x]=round((1-fy)*((1-fx)*gray[y0*width+x0]+fx*gray[y0*width+x1])+fy*((1-fx)*gray[y1*width+x0]+fx*gray[y1*width+x1]));
    }
    return {gray:output,width:outWidth,height:outHeight,map};
  }
  const api={detect,rectify};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Code128Detector=api;
})(typeof globalThis!=='undefined'?globalThis:this);
