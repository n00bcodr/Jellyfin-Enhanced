# Real Jellyfin host regression checks

Run on Linux with Python 3, .NET SDK 10, and a local Docker daemon:

```sh
python3 tests/host/run.py --target all
# Each compatibility line can run separately in CI:
python3 tests/host/run.py --target jf10 --artifacts .engineering-artifacts/host
python3 tests/host/run.py --target jf12 --artifacts .engineering-artifacts/host
```

The runner builds production JE separately for each target using temporary MSBuild artifact directories. It installs the actual DLL into the newest official Jellyfin image of each compatibility line: `jellyfin/jellyfin:10.11` (the newest 10.11.x) and `jellyfin/jellyfin:12` (the newest 12.x; `latest` is deliberately avoided because it would move to the next major line). Every run first pulls the tag, so a stale local image is never tested; a failed pull fails the run instead of falling back to a cached image. The container then runs the exact pulled digest. Because the tags move, each target's `report.json` records what actually ran: `image` (the tag), `resolved_image` (the repository digest) and `server_version` (from `/System/Info/Public`); the run log prints both too. A run covers only the release the tag pointed at that day, not every patch release.

Each run owns a uniquely named `je-regression-*` container and internal bridge network, both labelled `je-regression.run=<that name>`, plus temporary configuration/cache, a synthetic one-second WAV, and three disposable users. Docker's existing subnets are inspected before allocating a small unused test subnet; if another run takes the same subnet first, network creation moves on to the next free one. The bridge must be reachable from the runner, so remote Docker daemons and Docker Desktop are not supported. No ports are published. External network access is blocked at the container network: background CDN failures in server logs are expected and no provider credentials are required. Pulling the Jellyfin images and first-time NuGet retrieval require internet access on the runner; cached NuGet packages allow the build to run offline.

Checks exercise the real HTTP pipeline: plugin loading/host compatibility, embedded assets, generated media scanning, restricted-library enumeration, anonymous authentication rejection, administrator-only APIs, cross-user read/write rejection for six user documents, bootstrap identity/private-config isolation, fake-secret protection, preference persistence, and restart behavior. Both regular and restricted users participate. Without `--browser`, this is an HTTP host suite. Native clients are not exercised. It does not claim playback, image rendering, trickplay, Seerr integration, or every scheduled task is covered.

Artifacts contain `build.log`, `server.log`, and machine-readable `report.json` (tag, resolved digest, server version, passed checks and status) per target. Errors fail the process; a missing prerequisite never counts as a skip or pass. Ephemeral passwords/tokens are redacted from server logs. Cleanup always attempts log collection, container removal and network removal by the run's unique name, each independently and including after failed, partial or interrupted (Ctrl+C, SIGTERM) creation; a resource that was never created is not an error. Only resources created by the invocation are removed; no existing services are modified. A process killed with SIGKILL cannot run cleanup; list leftovers with `docker ps -a --filter label=je-regression.run` and `docker network ls --filter label=je-regression.run`, and remove them after verifying ownership.

## Real browser journey

Add `--browser` to execute Chromium against each real host after the HTTP and restart checks:

```sh
npm ci
npx playwright install --with-deps chromium
python3 tests/host/run.py --target all --browser
# Alternatively use an installed Chromium:
JE_CHROMIUM_PATH=/usr/bin/chromium python3 tests/host/run.py --target all --browser
```

This loads the unmodified Jellyfin web application and JE assets, signs in through the real login form as regular and administrator users, waits for authenticated JE bootstrap, opens the Enhanced panel with its keyboard shortcut, changes Auto Pause through the checkbox, and reloads to verify server persistence. Uncaught page errors fail the journey. Third-party browser requests are blocked; host API and asset responses are not mocked. Browser dependencies are required when `--browser` is specified; failures are never silently skipped. Artifacts include a browser result file and failure screenshots. Session credentials are passed over stdin, and traces/HAR/storage snapshots are intentionally not recorded because they contain authentication tokens. These checks cover Chromium desktop only; mocked component browser tests remain a separate suite.
