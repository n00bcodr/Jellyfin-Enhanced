"""Defence-in-depth source walk for the resource-required presentation API."""
import re
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3] / "Jellyfin.Plugin.JellyfinEnhanced"


def project_calls(source):
    # Mask comments and strings before balancing invocation arguments. The compiler enforces
    # the actual overload contract; this walk also catches an accidentally restored fallback.
    source = re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"', ' literal ', source, flags=re.S)
    for match in re.finditer(r'(\b\w+)?\??\.(Project|ProjectResource)\s*\(', source):
        # Unrelated APIs that share the name: quota rows, a list's order filtered to the caller, and the legacy collage
        # byte projection (images closed PR #936 drew, withheld; no title presentation).
        if match[1] in ('QuotaProjector', 'ListOrder', 'LegacyCollageProjection'):
            continue
        depth, args, start = 1, [], match.end()
        for index in range(start, len(source)):
            char = source[index]
            if char in '([{':
                depth += 1
            elif char in ')]}':
                depth -= 1
            if char == ',' and depth == 1:
                args.append(source[start:index].strip())
                start = index + 1
            if depth == 0:
                args.append(source[start:index].strip())
                yield match[1], match[2], args
                break


class PresentationResourceTests(unittest.TestCase):
    def test_every_declared_resource_and_strip_switch_has_matrix_cells(self):
        source = (ROOT / 'Services/ProviderPresentationSchema.cs').read_text()
        dispatch = source.split('private static string Resource(', 1)[1].split('private static JsonNode? Walk(', 1)[0]
        declared = set(re.findall(r'"([\w/-]+)"', dispatch))
        fixture = json.loads((ROOT.parent / 'tests/fixtures/presentation-settings-matrix.json').read_text())
        covered = {s['resource'] for s in fixture['samples']}
        # The native TV fixture exercises the same route selector as the producer and final filter.
        if any(s.get('provider') == 'tv/83867/ratings' for s in fixture['samples']):
            covered.add('tv-ratings')
        # The resource switch's implementation schema is not a public resource.
        self.assertEqual(declared - {'score', 'calendar-page', 'seerr-provider-country'}, covered)
        policy = (ROOT / 'Services/SpoilerGuard/SpoilerPresentation.cs').read_text()
        flags = set(re.findall(r'config\.(Spoiler(?:Strip\w+|ReplaceTitle|BlurArtwork|KeepMoviePosters))', policy))
        self.assertEqual(flags - {'SpoilerStripCastMode'}, set(fixture['settings']))

    def test_production_project_calls_name_a_resource(self):
        calls = 0
        for path in ROOT.rglob('*.cs'):
            for receiver, method, args in project_calls(path.read_text()):
                calls += 1
                needed = 6 if receiver == 'ProviderPresentationSchema' else 3 if method == 'ProjectResource' else 4
                self.assertTrue(len(args) >= needed or any(a.startswith('resource:') for a in args),
                                f'{path.relative_to(ROOT)}: {receiver}.Project lacks a declared resource')
        self.assertGreaterEqual(calls, 16)

    def test_no_optional_or_resourceless_overload_can_restore_the_fallback(self):
        for relative in ('Services/ProviderPresentationSchema.cs', 'Services/TitlePresentationGate.cs',
                         'Services/SpoilerGuard/SpoilerPresentation.cs'):
            source = (ROOT / relative).read_text()
            for signature in re.findall(r'public (?:static )?string Project\((.*?)\)\s*(?:=>|\{)', source, re.S):
                self.assertRegex(signature, r'\bstring resource\s*[,)]?', relative)
                self.assertNotRegex(signature, r'\bresource\s*=', relative)
        self.assertNotIn('public string Project(', (ROOT / 'Services/SpoilerGuard/SpoilerPresentation.cs').read_text())

    def test_walk_detects_bare_and_nested_calls(self):
        self.assertEqual([('caller', 'Project', ['Serialize(row, options)', 'literal'])],
                         list(project_calls('caller.Project(Serialize(row, options), "requests")')))
        self.assertEqual([], list(project_calls('// caller.Project(raw)\nQuotaProjector.Project(raw)')))
