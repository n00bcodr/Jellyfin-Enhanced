#!/usr/bin/env python3
"""Put a build of an upstream commit on this checkout's je12 lab, for the side-by-side check of a port.

  JE12=<path to the je12 script> scripts/upstream_lab_deploy.py <upstream ref>

`je12 deploy` only builds trees of the rewrite (it runs `npm run client:build` first, which upstream does not have).
This does what `je12 deploy --base REF` does for an upstream commit instead: a detached snapshot worktree of the
commit under $JE12_HOME/snap, the Jellyfin 12 plugin build (as je-upstream-bench/run.sh builds one, under je12's
dotnet lock), then je12's own install-and-restart into the lab `je12 up` started. The lab's deployed label becomes
`upstream-<sha>`, so `je12 browse|api … --keep before` records which build answered. `je12 deploy` puts the working
tree back; `je12 down` removes the snapshot with the lab.

It starts no server and reaches nothing but the lab. It uses je12's internal functions, so it follows the je12
version in $JE12; if that breaks, the same steps belong in je12 itself as `je12 deploy --upstream REF`.
"""
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def load_je12():
    path = os.environ.get('JE12') or shutil.which('je12')
    if not path or not Path(path).is_file():
        sys.exit('upstream_lab_deploy: set JE12 to the je12 script (…/je12/scripts/je12)')
    loader = importlib.machinery.SourceFileLoader('je12_tool', str(path))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader('je12_tool', loader))
    loader.exec_module(module)
    return module


def main(argv):
    if len(argv) != 1 or argv[0].startswith('-'):
        sys.exit(__doc__.strip())
    je12 = load_je12()
    root = je12.repo_root()
    state = je12.lab(root, need_running=False, enter=False)
    sha = subprocess.run(['git', '-C', str(root), 'rev-parse', '--verify', f'{argv[0]}^{{commit}}'],
                         capture_output=True, text=True).stdout.strip()
    if not sha:
        sys.exit(f'upstream_lab_deploy: unknown ref {argv[0]} (run scripts/upstream_sync.py update, or git fetch origin)')
    if (Path(subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], capture_output=True, text=True).stdout.strip())
            / 'client/src').is_dir() and subprocess.run(['git', '-C', str(root), 'cat-file', '-e', f'{sha}:client/src'], capture_output=True).returncode == 0:
        sys.exit(f'upstream_lab_deploy: {sha[:12]} is a rewrite commit (it has client/src); use je12 deploy --base {argv[0]}')

    started = time.time()
    key = je12.key_of(root)
    snapshot = je12.HOME / 'snap' / f'{key}-{sha[:12]}'
    if not (snapshot / '.git').exists():
        shutil.rmtree(snapshot, ignore_errors=True)
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['git', '-C', str(root), 'worktree', 'add', '--detach', str(snapshot), sha], check=True, capture_output=True)
    artifacts = je12.HOME / 'build' / f'{key}-snap-{sha[:12]}'
    dll = artifacts / 'bin/JellyfinEnhanced/release' / je12.DLL
    with je12.Lock('dotnet', 'dotnet build or test'):
        build = subprocess.run(['nice', '-n', '10', 'dotnet', 'build', je12.PROJ, '-c', 'Release', '-p:JellyfinTarget=jf12',
                                '-p:UseSharedCompilation=false', '-nodeReuse:false', '--artifacts-path', str(artifacts),
                                '-nologo', '-tl:off', '-clp:NoSummary'], cwd=snapshot, capture_output=True, text=True)
    if build.returncode or not dll.is_file():
        sys.exit('upstream_lab_deploy: the upstream build failed:\n' + (build.stdout + build.stderr)[-2500:])
    print(f'build: upstream {sha[:12]} ok in {time.time() - started:.0f}s', flush=True)

    label = f'upstream-{sha[:12]}'
    je12.backend_of(state).enter(state)
    took = je12.restart_with(root, state, dll, label, sha)
    if state.get('mock'):
        je12.seed_mock_users(state)
    print(f"deployed {label} (dll {state['dll']}) to {je12.lab_url(state)}: restart {took:.0f}s, total {time.time() - started:.0f}s")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
