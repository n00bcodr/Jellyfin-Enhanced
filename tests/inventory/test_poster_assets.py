"""Regressions for source-rating assets surviving a complete poster asset build."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("poster_assets", REPO / "scripts/build_poster_assets.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class RatingSourceAssetsTests(unittest.TestCase):
    def test_complete_build_emits_source_logos_and_records_them_in_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            out = root / "out"
            out.mkdir()
            (out / "obsolete.json").write_text("{}")
            # Skip external downloads/rasterisation; exercise the actual clean build,
            # repository SVG conversion, output writes and manifest generation.
            with patch.object(assets, "build_noto"), patch.object(assets, "build_icons", return_value=[]), \
                    patch.object(assets, "build_vector_icons"), patch.object(assets, "build_flags", return_value=[]), \
                    patch.object(assets, "build_licences"), patch.object(assets, "tool_versions", return_value={}):
                assets.build(out, root / "cache", root / "work")
            self.assertFalse((out / "obsolete.json").exists())
            logos = json.loads((out / "rating-source-icons.json").read_text())
            self.assertEqual(set(logos), {"rating-" + name for name in
                             ["imdb", "tmdb", "rtCritic", "rtAudience", "metacritic", "letterboxd", "trakt",
                              "myAnimeList", "aniList", "metacriticUser", "rogerEbert", "mdblist"]})
            for logo in logos.values():
                self.assertTrue(logo["paths"])
                self.assertTrue(all(path["d"] and path["fill"] for path in logo["paths"]))
            manifest = json.loads((out / "manifest.json").read_text())
            self.assertEqual(manifest["outputs"]["rating-source-icons.json"], assets.outputs_of(out)["rating-source-icons.json"])
            self.assertIn("Jellyfin.Plugin.JellyfinEnhanced/js/tags/rating-sources.js", manifest["inputs"])

    def test_committed_rating_logos_match_current_web_paths(self):
        committed = json.loads((assets.DEFAULT_OUT / "rating-source-icons.json").read_text())
        self.assertEqual(committed, assets.rating_source_icons())


if __name__ == "__main__":
    unittest.main()
