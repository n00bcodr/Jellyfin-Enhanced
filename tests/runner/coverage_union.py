"""Union Coverlet counters by source/method/IL branch identity, never percentages."""
import copy
import hashlib
import json
from pathlib import Path

PLUGIN = 'Jellyfin.Plugin.JellyfinEnhanced'


def one_report(directory, name):
    unique = {}
    for path in Path(directory).rglob(name):
        unique.setdefault(hashlib.sha256(path.read_bytes()).hexdigest(), path)
    if len(unique) != 1:
        raise ValueError(f'Expected exactly one fresh {name} report in {directory}, found {len(unique)}')
    return next(iter(unique.values()))


def normalize_source(path):
    path = path.replace('\\', '/')
    marker = '/Jellyfin.Plugin.JellyfinEnhanced/'
    if marker in path:
        return 'Jellyfin.Plugin.JellyfinEnhanced/' + path.split(marker, 1)[1]
    if path.startswith('Jellyfin.Plugin.JellyfinEnhanced/'):
        return path
    # Compiler-generated documents belong to the plugin too. Preserve their
    # counters/denominators while removing only the mutable build-root prefix.
    if '/obj/' in path:
        return '__generated__/obj/' + path.split('/obj/', 1)[1]
    # Virtual or external #line documents must never disappear from inventory.
    # Unknown absolute identities remain exact, so an incompatible relocation
    # fails the cross-partition inventory comparison instead of being excluded.
    return '__document__/' + path


def counters(path):
    report = json.loads(Path(path).read_text())
    modules = [v for k, v in report.items() if Path(k.replace('\\', '/')).name == PLUGIN + '.dll']
    if len(modules) != 1 or not modules[0]:
        raise ValueError('Production plugin is missing/empty in coverage report')
    result = {}
    for source, classes in modules[0].items():
        source = normalize_source(source)
        if source in result:
            raise ValueError('Duplicate normalized source')
        points = {}
        for class_name, methods in classes.items():
            for method_name, method in methods.items():
                for line, hits in method['Lines'].items():
                    point = ('line', class_name, method_name, int(line))
                    if point in points: raise ValueError('Duplicate line identity')
                    points[point] = int(hits)
                for branch in method['Branches']:
                    point = ('branch', class_name, method_name, branch['Line'], branch['Offset'],
                             branch['EndOffset'], branch['Path'], branch['Ordinal'])
                    if point in points: raise ValueError('Duplicate branch identity')
                    points[point] = int(branch['Hits'])
        if any(hits < 0 for hits in points.values()): raise ValueError('Negative coverage counter')
        result[source] = points
    if not any(result.values()): raise ValueError('Empty production coverage inventory')
    return result


def union_reports(paths):
    merged = None
    for path in paths:
        current = counters(path)
        if merged is None:
            merged = copy.deepcopy(current)
            continue
        if current.keys() != merged.keys() or any(current[s].keys() != merged[s].keys() for s in merged):
            raise ValueError('Coverage source/line/branch denominators differ across partitions')
        for source, points in current.items():
            for point, hits in points.items():
                merged[source][point] += hits
    if merged is None: raise ValueError('No coverage partitions')
    return merged


def summary(points):
    # Match Coverlet 6.0.4 CoverageSummary: each method's sequence lines
    # contribute to the denominator, even when two methods share a source line.
    # https://github.com/coverlet-coverage/coverlet/blob/v6.0.4/src/coverlet.core/CoverageSummary.cs
    values = {kind: [hits for entries in points.values() for point, hits in entries.items() if point[0] == kind]
              for kind in ('line', 'branch')}
    return {kind: dict(covered=sum(h > 0 for h in hits), total=len(hits)) for kind, hits in values.items()}


def write_union(directory, points):
    path = Path(directory) / 'coverage-union.json'
    path.write_text(json.dumps({source: [[list(point), hits] for point, hits in sorted(entries.items())]
                                for source, entries in sorted(points.items())}, indent=2) + '\n')
    return path
