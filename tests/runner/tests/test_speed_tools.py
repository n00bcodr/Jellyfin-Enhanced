"""The test-speed tooling must never lose a test, double a test, or select less than a change can reach."""
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tests/runner' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


shards = load('dotnet_shards')
affected = load('affected')
NS = 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'


def trx(path, results, outcome='Completed'):
    rows = ''.join(f'<UnitTestResult testId="{i}" testName="{name}" outcome="{outcome}" duration="00:00:00.0100000"/>'
                   for i, (name, outcome) in enumerate(results))
    defs = ''.join(f'<UnitTest id="{i}"><TestMethod className="{name.rsplit(".", 1)[0]}"/></UnitTest>' for i, (name, _) in enumerate(results))
    passed = sum(1 for _, o in results if o == 'Passed')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'<TestRun xmlns="{NS}"><Results>{rows}</Results><TestDefinitions>{defs}</TestDefinitions>'
                    f'<ResultSummary outcome="{outcome}"><Counters total="{len(results)}" passed="{passed}"/></ResultSummary></TestRun>')


def coverage(path, lines, branches):
    path.mkdir(parents=True, exist_ok=True)
    (path / 'coverage.json').write_text(json.dumps({'Jellyfin.Plugin.JellyfinEnhanced.dll': {'/src/A.cs': {'A': {'M': {
        'Lines': {str(k): v for k, v in lines.items()},
        'Branches': [{'Line': 1, 'Offset': o, 'EndOffset': o + 1, 'Path': p, 'Ordinal': p, 'Hits': h} for (o, p), h in branches.items()]}}}}}))


class DotnetShardsTests(unittest.TestCase):
    def test_the_real_tree_has_no_unplaceable_singleton_attribute(self):
        singles, classes, problems = shards.scan()
        self.assertEqual([], problems)
        self.assertGreater(len(singles), 0)
        self.assertTrue(set(singles) <= set(classes))

    def test_singleton_shards_partition_the_singleton_classes_and_the_parallel_filter_excludes_all_of_them(self):
        singles, _, _ = shards.scan()
        with mock.patch('builtins.print') as out:
            self.assertEqual(0, shards.plan(3, None))
        plan = json.loads(out.call_args[0][0])
        placed = [c for name, f in plan.items() if name.startswith('singleton-') for c in
                  (part.removeprefix('FullyQualifiedName~').removesuffix('.') for part in f.split('|'))]
        self.assertEqual(sorted(singles), sorted(placed), 'every singleton class in exactly one shard')
        self.assertEqual(len(placed), len(set(placed)))
        excluded = [part.removeprefix('FullyQualifiedName!~').removesuffix('.') for part in plan['parallel'].split('&')]
        self.assertEqual(sorted(singles), sorted(excluded))

    def test_merge_adds_counts_refuses_a_test_in_two_shards_and_unions_coverage_exactly(self):
        with tempfile.TemporaryDirectory() as d:
            res = Path(d)
            trx(res / 'a' / 'a.trx', [('N.C.t1', 'Passed'), ('N.C.t2', 'Failed')])
            trx(res / 'b' / 'b.trx', [('N.D.t3', 'Passed')])
            coverage(res / 'a' / 'g1', {1: 1, 2: 0, 3: 0}, {(0, 0): 1, (0, 1): 0})
            coverage(res / 'b' / 'g2', {1: 0, 2: 2, 3: 0}, {(0, 0): 0, (0, 1): 3})
            with mock.patch('builtins.print') as out:
                shards.merge(res, ['a', 'b'])
            lines = [c[0] for c in out.call_args_list if c[0]]
            self.assertEqual((3, 2), lines[0])
            xml = (res / 'merged/coverage.cobertura.xml').read_text()
            self.assertIn('line-rate="0.6666"', xml)     # lines 1 and 2 of 3 covered by one shard or the other (coverlet truncates)
            self.assertIn('branch-rate="1.0"', xml)                  # each branch path covered by one shard
            trx(res / 'b' / 'b.trx', [('N.D.t3', 'Passed'), ('N.D.t3', 'Passed')])   # two theory cases, one truncated name
            with mock.patch('builtins.print'):
                shards.merge(res, ['a', 'b'])
            trx(res / 'b' / 'b.trx', [('N.C.t1', 'Passed')])    # class N.C in both hosts
            with self.assertRaises(SystemExit):
                shards.merge(res, ['a', 'b'])
            trx(res / 'b' / 'b.trx', [], outcome='Aborted')     # a test host that crashed
            with self.assertRaises(SystemExit):
                shards.merge(res, ['a', 'b'])


