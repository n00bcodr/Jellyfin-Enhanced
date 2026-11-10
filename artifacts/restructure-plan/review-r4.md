# Restructure plan: review round 4 (independent, read-only)

Scope: I read PLAN.md, the S0/INV/P1/S2 parts of backend.md, and frontend.md §0–§3/F1. I checked them against `tests/inventory/generate.py`, `.github/workflows/*`, `tests/run.py`, `tests/runner/**`, `tests/history/*` and `scripts/`. I ran no builds and changed no repo files.

## (a) Round-3 fixes: verdict
- **#1 generator (backend §4 S0): correct.** Today `generate.py:55` reads routes only when `category == 'Controllers'`. The declaration regex at L59 needs `: ControllerBase|Controller`, so it would miss `: JeControllerBase` and partials that have no base list. The new rule fixes this: route-scan any `.cs` file that declares `class \w+Controller\b`.
  - `JeControllerBase` does not match, because `Controller` is followed by `B`, so there is no `\b`.
  - Today only `CatchUpController.cs` and `JellyfinEnhancedController.cs` match, and they are the only files with `[Http*("`. That means S0 really is route-neutral.
  - If a partial has no `[Route]`, it falls back to `JellyfinEnhanced`. That is correct for every controller except Catchup. A Catchup partial would produce wrong paths, but the route-list diff would catch it.
  - Two details to keep:
    - Keep capture group 1, `((?:\[[^\n]+\]\s*)*)`, in front of the new pattern, because L58 reads `declaration[1]`.
    - Prefer a required `public\s+` over `(?:public\s+)?`. With the optional form, a non-public modifier would silently detach the class attributes. This is not a problem today, because MVC controllers must be public.
- **INV gate:** runnable. The baseline one-liner matches the JSON schema (`routes[].verb/path`) and keeps multiplicity. One weakness is noted in #4.
- **The four minor fixes:**
  - S2.8/S2.11 now say "one frontend test".
  - The bundle is written to a file, and `bundle-checkpoints.txt` is appended at each checkpoint.
  - S2 and A4 have been added to rule (b).
  - The `LoadRevisionedSettings` qualifier is now in the S2.8 brief.
  
  All four are applied and correct.

## Findings

### 1. MATERIAL: no gate runs the runner/tooling unit tests, and both S0 and P1-e edit them
- **Evidence:**
  - CI runs `python3 -m unittest discover -s tests/runner/tests` on every PR (`regression.yml:134`, `tests/run.py tooling` L84–85, part of `fast`). No BE, FE, INV or `verify:restructure` gate runs it.
  - S0 rewrites the generator self-test fixture (`test_regression.py:121-160`).
  - `test_regression.py:82` opens the real file `Jellyfin.Plugin.JellyfinEnhanced/Services/PosterTags/NativeClientPolicy.cs`, which P1-e moves.
  - If either edit is wrong or missed, every gate stays green and PR CI fails only at the end. This is the same class of problem as r3 #1.
- **Fix:** add `python3 tests/run.py tooling` (or the `unittest discover` line) to `restructure-gates.sh inv`, and so to every backend and frontend step. Also add it to the Definition of done.

### 2. MATERIAL: the mutation and history case files hard-code moved paths, and no step or gate covers them
- **Evidence:**
  - `tests/history/backend-mutations.json` names 4 files that move:
    - `Services/CdnAssetService.cs`
    - `Helpers/ArrUrlGuard.cs`
    - `Services/PosterTags/NativeClientPolicy.cs`
    - `Controllers/JellyfinEnhancedController.cs`. Its anchor `content = StripAdvancedRequestOptions(content);` moves with the Seerr step.
  - `tests/runner/mutations.py` L87/L120 default `test_file` to `tests/frontend/features/features-hidden.test.mjs`.
  - `tests/history/recent-mutations.json` names `tests/frontend/features/features-bookmarks.test.mjs`. Frontend **F1** moves both of those test files into `features/<feature>/`.
  - backend.md L561 lists only `mutations.py` CASES. Neither plan mentions `tests/history/*.json` or the default `test_file`.
  - `mutations.py` raises when an anchor doesn't match exactly once (L126). The extended CI job (`regression.yml:253-255`, `run.py mutation`/`history`) will therefore fail after the merge.
