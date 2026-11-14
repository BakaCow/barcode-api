import importlib.util
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location('condition_summary', Path(__file__).parents[1] / 'tools/summarize-condition-results.py')
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


def report():
    return {'corpusSha256': 'same-source-images', 'cases': [
        {'name': 'ean13/a/motion-blur-1', 'expectedCount': 1, 'exact': True, 'unexpected': []},
        {'name': 'ean13/a/motion-blur-2', 'expectedCount': 1, 'exact': False, 'unexpected': ['wrong']},
        {'name': 'qr/b/small-in-frame-2', 'expectedCount': 1, 'exact': False, 'unexpected': [], 'missing': ['truth']},
        {'name': 'negative/c/motion-blur-2', 'expectedCount': 0, 'exact': True, 'unexpected': []},
    ]}


def test_condition_summary_retains_wrong_extra_and_missing_cases_in_denominator():
    result = summary.summarize(report())
    assert result['allPositives'] == {'positiveImages': 3, 'exactPositiveReads': 1,
                                     'failedPositiveImages': 2, 'unexpectedResults': 1,
                                     'imagesWithUnexpected': 1, 'errors': 0}
    assert result['targetGroups']['motion-blur-all']['positiveImages'] == 2
    assert result['targetGroups']['motion-blur-severe']['unexpectedResults'] == 1
    assert result['targetGroups']['motion-and-small-severe']['failedPositiveImages'] == 2
    assert result['targetGroupsByFormat']['qr']['small-in-frame-all']['positiveImages'] == 1


def test_condition_summary_rejects_success_with_wrong_extra():
    value = report()
    value['cases'][1]['exact'] = True
    with pytest.raises(ValueError, match='cannot be exact'):
        summary.summarize(value)


def test_condition_summary_rejects_duplicate_cases():
    value = report()
    value['cases'].append(value['cases'][0])
    with pytest.raises(ValueError, match='unique'):
        summary.summarize(value)


def test_paired_conditions_require_same_corpus_and_full_case_denominators():
    before, after = report(), report()
    assert summary.compare(before, after)['before'] == summary.summarize(before)
    after['corpusSha256'] = 'different-source-images'
    with pytest.raises(ValueError, match='same recorded corpus hash'):
        summary.compare(before, after)
    after = report()
    after['cases'].pop()
    with pytest.raises(ValueError, match='same cases'):
        summary.compare(before, after)
