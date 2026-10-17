"""Native poster tags draw from committed tables derived from the web's JS/CSS; they must not drift from them."""
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]


class PosterAssetTests(unittest.TestCase):
    def test_committed_poster_assets_match_the_web_sources(self):
        # A rating colour, quality colour, genre icon or flag the web gained since the assets were last built would
        # otherwise draw differently on native posters than on web cards.
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/build_poster_assets.py'), '--check'], capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
