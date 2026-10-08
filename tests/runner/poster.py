#!/usr/bin/env python3
"""Run real native rendering, pipeline, and JS/C# resolver parity without a server."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', type=Path, default=ROOT / 'artifacts/regression/poster')
    args = parser.parse_args()
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    for tool in ('dotnet', 'node'):
        if not shutil.which(tool):
            parser.error(f'Missing {tool}; see tests/docs/README.md')
    commands = [
        ['dotnet', 'run', '--project', 'tests/poster/pipeline', '-c', 'Release'],
        ['node', 'tests/poster/parity/run.mjs', '--offline'],
    ]
    for skia in ('3.116.1', '3.119.4'):
        commands.append(['dotnet', 'run', '--project', 'tests/poster/rendering', '-c', 'Release', f'-p:Skia={skia}', '--', 'assets', '--out', str(artifacts / skia)])
    failed = False
    for index, command in enumerate(commands):
        print('$ ' + ' '.join(command), flush=True)
        with (artifacts / f'{index:02d}.log').open('w') as log:
            process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in process.stdout:
                print(line, end='', flush=True)
                log.write(line)
            failed |= process.wait() != 0
    parity = ROOT / 'tests/poster/parity/data/out'
    if parity.exists():
        shutil.copytree(parity, artifacts / 'parity', dirs_exist_ok=True)
    return int(failed)

if __name__ == '__main__':
    sys.exit(main())
