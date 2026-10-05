# Regression implementation progress

No commits or pushes were made. Production fixes, tests and documentation remain reviewable in the existing worktree.

## Test directory organization

All regression test code, harnesses, fixtures, orchestration and documentation now live under `tests/`. Entry point: `python3 tests/run.py all`; layout and contribution rules: [tests README](../README.md). CI/npm paths, historical manifests, C# project references and browser configuration were updated. Shared backend fixtures live in `backend/Support/`; frontend discovery is recursive and rejects an empty suite. Fresh-copy fast validation passed both backend targets (693 each), frontend (333) and tooling (8). Full relocated-suite validation passed all 17 stages (exit 0), including browser/visual checks, both actual hosts, poster checks, and standard/historical fault replay; evidence: `artifacts/test-organization/full/summary.json`. No commits or pushes.

## perf/round2 comparison

Compared `6fcc633e` to `8b8a5baa` with identical tests and no local production-fix overlay. Found one new discovery retry regression; both backend targets share the same 34 existing failures, while actual-host and browser smoke checks pass. Added five targeted backend cases and one discovery test, and corrected unrealistic Episode fixtures. See [the comparison report](perf-round2.md) for failed, passed and timed-out checks. The performance branch remains untouched and uncommitted.

## Historical audit follow-up

The [issue/PR audit](history-audit.md) adds nine frontend tests, thirteen backend cases, and replayable historical faults. These changes postdate the full/fresh-tree run below. The earlier completion claim was too broad: many feasible behavioral gaps remain, and the broader comprehensive-testing goal is not complete. Follow-up integrated checks passed: 688 backend tests per target, 332 instrumented frontend tests and seven tooling checks. Coverage is 47.14%/47.16% backend lines and 26.10% frontend lines. All 13 historical fault scenarios (17 experiments across targets) also passed their baseline/failure/restoration checks. Historical fault replay is recorded separately in [validation.md](validation.md). No commits or pushes.

## Previous full-run validation state

The earlier code-frozen complete run finished successfully (exit 0). Its authoritative report is `artifacts/final-validation/summary.json`; console log `/tmp/je-all-verified.log`. The final clean disposable checkout run also finished with exit 0: `artifacts/clean-final/summary.json` and its `regression/summary.json` record every stage passing against the same frozen sources, with the same test counts.

| Layer | Latest verified evidence before final run |
|---|---|
| Backend | Final frozen run passed 675/675 on each jf10/net9 and jf12/net10, zero failures/skips. Coverage: jf10 47.03% lines / 34.90% branches; jf12 47.04% lines / 34.93% branches. |
| Frontend | Final frozen instrumented run passed 323/323 with zero failures/skips. All production JavaScript: 23.55% statements, 18.40% branches, 24.98% functions, 24.50% lines. |
| Mocked browser | 39 cases passed across Chromium desktop, mobile Chromium and Firefox, including three reviewed visual baselines. These use mocked fixture pages. |
| Actual Jellyfin hosts | Final frozen run: both digest-pinned 10.11.11 and 12.0 passed 45 HTTP scenarios plus a real Chromium browser flow (46 report entries per host). Browser flow covers regular/admin login, injected JE/bootstrap, Enhanced panel Auto Pause save and persistence after reload. |
| Posters | 140 pipeline checks; strict metadata parity over 40 profiles × 101 fixtures; 115,374 language-name and 31,676 casing comparisons; all 253 flag assets and HarfBuzz shaping on Skia 3.116.1/3.119.4. |
| Tooling and mutation | Five tooling tests passed. All four selected production fault types were killed on each target, with passing baseline and restored-source checks. |
| Inventory | `python3 tests/inventory/generate.py --check` passes after regeneration from current production sources. |

Current coverage floors: backend 38% lines / 27% branches; frontend 20% statements / 15% branches / 21% functions / 21% lines. These guard against regressions in established coverage; they do not establish comprehensive behavioral coverage. Every production feature area is assessed in [coverage-matrix.md](coverage-matrix.md), including remaining gaps.

## Reproduced regressions and corrections

Tests were observed failing before these fixes, or deliberately injected faults were detected:

- Malformed review-store shapes could be overwritten; strict shape validation preserves existing data.
- Corrupt TMDB and awards cache entries could prevent startup; invalid entries are rejected while valid cache data survives.
- Maintenance restoration failures could lose pending intent or overwrite it during reconciliation. Journal/checkpoint/retry tests now preserve unresolved work; [cross-store transaction limits](maintenance-recovery.md) remain explicit.
- Usage counters needed malformed-state validation and Gregorian periods under non-Gregorian cultures.
- DOM observer replacement could retain wrong priorities, disconnect the wrong registration, leak dedicated observers or loop during dispatch re-registration. API cache replacement could evict an unrelated entry.
- Previous-user responses could repopulate bookmark/spoiler/hidden-content/media-info state. Regressions exercise logout/switch during successful and failed asynchronous operations.
- Pause/release-date content needed escaping and cleanup. Old Letterboxd and More Info responses could decorate a replacement page/modal; generation/lifecycle cases prevent this.
- Watch-provider region/logo validation accepted a trailing newline; strict end-of-input matching now rejects it.
- Native blur replacement leaked the consumed input stream; actual MVC stream-result ownership tests detect it.
- Existing language parity checks printed mismatches without failing. Strict failure behavior exposed 51 Baku alias mismatches; production mapping and resolver version were corrected. A deliberately wrong oracle now fails verification.

Targeted mutation verification is documented in [mutations.md](mutations.md), including authorization, parental policy, negative-cache resource bounds and stale-user responses. Additional isolated API/navigation probes were restored after detection. Intermediate failing snapshots taken during those probes are not final regressions.

## Execution and evidence locations

- Main entry point: `python3 tests/run.py all` (see [testing README](README.md) for prerequisites and selectable suites).
- Real-host runner: `python3 tests/host/run.py --target all --browser`; reports and browser evidence live under `.engineering-artifacts/host/{jf10,jf12}/`.
- Backend tests: `dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf10` and `jf12`; use separate artifact directories to avoid concurrent target output collisions.
- Frontend: `npm run test:frontend:coverage`; browser: `npm run test:browser`.
- Initial isolated logs used disposable `/tmp/je-*` paths; final retained artifacts are authoritative and should be used for review.

## Ownership and review

Independent agents owned core persistence/maintenance, provider integrations, privacy/filters, API/middleware, tasks, poster rendering/parity, browser fixtures, actual host infrastructure, frontend runtime/features/pages/request flows, and inventory. Backend/frontend reviewers identified missing behaviors and weak assertions; contributors added and executed focused regressions. The coordinating agent owns integrated and clean-environment validation.

Remaining limits include real-host playback/native image journeys, selected enabled import/reverse-sync error paths, header/shortcut UI, cross-store maintenance crash ambiguity, and unexecuted feature combinations. Passing suites are not reported as proof that these gaps are covered.
