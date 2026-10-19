"""The display-language policy (js/language-policy.json and its copy in js/enhanced/translations.js) lists exactly the
locale bundles JE ships (stage 1 fix round 3, RBS1-R3-2): a locale file added or removed without regenerating fails here."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


def generator():
    spec = importlib.util.spec_from_file_location('generate_language_policy', ROOT / 'scripts/generate_language_policy.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LanguagePolicyTests(unittest.TestCase):
    def test_the_committed_policy_and_its_client_copy_are_current(self):
        self.assertEqual([], generator().stale(ROOT))

    def test_the_policy_lists_every_locale_file_and_nothing_else(self):
        policy = json.loads((ROOT / 'Jellyfin.Plugin.JellyfinEnhanced/js/language-policy.json').read_text(encoding='utf-8'))
        files = sorted((p.stem for p in (ROOT / 'Jellyfin.Plugin.JellyfinEnhanced/js/locales').glob('*.json')), key=str.upper)
        self.assertEqual(files, policy['shipped'])
        self.assertIn('en', policy['shipped'])

    def test_a_locale_added_or_removed_without_regenerating_is_reported(self):
        module = generator()
        with tempfile.TemporaryDirectory() as scratch:
            copy = Path(scratch)
            js = copy / 'Jellyfin.Plugin.JellyfinEnhanced/js'
            shutil.copytree(ROOT / 'Jellyfin.Plugin.JellyfinEnhanced/js/locales', js / 'locales')
            (js / 'enhanced').mkdir(parents=True)
            shutil.copy(ROOT / 'Jellyfin.Plugin.JellyfinEnhanced/js/language-policy.json', js / 'language-policy.json')
            shutil.copy(ROOT / 'Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/translations.js', js / 'enhanced/translations.js')
            self.assertEqual([], module.stale(copy))
            (js / 'locales/haw.json').write_text('{}', encoding='utf-8')
            self.assertEqual(['Jellyfin.Plugin.JellyfinEnhanced/js/language-policy.json', 'Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/translations.js'], module.stale(copy))
            module.write(copy)
            self.assertEqual([], module.stale(copy))
            self.assertIn('haw', json.loads((js / 'language-policy.json').read_text(encoding='utf-8'))['shipped'])
            (js / 'locales/haw.json').unlink()
            (js / 'locales/gsw.json').unlink()
            self.assertEqual(2, len(module.stale(copy)))

    def test_the_client_copy_is_the_policy_without_its_note(self):
        module = generator()
        source = (ROOT / 'Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/translations.js').read_text(encoding='utf-8')
        policy = json.loads((ROOT / 'Jellyfin.Plugin.JellyfinEnhanced/js/language-policy.json').read_text(encoding='utf-8'))
        del policy['about']
        self.assertEqual(policy, module.client_copy(source))


if __name__ == '__main__':
    unittest.main()
