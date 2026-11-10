#!/usr/bin/env python3
"""Time TypeScript checkers on client/ the same way: interleaved, cold and warm, plus watch-mode re-checks.

    scripts/typecheck-timing.py --checker tsc6='node node_modules/typescript/bin/tsc' --checker ts7='...' \
        --checker tsrs='.../tsc-rs' [--runs 10] [--edits 10] [--out FILE.json] [--cpus 0-7]

Each round runs every checker (in a rotating order) twice: cold, after evicting from the page cache (posix_fadvise
DONTNEED, no root needed) every file under client/ and every file of the checker's own install (its --evict paths, or
the directory of its first argument that is not `node`), then warm, straight after. Both are full `-p client/tsconfig.json`
checks (the tsconfig has noEmit) in a new process; `--pretty false`. Every run must report zero errors.
Watch mode: each checker with `--watch` is started once; after its first report, --edits one-line edits are timed from
the write to the checker's next "Found N errors" line after its "File change detected" line. The edits alternate between
adding a line with a type error to a real source file (`export const timingProbe: string = 1;`, expect 1 error) and
removing it again (expect 0), so a report only counts when it shows the checker really checked the edit; a report with
the wrong count is recorded as a mismatch. A checker whose watch mode never reports is recorded as such.
--npm-step also times `npm run client:typecheck` (the repository's own step: tag data, source policy, then the
TypeScript 6 API check) cold and warm in the same rotation.
"""
import argparse
import json
import os
import re
import select
import shlex
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def evict(paths):
    n = 0
    for base in paths:
        base = Path(base)
        files = [base] if base.is_file() else [p for p in base.rglob('*') if p.is_file()]
        for f in files:
            try:
                fd = os.open(f, os.O_RDONLY)
                try:
                    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
                    n += 1
                finally:
                    os.close(fd)
            except OSError:
                pass
    return n


def run_check(cmd, cwd, env):
    t = time.perf_counter()
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    wall = time.perf_counter() - t
    errors = len(re.findall(r'error TS\d+', r.stdout + r.stderr))
    if r.returncode != 0 and not errors:
        errors = -1   # failed without diagnostics: the command itself broke
    return wall, errors, r.returncode, (r.stdout + r.stderr)[-400:]


EDIT = '\nexport const timingProbe: string = 1;\n'


def restore(files):
    for f in files:
        txt = f.read_text()
        if txt.endswith(EDIT):
            f.write_text(txt[:-len(EDIT)])


