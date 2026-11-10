#!/usr/bin/env python3
"""Run the backend suite as several test-host processes and merge their results and coverage.

xUnit runs the `Plugin singleton` collection (tests that replace the plugin's static instance) with
DisableParallelization = true: after every other collection, alone, one test at a time. That serial tail was most of
T's test time. Here each shard is its own `dotnet test` process, so it has its own plugin singleton:

- `singleton-<i>` shards run only `Plugin singleton` classes. Inside each process they still run one at a time and
  alone (DisableParallelization applies inside the process), exactly as before; nothing else runs in that process.
- the `parallel` shard runs every other test (its filter is the complement of the singleton classes), with xUnit's
  usual parallel collections.
So every test runs once, under the same isolation as in one process; only processes are added.

    dotnet_shards.py plan  [--shards N] [--durations FILE.trx]   -> JSON {name: filter} on stdout
    dotnet_shards.py merge <results dir> <shard names...>        -> `<total> <passed>` then `PASS|FAIL|SKIP <test>`
                                                                     lines (as trx_results), and <dir>/merged/
                                                                     coverage.cobertura.xml with the merged rates

The singleton classes come from the test sources: a `[Collection("Plugin singleton")]` attribute directly before a
top-level class declaration. The plan refuses (exit 2) anything it cannot place: the attribute anywhere else, a class
name that is a prefix of another class's full name (the filters match `FullyQualifiedName~<class>.`), or a namespace
it cannot read. merge refuses a test that ran in two shards and checks that the shard counts add up.

Coverage: each shard writes coverlet's JSON (per method: line hits; branches by line, offset, end offset, path and
ordinal), so the union is exact: hits are summed per line and per branch. The rates are computed the way coverlet's
Cobertura reporter computes the package rates (lines and branches counted per method; covered = hits > 0), and
`merged/coverage.cobertura.xml` carries them for tests/runner/coverage.py, which is unchanged. `self-check <dir>`
recomputes the rates from one unsharded run's JSON and compares them with that run's own Cobertura report.
"""
import argparse
import glob
import math
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TESTS = ROOT / 'tests/backend'
SINGLETON = 'Plugin singleton'
NS = '{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}'


def scan():
    """-> (singleton class full names, all top-level test-project class full names)."""
    singles, classes, problems = [], [], []
    for path in sorted(TESTS.rglob('*.cs')):
        if any(part in ('bin', 'obj') for part in path.parts):
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        ns = re.search(r'^\s*namespace\s+([\w.]+)\s*[;{]', text, re.M)
        decls = list(re.finditer(r'^(?:public|internal)\s+(?:(?:sealed|static|partial|abstract)\s+)*class\s+(\w+)', text, re.M))
        for d in decls:
            if ns:
                classes.append(f'{ns.group(1)}.{d.group(1)}')
        for m in re.finditer(r'\[Collection\("' + re.escape(SINGLETON) + r'"\)\]', text):
            after = text[m.end():]
            d = re.match(r'\s*(?:\[[^\]]*\]\s*)*(?:public|internal)\s+(?:(?:sealed|static|partial|abstract)\s+)*class\s+(\w+)', after)
            if not d or not ns:
                problems.append(f'{path.relative_to(ROOT)}: [Collection("{SINGLETON}")] not directly before a top-level class in a namespace')
                continue
            singles.append(f'{ns.group(1)}.{d.group(1)}')
    names = set(classes)
    for s in singles:
        for c in names:
            if c != s and (c + '.').startswith(s + '.'):
                problems.append(f'{s} is a prefix of {c}: the filter would also match it')
    if len(set(singles)) != len(singles):
        problems.append('a singleton class is declared twice')
    return sorted(set(singles)), sorted(names), problems


DURATIONS = TESTS / 'singleton-durations.json'


def class_durations(trx):
    """Seconds per class: from an earlier TRX (sum of its tests' durations), else the committed singleton-durations.json."""
    out = {}
    if not trx:
        return json.loads(DURATIONS.read_text()) if DURATIONS.is_file() else {}
    if not Path(trx).is_file():
        return out
    root = ET.parse(trx).getroot()
    defs = {d.get('id'): d.find(f'{NS}TestMethod').get('className') for d in root.iter(f'{NS}UnitTest')}
    for r in root.iter(f'{NS}UnitTestResult'):
        h, m, s = r.get('duration', '0:0:0').split(':')
        c = defs.get(r.get('testId'))
        out[c] = out.get(c, 0.0) + int(h) * 3600 + int(m) * 60 + float(s)
    return out


