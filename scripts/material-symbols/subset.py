#!/usr/bin/env python3
"""Subset the bundled Material Symbols fonts to the glyphs the client uses.

The plugin ships two Material Symbols faces (Rounded and Outlined) for the
poster tags, awards, reviews, calendar, release dates and people tags. The
full fonts are ~340 KB and ~320 KB each; the client renders a few dozen icons,
so JE's own icons use subsets built by this script (a couple of KB each).
Ligature lookups are kept, so `<span class="je-msym-rounded">cake</span>`
still resolves.

Layout of `Jellyfin.Plugin.JellyfinEnhanced/js/fonts/` (all four embedded):

    materialsymbolsrounded.woff2           full font, input to this script,
    materialsymbolsoutlined.woff2          declared under the public family
                                           names ('Material Symbols Rounded',
                                           'Material Symbols Outlined') for
                                           themes and custom CSS that rely on
                                           JE providing them
    materialsymbolsrounded-subset.woff2    output of this script, declared
    materialsymbolsoutlined-subset.woff2   under the JE-private family names
                                           ('JE Material Symbols Rounded',
                                           'JE Material Symbols Outlined')
                                           that JE's own rules use

The two sets must stay separate: themes declare the public families
themselves, and a subset under the same name would shadow the theme's full
font, so every icon outside the subset would render as its ligature name.
For the same reason JE's icon elements use the JE-private classes
`je-msym-rounded` / `je-msym-outlined`, never Google's `material-symbols-*`
classes, which themes and other plugins use and style for their own icons;
the script fails if a client source or the config page still uses them
(enhanced/ui-styles.js may, in its zero-specificity `:where()` fallback that
gives other code's icons the full fonts).

Usage (from the repository root):

    pip install --user fonttools brotli
    python3 scripts/material-symbols/subset.py

Add every new icon name to ICONS below before using it in a component, then
re-run the script and commit the regenerated subsets. The script also scans
the client sources for literal icon names inside symbol-font elements and
fails if one is missing from ICONS, but names built at runtime (maps,
ternaries) can only be covered by the list. The font URL carries the plugin
version as a cache key (`JE.cdn.font`), so a rebuilt subset is picked up on
the next release.
"""
import re
import subprocess
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
JS = ROOT / 'Jellyfin.Plugin.JellyfinEnhanced' / 'js'
FONTS = JS / 'fonts'
CONFIG_PAGE = ROOT / 'Jellyfin.Plugin.JellyfinEnhanced' / 'Configuration' / 'configPage.html'
CONFIG_CSS = CONFIG_PAGE.with_name('configPage.css')
UI_STYLES = JS / 'enhanced' / 'ui-styles.js'

# Icon names per face. Keep the comments: they say which module needs a name.
ICONS = {
    'rounded': {
        # awards/awards.js
        'auto_awesome',
        # tags/peopletags.js (age chips, birthplace)
        'event_busy', 'cake', 'movie', 'place',
        # elsewhere/reviews.js, tags/userreviewtags.js, Configuration/configPage.html
        'person_heart',
        # arr/calendar/* (agenda icons, status icons, filter bar)
        'bookmark', 'visibility', 'visibility_off', 'download', 'check_circle',
        'local_movies', 'ondemand_video', 'album', 'tv_guide', 'animation',
        # enhanced/itemdetails/features-release-dates.js
        # (local_movies, ondemand_video, album, tv_guide above)
        # arr/requests/* release-date label (shares .je-release-date-icon)
        'tv', 'cloud',
        # enhanced/itemdetails/features-details-media-info.js via the
        # .mediaInfoItem-* .material-icons rule in enhanced/ui-styles.js
        'hourglass_empty', 'save', 'translate',
    },
    # tags/genretags.js genreIconMap: scanned from the source, nothing to list.
    'outlined': set(),
}

# Glyphs the ligatures are composed of. Material Symbols names use a-z, 0-9
# and underscore; space keeps "icon text" runs measurable while loading.
COMPONENT_GLYPHS = list('abcdefghijklmnopqrstuvwxyz') + [
    'digit_zero', 'digit_one', 'digit_two', 'digit_three', 'digit_four',
    'digit_five', 'digit_six', 'digit_seven', 'digit_eight', 'digit_nine',
    'underscore', 'space',
]

# Face -> (full font, subset) file names, both under FONTS.
FACES = {
    'rounded': ('materialsymbolsrounded.woff2', 'materialsymbolsrounded-subset.woff2'),
    'outlined': ('materialsymbolsoutlined.woff2', 'materialsymbolsoutlined-subset.woff2'),
}

ROUNDED_CLASSES = ('je-msym-rounded', 'je-release-date-icon', 'je-userreview-icon')
OUTLINED_CLASS = 'je-msym-outlined'

