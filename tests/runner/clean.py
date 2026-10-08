#!/usr/bin/env python3
"""Validate local, uncommitted changes in a fresh disposable source tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=['fast', 'all'], default='all')
    parser.add_argument('--target', choices=['jf10', 'jf12', 'all'], default='all')
    parser.add_argument('--artifacts', type=Path, default=ROOT / 'artifacts' / 'clean')
    args = parser.parse_args()
    output = args.artifacts.resolve()
    output.mkdir(parents=True, exist_ok=True)
    files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    manifest = {}
    result = {'status': 'failed', 'suite': args.suite, 'target': args.target}
    with tempfile.TemporaryDirectory(prefix='je-clean-') as temp:
        work = Path(temp) / 'source'
        work.mkdir()
        for relative in sorted(set(files) - {''}):
            source = ROOT / relative
            if not source.exists():
                continue  # A local tracked deletion belongs to this snapshot too.
            destination = work / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.is_symlink():
                destination.symlink_to(os.readlink(source))
            else:
                shutil.copy2(source, destination)
                manifest[relative] = hashlib.sha256(source.read_bytes()).hexdigest()
        (output / 'source-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        try:
            with (output / 'install.log').open('w') as log:
                subprocess.run(['npm', 'ci'], cwd=work, check=True, stdout=log, stderr=subprocess.STDOUT)
            with (output / 'run.log').open('w') as log:
                completed = subprocess.run([sys.executable, 'tests/run.py', args.suite, '--target', args.target,
                    '--artifacts', str(output / 'regression')], cwd=work, stdout=log, stderr=subprocess.STDOUT)
            result.update(status='passed' if completed.returncode == 0 else 'failed', exit_code=completed.returncode)
        except (OSError, subprocess.CalledProcessError) as error:
            result['error'] = str(error)
        finally:
            for name in ('frontend-coverage', 'browser'):
                source = work / 'artifacts' / name
                if source.exists():
                    shutil.copytree(source, output / name, dirs_exist_ok=True)
            (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print(f'Fresh-tree reports: {output}')
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
