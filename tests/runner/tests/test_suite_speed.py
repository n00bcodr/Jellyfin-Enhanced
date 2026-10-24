"""Behavioral safeguards for suite optimizations; these never change suite scope."""
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[3]



import copy
from collections import Counter
import json
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0, str(ROOT / 'tests/runner'))
from coverage_union import counters, summary, union_reports
from partitions import partition, trx_cases, validate_manifest, validate_results


class PartitionTests(unittest.TestCase):
    def cases(self):
        return [dict(id=str(i), name=f'C{i}.Run', method=f'C{i}.Run',
                     collection='global' if i < 2 else f'C{i}', serial=i < 2) for i in range(6)]

    def test_complete_disjoint_and_serial_collection_kept_together(self):
        manifest = partition(self.cases(), 2)
        self.assertEqual(Counter(str(i) for i in range(6)), Counter(c for s in manifest['shards'] for c in s['cases']))
        owner = [s['id'] for s in manifest['shards'] for c in s['cases'] if c in ('0', '1')]
        self.assertEqual(1, len(set(owner)))
        self.assertEqual([3, 3], sorted(len(s['cases']) for s in manifest['shards']))

    def test_missing_duplicate_empty_and_split_serial_partitions_rejected(self):
        original = partition(self.cases(), 2)
        for mutation in ('missing', 'duplicate', 'empty', 'serial', 'duplicate-shard'):
            value = copy.deepcopy(original)
            a, b = value['shards']
            if mutation == 'missing': a['cases'].pop()
            if mutation == 'duplicate': b['cases'].append(a['cases'][0])
            if mutation == 'empty': b['cases'] = []
            if mutation == 'duplicate-shard': b['id'] = a['id']
            if mutation == 'serial':
                owner = next(s for s in value['shards'] if '0' in s['cases'])
                other = next(s for s in value['shards'] if s is not owner)
                owner['cases'].remove('0'); other['cases'].append('0')
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): validate_manifest(value)

    def test_weighted_partitions_use_measured_durations(self):
        cases = self.cases()
        cases[0]['serial'] = cases[1]['serial'] = False
        result = partition(cases, 2, {c['name']: 10 if i == 0 else 2 for i, c in enumerate(cases)})
        self.assertEqual([10, 10], sorted(s['estimated_seconds'] for s in result['shards']))

    def test_duration_balance_accounts_for_serial_and_parallel_collections(self):
        cases = self.cases()
        durations = {case['name']: 5.0 if index < 2 else 4.0 for index, case in enumerate(cases)}
        for shared_collection, expected_wall in [(False, 4.0), (True, 8.0)]:
            rows = copy.deepcopy(cases)
            if shared_collection:
                rows[2]['collection'] = rows[3]['collection'] = 'shared fixture'
            result = partition(rows, 2, durations)
            owner = next(shard for shard in result['shards'] if '0' in shard['cases'])
            other = next(shard for shard in result['shards'] if shard is not owner)
            # The parallel process has spare collection capacity. Giving its
            # classes to the disabled collection's process extends the critical path.
            self.assertEqual(['0', '1'], owner['cases'])
            self.assertEqual(10.0, owner['estimated_wall_seconds'])
            self.assertEqual(expected_wall, other['estimated_wall_seconds'])
            self.assertEqual(Counter(case['id'] for case in cases), Counter(case for shard in result['shards'] for case in shard['cases']))

    def test_failed_missing_and_wrong_case_results_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = partition(self.cases(), 2)
            result['identity'] = 'f' * 64
            for shard in result['shards']:
                shard['exit_code'] = 0
                shard['identity'] = 'f' * 64
                directory = Path(tmp) / shard['id']; directory.mkdir()
                items = ''.join(f'<UnitTestResult testName="C{i}.Run" outcome="Passed"/>' for i in shard['cases'])
                (directory / 'cases.trx').write_text('<TestRun><Results>' + items + '</Results></TestRun>')
            validate_results(result, tmp)
            result['shards'][0]['exit_code'] = 1
            with self.assertRaises(ValueError): validate_results(result, tmp)
            result['shards'][0]['exit_code'] = 0
            trx = Path(tmp) / result['shards'][0]['id'] / 'cases.trx'
            original = trx.read_text()
            trx.write_text(original.replace('C0.Run', 'Unexpected.Run'))
            # Whichever shard owns C0, explicitly corrupt a present case.
            trx.write_text(original.replace('testName="', 'testName="Unexpected.', 1))
            with self.assertRaises(ValueError): validate_results(result, tmp)
            trx.unlink()
            with self.assertRaises(ValueError): validate_results(result, tmp)


