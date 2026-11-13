"""POS decisions use only bounded request evidence and never look up products."""

import base64
from copy import deepcopy

from pydantic import ValidationError
import pytest

from pos_decoding import POS_FORMATS, PosOptions, decide_pos


def barcode(text="BOX-1042", format_="code128", raw=None, x=0):
    return {
        "text": text, "format": format_,
        "bytes_base64": base64.b64encode(text.encode() if raw is None else raw).decode(),
        "position": [{"x": x, "y": 0}, {"x": x + 20, "y": 0},
                     {"x": x + 20, "y": 10}, {"x": x, "y": 10}],
    }


def frame(index, *barcodes, duplicate_of=None):
    return {"index": index, "image": {"width": 200, "height": 100},
            "duplicate_of": duplicate_of, "barcodes": list(barcodes)}


def decide(frames, **options):
    return decide_pos(PosOptions(**options), frames)


def test_pos_defaults_are_independent_and_all_supported_formats_are_accepted():
    first, second = PosOptions(), PosOptions()
    assert first.allowed_formats == ["ean13", "upca", "code128", "qr"]
    assert first.confirmation_frames == 2
    first.allowed_formats.append("aztec")
    assert second.allowed_formats == ["ean13", "upca", "code128", "qr"]
    assert PosOptions(allowed_formats=list(POS_FORMATS)).allowed_formats == list(POS_FORMATS)


@pytest.mark.parametrize("options", [
    {"allowed_formats": []},
    {"allowed_formats": ["qr", "qr"]},
    {"allowed_formats": ["unknown"]},
    {"allowed_formats": ["QRCode"]},
    {"allowed_formats": "qr"},
    {"allowed_formats": ("qr",)},
    {"allowed_formats": list(POS_FORMATS) + ["qr"]},
    {"confirmation_frames": 0}, {"confirmation_frames": 4},
    {"confirmation_frames": True}, {"confirmation_frames": "2"},
    {"confirmation_frames": 2.0},
    {"roi": {}}, {"catalog": []}, {"scan_id": "optional-but-unsupported"},
])
def test_options_reject_unknown_coerced_duplicate_or_unbounded_values(options):
    with pytest.raises(ValidationError):
        PosOptions(**options)


def test_one_frame_requires_rescan_unless_confirmation_is_explicitly_disabled():
    frames = [frame(0, barcode())]
    waiting = decide(frames)
    assert (waiting.status, waiting.reason, waiting.barcode) == ("rescan", "insufficient_confirmation", None)
    assert waiting.candidates[0].frame_indices == [0]
    confirmed = decide(frames, confirmation_frames=1)
    assert (confirmed.status, confirmed.reason) == ("confirmed", "single_match")
    assert confirmed.barcode.text == "BOX-1042"
    assert confirmed.confirmation.model_dump() == {"required_frames": 1, "distinct_frames": 1, "matched_frames": 1}


def test_two_distinct_frames_confirm_and_three_can_be_required():
    frames = [frame(0, barcode()), frame(1, barcode())]
    confirmed = decide(frames)
    assert (confirmed.status, confirmed.reason) == ("confirmed", "frame_agreement")
    assert confirmed.barcode.frame_indices == [0, 1]
    assert decide(frames, confirmation_frames=3).status == "rescan"
    frames.append(frame(2, barcode()))
    assert decide(frames, confirmation_frames=3).status == "confirmed"


def test_blank_frames_count_as_distinct_images_but_do_not_break_or_confirm_agreement():
    result = decide([frame(0), frame(1, barcode()), frame(2), frame(3, barcode()), frame(4)])
    assert result.status == "confirmed"
    assert result.barcode.frame_indices == [1, 3]
    assert result.confirmation.model_dump() == {"required_frames": 2, "distinct_frames": 5, "matched_frames": 2}


def test_duplicate_uploads_do_not_inflate_confirmation_but_remain_in_details():
    frames = [frame(0, barcode()), frame(1, barcode(), duplicate_of=0), frame(2, barcode(), duplicate_of=0)]
    result = decide(frames)
    assert result.status == "rescan"
    assert result.confirmation.model_dump() == {"required_frames": 2, "distinct_frames": 1, "matched_frames": 1}
    assert result.candidates[0].frame_indices == [0]
    assert result.model_dump()["frames"] == frames
    frames.append(frame(3, barcode()))
    result = decide(frames)
    assert result.status == "confirmed"
    assert result.barcode.frame_indices == [0, 3]


def test_repeated_identity_at_multiple_locations_counts_once_per_frame():
    first = frame(0, barcode(x=1), barcode(x=80), barcode(x=1))
    result = decide([first])
    assert result.status == "rescan"
    assert len(result.candidates) == 1 and result.candidates[0].frame_indices == [0]
    result = decide([first, frame(1, barcode(x=50), barcode(x=90))])
    assert result.status == "confirmed"
    assert result.barcode.frame_indices == [0, 1]
    assert len(result.frames[0].barcodes) == 3, "Original locations remain in frame diagnostics"


