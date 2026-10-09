#!/usr/bin/env python3
"""Prove selected regression assertions detect faults in an isolated source copy."""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = 'Jellyfin.Plugin.JellyfinEnhanced/'
CASES = [
    dict(name='explicit-user-authorization', layer='backend', file=PLUGIN+'Helpers/UserHelper.cs',
         before='if (isAdministrator || (!currentUserId.IsNullOrEmpty() && userId.Equals(currentUserId)))',
         after='if (true)', test='ExplicitUserSelectionRequiresSelfOrAdministrator', assertion='Assert.Null'),
    dict(name='blocked-tags-precedence', layer='backend', file=PLUGIN+'Helpers/Jellyseerr/ParentalTagDecision.cs',
         before='return false; // blocked wins, even over an allowed match',
         after='return true; // MUTATION: allow a blocked title',
         test='TagsUseWholeValuesBlockedWinsAndGenresCannotGrantAccess', assertion='Assert.Equal'),
    dict(name='cookie-negative-cache', layer='backend', file=PLUGIN+'Services/Identity/RequestIdentityService.cs',
         before='if (!recentMiss)', after='if (true)',
         test='RepeatedForgedCookieDoesNotCauseSessionScanStorm', assertion='Expected invocation'),
    dict(name='stale-user-hidden-response', layer='frontend', file=PLUGIN+'js/enhanced/hiddencontent/hidden-content-data.js',
         before='if (JE.session && !JE.session.isCurrent(requestEpoch)) return false;',
         after='/* MUTATION: accept stale user response */',
         test='old-user hidden-content refresh cannot overwrite incoming preferences', assertion='ERR_ASSERTION'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['jf10', 'jf12'], default='jf12')
    parser.add_argument('--layer', choices=['all', 'backend', 'frontend'], default='all')
    parser.add_argument('--cases', type=Path, help='Local JSON case list, e.g. tests/history/backend-mutations.json')
    parser.add_argument('--artifacts', type=Path, default=ROOT/'artifacts/mutations')
    args = parser.parse_args()
    definitions = json.loads(args.cases.read_text()) if args.cases else CASES
    if not isinstance(definitions, list) or not definitions:
        parser.error('Mutation cases must be a nonempty JSON list.')
    names = set()
    for case in definitions:
        required = ('name', 'layer', 'file', 'before', 'after', 'test', 'assertion')
        if not isinstance(case, dict) or any(not isinstance(case.get(key), str) for key in required):
            parser.error('Each mutation must contain string fields: '+', '.join(required))
        if not re.fullmatch(r'[a-z0-9-]+', case['name']) or case['name'] in names:
            parser.error('Mutation names must be unique lowercase slugs.')
        names.add(case['name'])
        if case['layer'] not in ('backend', 'frontend') or not case['before'] or not case['test'] or not case['assertion']:
            parser.error('Mutation layer, anchor, selected test and failure signature are required.')
        for key in ('file', 'test_file'):
            if key in case:
                value = case[key]
                if (not isinstance(value, str) or Path(value).is_absolute() or '..' in Path(value).parts
                        or not (ROOT/value).resolve().is_relative_to(ROOT)):
                    parser.error('Mutation paths must be relative and stay inside the checkout.')
    cases = [c for c in definitions if args.layer in ('all', c['layer'])]
    if not cases:
        parser.error('No mutation cases selected for this layer.')
    for tool in {'dotnet' if c['layer'] == 'backend' else 'node' for c in cases}:
        if not shutil.which(tool):
            parser.error(f'Missing {tool}; see tests/docs/mutations.md')
    if any(c['layer'] == 'frontend' for c in cases) and not (ROOT/'node_modules').is_dir():
        parser.error('Run npm ci before frontend mutation verification.')
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    report = []
    # Copy current local files, including uncommitted tests. Never edit the shared tree.
    with tempfile.TemporaryDirectory(prefix='je-mutations-') as temp:
        work = Path(temp)/'source'
        shutil.copytree(ROOT, work, ignore=shutil.ignore_patterns('.git', 'node_modules', 'artifacts', 'bin', 'obj', '__pycache__', 'test-results', 'playwright-report'))
        if (ROOT/'node_modules').exists():
            (work/'node_modules').symlink_to(ROOT/'node_modules', target_is_directory=True)

        def run(case, stage):
            log = artifacts/f"{case['name']}-{stage}.log"
            trx = artifacts/f"{case['name']}-{stage}.trx"
            trx.unlink(missing_ok=True)
            if case['layer'] == 'backend':
                command = ['dotnet', 'test', 'tests/backend/JE.Tests.csproj', '-c', 'Release',
                           '-p:JellyfinTarget='+args.target, '--filter', 'FullyQualifiedName~'+case['test'],
                           '--results-directory', str(artifacts), '--logger', 'trx;LogFileName='+trx.name]
            else:
                command = ['node', '--test', '--test-reporter=tap', '--test-timeout=120000', '--test-name-pattern='+case['test'], case.get('test_file', 'tests/frontend/features/features-hidden.test.mjs')]
            started = time.monotonic()
            env = dict(os.environ)
            env.pop('JE_COVERAGE_DIR', None)
            if case['layer'] == 'frontend':
                # Same pinned zone/locale and timeout as tests/frontend/run.mjs.
                env.update(TZ='UTC', LANG='en_US.UTF-8', LC_ALL='en_US.UTF-8')
            with log.open('w') as output:
                process = subprocess.run(command, cwd=work, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=600)
            result = dict(stage=stage, command=command, exit_code=process.returncode, seconds=round(time.monotonic()-started, 2), log=str(log))
            if case['layer'] == 'backend':
                rows = ET.parse(trx).getroot().findall('.//{*}UnitTestResult') if trx.exists() else []
                selected = [row for row in rows if case['test'] in row.attrib.get('testName', '')]
                failed = [row for row in selected if row.attrib.get('outcome') == 'Failed']
                result['test_count'] = len(selected)
                result['assertion_detected'] = any(case['assertion'] in ''.join(row.itertext()) for row in failed)
                result['tests_passed'] = bool(selected) and all(row.attrib.get('outcome') == 'Passed' for row in selected)
            else:
                content = log.read_text()
                result['assertion_detected'] = bool(re.search(r'^not ok \d+ - '+re.escape(case['test'])+r'$', content, re.MULTILINE)) and case['assertion'] in content
                result['tests_passed'] = bool(re.search(r'^ok \d+ - '+re.escape(case['test'])+r'$', content, re.MULTILINE)) and '# fail 0' in content
            print(f"{case['name']} {stage}: exit {process.returncode}", flush=True)
            return result

        for case in cases:
            item = dict(name=case['name'], target=args.target if case['layer']=='backend' else 'node', source=case['file'], test=case['test'], status='failed', runs=[])
            for key in ('sources', 'evidence'):
                if key in case:
                    item[key] = case[key]
            report.append(item)
            source = work/case['file']
            if not source.resolve().is_relative_to(work):
                raise RuntimeError('Mutation source escaped the disposable checkout.')
            test_file = work/case.get('test_file', 'tests/frontend/features/features-hidden.test.mjs')
            if not test_file.resolve().is_relative_to(work):
                raise RuntimeError('Test file escaped the disposable checkout.')
            original = source.read_text()
            try:
                if original.count(case['before']) != 1:
                    raise RuntimeError('Mutation anchor must match exactly once; update this case for the current production code.')
                baseline = run(case, 'baseline')
                item['runs'].append(baseline)
                if baseline['exit_code'] != 0 or not baseline['tests_passed']:
                    raise RuntimeError('Baseline did not pass the selected test; mutation was not applied.')
                source.write_text(original.replace(case['before'], case['after'], 1))
                mutant = run(case, 'mutant')
                item['runs'].append(mutant)
                source.write_text(original)
                restored = run(case, 'restored')
                item['runs'].append(restored)
                if mutant['exit_code'] == 0 or not mutant['assertion_detected']:
                    raise RuntimeError('Fault survived or failed without the expected test assertion (build failures do not count).')
                if restored['exit_code'] != 0 or not restored['tests_passed']:
                    raise RuntimeError('Restored production source did not pass.')
                item['status'] = 'killed-and-restored'
            except Exception as error:
                item['error'] = str(error)
            finally:
                source.write_text(original)
                (artifacts/'summary.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps([{k:v for k,v in item.items() if k!='runs'} for item in report], indent=2))
    return 0 if all(item['status']=='killed-and-restored' for item in report) else 1


if __name__ == '__main__':
    raise SystemExit(main())
