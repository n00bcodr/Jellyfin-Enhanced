"""Status controls must keep readable generated analytics labels.

The status family switches live on the Media Tags admin page (section
modules), not on the main configuration page, so the registry entry comes
from the generator's section-module reader.
"""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("config_groups", ROOT / "scripts/generate_config_flag_groups.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StatusFlagLabelsTests(unittest.TestCase):
    def test_translated_media_tags_controls_keep_their_registry_labels(self):
        declared = {}
        for prop, group_title, label in module.media_tags_fields():
            declared.setdefault(prop, (group_title, label))
        for key in ["StatusTagsSchedule", "StatusTagsMilestones", "StatusTagsSeriesStatus", "StatusTagsScenes", "StatusTagsLeaving", "StatusTagsDirectPlay"]:
            self.assertIn(key, declared, key)
            group_title, label = declared[key]
            # A real English label, not a raw translation key or an empty string.
            self.assertTrue(label and label[0].isupper() and "_" not in label, (key, label))
            self.assertTrue(group_title, key)

    def test_status_controls_are_not_on_the_main_configuration_page(self):
        parser = module.ConfigPageParser()
        parser.feed(module.CONFIG_PAGE.read_text())
        for key in ["StatusTagsSchedule", "StatusTagsMilestones", "StatusTagsSeriesStatus"]:
            self.assertNotIn(key, parser.labels, key)


if __name__ == "__main__":
    unittest.main()
