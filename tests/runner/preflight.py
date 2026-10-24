"""Cheap prerequisite checks performed before the expensive legs."""
import json
import re
import subprocess


def check(root, suites, targets, environment):
    errors = []
    node_suites = {'tooling', 'frontend', 'browser', 'visual', 'poster', 'mutation', 'history', 'host'}
    backend_suites = {'backend', 'host', 'poster', 'mutation', 'history'}
    if node_suites.intersection(suites):
        version = subprocess.check_output(['node', '--version'], text=True).strip()
        match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', version)
        if not match or tuple(map(int, match.groups())) < (22, 12, 0):
            errors.append('Node >=22.12.0 is required')
        package = json.loads((root / 'package.json').read_text())
        lock = json.loads((root / 'package-lock.json').read_text())
        if package['devDependencies'] != lock['packages']['']['devDependencies']:
            errors.append('package.json and package-lock.json disagree; run npm ci after fixing the lock')
        for name in package['devDependencies']:
            expected = lock['packages'].get('node_modules/' + name, {}).get('version')
            metadata = root / 'node_modules' / name / 'package.json'
            installed = json.loads(metadata.read_text()).get('version') if metadata.is_file() else None
            if not expected or installed != expected:
                errors.append(f'Missing/mismatched pinned JavaScript dependency {name}; run npm ci')
        try:
            files = int(environment.get('JE_NODE_FILE_CONCURRENCY', '8'))
            shards = int(environment.get('JE_FRONTEND_SHARDS', '1'))
            nested = int(environment.get('JE_NODE_NESTED_CONCURRENCY', '8'))
            if files not in range(1, 9) or shards not in range(1, min(4, files) + 1) or nested not in range(1, 9) or files + min(files, 2) * (nested - 1) > 22:
                raise ValueError()
        except ValueError:
            errors.append('Invalid frontend worker budget: 1–8 file workers, 1–4 shards <= workers, 1–8 nested cases and <=22 asynchronous cases')
    if backend_suites.intersection(suites):
        runtimes = subprocess.check_output(['dotnet', '--list-runtimes'], text=True)
        sdk = subprocess.check_output(['dotnet', '--version'], text=True).strip()
        for target in targets:
            major = 10 if target == 'jf12' else 9
            for framework in ('Microsoft.NETCore.App', 'Microsoft.AspNetCore.App'):
                if not re.search(r'^' + re.escape(framework) + r' ' + str(major) + r'\.', runtimes, re.M):
                    errors.append(f'Missing {framework} {major}.x runtime for {target}')
            if int(sdk.split('.')[0]) < major:
                errors.append(f'Missing .NET SDK >= {major} for {target}')
            for directory in ('tests/backend', 'Jellyfin.Plugin.JellyfinEnhanced'):
                if not (root / directory / f'packages.{target}.lock.json').is_file():
                    errors.append(f'Missing pinned dependency lock for {target}: {directory}')
    if errors:
        raise ValueError('; '.join(errors))
