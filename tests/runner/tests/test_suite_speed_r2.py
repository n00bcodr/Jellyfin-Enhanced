"""Frozen default summary and additive shard totals regressions."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/runner'))


class FrozenDefaultSummaryTests(unittest.TestCase):
    def test_default_summary_matches_the_actual_pre_tier_validator_field_by_field(self):
        fixture = json.loads((ROOT / 'tests/fixtures/suite-speed/backend-default-summary.json').read_text())
        with tempfile.TemporaryDirectory() as temporary:
            results = Path(temporary)
            (results / 'coverage.cobertura.xml').write_text(
                '<coverage lines-covered="8" lines-valid="10" branches-covered="6" branches-valid="10">'
                '<packages><package name="Jellyfin.Plugin.JellyfinEnhanced" line-rate="0.8" branch-rate="0.6"/>'
                '</packages></coverage>')
            process = subprocess.run([sys.executable, str(ROOT / 'tests/runner/coverage.py'), str(results)],
                                     capture_output=True, text=True, timeout=30)
            self.assertEqual(0, process.returncode, process.stderr)
            actual = json.loads((results / 'coverage-summary.json').read_text())
            actual['source'] = '<coverage-report>'
            self.assertEqual(fixture['summary'], actual)
            self.assertFalse((results / 'coverage-summary.totals.json').exists())

    def test_shard_totals_are_an_additive_file_and_default_clears_it(self):
        from test_suite_speed import CoverageUnionTests, PartitionTests
        from partitions import partition
        with tempfile.TemporaryDirectory() as temporary:
            results = Path(temporary)
            manifest = partition(PartitionTests().cases(), 2)
            manifest['run_id'] = 'f' * 32
            for index, shard in enumerate(manifest['shards']):
                shard.update(exit_code=0, run_id='f' * 32)
                directory = results / shard['id']
                directory.mkdir()
                CoverageUnionTests().report(directory / 'coverage.json', hits=(1, 0) if index == 0 else (0, 1))
                items = ''.join(f'<UnitTestResult testName="C{i}.Run" outcome="Passed"/>' for i in shard['cases'])
                (directory / 'cases.trx').write_text('<TestRun><Results>' + items + '</Results></TestRun>')
            path = results / 'partitions.json'
            path.write_text(json.dumps(manifest))
            command = [sys.executable, str(ROOT / 'tests/runner/coverage.py'), str(results)]
            run = subprocess.run([*command, '--manifest', str(path)], capture_output=True, text=True, timeout=30)
            self.assertEqual(0, run.returncode, run.stderr)
            sidecar = results / 'coverage-summary.totals.json'
            self.assertTrue(sidecar.is_file(), 'Opt-in totals must live in an additive file')
            self.assertEqual({'line': {'covered': 1, 'total': 2}, 'branch': {'covered': 2, 'total': 2}},
                             json.loads(sidecar.read_text()))
            fixture = json.loads((ROOT / 'tests/fixtures/suite-speed/backend-default-summary.json').read_text())['summary']
            self.assertEqual(set(fixture), set(json.loads((results / 'coverage-summary.json').read_text())))
            (results / 'coverage.cobertura.xml').write_text(
                '<coverage><packages><package name="Jellyfin.Plugin.JellyfinEnhanced" '
                'line-rate="0.8" branch-rate="0.6"/></packages></coverage>')
            run = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertEqual(0, run.returncode, run.stderr)
            self.assertFalse(sidecar.exists(), 'Default validation retained old opt-in totals')
