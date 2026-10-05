#!/usr/bin/env python3
"""Enforce conservative measured backend floors without hiding untested code."""
import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results', type=Path)
    args = parser.parse_args()
    # VSTest copies attachments into the TRX results directory as well as the
    # collector's GUID directory. Identical copies describe the same run.
    unique = {}
    for report in args.results.rglob('coverage.cobertura.xml'):
        unique.setdefault(hashlib.sha256(report.read_bytes()).hexdigest(), report)
    reports = list(unique.values())
    if len(reports) != 1:
        parser.error(f'Expected exactly one fresh coverage report, found {len(reports)} in {args.results}')
    root = ET.parse(reports[0]).getroot()
    package = root.find("./packages/package[@name='Jellyfin.Plugin.JellyfinEnhanced']")
    if package is None:
        parser.error('Production plugin is missing from coverage report')
    measured = {kind: round(float(package.attrib[kind + '-rate']) * 100, 4) for kind in ('line', 'branch')}
    # The integrated baseline exceeded 41% lines / 29% branches. Leave a small
    # margin across build targets; review and raise floors as coverage improves.
    floors = {'line': 38.0, 'branch': 27.0}
    report = {'measured_percent': measured, 'minimum_percent': floors,
              'source': str(reports[0]), 'exclusions': [],
              'passed': all(measured[kind] >= floor for kind, floor in floors.items())}
    (args.results / 'coverage-summary.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