class CoverageUnionTests(unittest.TestCase):
    def report(self, path, *, root='/machine/a', hits=(1, 0), extra=False):
        branches = [dict(Line=1, Offset=0, EndOffset=i + 1, Path=i, Ordinal=i, Hits=h) for i, h in enumerate(hits)]
        method = {'Lines': {'1': 1, '2': 0}, 'Branches': branches}
        if extra: method['Lines']['3'] = 0
        path.write_text(json.dumps({'Jellyfin.Plugin.JellyfinEnhanced.dll': {
            root + '/Jellyfin.Plugin.JellyfinEnhanced/Example.cs': {'Example': {'Run()': method}}}}))
        return path

    def test_union_counts_distinct_hits_and_normalizes_machine_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = self.report(Path(tmp) / 'a.json')
            b = self.report(Path(tmp) / 'b.json', root='/other/machine', hits=(0, 1))
            totals = summary(union_reports([a, b]))
            self.assertEqual({'line': {'covered': 1, 'total': 2}, 'branch': {'covered': 2, 'total': 2}}, totals)
            self.assertEqual(summary(counters(a)), summary(union_reports([a, a])))

    def test_denominator_mismatch_and_empty_plugin_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = self.report(Path(tmp) / 'a.json')
            b = self.report(Path(tmp) / 'b.json', extra=True)
            with self.assertRaises(ValueError): union_reports([a, b])
            b.write_text('{"Jellyfin.Plugin.JellyfinEnhanced.dll": {}}')
            with self.assertRaises(ValueError): union_reports([b])
            with self.assertRaises(ValueError): union_reports([])

    def test_real_validator_accepts_union_and_rejects_failed_partition(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            manifest = partition(PartitionTests().cases(), 2)
            manifest['identity'] = 'f' * 64
            for index, shard in enumerate(manifest['shards']):
                shard['exit_code'] = 0
                shard['identity'] = 'f' * 64
                directory = folder / shard['id']; directory.mkdir()
                self.report(directory / 'coverage.json', hits=(1, 0) if index == 0 else (0, 1))
                items = ''.join(f'<UnitTestResult testName="C{i}.Run" outcome="Passed"/>' for i in shard['cases'])
                (directory / 'cases.trx').write_text('<TestRun><Results>' + items + '</Results></TestRun>')
            path = folder / 'partitions.json'
            path.write_text(json.dumps(manifest))
            command = [sys.executable, str(ROOT / 'tests/runner/coverage.py'), str(folder), '--manifest', str(path)]
            actual = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(0, actual.returncode, actual.stderr)
            measured = json.loads((folder / 'coverage-summary.json').read_text())
            self.assertEqual({'line': 50.0, 'branch': 100.0}, measured['measured_percent'])
            manifest['shards'][0]['exit_code'] = 1
            path.write_text(json.dumps(manifest))
            self.assertNotEqual(0, subprocess.run(command, capture_output=True).returncode)


class BuildIdentityTests(unittest.TestCase):
    def test_output_fingerprint_frames_file_names_and_contents(self):
        import backend
        with tempfile.TemporaryDirectory() as tmp:
            left, right = Path(tmp) / 'left', Path(tmp) / 'right'
            left.mkdir()
            right.mkdir()
            (left / 'a').write_bytes(b'bc')
            (right / 'ab').write_bytes(b'c')
            self.assertNotEqual(backend.fingerprint(left), backend.fingerprint(right))

    def test_custom_output_root_is_ignored_but_a_source_results_directory_is_not(self):
        import backend
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'Jellyfin.Plugin.JellyfinEnhanced/results/Input.cs'
            source.parent.mkdir(parents=True)
            source.write_text('class InputA {}')
            pins = root / 'tests/backend/Support/jellyfin-api.json'
            pins.parent.mkdir(parents=True)
            pins.write_text(json.dumps({'jf12': {'version': '12.2', 'image': 'image@sha256:' + 'a' * 64}}))
            cache = root / 'api-cache/12.2-aaaaaaaaaaaa'
            cache.mkdir(parents=True)
            (cache / 'host.dll').write_bytes(b'host')
            build = root / 'custom-output/build/jf12/snapshot'
            build.parent.mkdir(parents=True)
            builds = []
            def execute(command, log):
                builds.append(command)
                build.mkdir(parents=True)
                (build / 'plugin.dll').write_bytes(b'output')
                Path(log).write_text('build complete')
                return {'exit_code': 0, 'seconds': 0.1}
            with patch.object(backend, 'msbuild_inputs', return_value=[]), patch.object(backend, 'ROOT', root), patch.dict(os.environ, {'JE_JELLYFIN_API_CACHE': str(cache.parent)}), \
                 patch.object(backend.subprocess, 'check_output', return_value=b'sdk'), patch.object(backend, 'run', side_effect=execute):
                self.assertFalse(backend.prepare_build('jf12', build, True)['reused'])
                self.assertTrue(backend.prepare_build('jf12', build, True)['reused'])
                source.write_text('class InputB {}')
                self.assertFalse(backend.prepare_build('jf12', build, True)['reused'])
                self.assertEqual(2, len(builds))

    def test_source_resources_sdk_properties_target_and_outputs_affect_identity(self):
        import backend
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'tests/backend/Support').mkdir(parents=True)
            pin = {'version': '12.2', 'image': 'image@sha256:' + 'a' * 64}
            (root / 'tests/backend/Support/jellyfin-api.json').write_text(json.dumps({'jf12': pin, 'jf10': pin}))
            source = root / 'source.cs'; source.write_text('class A {}')
            resource = root / 'resource.json'; resource.write_text('{}')
            with patch.object(backend, 'msbuild_inputs', return_value=[]), patch.object(backend, 'ROOT', root), patch.object(backend.subprocess, 'check_output', return_value=b'sdk1'):
                first = backend.build_identity('jf12', ['Release'])
                self.assertEqual(first, backend.build_identity('jf12', ['Release']))
                self.assertNotEqual(first, backend.build_identity('jf10', ['Release']))
                self.assertNotEqual(first, backend.build_identity('jf12', ['Debug']))
                resource.write_text('{"changed":true}')
                self.assertNotEqual(first, backend.build_identity('jf12', ['Release']))
                source.write_text('class B {}')
                second = backend.build_identity('jf12', ['Release'])
                with patch.object(backend.subprocess, 'check_output', return_value=b'sdk2'):
                    self.assertNotEqual(second, backend.build_identity('jf12', ['Release']))
            before = backend.fingerprint(root)
            source.write_text('class C {}')
            self.assertNotEqual(before, backend.fingerprint(root))


