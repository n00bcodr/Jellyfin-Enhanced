"""Status controls must keep readable generated analytics labels."""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("config_groups", ROOT / "scripts/generate_config_flag_groups.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StatusFlagLabelsTests(unittest.TestCase):
    def test_translated_dashboard_controls_keep_their_registry_labels(self):
        parser = module.ConfigPageParser()
        parser.feed(module.CONFIG_PAGE.read_text())
        for key in ["StatusTagsSchedule", "StatusTagsMilestones", "StatusTagsSeriesStatus"]:
            self.assertTrue(parser.labels[key].startswith("Show "), key)
            self.assertEqual("Media Tags", parser.groups[key])
            self.assertEqual("Display", parser.tabs[key])


if __name__ == "__main__":
    unittest.main()
