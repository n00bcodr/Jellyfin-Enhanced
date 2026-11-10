# Where the gate time goes (Part 1, before any change)

Measured with `scripts/gate-timing.py` (this branch) on 2026-11-10, Lenovo `t3-lenovo` (10 cores, 14 GB), Node 26.13.0, dotnet SDK 10.0.401, the gate lock held (`~/.local/share/je12/gate.lock`, `flock --close` semantics), `UseSharedCompilation=false`, `MSBUILDDISABLENODEREUSE=1`. Tree: `restructure/integration` 2917a115 plus the harness commits (the only gate-script change is an opt-in step trace and report copy, inactive unless `JE_GATE_TRACE`/`JE_GATE_KEEP` are set). Three runs of each gate in a clean measurement worktree (`je-ts-base`), alternating `all`, `browser`. No run started or ran under load: CPU used by other processes was 0.30–0.55 cores during every run (the harness flags a run above 2 cores).

## How the harness measures

`scripts/gate-timing.py run [--runs N] [--variant NAME=DIR ...] -- <gate command>` samples `/proc` every 0.2 s for the gate's whole process tree (it is a child subreaper, so orphans such as esbuild's service process stay counted), records the step markers the gate script writes, and keeps the gate's TRX, node results and Playwright JSON. Per run it reports: wall time; CPU time (exact, from `getrusage` of everything it reaped; sampling attributes 100% of it here); parallelism (CPU s / wall s) and utilisation against the 10 cores; idle time (the tree using < 0.3 cores); per step, per process kind and per command; per node test file (its own process); per dotnet test class (TRX start/end); per Playwright file (JSON report, with each worker's CPU assigned to the test it was running). `report` aggregates runs (median, min, max); `compare` judges A against B (a difference counts only when the ranges do not overlap and it exceeds the larger spread). Memory per sample (RSS of the tree, MemAvailable) was added after this profile, so it is not in these runs.

## Totals

| gate | wall s, median (min–max) | CPU s | parallelism | cores used | idle s | runs |
|---|---:|---:|---:|---:|---:|---|
| `all` | **275.6** (274.7–277.5) | 941 | 3.4 | 34% | 14.9 | 3 × pass |
| `browser` (6 workers) | **193.4** (193.1–196.0) | 751 | 3.9 | 39% | 0.4 | 2 × pass, **1 × fail** (below) |

The brief's "browser about 8.5 to 10 minutes" does not match the quiet-machine number: alone and quiet it is 3.2 min. The longer figures come from runs beside `all` (je12's `final` takes 5.5 min for both together) or under other agents' load. Load is what makes it slow.

## `all`: steps in order

| step | wall s | CPU s | parallelism | what burns the CPU |
|---|---:|---:|---:|---|
| B: plugin build `--no-incremental` + warning ratchet | 9.0 | 23 | 2.6 | csc 14, client `--check` (tsc) 8 |
| G: Architecture tests (`dotnet test` **rebuilds** the test project first) | 10.4 | 25 | 2.4 | csc 13, client `--check` 8 |
| T: full dotnet suite + coverage ‖ F: frontend suite | **87.1** | 85 + 488 | 1.0 ‖ 6.8 | T: test host 49, `dotnet test`'s own rebuild 12 s wall before the host starts; F: 176 node test processes |
| F rest: `test:client-build`, `contracts:check`, `test:contract-boundary`, `client:check`, `inventory:rewrite:check` | **106.4** | 172 | 1.6 | tsc in fixtures 81, node tests 70 |
| INV, TOOL | 1.0 | 1 | | |
| fe: `client:typecheck`, `client:build`, `inventory:rewrite`, `client:check`, `inventory:rewrite:check` | 15.6 | 27 | 1.7 | four full TypeScript checks |
| INV, TOOL **again** | 1.0 | 1 | | |
| fe: **`test:client-build` again**, bootstrap manifest, output keys | **45.0** | 75 | 1.7 | |

Cores in use, 10-second buckets (one run): `0:2.5 10:2.7 20:8.8 30:9.5 40:9.6 50:9.1 60:8.1 70:7.6 80:3.1 90:0.4 100:1.2 110:1.7 … 270:1.5`. The machine is busy for one minute (T beside the frontend suite) and then uses about **1.6 cores for the last 190 seconds**.

### Build vs test vs startup vs idle, along the critical path (275 s)

