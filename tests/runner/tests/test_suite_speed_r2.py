"""Second-recurrence regressions: evaluated build inputs and frozen default schema."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/runner'))
import backend
import msbuild_inputs


@unittest.skipUnless(shutil.which('dotnet'), 'Evaluated file inputs require the .NET SDK')
class EvaluatedInputTests(unittest.TestCase):
    def fixture(self, parent):
        root = parent / 'repo'
        project = root / 'tests/backend/JE.Tests.csproj'
        project.parent.mkdir(parents=True)
        support = project.parent / 'Support'
        support.mkdir()
        (support / 'jellyfin-api.json').write_text(json.dumps({'jf12': {
            'version': 'fixture', 'image': 'fixture@sha256:' + 'a' * 64}}))
        reference = parent / 'external/Reference.csproj'
        reference.parent.mkdir()
        reference.write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>'
                             '</PropertyGroup></Project>')
        source = reference.parent / 'Value.cs'
        source.write_text('public static class Value { public static string Marker => "BEFORE"; }')
        project.write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>'
                           '<OutputType>Exe</OutputType></PropertyGroup><ItemGroup>'
                           '<ProjectReference Include="../../../external/Reference.csproj"/></ItemGroup></Project>')
        (project.parent / 'Program.cs').write_text('System.Console.WriteLine(Value.Marker);')
        # Restore only from the installed SDK/package cache, never the network.
        (parent / 'NuGet.Config').write_text('<configuration><packageSources><clear /></packageSources></configuration>')
        build = root / 'artifacts/build/jf12/snapshot'
        build.parent.mkdir(parents=True)
        return root, reference, source, build

    def warm(self, build):
        for _ in range(3):  # A cold restore may change imports before a stamp exists.
            receipt = backend.prepare_build('jf12', build, True)
            if receipt['reused']:
                return receipt
        self.fail('Unchanged evaluated inputs never established a warm reuse stamp')

    def output(self, build):
        assembly = next((build / 'bin/JE.Tests').rglob('JE.Tests.dll'))
        return subprocess.check_output(['dotnet', str(assembly)], text=True).strip()

    def test_external_source_edit_changes_identity_rebuilds_and_prints_after(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, reference, source, build = self.fixture(Path(temporary))
            with patch.object(backend, 'ROOT', root):
                first = self.warm(build)
                self.assertEqual('BEFORE', self.output(build))
                source.write_text('public static class Value { public static string Marker => "AFTER"; }')
                second = backend.prepare_build('jf12', build, True)
                self.assertNotEqual(first['identity'], second['identity'], 'External Compile edit escaped identity')
                self.assertFalse(second['reused'])
                self.assertEqual('AFTER', self.output(build))

    def test_unreadable_external_input_disables_reuse_and_records_the_reason(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, reference, source, build = self.fixture(Path(temporary))
            read_bytes = Path.read_bytes
            def read(path):
                if path == source:
                    raise PermissionError('fixture unreadable input: ' + str(path))
                return read_bytes(path)
            with patch.object(backend, 'ROOT', root):
                self.warm(build)
                # Inject EACCES at the real content-hashing boundary. chmod is
                # unreliable when a tooling job happens to run as root.
                with patch.object(Path, 'read_bytes', read):
                    first = backend.prepare_build('jf12', build, True)
                    second = backend.prepare_build('jf12', build, True)
                self.assertFalse(first['reused'], 'Unreadable evaluated source reused stale output')
                self.assertFalse(second['reused'])
                self.assertFalse(first['reuse_eligible'])
                self.assertNotEqual(first['identity'], second['identity'])
                self.assertIn(str(source), first['reuse_disabled_reason'])
                self.assertFalse((build.parent / 'build-identity.json').exists())

    def test_all_item_kinds_in_the_transitive_external_project_change_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root, reference, source, build = self.fixture(parent)
            # The source-containing project is two edges from the test project.
            leaf = parent / 'leaf/Leaf.csproj'
            leaf.parent.mkdir()
            leaf.write_text(reference.read_text())
            source.rename(leaf.parent / source.name)
            source = leaf.parent / source.name
            reference.write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>'
                                 '</PropertyGroup><ItemGroup><ProjectReference Include="../leaf/Leaf.csproj"/></ItemGroup></Project>')
            files = {'Compile': source}
            items = []
            for kind, name, metadata in (
                ('EmbeddedResource', 'resource.bin', ''), ('AdditionalFiles', 'additional.txt', ''),
                ('Analyzer', 'analyzer.dll', ''), ('Content', 'content.dat', 'CopyToOutputDirectory="Always"'),
                ('None', 'copied.dat', 'CopyToOutputDirectory="PreserveNewest"'),
                ('Reference', 'reference.dll', ''), ('EditorConfigFiles', 'named.config', ''),
                ('GlobalAnalyzerConfigFiles', 'named.globalconfig', '')):
                path = parent / 'linked' / name
                path.parent.mkdir(exist_ok=True)
                path.write_text('before')
                files[kind] = path
                if kind == 'Reference':
                    items.append(f'<Reference Include="Linked"><HintPath>{path}</HintPath></Reference>')
                else:
                    items.append(f'<{kind} Include="{path}" {metadata}/>')
            lock = leaf.parent / 'packages.lock.json'
            lock.write_text('{}')
            files['lock'] = lock
            for name in ('.editorconfig', '.globalconfig'):
                files[name] = leaf.parent / name
                files[name].write_text('root = true\n')
            props = leaf.parent / 'Directory.Build.props'
            props.write_text('<Project/>')
            files['Directory.Build.props'] = props
            leaf.write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework>'
                            '<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile></PropertyGroup><ItemGroup>'
                            + ''.join(items) + '</ItemGroup></Project>')
            properties = ['-c', 'Release']
            # Evaluate membership for real once. These edits change only bytes,
            # so avoid restarting MSBuild for every kind; the executable probe
            # above separately exercises reevaluation across real invocations.
            paths = msbuild_inputs.collect(root, properties, build)
            self.assertIsNotNone(paths)
            with patch.object(backend, 'ROOT', root), patch.object(backend, 'msbuild_inputs', return_value=paths):
                before = backend.build_identity('jf12', properties, root / 'artifacts')
                self.assertIsNotNone(before)
                for kind, path in files.items():
                    with self.subTest(kind=kind):
                        original = path.read_bytes()
                        # Keep evaluated XML/JSON/config syntactically valid.
                        path.write_bytes(original + (b'<!--changed-->' if path.suffix == '.props' else b'\n '))
                        try:
                            self.assertNotEqual(before, backend.build_identity('jf12', properties, root / 'artifacts'), kind)
                        finally:
                            path.write_bytes(original)

    def test_missing_item_enumeration_is_unproven_instead_of_empty(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, reference, source, build = self.fixture(Path(temporary))
            evaluate = subprocess.check_output
            def omit_item(command, **kwargs):
                result = evaluate(command, **kwargs)
                if any(arg.startswith('-getItem:') for arg in command):
                    data = json.loads(result)
                    data['Items'].pop('AdditionalFiles', None)
                    return json.dumps(data)
                return result
            with patch.object(msbuild_inputs.subprocess, 'check_output', side_effect=omit_item):
                self.assertIsNone(msbuild_inputs.collect(root, ['-c', 'Release'], build),
                                  'Missing item-kind enumeration must disable reuse')


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
            manifest['identity'] = 'f' * 64
            for index, shard in enumerate(manifest['shards']):
                shard.update(exit_code=0, identity='f' * 64)
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
