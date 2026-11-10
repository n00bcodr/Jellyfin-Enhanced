#!/usr/bin/env python3
"""Generate the typed web Status vocabulary and its native formatting tables."""
import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    """Project the shared table to TypeScript; client-build owns executable JS."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--table-only", action="store_true", help="Project vocabulary only; retain the separately pinned ICU date/number tables.")
    args = parser.parse_args()
    check = ["--check"] if args.check else []
    if not args.table_only:
        for script in ["generate_status_dates.mjs", "generate_score_numbers.mjs"]:
            subprocess.run(["node", str(ROOT / "scripts" / script), *check], check=True)
    subprocess.run(["node", str(ROOT / "scripts/tag-data.mjs"), "--status", *check], check=True)


if __name__ == "__main__":
    main()
