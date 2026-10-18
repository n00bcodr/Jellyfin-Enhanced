"""The configuration flag groups the docs and dashboard read are derived from the real sources."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]


def generator():
    spec = importlib.util.spec_from_file_location('generate_config_flag_groups', ROOT / 'scripts/generate_config_flag_groups.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ConfigFlagGroupsTests(unittest.TestCase):
    def test_per_person_preferences_come_from_the_real_settings_class(self):
        # The settings class was renamed upstream (UserSettings -> JellyfinEnhancedUserSettings); the generator must still
        # find it, with every per-person on/off setting and its class.
        module = generator()
        source = module.USER_CONFIG_CS.read_text(encoding='utf-8')
        preferences = module.extract_user_preferences(source)
        self.assertIn('AutoMovieRequests', preferences)
        self.assertIn('AutoSeasonRequests', preferences)
        self.assertIn('ListSwapIn', preferences)

    def test_the_old_class_name_is_still_read(self):
        module = generator()
        preferences = module.extract_user_preferences('public class UserSettings { public bool? AutoMovieRequests { get; set; } }')
        self.assertEqual(['AutoMovieRequests'], list(preferences))


if __name__ == '__main__':
    unittest.main()
