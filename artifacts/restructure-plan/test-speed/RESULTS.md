# Test-speed results (Part 3)

Branch `perf/test-speed` from `restructure/integration` 2917a115, rebased onto the main line on 2026-11-11 (§11: the commit hashes in §1–§10 are from before the rebase; the subjects are unchanged except where §11 says). Profile: [PROFILE.md](PROFILE.md); research: [RESEARCH.md](RESEARCH.md). All timings are from `scripts/gate-timing.py` on the Lenovo (10 cores, 15 GB) unless stated, with the gate lock held, `UseSharedCompilation=false`, Node 26.13.0. Every comparison interleaves its variants (A, B, C, … then again), each variant in its own clean worktree at its commit. A difference is called **real** when the variants' ranges (min–max) do not overlap and the difference exceeds the larger spread; otherwise **within noise**. Runs flagged as loaded (other processes above 2 cores at the start or on average) are shown and left out of the medians.

## Summary

| | before (2917a115 + harness) | after (this branch) | change |
|---|---:|---:|---:|
| `all`, median of interleaved runs | 276.4 s (270.8–278.8) | 102.2 s (101.5–102.6), the last configuration measured 5× interleaved (rotation 2, C8); the final commit: 103.9 s on a quiet machine | **−174.2 s (−63%)** |
| `browser`, median of interleaved runs | 192.5 s (192.1–199.2) | 120.6 s (119.6–122.6) | −71.9 s (−37%) |
| `all` then `browser` (sum) | 468.9 s | 222.8 s (102.2 + 120.6); the final commit, quiet: 225.4 s (103.9 + 121.5) | **−246.1 s (−52%)** |
| `all` and `browser` started at the same time (2 runs each) | both done in 342.3 and 337.7 s, both passed | **both failed** both times (17 browser test timeouts, one dotnet node-child timeout; 307 and 544 s): the final design must not run two gates side by side (§8); in sequence they take 225.4 s on the final commit | |
| first failure of a broken change named (`scripts/first-failure.py`, `all`) | type error 4.3 s; dotnet fault 132.4 s; frontend fault 172.5 s | type error 10.0–10.6 s; dotnet fault 40.2–43.1 s; frontend fault **2.1–4.2 s** with an affected map, 74.3–81.9 s without one | |
| cores used by `all` (CPU-seconds ÷ wall ÷ cores) | 34% | 85–86% (8.5 of 10 cores) | |
| baseline browser runs that failed (quiet machine) | 2 of 6 | `browser` on the final commit: 0 of 3 (two of them beside another agent's Jellyfin lab); the discovery spec 0 of 60 repeats beside a hog. `all` on the final commit: 1 of 3, the run beside that lab (360 s: three hang guards on child processes fired; isolated reruns and a clean full rerun passed, §9) | |

Targets from the brief: `all` < 150 s (2.5 min), `browser` < 240 s (4 min), both together < 300 s (5 min), first failure < 60 s.

**Three targets are met outright on the final commit, on a quiet machine:** `all` 103.9 s (< 150), `browser` 121.5 s (< 240), both in sequence 225.4 s (< 300; side by side they fail on this machine, §8). **The fourth, first failure < 60 s, is met for type errors (10 s) and dotnet faults (41 s), and for frontend faults when an affected map of the base exists (2–4 s); without a map a frontend fault is named after 74–82 s** (it waits for its file's alphabetical turn).


## 1. The changes, one commit each

Each row: the commit, what it removes, the variants' medians (min–max) over interleaved runs, the difference, and whether it is real by the rule above. `all` rotation 1 = base, C1, C2, C3, C4 interleaved, 5 rounds (one C1 run flagged as loaded: 3.9 other cores busy at its start; left out). `all` rotation 2 = C4, C5, C6, C7, C8, C9 interleaved, 5 rounds, every run passed, none flagged (other processes 0.28–0.38 cores).

| # | change (commit) | what it removes | before → after (s, median, min–max, n) | Δ | verdict | kept |
|---|---|---|---|---:|---|---|
| C1 | build the test project once; G and T run `--no-build` (`perf(gates): build the test project once`) | two test-project builds and two runs of the plugin's client `--check` target per `be`/`all` | 276.4 (270.8–278.8, 5) → 259.4 (258.3–263.0, 4) | −17.0 | real | yes |
| C2 | `all` runs each check once on its tree (`perf(gates): all runs each check once`) | the second `test:client-build` (45 s), `client:typecheck` (⊂ `client:build`), and the second `client:check`, `inventory:rewrite:check`, INV, TOOL | 259.4 → 209.1 (203.9–219.1, 5) | −50.3 | real | yes |
| C3 | client-build test files in parallel (`perf(tests): run the client-build test files in parallel`) | `--test-concurrency=1` on six files that share nothing | gate: 209.1 → 182.4 (177.5–205.1, 5); step (`npm run test:client-build` alone, 5 interleaved runs each): 44.5 (43.5–44.7) → 20.1 (19.6–20.7) | −26.7 | gate: within noise (the serial gate's other steps vary by ±10 s); step: real (−24.4 s, spread 1.2 s; CPU 77 → 82 s) | yes |
| C4 | four concurrent lanes (`perf(gates): be and all run as four concurrent lanes`) | the line: node suites waiting for dotnet, F's 106 s and fe after T/F | 182.4 → 124.9 (119.6–129.6, 5) | −57.5 | real | yes |
| C1–C4 | together | | 276.4 → 124.9 | **−151.5 (−55%)** | real | |
| B1 | as many Playwright workers as cores, at least 6 (`perf(browser): as many Playwright workers as cores`) | idle cores: 6 workers used 3.9 of 10, because the long tests wait on frames | `browser` 192.5 (192.1–199.2, 6) → 138.4 (137.9–140.7, 5; one run flagged loaded, left out) | −54.1 | real | yes |
| B2 | `tag-row-subpixel` as a second Playwright run beside the rest, 1 worker below 12 workers (`perf(browser): run tag-row-subpixel beside the rest`, `…gets 1 worker below 12 workers, 2 from 12`) | the 33 s single tests that started last in each project's queue and ended the run alone | 138.4 → 120.6 (119.6–122.6, 6) | −17.8 | real | yes |
| B1+B2 | together | | 192.5 → 120.6 | **−71.9 (−37%)** | real | |
| C5 | cache passing type checks by content, per gate run (`perf(build): cache passing type checks by content`) | the same `client/` checked by the plugin build's `VerifyJellyfinEnhancedClient`, `client:check`, `client:build` and the contract fixture's copies (§5) | 119.7 (119.1–122.2, 5) → 112.7 (111.4–115.5, 5) | −6.9 | real; CPU 925 → 815 s | yes |
| C6 | T as four test hosts: three for the 77 `Plugin singleton` classes (longest-first by recorded duration), one for the rest; TRX and coverage merged exactly (`perf(gates): run T as several test hosts`) | the 50 s serial chain of singleton classes after the 16 s parallel part | 112.7 → 100.7 (100.4–108.4, 5) | −12.0 | real; CPU 815 → 901 s (four host start-ups) | yes |
| C7 | wide lanes (frontend, checks) at nice 5 (`perf(gates): wide lanes yield the CPU to the long chains`) | nothing measurable: the dotnet and contracts lanes end 15 s sooner (89 → 74 s), but the frontend lane is the critical path since C6 and ends at 102 s either way | 100.7 → 102.2 (101.2–102.7, 5) | +1.5 | within noise (slower in rounds 2–5 by 0.6–1.8 s) | yes, for its first-failure gain: on the same tree (`JE_GATE_WIDE_NICE` 5 vs 0, a planted dotnet fault, 3 interleaved runs each) a dotnet failure is named after 41.3 s (40.2–42.3) instead of 54.0 s (51.9–75.0); a frontend fault after 99.6–112.8 s either way |
| C8 | each lane's first failing line printed as soon as it is written (`perf(gates): report each lane's first failing line`) | waiting for the lane's end to see a failure (§9 first failure) | 102.2 → 102.2 (101.5–102.6, 5) | −0.0 | within noise, as intended: it costs nothing | yes |
| C9 | frontend files start longest first, from recorded durations (`perf(tests): frontend files start longest first`) | nothing, because it never took effect: `node --test` sorts the files it is given (found later, see C12; checked: `c b a` run as `a b c`; the per-file start times of the C9 runs are alphabetical). The frontend lane ended at 102 s with and without it | 102.2 → 102.5 (101.8–102.9, 5) | +0.3 | within noise | **no, reverted** (`Revert "perf(tests): frontend files start longest first"`; its message gives the wrong reason, CPU-bound, corrected here). Longest-first is untested; the longest file (`admin/…`, 72 s) already sorts first |
| C4→C9 | rotation 2 end to end | | 119.7 → 102.5 | −17.1 | real | |
| C10 | node test processes share V8's compile cache (`perf(tests): node test processes share V8's compile cache`; `NODE_COMPILE_CACHE` under `node_modules/.cache`, keyed by V8 on file content) | compiling jsdom, the harness and esbuild's JS API again in each of ~180 test processes | frontend suite alone (`node tests/frontend/run.mjs`), 6 interleaved runs: 64.4 (64.2–64.8) → 63.4 (62.9–63.6) | −1.1 | real (spread 0.7 s), small; CPU 480 → 469 s | yes |
| C11 | each failing frontend test reaches the failure watcher the moment it fails (`perf(gates): each failing frontend test reaches the failure watcher the moment it fails`) | waiting for `node --test`'s report, which gives a file's results only after every file before it in its (sorted) list | time to name a planted frontend fault (`first-failure.py`, `all`): 99.4–112.8 s (6 runs, the tree before) → 74.3–81.9 s (3 runs) | ≈ −25 | real (ranges do not overlap) | yes |
| C12 | the files a change can reach (affected map) run as a first part, then the rest (`perf(gates): frontend files the change can reach start first`, then `fix(gates): the files a change can reach run as a first part, then the rest`) | the failing file waiting for its alphabetical turn | same fault, map recorded at the commit: 74.3–81.9 s → **2.1–4.2 s** (3 runs each). The first commit alone passed the files first in one `node --test` command and did nothing (82.4–95.0 s, 3 runs): `node --test` sorts its files | ≈ −75 | real | yes. Without a map, or for a global change, the suite runs as one part, as before. With a split, a full `all` counted 37 + 3827 = 3864 and passed |


## 2. Test counts

Every suite runs at least as many tests as before; no test was removed, skipped or weakened, no floor lowered, no failure list grown, and `JE_UPDATE_SNAPSHOTS` was never set. Counts from `all` and `browser` runs on the base and on this branch:

| suite | base (2917a115) | this branch | |
|---|---:|---:|---|
| dotnet T (`dotnet test`, ratcheted) | 3238 total, 3238 passed | 3238 total, 3238 passed: the sum of the four test hosts (e.g. 1133 + 1243 + 347 + 515); `dotnet_shards.py merge` refuses a host that did not complete, a count that does not add up, and a test class in two hosts | = |
| dotnet G (Architecture tests) | 24 | 24 | = |
| npm frontend suite (ratcheted) | 3863 | 3864 | +1: the scroll regression test (`pages-scroll.test.mjs`); floor raised to 3864 |
| client-build (`test:client-build`) | 223 (run twice in `all`) | 230 (run once in `all`) | +7: the type-check cache tests |
| contract boundary (`test:contract-boundary`) | 1 | 1 | = |
| bootstrap manifest (FE G) | 2 | 2 | = |
| tooling (`tests/run.py tooling`, TOOL) | 16 (run twice in `all`) | 27 (run once in `all`) | +11: `test_speed_tools.py` (shard plan and merge, affected tracing and selection, the frontend runner's split and early failures); floor raised to 27 |
| browser (Playwright, ratcheted) | 693: 690 passed, 3 skipped | 693: 690 passed, 3 skipped (the long-spec run and the rest run disjoint test sets; the gate refuses a test that appears in both) | = |

Every failure baseline (`dotnet-failures.txt`, `npm-failures.txt`, `browser-failures.txt`) is still empty. The checks `all` used to run twice on the same tree (C2) still run once each; `fe`, which runs them for a frontend change on its own, is unchanged.

## 3. Load-sensitive tests and stability

### The discovery stall: a real product race behind the most frequent flake

`[mobile-chromium] › discovery-recommendations-rewrite.spec.cjs:70` failed in **2 of 4 quiet baseline `browser` runs** (other processes at 0.3 cores), always the same way: after a scroll to the bottom the card count stayed at 360 for the whole 5 s `expect.poll`. Isolated, it passed 12 of 12. An instrumented copy (scratch, not committed) that logged the engine's console showed the passing path: 200 cards, a scroll to the bottom loads to 360, the poll's next scroll loads to 480 (the end of the fixture's 12 pages per feed). The engine throttles its scroll handler with `JE.helpers.throttle`, which is **leading-edge only**: a scroll inside the 100 ms window is dropped. When the poll's scroll landed inside that window just after a fill finished, it was dropped; the page then sat at the bottom (further `scrollTo(bottom)` calls are no-ops and fire no event) and the sentinel never stopped intersecting (no observer callback). Nothing woke the fill loop. A viewer who stops at the bottom right after a page lands sees the same thing: the list ends with pages left.

Fixed in the product, not the test (`fix(seerr): infinite scroll keeps the last scroll of a burst`, filed as a found bug): the engine's own throttle runs a call made inside the window once the window ends, and teardown cancels it. A deterministic jsdom test (`tests/frontend/pages/pages-scroll.test.mjs`, +1 test) fails before the fix ("3 loads, expected 4") and passes after. The spec itself is unchanged.

A second race in the same spec showed up once the stall was gone: after a sort it expects exactly 40 cards (the re-read first page and the second), and the engine's read-ahead could land a third page before the poll looked (`Received: 120`). The spec's fixture now holds the pages after the first until that assertion has seen 40, then releases them (`test(browser): discovery spec sees the re-read first page without racing the read-ahead fill`); the assertion is unchanged.

Stability, beside a 10-process CPU hog, the spec 20 times in each project (60 runs, 4 workers, `--repeat-each=20`): **base 7 of 60 failed** (all on the second race: `toBe(40)` received 120 or 200); **this branch 0 of 60**. On a quiet machine the base failed the stall in 2 of 4 `browser` runs (above) and the read-ahead race in 1 of 6 B2 runs; this branch's `browser` runs are in the summary.

### The other tests AGENTS.md calls load-sensitive

How they were found: the step logs (`artifacts/restructure-plan/step-logs/`) record each one failing under load and passing alone. How they were reproduced: `scripts/test-under-load.py` runs a command N times beside K busy-loop processes (`--hog K`), and with `--starve` loads `tests/runner/starve.mjs` into every Node process, which blocks its event loop for 20–80 ms at random moments (what a saturated machine does to a test process, but every few hundred milliseconds instead of rarely). Before = `8992c292` (the test code of the base), after = the fixes below; same machine, same commands, the gate lock held, nothing else running.

| | before | after |
|---|---:|---:|
| the five npm files below, together, **event loop starved**, 20 runs | **4 of 20 runs failed** (`SEERR-CORE-22: repeated close restores history once` ×4, `…Request consumes its history entry…` ×2, `…closing parent while nested modal is open…` ×2, `R2 disposed TV picker…: back` ×2, `retry jitter and clamping…` ×2) | **0 of 20** |
| the same, beside a 10-process CPU hog, 20 runs | 0 of 20 | 0 of 20 |
| `core-api-runtime`, `bootstrap-loader-rewrite` and `features-status-tags-vocabulary` beside a **30-process** hog (3× the cores), 20 runs | 1 of 20 (vocabulary `series: cancelled from TMDB over Jellyfin` showed `ended`) | 1 of 20 (vocabulary `series: airing today` showed no badge; this tree did not have the vocabulary fix yet) |
| `features-status-tags-vocabulary` with a 40 ms stall injected into the card's intersection callback (where a descheduled process loses time), quiet machine, 2 runs | `h.flush()` as it was: **39 of 104 tests failed**, both runs | the fixed `h.flush()`: **0 of 104**, both runs |
| the fixed `features-status-tags-vocabulary` beside a 30-process hog, 20 runs | (1 of 20 above) | **0 of 20** |
| dotnet `ApiSeerrProxyOutcomeTests` (37 tests) beside a 10-process hog, 20 runs | **1 of 20** (`RealSocketWriteOnAReusedConnectionIsSentOnce`) | **0 of 20** |
| whole suites on this branch beside a 10-process hog (gate concurrency: frontend at the runner's default, T one host, `browser` 10 workers) | | frontend 3 of 3 runs passed (3864 each); dotnet 2 of 2 (3238 each); `browser` 2 of 2 (690 passed, 3 skipped; 4.9 and 3.9 min) |
| the socket test with a 50 ms pause injected where a loaded machine delays the server, quiet machine, 5 runs | head and body written separately (the old server): **5 of 5 failed**, the logged assertion (the POST on another connection than the status probe) | head and body in one write (the fix): **5 of 5 passed** |

Each one, its cause and its fix (no assertion changed; every fix is in the test harness except the discovery stall above):

- **dotnet `ApiSeerrProxyOutcomeTests.RealSocketWriteOnAReusedConnectionIsSentOnce`** (`test(seerr): the loopback server writes a reply's head and body together`). The test asserts that the write reuses the CSRF probe's pooled connection. The plugin's probe (`SeerrCsrfHandler`) disposes the `/api/v1/status` reply without reading its 2-byte body. The test's loopback server wrote the head and the body in two writes; when the body landed after the client had parsed the head, `SocketsHttpHandler` drained it in the background, so the write found no idle connection and opened a new one (the logged failure: three requests on three connections). The server now writes a small reply in one write, as a server does; the pause injection shows the cause and that the fix removes it.
- **npm `core/core-api-runtime` "retry jitter and clamping…"** (`test(api): retry budget and retry schedule tests no longer depend on wall-clock time`). The test spies on every `setTimeout` under 1 s. Navigation polls for Jellyfin's page API every 100 ms when it is missing, so a retry loop that took over 100 ms of wall time recorded an extra `100` (the logged `[7, 100, 14, 14]`). The test now provides the page API (`Emby.Page`), so navigation hooks it at once and never polls. Reproduced by the starver (2 of 20 runs before, 0 after).
- **npm `core/core-api-runtime` "retry budget aborts a transport that never settles"** (same commit). The test sets a 5 ms budget; `retryFetch` checks the wall clock against the budget before the first attempt, so a process descheduled for 5 ms between two synchronous lines failed with the logged `Time budget exceeded (5ms)` instead of `AbortError`. The test now stops the API's clock, so only the budget's own timer can end the attempt, which is what the test is about. Not reproduced here (the starver cannot stall synchronous code; it passed in all 20 runs beside a 30-process hog, before and after); the logged message can only come from that path.
- **npm `requests/seerr-review-boundaries` and `seerr-review-r2`** (`test(seerr): modal history waits run the history traversal's chained tasks`). jsdom runs `history.back()` as two or three chained zero-delay tasks, and a popstate handler can start another chain; when the event loop is starved past the test's fixed 30–40 ms wait, the wait's timer runs between two links and the assertion sees the modal's history entry still current (the logged failures). The waits now run the chained zero-delay tasks to completion before and after the same fixed wait (Node runs equal-delay timers in order, so this is exact, not a longer guess); they never wait less than before. The `back` case of the TV-picker test also needed the first drain: the modal's 300 ms removal timer starts only when the traversal reaches it. Reproduced by the starver (all four failing tests, 0 after).
- **npm `bootstrap/bootstrap-loader-rewrite` "the bundle waits for idle time and slices yield once the idle period is spent"** (`test(bootstrap): idle slicing test stops the loader's clock`). The loader also ends a slice after 10 ms of wall time (`BUNDLE_RUN_BUDGET_MS`); a loaded machine can spend that inside one module's evaluation, and the slice then waits for an idle callback this test never releases, so `until` gave up after 3 s. The test is about the idle period, so it now stops the loader's clock. Not reproduced here (synchronous code again; it passed in all 20 runs beside a 30-process hog, before and after).
- **npm `features/media-tags/features-status-tags-vocabulary`** (two tests at load 40–50, one logged as "series facts arrived after `h.flush()`"). `h.flush()` waited a fixed 60 ms, started as soon as the test called it; the series request it waits for is queued by the card's intersection callback, a microtask that runs only after that call, and goes out 30 ms later. A process descheduled for 30 ms between the two (a 3× oversubscribed machine, a GC pause) reached the end of the 60 ms first, and the card still showed its library badge or none. Neither the starver nor a 10-process hog reproduces it (no event-loop task can run between a call and its microtasks); a 30-process hog does (1 of 20), and a 40 ms stall injected into that microtask fails 39 of the file's 104 tests every time. Fixed (`test(media-tags): status-tags flush starts its wait after the card's intersection callback has queued the series request`): `flush` lets pending microtasks run (`setImmediate`) before its 60 ms start, so the request's 30 ms always end first; the wait is never shorter.
- **browser `tag-fit-monotonic.spec.cjs:93`** failed in step 8 on its 15 s test timeout at load 19, with sibling cases taking 18.8 s. It has since been given `test.setTimeout(240000)` (not by this branch); it did not fail in any of the 20 timed `browser` runs here (base, B1, B2) or the 2 beside a 10-process hog.
- **browser `discovery-recommendations-rewrite.spec.cjs:70`**: the product race above, fixed.

`AGENTS.md`'s list is updated to what is still known to be load-sensitive.


## 4. Affected-tests mode

`scripts/restructure-gates.sh affected` (and `tests/runner/affected.py select|run`): regenerate the client as `fe` does, then run only the test files whose **recorded inputs** the change touches. It is never a merge gate: `all` and `browser` stay mandatory before merge, and `affected` says so when it runs.

**How it selects.** `affected.py record` runs every node test file, every Playwright spec (chromium) and the dotnet suite once under `strace -f` and keeps, per file, every checkout path the file or anything it started (a fixture server, a browser, a `dotnet` or `python` child) opened, `stat`ed, listed, or looked for and did not find. A change (committed, staged, unstaged, untracked, measured from the map's commit) selects a file when it touches one of those paths, adds or removes a file in a directory the test listed, creates a path the test looked for, or changes the test file itself; a file the map does not know is selected; and anything global (package.json, the lockfile, the Node version, the test runner and reporter, the Playwright config, the gate script, affected.py) selects everything. The dotnet suite is one assembly: it is selected for any change under the plugin, the backend tests, their fixtures or the build files, or to a path its run read (`docs/feature-map.json`, `client/entries/*.json`, …). Why tracing instead of an import graph: the node tests read the generated `js/**` with `readFileSync`, compile `client/src` through esbuild, list directories (the admin engine is "every `Configuration/admin/*.js`"), and start child processes; the browser specs add scripts by path and fetch through the fixture server. A static graph sees almost none of that.

**The map.** 240 files traced in 206 s on the Lenovo at 6b12bf6f (181 frontend, 7 client-build, the contract boundary, 50 specs, the dotnet run); none failed while recording. Median paths per file: frontend 25, specs 61, the boundary test 1184, the dotnet run 328. It needs `strace` (the laptop has none; `record` now says so and records nothing). A second map, recorded at the final code (c3ff299e) for the first-failure runs, traced the same 240 files in 286 s. The map is keyed by commit, Node version and lockfile hash; a stale one (other Node, other lockfile) selects everything.

**History replay** (`affected_validate.py history`, the last 100 commits of `restructure/integration`, each commit's diff from its first parent, with the map of the tip; an approximation for old commits, whose tests read slightly different files): 23 commits select everything (they touch a global input: the gate script, `package.json`, the runner); 58 select the dotnet suite (they touch the plugin); in the other 77 the median selection is **20 of 189 node test files and 1 of 50 specs** (frontend median 1.7%). No changed test file was ever left out (that is by construction). The literal test the brief asks for, "every test that changed result between a commit and its parent was selected", is vacuous on this history: every commit passed its gates, so no test changed result except by being added, and added files are always selected. The planted-fault validation below is the real check.

**Planted faults** (`affected_validate.py mutate`): 24 single-site faults (operators `<`→`<=`, `&&`→`||`, `==`→`!=`, `true`→`false`, `0`→`1`, …) in source files the last 100 commits changed (15 C#, 8 TypeScript under `client/src`, 1 browser fixture loader; seed 1), each applied alone to the map's tree (`6b12bf6f`), the client regenerated for `client/src` edits, then **every** node test file and every spec (chromium) run, and the dotnet suite whenever the selection left it out. A failing file the selection left out goes through the flake protocol: it must fail again with the fault and pass on the clean tree to count as a miss.

- **Faults that broke a node or browser test: 7.** In 3 of them (a browser fixture loader: 5 specs; `review-domain.ts`: `pages-reviews`; `seerr/details/moreinfo/init-entry.ts`: `pages-seerr-details-moreinfo`) every failing file was selected. The other 4 broke only the discovery spec, outside the selection (below).
- **Faults no node or browser test noticed: 17**, 12 of them C# changes for which the dotnet suite was selected and so not run here (a C# change always selects the whole dotnet suite; the validation checks what was left out, not what was selected). The 5 TypeScript survivors are gaps in the suites, not in the selection; they are listed in the record (`affected_validate.py mutate --out`).
- **Failures outside the selection: 6**, all browser specs known to be flaky on that tree (it predates the discovery fixes): `discovery-recommendations-rewrite.spec.cjs` after four unrelated faults (three in C# controllers and services that no spec can reach: the browser specs run against the Node fixture server, never the plugin), `admin-config-rewrite` once, `tag-fit-monotonic` once. The protocol classed 5 as flakes and **1 as a miss** (the discovery spec after a C# change to a `NotFound` body in `JeDetailsProvidersController.Reviews.cs`: it failed again with the fault and passed once clean). **Re-checked with 10 runs per condition** (the spec on chromium, with the fault and clean, on the map's tree and on this branch): 0 failures in all 40 runs. The flagged miss was the spec's flakiness, not a dependency.

**Miss rate: 0 of 24 faults** (0 failing test files left out of a selection, after the re-check); the other 5 failures outside a selection were flakes cleared by the protocol (the discovery spec, flaky on that tree before its fixes, three times; `admin-config-rewrite` and `tag-fit-monotonic` once each). The same protocol on a tree with the discovery fixes would not have to separate flakes at all; the next run of this validation should use a map recorded after them.


## 5. Result caching

### What was built

`scripts/client-build.mjs` caches **passing type checks** of `client/` by content (commit 27ec6f40), with `tests/client-build/typecheck-cache.test.mjs` (7 tests) proving the invalidation:

- **Key:** sha256 over the TypeScript version, `client-build.mjs`'s own text, `package-lock.json`, the parsed compiler options (root-relative), and every root file of the tsconfig (`client/src/**/*.ts`) with its content hash.
- **Hit check:** the stored entry also lists every other file the passing program loaded (TypeScript's `lib.*.d.ts`, anything resolved outside the roots) with its hash; all must still match.
- **Never stored:** a failing check. A failure always runs the full check again.
- **Invalidation proved by the tests:** an edited source (and its error is reported), an added or removed source, a changed compiler option, a changed lockfile, and a changed loaded lib file each run the check again; with no `JE_TYPECHECK_CACHE_DIR` nothing is read or written; `JE_TYPECHECK_CACHE_VERIFY=1` checks even on a hit (an audit, in the spirit of t3code's `--verify-hits`).
- **Scope:** the merge gates (`be`, `fe`, `all`) create a fresh cache directory per run and delete it at the end, so a gate never trusts a result from before it started; inside one run the same tree is checked by the plugin build's `VerifyJellyfinEnhancedClient` target, `client:check`, `client:build` and the contract-boundary fixture's copies (which share the cache through the inherited environment, and whose untouched copy of `client/` hashes the same). `affected` keeps a persistent cache in `node_modules/.cache/je-typecheck`.

### What was not built, and why

- **Per-file caching of node test results** (t3code's `test:cached`). The sound key is the set of files a test file read; that set is what the affected map records (§4), so the same traces could key a cache. It was not added to the merge gates: a merge changes many inputs (few hits), and a wrong key there is a false green on `restructure/integration`. As an inner-loop feature it would need the map to be kept current per commit; §4 measures how trustworthy the traces are first.
- **dotnet results.** One assembly: any plugin change changes the input. No per-class keys without a coverage map.


## 6. The browser suite's structure

### What the suite is

693 tests = 231 specs' tests × 3 projects (chromium, mobile-chromium = Pixel 7 emulation in Chromium, firefox); 690 pass, 3 skip by design (two layout-only tests skip on the other form factor). One fixture server (`tests/browser/server.cjs`) per Playwright run, a fresh browser context per test, 18 worker processes per run (6 per project, as the queue moves project by project).

### The questions in the brief

- **How many tests need Firefox as well as Chromium?** The suite cannot prove a negative, but the history says Firefox earns its 36% of the time (351 of 972 test-seconds). Five hours before this work started, Firefox's runs of `seerr-core-rewrite.spec.cjs:56/:69/:80` caught BUG-019 (Gecko does not deliver `mouseenter` to a listener bound during that move; fixed in e150c140); `logo-custom-layout`, `settings-overflow` and `tag-stack-fit` carry Firefox-specific geometry (narrower fonts, trailing-space line breaks). The geometry and event specs (the `tag-*`, `settings-*`, `flush-edges`, `first-chip-fit`, `*-navigation` families: most of the time) are exactly the engine-dependent ones. Firefox stays in the full gate. A Chromium-only run would be a separately named inner-loop mode, not offered here.
- **Browser and server startup.** Small: one fixture server per run (1.5 CPU-s), browser launch to first test 1.56 s median, 18 launches ≈ 28 worker-seconds ≈ 5 s of wall at 6 workers; workers spend 15.6 CPU-s outside tests. Not worth a change.
- **Shared logged-in state.** Nothing to share: no spec logs in. Each test builds its state in the page (`window.JellyfinEnhanced` fixtures, `page.route` answers). `storageState` would save nothing.
- **Reusing the fixture server.** It is already one per run. The long-spec split adds a second (one more 1.5 CPU-s).
- **Does sharding across more workers scale?** Yes, because the long tests wait on animation frames, not on the CPU (at 6 workers the suite used 3.9 of 10 cores). A model of Playwright's queue (project by project, file by file, a worker restart of 1.6 s at each project change) fed with the recorded per-test durations reproduces the measured 193 s at 6 workers exactly (193.0 s), and predicts:

  | workers | one FIFO run | `tag-row-subpixel` as a second run with 1 worker | … with 2 workers | ideal (sum / workers, floor 33.5 s) |
  |---:|---:|---:|---:|---:|
  | 6 | 193.0 | – | – | 161.4 |
  | 8 | 149.9 | – | – | 121.1 |
  | 10 | 126.0 | 106.0 | 116.1 | 96.9 |
  | 12 | 110.5 | 104.9 | 97.3 | 80.7 |
  | 16 | 90.3 | – | 74.8 | 60.5 |

  The model ignores CPU contention, so it is a lower bound once the workers saturate the cores. Measured numbers are in §1 (B1, B2) for 10 cores; the 16-core laptop was busy with trials for the whole session (load 12–23), so the 16-core row is the model only. The gate sets workers from the machine (`JE_BROWSER_WORKERS`, default the core count, at least 6) and gives the long spec 2 workers from 12 workers up, so a 16-core machine gets the 16-worker line without a change.
- **Ordering.** Playwright has no ordering hook: files are collected alphabetically and dispatched in that order, project by project, so a 33 s test late in a project's list ends the run on its own. Longest-first within each project would give 101.8 s at 10 workers in the model; the closest thing Playwright allows without renaming files or projects (project names are part of snapshot names and test identities) is a second run for the long spec, which is what B2 does.


## 7. TypeScript checkers: `tsc` 6, `tsgo` (TypeScript 7) and ts-rust (tsc-rs)

Versions tested (pinned, recorded): **`tsc` 6** = `typescript@6.0.3` (the repository's, `package-lock.json`); **`tsgo`** = **`typescript@7.0.2`** (TypeScript 7 *is* the Go compiler, shipped as `tsc` in the `typescript` package; `@typescript/native-preview` stopped at `7.0.0-dev.20260707.2`, measured too as `tsgo-preview`); **ts-rust** = **`tsc-rs@0.8.0`** (npm `latest`, 2026-10-21; binary from `@tsc-rs/linux-x64@0.8.0`; prints `Version 7.1.0-dev`, the TypeScript version it ports, upstream pin `typescript@7.1.0-dev.20261008.1`). All installed with `npm install --save-exact` into a scratch directory (no repository change), install scripts blocked (`tsc-rs`'s `postinstall` is not needed: the binary comes from the platform package).

What each covers here: the client is bundled by esbuild, so the job is **checking** `client/` (`client/tsconfig.json`: `noEmit`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: Bundler`, `types: []`). The tsconfig needs no change for TypeScript 7 or tsc-rs (none of the options TypeScript 7 removed are used). Emit, declaration output and project references are not used by this repository; both native compilers support `--build` and `--watch` (`tsc-rs --help`; ts-rust README "Known problems" for `-b` without references). Neither offers anything for the other steps here: no bundler (esbuild stays), no linter (none in the gates), and the node test files are plain `.mjs` that need no transform.

### 7.1 Speed

One full check of `client/` (580 files), a new process each time (`-p client/tsconfig.json --pretty false`), 10 rounds, the checkers interleaved in a rotating order; **cold** = every file under `client/` and the checker's own install evicted from the page cache first (`posix_fadvise DONTNEED`), **warm** = straight after. Every run reported zero errors.

Seconds, median (min–max), n = 10 each:

| checker | Lenovo (10 cores) cold | Lenovo warm | 16-core laptop cold | laptop warm |
|---|---:|---:|---:|---:|
| `npm run client:typecheck` (the repository's step: tag data, source policy, TS 6 API check) | 3.88 (3.85–3.97) | 3.81 (3.74–4.07) | 4.96 (4.90–6.14) | 4.82 (4.73–4.95) |
| `tsc` 6.0.3 | 3.22 (3.15–3.39) | 3.15 (3.12–3.33) | 4.12 (3.99–5.30) | 3.98 (3.91–4.04) |
| `tsgo` = TypeScript 7.0.2 | 0.49 (0.47–0.53) | 0.45 (0.44–0.48) | 0.54 (0.51–0.66) | 0.51 (0.49–0.53) |
| `tsgo` preview 7.0.0-dev.20260707.2 | 0.48 (0.46–0.52) | 0.45 (0.44–0.54) | 0.54 (0.52–0.63) | 0.51 (0.47–0.53) |
| ts-rust `tsc-rs` 0.8.0 | **0.23** (0.21–0.23) | **0.19** (0.18–0.19) | **0.29** (0.29–0.57) | **0.25** (0.24–0.26) |
| ts-rust `tsc-rs --fast` | 0.16 (0.15–0.21) | 0.13 (0.12–0.15) | 0.27 (0.25–0.52) | 0.22 (0.21–0.23) |

On this tree TypeScript 7 is 6.6–7.8× `tsc` 6 and tsc-rs is 14–17× (about 2× TypeScript 7, as its README claims for small projects); `--fast` (one checker per core) adds little at 580 files. All differences are far outside the spreads. The laptop was quiet during its runs (a watchdog would have aborted at 1.5 foreign cores); its slower single-thread speed shows in `tsc` 6. Watch mode (`--watch`: the re-check after a one-line edit, the inner loop's real cost), Lenovo, one watcher per checker, 10 edits each that alternately add a type error to a real file and remove it; every report is checked for the expected count (1, then 0), and all 40 matched:

| checker | edit in a leaf file (`core/lifecycle-entry.ts`) | edit in `host/context.ts`, imported by much of `client/src` |
|---|---:|---:|
| `tsc` 6.0.3 `--watch` | 0.26–0.28 s | 1.76–2.06 s |
| TypeScript 7.0.2 `--watch` | 0.011–0.019 s | 0.22–0.25 s |
| tsc-rs 0.8.0 `--watch` | 0.005–0.008 s | 0.10–0.11 s |
| tsc-rs 0.8.0 `--fast --watch` | 0.006–0.016 s | 0.07–0.09 s |

So in watch mode the native checkers answer a leaf-file edit within a screen frame or two and an edit to a widely imported file in 0.07–0.25 s; `tsc` 6 takes 0.26–2.1 s. (A first attempt edited a comment line; `tsc` 6 reported only half of those edits, so a report did not prove a check, and the edits were changed to add and remove an error.) Watch mode was measured on the Lenovo only: the laptop was busy with trials for the rest of the day.


### 7.2 Agreement with `tsc` 6

`scripts/typecheck-agreement.mjs` finds mutation sites in the real `client/src` with the TypeScript 6 API (22 kinds, up to 6 sites each, spread over different files), applies each mutation **alone** to a copy of `client/`, runs every checker on it and compares `file:line TScode` sets with `tsc` 6. Kinds: a removed `override` (`noImplicitOverride`); `import type` turned into a value import (`verbatimModuleSyntax`); a type-only import used as a value; a removed `break` (`noFallthroughCasesInSwitch`); a wrong argument type; one argument too many; a misspelt property; a missing required property; an excess property; `undefined` for an optional property (`exactOptionalPropertyTypes`); a removed `!` on an indexed access (`noUncheckedIndexedAccess`); a removed `!` elsewhere; a removed `?.` on a possibly-undefined value; a wrong return type; an unreachable `case` on a narrowed literal union; a parameter that loses its annotation (implicit `any`); `e.message` on a `catch` variable (`unknown`); a `readonly` property assigned; a `const` reassigned; `null` for a non-nullable declaration; an explicit type argument replaced; `export type … from` turned into a value re-export (`isolatedModules`).

Results (Lenovo, `client/` at 02c83535, which equals 2917a115's `client/`):

- **Clean tree:** all five report zero errors.
- **121 mutations; `tsc` 6 rejects 117 (the seeded errors) and accepts 4.**
- **Verdict and location:** TypeScript 7.0.2, the July preview, tsc-rs 0.8.0 and tsc-rs `--fast` each agree with `tsc` 6 on **all 121**: every error `tsc` 6 reports is reported at the same file and line, and none of them reports an error where `tsc` 6 does not (the 4 accepted mutations are accepted by all). **Missed errors: 0. False errors: 0.**
- **Error code:** 3 differ, identically for all four native checkers: a required property removed from an object passed as an argument (`src/core/api/retry.ts:35`, `src/features/media-tags/pipeline/server-cache.ts:421`, `src/features/seerr/details/details-page/rows.ts:112`) is TS2345 ("argument not assignable") in `tsc` 6 and TS2741 ("property missing") in TypeScript 7. Same line, both an error; it is TypeScript 7's behaviour, and tsc-rs matches TypeScript 7 exactly.
- tsc-rs never differed from TypeScript 7 on any of the 121 (the port's claim to match Go held here).

The whole record (every mutation, every diagnostic of every checker) is `scripts/typecheck-agreement.mjs --out` output, kept with the measurements; rerunning it is one command.


### 7.3 Where a faster checker could be used

The user's default position holds, and the numbers sharpen it:

- **The agent's inner loop (`quick`, `je12 test`, `affected`).** A type check there costs 3.2–4.1 s with `tsc` 6 and 0.19–0.29 s with tsc-rs, per check. tsc-rs missed nothing in the seeded set, so by the stated rule it **may replace `tsc` in the inner loop now**, as a separate fast pre-check (the step's tag-data and source-policy checks still need the TypeScript 6 JS API; they take ~0.7 s). With the type-check cache (§5) an unchanged tree already costs nothing; tsc-rs makes the changed-tree case cheap. TypeScript 7.0.2 is the conservative choice (Microsoft's release, 0.45–0.54 s) with the same agreement.
- **The `fe` and `all` gates.** Keep `tsc` 6 as the authority. Add a **shadow step** that runs tsc-rs (or TypeScript 7) on the same tree and fails when its `file:line` set differs from `tsc` 6's, so the comparison keeps running on real changes; it costs ~0.3 s on a lane with slack. Error-code differences (TS2345 vs TS2741 above) should be reported but not fail the step, since TypeScript 7 changed them on purpose. Not implemented in this branch: it adds a dependency (below), which is a maintainer decision.
- **The plugin build** (`VerifyJellyfinEnhancedClient` runs `client-build.mjs --check` in every `dotnet build`, including `je up`/`je12 deploy`). Keep `tsc` 6 there: it is the guard that a build never ships unchecked or stale client code. The repeats inside one gate run are already gone (C1, C5).
- **Contract generation.** `tools/ClientContracts` is a .NET tool; it does not use the TypeScript API. Nothing to change. The TypeScript 6 JS API used by `client-build.mjs` (`createProgram`, `createSourceFile` for the source policy, `parseJsonText`) has no stable equivalent in TypeScript 7.0 (a stable API is promised for 7.1); tsc-rs offers an API server (`--api`) not evaluated here.
- **Other steps:** neither native compiler bundles or lints; esbuild stays; the node test files are `.mjs` and need no transform. Nothing else to speed up with them.


### 7.4 Getting it reproducibly, offline

Nothing was added to the repository. To adopt tsc-rs reproducibly: add `"tsc-rs": "0.8.0"` (exact) to `devDependencies` and commit the lockfile; `package-lock.json` then pins `tsc-rs@0.8.0` and the platform package `@tsc-rs/linux-x64@0.8.0` (`optionalDependencies` of `tsc-rs`, with integrity hashes), and `npm ci` installs it from a populated npm cache with no network, exactly as it does `esbuild`'s platform binary today; its `postinstall` is not needed (verified: it works with install scripts blocked). For the trial sandboxes and the second maintainer's machine that means the cache they are seeded from must include those two tarballs (`npm cache add tsc-rs@0.8.0 @tsc-rs/linux-x64@0.8.0`, plus `@tsc-rs/darwin-arm64` for a Mac). TypeScript 7 is the same story with `typescript@7.0.2` under an alias (the repository must keep `typescript@6.0.3` for `client-build.mjs`'s API), e.g. `"ts7": "npm:typescript@7.0.2"`. Upgrades should be deliberate: rerun `scripts/typecheck-agreement.mjs` and the timing script on each bump; tsc-rs is two months old, LLM-written and maintained by one person ("This is an early release"), and its version string (`7.1.0-dev`) is the ported TypeScript version, not the package's.



## 8. Several gate runs at once

`scripts/gate-concurrency.py` starts K `all` runs at once in K clean worktrees (several agents finishing together) and records each run, the time until the last one ends, throughput, CPU use, the lowest MemAvailable and the swap in use. It holds the gate lock for the whole experiment and stops a level, and every level above it, when memory runs out or the kernel reports thrashing (§ the guard below). The Lenovo has 10 cores and 15 GB of memory with 4 GB of swap; other agents' resident processes (the T3 server, sessions) use about 3–4 GB of it.

| design | K at once | every run passed | until the last ends | `all` runs per hour | CPU busy | lowest MemAvailable | swap in use |
|---|---:|---|---:|---:|---:|---:|---:|
| base (2917a115) | 1 | yes | 272.1 s | 13.2 | 35% | 6.2 GB | 1.7 GB |
| base | 2 | yes | 404.9 s (399.9, 404.9) | 17.8 | 54% | 3.5 GB | 4.1 GB (all of it) |
| base | 3 | stopped by hand after 26 min | — | — | — | ~1.55 GB | 4.1 GB |
| this branch | 1 | yes | 102.1 s | 35.3 | 86% | 4.3 GB | 2.9 GB (left from the level above) |
| this branch | 2 | stopped by the guard in all three tries | — | — | — | 3.5 / 5.4 / 3.9 GB | up to 4.1 GB (all of it) |

**This branch at K=2.** The first try was stopped after 14 s by a swap-in guard (a false positive: pages swapped out by the base's K=3 were coming back); the second after 8 s by the memory-stall guard at 16% (a busy start, with 5.4 GB available: the threshold was then raised to 40%); the third after 32 s at a 41% stall, with 3.9 GB available and swap full, while another agent's Jellyfin lab ran beside it. K=3 and K=4 were not tried. The `all` + `browser` runs below are the cleaner evidence of what two final-design gates do to this machine.

**What happened at base K=3.** MemAvailable sat just above the first guard's 1.5 GB floor, so the guard never fired, while the machine thrashed: code and file pages evicted and re-read at 1.4–1.7 GB/s, 77–86 processes blocked on I/O, 68% of CPU time waiting, the kernel's 5-minute `full` memory stall at 47%. I stopped it (every tree checked clean afterwards) and changed the guard to stop a level on the kernel's own thrashing signal (PSI `full avg10` over 15%) or below 2 GB available, and to climb no further. A first replacement guard that watched swap-in stopped this branch's K=2 after 14 s at 3.5 GB available: pages swapped out by the base's K=3 were coming back, not new pressure, so swap-in is not a usable signal and was replaced by PSI before the final K=2–4 were measured.

**`all` and `browser` started together** (each in its own worktree, twice per design, alternating; the base `browser` is 6 workers, this branch's 10): the base finished both in 342.3 and 337.7 s and passed. This branch failed both times: `browser` had 17 tests over their 15 s timeout (mobile-chromium and chromium pages under 2× oversubscription) and one dotnet test's node child exceeded its 15 s hang guard (`BootstrapContractTests.SpoilerStateWire…`), in 307 s the first time and 544 s the second. Nothing in the tests is wrong; the machine was asked for about twice what it has. The final design assumes it has the machine to itself: `all` uses 8.5 of 10 cores and up to ~6 GB, `browser` a worker per core.

**Policy this supports.** One gate per machine at a time, which agents already follow through the gate lock (`JE12_GATE_LOCK`); `restructure-gates.sh` does not take the lock itself, so the rule holds only as long as every caller wraps it (a decision below). Run `all` then `browser` in sequence: 225.4 s in total on the final commit, faster than the base ran the two side by side (342 s), and every test passes. More agents finishing at once queue for the lock instead of slowing each other: at 102 s per `all`, a queue of four is done in under 7 minutes, where four base gates side by side do not finish at all on this machine.

## 9. Final gates on the final commit

The full gates, run through `scripts/gate-timing.py` (gate lock held) on the final commit `db907c54` in a clean worktree, three times each, alternating `all` and `browser`. The machine was shared: another agent's Jellyfin lab and benchmarks ran beside the second and third pairs (the harness flags them).

| pair | `all` | `browser` |
|---|---|---|
| 1 (quiet: other processes 0.4 cores) | **passed, 103.9 s** (8.5 of 10 cores) | **passed, 121.5 s** |
| 2 (beside the lab: load 7.6 at the start, other processes 2.1–3.0 cores) | **failed, 360.4 s**: 3 dotnet tests and the contract-boundary test, all on hang guards around child processes (`BootstrapContractTests.SpoilerStateWire…`'s node child, 15 s; `ApiItemLookMutationTests.ProductionPageSavesThroughRealHttpValidator`, 2 min; the boundary test's `spawnSync node ETIMEDOUT`); the run used only 3.2 cores, so it waited on something other than CPU | passed, 166.3 s |
| 3 (load 29 at the start, other processes 1.1–1.4 cores during) | **passed, 110.3 s** | passed, 131.1 s |

Under the flake protocol the pair-2 failures are load flakes: the isolated reruns passed (the 21 test cases of the two dotnet tests in 12 s; the boundary test), and the clean full rerun (pair 3) passed. They are newly seen load-sensitive tests: fixed time limits on child processes that a 3.5× slower machine exceeds. Raising a hang guard does not touch an assertion, but it is the maintainer's call; they are recorded here and in the decisions below, not changed.

Output summary of the passing `all` runs (pairs 1 and 3, identical counts):

```
lane checks: passed after 69 s          lane contracts: passed after 83 s
lane dotnet: passed after 85 s          lane frontend: passed after 104 s
G   Passed!  - Failed: 0, Passed:   24, Total:   24
T   Passed!  - Failed: 0, Passed: 1243 / 347 / 515 / 1133 (four test hosts)
T (dotnet test): total 3238 (baseline 3238), passed 3238 (baseline 3238), failed 0 (baseline list 0)
coverage: "passed": true
npm test: total 3864 (baseline 3864), passed 3864 (baseline 3864), failed 0 (baseline list 0)
contract boundary: tests 1, pass 1   client-build: tests 230, pass 230   bootstrap manifest: tests 2, pass 2
restructure-gates: all passed
```

Output summary of the `browser` runs (all three identical):

```
the rest: 687 passed, 3 skipped      the long run (tag-row-subpixel.spec.cjs): 3 passed
BROWSER: 693 tests, passed 690, failed 0 (baseline list 0), skipped 3
restructure-gates: browser passed
```

## 10. What remains slow, and what next

### What remains slow, and why

- **`all` is now CPU-bound, not wait-bound.** It uses ~8 of 10 cores for its whole run; ~900 CPU-seconds on 10 cores is a floor of ~90 s whatever the order. The biggest consumer is the frontend suite (~490 CPU-s), and a CPU profile of its slowest file (`admin/config/admin-config-rewrite.test.mjs`, 59 CPU-s) is **jsdom itself**: 42% jsdom, 21% `symbol-tree` DOM walks, 7% `nwsapi` selector matching, 9% GC — 43 tests each parse the 1.36 MB generated `configPage.html` and run its scripts in a fresh realm. The test code is not where the time goes.
- **The contract-boundary test** (`tools/ClientContracts/boundary.test.mjs`) is one 54 s sequential integration test (seven `dotnet run`s, a fixture `dotnet build`/`pack`, full type checks of the fixture); in the lanes it is one of the long chains.
- **`browser` is frame-bound.** Its long tests wait on animation frames (`tag-fit-monotonic`, `tag-row-subpixel`: 0–22 CPU-s over 33–95 s); Firefox is 36% of it and earns its place (BUG-019).
- **Memory, not CPU, limits several gates at once** (§8).

### Decisions needed

1. **A native type checker as a dependency** (§7.3, §7.4): tsc-rs 0.8.0 (fastest, one maintainer, two months old) or TypeScript 7.0.2 (Microsoft's, half the speed of tsc-rs, still 7× `tsc` 6), for the inner loop, with a shadow step in `fe`/`all` that fails on any `file:line` disagreement with `tsc` 6. Not added here.
2. **HOST check of the product fix** `fix(seerr): infinite scroll keeps the last scroll of a burst` (ea924a25, found bug filed in `je-found-bugs/inbox`): it changes the Seerr discovery engine's scroll throttle from leading-edge-only to leading plus one trailing call. jsdom and Playwright fixtures cover it; a real Jellyfin 12.4 page with Seerr has not been scrolled with it.
3. **Enforce one gate per machine in `restructure-gates.sh`.** The final design assumes it has the machine to itself (§8: two at once fail on timeouts; three base gates thrash). Today only callers that wrap the script in `flock` on `JE12_GATE_LOCK` keep the rule. Taking the lock inside the script needs a re-entrancy marker so callers that already hold it do not deadlock.
4. **je12's `summarize` should show `FAILURE seen after N s in lane X` lines** (and its `quick` mode could call `affected`): the early failure lines go to the gate's stderr while the lanes still run; a summary that keeps only the last lines hides them.
5. **Who records the affected map, and when** (next step 3): it needs `strace` (the laptop has none) and 3.5 minutes per base.
6. **Hang guards on child processes in three tests** (§9: `BootstrapContractTests.SpoilerStateWire…` 15 s, `ApiItemLookMutationTests.ProductionPageSavesThroughRealHttpValidator`, the contract-boundary test's `spawnSync` timeout) fired once when another agent's lab slowed the machine 3.5×. Raise them to a hang-only limit, or accept them as load flakes under the protocol.

### What I would do next, and what it needs

1. **Cut the frontend suite's CPU, now the floor under `all`.** `all` burns ~875 CPU-s on 10 cores, so ~88 s is the floor whatever the order, and it ends at ~102 s. The frontend suite is ~470 of those CPU-s and is the lane that ends last; its biggest file (`admin/config/admin-config-rewrite.test.mjs`, 59 CPU-s, 72 s alone) parses the 1.36 MB generated `configPage.html` in a fresh jsdom realm for each of its 43 tests, and jsdom itself is 70% of the profile. Candidates, each to be A/B-tested like the rest: parse the page once per process and give each test a fresh realm cloned from it (keeps isolation), split that file in two (it then stops being the lane's tail), and see whether `happy-dom` passes the same tests (a tool swap, only where measured). Needs: a per-file CPU profile run (`node --cpu-prof`, as in PROFILE.md) and the same interleaved A/B.
2. **Adopt a native type checker where it is safe, with a shadow step in the gates.** tsc-rs 0.8.0 and TypeScript 7.0.2 agreed with `tsc` 6 on all 121 seeded mutations (verdict and `file:line`) and check `client/` in 0.13–0.5 s instead of 3.2 s, and re-check an edit in 5–250 ms instead of 0.3–2 s. Proposed: the inner loop (`quick`, `je12 test`, `affected`) uses the native checker; `fe`/`all` keep `tsc` 6 as the authority and add a step that runs both and fails on any `file:line` disagreement (error codes reported, not failed: TS7 changed TS2345 to TS2741 on purpose). Needs the maintainer's decision on the dependency (§7.4 has the pinned, offline install) and one commit to wire it.
3. **Make the inner loop use what this branch built.** `affected` (traced inputs, never a merge gate) plus the content-keyed type-check cache and the early failure lines are in place; je12's `quick` does not use them yet, and the map is only as good as its recording. Proposed: record the map in the merge flow on `restructure/integration` (3.5 min on the Lenovo, needs `strace`; a stale map already falls back to running everything), have `quick` call `affected`, and keep running `affected_validate.py mutate` on a schedule so the miss rate stays measured. Needs: the je12 skill change (outside this repository) and somewhere to run the recording.


## 11. Landing: the rebase onto the main line (2026-11-11)

The main line moved 64 commits while this was measured (the upstream catch-up to 12.15.0.0 and later ports, three bug fixes, the per-kind tag opacity and size feature, the runtime performance branch, `quick` and the attribution check in the gate script). The branch was rebased onto `0390f885`, then `87c34b87`. Five places needed a hand: the gate script (the main line's `quick` beside this branch's `affected`), `AGENTS.md`, and the count floors (the main line had raised them to dotnet 3295, npm 3906, tooling 28; each of this branch's floor commits now adds its tests to those). Generated files were never hand-merged: after each rebase `npm run client:build` regenerated the client and matched the committed output exactly. Five commit messages that stated pre-rebase floors, or C9's wrong reason, were reworded.

**What the rebase added** (one commit each):

- **`quick` found no features** (a main-line bug): `quick_map`'s program is python's stdin (a heredoc), so the changed paths piped into it were never read and `quick` without feature names ran only the architecture and guard tests; je12 passes its own names, so nobody noticed. The paths now go as arguments, with a tooling test.
- **One inner loop.** `quick` (the main line's, which je12 calls) stays the entry point; `affected` alone is now an alias. A recorded affected map widens `quick`: it adds the node test files whose traced inputs the change touches (a union, never fewer files) and runs the traced specs on chromium; the contract-boundary test stays in the gates. `quick` keeps a type-check cache, so its typecheck and build share one check, and starts with the tsc-rs pre-check. `affected record` records the map.
- **Heavy gates take turns.** `be`, `fe`, `all` and `browser` hold a machine-wide slot (their own lock file, never `JE12_GATE_LOCK`, so callers holding the gate lock cannot deadlock on it). §8 showed `all` and `browser` started together fail on this machine; je12's `gate final` starts them together on a quiet machine. Now the second one waits and they finish in turn. A tooling test holds the slot and checks a second gate waits.
- **tsc-rs 0.8.0**, exactly pinned, as `quick`'s fast pre-check (`npm run client:typecheck:fast`, 0.21 s); TypeScript 6 still checks right after and stays the authority in every gate. Pinned under **`optionalDependencies`, not `devDependencies`**: an offline `npm ci` whose npm cache was filled before this change fails with `ENOTCACHED` for a dev dependency and skips an optional one (both tried with a cache seeded from the main line's lockfile); a cache with `tsc-rs` but without its platform package installs either way and leaves the binary unusable. Without a usable binary the pre-check says so and passes. The `tool` gate runs `scripts/typecheck-agreement.mjs --gate`: the clean tree and 4 mutation sites drawn by the commit, failing on a different verdict or `file:line` set (14 s; `tool` is 74 s with it). Wiring it found a bug in the agreement script: a checker command that does not resolve in the scratch copy exited without diagnostics and read as "no errors"; that is now an error (the 121-mutation run in §7 used absolute paths and is unaffected).
- **At most 10 Playwright workers, fewer when other work keeps cores busy.** On the 16-thread second worker (an i5-1340P: 4 performance cores with two threads each and 8 efficiency cores, power-limited, shared with trials) one worker per thread pushed Firefox tests past their 15 s timeout: `browser` failed 2 of 2 (3 and 1 tests). With the cap (10, less the cores busy in a 1 s sample, at least 6) it passed 2 of 2 there (9 and 8 workers, 265.6 and 276.7 s; 741 tests, 738 passed, 3 skipped). On the Lenovo's 10 real cores nothing changes.
- **The build after the main line's "bundle the client entries at once".** Both gains stay: `client-build.mjs --check`, 5 interleaved rounds: the main line 4.31–4.38 s, this branch without a cache 4.31–4.40 s (the same work), with a type-check cache hit 1.32–1.39 s (the repeated checks inside a gate run). Overlapping the 3.3 s type check with the 0.45 s of bundling would need a worker thread; not done.

**Today's before/after** (the Lenovo, quiet, the gate lock held, the main line `0390f885` against this branch rebased on it, 3 interleaved rounds, every run passed):

| | main line | this branch | change |
|---|---:|---:|---:|
| `all` | 272.7 s (267.6–280.6) | **122.8 s** (122.3–124.1) | −149.9 s (−55%), real |
| `browser` | 196.9 s (196.7–197.0) | **121.7 s** (121.6–122.6) | −75.2 s (−38%), real |
| both, in turn | 469.6 s | 244.5 s | −225.1 s (−48%) |
| `all` on the final base `87c34b87` | | 121.3 s (1 run) | |
| the second worker (16 threads, shared) | | `all` 313–341 s, `browser` 266–277 s | |

**Counts, both sides** (from those runs): dotnet T 3340 on both (3343 on `87c34b87`, which adds the main line's new LeavingSoon tests); G 24 = 24; npm 3954 → 3955 (+1, the scroll regression test; 3956 on `87c34b87`); client-build 223 → 230; contract boundary 1 = 1; bootstrap manifest 2 = 2; tooling 28 → 41; browser 741 = 741 (738 passed, 3 skipped). The floors are now dotnet 3343, npm 3956, tooling 41, the measured counts of the final tree.

**The load-sensitive tests on today's tree** (the five npm files under the event-loop starver, 20 runs each): the main line failed **9 of 20** runs (`SEERR-CORE-22: repeated close restores history once` ×6, `…Request consumes its history entry…` ×4, `…nested modal close leaves parent active…` ×4, `retry jitter and clamping…` ×4, `R2 disposed TV picker…: back` ×2); this branch **0 of 20**.

**Where the gate results come from:** the landing report names the gates run on the final commit, the tool and version, and the machine.

