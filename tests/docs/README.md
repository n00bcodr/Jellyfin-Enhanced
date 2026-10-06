# Regression testing

JE has separate .NET builds for Jellyfin 10.11 (`jf10`, .NET 9) and Jellyfin 12 (`jf12`, .NET 10). Tests exercise production code, browser modules, and disposable Jellyfin servers. See [the coverage matrix](coverage-matrix.md) for tested behavior and remaining gaps; a green run does not mean every feature or combination is covered.

## Setup

The complete suite is validated on native Linux. The native renderer test packages and direct container-IP access are Linux-specific; Windows, macOS, and Docker Desktop runs are not validated.

Use Python 3.10+, Node.js 26.2.0 for the full suite (22.14+ suffices for frontend/browser tests), npm, a .NET 10 SDK, and both .NET 9 and .NET 10 ASP.NET Core runtimes. Install current servicing patches: an older runtime patch can fail to launch the test host even when compilation succeeds. `dotnet --list-sdks` and `dotnet --list-runtimes` show what the selected executable uses. If installing .NET in a separate directory, put its `dotnet` executable first on `PATH` and set `DOTNET_ROOT` to that directory.

```sh
npm ci
npx playwright install --with-deps chromium firefox
python3 tests/run.py fast
```

The real-host suite additionally requires a running Linux Docker engine accessible to your user. It creates an internal network, temporary configuration/media, and disposable users, builds the plugin, and installs it in digest-pinned official Jellyfin images. It never needs your Jellyfin server, personal library, or provider credentials. Container IP access currently requires native Linux Docker; Docker Desktop is not a validated environment.

The strict poster language-parity checks use Node 26.2.0 / ICU 78.3, matching the generated production language tables; a different ICU version can legitimately produce different names. Initial package/browser/container downloads require network access. Provider integration tests use deterministic local or in-process responses; they do not call live provider accounts. NuGet dependencies have separate `packages.jf10.lock.json` and `packages.jf12.lock.json` files for both projects, and the backend runner restores in locked mode. `package-lock.json` records the npm dependency graph. After an intentional NuGet dependency change, regenerate both targets with `dotnet restore tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf10 --force-evaluate` and the corresponding `jf12` command, then review the lockfile changes.

## Commands

Run commands from the repository root:

| Command | Scope |
| --- | --- |
| `python3 tests/run.py fast` | Inventory freshness, backend on both targets, frontend with coverage |
| `python3 tests/run.py backend --target jf12` | Backend behavior and HTTP pipeline, one build target |
| `python3 tests/run.py frontend` | JavaScript behavioral tests and full-source coverage |
| `python3 tests/run.py browser` | Mock-host browser component tests, including visual assertions |
| `python3 tests/run.py visual` | Visual subset only |
| `python3 tests/run.py host --target all` | Actual Jellyfin host API and Chromium UI journeys on both compatibility lines |
| `python3 tests/runner/poster.py` | Existing native pipeline, offline JS/C# parity, embedded poster assets |
| `python3 tests/runner/mutations.py --target jf12` | Isolated representative fault injection |
| `python3 tests/run.py history` | Replay selected historical issue/PR faults in disposable copies, both backend targets |
| `python3 tests/run.py all` | Complete regression entry point |
| `python3 tests/inventory/generate.py` | Regenerate production inventory after source changes |
| `python3 tests/runner/clean.py` | Install dependencies and run the full suite in a fresh copy of tracked and unignored local files |

The results of the latest complete run are recorded in [validation](validation.md).

`--target jf10`, `--target jf12`, or `--target all` selects backend/host compatibility coverage. A single-target run is not a complete compatibility run. Direct test commands support focused iteration:

```sh
dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --artifacts-path artifacts/focused-jf12 --filter 'FullyQualifiedName~JE.Tests.Core'
node --test tests/frontend/core/*.test.mjs
npx playwright test --config tests/browser/playwright.config.cjs --project=firefox
```

