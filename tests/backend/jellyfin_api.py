#!/usr/bin/env python3
"""Fetch the assemblies of each pinned Jellyfin release for the backend tests.

The user-action coverage tests (Integrations/IntegrationJellyfinApiUserActionTests.cs) read Jellyfin's own controllers
from the official image's Jellyfin.Api.dll, and (4a review round 10) follow their calls into the other Jellyfin server
assemblies next to it (Jellyfin.*, MediaBrowser.*, Emby.*, jellyfin.dll: where the interfaces the controllers call are
implemented). Round 19: the classifier reads the ancestry of the types those assemblies derive from (base classes and
interfaces in .NET and in Jellyfin's libraries) from the metadata of the assemblies next to them, as it does in a running
Jellyfin, so every assembly of /jellyfin is kept (the runtime and libraries the image ships with), not only the server's.
Jellyfin doesn't publish those as packages, so they are copied out of the pinned image (Support/jellyfin-api.json, by
digest) with `docker create` and `docker cp`: nothing in the image runs. The copies are cached outside the checkout
(JE_JELLYFIN_API_CACHE, else $XDG_CACHE_HOME or ~/.cache, then jellyfin-enhanced/jellyfin-api/<version>-<digest>/),
where the tests look for them. The tests fail when they are missing.
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


# Every assembly in /jellyfin: Jellyfin's own server assemblies (the code the classifier reads) and the runtime and
# libraries it ships with (read for their types' ancestry only). MARKER lists them once all are in place.
MARKER = "assemblies.txt"


def assembly(name):
    return name.endswith(".dll") and not name.startswith("Jellyfin.Plugin.")


def docker(*args):
    return subprocess.run(["docker", *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True).stdout.strip()


def complete(dll):
    """The cache holds every assembly of the image's /jellyfin (MARKER, written last, lists them)."""
    marker = dll.parent / MARKER
    if not dll.is_file() or not marker.is_file():
        return False
    names = marker.read_text().split()
    return "MediaBrowser.Controller.dll" in names and all((dll.parent / name).is_file() for name in names)


def fetch(target, pin):
    dll = location(pin)
    if complete(dll):
        print(f"{target}: Jellyfin {pin['version']} assemblies are cached at {dll.parent}", flush=True)
        return
    image = pin["image"]
    try:
        docker("image", "inspect", image)
    except subprocess.CalledProcessError:
        print(f"{target}: pulling {image}", flush=True)
        docker("pull", image)
    container = docker("create", image)
    staging = dll.parent.with_name(dll.parent.name + "." + uuid.uuid4().hex + ".partial")
    try:
        staging.mkdir(parents=True)
        # The image's /jellyfin, copied whole into the staging folder, then its assemblies kept.
        docker("cp", container + ":/jellyfin/.", str(staging))
        names = sorted(n for n in os.listdir(staging) if assembly(n))
        if "Jellyfin.Api.dll" not in names or "MediaBrowser.Controller.dll" not in names:
            raise RuntimeError(f"{image} has no /jellyfin/Jellyfin.Api.dll or MediaBrowser.Controller.dll")
        dll.parent.mkdir(parents=True, exist_ok=True)
        for name in names:
            os.replace(staging / name, dll.parent / name)
        (dll.parent / MARKER).write_text("\n".join(names) + "\n")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        docker("rm", container)
    print(f"{target}: copied Jellyfin {pin['version']}'s {len(names)} assemblies to {dll.parent}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=["jf10", "jf12", "all"], default="all")
    args = parser.parse_args()
    pins = json.loads(PINS.read_text())
    if not shutil.which("docker"):
        missing = [t for t in pins if args.target in ("all", t) and not complete(location(pins[t]))]
        if missing:
            print("docker is needed once to copy the assemblies out of the pinned Jellyfin images (" + ", ".join(missing) + ").", file=sys.stderr)
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
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
