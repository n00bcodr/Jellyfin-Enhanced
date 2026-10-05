"""Protect regression tooling against false-green reports."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


class RegressionToolingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name)

    def coverage(self, folder, lines=0.5, branches=0.4, plugin=True):
        path = self.output / folder / 'coverage.cobertura.xml'
        path.parent.mkdir(parents=True, exist_ok=True)
        name = 'Jellyfin.Plugin.JellyfinEnhanced' if plugin else 'Unrelated.Assembly'
        path.write_text(f'<coverage><packages><package name="{name}" line-rate="{lines}" branch-rate="{branches}"/></packages></coverage>')

    def check_coverage(self):
        return subprocess.run([sys.executable, str(ROOT / 'tests/runner/coverage.py'), str(self.output)], capture_output=True, text=True)

    def test_vstest_duplicate_attachment_is_one_report(self):
        self.coverage('collector')
        self.coverage('trx/In/host')
        self.assertEqual(0, self.check_coverage().returncode)
        self.assertTrue(json.loads((self.output / 'coverage-summary.json').read_text())['passed'])

    def test_distinct_runs_must_not_select_a_stale_passing_report(self):
        self.coverage('old', lines=0.9)
        self.coverage('new', lines=0.01)
        self.assertNotEqual(0, self.check_coverage().returncode)

    def test_low_coverage_fails_even_with_a_valid_report(self):
        self.coverage('collector', branches=0.01)
        self.assertEqual(1, self.check_coverage().returncode)
        self.assertFalse(json.loads((self.output / 'coverage-summary.json').read_text())['passed'])

    def test_missing_plugin_or_report_fails(self):
        self.assertNotEqual(0, self.check_coverage().returncode)
        self.coverage('collector', plugin=False)
        self.assertNotEqual(0, self.check_coverage().returncode)

    def test_failed_prerequisites_replace_previous_passing_summary(self):
        summary = self.output / 'summary.json'
        summary.write_text('[{"status":"passed"}]')
        env = {**os.environ, 'PATH': str(self.output / 'no-tools')}
        result = subprocess.run([sys.executable, str(ROOT / 'tests/run.py'), 'frontend', '--artifacts', str(self.output)], env=env, capture_output=True, text=True)
        self.assertNotEqual(0, result.returncode)
        self.assertIn('Missing prerequisites', result.stderr)
        self.assertEqual('failed', json.loads(summary.read_text())[0]['status'])

    def test_mutation_manifest_cannot_target_original_checkout(self):
        original = ROOT / 'Jellyfin.Plugin.JellyfinEnhanced/Services/PosterTags/NativeClientPolicy.cs'
        before = original.read_bytes()
        for path in (str(original), '../outside.cs'):
            with self.subTest(path=path):
                manifest = self.output / 'cases.json'
                manifest.write_text(json.dumps([dict(name='escape', layer='backend', file=path,
                    before='Jellium Desktop', after='changed', test='Example', assertion='Assert.Equal')]))
                result = subprocess.run([sys.executable, str(ROOT / 'tests/runner/mutations.py'),
                    '--cases', str(manifest)], capture_output=True, text=True)
                self.assertNotEqual(0, result.returncode)
                self.assertIn('paths must be relative', result.stderr)
                self.assertEqual(before, original.read_bytes())

    def test_empty_mutation_selection_cannot_report_success(self):
        manifest = self.output / 'cases.json'
        manifest.write_text('[]')
        result = subprocess.run([sys.executable, str(ROOT / 'tests/runner/mutations.py'),
            '--cases', str(manifest)], capture_output=True, text=True)
        self.assertNotEqual(0, result.returncode)
        self.assertIn('nonempty JSON list', result.stderr)

    def test_frontend_discovery_includes_nested_specs_and_rejects_empty_suite(self):
        discovery = (ROOT / 'tests/frontend/helpers/discovery.mjs').as_uri()
        command = ['node', '--input-type=module', '-e',
            f'import {{discoverTests}} from {json.dumps(discovery)}; console.log(JSON.stringify(discoverTests(process.argv[1])));', str(self.output)]
        empty = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(0, empty.returncode)
        self.assertIn('No frontend tests discovered', empty.stderr)
        nested = self.output / 'feature' / 'nested'
        nested.mkdir(parents=True)
        spec = nested / 'behavior.test.mjs'
        spec.write_text('// discovery fixture; never executed')
        (nested / 'helper.mjs').write_text('// not a test')
        found = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(0, found.returncode, found.stderr)
        self.assertEqual([str(spec)], json.loads(found.stdout))


if __name__ == '__main__':
    unittest.main()