| kind | wall s on the critical path | what |
|---|---:|---|
| build | ~44 | plugin build 9; test-project builds inside G and T 6 + 12; full TypeScript checks in `client:check` ×2, `client:typecheck`, `client:build` ~18 |
| test | ~200 | dotnet tests 66 (T beside the frontend suite 72); client-build tests 45 **+ 45 again**; contract boundary 54; fe/INV/TOOL bits |
| startup | ~4 | dotnet test host start to first test 1.4 s (×2); node test processes start in parallel and are hidden |
| idle | ~15 | the tree below 0.3 cores, mostly in the T/F join and between serial steps |
| repeated work | **~62** | second `test:client-build` (45), G's and T's rebuilds (6 + 12 – one is needed) — see below |

### Repeated work

| what | times per `all` | cost each | why it is repeated |
|---|---:|---:|---|
| `test:client-build` (6 files, `--test-concurrency=1`) | 2 | 45 s wall, 75 CPU-s | be runs it, then fe runs it on the same tree (gate_all proves the tree unchanged) |
| full TypeScript check of `client/` (TS 6 API, single-threaded) | ~7 (+4 on fixtures) | 3.7–5.4 s, 7 CPU-s | MSBuild target `VerifyJellyfinEnhancedClient` in each of B, G and T's builds; `client:check` ×2; `client:typecheck`; `client:build` |
| test-project build | 3 (B, G, T) | 6–12 s | G and T run `dotnet test` without `--no-build` |
| INV, TOOL, `client:check`, `inventory:rewrite:check` | 2 | ~1–5 s | be and fe both run them |
| esbuild service process | 129 starts | ~0.16 CPU-s | every node test process that compiles a TS helper starts its own esbuild service (21 CPU-s in all) |

### dotnet suite (T): 3238 tests in 145 classes

Test host wall 67.2 s, CPU 49.4 s (**0.7 cores**); sum of test durations 101 s over a span of 65.7 s. The surprise: `tests/backend/Support/ApiPluginFixture.cs` declares `[CollectionDefinition("Plugin singleton", DisableParallelization = true)]`. xUnit runs those **77 classes after every other collection, alone, one at a time**. In all three runs the 68 parallel classes take 16.3 s (span) and then the singleton chain takes 49.8 s (span) on one core; their sum is the whole 65.7 s span. The singleton classes exist because they replace the plugin's static instance.