# Google's standard classes: other code's icons, never JE's (see the docstring).
GENERIC_CLASS = re.compile(r'material-symbols-(?:rounded|outlined)')
# The one allowed use, ui-styles.js's fallback for other code's icons.
GENERIC_FALLBACK = re.compile(r':where\(\.material-symbols-(?:rounded|outlined)\)')
# HTML, CSS/JS block and JS line comments. The lookbehinds skip `image/*`,
# `'*/*'` and `https://` inside strings.
COMMENTS = re.compile(r'<!--.*?-->|(?<![\w\'"*/])/\*.*?\*/|(?<![:\w\'"/])//[^\n]*', re.S)


def ligature_map(font):
    """Map each icon name (the ligature's component string) to its glyph.

    Glyph names are not reliable: several names are aliases of one glyph
    (`local_movies` and `theaters`, `location_on` and `place`, ...).
    """
    names = {}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for subtable in lookup.SubTable:
            table = getattr(subtable, 'ExtSubTable', subtable)
            for first, ligatures in getattr(table, 'ligatures', {}).items():
                for ligature in ligatures:
                    text = first + ''.join(ligature.Component)
                    names[text.replace('underscore', '_')] = ligature.LigGlyph
    return names


def sources():
    """The client sources and the config page."""
    return sorted(JS.rglob('*.js')) + [CONFIG_PAGE, CONFIG_CSS]


def blank(match):
    """Blank out a match, keeping its newlines so line numbers survive."""
    return re.sub(r'[^\n]', ' ', match.group(0))


def generic_class_uses():
    """List `path:line` for every use of Google's classes in JE's sources."""
    hits = []
    for path in sources():
        text = COMMENTS.sub(blank, path.read_text(encoding='utf-8'))
        if path == UI_STYLES:
            text = GENERIC_FALLBACK.sub(blank, text)
        for match in GENERIC_CLASS.finditer(text):
            line = text.count('\n', 0, match.start()) + 1
            hits.append(f'{path.relative_to(ROOT)}:{line}')
    return hits


def scan_sources():
    """Collect literal icon names from the client sources and config page."""
    found = {'rounded': set(), 'outlined': set()}
    genre = (JS / 'tags' / 'genretags.js').read_text(encoding='utf-8')
    match = re.search(r"const genreIconMap = \{(.*?)\n\s*\};", genre, re.S)
    if match:
        found['outlined'].update(re.findall(r":\s*'([a-z0-9_]+)'", match.group(1)))
    element = re.compile(r'<span\s+class="([^"]*)"[^>]*>\s*([a-z0-9_]+)\s*</span>')
    for path in sources():
        text = path.read_text(encoding='utf-8')
        for classes, name in element.findall(text):
            if OUTLINED_CLASS in classes:
                found['outlined'].add(name)
            elif any(cls in classes for cls in ROUNDED_CLASSES):
                found['rounded'].add(name)
    return found


def main():
    found = scan_sources()
    ok = True
    for face, names in found.items():
        missing = sorted(names - ICONS[face])
        if face == 'outlined':
            # The genre map is the source of truth for the outlined face.
            ICONS[face].update(names)
            missing = []
        if missing:
            ok = False
            print(f'ERROR: {face}: icon names used in sources but not listed in ICONS: {missing}')
    generic = generic_class_uses()
    if generic:
        ok = False
        print('ERROR: JE icons must use the je-msym-rounded / je-msym-outlined classes, '
              f'not material-symbols-rounded / material-symbols-outlined: {generic}')
    if not ok:
        sys.exit(1)

    for face, (src_name, out_name) in FACES.items():
        names = sorted(ICONS[face])
        src = FONTS / src_name
        out = FONTS / out_name
        ligatures = ligature_map(TTFont(src))
        unknown = [name for name in names if name not in ligatures]
        if unknown:
            print(f'ERROR: {face}: no ligature in {src_name} for {unknown}')
            sys.exit(1)
        glyphs = ','.join(COMPONENT_GLYPHS + sorted({ligatures[name] for name in names}))
        cmd = [
            sys.executable, '-m', 'fontTools.subset', str(src),
            f'--glyphs={glyphs}',
            '--layout-features=rlig',   # the name -> icon ligatures
            '--no-layout-closure',      # closure over a-z would pull every ligature back in
            '--flavor=woff2',
            '--no-hinting',
            '--glyph-names',            # keep names so the subset stays inspectable
            f'--output-file={out}',
        ]
        subprocess.run(cmd, check=True)
        print(f'{out_name}: {len(names)} icons, {out.stat().st_size:,} bytes '
              f'(source {src.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