def watch_times(name, cmd, cwd, env, edits, files):
    """Seconds from each one-line edit to the watcher's next result line."""
    proc = subprocess.Popen(cmd + ['--watch'], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    fd = proc.stdout.fileno()
    buf, pending = '', ''

    def wait_result(timeout, after_change=False):
        """The next `Found N errors` line (after a `File change detected` line when after_change). Reads the raw pipe:
        select() on a buffered reader misses lines it holds."""
        nonlocal buf, pending
        end = time.time() + timeout
        seen_change = not after_change
        while time.time() < end:
            while '\n' in pending:
                line, pending = pending.split('\n', 1)
                if 'File change detected' in line:
                    seen_change = True
                elif seen_change and re.search(r'Found (\d+) errors?', line):
                    return line.strip()
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                chunk = os.read(fd, 65536).decode('utf-8', 'replace')
                if not chunk:
                    return None
                buf += chunk
                pending += chunk
        return None
    first = wait_result(120)
    times, outs = [], []
    if first is None:
        proc.kill()
        return {'error': f'no first result in 120 s; output: {buf[-500:]}'}
    mismatches = 0
    for i in range(edits):
        f = files[(i // 2) % len(files)]          # add then remove in the same file
        text = f.read_text()
        add = i % 2 == 0
        new = text + EDIT if add else text.replace(EDIT, '', 1)
        # Let the watcher settle, then drop whatever it printed since its last result (a second report of one edit
        # must not count as the answer to the next edit).
        time.sleep(1.0)
        while select.select([fd], [], [], 0.2)[0]:
            if not os.read(fd, 65536):
                break
        pending = ''
        t = time.perf_counter()
        f.write_text(new)
        line = wait_result(60, after_change=True)
        if line is None:
            outs.append(f'NO REPORT in 60 s; output tail: {buf[-300:]!r}')
            times.append(None)
            continue
        found = int(re.search(r'Found (\d+) errors?', line).group(1)) if line else None
        if line is not None and found != (1 if add else 0):
            mismatches += 1
            line = f'MISMATCH (expected {1 if add else 0}): {line}'
        times.append(time.perf_counter() - t if line and not line.startswith('MISMATCH') else None)
        outs.append(line)
    restore(files)
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
    return {'times': times, 'results': outs, 'mismatches': mismatches}


def summary(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    return {'n': len(xs), 'median': statistics.median(xs), 'min': min(xs), 'max': max(xs)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--checker', action='append', required=True, help="name='command ...' (gets -p client/tsconfig.json)")
    ap.add_argument('--evict', action='append', default=[], help='name=path: extra files to evict for a cold run')
    ap.add_argument('--runs', type=int, default=10)
    ap.add_argument('--edits', type=int, default=10)
    ap.add_argument('--no-watch', action='store_true')
    ap.add_argument('--npm-step', action='store_true')
    ap.add_argument('--cpus', help='taskset CPU list for every checker run')
    ap.add_argument('--tree', default=str(ROOT), help='checkout whose client/ is checked')
    ap.add_argument('--out')
    a = ap.parse_args()
    tree = Path(a.tree)
    env = dict(os.environ)
    checkers = []
    for spec in a.checker:
        name, _, cmd = spec.partition('=')
        argv = shlex.split(cmd)
        own = [x for x in argv if x != 'node' and not x.startswith('-')][:1]
        ev = [str(Path(own[0]).resolve().parent)] if own else []
        ev += [p.partition('=')[2] for p in a.evict if p.partition('=')[0] == name]
        checkers.append({'name': name, 'argv': argv, 'evict': ev})
    if a.npm_step:
        checkers.append({'name': 'npm run client:typecheck', 'argv': ['npm', 'run', '--silent', 'client:typecheck'],
                         'evict': [str(tree / 'node_modules/typescript'), str(tree / 'scripts')], 'npm': True})
    prefix = ['taskset', '-c', a.cpus] if a.cpus else []
    res = {c['name']: {'cold': [], 'warm': [], 'errors': []} for c in checkers}
    for rnd in range(a.runs):
        order = checkers[rnd % len(checkers):] + checkers[:rnd % len(checkers)]
        for c in order:
            cmd = prefix + c['argv'] + ([] if c.get('npm') else ['-p', 'client/tsconfig.json', '--pretty', 'false'])
            evict([tree / 'client', *c['evict']])
            w, e, rc, tail = run_check(cmd, tree, env)
            res[c['name']]['cold'].append(w)
            w2, e2, rc2, tail2 = run_check(cmd, tree, env)
            res[c['name']]['warm'].append(w2)
            if e or e2:
                res[c['name']]['errors'].append({'round': rnd, 'cold': e, 'warm': e2, 'tail': tail2})
            print(f"round {rnd + 1} {c['name']}: cold {w:.2f} s, warm {w2:.2f} s{'' if not (e or e2) else f', ERRORS {e}/{e2}'}",
                  file=sys.stderr, flush=True)
    out = {'host': os.uname().nodename, 'cpus': a.cpus or f'all {len(os.sched_getaffinity(0))}', 'tree': str(tree),
           'git': subprocess.run(['git', '-C', str(tree), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip(),
           'versions': {}, 'results': {}}
    for c in checkers:
        if not c.get('npm'):
            v = subprocess.run(c['argv'] + ['--version'], cwd=tree, capture_output=True, text=True)
            out['versions'][c['name']] = (v.stdout + v.stderr).strip()
    def save():
        for name, r in res.items():
            out['results'][name] = {'cold': summary(r['cold']), 'warm': summary(r['warm']), 'errors': r['errors'],
                                    'watch': summary(r.get('watch', {}).get('times', [])) if r.get('watch') else None,
                                    'watch_raw': r.get('watch'), 'raw': {'cold': r['cold'], 'warm': r['warm']}}
        if a.out:
            Path(a.out).write_text(json.dumps(out, indent=1))
    save()      # the rounds are kept even if the watch phase is interrupted
    if not a.no_watch:
        files = [tree / 'client/src/core/lifecycle-entry.ts', tree / 'client/src/host/context.ts']
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))     # so the finally below puts the sources back
        try:
            for c in checkers:
                if c.get('npm'):
                    continue
                wt = watch_times(c['name'], prefix + c['argv'] + ['-p', 'client/tsconfig.json', '--pretty', 'false'], tree, env, a.edits, files)
                res[c['name']]['watch'] = wt
                print(f"watch {c['name']}: {wt}", file=sys.stderr, flush=True)
                save()
        finally:
            restore(files)
    save()
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
