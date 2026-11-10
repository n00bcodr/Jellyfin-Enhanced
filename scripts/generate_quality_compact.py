#!/usr/bin/env python3
"""Generate TypeScript/native compact labels; client-build owns executable JS."""
import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    """Write or check both deterministic projections of the source table."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    subprocess.run(["node", str(ROOT / "scripts/tag-data.mjs"), "--quality", *(["--check"] if args.check else [])], check=True)


if __name__ == "__main__":
    main()
