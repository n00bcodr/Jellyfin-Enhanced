# perf/round2 regression comparison — 2026-10-05

**One newly introduced regression was reproduced.** The branch was tested at `6fcc633e` against its merge base `8b8a5baa`, using the same local regression tests in separate disposable source snapshots. Neither snapshot received the local production bug fixes from the regression worktree. The original `perf/round2` worktree was clean and untouched; nothing was committed or pushed.

## Confirmed regression: discovery retry skips titles

`js/jellyseerr/discovery/discovery-base.js`, `renderChunkInSlices`, lines 514–519 on the tested branch advances `renderedCount` and `hasMorePages` **before** awaiting card construction/appending. If card construction rejects, the next attempt starts after the failed chunk. The old synchronous path advances its cursor only after constructing and appending the fragment successfully.

Reproduction: six person-discovery results, chunks of two. Render `[1,2]`, inject one transient failure while building the next card, then retry. The base renders `[1,2,3,4]`; the branch renders `[1,2,5,6]`. Titles 3 and 4 are skipped. This is a recovery-path regression, not evidence that ordinary successful rendering fails. A failure in the last chunk can also leave the pagination state exhausted by the same mechanism; that variant was inspected, not separately executed.

The new [behavioral test](../../tests/frontend/regressions/perf-round2-discovery.test.mjs) executes the real discovery/filter/rendering modules and drives the scroll callback explicitly. The card factory throws once to make the failure deterministic. It passes on the base and local regression worktree, and fails on the candidate with the expected missing IDs. Evidence: `artifacts/perf-round2/{base,candidate}/discovery-recovery.txt`.

Suggested correction: update pagination only for successfully appended results, with explicit handling of partially appended slices and aborted navigation. No production correction was applied as part of this comparison.

## Results

| Check | Base | perf/round2 | Assessment |
| --- | --- | --- | --- |
| Existing backend tests, jf10 | 654 passed / 34 failed | 654 passed / 34 failed | Same 34 test identities fail; zero skipped/unexecuted. |
| Existing backend tests, jf12 | 654 passed / 34 failed | 654 passed / 34 failed | Same 34 failures; no new failure in the existing backend suite. |
| Added tag-cache checks, each target | 5 passed | 5 passed | Full-build/on-demand representative and language parity; actual MVC JSON execution, ETag/304, user isolation and access invalidation. |
| Browser component/visual tests | 39 passed | 39 passed | Chromium desktop/mobile and Firefox; unchanged visual baselines. |
| Native poster pipeline | 140 passed | 140 passed | Actual production pipeline contracts. |
| Native assets/shaping | Passed both Skia lines | Passed both Skia lines | 253 flags per line plus HarfBuzz checks. |
| Poster resolver/profile comparison and casing | Passed | Passed | 40 synthetic profiles and 31,676 casing comparisons. |
| Strict language-name oracle | 51 mismatches | Same 51 mismatches | Preexisting Baku variant aliases; runner correctly exits nonzero. |
| Real-host API/browser smoke | Not repeated in this comparison | Both 10.11.11 and 12.0 passed | 45 HTTP checks plus regular/admin Chromium login, panel save/reload, restart persistence per host. |
| New discovery retry test | Passed | Failed | Confirmed branch-introduced regression described above. |

### Frontend failures and fixture corrections

The initial 332-test frontend attempt reported **275 passed / 56 failed / one hung test** on base and **273 passed / 58 failed / the same hung test** on candidate. Each file had a 30-second process timeout; the hanging bookmark test was then isolated and independently timed out after 10 seconds on both commits. It is not a new branch failure. It must not be counted as passed or skipped.

Three apparent candidate-only failures were test-fixture defects: Episode objects contained `SeriesProviderIds` but no real `SeriesId` or parent-item response. The branch deliberately resolves the parent series, matching the actual DTO contract. Correcting those fixtures preserves the visible assertions and the no-external-TMDB-call requirement. All 32 tests in those three files then produced identical results: **31 passed and one existing release-date escaping failure** on each snapshot. The original and corrected logs are retained separately.

