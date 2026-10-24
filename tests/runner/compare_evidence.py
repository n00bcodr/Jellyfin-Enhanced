#!/usr/bin/env python3
"""Compare complete case inventories and coverage points without printing fixture data."""
import argparse
from collections import Counter
import json
from pathlib import Path
import sys

from coverage_union import summary, union_reports
from partitions import trx_cases


def frontend_points(path):
    result = {}
    for filename, record in json.loads(Path(path).read_text()).items():
        source = 'Jellyfin.Plugin.JellyfinEnhanced/js/' + filename.replace('\\', '/').split('/Jellyfin.Plugin.JellyfinEnhanced/js/', 1)[1]
        points = {}
        for map_name, hits_name in [('statementMap', 's'), ('fnMap', 'f'), ('branchMap', 'b')]:
            for identity, location in record[map_name].items():
                key = json.dumps(location, sort_keys=True)
                value = record[hits_name][identity]
                hit = tuple(v > 0 for v in value) if isinstance(value, list) else value > 0
                points.setdefault((map_name, key), []).append(hit)
        result[source] = {point: Counter(hits) for point, hits in points.items()}
    return result


def compare_frontend(before, after):
    a, b = frontend_points(before), frontend_points(after)
    # Point locations can repeat. Preserve their multiplicity as well as their
    # locations when proving that the coverage denominator did not change.
    def schema(files):
        return {name: {point: sum(hits.values()) for point, hits in points.items()}
                for name, points in files.items()}
    return dict(files_before=len(a), files_after=len(b),
                inventory_equal=schema(a) == schema(b),
                differing_files=[name for name in sorted(a.keys() | b.keys()) if a.get(name) != b.get(name)])


def compare_backend(before_trx, after_trx, before_coverage, after_coverage, before_root=None, after_root=None):
    before = [case for path in before_trx for case in trx_cases(path)]
    after = [case for path in after_trx for case in trx_cases(path)]
    def names(cases, root):
        return Counter((c['name'].replace(str(root), '<repository>') if root else c['name'], c['outcome']) for c in cases)
    a, b = union_reports(before_coverage), union_reports(after_coverage)
    return dict(cases_before=len(before), cases_after=len(after),
                cases_equal=names(before, before_root) == names(after, after_root),
                totals_before=summary(a), totals_after=summary(b),
                inventory_equal=a.keys() == b.keys() and all(a[s].keys() == b[s].keys() for s in a),
                differing_hit_files=[s for s in sorted(a.keys() | b.keys())
                                     if {p: h > 0 for p, h in a.get(s, {}).items()} != {p: h > 0 for p, h in b.get(s, {}).items()}])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before', type=Path)
    parser.add_argument('after', type=Path)
    args = parser.parse_args()
    result = compare_frontend(args.before, args.after)
    print(json.dumps(result, indent=2))
    return 0 if result['inventory_equal'] and not result['differing_files'] else 1


if __name__ == '__main__':
    sys.exit(main())