class AffectedTests(unittest.TestCase):
    def test_trace_parsing_keeps_reads_listings_and_misses_inside_the_checkout_only(self):
        root = affected.ROOT
        text = '\n'.join([
            f'1 openat(AT_FDCWD<{root}>, "package.json", O_RDONLY|O_CLOEXEC) = 20<{root}/package.json>',
            f'1 openat(AT_FDCWD<{root}>, "client/entries", O_RDONLY|O_DIRECTORY) = 21<{root}/client/entries>',
            f'1 newfstatat(AT_FDCWD<{root}>, "client/src/nope.ts", 0x7ffd, 0) = -1 ENOENT (No such file or directory)',
            '1 openat(AT_FDCWD</>, "/etc/hosts", O_RDONLY) = 3</etc/hosts>',
            f'2 openat(AT_FDCWD<{root}>, "client/src/a.ts", O_RDONLY <unfinished ...>',
            '2 <... openat resumed>) = 22',
            f'1 openat(AT_FDCWD<{root}>, "node_modules/x/index.js", O_RDONLY) = 23',
        ])
        reads, dirs, missing = affected.parse_trace(text, root)
        self.assertEqual(['client/src/a.ts', 'package.json'], reads)
        self.assertEqual(['client/entries'], dirs)
        self.assertEqual(['client/src/nope.ts'], missing)

    def selection(self, changed, suites=None, node=None, lock=None):
        files = {'frontend': ['tests/frontend/a.test.mjs', 'tests/frontend/b.test.mjs'], 'client-build': [], 'boundary': [],
                 'browser': ['tests/browser/x.spec.cjs'], 'dotnet': ['tests/backend/JE.Tests.csproj']}
        entry = lambda reads=(), dirs=(), missing=(): {'rc': 0, 'reads': list(reads), 'dirs': list(dirs), 'missing': list(missing)}
        data = {'commit': 'c0ffee', 'node': node or affected.node_version(), 'lock': lock or affected.lock_hash(), 'suites': suites or {
            'frontend': {'tests/frontend/a.test.mjs': entry(['js/a.js'], ['Configuration/admin'], ['js/missing.js']),
                         'tests/frontend/b.test.mjs': entry(['js/b.js'])},
            'browser': {'tests/browser/x.spec.cjs': entry(['js/a.js'])}, 'dotnet': {'tests/backend/JE.Tests.csproj': entry(['docs/feature-map.json'])}}}
        with tempfile.TemporaryDirectory() as d, mock.patch.object(affected, 'suite_files', lambda s: files[s]):
            path = Path(d) / 'map.json'
            path.write_text(json.dumps(data))
            return affected.select(path, changed=changed)

    def test_a_change_selects_exactly_the_files_that_read_it(self):
        s = self.selection({'js/a.js': 'M'})
        self.assertIsNone(s['all'])
        self.assertEqual(['tests/frontend/a.test.mjs'], s['suites'].get('frontend'))
        self.assertEqual(['tests/browser/x.spec.cjs'], s['suites'].get('browser'))
        self.assertNotIn('dotnet', s['suites'])

    def test_a_new_file_where_a_test_looked_or_in_a_directory_it_listed_selects_it(self):
        self.assertEqual(['tests/frontend/a.test.mjs'], self.selection({'js/missing.js': 'A'})['suites'].get('frontend'))
        self.assertEqual(['tests/frontend/a.test.mjs'], self.selection({'Configuration/admin/new.js': 'A'})['suites'].get('frontend'))

    def test_plugin_changes_and_runtime_reads_select_the_dotnet_suite(self):
        self.assertIn('dotnet', self.selection({'Jellyfin.Plugin.JellyfinEnhanced/Features/X.cs': 'M'})['suites'])
        self.assertIn('dotnet', self.selection({'docs/feature-map.json': 'M'})['suites'])

    def test_unknown_state_selects_everything(self):
        self.assertIsNotNone(self.selection({'package-lock.json': 'M'})['all'])
        self.assertIsNotNone(self.selection({}, node='v0.0.0')['all'])
        self.assertIsNotNone(self.selection({}, lock='other')['all'])
        s = self.selection({}, suites={'frontend': {}})      # files the map does not know are selected
        self.assertEqual(['tests/frontend/a.test.mjs', 'tests/frontend/b.test.mjs'], s['suites']['frontend'])