- **Fix:**
  - Add `tests/history/backend-mutations.json` to the P1 and S2 rows that move each file.
  - At F1, update `recent-mutations.json` and add an explicit `test_file` to the frontend case in `mutations.py`.
  - Add a cheap static check to `restructure-gates.sh inv`: for every case in `mutations.CASES` and `tests/history/*-mutations.json`, assert that `file` and `test_file` (or the default) exist and that `before` occurs exactly once in `file`. This needs no dotnet.

### 3. MINOR: the PR parity trigger filter will stop matching poster code
- **Evidence:** `regression.yml:215` runs offline poster parity only for paths under `Services/|Model/|Helpers/|Configuration/…`. After P1-e, PosterTags lives under `Features/MediaTags/PosterTags/`, so PRs that change poster code silently skip parity. Nothing breaks, but coverage is lost. The plan doesn't mention it.
- **Fix:** in P1-e, extend the regex with `Features/MediaTags/|Shared/|Infrastructure/`. Add `.github/workflows/regression.yml` to that row's path readers.

### 4. MINOR: the INV `--check` is tautological as written
- **Evidence:** PLAN INV and backend.md L585 regenerate first and then run `--check`, so the check can never fail. L585 also regenerates twice before calling `inv`, which regenerates again.
- **Fix:** make regeneration a step action, not part of the gate. Have `inv` run `generate.py --check` (without regenerating) on the committed or merged tree, then the route diff. In backend.md L585, call only `scripts/restructure-gates.sh inv`.

## (b) Repo-wide generators and checks
| Item | Hard-codes moved paths? | Covered? |
|---|---|---|
| `tests/inventory/generate.py` and `production-inventory.json` (CI :36) | yes | yes (S0 + INV) |
| `tests/runner/tests/test_regression.py` (CI :134) | yes (L82, fixture) | edits yes, gate **no** (#1) |
| `tests/runner/mutations.py` CASES | yes | backend yes; frontend default `test_file` **no** (#2) |
| `tests/history/*-mutations.json` (extended CI) | yes | **no** (#2) |
| `regression.yml:215` parity filter | yes | **no** (#3) |
| `tools/ClientContracts` csproj and `contracts:check` | yes (`Model/Arr/ArrInstance.cs`, `Model/AnalyticsData.cs`) | yes (P1-g, gate F) |
| `scripts/rewrite-inventory.mjs` and `migration-inventory.json` (`verify:rewrite`) | yes | yes (gate F, conflict list) |
| `scripts/generate_config_flag_groups.py`, `docs.yml` | yes | yes (P1-g, backend L562) |
| `scripts/tag-data.mjs`, `generate_technical_ratios.py`, `generate_genre_labels.py`, `build_poster_assets.py`, `gen-resolution-data.mjs` | yes | yes (P1-e/B2, gate H) |
| `scripts/generate_per_user_props.py` | yes | yes (S2.0a/S2.8) |
| `validate-translations.js`, translation workflows, `validate-manifest`, `codeql` | no (`js/` and locales only) | n/a |
| `tests/docs/coverage-matrix.md`, `docs/rewrite/*.md` | prose | yes (sweep) |

## (c) Cold-execution pass over PLAN.md
- The order, gates, baselines, rollback and Definition of done are consistent with the sub-plans.
- The baseline commands are runnable once `restructure-gates.sh` exists.
- The DoD figure of 202 snapshot routes and the 200 inventory routes are different measures, and both are compared only to themselves, so they don't conflict.
- PLAN gate **BE** lists INV, but the `restructure-gates.sh` usage line in backend.md L591 omits `inv`. PLAN's own usage line includes it, so this is cosmetic.

## Verdict
The plan is ready after #1 and #2. Both are small gate additions plus path updates in existing rows. #3 and #4 are clarifications.

MATERIAL_FINDINGS: 2