def plan(shards, durations):
    singles, _, problems = scan()
    if problems:
        print('\n'.join(problems), file=sys.stderr)
        return 2
    if not singles:
        print(json.dumps({'parallel': ''}))
        return 0
    took = class_durations(durations)
    default = (sum(took.values()) / len(took)) if took else 1.0
    # Longest first onto the least-loaded shard (LPT); ties by name, so the plan is the same on every machine.
    loads = [[0.0, i, []] for i in range(max(1, shards))]
    for c in sorted(singles, key=lambda c: (-took.get(c, default), c)):
        lightest = min(loads, key=lambda x: (x[0], x[1]))
        lightest[0] += took.get(c, default)
        lightest[2].append(c)
    out = {}
    for load, i, members in loads:
        if members:
            out[f'singleton-{i + 1}'] = '|'.join(f'FullyQualifiedName~{c}.' for c in sorted(members))
    out['parallel'] = '&'.join(f'FullyQualifiedName!~{c}.' for c in singles)
    print(json.dumps(out))
    return 0


def trx_results(path):
    root = ET.parse(path).getroot()
    summary = root.find(f'{NS}ResultSummary')
    c = summary.find(f'{NS}Counters')
    rows = []
    for r in root.iter(f'{NS}UnitTestResult'):
        o = r.get('outcome')
        rows.append(('PASS' if o == 'Passed' else 'SKIP' if o == 'NotExecuted' else 'FAIL', r.get('testName')))
    classes = {d.find(f'{NS}TestMethod').get('className') for d in root.iter(f'{NS}UnitTest')}
    return int(c.get('total')), int(c.get('passed')), rows, summary.get('outcome', 'Completed'), classes


def coverage_json(shard_dir):
    """The shard's coverlet JSON report (the collector writes it under a GUID directory)."""
    found = sorted(glob.glob(str(Path(shard_dir) / '**' / 'coverage.json'), recursive=True))
    unique = {}
    for f in found:
        unique.setdefault(Path(f).read_bytes(), f)
    if len(unique) != 1:
        raise SystemExit(f'{shard_dir}: expected one coverage.json, found {len(unique)}')
    return json.loads(next(iter(unique)))


def merge_json(reports):
    """Sum hits per (module, document, class, method, line) and per branch (line, offset, end offset, path, ordinal)."""
    out = {}
    for rep in reports:
        for module, docs in rep.items():
            for doc, classes in docs.items():
                for cls, methods in classes.items():
                    for meth, data in methods.items():
                        dst = out.setdefault(module, {}).setdefault(doc, {}).setdefault(cls, {}).setdefault(meth, {'Lines': {}, 'Branches': {}})
                        for line, hits in data.get('Lines', {}).items():
                            dst['Lines'][line] = dst['Lines'].get(line, 0) + hits
                        for b in data.get('Branches', []):
                            k = (b['Line'], b['Offset'], b['EndOffset'], b['Path'], b['Ordinal'])
                            dst['Branches'][k] = dst['Branches'].get(k, 0) + b['Hits']
    return out


def rates(merged_or_report, module_name):
    """(line rate, branch rate) of one module, counted like coverlet: every (method, line) and every branch."""
    for module, docs in merged_or_report.items():
        if Path(module).stem != module_name:
            continue
        lines = covered_lines = branches = covered_branches = 0
        for classes in docs.values():
            for methods in classes.values():
                for data in methods.values():
                    ls = data['Lines']
                    lines += len(ls)
                    covered_lines += sum(1 for h in ls.values() if h > 0)
                    bs = data['Branches']
                    vals = bs.values() if isinstance(bs, dict) else [b['Hits'] for b in bs]
                    vals = list(vals)
                    branches += len(vals)
                    covered_branches += sum(1 for h in vals if h > 0)
        return (covered_lines / lines if lines else 1.0, covered_branches / branches if branches else 1.0,
                {'lines': lines, 'covered_lines': covered_lines, 'branches': branches, 'covered_branches': covered_branches})
    raise SystemExit(f'module {module_name} not in the coverage report')


def coverlet_rate(rate):
    """Coverlet writes a rate truncated to four decimal places (0.650379 -> 0.6503), not rounded."""
    return math.floor(rate * 10000) / 10000


