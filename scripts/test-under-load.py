#!/usr/bin/env python3
"""Run a test command N times, alone or beside a CPU hog, and count how often it fails.

    scripts/test-under-load.py --runs 20 --hog 10 -- node --test tests/frontend/core/core-api-runtime.test.mjs
    scripts/test-under-load.py --runs 20 --hog 0  -- ...        # the same command on a quiet machine, for contrast

--hog K starts K busy-loop processes (`while :; do :; done` at normal priority) before each run and stops them after,
so the command competes for the CPU the way it does when several gates or labs run at once. --starve also loads
tests/runner/starve.mjs into every Node process the command starts (NODE_OPTIONS=--import), which blocks each one's
event loop for 20-80 ms at random moments: a harsher, cheaper stand-in for a saturated machine that exposes tests
assuming work settles within a fixed time. The output of every
failing run is kept (--keep DIR). Exit status 1 if any run failed. Prints one line per run and a summary:
`runs N, failed F, wall median M s (min, max)`.
"""
import argparse
import os
import signal
import statistics
import subprocess
import sys
import time
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--runs', type=int, default=20)
    ap.add_argument('--hog', type=int, default=os.cpu_count())
    ap.add_argument('--keep', type=Path, default=None)
    ap.add_argument('--timeout', type=float, default=1800)
    ap.add_argument('--starve', action='store_true', help='block every Node process\'s event loop at random moments')
    ap.add_argument('command', nargs='+')
    a = ap.parse_args()
    if a.keep:
        a.keep.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    if a.starve:
        starve = Path(__file__).resolve().parents[1] / 'tests/runner/starve.mjs'
        env['NODE_OPTIONS'] = f"{env.get('NODE_OPTIONS', '')} --import={starve}".strip()
    fails, walls = 0, []
    for i in range(a.runs):
        hogs = [subprocess.Popen(['sh', '-c', 'while :; do :; done'], start_new_session=True) for _ in range(a.hog)]
        time.sleep(0.5)
        t = time.perf_counter()
        try:
            r = subprocess.run(a.command, capture_output=True, text=True, timeout=a.timeout, env=env)
            rc, out = r.returncode, r.stdout + r.stderr
        except subprocess.TimeoutExpired as e:
            rc, out = 124, f'TIMEOUT after {a.timeout} s\n{e.stdout or ""}{e.stderr or ""}'
        wall = time.perf_counter() - t
        for h in hogs:
            os.killpg(h.pid, signal.SIGKILL)
            h.wait()
        walls.append(wall)
        if rc:
            fails += 1
            if a.keep:
                (a.keep / f'run-{i + 1:02d}.log').write_text(out)
        print(f'run {i + 1}: {"FAIL" if rc else "pass"} (exit {rc}) {wall:.1f} s', flush=True)
    print(f'runs {a.runs}, failed {fails}, hog {a.hog}{", starved" if a.starve else ""}, wall median {statistics.median(walls):.1f} s '
          f'(min {min(walls):.1f}, max {max(walls):.1f})', flush=True)
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