class FrontendRunnerTests(unittest.TestCase):
    """tests/frontend/run.mjs may run some files as a first part and report failures early, but never runs fewer files."""
    node = shutil.which('node')

    def test_split_first_parts_are_every_file_exactly_once(self):
        script = ("import('./tests/frontend/helpers/discovery.mjs').then(m => { const all = m.discoverTests();"
                  " const listed = ['tests/frontend/requests/seerr-review-r2.test.mjs', 'tests/frontend/no-such.test.mjs',"
                  " 'tests/frontend/core/core-api-runtime.test.mjs'];"
                  " console.log(JSON.stringify({ all, ...m.splitFirst(all, listed) })); })")
        out = json.loads(subprocess.run([self.node, '--input-type=module', '-e', script], cwd=ROOT, capture_output=True,
                                        text=True, check=True).stdout)
        self.assertEqual(['tests/frontend/core/core-api-runtime.test.mjs', 'tests/frontend/requests/seerr-review-r2.test.mjs'],
                         [str(Path(f).relative_to(ROOT)) for f in out['first']])
        self.assertEqual(sorted(out['all']), sorted(out['first'] + out['rest']))
        self.assertEqual(len(out['all']), len(set(out['first'] + out['rest'])))

    def test_an_empty_part_runs_nothing(self):
        # `node --test` with no files would discover tests of its own; a part with no files must run none.
        with tempfile.TemporaryDirectory() as d:
            listed = Path(d) / 'first'
            listed.write_text('tests/frontend/no-such.test.mjs\n')
            env = dict(os.environ, JE_TESTS_FIRST=str(listed), JE_TESTS_PART='first')
            r = subprocess.run([self.node, 'tests/frontend/run.mjs'], cwd=ROOT, env=env, capture_output=True, text=True,
                               timeout=60)
            self.assertEqual((0, ''), (r.returncode, r.stdout))

    def test_early_failures_reports_each_failing_test_at_once_and_nothing_else(self):
        hook = ROOT / 'tests/runner/early-failures.mjs'
        with tempfile.TemporaryDirectory() as d:
            spec = Path(d) / 'sample.test.mjs'
            spec.write_text("import test from 'node:test';\n"
                            "test('passes', () => {});\n"
                            "test('fails', () => { throw new Error('no'); });\n"
                            "test('outer', async t => { await t.test('inner fails', () => { throw new Error('no'); }); });\n")
            log = Path(d) / 'early.log'
            env = dict(os.environ, JE_EARLY_FAILURES=str(log))
            r = subprocess.run([self.node, f'--import={hook}', '--test', '--test-reporter=tap', str(spec)], cwd=d,
                               env=env, capture_output=True, text=True)
            self.assertNotEqual(0, r.returncode)
            self.assertIn('# tests 4', r.stdout)                        # the hook adds no test
            self.assertEqual(['✖ sample.test.mjs :: fails', '✖ sample.test.mjs :: outer > inner fails'],
                             sorted(log.read_text().splitlines()))
            # A node process that is not a test file's process (a script a test starts) is left alone.
            log.unlink()
            r = subprocess.run([self.node, f'--import={hook}', '-e', "console.log('plain')"], cwd=d, env=env,
                               capture_output=True, text=True, check=True)
            self.assertEqual('plain\n', r.stdout)
            self.assertFalse(log.exists())


class QuickFeatureTests(unittest.TestCase):
    """restructure-gates.sh quick finds the features a change touches from the changed paths."""

    def quick_map(self, *args):
        script = (ROOT / 'scripts/restructure-gates.sh').read_text()
        start = script.index('quick_map() {')
        end = script.index('\n}\n', script.index("\nPY\n", start)) + 3
        r = subprocess.run(['bash', '-c', script[start:end] + '\nquick_map "$@"', 'quick_map', *args], cwd=ROOT,
                           capture_output=True, text=True, check=True)
        return r.stdout.split()

    def test_changed_paths_map_to_their_features(self):
        self.assertEqual(['seerr', 'platform'], self.quick_map(
            'features', 'client/src/features/seerr/details/scroll/seamless-scroll.ts', 'client/src/core/api/retry.ts',
            'docs/feature-map.json', 'Jellyfin.Plugin.JellyfinEnhanced/js/core/api-client.js'))
        self.assertEqual([], self.quick_map('features'))


class HeavyGateSlotTests(unittest.TestCase):
    """Two heavy gates on one machine run one after the other, never side by side."""

    def test_a_heavy_gate_waits_while_another_holds_the_machine_slot(self):
        with tempfile.TemporaryDirectory() as d:
            lock = Path(d) / 'heavy.lock'
            holder = subprocess.Popen(['flock', str(lock), 'sleep', '60'])
            try:
                time.sleep(0.3)
                env = {k: v for k, v in os.environ.items() if k not in ('JE_GATE_HEAVY_HELD', 'JE_GATE_SIDE_BY_SIDE')}
                env['JE_GATE_HEAVY_LOCK'] = str(lock)
                gate = subprocess.Popen(['bash', 'scripts/restructure-gates.sh', 'browser'], cwd=ROOT, env=env, text=True,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
                try:
                    gate.communicate(timeout=3)
                    self.fail('the gate did not wait for the slot')
                except subprocess.TimeoutExpired:
                    pass
                os.killpg(gate.pid, signal.SIGKILL)
                _, err = gate.communicate()
                self.assertIn('another heavy gate is running on this machine; browser waits for it', err)
            finally:
                holder.kill()
                holder.wait()


if __name__ == '__main__':
    unittest.main()