class PreflightTests(unittest.TestCase):
    def test_missing_runtime_and_invalid_worker_budget_fail_before_running_tests(self):
        from preflight import check
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'package.json').write_text('{"devDependencies": {}}')
            (root / 'package-lock.json').write_text('{"packages": {"": {"devDependencies": {}}}}')
            with patch('preflight.subprocess.check_output', return_value='v26.2.0'):
                with self.assertRaisesRegex(ValueError, 'worker budget'):
                    check(root, ['frontend'], ['jf12'], {'JE_NODE_FILE_CONCURRENCY': '9', 'JE_NODE_NESTED_CONCURRENCY': '8'})
            with patch('preflight.subprocess.check_output', side_effect=['Microsoft.NETCore.App 9.0.0', '10.0.401']):
                with self.assertRaisesRegex(ValueError, 'Missing Microsoft.NETCore.App 10'):
                    check(root, ['backend'], ['jf12'], {})

    def test_measured_worker_budget_is_accepted_and_excess_shards_are_rejected(self):
        from preflight import check
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'package.json').write_text('{"devDependencies": {}}')
            (root / 'package-lock.json').write_text('{"packages": {"": {"devDependencies": {}}}}')
            with patch('preflight.subprocess.check_output', return_value='v26.2.0'):
                check(root, ['frontend'], ['jf12'], {})
                check(root, ['frontend'], ['jf12'], {'JE_NODE_FILE_CONCURRENCY': '8', 'JE_FRONTEND_SHARDS': '2', 'JE_NODE_NESTED_CONCURRENCY': '8'})
                with self.assertRaisesRegex(ValueError, 'worker budget'):
                    check(root, ['frontend'], ['jf12'], {'JE_NODE_FILE_CONCURRENCY': '8', 'JE_FRONTEND_SHARDS': '5'})

    def test_old_node_and_lock_drift_are_explicit_prerequisite_failures(self):
        from preflight import check
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'package.json').write_text('{"devDependencies": {"x": "1"}}')
            (root / 'package-lock.json').write_text('{"packages": {"": {"devDependencies": {}}}}')
            with patch('preflight.subprocess.check_output', return_value='v20.1.0'):
                with self.assertRaisesRegex(ValueError, 'Node >=22.12.0.*lock'):
                    check(root, ['frontend'], ['jf12'], {})


