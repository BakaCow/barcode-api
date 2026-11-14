"""New fallback composition cannot hide a later conflicting/withheld label."""
from pathlib import Path
from time import monotonic
from types import SimpleNamespace

from PIL import Image
import pytest
import zxingcpp


@pytest.fixture
def reader(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1]))
    import barcode_reader
    return barcode_reader


def observation(payload=b'A', family='Code128', points=((1, 1), (9, 1), (9, 9), (1, 9)), **changes):
    code = SimpleNamespace(**(dict(text=payload.decode('latin-1'), bytes=payload,
                                  format=getattr(zxingcpp.BarcodeFormat, family), valid=True, error=None) | changes))
    return SimpleNamespace(code=code, points=points)


def result(*observations, complete=True, observed=None):
    return SimpleNamespace(observations=observations, complete=complete,
                           observed=len(observations) if observed is None else observed, passes=0)


def run(reader, allowed=None):
    with Image.new('L', (10, 10), 255) as source:
        return reader._recover_signals(source, lambda x, y: (x * 2, y * 2), (20, 20), allowed, monotonic())


def test_later_qr_conflict_is_not_hidden_by_earlier_linear_result(reader, monkeypatch):
    calls = []
    def linear(*args, **kwargs):
        calls.append('linear'); return result(observation())
    def qr(*args, **kwargs):
        calls.append('qr'); return result(observation(b'B', 'QRCode'))
    monkeypatch.setattr(reader.linear_signal, 'recover', linear)
    monkeypatch.setattr(reader.qr_signal, 'recover', qr)
    records = run(reader)
    assert calls == ['linear', 'qr']
    assert [(record.bytes, record.format.name) for record in records] == [(b'A', 'Code128'), (b'B', 'QRCode')]
    assert records[0].points == ((2, 2), (18, 2), (18, 18), (2, 18))


@pytest.mark.parametrize('incomplete_first', [True, False])
def test_either_incomplete_search_vetoes_unique_result(reader, monkeypatch, incomplete_first):
    monkeypatch.setattr(reader.linear_signal, 'recover', lambda *a, **k: result(complete=False, observed=1) if incomplete_first else result(observation()))
    monkeypatch.setattr(reader.qr_signal, 'recover', lambda *a, **k: result(observation(b'Q', 'QRCode')) if incomplete_first else result(complete=False, observed=1))
    assert run(reader) == []


def test_visible_conflicts_survive_incomplete_search(reader, monkeypatch):
    monkeypatch.setattr(reader.linear_signal, 'recover', lambda *a, **k: result(observation(), observation(b'B'), complete=False))
    monkeypatch.setattr(reader.qr_signal, 'recover', lambda *a, **k: result(complete=False))
    assert [record.bytes for record in run(reader)] == [b'A', b'B']


def test_explicit_formats_do_not_plan_excluded_helper(reader, monkeypatch):
    monkeypatch.setattr(reader.linear_signal, 'recover', lambda *a, **k: result(observation()))
    def unexpected(*args, **kwargs):
        pytest.fail('Disallowed QR helper called.')
    monkeypatch.setattr(reader.qr_signal, 'recover', unexpected)
    assert len(run(reader, ['code128'])) == 1


@pytest.mark.parametrize('invalid', [
    observation(bytes=b''), observation(bytes=[65]), observation(valid=False), observation(error='invalid'),
    observation(family='EAN8'), observation(points=((1, 1), (9, 1), (11, 9), (1, 9))),
    observation(points=((1, 1), (9, 1), (float('nan'), 9), (1, 9))),
])
def test_malformed_helper_record_cannot_make_another_result_look_unique(reader, monkeypatch, invalid):
    monkeypatch.setattr(reader.linear_signal, 'recover', lambda *a, **k: result(observation(), invalid))
    monkeypatch.setattr(reader.qr_signal, 'recover', lambda *a, **k: result())
    assert run(reader) == []


def test_exact_native_control_bytes_are_not_rebuilt_from_text(reader, monkeypatch):
    value = observation(b'\x00\x1d\xff', text='<NUL><GS>ÿ')
    monkeypatch.setattr(reader.linear_signal, 'recover', lambda *a, **k: result(value))
    monkeypatch.setattr(reader.qr_signal, 'recover', lambda *a, **k: result())
    found = run(reader)
    assert found[0].text == '<NUL><GS>ÿ'
    assert found[0].bytes == b'\x00\x1d\xff'


def test_damage_search_cannot_hide_conflicts_or_finish_an_incomplete_batch(reader, monkeypatch):
    monkeypatch.setattr(reader.linear_signal, 'recover', lambda *a, **k: result())
    monkeypatch.setattr(reader.qr_signal, 'recover', lambda *a, **k: result(observation(b'A', 'QRCode')))
    monkeypatch.setattr(reader.qr_damage, 'recover', lambda *a, **k: result(complete=False, observed=1))
    assert run(reader) == []
    monkeypatch.setattr(reader.qr_damage, 'recover', lambda *a, **k: result(observation(b'B', 'QRCode'), complete=False))
    assert [record.bytes for record in run(reader)] == [b'A', b'B']


def test_same_symbol_from_two_methods_is_one_record_but_separate_labels_survive(reader, monkeypatch):
    first = observation(b'A', 'QRCode', points=((1, 1), (4, 1), (4, 4), (1, 4)))
    second = observation(b'A', 'QRCode', points=((6, 1), (9, 1), (9, 4), (6, 4)))
    monkeypatch.setattr(reader.linear_signal, 'recover', lambda *a, **k: result())
    monkeypatch.setattr(reader.qr_signal, 'recover', lambda *a, **k: result(first))
    monkeypatch.setattr(reader.qr_damage, 'recover', lambda *a, **k: result(first, second))
    found = run(reader)
    assert len(found) == 2
    assert found[0].points != found[1].points
