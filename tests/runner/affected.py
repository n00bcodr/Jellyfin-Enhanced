#!/usr/bin/env python3
"""Affected tests: run only the tests whose recorded inputs a change touches. An inner-loop mode, never a merge gate.

    affected.py record [--jobs N] [--suites frontend,client-build,boundary,browser,dotnet]   (minutes; once per base)
    affected.py select [--map FILE] [--json]          what a change selects, and why
    affected.py run    [--map FILE]                   select, then run: node files, Playwright specs, the dotnet suite

The map is built by running every test file once under `strace -f` and recording, per file, every path under the
checkout that it (or anything it started: a fixture server, a browser, a build) opened, stat'ed or listed, including
paths it looked for and did not find. It is keyed by the commit it was recorded at and the Node and package-lock
versions.

A test file is selected when, between the map's commit and the working tree (committed, staged, unstaged and untracked):
  - a path it read, or looked for and did not find, was added, changed or deleted;
  - a file was added to or removed from a directory it listed;
  - the test file itself changed or is new (not in the map);
  - or anything global changed: package.json / package-lock.json, the Node version, the node test runner and reporter
    (tests/frontend/run.mjs, tests/frontend/helpers/discovery.mjs, scripts/restructure-gates*), the Playwright config.
The dotnet suite (whole, it is one assembly) is selected when a change is under the plugin, the backend tests, their
fixtures or the build files, or touches a path the dotnet test run read at runtime (recorded the same way).
Unknown state fails open: no map, a map from another Node or lockfile, or a diff git cannot compute selects everything.

Why tracing and not an import graph: the node tests read the generated js/** with readFileSync, compile client/src
through esbuild, list directories (servedEngine reads every Configuration/admin/*.js) and start child processes; the
browser specs add scripts by path and fetch through the fixture server. Static imports see almost none of that; the
kernel sees all of it. The assumption is determinism: a test that read the same bytes behaves the same. Time,
randomness, the network and the machine's load are outside it; that is what the full gates are for.
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAP = Path(os.environ.get('JE_AFFECTED_MAP') or ROOT / 'node_modules/.cache/je-affected/map.json')
SUITES = ('frontend', 'client-build', 'boundary', 'browser', 'dotnet')
GLOBAL = ('package.json', 'package-lock.json', 'tests/frontend/run.mjs', 'tests/frontend/helpers/discovery.mjs',
          'scripts/restructure-gates.sh', 'scripts/restructure-gates-reporter.mjs', 'tests/browser/playwright.config.cjs',
          'tests/runner/affected.py')
DOTNET_TREES = ('Jellyfin.Plugin.JellyfinEnhanced/', 'tests/backend/', 'tests/fixtures/')
DOTNET_FILES = ('Directory.Build.targets', 'Directory.Build.props', 'global.json', 'NuGet.config', 'nuget.config')
IGNORED = ('.git/', 'node_modules/', 'artifacts/', 'tests/backend/bin/', 'tests/backend/obj/',
           'Jellyfin.Plugin.JellyfinEnhanced/bin/', 'Jellyfin.Plugin.JellyfinEnhanced/obj/', 'tools/ClientContracts/bin/',
           'tools/ClientContracts/obj/')
STRACE = ['strace', '-f', '-qq', '-y', '--seccomp-bpf', '-e', 'signal=none', '-e',
          'trace=open,openat,openat2,stat,lstat,newfstatat,statx,access,faccessat,faccessat2,readlink,readlinkat,execve']
LINE = re.compile(r'^(\d+)\s+(\w+)\((.*)\)\s+=\s+(-?\d+|\?)(?:\s+(\w+))?')
PATH_ARG = re.compile(r'(?:^|, )(?:(\w+|-?\d+)(?:<([^>]*)>)?, )?"((?:[^"\\]|\\.)*)"')


def git(*args, check=True):
    r = subprocess.run(['git', '-C', str(ROOT), *args], capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f'git {" ".join(args)}: {r.stderr.strip()}')
    return r.stdout


def node_version():
    return subprocess.run(['node', '--version'], capture_output=True, text=True).stdout.strip()


def lock_hash():
    return hashlib.sha256((ROOT / 'package-lock.json').read_bytes()).hexdigest()[:16]


# ------------------------------------------------------------------ recording

def rel(path):
    """Repository-relative path, or None for anything outside the checkout or ignored."""
    try:
        p = os.path.normpath(path)
        r = os.path.relpath(p, ROOT)
    except ValueError:
        return None
    if r.startswith('..') or r == '.':
        return None
    r = r.replace(os.sep, '/')
    if any(r.startswith(i) or r + '/' == i for i in IGNORED):
        return None
    return r


def parse_trace(text, cwd):
    """-> (read paths, listed directories, looked-for-but-missing paths), repository-relative."""
    reads, dirs, missing = set(), set(), set()
    pending = {}
    for line in text.splitlines():
        # Threads interleave: `PID call(args <unfinished ...>` then `PID <... call resumed>rest) = ret`.
        u = re.match(r'^(\d+)\s+(\w+)\((.*) <unfinished \.\.\.>$', line)
        if u:
            pending[(u.group(1), u.group(2))] = u.group(3)
            continue
        rz = re.match(r'^(\d+)\s+<\.\.\. (\w+) resumed>(.*)$', line)
        if rz:
            head = pending.pop((rz.group(1), rz.group(2)), None)
            if head is None:
                continue
            line = f'{rz.group(1)} {rz.group(2)}({head}{rz.group(3)}'
        m = LINE.match(line)
        if not m:
            continue
        call, args, ret, err = m.group(2), m.group(3), m.group(4), m.group(5)
        pm = PATH_ARG.search(args)
        if not pm:
            continue
        dirfd_path, path = pm.group(2), pm.group(3).encode().decode('unicode_escape', 'ignore')
        if not path.startswith('/'):
            base = dirfd_path if dirfd_path and dirfd_path.startswith('/') else str(cwd)
            path = os.path.join(base, path)
        r = rel(path)
        if r is None:
            continue
        ok = ret not in ('-1', '?')
        if call.startswith('open') and ok and 'O_DIRECTORY' in args:
            dirs.add(r)
        elif ok:
            reads.add(r)
        elif err in ('ENOENT', 'ENOTDIR'):
            missing.add(r)
    # A path read is not also "missing" because one probe failed first.
    return sorted(reads), sorted(dirs), sorted(missing - reads - dirs)


def traced(cmd, env, cwd=ROOT, timeout=900):
    with tempfile.TemporaryDirectory(prefix='je-affected-') as tmp:
        out = Path(tmp) / 'trace'
        t = time.time()
        r = subprocess.run(STRACE + ['-o', str(out), '--', *cmd], cwd=cwd, env=env, capture_output=True, text=True,
                           timeout=timeout)
        text = out.read_text(errors='replace') if out.exists() else ''
        reads, dirs, missing = parse_trace(text, cwd)
        return {'rc': r.returncode, 'seconds': round(time.time() - t, 1), 'reads': reads, 'dirs': dirs, 'missing': missing,
                'tail': (r.stdout + r.stderr)[-600:] if r.returncode else ''}


def node_env():
    e = dict(os.environ, TZ='UTC', LANG='en_US.UTF-8', LC_ALL='en_US.UTF-8')
    e.pop('NODE_OPTIONS', None)
    return e


def frontend_files():
    return sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests/frontend').rglob('*.test.mjs'))


def suite_files(suite):
    if suite == 'frontend':
        return frontend_files()
    if suite == 'client-build':
        return sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests/client-build').glob('*.test.mjs'))
    if suite == 'boundary':
        return ['tools/ClientContracts/boundary.test.mjs']
    if suite == 'browser':
        return sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests/browser').glob('*.spec.cjs'))
    if suite == 'dotnet':
        return ['tests/backend/JE.Tests.csproj']
    raise ValueError(suite)


def record_one(suite, f, port):
    env = node_env()
    if suite in ('frontend', 'client-build', 'boundary'):
        return traced(['node', '--test', '--test-timeout=300000', f], env)
    if suite == 'browser':
        env['JE_BROWSER_PORT'] = str(port)
        out = tempfile.mkdtemp(prefix='je-affected-pw-')
        try:
            # One project is enough: every project loads the same files; the selection then runs all three.
            return traced(['node', 'node_modules/.bin/playwright', 'test', '--config', 'tests/browser/playwright.config.cjs',
                           '--project=chromium', '--workers=1', '--reporter=line', '--output', out, f], env)
        finally:
            shutil.rmtree(out, ignore_errors=True)
    if suite == 'dotnet':
        env.update(UseSharedCompilation='false', MSBUILDDISABLENODEREUSE='1', DOTNET_CLI_USE_MSBUILD_SERVER='0')
        lock = ['flock', '--close', os.environ['JE_DOTNET_LOCK']] if os.environ.get('JE_DOTNET_LOCK') else []
        return traced(lock + ['dotnet', 'test', f, '-c', 'Release', '--no-restore', '--no-build', '-p:JellyfinTarget=jf12'], env,
                      timeout=1800)
    raise ValueError(suite)


def record(args):
    if not shutil.which('strace'):
        print('affected: strace is not installed; the map needs it (apt install strace). Nothing recorded.', file=sys.stderr)
        return 2
    suites = args.suites.split(',')
    head = git('rev-parse', 'HEAD').strip()
    dirty = git('status', '--porcelain', '--untracked-files=no').strip()
    if dirty and not args.allow_dirty:
        print('affected: the tree has uncommitted changes; record on a clean commit (or --allow-dirty)', file=sys.stderr)
        return 2
    data = {'commit': head, 'node': node_version(), 'lock': lock_hash(), 'recorded': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'suites': {}}
    if MAP.exists() and args.update:
        old = json.loads(MAP.read_text())
        data['suites'] = old.get('suites', {})
    jobs = []
    port = 41790
    for s in suites:
        for f in suite_files(s):
            jobs.append((s, f, port))
            port += 1
    t0 = time.time()
    failed = []
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(record_one, s, f, p): (s, f) for s, f, p in jobs}
        for fut in cf.as_completed(futs):
            s, f = futs[fut]
            try:
                r = fut.result()
            except Exception as e:      # a file the tracer could not run is recorded as such: it is always selected
                r = {'rc': -1, 'error': str(e), 'reads': [], 'dirs': [], 'missing': []}
            data['suites'].setdefault(s, {})[f] = r
            if r['rc']:
                failed.append(f'{s}:{f} (exit {r["rc"]}) {r.get("tail", "")[-200:]}')
            print(f'affected: {s} {f}: {len(r["reads"])} reads, {len(r["dirs"])} dirs, {len(r["missing"])} missing, '
                  f'{r.get("seconds", "?")} s{"" if not r["rc"] else " FAILED"}', file=sys.stderr, flush=True)
    MAP.parent.mkdir(parents=True, exist_ok=True)
    MAP.write_text(json.dumps(data))
    print(f'affected: recorded {len(jobs)} files in {time.time() - t0:.0f} s at {head[:10]} -> {MAP}', file=sys.stderr)
    if failed:
        print('affected: these failed while recording (they are always selected):\n  ' + '\n  '.join(failed), file=sys.stderr)
    return 0


# ------------------------------------------------------------------ selecting

def changes(since):
    """{path: 'A'|'M'|'D'} between `since` and the working tree, untracked files included (as 'A')."""
    out = {}
    for line in git('diff', '--name-status', '--no-renames', since).splitlines():
        status, _, path = line.partition('\t')
        out[path] = status[0]
    for path in git('ls-files', '--others', '--exclude-standard').splitlines():
        out[path] = 'A'
    return out


def select(map_path=MAP, since=None, changed=None):
    """-> {'all': reason or None, 'suites': {suite: [files]}, 'why': {file: reason}, 'changed': {...}}
    `changed` ({path: A|M|D}) replaces the diff from the map commit (history replay)."""
    everything = {s: suite_files(s) for s in SUITES}
    if not map_path.exists():
        return {'all': f'no map at {map_path} (run: tests/runner/affected.py record)', 'suites': everything, 'why': {}, 'changed': {}}
    data = json.loads(map_path.read_text())
    base = since or data['commit']
    if changed is None:
        try:
            changed = changes(base)
        except RuntimeError as e:
            return {'all': f'cannot diff against the map commit: {e}', 'suites': everything, 'why': {}, 'changed': {}}
    if data.get('node') != node_version():
        return {'all': f'Node {node_version()}, map recorded with {data.get("node")}', 'suites': everything, 'why': {}, 'changed': changed}
    if data.get('lock') != lock_hash():
        return {'all': 'package-lock.json changed since the map', 'suites': everything, 'why': {}, 'changed': changed}
    glob_hit = sorted(p for p in changed if p in GLOBAL)
    if glob_hit:
        return {'all': f'global input changed: {", ".join(glob_hit)}', 'suites': everything, 'why': {}, 'changed': changed}
    added_removed_dirs = {}
    for p, st in changed.items():
        if st in ('A', 'D'):
            d = p.rsplit('/', 1)[0] if '/' in p else ''
            added_removed_dirs.setdefault(d, []).append(p)
    picked, why = {}, {}
    for suite in SUITES:
        recorded = data['suites'].get(suite, {})
        for f in everything[suite]:
            reason = None
            r = recorded.get(f)
            if suite == 'dotnet':
                hit = [p for p in changed if p.startswith(DOTNET_TREES) or p in DOTNET_FILES or p.endswith(('.csproj', '.props', '.targets'))]
                if hit:
                    reason = f'build input {hit[0]}'
            if reason is None and f in changed:
                reason = 'the test file changed'
            if reason is None and r is None:
                reason = 'not in the map (new test file)'
            if reason is None and r.get('rc'):
                reason = 'it failed while the map was recorded'
            if reason is None:
                reads, missing, dirs = set(r['reads']), set(r['missing']), set(r['dirs'])
                hit = next((p for p in changed if p in reads or p in missing), None)
                if hit:
                    reason = f'reads {hit}' if hit in reads else f'looked for {hit}'
                else:
                    d = next((d for d in added_removed_dirs if d in dirs), None)
                    if d is not None:
                        reason = f'lists {d or "."}, which gained or lost {added_removed_dirs[d][0]}'
            if reason:
                picked.setdefault(suite, []).append(f)
                why[f] = reason
    return {'all': None, 'suites': picked, 'why': why, 'changed': changed, 'map_commit': data['commit']}


def cmd_select(args):
    s = select(Path(args.map) if args.map else MAP, args.since)
    if args.json:
        print(json.dumps(s, indent=1))
        return 0
    total = {k: len(suite_files(k)) for k in SUITES}
    print(f"affected: {len(s['changed'])} changed path(s) since {s.get('map_commit', '?')[:10]}")
    if s['all']:
        print(f"affected: everything ({s['all']})")
    for suite in SUITES:
        files = s['suites'].get(suite, [])
        print(f"  {suite}: {len(files)} of {total[suite]}")
        for f in files[:40]:
            print(f"    {f}  [{s['why'].get(f, 'everything')}]")
    return 0


def cmd_run(args):
    s = select(Path(args.map) if args.map else MAP, args.since)
    rc = 0
    env = node_env()
    node = s['suites'].get('frontend', []) + s['suites'].get('client-build', []) + s['suites'].get('boundary', [])
    if node:
        print(f'affected: node test files: {len(node)}', file=sys.stderr, flush=True)
        r = subprocess.run(['node', '--test', '--test-timeout=300000', f'--test-concurrency={max(2, len(os.sched_getaffinity(0)) - 1)}', *node],
                           cwd=ROOT, env=env)
        rc |= r.returncode
    specs = s['suites'].get('browser', [])
    if specs:
        print(f'affected: Playwright specs: {len(specs)} (all projects)', file=sys.stderr, flush=True)
        r = subprocess.run(['node', 'node_modules/.bin/playwright', 'test', '--config', 'tests/browser/playwright.config.cjs',
                            '--reporter=line', *[Path(p).name for p in specs]], cwd=ROOT, env=env)
        rc |= r.returncode
    if s['suites'].get('dotnet'):
        print('affected: dotnet suite', file=sys.stderr, flush=True)
        r = subprocess.run(['dotnet', 'test', 'tests/backend/JE.Tests.csproj', '-c', 'Release', '--no-restore', '-p:JellyfinTarget=jf12'],
                           cwd=ROOT, env=dict(env, UseSharedCompilation='false', MSBUILDDISABLENODEREUSE='1'))
        rc |= r.returncode
    return 1 if rc else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('record')
    r.add_argument('--jobs', type=int, default=max(2, len(os.sched_getaffinity(0)) // 2))
    r.add_argument('--suites', default=','.join(SUITES))
    r.add_argument('--update', action='store_true', help='keep other suites of an existing map')
    r.add_argument('--allow-dirty', action='store_true')
    for name in ('select', 'run'):
        p = sub.add_parser(name)
        p.add_argument('--map')
        p.add_argument('--since', help='diff from this commit instead of the map commit (validation only)')
        if name == 'select':
            p.add_argument('--json', action='store_true')
    a = ap.parse_args()
    return {'record': record, 'select': cmd_select, 'run': cmd_run}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