class CoverageDenominatorTests(unittest.TestCase):
    def test_frontend_duplicate_locations_still_count_as_distinct_instrumentation_points(self):
        from compare_evidence import compare_frontend
        with tempfile.TemporaryDirectory() as tmp:
            before, after = Path(tmp) / 'before.json', Path(tmp) / 'after.json'
            def report(count, hit=0):
                return {'/source/Jellyfin.Plugin.JellyfinEnhanced/js/probe.js': {
                    'statementMap': {str(i): {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 1}} for i in range(count)},
                    's': {str(i): hit for i in range(count)}, 'fnMap': {}, 'f': {}, 'branchMap': {}, 'b': {}}}
            before.write_text(json.dumps(report(1)))
            after.write_text(json.dumps(report(2)))
            self.assertFalse(compare_frontend(before, after)['inventory_equal'])
            after.write_text(json.dumps(report(1, 1)))
            result = compare_frontend(before, after)
            self.assertTrue(result['inventory_equal'])
            self.assertEqual(1, len(result['differing_files']))

    def test_distinct_methods_on_one_source_line_remain_distinct_denominator_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'coverage.json'
            path.write_text(json.dumps({'Jellyfin.Plugin.JellyfinEnhanced.dll': {
                '/source/Jellyfin.Plugin.JellyfinEnhanced/Example.cs': {'Example': {
                    'One()': {'Lines': {'1': 1}, 'Branches': []},
                    'Two()': {'Lines': {'1': 0}, 'Branches': []}}}}}))
            self.assertEqual({'covered': 1, 'total': 2}, summary(counters(path))['line'])




class BuildReuseTests(unittest.TestCase):
    def test_reuse_requires_matching_inputs_and_every_output_hash(self):
        import backend
        with tempfile.TemporaryDirectory() as tmp:
            build = Path(tmp) / 'build/jf12/snapshot'
            build.parent.mkdir(parents=True)
            state = {'identity': 'a' * 64, 'builds': 0}
            def execute(command, log):
                state['builds'] += 1
                self.assertIn('-m:4', command)
                self.assertIn('-p:RestoreLockedMode=true', command)
                build.mkdir()
                (build / 'plugin.dll').write_text('fresh binary')
                return {'exit_code': 0, 'seconds': 1.0}
            with patch.object(backend, 'build_identity', side_effect=lambda *_: state['identity']), patch.object(backend, 'run', side_effect=execute):
                self.assertFalse(backend.prepare_build('jf12', build, True)['reused'])
                self.assertTrue(backend.prepare_build('jf12', build, True)['reused'])
                self.assertEqual(1, state['builds'])
                (build / 'plugin.dll').write_text('collector left instrumented/stale output')
                self.assertFalse(backend.prepare_build('jf12', build, True)['reused'])
                state['identity'] = 'b' * 64
                self.assertFalse(backend.prepare_build('jf12', build, True)['reused'])
                (build.parent / 'build-identity.json').write_text('corrupt receipt')
                self.assertFalse(backend.prepare_build('jf12', build, True)['reused'])
                self.assertFalse(backend.prepare_build('jf12', build, False)['reused'])
                self.assertEqual(5, state['builds'])


