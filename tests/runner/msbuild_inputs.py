"""Obtain effective imports and project references from MSBuild, fail closed.

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


def collect(root, properties, build_directory):
    """Return the proven transitive file closure, or None when evaluation fails.

    This runner builds a single target/configuration. Reference property overrides
    and multi-target projects require a graph evaluator; reject those rather than
    silently evaluating a different configuration. Fresh builds remain available.
    """
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
                '-getItem:ProjectReference']))
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
            for reference in data['Items']['ProjectReference']:
                if any(reference.get(name) for name in ('AdditionalProperties', 'GlobalPropertiesToRemove',
                       'SetConfiguration', 'SetPlatform', 'SetTargetFramework', 'UndefineProperties')):
                    raise ValueError('Project reference overrides require graph evaluation')
                pending.append(Path(reference['FullPath']).resolve())
            # SDK selection and NuGet configuration can live above the checkout.
            # Import discovery itself comes exclusively from MSBuild, not a glob.
            for directory in (project.parent, *project.parents, root, *root.parents):
                for name in ('global.json', 'NuGet.Config', 'nuget.config'):
                    candidate = directory / name
                    if candidate.is_file():
                        paths.add(candidate.resolve())
        # A missing declared lock file is not a proven restore input closure.
        if not all(path.is_file() for path in paths):
            return None
        return sorted(paths)
    except (OSError, ValueError, KeyError, IndexError, TypeError, ET.ParseError, subprocess.SubprocessError):
        return None
