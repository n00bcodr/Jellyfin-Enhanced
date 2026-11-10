"""The rewrite must never dispatch a legacy build or host, even through `all`."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]


def load(relative):
    spec = importlib.util.spec_from_file_location('target_runner', ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TargetSelectionTests(unittest.TestCase):
    def test_legacy_and_unknown_targets_fail_before_prerequisites_or_side_effects(self):
        for runner in ('tests/run.py', 'tests/host/run.py', 'tests/runner/clean.py', 'tests/runner/mutations.py'):
            for target in ('jf10', 'jf13', 'typo'):
                with self.subTest(runner=runner, target=target), tempfile.TemporaryDirectory() as temp:
                    output = Path(temp) / 'must-not-exist'
                    result = subprocess.run([sys.executable, str(ROOT / runner), '--target', target,
                                             '--artifacts', str(output)], capture_output=True, text=True)
                    self.assertEqual(2, result.returncode, result.stdout + result.stderr)
                    self.assertIn('invalid choice', result.stderr)
                    self.assertIn('jf12', result.stderr)
                    self.assertFalse(output.exists())

    def test_backend_default_all_and_explicit_dispatch_only_jf12(self):
        runner = load('tests/run.py')
        for selection in ([], ['--target', 'all'], ['--target', 'jf12']):
            with self.subTest(selection=selection), tempfile.TemporaryDirectory() as temp:
                argv = ['run.py', 'backend', '--artifacts', temp, *selection]
                with patch.object(sys, 'argv', argv), patch.object(runner.shutil, 'which', return_value='/fake/dotnet'), \
                     patch.object(runner.subprocess, 'Popen') as process:
                    process.return_value.stdout = []
                    process.return_value.wait.return_value = 0
                    self.assertEqual(0, runner.main())
                results = json.loads((Path(temp) / 'summary.json').read_text())
                self.assertEqual(['backend-jf12', 'coverage-jf12'], [r['name'] for r in results])
                self.assertIn('-p:JellyfinTarget=jf12', results[0]['command'])

    def test_host_default_all_and_explicit_dispatch_only_jf12(self):
        runner = load('tests/host/run.py')
        for selection in ([], ['--target', 'all'], ['--target', 'jf12']):
            with self.subTest(selection=selection), tempfile.TemporaryDirectory() as temp:
                with patch.object(sys, 'argv', ['run.py', '--artifacts', temp, *selection]), \
                     patch.object(runner.shutil, 'which', return_value='/fake/tool'), \
                     patch.object(runner, 'command'), patch.object(runner, 'run') as run, \
                     patch.object(runner.signal, 'signal'):
                    self.assertFalse(runner.main())
                run.assert_called_once_with('jf12', Path(temp).resolve(), False)
        self.assertEqual({'jf12': 'jellyfin/jellyfin:12'}, runner.IMAGES)

    def test_direct_host_runner_rejects_unsupported_target_before_creating_artifacts(self):
        runner = load('tests/host/run.py')
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'must-not-exist'
            with self.assertRaisesRegex(ValueError, 'Jellyfin 12.x only'), patch.object(runner, 'command') as command:
                runner.run('jf10', output)
            command.assert_not_called()
            self.assertFalse(output.exists())