class RunnerPreflightTests(unittest.TestCase):
    def test_bad_worker_budget_exits_incomplete_before_frontend_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, 'JE_NODE_FILE_CONCURRENCY': '9', 'JE_NODE_NESTED_CONCURRENCY': '8'}
            result = subprocess.run([sys.executable, str(ROOT / 'tests/run.py'), 'frontend', '--artifacts', tmp],
                                    cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
            self.assertNotEqual(0, result.returncode)
            summary = json.loads((Path(tmp) / 'summary.json').read_text())
            self.assertEqual('incomplete', summary[-1]['status'])
            self.assertFalse((Path(tmp) / 'frontend.log').exists())


class GeneratedCoverageTests(unittest.TestCase):
    def test_generated_plugin_documents_retain_denominators_across_build_roots(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for index in range(2):
                path = Path(tmp) / f'{index}.json'
                path.write_text(json.dumps({'Jellyfin.Plugin.JellyfinEnhanced.dll': {
                    f'/build/{index}/obj/JellyfinEnhanced/release/net10.0/Generated.g.cs': {
                        'Generated': {'Run()': {'Lines': {'1': index}, 'Branches': []}}}}}))
                paths.append(path)
            self.assertEqual({'covered': 1, 'total': 1}, summary(union_reports(paths))['line'])


class SourceControlIdentityTests(unittest.TestCase):
    def test_staged_source_tracking_is_part_of_sdk_metadata_identity(self):
        import backend
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.git').write_text('gitdir: fixture')
            state = {'index': b'first staged source set'}
            def read(command, **kwargs):
                return SimpleNamespace(returncode=0, stdout=state['index'] if 'ls-files' in command else b'unchanged')
            with patch.object(backend, 'ROOT', root), patch.object(backend.shutil, 'which', return_value='/usr/bin/git'), \
                 patch.object(backend.subprocess, 'run', side_effect=read):
                before = backend.source_control_identity()
                state['index'] = b'changed staged source set'
                self.assertNotEqual(before, backend.source_control_identity())

    def test_revision_metadata_also_invalidates_identical_source_build_reuse(self):
        import backend
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(backend, 'ROOT', root):
                archive = backend.source_control_identity()
                self.assertIsNotNone(archive)
                (root / '.git').write_text('gitdir: fixture')
                with patch.object(backend.shutil, 'which', return_value=None):
                    self.assertIsNone(backend.source_control_identity())
                with patch.object(backend.shutil, 'which', return_value='/usr/bin/git'), patch.object(backend.subprocess, 'run') as run:
                    from types import SimpleNamespace
                    state = {'revision': b'first-head'}
                    def read(command, **kwargs):
                        return SimpleNamespace(returncode=0, stdout=state['revision'] if 'rev-parse' in command else b'constant')
                    run.side_effect = read
                    first = backend.source_control_identity()
                    state['revision'] = b'second-head'
                    self.assertNotEqual(first, backend.source_control_identity())


class DiscoveryIntegrationTests(unittest.TestCase):
    def test_real_xunit_discovery_keeps_serial_collections_and_rejects_deferred_rows(self):
        import re
        import shutil
        dotnet = shutil.which('dotnet')
        if not dotnet:
            self.skipTest('Backend discovery probe requires the .NET SDK')
        sdks = subprocess.check_output([dotnet, '--list-sdks'], text=True)
        matches = re.findall(r'^(10\.\d+\.\d+) \[([^\]]+)\]', sdks, re.M)
        if not matches:
            self.skipTest('Backend discovery probe requires SDK 10')
        version, sdk_parent = matches[-1]
        sdk_root = Path(sdk_parent)
        packs = sorted((sdk_root.parent / 'packs/Microsoft.NETCore.App.Ref').glob('10.*/ref/net10.0'))
        cache = Path(os.environ.get('NUGET_PACKAGES') or Path.home() / '.nuget/packages')
        xunit = [cache / p for p in ['xunit.abstractions/2.0.3/lib/netstandard2.0/xunit.abstractions.dll',
                 'xunit.extensibility.core/2.9.3/lib/netstandard1.1/xunit.core.dll',
                 'xunit.extensibility.execution/2.9.3/lib/netstandard1.1/xunit.execution.dotnet.dll']]
        analyzer = cache / 'xunit.analyzers/1.18.0/analyzers/dotnet/cs/xunit.analyzers.dll'
        if not packs or not analyzer.is_file() or not all(path.is_file() for path in xunit):
            self.skipTest('Backend discovery probe requires restored pinned xUnit assemblies and reference pack')
        runtimes = subprocess.check_output([dotnet, '--list-runtimes'], text=True)
        runtime = re.findall(r'^Microsoft.NETCore.App (10\.\d+\.\d+) ', runtimes, re.M)
        if not runtime:
            self.skipTest('Backend discovery probe requires runtime 10')
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for reference in xunit:
                shutil.copy2(reference, directory / reference.name)
            (directory / 'Probe.runtimeconfig.json').write_text(json.dumps({'runtimeOptions': {
                'tfm': 'net10.0', 'framework': {'name': 'Microsoft.NETCore.App', 'version': runtime[-1]}}}))
            usings = directory / 'Usings.cs'
            usings.write_text('global using System; global using System.IO; global using System.Linq; '
                              'global using System.Threading; global using System.Collections.Generic; global using Xunit;')
            references = list(packs[-1].glob('*.dll')) + xunit
            output = directory / 'Probe.dll'
            for deferred in (False, True):
                response = directory / 'compile.rsp'
                response.write_text('\n'.join(['-target:exe', '-nullable:enable', f'-out:"{output}"', f'-analyzer:"{analyzer}"'] +
                    (['-define:DEFERRED_DATA'] if deferred else []) + [f'-r:"{p}"' for p in references] +
                    [f'"{p}"' for p in [usings, ROOT / 'tests/backend/Support/SuiteManifest.cs',
                                       ROOT / 'tests/runner/fixtures/discovery-probe.cs']]))
                compiled = subprocess.run([dotnet, 'exec', str(sdk_root / version / 'Roslyn/bincore/csc.dll'),
                                           '-noconfig', '@' + str(response)], capture_output=True, text=True, timeout=60)
                self.assertEqual(0, compiled.returncode, compiled.stderr + compiled.stdout)
                cases = directory / ('rejected.json' if deferred else 'complete.json')
                discovered = subprocess.run([dotnet, str(output), str(cases)], capture_output=True, text=True, timeout=60)
                if deferred:
                    self.assertNotEqual(0, discovered.returncode)
                    self.assertIn('Deferred theory', discovered.stderr)
                    self.assertFalse(cases.exists())
                else:
                    self.assertEqual(0, discovered.returncode, discovered.stderr)
                    data = json.loads(cases.read_text())
                    self.assertEqual(5, len(data))
                    self.assertEqual(5, len({case['id'] for case in data}))
                    self.assertEqual(3, sum(case['serial'] for case in data))
                    validate_manifest(partition(data, 2))


class OutputSafetyTests(unittest.TestCase):
    def test_invalid_output_directory_is_rejected_before_any_cleanup_or_build(self):
        import backend
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'important'
            directory.mkdir()
            marker = directory / 'retain.txt'
            marker.write_text('retain')
            command = ['backend.py', '--target', 'jf12', '--results', str(directory),
                       '--build', str(Path(tmp) / 'snapshot')]
            with patch.object(sys, 'argv', command), patch.object(backend, 'prepare_build') as build:
                with self.assertRaises(SystemExit) as raised:
                    backend.main()
                self.assertEqual(2, raised.exception.code)
                build.assert_not_called()
            self.assertEqual('retain', marker.read_text())


class TimingProfileTests(unittest.TestCase):
    def test_zero_duration_profile_still_produces_nonempty_complete_partitions(self):
        cases = PartitionTests().cases()
        for count in (2, 3, 4):
            result = partition(cases, count, {case['name']: 0.0 for case in cases})
            self.assertEqual(count, len(result['shards']))
            self.assertTrue(all(shard['cases'] for shard in result['shards']))
            validate_manifest(result)

    def test_previous_default_results_are_read_before_cleanup(self):
        import backend
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'backend/jf12'
            directory.mkdir(parents=True)
            profile = directory / 'previous.trx'
            profile.write_text('<TestRun><Results><UnitTestResult testName="C.Run" outcome="Passed" duration="00:00:02"/></Results></TestRun>')
            command = ['backend.py', '--target', 'jf12', '--results', str(directory),
                       '--build', str(Path(tmp) / 'build/jf12/snapshot'), '--durations', str(profile)]
            with patch.object(sys, 'argv', command), patch.object(backend, 'trx_cases', wraps=trx_cases) as read, \
                 patch.object(backend, 'prepare_build', side_effect=RuntimeError('probe after duration capture')):
                self.assertEqual(1, backend.main())
                read.assert_called_once_with(profile)
            self.assertEqual('probe after duration capture', json.loads((directory / 'status.json').read_text())['reason'])


class MalformedProfileTests(unittest.TestCase):
    def test_malformed_profile_exits_incomplete_before_build(self):
        import backend
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'backend/jf12'
            directory.mkdir(parents=True)
            profile = directory / 'invalid.trx'
            profile.write_text('<TestRun>')
            command = ['backend.py', '--target', 'jf12', '--results', str(directory),
                       '--build', str(Path(tmp) / 'build/jf12/snapshot'), '--durations', str(profile)]
            with patch.object(sys, 'argv', command), patch.object(backend, 'prepare_build') as build:
                self.assertEqual(1, backend.main())
                build.assert_not_called()
            self.assertEqual('incomplete', json.loads((directory / 'status.json').read_text())['status'])