The branch also passes the existing modal-replacement test that fails on base; its captured closing-node change prevents an old close timer removing the successor modal. A separate diagnostic confirms another improvement: awards use a parent series TMDB ID even when the Episode has a different own ID. That diagnostic fails base and passes candidate. Its source is archived under `artifacts/perf-round2/awards-parent-namespace.mjs` rather than adding an intentionally failing test to the local suite without fixing the local production code.

The local regression worktree, which already contains its separate production fixes, passes **333 frontend tests** after the fixture corrections and discovery-test addition. This local passing result is not the result for `perf/round2`.

## Harness compatibility and scope

Production snapshots differ from their Git commits only by the test assembly's `InternalsVisibleTo` entry and lockfile support in the project file. Tests, harnesses, pinned package manifests and lockfiles were overlaid identically. `node_modules` was shared by symlink; production source was not merged from the regression worktree. Snapshot hashes and resolved commit IDs are recorded in `artifacts/perf-round2/checkouts.json`.

The minimal poster VM lacked the standard browser globals `URL` and `URLSearchParams`, newly used by the branch's navigation logic. Adding those real globals to the harness resolved the setup failure. Rerunning then exposed the same 51 real language-name mismatches as base. No assertions were weakened, snapshots regenerated, or production changes applied to obtain these results.

Full backend commands, TRX reports, per-file frontend outcomes, corrected fixtures, browser reports, host logs, screenshots and poster comparisons are retained under `artifacts/perf-round2/`. Backend runs used `-p:JellyfinTarget=jf10` and `jf12`, locked restore, separate build output paths, and a 60-second test-hang limit. Host/browser suites used the already documented isolated infrastructure. The local .NET runtime override was `PATH=/tmp/je-dotnet:$PATH DOTNET_ROOT=/tmp/je-dotnet`.

Representative commands **inside either prepared snapshot**:

```sh
dotnet test tests/backend/JE.Tests.csproj -c Release -p:JellyfinTarget=jf12
dotnet test tests/backend/JE.Tests.csproj -c Release -p:JellyfinTarget=jf10 --filter FullyQualifiedName~PerfRound2
node --test tests/frontend/regressions/perf-round2-discovery.test.mjs
npm run test:browser
python3 tests/host/run.py --target all --browser --artifacts artifacts/host
python3 tests/runner/poster.py --artifacts artifacts/poster
```

To recreate just the confirmed discovery comparison from this regression worktree (`npm ci` required), without changing either worktree:

```sh
python3 - <<'PY'
from pathlib import Path
import shutil, subprocess, tarfile, tempfile
root = Path.cwd()
for ref in ('8b8a5baa', '6fcc633e'):
    with tempfile.TemporaryDirectory(prefix='je-discovery-check-') as temp:
        work = Path(temp)
        with tempfile.TemporaryFile() as archive:
            subprocess.run(['git', 'archive', ref], stdout=archive, check=True)
            archive.seek(0)
            with tarfile.open(fileobj=archive) as tree:
                tree.extractall(work, filter='data')
        shutil.copytree(root / 'tests/frontend', work / 'tests/frontend')
        (work / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
        result = subprocess.run(['node', '--test',
            'tests/frontend/regressions/perf-round2-discovery.test.mjs'], cwd=work)
        print(ref, 'exit:', result.returncode)
PY
```

Expected: base exits 0; candidate exits 1 with the missing-chunk assertion. Temporary source snapshots are deleted after each check.

This is a behavioral comparison, not a throughput/latency benchmark or proof that all 36 changed files are regression-free. Existing coverage gaps still apply, especially native clients, complete movie-collection batch behavior, live external providers and every discovery/search state combination. The branch is not reported as green: it has inherited failures and the confirmed new recovery defect.
