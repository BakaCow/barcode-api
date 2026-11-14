"""Source-supported QR erasure reconstruction, versions 1–10.

QR block/alignment/version constants derive from jsQR 1.4.0 (Cosmo Wolfe and
contributors), Apache-2.0. See web/vendor/THIRD-PARTY.txt and the bundled Apache
license. GF equations, masks and source checks are project code. Uncertain
source bits alone may change; at least four parity bytes remain as constraints.
"""
from dataclasses import dataclass
from math import ceil, floor, isfinite
from time import monotonic

from PIL import Image
import zxingcpp
import qr_recovery

LAYOUTS = (
    (None,(),((7,1,19),(10,1,16),(13,1,13),(17,1,9))),
    (None,(6,18),((10,1,34),(16,1,28),(22,1,22),(28,1,16))),
    (None,(6,22),((15,1,55),(26,1,44),(18,2,17),(22,2,13))),
    (None,(6,26),((20,1,80),(18,2,32),(26,2,24),(16,4,9))),
    (None,(6,30),((26,1,108),(24,2,43),(18,2,15,2,16),(22,2,11,2,12))),
    (None,(6,34),((18,2,68),(16,4,27),(24,4,19),(28,4,15))),
    (31892,(6,22,38),((20,2,78),(18,4,31),(18,2,14,4,15),(26,4,13,1,14))),
    (34236,(6,24,42),((24,2,97),(22,2,38,2,39),(22,4,18,2,19),(26,4,14,2,15))),
    (39577,(6,26,46),((30,2,116),(22,3,36,2,37),(20,4,16,4,17),(24,4,12,4,13))),
    (42195,(6,28,50),((18,2,68,2,69),(26,4,43,1,44),(24,6,19,2,20),(28,6,15,2,16))),
)
EXP, LOG = [0]*510, [0]*256
value = 1
for index in range(255):
    EXP[index], LOG[value] = value, index
    value <<= 1
    if value & 256: value ^= 0x11d
for index in range(255,510): EXP[index] = EXP[index-255]


@dataclass(frozen=True, slots=True)
class Observation:
    code: object
    points: tuple[tuple[float,float],...]


@dataclass(frozen=True, slots=True)
class Result:
    observations: tuple[Observation,...]
    complete: bool
    observed: int
    passes: int


def mul(a,b): return EXP[LOG[a]+LOG[b]] if a and b else 0
def power(n): return EXP[n%255]


def format_word(data):
    value = data << 10
    for bit in range(14,9,-1):
        if value & (1 << bit): value ^= 0x537 << (bit-10)
    return ((data << 10)|value)^0x5412


def metadata(modules, dimension, uncertainty):
    version = (dimension-17)//4
    if (dimension-17)%4 or not 1 <= version <= 10: return None
    layout = LAYOUTS[version-1]
    first = [(x,8) for x in range(9) if x!=6] + [(8,y) for y in range(7,-1,-1) if y!=6]
    second = [(8,y) for y in range(dimension-1,dimension-8,-1)] + [(x,8) for x in range(dimension-8,dimension)]
    def bits(coordinates, values):
        value=0
        for x,y in coordinates: value=(value<<1)|values[y*dimension+x]
        return value
    a,b = bits(first,modules),bits(second,modules)
    ua,ub = bits(first,uncertainty),bits(second,uncertainty)
    matches=[]
    for data in range(32):
        word=format_word(data)
        if min((word^a).bit_count(),(word^b).bit_count())<=2 and not ((word^a)&(32767^ua)) and not ((word^b)&(32767^ub)):
            matches.append(data)
    if len(matches)!=1: return None
    if version>6:
        a=bits([(x,y) for y in range(5,-1,-1) for x in range(dimension-9,dimension-12,-1)],modules)
        b=bits([(x,y) for x in range(5,-1,-1) for y in range(dimension-9,dimension-12,-1)],modules)
        if (a^layout[0]).bit_count()>2 or (b^layout[0]).bit_count()>2: return None
    data=matches[0]
    return version,layout,(1,0,3,2)[data>>3],data&7


