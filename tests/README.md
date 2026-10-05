# JE regression tests

All test code, fixtures, harnesses, runners, browser configuration and testing documentation live here. Production code stays in `Jellyfin.Plugin.JellyfinEnhanced/`. Root `package.json` and `package-lock.json` provide the normal npm entry points; `.github/workflows/regression.yml` calls this directory's runner. Generated evidence stays in the ignored root `artifacts/` directory.

```text
tests/
├── run.py                 # Entry point for every suite
├── backend/               # One xUnit project for both Jellyfin targets
│   ├── Api/
│   ├── Core/
│   ├── Integrations/
│   ├── PosterTags/
│   ├── Privacy/
│   ├── ScheduledTasks/
│   └── Support/           # Shared plugin, storage and HTTP fixtures
├── frontend/              # Actual JavaScript modules in isolated jsdom realms
│   ├── bootstrap/
│   ├── core/
│   ├── features/
│   ├── pages/
│   ├── requests/
│   ├── regressions/       # Historical cases spanning several features
│   └── helpers/           # Shared realm, recursive discovery and coverage
├── browser/               # Playwright config, fixtures, fonts and visual baselines
├── host/                  # Real disposable Jellyfin servers and browser smoke tests
├── poster/
│   ├── rendering/         # Native renderer/assets harness
│   ├── pipeline/          # Image/filter/cache pipeline harness
│   └── parity/            # Browser/native metadata parity
├── history/               # Historical fault manifests and triage data
├── inventory/             # Production-surface inventory generator
├── runner/                # Coverage, mutation, poster and clean-copy orchestration
│   └── tests/             # Tests of the runner's failure/reporting guarantees
└── docs/                  # Setup, coverage matrix, audits and validation history
```

From the repository root, after [setup](docs/README.md#setup):

```sh
python3 tests/run.py fast      # Tooling, both backend targets, frontend coverage
python3 tests/run.py all       # Also browsers, posters, real hosts and fault replays
npm run test:frontend          # Frontend only
npm run test:browser           # Browser only
```

See [all commands and prerequisites](docs/README.md), the [coverage matrix](docs/coverage-matrix.md), and [historical fault checks](docs/history-audit.md). Older artifact logs retain the paths used when they were generated; current documentation uses the organized paths.

## Adding and maintaining tests

- Put a new test beside the behavior it exercises. Use `*Tests.cs` for backend tests and `*.test.mjs` for frontend tests. .NET includes nested C# files automatically; both frontend commands use the same recursive discovery and reject an empty suite.
- Keep one authoritative behavioral assertion where practical. Historical issue IDs belong in comments or fault manifests; avoid copying whole test implementations into audit-specific suites. Cross-feature historical fixtures already grouped in `frontend/regressions/` remain discoverable.
- Reuse `backend/Support/` and `frontend/helpers/`; keep fixtures used by only one feature next to that feature. Only extract a shared helper when multiple tests need it. Preserve the singleton collection for tests changing JE's plugin singleton.
- Test production code through observable contracts. Prefer controlled promises, time and isolated storage. Do not duplicate production algorithms, add order dependencies, or accept unexpected console/network failures.
- Put browser fixture assets and reviewed snapshots in `browser/`; put real-host setup in `host/`. Do not add test code or fixtures to production resource directories.
- Keep new runner code in `runner/`, with meaningful failure-handling tests in `runner/tests/`. CI, documentation and npm scripts should use the shared entry points rather than duplicating suite lists.
- Keep reports, coverage, traces and generated media out of source. Update the coverage matrix for new behavior; update historical manifests if moving a test they select. Review visual diffs before accepting baselines.

The directory structure makes the suite easier to maintain; it does not imply complete behavioral coverage. Remaining gaps and known branch-specific failures stay documented.