Use distinct `--artifacts-path` directories for concurrent .NET builds, especially when switching targets. Normal regression orchestration does this automatically.

## Test layers and evidence

- Backend xUnit tests load the actual plugin and use isolated files, controlled HTTP responses, and host interfaces. ASP.NET TestServer checks routing, authorization, and middleware; these are not a substitute for real-host tests.
- Frontend tests evaluate actual production scripts in jsdom. They cover state, requests, rendering, user changes, lifecycle cleanup, and failure handling. Expected errors are declared explicitly; unexpected requests/errors fail tests.
- Playwright runs Chromium desktop/mobile and Firefox against a minimal mock-host page loading production modules. Its component fixtures do not represent a complete Jellyfin browser session or actual native-client validation. See [browser details](../../tests/browser/README.md).
- Host tests run the actual built plugin in official Jellyfin containers. The main runner enables real Chromium login, injected bootstrap, settings-panel save, and reload checks; `python3 tests/host/run.py --target all` runs the API-only subset. Their reports list each verified scenario; host smoke coverage is deliberately distinguished from full application E2E coverage.
- Poster tests compare production JavaScript and C# outputs using synthetic fixtures and validate native image pipeline/assets without a media server or live metadata.
- Mutation checks copy sources into temporary workspaces and verify selected injected faults fail their target tests. They do not alter the working copy.

The runner writes commands, exit status, durations, and log locations to `artifacts/regression/summary.json`. Backend TRX/Cobertura reports are under `artifacts/regression/backend/`; frontend HTML/LCOV coverage is under `artifacts/frontend-coverage/`; browser reports/traces/screenshots are under `artifacts/browser/`. Host and poster reports include the exact scenarios exercised. Generated artifacts are ignored by Git. `--artifacts` relocates runner/backend/host/poster/mutation reports; frontend and browser tools keep the fixed paths above. The clean-tree command copies those fixed reports back before removing its temporary source tree and records source hashes for the exact local snapshot tested.

Coverage includes unexecuted production modules; thresholds prevent measured coverage from silently dropping but do not certify feature completeness. Backend floors are 47% lines and 35% branches and frontend global floors are 28% statements, 20% branches, 29% functions and 30% lines, each just under the measured values recorded in [validation](validation.md). The frontend runner declares its global and core-module floors alongside report generation. No production code is excluded merely to raise these values. Review the behavioral matrix alongside reports. The generated inventory is a lexical list of production files, routes, settings, tasks, and storage references—not a behavioral test.

The [historical issue/PR audit](history-audit.md) records proven existing catches, newly repaired blind spots, and unproven reports. Historical replay also runs in scheduled/manual extended CI and the full `all` suite.

## Visual baseline changes

Run visual tests in the pinned Playwright Linux environment. Review the failed screenshot and diff first. If the change is intended, update only the relevant baseline with `npx playwright test --config tests/browser/playwright.config.cjs --grep @visual --update-snapshots`, inspect each changed PNG, then run the tests normally. Never automatically approve baseline updates in CI. Test fixtures use bundled licensed fonts and fixed locale, timezone, viewport, and color scheme. See the browser README for baseline-specific instructions.

## CI and troubleshooting

`regression.yml` runs backend checks for both targets, JavaScript coverage, and browser checks on pull requests. Scheduled/manual runs additionally execute real-host compatibility and the broader checks. Existing security, translation, and static-analysis workflows remain in place. Failed test commands fail their jobs; artifacts are uploaded even on failure.

Missing runtimes, dependencies, browser executables, or Docker access are failures, not skips. Check `dotnet --list-runtimes`, run `npm ci`, install the pinned Playwright browsers, or check `docker info` as appropriate. A host-startup failure should be investigated using the saved build/server logs. The host runner removes resources it created; it must never prune unrelated containers or networks.

The test infrastructure uses synthetic data only. Do not substitute production credentials or a personal media library into fixtures.
