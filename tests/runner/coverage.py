#!/usr/bin/env python3
"""Enforce conservative measured backend floors without hiding untested code."""
import argparse
import math
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from coverage_union import one_report, union_reports, summary, write_union
from partitions import validate_results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results', type=Path)
    parser.add_argument('--manifest', type=Path, help='Require complete successful disjoint backend partitions')
    args = parser.parse_args()
    try:
        if args.manifest:
            manifest = json.loads(args.manifest.read_text())
            validate_results(manifest, args.results)
            reports = [one_report(args.results / shard['id'], 'coverage.json') for shard in manifest['shards']]
            points = union_reports(reports)
            totals = summary(points)
            measured = {kind: math.floor((counts['covered'] / counts['total']) * 10000) / 100 if counts['total'] else 100.0
                        for kind, counts in totals.items()}
            source = write_union(args.results, points)
        else:
            source = one_report(args.results, 'coverage.cobertura.xml')
            root = ET.parse(source).getroot()
            package = root.find("./packages/package[@name='Jellyfin.Plugin.JellyfinEnhanced']")
            if package is None:
                raise ValueError('Production plugin is missing from coverage report')
            measured = {kind: round(float(package.attrib[kind + '-rate']) * 100, 4) for kind in ('line', 'branch')}
    except (ValueError, KeyError, OSError, ET.ParseError) as error:
        parser.error(str(error))
    # Below the measured values recorded in tests/docs/validation.md for both targets.
    # Raise the floors as coverage improves; never lower them to accept a loss.
    floors = {'line': 47.0, 'branch': 35.0}
    report = {'measured_percent': measured, 'minimum_percent': floors,
              'source': str(source), 'exclusions': [],
              'passed': all(measured[kind] >= floor for kind, floor in floors.items())}
    # Default artifacts keep the pre-tier schema; speedup diagnostics are additive.
    sidecar = args.results / 'coverage-summary.totals.json'
    if args.manifest and len(manifest['shards']) > 1:
        sidecar.write_text(json.dumps(totals, indent=2) + '\n')
    else:
        sidecar.unlink(missing_ok=True)
    (args.results / 'coverage-summary.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