Slowest 30 classes (median of 3; duration = sum of the class's test durations; singleton classes marked S):

| class | tests | duration s | | class | tests | duration s |
|---|---:|---:|---|---|---:|---:|
| S MediaTags.ApiItemLookMutationTests | 20 | 14.64 | | S Seerr.ApiSeerrProxyOutcomeTests | 37 | 1.50 |
| ApiRoutingTests | 223 | 14.07 | | MediaTags.CoreTagScaleSettingsTests | 19 | 1.46 |
| S MediaTags.RatingSourceTests | 51 | 5.93 | | S SpoilerGuard.PrivacySeerrRedactionTests | 96 | 1.43 |
| CorePersistenceTests | 22 | 3.94 | | S MediaTags.NativeScenesInvalidationTests | 15 | 1.40 |
| S DetailsProviders.ElsewhereDocumentTests | 93 | 3.93 | | MediaTags.PosterEdgeSpacingTests | 30 | 1.37 |
| ApiAssetTests | 15 | 2.92 | | S SpoilerGuard.PosterBlurFilterTests | 59 | 1.25 |
| S Platform.BootstrapContractTests | 8 | 2.62 | | SpoilerGuard.PosterBlurTests | 8 | 1.14 |
| Architecture.FeatureBoundaryTests | 3 | 2.59 | | MediaTags.PosterRegressionTests | 69 | 1.13 |
| S MediaTags.LeavingSoonTests | 47 | 2.47 | | S TaskMetadataTests | 10 | 1.12 |
| S MediaTags.LogoTagTests | 21 | 2.15 | | S MediaTags.StatusScenesReadTests | 2 | 1.01 |
| MediaTags.IntegrationStatusTagsSeriesTests | 19 | 2.09 | | MediaTags.PosterColourTests | 13 | 0.98 |
| Persistence.RevisionedDocumentTests | 31 | 1.86 | | MediaTags.NativeStatusBandTests | 25 | 0.98 |
| S BundleServingTests | 4 | 1.79 | | BundleBudgetTests | 2 | 0.82 |
| MediaTags.TagStyleTests | 81 | 1.54 | | MediaTags.PosterCentreAnchorTests | 29 | 0.77 |
| | | | | Seerr.ApiSeerrTests | 36 | 0.76 |

(`JE.Tests.` and `Features.` prefixes dropped.) The slowest single tests: `ApiItemLookMutationTests.ProductionPageSavesThroughRealHttpValidator(import-replace)` 4.5 s (it drives the production page through node), `CorePersistenceTests.ConcurrentStrictReadsNeverSeeAHalfWrittenSave` 4.1 s. Only 12 tests take over 1 s; the time is in the serial chain, not in a few slow tests.

### Frontend suite (F): 3863 tests in 181 files, 9 files at once

72.1 s wall, 488 CPU-s (6.8 cores). The wall time is **one file**: `admin/config/admin-config-rewrite.test.mjs` takes 71.6 s by itself (43 tests, each parsing the 1.36 MB generated `configPage.html` in jsdom with its scripts). Ideal packing on 9 workers would be 488/9 ≈ 54 s.

Slowest 30 node test files (median wall; CPU includes children; the `client-build` and `ClientContracts` files are from F rest):

| file | wall s | CPU s | | file | wall s | CPU s |
|---|---:|---:|---|---|---:|---:|
| admin/config/admin-config-rewrite | 71.6 | 64.3 | | media-tags/admin/…-colours-status | 14.3 | 14.0 |
| ClientContracts/boundary (F rest) | 54.1 | 84.2 | | media-tags/features-tag-poster-colours | 12.9 | **1.3** |
| media-tags/admin/…-overview-layout | 33.6 | 32.8 | | bootstrap/bootstrap-media-tags-portable | 12.1 | 10.6 |
| media-tags/admin/…-page-server | 30.8 | 32.3 | | client-build/build | 11.2 | 19.6 |
| media-tags/admin/…-config-media-tags-tab | 27.0 | 23.7 | | media-tags/features-status-tags-vocabulary | 9.7 | **1.8** |
| media-tags/admin/…-tags-portable | 25.7 | 26.6 | | media-tags/admin/…-preview-styles | 9.5 | 9.1 |
| client-build/tag-data | 23.5 | 40.0 | | media-tags/admin/…-rules-builder | 8.3 | 8.2 |
| bootstrap/bootstrap-media-tags-hub | 23.2 | 21.9 | | media-tags/core-tag-pipeline-paged | 8.3 | **0.7** |
| media-tags/admin/…-rules-requests | 21.2 | 20.8 | | bootstrap/bootstrap-tag-group-editor | 7.9 | 8.5 |
| guards/config-control-guard | 20.2 | 20.4 | | media-tags/core-tag-pipeline | 6.8 | **1.0** |
| client-build/html-build | 18.6 | 31.6 | | client-build/rewrite-inventory | 6.5 | 9.7 |
| media-tags/admin/…-groups | 18.4 | 17.4 | | architecture/feature-boundaries | 6.2 | 7.5 |
| media-tags/admin/admin-tags-review | 16.5 | 15.9 | | pages/pages-discovery-boundaries | 6.1 | **1.2** |
| media-tags/admin/…-rules | 16.1 | 16.2 | | media-tags/features-quality-display | 5.8 | 6.1 |
| | | | | media-tags/admin/…-isolation | 5.4 | 5.0 |

Files with CPU far below wall (bold) wait on real time: fixed sleeps or timers, not work. `features-status-tags-vocabulary` is one of the load-sensitive files AGENTS.md lists, and its fixture waits a fixed 60 ms of real time for a 30 ms batch timer and its answer (`flush`, used 41 times).

### F rest (106 s on ~1.6 cores)

`test:client-build` 45 s at `--test-concurrency=1` (its slowest file is 23.5 s, no shared state); `test:contract-boundary` 54 s, one sequential integration test (7 `dotnet run`s, `dotnet build` and `pack` on a fixture copy, 4 full TypeScript checks of the fixture); `client:check` 5.4 s; `contracts:check` 2 s.

## `browser`: 693 tests = 231 × {chromium, mobile-chromium, firefox}, 6 workers

| project | tests | sum of test durations s |
|---|---:|---:|
| chromium | 231 | 304 |
| mobile-chromium | 231 | 314 |
| firefox | 231 | 351 (36% of the total) |

972 test-seconds over 6 workers is 162 s of the 193 s; first test 1.4 s after the gate starts; 18 worker processes (6 per project, as the queue moves from one project to the next), 18 browser launches at a median 1.56 s from launch to first test (~28 worker-seconds, ~5 s of wall); one fixture server for the run (1.5 CPU-s). Workers spend 15.6 CPU-s outside tests. So **startup is small**; the time is in the tests and in the tail.

Cores in use, 10-second buckets: `0:5.1 10:4.3 … 130:6.2 140:3.1 150:3.1 160:0.8 170:0.6 180:0.6 190:0.5`. The last ~33 s is **one test** running alone: Playwright queues project by project and file by file (alphabetically), so the 33 s `tag-row-subpixel` test of the last project starts near the end.

The longest tests are frame-bound, not CPU-bound:

| test (per project) | duration s | CPU s while it runs | why |
|---|---:|---:|---|
| `tag-row-subpixel` (1 test) | 33.3–33.5 | 0–7 | 4 layouts × 2 scales × 123 widths, each waiting two animation frames (984 × 33 ms) |
| `tag-fit-monotonic` (5 of its 6 tests) | 18.7–18.9 each | 9–22 for the file | 184 snapshots per test, each waiting 3 × double rAF |
| `settings-overflow` (3 tests) | 11–13, 6–7 | 8–18 | 5 widths × 2 themes per page |

12 tests take over 8 s (227 test-seconds in all), all in these three files. Slowest 30 files per project:

| file | project | tests | duration s | | file | project | tests | duration s |
|---|---|---:|---:|---|---|---|---:|---:|
| tag-fit-monotonic | firefox | 6 | 95.0 | | plugin-pages-rewrite | mobile | 13 | 15.0 |
| tag-fit-monotonic | mobile | 6 | 94.3 | | plugin-pages-rewrite | chromium | 13 | 14.7 |
| tag-fit-monotonic | chromium | 6 | 94.0 | | admin-config-rewrite | mobile | 16 | 14.2 |
| tag-row-subpixel | firefox | 1 | 33.5 | | admin-config-rewrite | chromium | 16 | 13.8 |
| tag-row-subpixel | mobile | 1 | 33.4 | | flush-edges | mobile | 10 | 10.1 |
| tag-row-subpixel | chromium | 1 | 33.3 | | flush-edges | firefox | 10 | 10.0 |
| settings-overflow | firefox | 3 | 32.5 | | flush-edges | chromium | 10 | 9.3 |
| settings-overflow | mobile | 3 | 28.3 | | first-chip-fit | firefox | 15 | 8.6 |
| settings-overflow | chromium | 3 | 27.9 | | tag-genre-names | firefox | 9 | 8.1 |
| tag-clipping | firefox | 4 | 18.8 | | tag-genre-names | mobile | 9 | 7.6 |
| admin-config-rewrite | firefox | 16 | 18.8 | | awards-navigation | firefox | 10 | 7.6 |
| tag-hidden-refit | firefox | 9 | 17.2 | | tag-genre-names | chromium | 9 | 6.6 |
| tag-clipping | chromium | 4 | 16.7 | | admin-preview-styles | firefox | 6 | 6.6 |
| tag-hidden-refit | mobile | 9 | 16.4 | | tag-clipping | mobile | 4 | 16.3 |
| plugin-pages-rewrite | firefox | 13 | 16.2 | | tag-hidden-refit | chromium | 9 | 15.5 |

### A flake on a quiet machine

Baseline run 3 of `browser` **failed**, on the unmodified tree with 0.3 foreign cores: `[mobile-chromium] › discovery-recommendations-rewrite.spec.cjs:70` ("generated discovery and recommendations page…"): after a scroll to the bottom the card count stayed at 360 for the whole 5 s `expect.poll` (`Expected: > 360, Received: 360`). AGENTS.md lists this test as load-sensitive; here it failed with no load. One failed run in three is a flake rate that alone forces reruns.

## What the profile says (the surprises)

1. **`all` is a line, not a graph.** 34% of the cores; after the first 80 s it runs on 1.6 cores. The node suites need no dotnet build, yet wait for it; the client-build tests, the contract boundary test and fe run after T and F instead of beside them.
2. **62 s of `all` is repeated work** on an identical tree: the client-build tests twice, three test-project builds, seven full TypeScript checks.
3. **T is a serial chain by design.** `DisableParallelization` on the singleton collection puts 50 s of tests on one core after the parallel 16 s. More cores do nothing for it; more test-host processes do, because each has its own singleton.
4. **The frontend suite is bounded by one 72 s file**, and is otherwise CPU-bound (6.8 cores).
5. **Browser time is waiting on animation frames**, and its end is one 33 s test running alone. More workers help; so does not leaving the longest tests to the end.
6. **Browser startup, server startup and logins are not the problem**: one fixture server per run, ~1.5 s per browser launch, no login (tests set state in the page).
7. **The baseline is not reliably green**: one browser flake in three quiet runs.
