"""Review regressions through the real build/coverage/runner entry points."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'tests/runner'))


class DefaultBackendContractTests(unittest.TestCase):
    def test_default_fast_uses_the_original_trx_collector_and_build_layout(self):
        spec = importlib.util.spec_from_file_location('run_contract', ROOT / 'tests/run.py')
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        commands = []
        class Process:
            def __init__(self, command, **kwargs):
                commands.append(command)
                self.stdout = io.StringIO('fixture completed\n')
            def wait(self):
                return 0
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = Path(temporary) / 'artifacts/regression'
            stale = artifacts / 'backend/jf12/shard-0/raw.json'
            stale.parent.mkdir(parents=True)
            stale.write_text('stale aborted shard')
            stale_build = artifacts / 'build/jf12/snapshot/old.dll'
            stale_build.parent.mkdir(parents=True)
            stale_build.write_text('aborted isolated build')
            (stale_build.parent.parent / 'build-identity.json').write_text('{}')
            with patch.object(sys, 'argv', ['run.py', 'fast', '--target', 'jf12']), \
                 patch.object(runner, 'ROOT', Path(temporary)), \
                 patch.object(runner, 'check_preflight'), patch.object(runner.shutil, 'which', return_value='fixture'), \
                 patch.object(runner.subprocess, 'Popen', Process):
                # Avoid the dependency existence probe without altering artifact paths.
                (Path(temporary) / 'node_modules').mkdir()
                self.assertEqual(0, runner.main())
            test = next((command for command in commands if command[:2] == ['dotnet', 'test']), None)
            self.assertIsNotNone(test, 'Default must use the original single-process dotnet test entry point')
            self.assertEqual(str(artifacts / 'build/jf12'), test[test.index('--artifacts-path') + 1])
            self.assertEqual(str(artifacts / 'backend/jf12'), test[test.index('--results-directory') + 1])
            self.assertEqual('trx', test[test.index('--logger') + 1])
            self.assertIn('--collect:XPlat Code Coverage', test)
            self.assertNotIn('--no-build', test)
            self.assertNotIn('-m:4', test)
            self.assertFalse(stale.is_file())
            self.assertFalse(stale_build.is_file())
            self.assertFalse((stale_build.parent.parent / 'build-identity.json').exists())


class FrontendArtifactContractTests(unittest.TestCase):
    def fixture(self, root):
        helpers = root / 'tests/frontend/helpers'
        helpers.mkdir(parents=True)
        for name in ('coverage.mjs', 'discovery.mjs'):
            shutil.copy2(ROOT / 'tests/frontend/helpers' / name, helpers / name)
        (root / 'node_modules').symlink_to((ROOT / 'node_modules').resolve(), target_is_directory=True)
        source = root / 'Jellyfin.Plugin.JellyfinEnhanced/js/core'
        source.mkdir(parents=True)
        names = ['api-client', 'dom-observer', 'lifecycle', 'navigation', 'session']
        for name in names:
            (source / (name + '.js')).write_text('globalThis.fixture = 1;\n')
        # Real Node tests and Istanbul counters; each test file owns a raw map.
        for index, group in enumerate((names[:2], names[2:])):
            (helpers.parent / f'part{index}.test.mjs').write_text('''
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createInstrumenter } from 'istanbul-lib-instrument';
test('fixture GROUP', async () => {
  const map = {};
  for (const name of NAMES) {
    const path = resolve(`Jellyfin.Plugin.JellyfinEnhanced/js/core/${name}.js`);
    const instrumenter = createInstrumenter();
    const context = {};
    runInNewContext(instrumenter.instrumentSync(readFileSync(path, 'utf8'), path), context);
    Object.assign(map, context.__coverage__);
  }
  writeFileSync(join(process.env.JE_COVERAGE_DIR, `fixture-GROUP.json`), JSON.stringify(map));
  if (process.env.JE_ARTIFACT_ABORT) await new Promise(done => setTimeout(done, 30000));
});
'''.replace('GROUP', str(index)).replace('NAMES', json.dumps(group)))
        return helpers / 'coverage.mjs'

    def execute(self, script, shards=None):
        env = {k: v for k, v in os.environ.items() if k not in (
            'JE_SPEED_PROFILE', 'JE_FRONTEND_SHARDS', 'JE_FRONTEND_COVERAGE_ROOT', 'JE_NODE_FILE_CONCURRENCY', 'JE_NODE_NESTED_CONCURRENCY')}
        if shards is not None:
            env['JE_FRONTEND_SHARDS'] = str(shards)
            env['JE_SPEED_PROFILE'] = '1'
        result = subprocess.run(['node', str(script)], env=env, capture_output=True, text=True, timeout=45)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        return result.stdout

    def test_default_tree_and_schema_match_pre_medium_and_aborted_shards_cannot_leak(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = self.fixture(root)
            out = root / 'artifacts/frontend-coverage'
            self.execute(script)
            expected = json.loads((ROOT / 'tests/runner/fixtures/default-frontend-tree.json').read_text())
            self.assertEqual(expected, self.tree(out))
            self.assertEqual(['frontend-coverage'], sorted(p.name for p in out.parent.iterdir()))
            original = json.loads((out / 'coverage-summary.json').read_text())
            self.assertEqual({'total', *(str(p) for p in (root / 'Jellyfin.Plugin.JellyfinEnhanced/js/core').glob('*.js'))}, set(original))
            self.assertEqual({'lines', 'statements', 'functions', 'branches', 'branchesTrue'}, set(original['total']))
            maps = [json.loads(p.read_text()) for p in (out / 'raw').glob('*.json')]
            for data in maps:
                for file in data.values():
                    self.assertTrue({'path', 'statementMap', 'fnMap', 'branchMap', 's', 'f', 'b'} <= file.keys())
            # A sharded run must clear the old raw compatibility directory before
            # spawning. An interrupted run can only leave private shard counters.
            self.abort_sharded(script, out)
            self.assertFalse((out / 'raw').exists())
            abandoned = out / 'runs/run-aborted/shard-0/raw/stale.json'
            abandoned.parent.mkdir(parents=True)
            abandoned.write_text('{"stale":true}')
            (out / 'raw').mkdir()
            (out / 'raw/stale.json').write_text('{"stale":true}')
            private = out.parent / '.frontend-coverage-runs/run-other/shard-0/raw/active.json'
            private.parent.mkdir(parents=True)
            private.write_text('other invocation')
            self.execute(script)
            self.assertEqual('other invocation', private.read_text())
            self.assertEqual(expected, self.tree(out))
            self.assertEqual(original, json.loads((out / 'coverage-summary.json').read_text()))
            self.assertFalse(list(out.rglob('stale.json')))

    def test_default_and_two_shards_have_identical_cases_and_coverage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = self.fixture(root)
            default = self.execute(script)
            out = root / 'artifacts/frontend-coverage'
            summary = json.loads((out / 'coverage-summary.json').read_text())
            sharded = self.execute(script, 2)
            self.assertEqual(summary, json.loads((out / 'coverage-summary.json').read_text()))
            import re
            self.assertEqual(sorted(re.findall(r'^(?:ok \d+ - |✔ )(fixture \d+)(?:$| \()', default, re.M)),
                             sorted(re.findall(r'^(?:ok \d+ - |✔ )(fixture \d+)(?:$| \()', sharded, re.M)))
            self.assertEqual(2, len(re.findall(r'^(?:ok \d+ - |✔ )fixture \d+(?:$| \()', default, re.M)))

    def abort_sharded(self, script, out):
        import signal
        import time
        runs = out.parent / '.frontend-coverage-runs'
        previous = set(runs.glob('run-*'))
        env = {**os.environ, 'JE_FRONTEND_SHARDS': '2', 'JE_ARTIFACT_ABORT': '1',
               'JE_NODE_FILE_CONCURRENCY': '8', 'JE_NODE_NESTED_CONCURRENCY': '8', 'JE_SPEED_PROFILE': '1'}
        env.pop('JE_FRONTEND_COVERAGE_ROOT', None)
        child = subprocess.Popen(['node', str(script)], env=env, start_new_session=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            for _ in range(100):
                current = set(runs.glob('run-*')) - previous
                if any(list(run.glob('shard-*/raw/*.json')) for run in current):
                    break
                if child.poll() is not None:
                    self.fail('Sharded fixture exited before it could be interrupted')
                time.sleep(0.05)
            else:
                self.fail('Sharded fixture did not produce counters within five seconds')
        finally:
            # Only this test's recorded process group, including its Node workers.
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
            child.communicate(timeout=10)
        self.assertNotEqual(0, child.returncode)

    @staticmethod
    def tree(out):
        return sorted(str(p.relative_to(out)) for p in out.rglob('*') if p.is_file())


class BackendArtifactTreeTests(unittest.TestCase):
    def test_real_default_artifact_tree_and_schemas_match_pre_medium(self):
        import re
        import xml.etree.ElementTree as ET
        if not shutil.which('dotnet') or not re.search(r'^10\.', subprocess.check_output(['dotnet', '--list-sdks'], text=True), re.M):
            self.skipTest('Artifact layout probe requires SDK 10')
        cache = Path(os.environ.get('NUGET_PACKAGES') or Path.home() / '.nuget/packages')
        if not all((cache / package).is_dir() for package in (
                'microsoft.net.test.sdk/17.12.0', 'xunit/2.9.3',
                'xunit.runner.visualstudio/3.0.2', 'coverlet.collector/6.0.4')):
            self.skipTest('Artifact layout probe requires restored pinned test packages')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / 'tests/backend/JE.Tests.csproj'
            project.parent.mkdir(parents=True)
            product = root / 'fixture/Jellyfin.Plugin.JellyfinEnhanced.csproj'
            product.parent.mkdir()
            product.write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>'
                               '</PropertyGroup></Project>')
            (product.parent / 'Fixture.cs').write_text('public static class Fixture { public static int Value() => 42; }')
            project.write_text('''<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
<TargetFramework>net10.0</TargetFramework><IsTestProject>true</IsTestProject><NuGetAudit>false</NuGetAudit>
</PropertyGroup><ItemGroup><ProjectReference Include="../../fixture/Jellyfin.Plugin.JellyfinEnhanced.csproj"/>
<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0"/>
<PackageReference Include="xunit" Version="2.9.3"/>
<PackageReference Include="xunit.runner.visualstudio" Version="3.0.2"/>
<PackageReference Include="coverlet.collector" Version="6.0.4"/>
</ItemGroup></Project>''')
            (project.parent / 'FixtureTests.cs').write_text('public class FixtureTests { [Xunit.Fact] '
                'public void ValueIsFortyTwo() { Xunit.Assert.Equal(42, Fixture.Value()); } }')
            baseline = root / 'baseline'
            # Frozen b1a9ee65f default command, before the MEDIUM tier.
            command = ['dotnet', 'test', str(project), '-c', 'Release', '-p:JellyfinTarget=jf12',
                       '-p:RestoreLockedMode=true', '--artifacts-path', str(baseline / 'build/jf12'),
                       '--results-directory', str(baseline / 'backend/jf12'), '--logger', 'trx', '--collect:XPlat Code Coverage']
            result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=90)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            validator = ROOT / 'tests/runner/coverage.py'
            result = subprocess.run([sys.executable, str(validator), str(baseline / 'backend/jf12')],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            spec = importlib.util.spec_from_file_location('run_tree_contract', ROOT / 'tests/run.py')
            runner = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runner)
            real_popen = subprocess.Popen
            class Pins:
                stdout = io.StringIO('Fixture pin prerequisites\n')
                def wait(self): return 0
            def launch(command, **kwargs):
                if 'tests/backend/jellyfin_api.py' in command:
                    return Pins()
                if 'tests/runner/coverage.py' in command:
                    command[1] = str(validator)
                return real_popen(command, **kwargs)
            artifacts = root / 'artifacts/regression'
            with patch.object(sys, 'argv', ['run.py', 'backend', '--target', 'jf12']), \
                 patch.object(runner, 'ROOT', root), patch.object(runner, 'check_preflight'), \
                 patch.object(runner.subprocess, 'Popen', side_effect=launch):
                self.assertEqual(0, runner.main())
            def tree(directory):
                files = {}
                for path in directory.rglob('*'):
                    if not path.is_file(): continue
                    name = str(path.relative_to(directory))
                    name = re.sub(r'[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}', '<collector>', name)
                    name = re.sub(r'[^/]+\.trx$', '<run>.trx', name)
                    name = re.sub(r'\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}', '<time>', name)
                    if path.suffix == '.trx' or path.name == 'coverage.cobertura.xml':
                        schema = sorted({(element.tag.rsplit('}', 1)[-1], tuple(sorted(element.attrib)))
                                         for element in ET.parse(path).iter()})
                    elif path.name == 'coverage-summary.json':
                        schema = sorted(json.loads(path.read_text()).keys())
                    else:
                        schema = None
                    files[name] = schema
                return files
            for subtree in ('backend/jf12', 'build/jf12'):
                self.assertEqual(tree(baseline / subtree), tree(artifacts / subtree))
