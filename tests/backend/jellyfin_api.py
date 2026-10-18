#!/usr/bin/env python3
"""Fetch the Jellyfin.Api assembly of each pinned Jellyfin release for the backend tests.

The user-action coverage tests (Integrations/IntegrationJellyfinApiUserActionTests.cs) read Jellyfin's own controllers
from the official image's Jellyfin.Api.dll. Jellyfin doesn't publish that assembly as a package, so it is copied out of
the pinned image (Support/jellyfin-api.json, by digest) with `docker create` and `docker cp`: nothing in the image runs.
The copy is cached outside the checkout (JE_JELLYFIN_API_CACHE, else $XDG_CACHE_HOME or ~/.cache, then
jellyfin-enhanced/jellyfin-api/<version>-<digest>/), where the tests look for it. The tests fail when it is missing.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

PINS = Path(__file__).resolve().parent / "Support" / "jellyfin-api.json"


def cache_root():
    if os.environ.get("JE_JELLYFIN_API_CACHE"):
        return Path(os.environ["JE_JELLYFIN_API_CACHE"])
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "jellyfin-enhanced" / "jellyfin-api"


def location(pin):
    """Where the tests read the pinned release's Jellyfin.Api.dll (keep in step with JellyfinApiAssembly.cs)."""
    digest = pin["image"].split("@sha256:", 1)[1]
    return cache_root() / (pin["version"] + "-" + digest[:12]) / "Jellyfin.Api.dll"


def docker(*args):
    return subprocess.run(["docker", *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True).stdout.strip()


def fetch(target, pin):
    dll = location(pin)
    if dll.is_file():
        print(f"{target}: Jellyfin {pin['version']} Jellyfin.Api.dll is cached at {dll}", flush=True)
        return
    image = pin["image"]
    try:
        docker("image", "inspect", image)
    except subprocess.CalledProcessError:
        print(f"{target}: pulling {image}", flush=True)
        docker("pull", image)
    container = docker("create", image)
    partial = dll.with_name("Jellyfin.Api.dll." + uuid.uuid4().hex + ".partial")
    try:
        dll.parent.mkdir(parents=True, exist_ok=True)
        docker("cp", container + ":/jellyfin/Jellyfin.Api.dll", str(partial))
        os.replace(partial, dll)
    finally:
        partial.unlink(missing_ok=True)
        docker("rm", container)
    print(f"{target}: copied Jellyfin {pin['version']} Jellyfin.Api.dll to {dll}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=["jf10", "jf12", "all"], default="all")
    args = parser.parse_args()
    pins = json.loads(PINS.read_text())
    if not shutil.which("docker"):
        missing = [t for t in pins if args.target in ("all", t) and not location(pins[t]).is_file()]
        if missing:
            print("docker is needed once to copy Jellyfin.Api.dll out of the pinned Jellyfin images (" + ", ".join(missing) + ").", file=sys.stderr)
            return 1
    for target, pin in pins.items():
        if args.target in ("all", target):
            fetch(target, pin)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        print(f"docker {' '.join(error.cmd[1:])} failed: {error.stdout}", file=sys.stderr)
        sys.exit(1)