def write_cobertura(path, line_rate, branch_rate, counts):
    line_rate, branch_rate = coverlet_rate(line_rate), coverlet_rate(branch_rate)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<!-- Merged from the shards\' coverlet JSON by tests/runner/dotnet_shards.py: {json.dumps(counts)} -->\n'
        f'<coverage line-rate="{line_rate}" branch-rate="{branch_rate}" lines-covered="{counts["covered_lines"]}" '
        f'lines-valid="{counts["lines"]}" branches-covered="{counts["covered_branches"]}" branches-valid="{counts["branches"]}">\n'
        f'  <packages><package name="Jellyfin.Plugin.JellyfinEnhanced" line-rate="{line_rate}" branch-rate="{branch_rate}"/></packages>\n'
        '</coverage>\n')


def merge(results_dir, shards):
    res = Path(results_dir)
    total = passed = 0
    rows, seen = [], {}
    for s in shards:
        trx = res / s / f'{s}.trx'
        if not trx.is_file():
            raise SystemExit(f'{s}: no TRX at {trx}')
        t, p, r, outcome, classes = trx_results(trx)
        if outcome not in ('Completed', 'Passed', 'Failed'):
            raise SystemExit(f'{s}: the test run did not complete (TRX outcome {outcome}); see its log')
        if t != len(r):
            raise SystemExit(f'{s}: TRX counts {t} tests but lists {len(r)} results')
        # The plan splits by class, so a class in two hosts means a test ran twice. (Test names cannot be compared:
        # the TRX truncates long theory display names, so cases of one theory can share a name.)
        for cls in classes:
            if cls in seen:
                raise SystemExit(f'{cls} ran in two test hosts ({seen[cls]}, {s})')
            seen[cls] = s
        total += t
        passed += p
        rows += r
    print(total, passed)
    for status, name in rows:
        print(status, name)
    merged = merge_json([coverage_json(res / s) for s in shards])
    lr, br, counts = rates(merged, 'Jellyfin.Plugin.JellyfinEnhanced')
    write_cobertura(res / 'merged' / 'coverage.cobertura.xml', lr, br, counts)
    print(f'merged coverage of {len(shards)} shards: line {lr:.6f}, branch {br:.6f} {counts}', file=sys.stderr)
    return 0


def self_check(run_dir):
    """One unsharded run with Format=json,cobertura: do the rates from its JSON equal its Cobertura package rates?"""
    rep = coverage_json(run_dir)
    lr, br, counts = rates(merge_json([rep]), 'Jellyfin.Plugin.JellyfinEnhanced')
    cob = sorted(glob.glob(str(Path(run_dir) / '**' / 'coverage.cobertura.xml'), recursive=True))[0]
    pkg = ET.parse(cob).getroot().find("./packages/package[@name='Jellyfin.Plugin.JellyfinEnhanced']")
    want = (float(pkg.get('line-rate')), float(pkg.get('branch-rate')))
    same = [coverlet_rate(lr) == want[0], coverlet_rate(br) == want[1]]
    print(json.dumps({'from_json': [lr, br], 'as_coverlet_writes_them': [coverlet_rate(lr), coverlet_rate(br)],
                      'cobertura': want, 'counts': counts, 'equal': same}))
    return 0 if all(same) else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('plan')
    p.add_argument('--shards', type=int, default=int(os.environ.get('JE_DOTNET_SINGLETON_SHARDS', '3')))
    p.add_argument('--durations', default=None, help='an earlier TRX to balance the singleton shards by')
    m = sub.add_parser('merge')
    m.add_argument('results')
    m.add_argument('shards', nargs='+')
    r = sub.add_parser('record', help='write singleton-durations.json from a TRX (seconds per singleton class)')
    r.add_argument('trx')
    c = sub.add_parser('self-check')
    c.add_argument('run')
    sub.add_parser('scan')
    a = ap.parse_args()
    if a.cmd == 'plan':
        return plan(a.shards, a.durations)
    if a.cmd == 'merge':
        return merge(a.results, a.shards)
    if a.cmd == 'record':
        singles, _, _ = scan()
        took = class_durations(a.trx)
        DURATIONS.write_text(json.dumps({c: round(took[c], 2) for c in singles if c in took}, indent=1, sort_keys=True) + '\n')
        return 0
    if a.cmd == 'self-check':
        return self_check(a.run)
    singles, classes, problems = scan()
    print(json.dumps({'singleton': singles, 'classes': len(classes), 'problems': problems}, indent=1))
    return 2 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
