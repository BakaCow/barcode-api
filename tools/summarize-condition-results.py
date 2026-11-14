"""Summarize fixed-image benchmark conditions without changing scoring truth."""
import argparse
import json
from pathlib import Path


TARGET_GROUPS = {
    'motion-blur-all': {'motion-blur-1', 'motion-blur-2'},
    'motion-blur-severe': {'motion-blur-2'},
    'small-in-frame-all': {'small-in-frame-1', 'small-in-frame-2'},
    'small-in-frame-severe': {'small-in-frame-2'},
    'motion-and-small-all': {'motion-blur-1', 'motion-blur-2', 'small-in-frame-1', 'small-in-frame-2'},
    'motion-and-small-severe': {'motion-blur-2', 'small-in-frame-2'},
}


def validated_cases(report):
    cases = report.get('cases')
    if not isinstance(cases, list) or not cases:
        raise ValueError('A nonempty benchmark cases array is required.')
    seen = set()
    for case in cases:
        name = case.get('name')
        if not isinstance(name, str) or name in seen:
            raise ValueError('Case names must be unique strings.')
        seen.add(name)
        if type(case.get('expectedCount')) is not int or case['expectedCount'] < 0:
            raise ValueError('Each case needs a nonnegative expectedCount.')
        if type(case.get('exact')) is not bool or not isinstance(case.get('unexpected'), list):
            raise ValueError('Each case needs an exact boolean and unexpected array.')
        if case['exact'] and (case['unexpected'] or case.get('error') or case.get('missing')):
            raise ValueError('A case with missing/wrong results or an error cannot be exact.')
    return cases


def counts(cases):
    return {
        'positiveImages': len(cases),
        'exactPositiveReads': sum(case['exact'] for case in cases),
        'failedPositiveImages': sum(not case['exact'] for case in cases),
        'unexpectedResults': sum(len(case['unexpected']) for case in cases),
        'imagesWithUnexpected': sum(bool(case['unexpected']) for case in cases),
        'errors': sum(bool(case.get('error')) for case in cases),
    }


def summarize(report):
    positives = [case for case in validated_cases(report) if case['expectedCount']]
    condition = lambda case: case['name'].rsplit('/', 1)[-1]
    return {
        'corpusSha256': report.get('corpusSha256'),
        'allPositives': counts(positives),
        'byCondition': {name: counts([case for case in positives if condition(case) == name])
                        for name in sorted({condition(case) for case in positives})},
        'targetGroups': {name: counts([case for case in positives if condition(case) in conditions])
                         for name, conditions in TARGET_GROUPS.items()},
        'targetGroupsByFormat': {
            format_name: {name: counts([case for case in positives
                                       if case['name'].startswith(format_name + '/') and condition(case) in conditions])
                          for name, conditions in TARGET_GROUPS.items()}
            for format_name in sorted({case['name'].split('/', 1)[0] for case in positives})
        },
    }


def compare(before, after):
    old = validated_cases(before)
    new = validated_cases(after)
    if not before.get('corpusSha256') or before['corpusSha256'] != after.get('corpusSha256'):
        raise ValueError('Paired reports must use the same recorded corpus hash.')
    old_truth = {case['name']: case['expectedCount'] for case in old}
    new_truth = {case['name']: case['expectedCount'] for case in new}
    if old_truth != new_truth:
        raise ValueError('Paired reports must contain the same cases and expected counts.')
    return {'before': summarize(before), 'after': summarize(after),
            'note': 'All/severe groups overlap; do not add their denominators. Fixed images do not measure live camera sessions.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    before = json.loads(args.before.read_text(encoding='utf-8'))
    result = compare(before, json.loads(args.after.read_text(encoding='utf-8'))) if args.after else summarize(before)
    encoded = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding='utf-8', newline='\n')
    else:
        print(encoded, end='')


if __name__ == '__main__':
    main()
