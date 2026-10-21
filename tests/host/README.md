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

Before the server starts, each target also runs the backend's Jellyfin user-action coverage tests against the pulled image's own `Jellyfin.Api.dll` and the Jellyfin server assemblies its calls go into (copied out of a created, never started container): an action a Jellyfin update adds that can change or authenticate a user, and that JE's bracket doesn't cover or that isn't reviewed, fails the run (`user-actions.log`). The backend suite runs the same tests against the pinned releases.

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

## Endpoint registry extraction

`tests/host/endpoint-registry` lists every controller action of a Jellyfin host with its declared answer and whether that answer can carry a title (BaseItemDto, SearchHint, ImageInfo, MediaSourceInfo, RecommendationDto, an ActivityLogEntry, whose text names the item it records, or a SeriesTimerInfoDto, whose name and overview are the programme it records), by reading the host's `Jellyfin.Api.dll` as metadata (nothing runs). Copy `/jellyfin` out of an official image and run it on that folder:

```sh
id=$(docker create jellyfin/jellyfin:12.2) && docker cp "$id":/jellyfin ./host-12.2 && docker rm "$id"
dotnet run --project tests/host/endpoint-registry -- ./host-12.2 > endpoints.tsv
```

The checked-in results are `tests/fixtures/host-endpoints/jellyfin-<version>.tsv`. With `--fields` it lists instead every public property (with whether it has a public setter) of every DTO type JE's privacy walker touches in those answers; the checked-in results are `tests/fixtures/host-endpoints/dto-fields-<version>.tsv`, and every property must be classified in `Services/PrivacyFieldClassification.cs`. The backend tests read them: every title-carrying endpoint must be classified in `Services/PrivacySurfaceRegistry.cs`, and the generated privacy model (`PrivacySurfaceModelTests`) covers each one. Regenerate them for a new Jellyfin release.

The privacy model's fixtures are the hosts' real answers: `tests/fixtures/host-shapes/<version>/` holds one response per endpoint family captured from owned 12.2 and 10.11.11 labs with no privacy rule set (sessions with another account playing, theme songs and videos as Audio/Video extras with their envelope's `OwnerId`, local trailers and featurettes, a Live TV channel with its `CurrentProgram`, a session playing that channel over REST and the dashboard's WebSocket (`Session.WebSocket.*`), a timer with its programme and a series timer), only the round's own fixture titles kept (folders and names anonymized), plus `manifest.json` (each item's role, extra owners and the request path). `PrivacyHostShapeModelTests` deserializes them into the host's own types (12.2 for the jf12 build, 10.11.11 for jf10); recapture them when a Jellyfin release changes a response shape.

## Host web client fixtures

`tests/host/web-bundle/extract.mjs` copies, from an official image's jellyfin-web, the remote-control (now playing) page and its template, the remote session player, the now-playing names helper, the playback manager module (found by its `RequiredHttpHeaders.length` check) and the HTML video player chunk into `tests/fixtures/host-web/<version>/` (with each source file's name and SHA-256 in `manifest.json`), together with every licence sidecar (`*.LICENSE.txt`) a copied file refers to; a referenced sidecar that is missing fails the extraction. `tests/fixtures/host-web/README.md` names the upstream project, its licence and the corresponding source. `tests/frontend/regressions/host-web-now-playing.test.mjs` runs those real functions on the sessions JE's privacy projection delivers (`tests/fixtures/host-web/projected/<version>.json`, which `PrivacyReviewRound18Tests` keeps current; set `JE_HOST_WEB_PROJECTED` to a directory to rewrite them). `tests/frontend/regressions/host-web-playback.test.mjs` runs the real direct-play decision, `createStreamInfo` (stream URL and text tracks) and the video player's audio stream list on the playback answers JE delivers for a guarded episode with an HTTP source and a file source with transcoding and a sidecar subtitle (`tests/fixtures/host-web/playback/<version>.json`, kept current by `PrivacyReviewRound20Tests`; set `JE_HOST_WEB_PLAYBACK` to rewrite them). Regenerate for a new Jellyfin release:

```sh
id=$(docker create jellyfin/jellyfin:12.2) && docker cp "$id":/jellyfin/jellyfin-web ./web-12.2 && docker rm "$id"
node tests/host/web-bundle/extract.mjs ./web-12.2 tests/fixtures/host-web/12.2 jellyfin/jellyfin:12.2
```
