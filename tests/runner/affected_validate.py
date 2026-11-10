#!/usr/bin/env python3
"""Is tests/runner/affected.py safe? Two checks, both reported with their miss counts.

    affected_validate.py history  [--commits 100]                    selection sizes over real commits (cheap)
    affected_validate.py mutate   --tree DIR [--count 30] [--seed 1]  planted faults: does any unselected test fail?

`mutate` works in a clean checkout DIR whose affected map (affected.py record) is current. For each mutation it picks a
source file that one of the last 100 commits changed (client/src, the plugin's C#, test helpers and scripts, weighted
by how often they changed), applies one small fault that still compiles (a flipped comparison, condition or boolean, an
off-by-one constant), rebuilds the client when the file is client source (as an agent would before testing), asks
affected.py what to run, and then runs EVERY suite: the node files, every Playwright spec in all projects, and the
dotnet suite when it is not selected (it is selected for every plugin change, so it cannot be missed there). A failing
test outside the selection is a candidate miss; it is re-run with the fault and on the clean tree, and counts as a
miss only if it fails with the fault and passes without it (a flake otherwise). Mutations no test notices are reported
as survivors: they say nothing about the selection.
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve()
SOURCES = re.compile(r'^(client/src/.*(?<!\.d)\.ts|Jellyfin\.Plugin\.JellyfinEnhanced/(?!js/|min/|bin/|obj/).*\.cs|'
                     r'tests/frontend/helpers/.*\.(mjs|cjs)|tests/browser/helpers/.*\.cjs|scripts/[^/]*\.mjs)$')
OPERATORS = [(r' === ', ' !== '), (r' !== ', ' === '), (r' < ', ' <= '), (r' > ', ' >= '), (r' <= ', ' < '), (r' >= ', ' > '),
             (r' && ', ' || '), (r' \|\| ', ' && '), (r'\btrue\b', 'false'), (r'\bfalse\b', 'true'), (r' == ', ' != '), (r' != ', ' == '),
             (r'(?<![\w.])1(?![\w.])', '2'), (r'(?<![\w.])0(?![\w.])', '1')]


def git(tree, *args):
    return subprocess.run(['git', '-C', str(tree), *args], capture_output=True, text=True, check=True).stdout


def history_files(tree, n):
    counts = {}
    for c in git(tree, 'log', '--format=%H', f'-{n}', 'HEAD').split():
        for path in git(tree, 'diff', '--name-only', f'{c}^1', c).split():
            if SOURCES.match(path) and (Path(tree) / path).is_file():
                counts[path] = counts.get(path, 0) + 1
    return counts


def code_sites(text, path):
    """(start, end, replacement) for each operator match outside comments and string literals (line-based guard)."""
    out = []
    for lineno, line in enumerate(text.split('\n')):
        s = line.strip()
        if not s or s.startswith(('//', '*', '/*', '#', 'using ', 'import ', 'export type', '[')):
            continue
        offset = sum(len(l) + 1 for l in text.split('\n')[:lineno])
        for pat, rep in OPERATORS:
            for m in re.finditer(pat, line):
                before = line[:m.start()]
                if before.count('"') % 2 or before.count("'") % 2 or before.count('`') % 2 or '//' in before:
                    continue
                out.append((offset + m.start(), offset + m.end(), rep, lineno + 1, pat))
    return out


def run(cmd, cwd, env=None, timeout=1800):
    t = time.time()
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout + r.stderr, time.time() - t


def node_failures(tree, files, env):
    """Failing test files among `files` (node --test, results by file)."""
    if not files:
        return set(), 0.0
    with tempfile.TemporaryDirectory() as d:
        res = Path(d) / 'r'
        rc, out, secs = run(['node', '--test', '--test-timeout=300000', f'--test-concurrency={max(2, len(os.sched_getaffinity(0)) - 1)}',
                             '--test-reporter=' + str(Path(tree) / 'scripts/restructure-gates-reporter.mjs'),
                             f'--test-reporter-destination={res}', *files], tree, env)
        failed = {l.split(' ', 1)[1].split(' :: ')[0] for l in res.read_text().splitlines() if l.startswith('FAIL ')} if res.exists() else set()
        if rc and not failed:
            failed = {'<node run failed: ' + out[-300:] + '>'}
        return failed, secs


def browser_failures(tree, specs, env, workers):
    if not specs:
        return set(), 0.0
    with tempfile.TemporaryDirectory() as d:
        report = Path(d) / 'r.json'
        e = dict(env, PLAYWRIGHT_JSON_OUTPUT_NAME=str(report), JE_BROWSER_PORT=str(43000 + os.getpid() % 1000))
        rc, out, secs = run(['node', 'node_modules/.bin/playwright', 'test', '--config', 'tests/browser/playwright.config.cjs',
                             f'--workers={workers}', '--reporter=json', '--output', str(Path(d) / 'o'),
                             *[Path(s).name for s in specs]], tree, e)
        failed = set()
        if report.exists():
            data = json.loads(report.read_text())

            def walk(s):
                for sp in s.get('specs', []):
                    for t in sp['tests']:
                        if t['status'] in ('unexpected', 'flaky'):
                            failed.add(f"tests/browser/{sp['file']}")
                for c in s.get('suites', []):
                    walk(c)
            for s in data['suites']:
                walk(s)
        elif rc:
            failed.add('<playwright failed: ' + out[-300:] + '>')
        return failed, secs


def dotnet_failures(tree, env):
    lock = ['flock', '--close', os.environ['JE_DOTNET_LOCK']] if os.environ.get('JE_DOTNET_LOCK') else []
    rc, out, secs = run(lock + ['dotnet', 'test', 'tests/backend/JE.Tests.csproj', '-c', 'Release', '--no-restore', '-p:JellyfinTarget=jf12'],
                        tree, dict(env, UseSharedCompilation='false', MSBUILDDISABLENODEREUSE='1'), timeout=3600)
    return ({'tests/backend (dotnet)'} if rc else set()), secs


def select(tree):
    r = subprocess.run([sys.executable, str(Path(tree) / 'tests/runner/affected.py'), 'select', '--json'], cwd=tree,
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def all_files(tree):
    sys.path.insert(0, str(Path(tree) / 'tests/runner'))
    import importlib
    mod = importlib.import_module('affected')
    return {s: mod.suite_files(s) for s in mod.SUITES}


def mutate(args):
    tree = Path(args.tree).resolve()
    if git(tree, 'status', '--porcelain', '--untracked-files=no').strip():
        sys.exit(f'{tree} has local changes; mutate needs a clean checkout')
    rnd = random.Random(args.seed)
    files = history_files(tree, args.commits)
    pool = [f for f, n in sorted(files.items()) for _ in range(n)]
    env = dict(os.environ, TZ='UTC', LANG='en_US.UTF-8', LC_ALL='en_US.UTF-8')
    everything = all_files(tree)
    results, tried = [], set()
    while len(results) < args.count and len(tried) < len(set(pool)) * 4:
        path = rnd.choice(pool)
        text = (tree / path).read_text()
        sites = code_sites(text, path)
        if not sites:
            tried.add((path, None))
            continue
        start, end, rep, line, pat = rnd.choice(sites)
        if (path, start) in tried:
            continue
        tried.add((path, start))
        (tree / path).write_text(text[:start] + rep + text[end:])
        try:
            if path.startswith('client/src/'):
                rc, out, _ = run(['node', 'scripts/client-build.mjs'], tree, env)
                if rc:
                    continue        # does not compile: not a change an agent could test
            sel = select(tree)
            picked = {s: set(v) for s, v in sel['suites'].items()}
            node_all = everything['frontend'] + everything['client-build'] + everything['boundary']
            nf, nsec = node_failures(tree, node_all, env)
            bf, bsec = browser_failures(tree, everything['browser'], env, args.workers)
            df, dsec = (set(), 0.0) if 'dotnet' in picked else dotnet_failures(tree, env)
            failed = nf | bf | df
            selected = set().union(*picked.values()) if picked else set()
            if 'dotnet' in picked:
                selected.add('tests/backend (dotnet)')
            unselected_failures = sorted(f for f in failed if f not in selected and not f.startswith('<'))
            confirmed = []
            for f in unselected_failures:   # flake protocol: fails again with the fault, passes on the clean tree
                again = (node_failures(tree, [f], env)[0] if f.endswith('.mjs') else browser_failures(tree, [f], env, 3)[0])
                (tree / path).write_text(text)
                if path.startswith('client/src/'):
                    run(['node', 'scripts/client-build.mjs'], tree, env)
                clean = (node_failures(tree, [f], env)[0] if f.endswith('.mjs') else browser_failures(tree, [f], env, 3)[0])
                (tree / path).write_text(text[:start] + rep + text[end:])
                if path.startswith('client/src/'):
                    run(['node', 'scripts/client-build.mjs'], tree, env)
                confirmed.append({'file': f, 'fails_again': bool(again), 'fails_clean': bool(clean),
                                  'miss': bool(again) and not clean})
            r = {'file': path, 'line': line, 'operator': f'{pat} -> {rep}', 'all': sel['all'],
                 'selected': {s: len(v) for s, v in picked.items()},
                 'of': {s: len(v) for s, v in everything.items()},
                 'failed': sorted(failed), 'unselected_failures': confirmed,
                 'killed': bool(failed), 'misses': sum(c['miss'] for c in confirmed),
                 'seconds': round(nsec + bsec + dsec)}
            results.append(r)
            print(json.dumps(r), flush=True)
        finally:
            (tree / path).write_text(text)
            if path.startswith('client/src/'):
                run(['node', 'scripts/client-build.mjs'], tree, env)
            git(tree, 'checkout', '--', '.')
    killed = [r for r in results if r['killed']]
    summary = {'mutations': len(results), 'killed': len(killed), 'survived': len(results) - len(killed),
               'mutations_with_a_miss': sum(1 for r in results if r['misses']), 'missed_failing_files': sum(r['misses'] for r in results),
               'flakes_outside_selection': sum(1 for r in results for c in r['unselected_failures'] if not c['miss'])}
    print(json.dumps({'summary': summary}), flush=True)
    if args.out:
        Path(args.out).write_text(json.dumps({'summary': summary, 'results': results}, indent=1))
    return 1 if summary['mutations_with_a_miss'] else 0


def history(args):
    """Selection over each of the last N commits (diff from its first parent), with the map of the checkout."""
    tree = Path(args.tree).resolve()
    sys.path.insert(0, str(tree / 'tests/runner'))
    import importlib
    mod = importlib.import_module('affected')
    rows = []
    for c in git(tree, 'log', '--format=%H', f'-{args.commits}', 'HEAD').split():
        changed = {}
        for line in git(tree, 'diff', '--name-status', '--no-renames', f'{c}^1', c).splitlines():
            st, _, p = line.partition('\t')
            changed[p] = st[0]
        sel = mod.select(mod.MAP, changed=changed)
        everything = {s: len(mod.suite_files(s)) for s in mod.SUITES}
        tests_changed = sorted(p for p in changed if re.search(r'\.(test\.mjs|spec\.cjs)$', p) and (tree / p).exists())
        picked = set().union(*map(set, sel['suites'].values())) if sel['suites'] else set()
        rows.append({'commit': c[:10], 'changed': len(changed), 'all': sel['all'],
                     'selected': {s: len(sel['suites'].get(s, [])) for s in mod.SUITES}, 'of': everything,
                     'changed_test_files': len(tests_changed),
                     'changed_test_files_not_selected': [p for p in tests_changed if p not in picked]})
    out = {'commits': len(rows), 'everything': sum(1 for r in rows if r['all']),
           'dotnet_selected': sum(1 for r in rows if r['selected']['dotnet']),
           'median_node_files_selected': sorted(r['selected']['frontend'] + r['selected']['client-build'] + r['selected']['boundary'] for r in rows)[len(rows) // 2],
           'median_specs_selected': sorted(r['selected']['browser'] for r in rows)[len(rows) // 2],
           'changed_test_files_missed': sum(len(r['changed_test_files_not_selected']) for r in rows), 'rows': rows}
    print(json.dumps(out, indent=1))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    m = sub.add_parser('mutate')
    m.add_argument('--tree', required=True)
    m.add_argument('--count', type=int, default=30)
    m.add_argument('--seed', type=int, default=1)
    m.add_argument('--commits', type=int, default=100)
    m.add_argument('--workers', type=int, default=8)
    m.add_argument('--out')
    h = sub.add_parser('history')
    h.add_argument('--tree', default=str(HERE.parents[2]))
    h.add_argument('--commits', type=int, default=100)
    a = ap.parse_args()
    return mutate(a) if a.cmd == 'mutate' else history(a)


if __name__ == '__main__':
    sys.exit(main())
