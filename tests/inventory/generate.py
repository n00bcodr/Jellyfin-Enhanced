#!/usr/bin/env python3
"""Inventory production surfaces for coverage review; this is not a behavioral test.

Extraction is deliberately conservative and lexical (not a C# parser). The output
retains paths/line numbers so reviewers can inspect overloads and attributes.
Run with --check in CI to detect an inventory needing regeneration.
"""
import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCTION = ROOT / 'Jellyfin.Plugin.JellyfinEnhanced'
OUTPUT = ROOT / 'tests/docs/production-inventory.json'


def line_number(text, offset):
    return text.count('\n', 0, offset) + 1


def inventory():
    project = ET.parse(PRODUCTION / 'JellyfinEnhanced.csproj')
    targets = []
    for group in project.findall('PropertyGroup'):
        selector = re.search(r"==\s*'([^']+)'", group.get('Condition', ''))
        if selector and group.findtext('TargetFramework'):
            targets.append({'selector': selector[1], 'framework': group.findtext('TargetFramework'),
                            'jellyfin_reference': group.findtext('JellyfinVersion')})
    result = {'schema_version': 1,
              'extraction': 'Lexical inventory only; entries do not imply behavioral coverage. Public property types/defaults and route attributes require semantic review.',
              'build_targets': targets,
              'files': [], 'routes': [], 'configuration_properties': [],
              'storage_references': [], 'scheduled_tasks': [], 'locales': []}
    for path in sorted(PRODUCTION.rglob('*')):
        if not path.is_file() or any(part in ('obj', 'bin') for part in path.relative_to(PRODUCTION).parts):
            continue
        relative = path.relative_to(ROOT).as_posix()
        if path.suffix not in ('.cs', '.js', '.html', '.css', '.json'):
            continue
        text = path.read_text(encoding='utf-8-sig')
        category = path.relative_to(PRODUCTION).parts[0]
        result['files'].append({'path': relative, 'category': category, 'lines': len(text.splitlines())})
        if category == 'Controllers' and path.suffix == '.cs':
            for match in re.finditer(r'\[Http(Get|Post|Put|Delete|Patch|Head|Options)\("([^"\n]*)"\)\]', text):
                tail = text[match.end():]
                method = re.search(r'\bpublic\s+(?:async\s+)?[^\n]+?\s+(\w+)\s*\(', tail)
                attributes = tail[:method.start()] if method else ''
                result['routes'].append({'verb': match[1].upper(), 'path': '/JellyfinEnhanced/' + match[2],
                                         'method': method[1] if method else None, 'file': relative,
                                         'line': line_number(text, match.start()),
                                         'following_attributes': re.findall(r'\[([^\n]+)\]', attributes)})
        if category == 'Configuration' and path.suffix == '.cs':
            classes = list(re.finditer(r'\bclass\s+(\w+)', text))
            for match in re.finditer(r'\bpublic\s+([\w<>?,.\[\] ]+?)\s+(\w+)\s*\{\s*get\s*;\s*(?:set|init)\s*;\s*\}(?:\s*=\s*([^;]+);)?', text):
                preceding = [item for item in classes if item.start() < match.start()]
                constructor = re.search(r'^\s*' + re.escape(match[2]) + r'\s*=\s*([^;\n]+);', text, re.M)
                result['configuration_properties'].append({'class': preceding[-1][1] if preceding else None,
                    'name': match[2], 'type': match[1].strip(), 'initializer': match[3],
                    'constructor_assignment': constructor[1] if constructor else None,
                    'file': relative, 'line': line_number(text, match.start())})
        if path.suffix in ('.cs', '.js'):
            for match in re.finditer(r'''["']([^"'\n]{1,180}\.(?:json|xml|db|sqlite))["']''', text):
                result['storage_references'].append({'literal': match[1], 'file': relative, 'line': line_number(text, match.start())})
        if category == 'ScheduledTasks' and re.search(r':\s*IScheduledTask', text):
            result['scheduled_tasks'].append({'file': relative, 'class': path.stem,
                'key': next(iter(re.findall(r'\bKey\s*=>\s*"([^"]+)"', text)), None)})
        if 'js/locales/' in relative and path.suffix == '.json':
            content = json.loads(text)
            result['locales'].append({'file': relative, 'top_level_keys': len(content)})
    result['counts'] = {key: len(value) for key, value in result.items() if isinstance(value, list)}
    return json.dumps(result, indent=2, ensure_ascii=False) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail if committed inventory is stale')
    args = parser.parse_args()
    generated = inventory()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding='utf-8') != generated:
            raise SystemExit('Inventory is stale: run python3 tests/inventory/generate.py')
        print('Production inventory is current (this does not assert behavioral coverage).')
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_text(generated, encoding='utf-8')
        print(f'Wrote {OUTPUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