def data_coordinates(dimension, meta):
    version,layout,_,_=meta
    reserved=bytearray(dimension*dimension)
    def mark(x,y,w,h):
        for yy in range(y,y+h):
            for xx in range(x,x+w): reserved[yy*dimension+xx]=1
    mark(0,0,9,9);mark(dimension-8,0,8,9);mark(0,dimension-8,9,8)
    for x in layout[1]:
        for y in layout[1]:
            if (x==6 and y in (6,dimension-7)) or (y==6 and x==dimension-7): continue
            mark(x-2,y-2,5,5)
    mark(6,9,1,dimension-17);mark(9,6,dimension-17,1)
    if version>6: mark(dimension-11,0,3,6);mark(0,dimension-11,6,3)
    result=[];up=True;right=dimension-1
    while right>0:
        if right==6:right-=1
        for offset in range(dimension):
            y=dimension-1-offset if up else offset
            for x in (right,right-1):
                if not reserved[y*dimension+x]:result.append(y*dimension+x)
        up=not up;right-=2
    return result


def mask_bit(mask,x,y):
    return ((x+y)%2==0,y%2==0,x%3==0,(x+y)%3==0,(y//2+x//3)%2==0,
            (x*y)%2+(x*y)%3==0,((x*y)%2+(x*y)%3)%2==0,((x+y)%2+(x*y)%3)%2==0)[mask]


def syndrome(values,count):
    result=[]
    for s in range(count):
        value=0
        for byte in values:value=mul(value,power(s))^byte
        result.append(value)
    return result


def reconstruct_bits(values, uncertain, ec, deadline):
    variables=[(i,1<<bit) for i,mask in enumerate(uncertain) for bit in range(8) if mask&(1<<bit)]
    n,m=len(variables),ec*8
    if not n or n>min(192,m-32) or monotonic()>=deadline:return None
    checks=syndrome(values,ec);rows=[]
    for s in range(ec):
        coefficients=[mul(bit,power(s*(len(values)-1-index))) for index,bit in variables]
        for bit in range(8):
            row=((checks[s]>>bit)&1)<<n
            for col,value in enumerate(coefficients):
                if (value>>bit)&1:row|=1<<col
            rows.append(row)
    for col in range(n):
        if monotonic()>=deadline:return None
        flag=1<<col;pivot=next((row for row in range(col,m) if rows[row]&flag),None)
        if pivot is None:return None
        rows[pivot],rows[col]=rows[col],rows[pivot]
        for row in range(m):
            if row!=col and rows[row]&flag:rows[row]^=rows[col]
    if any(rows[n:]):return None
    output=bytearray(values)
    for col,(index,bit) in enumerate(variables):
        if rows[col]&(1<<n):output[index]^=bit
    if output==values or any(syndrome(output,ec)) or monotonic()>=deadline:return None
    return output


def reconstruct_block(values, uncertain, ec, deadline):
    checks=syndrome(values,ec)
    if not any(checks):return bytearray(values)
    erased=[index for index,bits in enumerate(uncertain) if bits]
    if not erased or monotonic()>=deadline:return None
    if len(erased)>ec-max(4,ceil(ec/4)):return reconstruct_bits(values,uncertain,ec,deadline)
    n=len(erased)
    rows=[[power(s*(len(values)-1-index)) for index in erased]+[checks[s]] for s in range(n)]
    for col in range(n):
        if monotonic()>=deadline:return None
        pivot=next((row for row in range(col,n) if rows[row][col]),None)
        if pivot is None:return None
        rows[pivot],rows[col]=rows[col],rows[pivot]
        inverse=power(255-LOG[rows[col][col]])
        for j in range(col,n+1):rows[col][j]=mul(rows[col][j],inverse)
        for row in range(n):
            if row!=col and rows[row][col]:
                factor=rows[row][col]
                for j in range(col,n+1):rows[row][j]^=mul(factor,rows[col][j])
    output=bytearray(values)
    for col,index in enumerate(erased):
        difference=rows[col][n]
        if difference&(255^uncertain[index]):return reconstruct_bits(values,uncertain,ec,deadline)
        output[index]^=difference
    if output==values or any(syndrome(output,ec)) or monotonic()>=deadline:return None
    return output


def repair(dimension,modules,uncertainty,deadline):
    if (not isinstance(dimension,int) or not 21<=dimension<=57 or (dimension-17)%4 or
        len(modules)!=dimension*dimension or len(uncertainty)!=len(modules) or
        any(value not in (0,1) for value in modules) or any(value not in (0,1) for value in uncertainty) or
        monotonic()>=deadline):return None
    meta=metadata(modules,dimension,uncertainty)
    if meta is None:return None
    _,layout,level,mask=meta;coordinates=data_coordinates(dimension,meta);spec=layout[2][level];ec=spec[0]
    blocks=[]
    for i in range(1,len(spec),2):
        for _ in range(spec[i]):blocks.append((spec[i+1],bytearray(spec[i+1]+ec),bytearray(spec[i+1]+ec),[]))
    total=sum(len(block[1]) for block in blocks)
    if len(coordinates)//8!=total:return None
    values,uncertain=bytearray(total),bytearray(total)
    for bit in range(total*8):
        index=coordinates[bit];x,y=index%dimension,index//dimension;shift=7-bit%8
        values[bit//8]|=(modules[index]^mask_bit(mask,x,y))<<shift
        uncertain[bit//8]|=uncertainty[index]<<shift
    index=0
    for offset in range(max(block[0] for block in blocks)):
        for size,data,unknown,indices in blocks:
            if offset<size:data[offset]=values[index];unknown[offset]=uncertain[index];indices.append(index);index+=1
    for offset in range(ec):
        for size,data,unknown,indices in blocks:
            data[size+offset]=values[index];unknown[size+offset]=uncertain[index];indices.append(index);index+=1
    repaired=0
    for _,data,unknown,indices in blocks:
        result=reconstruct_block(data,unknown,ec,deadline)
        if result is None:return None
        repaired+=sum(a!=b for a,b in zip(data,result))
        for index,value in zip(indices,result):values[index]=value
    if not repaired or monotonic()>=deadline:return None
    corrected=bytearray(modules)
    for bit in range(total*8):
        index=coordinates[bit];x,y=index%dimension,index//dimension
        corrected[index]=((values[bit//8]>>(7-bit%8))&1)^mask_bit(mask,x,y)
    return corrected


def source_grid(image,proposal,deadline):
    d=proposal.dimension
    pitch=(proposal.top_left.module+proposal.top_right.module+proposal.bottom_left.module)/3
    if d<21 or d>57 or not 1.8<=pitch<=24:return None
    pixels=image.load()
    def sample(x,y):
        px,py=proposal.point(x,y);px,py=floor(px+.5),floor(py+.5)
        return pixels[px,py] if 0<=px<image.width and 0<=py<image.height else None
    border=[]
    for k in range(-1,d+1):
        for x,y in ((k+.5,-.5),(k+.5,d+.5),(-.5,k+.5),(d+.5,k+.5)):
            value=sample(x,y)
            if value is None:return None
            border.append(value)
    values=[];lows=[];highs=[];medians=[]
    for y in range(d):
        if monotonic()>=deadline:return None
        for x in range(d):
            samples=[sample(x+.5+dx,y+.5+dy) for dy in (-.28,0,.28) for dx in (-.28,0,.28)]
            if None in samples:return None
            samples.sort();lows.append(samples[0]);highs.append(samples[-1]);medians.append(samples[4]);values.extend(samples)
    values.sort();low,high=values[floor(len(values)*.1)],values[floor(len(values)*.9)];span=high-low
    if span<80 or sum(value>low+span*.8 for value in border)/len(border)<.97:return None
    modules=bytearray(value<low+span*.5 for value in medians)
    uncertainty=bytearray(high-low>span*.5 for high,low in zip(highs,lows))
    blank=bytearray(value>low+span*.88 for value in lows);minimum=max(9,ceil(d*.26))
    for vertical in (False,True):
        for line in range(1,d-1):
            def index(offset):return offset*d+line if vertical else line*d+offset
            begin=0
            while begin<d:
                while begin<d and not blank[index(begin)]:begin+=1
                end=begin
                while end<d and blank[index(end)]:end+=1
                if end-begin>=minimum:
                    for offset in range(begin,end):uncertainty[index(offset)]=1
                begin=end+1
    for aa in range(2,2*(d-1)):
        if monotonic()>=deadline:return None
        a=aa/2
        for bb in range(2,2*(d-1)):
            b=bb/2
            if abs(a-b)>d*.8:continue
            white=total=0
            for xx in range(2,2*(d-1)):
                x=xx/2;y=a+(b-a)*(x-1)/(d-2);value=sample(x,y);total+=1
                if value is not None and value>low+span*.94:white+=1
                elif total-white>1:break
            if total<2*(d-2) or white/total<.98:continue
            for x in range(1,d-1):
                center=a+(b-a)*(x-.5)/(d-2)
                for y in range(max(0,floor(center-1)),min(d,ceil(center+1))):
                    if blank[y*d+x]:uncertainty[y*d+x]=1
    return modules,uncertainty


def reconstructed(dimension,modules):
    side=(dimension+2)*4;data=bytearray([255])*(side*side)
    for y in range(dimension):
        for x in range(dimension):
            if modules[y*dimension+x]:
                for dy in range(4):
                    for dx in range(4):data[((y+1)*4+dy)*side+(x+1)*4+dx]=0
    return Image.frombytes('L',(side,side),bytes(data))


def recover(image,*,deadline):
    if not isinstance(deadline,(int,float)) or not isfinite(deadline):return Result((),False,0,0)
    deadline=min(deadline,monotonic()+.7)
    if image.mode!='L' or min(image.size)<1 or image.width*image.height>4_000_000 or monotonic()>=deadline:
        return Result((),False,0,0)
    # Python must finish inspecting the same bounded 960-pixel thumbnail even
    # when it contains no QR. A too-short locator slice would veto an already
    # proven linear observation merely because this additional search timed out.
    search=qr_recovery.find_proposals(image,min(deadline,monotonic()+.15))
    observations=[];identities=set();resolved=set();passes=0;complete=search.complete
    for proposal_index,proposal in enumerate(search.proposals):
        if monotonic()>=deadline:complete=False;break
        grid=source_grid(image,proposal,deadline)
        if grid is None:continue
        fixed=repair(proposal.dimension,*grid,min(deadline,monotonic()+.06))
        if fixed is None:continue
        with reconstructed(proposal.dimension,fixed) as candidate:
            codes=zxingcpp.read_barcodes(candidate,formats=zxingcpp.BarcodeFormat.QRCode,is_pure=True,binarizer=zxingcpp.Binarizer.FixedThreshold)
            passes+=1
            for code in codes:
                if not code.valid or code.error or code.format.name not in ('QRCode','QRCodeModel1','QRCodeModel2') or not code.bytes:continue
                native=tuple((p.x,p.y) for p in (code.position.top_left,code.position.top_right,code.position.bottom_right,code.position.bottom_left))
                left,right=min(p[0] for p in native),max(p[0] for p in native);top,bottom=min(p[1] for p in native),max(p[1] for p in native)
                side=proposal.dimension*4
                if max(abs(left-4),abs(top-4),abs(right-4-side),abs(bottom-4-side))>6:continue
                points=tuple(proposal.point(x/4-1,y/4-1) for x,y in native)
                if any(not 0<=x<=image.width or not 0<=y<=image.height for x,y in points):continue
                identity=(code.format.name,code.text,code.bytes);identities.add(identity);resolved.add(proposal_index)
                if not any((entry.code.format.name,entry.code.text,entry.code.bytes)==identity and
                           max(abs(a-b) for p,q in zip(entry.points,points) for a,b in zip(p,q))<3 for entry in observations):
                    observations.append(Observation(code,points))
    if observations and len(resolved)!=len(search.proposals):complete=False
    if monotonic()>=deadline:complete=False
    return Result(tuple(observations) if complete or len(identities)>1 else (),complete,len(observations),passes)
