"""Damage recovery uses measured pixels and parity, never fixture payload hints."""
import base64
import json
from pathlib import Path
from time import monotonic
from types import SimpleNamespace
import zlib

from PIL import Image
import pytest
import zxingcpp

import qr_damage
import qr_recovery

ROOT=Path(__file__).resolve().parents[1]
def load(name):return json.loads((ROOT/'tests/fixtures'/name).read_text())['cases']
CASES=sum((load(name) for name in ('damage-stress-dev.json','damage-stress-signal-upgrade.json','damage-stress-qr-upgrade.json')),[])
NAMES=['qr/qr-upgrade-qr-label-2/missing-patch-1',*[f'qr/signal-upgrade-qr-label-{n}/missing-patch-1' for n in (1,2,3)],
       'qr/dev-qr-label-2/scratches-2','qr/dev-qr-label-2/missing-patch-2']
TARGETS=[next(case for case in CASES if case['name']==name) for name in NAMES]

def pixels(case):
    with Image.frombytes('RGBA',(case['width'],case['height']),zlib.decompress(base64.b64decode(case['rgba_zlib_base64']))) as rgba:
        return rgba.convert('L')

def recover(image):return qr_damage.recover(image,deadline=monotonic()+.7)


@pytest.mark.parametrize('case',TARGETS,ids=lambda case:case['name'])
def test_source_supported_erasure_reconstruction(case):
    with pixels(case) as image:
        before=image.tobytes();found=recover(image)
        assert found.complete
        assert len(found.observations)==1
        code=found.observations[0].code
        assert code.text==case['expected'][0]['text']
        assert code.bytes==case['expected'][0]['text'].encode()
        assert image.tobytes()==before
        assert all(0<=x<=image.width and 0<=y<=image.height for x,y in found.observations[0].points)


def test_all_old_negatives_and_clipped_qr_reject():
    for case in CASES:
        if case['expected'] and not (case['name'].startswith('qr/') and case['name'].endswith('/clipping-2')):continue
        with pixels(case) as image:assert not recover(image).observations,case['name']


def stripe(image):
    proposal=qr_recovery.find_proposals(image,monotonic()+.5).proposals[0]
    col=proposal.dimension//2;a=proposal.point(col,0);b=proposal.point(col+1,proposal.dimension)
    result=image.copy()
    for y in range(int(a[1]+.5),int(b[1]+.5)):
        for x in range(int(a[0]+.5),int(b[0]+.5)):result.putpixel((x,y),255)
    return result


def test_binary_control_latin1_utf8_payloads_keep_canonical_native_bytes():
    for case in load('independent-byte-controls.json'):
        if case['format']!='QRCode':continue
        with pixels(case) as image:
            canonical=zxingcpp.read_barcodes(image,formats=zxingcpp.BarcodeFormat.QRCode)[0]
            with stripe(image) as damaged:found=recover(damaged)
        assert found.complete
        assert len(found.observations)==1,case['name']
        assert found.observations[0].code.bytes==bytes(case['encoderBytes'])
        assert found.observations[0].code.text==canonical.text


def test_confident_bits_and_reserved_parity_are_not_discarded():
    with pixels(TARGETS[0]) as image:
        proposal=qr_recovery.find_proposals(image,monotonic()+.5).proposals[0]
        modules,uncertainty=qr_damage.source_grid(image,proposal,monotonic()+.7)
        fixed=qr_damage.repair(proposal.dimension,modules,uncertainty,monotonic()+.06)
        assert fixed is not None
        assert all(a==b for a,b,unknown in zip(modules,fixed,uncertainty) if not unknown)
        assert qr_damage.repair(proposal.dimension,modules,bytearray(len(modules)),monotonic()+.06) is None
        assert qr_damage.repair(proposal.dimension,modules,bytearray([1])*len(modules),monotonic()+.06) is None


def joined(first,second):
    offset=max(first.size)+25;side=offset+max(second.size)
    output=Image.new('L',(side,side),255);output.paste(first,(0,0));output.paste(second,(offset,offset))
    return output


def test_separate_equal_and_distinct_labels_keep_their_physical_observations():
    for case in (TARGETS[0],TARGETS[1]):
        with pixels(TARGETS[0]) as a,pixels(case) as b,joined(a,b) as image:
            found=recover(image)
        assert found.complete
        assert len(found.observations)==2
        assert abs(found.observations[0].points[0][0]-found.observations[1].points[0][0])>100


def test_unresolved_neighbour_cannot_leave_a_unique_accepted_result():
    unread=next(case for case in CASES if case['name']=='qr/qr-upgrade-qr-label-2/missing-patch-2')
    with pixels(TARGETS[0]) as a,pixels(unread) as b,joined(a,b) as image:
        found=recover(image)
    assert not found.complete
    assert found.observed>0
    assert not found.observations


def test_native_deadline_overrun_retains_withheld_evidence(monkeypatch):
    native=zxingcpp.read_barcodes;clock=[0.0]
    monkeypatch.setattr(qr_damage,'monotonic',lambda:clock[0])
    # Real locator and native decoder are used; only their clocks are controlled.
    monkeypatch.setattr(qr_recovery,'monotonic',lambda:clock[0])
    def read(*args,**kwargs):
        result=native(*args,**kwargs);clock[0]=.8;return result
    monkeypatch.setattr(zxingcpp,'read_barcodes',read)
    with pixels(TARGETS[0]) as image:found=qr_damage.recover(image,deadline=.7)
    assert not found.complete
    assert found.observed==1
    assert not found.observations


def test_full_size_linear_source_is_completely_inspected_without_vetoing_its_read():
    import barcode_reader
    case=next(case for case in CASES if case['name']=='code128/signal-upgrade-code128-label-1/small-in-frame-2')
    with pixels(case) as image:
        search=recover(image)
        assert search.complete and not search.observations
        found=barcode_reader.read_barcodes(image)
    assert len(found)==1
    assert found[0].format.name=='Code128'
    assert found[0].text==case['expected'][0]['text']
    assert found[0].bytes==case['expected'][0]['text'].encode()
    assert all(0<=x<=case['width'] and 0<=y<=case['height'] for x,y in found[0].points)


def test_locator_can_finish_a_bounded_full_scan_but_never_extends_caller_deadline(monkeypatch):
    clock=[0.0]
    monkeypatch.setattr(qr_damage,'monotonic',lambda:clock[0])
    def bounded_scan(image,deadline):
        # Model a complete scan taking 110 ms, including all empty source rows.
        # A shorter caller deadline must still report incomplete, not no-QR.
        complete=deadline>=.11
        clock[0]=min(deadline,.11)
        return qr_recovery.Search((),complete)
    monkeypatch.setattr(qr_recovery,'find_proposals',bounded_scan)
    with Image.new('L',(1056,672),255) as image:
        assert qr_damage.recover(image,deadline=.7).complete
        clock[0]=0.0
        limited=qr_damage.recover(image,deadline=.05)
        assert not limited.complete and not limited.observations


@pytest.mark.parametrize('change',[{'valid':False},{'error':'invalid'},{'format':zxingcpp.BarcodeFormat.Code128}])
def test_invalid_native_status_and_wrong_families_do_not_escape(monkeypatch,change):
    native=zxingcpp.read_barcodes
    def read(*args,**kwargs):
        found=[]
        for code in native(*args,**kwargs):
            fields={name:getattr(code,name) for name in ('valid','error','format','text','bytes','position')};fields.update(change)
            found.append(SimpleNamespace(**fields))
        return found
    monkeypatch.setattr(zxingcpp,'read_barcodes',read)
    with pixels(TARGETS[0]) as image:assert not recover(image).observations
