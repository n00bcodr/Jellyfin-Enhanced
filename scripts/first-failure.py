#!/usr/bin/env python3
"""How long does a gate take to name the first failure of a broken change?

    scripts/first-failure.py --tree DIR --gate all --break typecheck|frontend|dotnet [--timeout 600]

Applies one deliberate fault to the clean checkout DIR (restored afterwards), runs the gate, timestamps every output
line, and stops the gate at the first line that names a failing test, a type error or a build error (or when it
exits). Prints the seconds to that line and the line. The faults:
  typecheck  a number assigned to a string in client/src/host/context.ts (type error TS2322)
  frontend   the status tags' series batch skips every non-empty batch (`batch.length !== 0`) in
             client/src/features/media-tags/types/status/statustags.ts, regenerated (client:build) before the gate
  dotnet     TagStyleKeys.Groups loses the Quality group (TagStylePalettes.cs; backend tests notice)
"""
import argparse
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

FAULTS = {
    'typecheck': ('client/src/host/context.ts', None, '\nexport const firstFailureProbe: string = 1;\n'),
    'frontend': ('client/src/features/media-tags/types/status/statustags.ts', 'if (batch.length === 0) continue;',
                 'if (batch.length !== 0) continue;'),
    'dotnet': ('Jellyfin.Plugin.JellyfinEnhanced/Shared/MediaTags/PosterTags/TagStylePalettes.cs',
               'Groups = new[] { Quality, AgeRating,', 'Groups = new[] { AgeRating,'),
}
PATTERN = re.compile(r'FAILURE seen after|^\s*(✖|✘) |^\s+Failed [A-Za-z]|error (TS|CS|MSB)\d+|Client build failed|'
                     r'failing test\(s\) not in|Frontend verification failed|^not ok ')


def apply(tree, kind):
    path, old, new = FAULTS[kind]
    p = Path(tree) / path
    text = p.read_text()
    if kind == 'typecheck':
        p.write_text(text + new)
    elif kind in ('frontend', 'dotnet'):
        if text.count(old) != 1:
            sys.exit(f'cannot find {old!r} once in {path}')
        p.write_text(text.replace(old, new))
        if kind == 'frontend':   # as an agent would: regenerate the shipped js from the edited source first
            subprocess.run(['node', 'scripts/client-build.mjs'], cwd=tree, check=True, capture_output=True)
    return p, text


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--tree', required=True)
    ap.add_argument('--gate', default='all')
    ap.add_argument('--break', dest='kind', choices=sorted(FAULTS), required=True)
    ap.add_argument('--timeout', type=float, default=900)
    a = ap.parse_args()
    tree = Path(a.tree).resolve()
    p, original = apply(tree, a.kind)
    env = dict(os.environ, UseSharedCompilation='false', MSBUILDDISABLENODEREUSE='1', DOTNET_CLI_USE_MSBUILD_SERVER='0')
    t0 = time.time()
    proc = subprocess.Popen(['bash', 'scripts/restructure-gates.sh', a.gate], cwd=tree, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, start_new_session=True, text=True, bufsize=1)
    first, first_t = None, None
    try:
        for line in proc.stdout:
            if PATTERN.search(line):
                first, first_t = line.rstrip(), time.time() - t0
                break
            if time.time() - t0 > a.timeout:
                break
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        p.write_text(original)
        subprocess.run(['git', '-C', str(tree), 'checkout', '--', '.'], check=False)
    print(f'{a.gate} {a.kind}: first failure after {first_t:.1f} s: {first[:300]}' if first else
          f'{a.gate} {a.kind}: no failure line before exit or timeout ({time.time() - t0:.0f} s)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
