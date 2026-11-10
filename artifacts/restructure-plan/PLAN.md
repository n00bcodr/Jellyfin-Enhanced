# JE v12 restructure: implementation entry point

Read this first. Details, evidence and the agent briefs are in [backend.md](backend.md) (C# feature split) and [frontend.md](frontend.md) (client/src reorganisation). Review history: [review-r1.md](review-r1.md), [review-r2.md](review-r2.md), [review-r3.md](review-r3.md), [CHANGELOG.md](CHANGELOG.md). If a sub-plan disagrees with this file about **order, feature names or gates**, this file wins.

## Prerequisite (blocking)
The working tree has ~656 uncommitted rewrite changes. Neither plan may start until their owner commits them:
```bash
git switch -c restructure/base && git add -A && git commit -m "wip: v12 rewrite snapshot before restructure"
# Base prep (review-r5 #1): the committed inventory is already stale (200 vs 202 routes; bookmark-document missing).
python3 tests/inventory/generate.py && python3 tests/inventory/generate.py --check
node --test tests/frontend/features/features-api-routes-docs.test.mjs   # fails until docs/advanced/api.md gets the 2 bookmark-document rows AND both route totals (L7 "covers the 200" and "enumerate all 200") change to 202 (review-r6 #2)
git add -A && git commit -m "chore: regenerate production inventory and document routes (pre-existing drift)"
git tag restructure-base
git branch restructure/integration restructure-base
```
This regeneration is base preparation of pre-existing drift, not "fixing a gate by regenerating". Every step branches from `restructure/integration` and merges back into it. Nothing goes to the default branch until the Definition of done holds.

## Canonical feature list
One map for both sides. The final step checks it in as `docs/feature-map.json`; both parity tests, both README tests and the CONTRIBUTING table read that file. **admin-tags is folded into media-tags on both sides.**

| Feature (client name) | Client path | Backend `Features/` | Notes |
|---|---|---|---|
| activity | features/activity | Activity | |
| bookmarks | features/bookmarks | Bookmarks | |
| calendar | features/calendar | Calendar | |
| catchup | features/catchup | Catchup | |
| chrome | features/chrome | Chrome | branding, active streams |
| details-providers | features/details-providers | DetailsProviders | |
| downloads | features/downloads | Downloads | |
| hidden-content | features/hidden-content (+ settings/) | HiddenContent | |
| media-tags | features/media-tags (+ admin/, settings/) | MediaTags (+ `JeMediaTagsController.Admin.cs`, `Admin/`) | was admin-tags / AdminTags |
| player | features/player | — | client-only |
| seerr | features/seerr | Seerr | |
| settings | features/settings | Settings | |
| settings-panel | features/settings-panel (shell) | — (served by Settings) | |
| spoiler-guard | features/spoiler-guard | SpoilerGuard | |
| shared | features/shared | — (part of Platform) | not the backend `Shared/` layer |
| *admin* | admin/config | Admin | not under features/ |
| *platform* | bootstrap, core, host, pages, features/shared | Platform | backend `Shared/`, `Infrastructure/` are layers, not features |

## Worktrees and parallelism
- One git worktree per step: `git worktree add ../je-rs-<step> -b restructure/<step> restructure/integration`. Run `npm ci` and the two `dotnet restore` commands ([backend.md §4](backend.md#4-migration-order)) once per worktree.
- **∥** = may run at the same time in separate worktrees. **→** = strictly sequential. Merge into `restructure/integration` one step at a time with `git merge --no-ff`, re-run that step's gates on the merged result (`scripts/restructure-gates.sh all` runs `be` and `fe` in one pass, with one frontend-suite run), then tag `restructure/<step>-done` (not `restructure/<step>`: that is the step's branch name, and git treats a tag and a branch of the same name as ambiguous).
- Conflicts in generated files (`client/generated-manifest.json`, `js/**`, `docs/rewrite/migration-inventory.json`, `tests/docs/production-inventory.json`, snapshots excluded): take either side, then `npm run client:build && npm run inventory:rewrite && python3 tests/inventory/generate.py`. Snapshot files never conflict-resolve by regeneration.
- 16 GB worker: at most **2 worktrees building/testing dotnet at once**. Extra lanes may run on Alex's laptop (authorised in AGENTS.md).
- Cross-plan file overlap (review-r1 F3): backend P1-e ↔ frontend B2 (tag-data.mjs, generators, tag-data/runtime-generators tests); backend P1-f/S2.8/S2.11 ↔ frontend A3/F1 (admin-tags and core-tag-pipeline tests). The order below sequences them. **While backend S2.8 or S2.11 is open, no frontend step may edit those test files.**

## Step order
| # | Step | Runs | Plan reference |
|---|---|---|---|
| 1 | Gates and baselines: backend **S0** ∥ frontend **S0 → S1**. **First, before any file moves:** backend S0 makes `tests/inventory/generate.py` find routes outside `Controllers/` (review-r3 #1, [backend.md §4 S0](backend.md#phase-0-gates-sequential)) and regenerates `tests/docs/production-inventory.json` with an unchanged route set. Add `scripts/restructure-gates.sh be\|fe\|r <pattern>\|h\|inv\|tool\|bundle <out.js>` (wraps each gate in a `set -e` subshell; non-zero exit on failure). Record the baselines below (gates **INV** and **TOOL** must pass on the untouched base before S0 edits anything, and again after S0), then run **HOST** once. | ∥ | [BE §3, §4 Phase 0](backend.md#3-keeping-authorization-identical); [FE §3](frontend.md#3-migration-steps) |
| 2 | Frontend **A0 → A1 → A2 → A3** (A0 makes the moves' cross-feature edges legal first; A1–A3 fix the media-tags naming) | → | [FE §1a, §3](frontend.md#1a-file-move-table-settings-panel--admin-tags-finding-a) |
| 3 | Backend **P1-a, b, c, e, f, g** (P1-d folded into P1-g) ∥ frontend **S2** (READMEs / public-api stubs) | ∥ | [BE §4 Phase 1](backend.md#4-migration-order); [FE §3](frontend.md#3-migration-steps) |
| 4 | Frontend **B1 → B2** (B2 based on a tree containing P1-e) | → | [FE §1b, §3](frontend.md#1b-file-move-table-media-tags-finding-b) |
| 5 | Backend **S2.0a → S2.0b**; then **HOST** | → | [BE §3 Shared base, §4 Phase 2](backend.md#shared-base-phase-2-step-2) |
| 6 | Backend **S2.1 → S2.2 → S2.3 → S2.5** ∥ frontend **A4**, **B3 ∥ B4**; then **BROWSER** + **HOST** | ∥ between tracks | [BE §4](backend.md#4-migration-order); [FE step detail](frontend.md#step-detail-and-verification) |
| 7 | Backend **S2.6 → S2.7 → S2.8 → S2.9** ∥ frontend **C1 → C2**; then **HOST** | ∥ between tracks | same |
| 8 | Backend **S2.10 → S2.11 → S2.12 → S2.13** ∥ frontend **C3-<feature>** (∥ per feature); then **HOST** | ∥ between tracks | [BE §4](backend.md#4-migration-order); [FE §2.3](frontend.md#23-target-featurecontextown-peers) |
| 9 | Backend **S2.14 → S2.15**; then full **HOST** smoke | → | [BE §4 Phase 2, smoke test](backend.md#4-migration-order) |
| 10 | Frontend **F1** (test mirror; needs backend S2.11 merged) | → | [FE §3 F1](frontend.md#step-detail-and-verification) |
| 11 | Backend **S3** ∥ frontend **C4**, **E1** | ∥ | [BE §7](backend.md#7-guardrails-against-regrowth-enforced-in-s3-report-only-from-s0); [FE §5](frontend.md#5-guardrails-against-regrowth-all-in-testsfrontendarchitecture-auto-discovered) |
| 12 | Final: add `docs/feature-map.json` + both parity tests reading it; add `npm run verify:restructure` (calls `scripts/restructure-gates.sh` for every gate below except HOST); CONTRIBUTING "where things live" table, `jellyfin-enhanced` skill notes, `client/entries/README.md` and `bug-ledger.json` path sweep; frontend **Z**; final **HOST** | → | [FE §3 Z](frontend.md#3-migration-steps); [BE §7.4, §7.6](backend.md#7-guardrails-against-regrowth-enforced-in-s3-report-only-from-s0) |
| 13 | Optional, only if time remains: frontend **A5**, **D1 → D2** (BROWSER mandatory, then HOST) | → | [FE §3 D1/D2](frontend.md#step-detail-and-verification) |

12 required steps plus 1 optional.

**Baselines (step 1)**, committed on `restructure/integration` under `artifacts/restructure-plan/baselines/` (review-r2 F10):
```bash
dotnet test tests/backend/JE.Tests.csproj -c Release -p:JellyfinTarget=jf12 --logger "trx;LogFileName=je.trx" --results-directory /tmp/je-trx | grep -E '^(Passed|Failed|Total)' > baselines/dotnet-tests.txt
trx_results /tmp/je-trx/je.trx | sed -n 's/^FAIL //p' | LC_ALL=C sort -u > baselines/dotnet-failures.txt   # trx_results: function in restructure-gates.sh
npm test 2>&1 | grep -E '^ℹ (tests|pass) ' > baselines/npm-tests.txt   # node's spec reporter prints `ℹ tests N`, not `# tests`
node tests/frontend/run.mjs --test-reporter=./scripts/restructure-gates-reporter.mjs --test-reporter-destination=/tmp/je-npm.txt
sed -n 's/^FAIL //p' /tmp/je-npm.txt | LC_ALL=C sort -u > baselines/npm-failures.txt
dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release -p:JellyfinTarget=jf12 --no-incremental -tl:off | build_warnings > baselines/build-warnings.txt   # `<code> <repo-relative file>`, sorted, unique
echo "jellyfin/jellyfin:12.4 $(docker image inspect --format '{{index .RepoDigests 0}}' jellyfin/jellyfin:12.4)" > baselines/jf12-digest.txt   # `<tag for je up --image> <RepoDigest>`
scripts/restructure-gates.sh bundle /tmp/je-bundle.js   # writes raw bundle bytes to the file, prints nothing else (review-r3 #3)
echo "step1 $(scripts/restructure-gates.sh bundle-hash /tmp/je-bundle.js)" > baselines/bundle-checkpoints.txt   # `<step> <stable sha256> <comment-stripped sha256>`
# right after the Prerequisite base-prep (inventory is current there; review-r6 #3): the (verb, path) route list, kept with multiplicity. S0 diffs against this file and never re-saves it
python3 -c "import json;[print(r['verb'],r['path']) for r in sorted(json.load(open('tests/docs/production-inventory.json'))['routes'],key=lambda r:(r['path'],r['verb']))]" > baselines/inventory-routes.txt
# runner/tooling unit tests (CI: regression.yml:134; review-r4 #1) and the mutation/history path check (review-r4 #2), both before and after S0
python3 tests/run.py tooling 2>&1 | grep -E '^(Ran|OK|FAILED)' > baselines/tooling-tests.txt
mutation_check | LC_ALL=C sort > baselines/mutation-check.txt   # function from backend.md §4; 9 pre-existing stale frontend anchors today
scripts/restructure-gates.sh tool
```

## Gates
| Gate | When | What |
|---|---|---|
| **BE** | every backend step | B (no new `<code> <file>` build warning vs `baselines/build-warnings.txt`), G, T, F, R, **INV**, **TOOL** (+H when MediaTags/PosterTags namespaces move), [backend.md §4](backend.md#4-migration-order). Route/auth, auth-helper and registration snapshots unchanged (registration = sorted multiset + per-ServiceType order for every multi-registered type, so feature grouping is allowed but consumer/filter/hosted-service order is not; [backend.md §2 DI](backend.md#di-registration-pluginserviceregistratorcs-226-lines)); `JE_UPDATE_SNAPSHOTS` never set. |
| **FE** | every frontend step | Gate G (+ check O for pure moves), **INV** and **TOOL**, [frontend.md §3](frontend.md#3-migration-steps). `component-scripts.json` and all `client/entries` output keys unchanged. |
| **INV** | every backend and frontend step, from S0 on (review-r3 #1) | Regenerating is a **step action, not part of the gate** (review-r4 #4): a step that moves or edits controller files runs `python3 tests/inventory/generate.py` and commits `tests/docs/production-inventory.json` with its changes. The gate `scripts/restructure-gates.sh inv` regenerates nothing. It runs on the committed (or merged) tree: `python3 tests/inventory/generate.py --check` (the exact command CI runs: `.github/workflows/regression.yml:36`, `tests/run.py:82`; it fails if the committed inventory is stale), then the route-list command from the baselines block piped to `diff - artifacts/restructure-plan/baselines/inventory-routes.txt`. File paths in the inventory may change; the route list may not. |
| **TOOL** | every backend and frontend step, and the baseline (review-r4 #1, #2). Mandatory in effect for S0, P1-c, P1-e, P1-g, S2.14 and F1, which edit `tests/runner/**`, `tests/history/*.json` or files they name; it is cheap (no dotnet), so it runs everywhere | `scripts/restructure-gates.sh tool` = (1) `python3 tests/run.py tooling` (= `python3 -m unittest discover -s tests/runner/tests -v`, what CI runs at `regression.yml:134`); (2) the mutation path check in [backend.md §4 Commands](backend.md#commands-from-the-repo-run-inside-the-steps-worktree): for every case in `tests/runner/mutations.py` `CASES` and every `tests/history/*-mutations.json`, `file`, `test_file` (or the `mutations.py` default) must exist and `before` must occur exactly once in `file`. 9 frontend anchors already fail on the current tree (pre-existing, from the uncommitted rewrite), so the gate fails on any failure line **not in** `baselines/mutation-check.txt`. If a B3/B4/C2/C3 output change makes a live anchor stop matching, update that case's `before`/`after` in place to the equivalent new text in the same commit; never add the line to `baselines/mutation-check.txt` (review-r5 #3). |
| **BROWSER** | FE B3, B4, C2, C3, D2 and step 6 | `scripts/restructure-gates.sh browser` = `npm run test:browser` (Playwright is installed on the worker; 6 workers via `JE_BROWSER_WORKERS`) with a failure ratchet: 52 tests already fail on the base and are identical before and after step 6 ([step6-frontend.md](step-logs/step6-frontend.md)), recorded in `baselines/browser-failures.txt` (coordinator decision, step 7; records existing state only). The gate fails on any failing test not in that list, printed by name; a listed test that passes prints a note and is then removed from the list. Never add a line. |
| **HOST** | steps 1, 5, 6, 7, 8, 9, 12 | Disposable JF12 container via the `jellyfin-enhanced` skill, removed afterwards. Image pinned: `baselines/jf12-digest.txt` is `<tag> <RepoDigest>` (`jellyfin/jellyfin:12.4`, `sha256:b45218a4…`); first run `scripts/restructure-gates.sh image` (fails if that tag's current RepoDigest differs), then `je up <name> <port> --image jellyfin/jellyfin:12.4`. Always pass `--image`: without it `je up` picks the newest local 12.x tag. (`jellyfin/jellyfin:12`, which `tests/host/run.py` pulls, is a different image, `fea863d0…`.) Plugin loads with no errors; bundle check below; the admin page, Media Tags hub and a poster with tags render; JE scheduled tasks are listed under their original names; `/api-docs/openapi.json` returns 200. |

**HOST bundle check** (review-r2 F2). Steps 6–8 contain behaviour-preserving code changes (B3, B4, C2, C3), so the bundle legitimately changes there. Compare bundles with `scripts/restructure-gates.sh bundle-hash <file>`, which prints two hashes: **stable** = sha256 without the bundle's last line `//# sourceMappingURL=bundle.js.map?v=<version>-<DLL mtime ticks>` (it changes on every plugin rebuild; the per-module `//# sourceMappingURL=<module>.js.map` lines stay), and **comment-stripped** = sha256 without that line and every line matching `^\s*// client/src/` (763 indented source comments at step 1). Below, "byte-identical" means identical stable hashes. Two rules:
- **(a) Packaging, always:** the stable hash of the served `GET /JellyfinEnhanced/bundle.js` equals the stable hash of the in-process bundle from `scripts/restructure-gates.sh bundle` on the same commit (a TestServer GET, as in `Api/ApiRoutingTests.cs`; added in step 1).
- **(b) No unexpected drift**, against the previous HOST checkpoint's bundle:
  - Span has no frontend steps: identical stable hash.
  - Every frontend step in the span is a pure move that passed check O, **or a types-only/doc-only step (S2, A4)** (review-r3 #4): identical comment-stripped hash.
  - Span contains **B3, B4, C2 or C3** (steps 6–8): the bundle is expected to differ, so instead (1) each of those steps passed BROWSER on its merged result, and (2) every backend merge `M` in the span leaves the bundle inputs alone: `git diff --quiet M^1 M -- Jellyfin.Plugin.JellyfinEnhanced/js client`, and any `ClientScriptBundle.cs` change is namespace/`using` lines only.
Record which rule applied in the checkpoint's merge or tag message, and append `<step> $(scripts/restructure-gates.sh bundle-hash <out.js>)` (= `<step> <stable sha256> <comment-stripped sha256>` of the `restructure-gates.sh bundle <out.js>` dump) to `baselines/bundle-checkpoints.txt` at every HOST checkpoint; rule (b) compares against the previous line (review-r3 #3).

**Failure ratchet** (step 1 base prep). 10 tests already fail on the base and are not fixed by this plan: 1 dotnet (`baselines/dotnet-failures.txt`) and 9 `npm test` (`baselines/npm-failures.txt`). So T (and the dotnet part of `verify:rewrite`) and `npm test` / `npm run test:frontend` (the same suite) pass when (i) every failing test is in its baseline list, (ii) the total is ≥ the baseline total and (iii) the passed count is ≥ the baseline passed count (`baselines/{dotnet,npm}-tests.txt`). A new failure fails the gate and is printed by name; a listed test that passes prints a note and is then removed from the list. Never add a line to a failure list. `restructure-gates.sh be` runs `verify:rewrite`'s parts itself (it stops at the first pre-existing failure). Gate B: a step that moves a file named in `baselines/build-warnings.txt` updates that path in the same commit (path only; never a new code or file).

A failing gate blocks the merge. Never fix a gate by regenerating a snapshot or relaxing a test inside a refactor step.

## Rollback
- Each step is one `--no-ff` merge tagged `restructure/<step>-done`. Undo: `git revert -m 1 <merge>`, then `npm run client:build && npm run inventory:rewrite`; if that changes anything, `git commit -am "regen after revert of <step>"`. Then re-run that step's gates.
- Later steps that depend on the reverted one (the "Depends on" columns in the sub-plans; all backend Phase 2 steps depend on their predecessor) are reverted first, newest first.
- HOST failure: bisect with the `restructure/<step>-done` tags between the last passing checkpoint and now, then revert the culprit as above.
- Abandon everything: `git worktree list`; in the worktree that has `restructure/integration` checked out run `git reset --hard restructure-base` (or `git worktree remove` it first, then `git branch -f restructure/integration restructure-base`). The base commit and the default branch are never touched.

## Definition of done
- [ ] `Controllers/JellyfinEnhancedController.cs` and the legacy backend folders (`Services/`, `Helpers/`, `Model/`, `ScheduledTasks/`, `EventHandlers/`, `Controllers/`) are gone; `client/src/features/admin-tags` is gone; no `Features/AdminTags`.
- [ ] Route/auth snapshot (202 routes, 12 anonymous), auth-helper snapshot and registration snapshot (multiset, per-type order, MVC filter order) are identical to step 1.
- [ ] Backend and frontend test counts are ≥ `baselines/{dotnet,npm}-tests.txt`; no test deleted without a replacement.
- [ ] `component-scripts.json` and every `client/entries` output key are unchanged; `npm run client:check` and `inventory:rewrite:check` pass.
- [ ] `python3 tests/inventory/generate.py --check` passes and the inventory route list equals `baselines/inventory-routes.txt`.
- [ ] `python3 tests/run.py tooling` passes with a test count ≥ `baselines/tooling-tests.txt`, and `scripts/restructure-gates.sh tool` passes (every mutation/history path resolves, and no anchor fails that wasn't already in `baselines/mutation-check.txt`).
- [ ] Guardrails enforce on both sides: feature boundaries, file size, folder = namespace, generated markers, and feature-map parity against `docs/feature-map.json`.
- [ ] `npm run verify:restructure`, BROWSER and the final HOST pass on `restructure/integration`.
- [ ] CONTRIBUTING, the `jellyfin-enhanced` skill notes and `client/entries/README.md` describe the new paths.
- [ ] All task-owned containers and worktrees are removed.
