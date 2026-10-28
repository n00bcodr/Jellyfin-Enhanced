"""Build reuse is gone; default execution keeps the pre-tier process contract."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/runner'))
import backend


class FreshBuildTests(unittest.TestCase):
    def test_each_invocation_builds_and_discards_previous_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'build/jf12/snapshot'
            directory.parent.mkdir(parents=True)
            (directory.parent / 'build-identity.json').write_text('retired stamp')
            def build(command, log):
                self.assertFalse(directory.exists())
                self.assertEqual(['dotnet', 'build'], command[:2])
                self.assertIn('-p:RestoreLockedMode=true', command)
                directory.mkdir()
                (directory / 'output.dll').write_text('fresh')
                return dict(exit_code=0, seconds=1)
            with patch.object(backend, 'run', side_effect=build) as run:
                backend.prepare_build('jf12', directory)
                (directory / 'stale.dll').write_text('old')
                backend.prepare_build('jf12', directory)
            self.assertEqual(2, run.call_count)
            self.assertFalse((directory / 'stale.dll').exists())
            self.assertEqual(['snapshot'], sorted(p.name for p in directory.parent.iterdir()))

    def test_removed_reuse_option_fails_loudly_at_both_entry_points(self):
        with tempfile.TemporaryDirectory() as tmp:
            for script, arguments in [('tests/run.py', ['backend']),
                    ('tests/runner/backend.py', ['--target', 'jf12', '--results', tmp, '--build', tmp])]:
                with self.subTest(script=script):
                    result = subprocess.run([sys.executable, str(ROOT / script), *arguments, '--reuse-build'],
                                            capture_output=True, text=True, timeout=15)
                    self.assertEqual(2, result.returncode)
                    self.assertIn('unrecognized arguments: --reuse-build', result.stderr)
            self.assertFalse(list(Path(tmp).iterdir()))

    def test_failed_witness_stops_before_any_full_partition(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            results = root / 'backend/jf12'
            build = root / 'build/jf12/snapshot'
            def prepare(target, directory):
                assembly = directory / 'bin/JE.Tests/release/JE.Tests.dll'
                assembly.parent.mkdir(parents=True)
                assembly.write_bytes(b'fixture')
                return dict(exit_code=0, seconds=1)
            def execute(command, log, env=None):
                if '--suite-manifest' in command:
                    Path(command[-1]).write_text(json.dumps([
                        dict(id='witness', name=backend.WITNESS, method=backend.WITNESS),
                        dict(id='other', name='Example.Other', method='Example.Other')]))
                    return dict(exit_code=0, seconds=0)
                self.assertEqual(['dotnet', 'test'], command[:2])
                self.assertNotIn('--collect:XPlat Code Coverage', command)
                settings = Path(command[command.index('--settings') + 1]).read_text()
                self.assertIn('FullyQualifiedName=' + backend.WITNESS, settings)
                self.assertNotIn('Example.Other', settings)
                destination = Path(command[command.index('--results-directory') + 1])
                (destination / 'cases.trx').write_text('<TestRun><Results><UnitTestResult '
                    f'testName="{backend.WITNESS}" outcome="Failed"/></Results></TestRun>')
                return dict(exit_code=1, seconds=1)
            argv = ['backend.py', '--target', 'jf12', '--results', str(results),
                    '--build', str(build), '--shards', '1', '--preflight-witnesses']
            with patch.object(sys, 'argv', argv), patch.object(backend, 'prepare_build', side_effect=prepare), \
                 patch.object(backend, 'run', side_effect=execute) as run, \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(1, backend.main())
            self.assertEqual(2, run.call_count)
            status = json.loads((results / 'status.json').read_text())
            self.assertEqual('incomplete', status['status'])
            self.assertIn('Known-failing witness', status['reason'])
            self.assertFalse((results / 'shard-0').exists())


class DefaultExecutionTests(unittest.TestCase):
    def runner(self):
        spec = importlib.util.spec_from_file_location('r3_runner', ROOT / 'tests/run.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_failures_continue_by_default_and_stop_only_with_opt_in(self):
        for failure in ('inventory', 'tooling', 'jellyfin-api-jf12'):
            for profile in (False, True):
                with self.subTest(failure=failure, profile=profile), tempfile.TemporaryDirectory() as tmp:
                    runner = self.runner()
                    root = Path(tmp)
                    (root / 'node_modules').mkdir()
                    commands = []
                    environments = []
                    class Process:
                        def __init__(self, command, **kwargs):
                            commands.append(command)
                            environments.append(kwargs.get('env'))
                            self.stdout = io.StringIO('fixture completed\n')
                        def wait(self):
                            command = commands[-1]
                            name = ('inventory' if 'tests/inventory/generate.py' in command else
                                    'tooling' if 'unittest' in command else
                                    'jellyfin-api-jf12' if 'tests/backend/jellyfin_api.py' in command else '')
                            return 1 if name == failure else 0
                    argv = ['run.py', 'fast', '--target', 'jf12'] + (['--speed-profile'] if profile else [])
                    with patch.object(sys, 'argv', argv), patch.object(runner, 'ROOT', root), \
                         patch.object(runner.shutil, 'which', return_value='fixture'), \
                         patch.object(runner, 'check_preflight') as preflight, \
                         patch.object(runner.subprocess, 'Popen', Process), \
                         contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(1, runner.main())
                    summary = json.loads((root / 'artifacts/regression/summary.json').read_text())
                    if profile:
                        preflight.assert_called_once()
                        self.assertEqual('incomplete', summary[-1]['status'])
                        self.assertFalse(any(c[:2] == ['npm', 'run'] for c in commands))
                        self.assertTrue(all(e['JE_SPEED_PROFILE'] == '1' for e in environments))
                    else:
                        preflight.assert_not_called()
                        self.assertEqual(['inventory', 'tooling', 'jellyfin-api-jf12', 'backend-jf12',
                                          'coverage-jf12', 'frontend'], [s['name'] for s in summary])
                        command = next(c for c in commands if c[:2] == ['dotnet', 'test'])
                        self.assertNotIn('-m:4', command)
                        self.assertTrue(all(e is None for e in environments))

    def test_default_missing_prerequisite_has_only_the_historical_record(self):
        runner = self.runner()
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(sys, 'argv', ['run.py', 'frontend', '--artifacts', tmp]), \
             patch.object(runner.shutil, 'which', return_value=None), \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                runner.main()
            self.assertEqual(2, raised.exception.code)
            records = json.loads((Path(tmp) / 'summary.json').read_text())
            self.assertEqual(1, len(records))
            self.assertEqual(('prerequisites', 'failed', 127),
                             tuple(records[0][k] for k in ('name', 'status', 'exit_code')))

    def test_frontend_default_arguments_and_names_require_no_worker_setting(self):
        module = (ROOT / 'tests/frontend/helpers/discovery.mjs').as_uri()
        code = f'import {{testArguments,nestedConcurrency}} from {json.dumps(module)}; console.log(JSON.stringify([testArguments,nestedConcurrency]));'
        env = {k: v for k, v in os.environ.items() if k != 'JE_SPEED_PROFILE'}
        env.update(JE_NODE_FILE_CONCURRENCY='invalid', JE_NODE_NESTED_CONCURRENCY='invalid')
        result = subprocess.run(['node', '--input-type=module', '-e', code], env=env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual([['--test-timeout=120000'], 8], json.loads(result.stdout))

    def test_frontend_default_does_not_populate_an_instrumentation_cache(self):
        module = (ROOT / 'tests/frontend/helpers/instrumentation.mjs').as_uri()
        code = f'import {{instrumentSource}} from {json.dumps(module)}; instrumentSource("globalThis.x=1;", "/example.js");'
        with tempfile.TemporaryDirectory() as tmp:
            env = {k: v for k, v in os.environ.items() if k not in ('JE_SPEED_PROFILE', 'JE_INSTRUMENT_CACHE')}
            env['JE_INSTRUMENT_CACHE_DIR'] = tmp
            result = subprocess.run(['node', '--input-type=module', '-e', code], env=env,
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertFalse(list(Path(tmp).iterdir()))


class CoverageComparisonTests(unittest.TestCase):
    def test_hit_variance_is_diagnostic_but_inventory_and_case_changes_are_not(self):
        from compare_evidence import compare_backend
        from test_suite_speed import CoverageUnionTests
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            before, after = root / 'before.json', root / 'after.json'
            trx = root / 'cases.trx'
            trx.write_text('<TestRun><Results><UnitTestResult testName="Example.Run" '
                           'outcome="Passed"/></Results></TestRun>')
            CoverageUnionTests().report(before, hits=(1, 0))
            CoverageUnionTests().report(after, hits=(0, 1))
            result = compare_backend([trx], [trx], [before], [after])
            self.assertTrue(result['equivalent'])
            self.assertTrue(result['denominators_equal'])
            self.assertEqual(1, len(result['differing_hit_files']))
            CoverageUnionTests().report(after, hits=(0, 1), extra=True)
            result = compare_backend([trx], [trx], [before], [after])
            self.assertFalse(result['equivalent'])
            self.assertFalse(result['inventory_equal'])
            self.assertFalse(result['denominators_equal'])
            CoverageUnionTests().report(after, hits=(0, 1))
            changed = json.loads(after.read_text())
            classes = next(iter(next(iter(changed.values())).values()))
            classes['Example']['Run()']['Lines'] = {'1': 1, '3': 0}
            after.write_text(json.dumps(changed))
            result = compare_backend([trx], [trx], [before], [after])
            self.assertTrue(result['denominators_equal'])
            self.assertFalse(result['inventory_equal'])
            self.assertFalse(result['equivalent'])
            CoverageUnionTests().report(after, hits=(0, 1))
            failed = root / 'failed.trx'
            failed.write_text(trx.read_text().replace('Passed', 'Failed'))
            self.assertFalse(compare_backend([trx], [failed], [before], [after])['equivalent'])
            self.assertFalse(compare_backend([], [], [before], [after])['equivalent'])