@pytest.mark.parametrize("conflict_first", [False, True])
@pytest.mark.parametrize("required", [1, 2])
def test_conflict_anywhere_in_burst_overrides_a_candidate_that_reaches_threshold(conflict_first, required):
    values = [barcode(), barcode(), barcode("OTHER-BOX")]
    if conflict_first:
        values.reverse()
    result = decide([frame(index, value) for index, value in enumerate(values)], confirmation_frames=required)
    assert (result.status, result.reason, result.barcode) == ("ambiguous", "conflicting_values", None)
    assert len(result.candidates) == 2
    assert result.confirmation.matched_frames == 2
    assert result.candidates[0].text == values[0]["text"], "Candidate order is deterministic by first observation"


def test_two_values_in_one_frame_are_ambiguous_even_without_confirmation():
    result = decide([frame(0, barcode(), barcode("SECOND"))], confirmation_frames=1)
    assert result.status == "ambiguous" and result.barcode is None
    assert [candidate.frame_indices for candidate in result.candidates] == [[0], [0]]


def test_equal_display_text_cannot_merge_different_raw_payloads():
    result = decide([frame(0, barcode("same", raw=b"\x01")), frame(1, barcode("same", raw=b"\x02"))])
    assert result.status == "ambiguous"
    assert {candidate.bytes_base64 for candidate in result.candidates} == {"AQ==", "Ag=="}


def test_same_raw_payload_and_format_cannot_confirm_conflicting_decoded_text():
    result = decide([frame(0, barcode(" first rendering ", raw=b"\x00\xff")),
                     frame(1, barcode("another rendering", raw=b"\x00\xff"))])
    assert (result.status, result.reason, result.barcode) == ("ambiguous", "conflicting_values", None)
    assert [candidate.text for candidate in result.candidates] == [" first rendering ", "another rendering"]
    assert [candidate.bytes_base64 for candidate in result.candidates] == ["AP8=", "AP8="]
    assert [candidate.frame_indices for candidate in result.candidates] == [[0], [1]]
    assert result.confirmation.matched_frames == 1


def test_whitespace_in_decoded_text_is_part_of_confirmation_identity():
    result = decide([frame(0, barcode("ITEM", raw=b"same")),
                     frame(1, barcode(" ITEM ", raw=b"same"))])
    assert result.status == "ambiguous" and result.barcode is None
    assert [candidate.text for candidate in result.candidates] == ["ITEM", " ITEM "]


def test_same_raw_payload_in_two_formats_remains_ambiguous():
    result = decide([frame(0, barcode("same", format_="qr")), frame(1, barcode("same", format_="code128"))])
    assert result.status == "ambiguous" and len(result.candidates) == 2


def test_common_format_spellings_are_canonicalized_without_merging_retail_formats():
    result = decide([frame(0, barcode(format_="QR Code")), frame(1, barcode(format_="qr"))])
    assert result.status == "confirmed" and result.barcode.format == "qr"
    assert result.frames[0].barcodes[0].format == "QR Code"
    result = decide([frame(0, barcode("012345678905", format_="UPC-A")),
                     frame(1, barcode("012345678905", format_="EAN-13"))])
    assert result.status == "ambiguous"


def test_disallowed_formats_do_not_become_candidates_or_conflicts():
    frames = [frame(0, barcode(), barcode("QR OTHER", format_="qr")), frame(1, barcode())]
    result = decide(frames, allowed_formats=["code128"])
    assert result.status == "confirmed" and len(result.candidates) == 1
    assert result.allowed_formats == ["code128"]
    assert len(result.frames[0].barcodes) == 2
    result = decide([frame(0, barcode(format_="aztec"))])
    assert (result.status, result.reason) == ("rescan", "no_code")


def test_no_codes_reports_no_code_and_zero_matched_frames():
    result = decide([frame(0), frame(1), frame(2, duplicate_of=0)])
    assert (result.status, result.reason, result.barcode) == ("rescan", "no_code", None)
    assert result.candidates == []
    assert result.confirmation.model_dump() == {"required_frames": 2, "distinct_frames": 2, "matched_frames": 0}


def test_a_hypothetical_conflicting_duplicate_remains_ambiguous_without_extra_evidence():
    result = decide([frame(0, barcode()), frame(1, barcode("OTHER"), duplicate_of=0)], confirmation_frames=1)
    assert result.status == "ambiguous" and result.barcode is None
    assert [candidate.frame_indices for candidate in result.candidates] == [[0], []]
    assert result.confirmation.distinct_frames == result.confirmation.matched_frames == 1


def test_decisions_do_not_mutate_input_or_carry_evidence_to_another_request():
    options = PosOptions()
    frames = [frame(0, barcode())]
    original = deepcopy(frames)
    first = decide_pos(options, frames)
    second = decide_pos(options, frames)
    assert first.status == second.status == "rescan"
    assert first.model_dump() == second.model_dump()
    assert frames == original
    first.allowed_formats.append("aztec")
    assert options.allowed_formats == ["ean13", "upca", "code128", "qr"]


@pytest.mark.parametrize("frames", [
    [], [frame(index) for index in range(6)],
    [frame(0), frame(0)], [frame(0, duplicate_of=0)],
    [frame(0), frame(1, duplicate_of=2)],
])
def test_malformed_or_unbounded_internal_bursts_are_rejected(frames):
    with pytest.raises(ValueError):
        decide(frames)
