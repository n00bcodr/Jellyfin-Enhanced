# Local validation — 2026-10-05

All implementation remains uncommitted. The repository HEAD remains `8b8a5baa`; no push, release, or GitHub Actions run was performed.

Commands in this document use the current organized paths under `tests/`. Archived logs retain the exact paths used when each earlier run executed. Directory-reorganization validation is recorded separately below; historical passing runs do not by themselves validate moved entry points.

## Directory organization validation

The relocated complete entry point exited **0**, with **all 17 stages passed**:

```sh
PATH=/tmp/je-dotnet:$PATH DOTNET_ROOT=/tmp/je-dotnet \
  python3 tests/run.py all --artifacts artifacts/test-organization/full
PATH=/tmp/je-dotnet:$PATH DOTNET_ROOT=/tmp/je-dotnet \
  python3 tests/runner/clean.py --suite fast --artifacts artifacts/test-organization/clean
```

The full run passed 693 backend tests on each target, 333 instrumented frontend tests, eight tooling checks, 39 browser tests including unchanged visual baselines, poster pipeline/parity/assets checks, both actual Jellyfin hosts (46 report entries each), and standard plus historical fault replay. Inventory and coverage checks passed. Evidence: `artifacts/test-organization/full/summary.json`; console log: `/tmp/je-organization-all.log`.

The fresh disposable copy installed dependencies and passed the **fast** suite on both targets with the same backend/frontend/tooling counts. Evidence: `artifacts/test-organization/clean/summary.json`. The full suite was run in the working tree; it was not rerun in that fresh copy. No visual baselines were updated. No commits or pushes were made. These results validate the current regression worktree, not the `perf/round2` branch, and do not imply complete behavioral coverage.

## Historical audit follow-up

The [historical audit](history-audit.md) postdates the full run below. Its integrated `fast` run passed **688 backend tests on each target, 332 instrumented frontend tests, seven tooling checks, and inventory verification**, with zero failed or skipped tests. Commands on this machine:

```sh
PATH=/tmp/je-dotnet:$PATH DOTNET_ROOT=/tmp/je-dotnet \
  python3 tests/run.py fast --artifacts artifacts/history-audit/integrated
PATH=/tmp/je-dotnet:$PATH DOTNET_ROOT=/tmp/je-dotnet \
  python3 tests/run.py history --artifacts artifacts/history-audit/history-suite
```

The historical entry point also exited **0**: all **13 distinct fault scenarios** were detected, with all **17 target-specific experiments** passing baseline/failure/restoration checks. Both backend targets and all three frontend history groups passed.

Follow-up coverage: backend jf10 **47.14% lines / 35.00% branches**, jf12 **47.16% / 35.02%**; frontend **26.10% lines / 19.86% branches** (25.07% statements, 26.15% functions). No exclusions or relaxed thresholds were added. Historical replay results are recorded in `artifacts/history-audit/history-suite/summary.json` and nested per-case reports. Each successful proof requires passing baseline/restored tests and the expected failure with the fault present.

The pre-audit 323 frontend tests passed with each of three historical faults restored; new tests detect those faults. The original native poster pipeline also passed with the Jellium exclusion removed; the new independent client test detects it. Proof details and exact-versus-representative distinctions are in the audit.

Browser visual/full real-host/fresh-tree suites were **not rerun for this test-only follow-up**; their evidence below belongs to the earlier snapshot. Scheduled CI was updated locally but not executed on GitHub. The comprehensive coverage goal remains unfinished; many historical reports and behavioral branches are unproven.

## Previous full integrated run

This command exited **0**, with every stage passed:

```sh
PATH=/tmp/je-dotnet:$PATH DOTNET_ROOT=/tmp/je-dotnet \
  python3 tests/run.py all --artifacts artifacts/final-validation
```

The temporary .NET installation supplies the runtime versions missing from this machine's default installation. Other machines should follow the [setup instructions](README.md); they should not depend on this `/tmp` path.

| Suite | Result |
| --- | --- |
| Tooling false-green checks | 5 passed |
| Backend, Jellyfin 10.11 / .NET 9 | 675 passed; 0 failed, skipped, or unexecuted |
| Backend, Jellyfin 12 / .NET 10 | 675 passed; 0 failed, skipped, or unexecuted |
| JavaScript, instrumented production modules | 323 passed; 0 failed or skipped |
| Playwright component/visual checks | 39 passed across Chromium desktop/mobile and Firefox; 3 visual baselines matched |
| Native poster pipeline | 140 checks passed |
| JavaScript/C# poster parity | All synthetic profiles matched; 115,374 language names and 31,676 casing strings matched |
| Native assets | 253 flags decoded and shaping checks passed on Skia 3.116.1 and 3.119.4 |
| Real Jellyfin 10.11.11 and 12.0 | 45 API checks per host plus actual Chromium regular/admin login, bootstrap, panel save, and reload journeys |
| Isolated mutation checks | Four fault types detected by their intended assertions, with passing baselines and restored runs on both targets |

Machine-readable stage status, commands, durations, logs, TRX reports, coverage, host reports, and mutation evidence are under `artifacts/final-validation/`. Browser component reports are under `artifacts/browser/`; frontend coverage is under `artifacts/frontend-coverage/`. These generated files are intentionally ignored by Git.

Measured production coverage, without excluding untested production modules:

| Target | Line coverage | Branch coverage |
| --- | --- | --- |
| Backend jf10 | 47.03% | 34.90% |
| Backend jf12 | 47.04% | 34.93% |
| Frontend | 24.50% | 18.40% |

Frontend statement coverage is 23.55% and function coverage is 24.98%. These are partial behavioral coverage, not a claim that every feature combination is tested. The [coverage matrix](coverage-matrix.md) records remaining cases explicitly.

## Fresh source-tree verification

The final source snapshot passed the complete suite again, with exit code **0**, using:

```sh
PATH=/tmp/je-dotnet:$PATH DOTNET_ROOT=/tmp/je-dotnet \
  python3 tests/runner/clean.py --artifacts artifacts/clean-final
```

This copies tracked and unignored local files into a fresh temporary directory, installs JavaScript dependencies with `npm ci`, restores locked .NET dependencies, and runs the complete entry point. It records source hashes in `artifacts/clean-final/source-manifest.json` and removes its temporary source tree afterward. The final passing result is recorded in `artifacts/clean-final/summary.json`; every stage in its `regression/summary.json` passed. Counts match the integrated run above.

An earlier complete fresh-tree checkpoint also passed; its reports under `artifacts/clean/` predate the final additions and must not be substituted for the final snapshot.

## Additional compatibility and review

- The final 323 JavaScript tests also passed in an isolated, network-disabled Node 22.23.1 Linux container. The main run used Node 26.2.0, matching the generated ICU poster tables, and Playwright 1.58.2.
- Both backend compatibility targets were built using .NET SDK 10.0.108 with suitable .NET 9/10 runtimes. Real hosts use the digest-pinned images in `tests/host/run.py`.
- Independent reviews identified additional regressions in observer dispatch, asynchronous ownership, watchlist deduplication, and maintenance checkpoints; targeted tests reproduced the failures before fixes.
- `git diff --check`, workflow YAML parsing, inventory freshness, and lockfile restoration passed. Workflow execution on GitHub remains unexecuted because this work is intentionally local.
- Native clients, complete playback workflows, every page's accessibility/layout, and additional feature combinations remain unverified. Maintenance's cross-store recovery limitations are documented in [maintenance recovery](maintenance-recovery.md).
