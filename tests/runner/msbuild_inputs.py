"""Obtain evaluated file inputs across the MSBuild project closure, fail closed.

Preprocessing is MSBuild's flattened evaluation, including implicit SDK imports.
Its delimited source markers identify the files actually imported; inactive
imports remain XML comments and are deliberately not guessed from their text.
"""
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET


def preprocessed_paths(text, project):
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    tree = ET.fromstring(text, parser=parser)
    paths = {project.resolve()}
    # Require the known MSBuild source-marker format, including the root marker.
    header = text.split('-->', 1)[0].splitlines()
    if str(project.resolve()) not in [line.strip() for line in header]:
        raise ValueError('MSBuild preprocessing did not identify the root project')
    for element in tree.iter():
        if element.tag is ET.Comment:
            lines = [line.strip() for line in (element.text or '').splitlines() if line.strip()]
            if len(lines) < 2 or not lines[0].startswith('=' * 20) or not lines[1].startswith('<Import '):
                continue
            if not lines[-1].startswith('=' * 20) or len(lines) < 3:
                raise ValueError('Unrecognized MSBuild import marker')
            path = Path(lines[-2])
            if not path.is_absolute() or not path.is_file():
                raise ValueError('MSBuild import is missing or not an absolute file: ' + str(path))
            paths.add(path.resolve())
        elif isinstance(element.tag, str) and element.tag.rsplit('}', 1)[-1] == 'Import':
            raise ValueError('MSBuild preprocessing left an unexpanded import')
    return paths


# Each key must be present even when that item list is empty. MSBuild supplies
# absolute FullPath metadata, including for linked files outside the checkout.
FILE_ITEMS = ('Compile', 'EmbeddedResource', 'AdditionalFiles', 'Analyzer', 'EditorConfigFiles')
ITEMS = ('ProjectReference', *FILE_ITEMS, 'Content', 'None', 'Reference', 'PackageReference')


def collect(root, properties, build_directory, diagnostics=None):
    """Return the proven transitive file closure, or None when evaluation fails.

    This runner builds a single target/configuration. Reference property overrides
    and multi-target projects require a graph evaluator; reject those rather than
    silently evaluating a different configuration. Fresh builds remain available.
    """
    project = root / 'tests/backend/JE.Tests.csproj'
    try:
        arguments = []
        index = 0
        while index < len(properties):
            value = properties[index]
            if value == '-c':
                index += 1
                arguments.append('-p:Configuration=' + properties[index])
            else:
                arguments.append(value)
            index += 1
        arguments.append('-p:ArtifactsPath=' + str(build_directory))
        pending = [(root / 'tests/backend/JE.Tests.csproj').resolve()]
        visited, paths = set(), set()
        while pending:
            project = pending.pop()
            if project in visited:
                continue
            visited.add(project)
            command = ['dotnet', 'msbuild', str(project), '-nologo', '-verbosity:quiet', *arguments]
            def evaluate(option):
                return subprocess.check_output(command + option, cwd=root, text=True,
                                               stderr=subprocess.PIPE, timeout=60)
            flattened = evaluate(['-preprocess'])
            paths.update(preprocessed_paths(flattened, project))
            data = json.loads(evaluate([
                '-getProperty:MSBuildProjectFullPath,TargetFrameworks,NuGetLockFilePath,RestorePackagesWithLockFile',
                '-getItem:' + ','.join(ITEMS)]))
            items = data['Items']
            for kind in ITEMS:
                if not isinstance(items[kind], list) or any(not isinstance(item, dict) for item in items[kind]):
                    raise ValueError('Cannot enumerate evaluated item kind ' + kind)
            def item_path(item):
                path = Path(item['FullPath'])
                if not path.is_absolute():
                    raise ValueError('Evaluated input is not absolute: ' + str(path))
                return path.resolve()
            project_files = set()
            for kind in FILE_ITEMS:
                project_files.update(item_path(item) for item in items[kind])
            for kind in ('Content', 'None'):
                for item in items[kind]:
                    if item.get('CopyToOutputDirectory', '').lower() not in ('', 'never'):
                        project_files.add(item_path(item))
            for item in items['Reference']:
                if item.get('HintPath'):
                    hint = Path(item['HintPath'].replace('\\', '/'))
                    project_files.add((project.parent / hint).resolve())
            paths.update(project_files)
            evaluated = data['Properties']
            if Path(evaluated['MSBuildProjectFullPath']).resolve() != project or evaluated['TargetFrameworks']:
                raise ValueError('Unsupported or ambiguous project evaluation')
            lock = evaluated['NuGetLockFilePath']
            if lock:
                lock_path = Path(lock)
                if not lock_path.is_absolute():
                    lock_path = project.parent / lock_path
                paths.add(lock_path.resolve())
            elif evaluated['RestorePackagesWithLockFile'].lower() == 'true':
                paths.add(project.parent / 'packages.lock.json')
            # Existing default locks are restore inputs even when the property
            # is not explicitly enabled (NuGet uses a present lock by default).
            default_lock = project.parent / 'packages.lock.json'
            if default_lock.exists():
                paths.add(default_lock.resolve())
            for reference in items['ProjectReference']:
                if any(reference.get(name) for name in ('AdditionalProperties', 'GlobalPropertiesToRemove',
                       'SetConfiguration', 'SetPlatform', 'SetTargetFramework', 'UndefineProperties')):
                    raise ValueError('Project reference overrides require graph evaluation')
                pending.append(item_path(reference))
            # Roslyn discovers .editorconfig/.globalconfig above Compile paths,
            # including linked sources. Include ancestors conservatively as well
            # as MSBuild's evaluated EditorConfigFiles (which includes existing
            # GlobalAnalyzerConfigFiles, not its nonexistent candidate paths).
            for file in project_files | {project}:
                for directory in file.parents:
                    for name in ('.editorconfig', '.globalconfig'):
                        candidate = directory / name
                        if candidate.exists():
                            paths.add(candidate.resolve())
            # SDK selection and NuGet configuration can live above the checkout.
            # Import discovery itself comes exclusively from MSBuild, not a glob.
            for directory in (project.parent, *project.parents, root, *root.parents):
                for name in ('global.json', 'NuGet.Config', 'nuget.config'):
                    candidate = directory / name
                    if candidate.is_file():
                        paths.add(candidate.resolve())
        # Listed inputs must be real readable files, never silently discarded.
        for path in paths:
            if not path.is_file():
                raise ValueError('Evaluated input is missing or not a file: ' + str(path))
            with path.open('rb') as source:
                source.read(1)
        return sorted(paths)
    except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError, ET.ParseError, subprocess.SubprocessError) as error:
        if diagnostics is not None:
            diagnostics.append('MSBuild evaluated input closure unavailable for ' + str(project) + ': ' + str(error))
        return None
