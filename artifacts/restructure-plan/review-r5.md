# Restructure plan: review round 5 (independent, read-only)

Scope: PLAN.md, backend.md §4 (Commands, S0, P1-e/g, brief), frontend.md F1/TOOL. Checked against `tests/run.py`, `tests/inventory/generate.py`, `tests/runner/**`, `tests/history/*`, `.github/workflows/regression.yml`, `client/tsconfig.json`, all `.csproj` files, `tests/frontend/helpers/discovery.mjs` and the F1 test files. I ran only read-only commands: `generate.py --check`, an in-memory regenerate and diff, and the plan's `mutation_check` copied to the scratchpad. I changed no repo files.

## (a) Round-4 fixes: verdict
- **TOOL / `tests/run.py tooling`: correct and runnable.**
  - `run.py` merges stderr into stdout (L36), so the `^(Ran|OK|FAILED)` baseline grep sees unittest's summary.
  - It returns 1 when any suite fails (end of `main`).
  - The tooling suite needs only `node`.
- **Mutation path check: correct.**
  - I ran the plan's `mutation_check` verbatim on today's tree. It printed exactly 9 lines, all frontend `js/**` anchors that occur 0 times, which matches the plan.
  - The default `test_file` regex finds `tests/frontend/features/features-hidden.test.mjs`.
  - `comm -13 baseline -` against a fresh run printed nothing, and `sort -c` passes in en_AU.UTF-8. See #4 for a locale caveat.
- **F1 `../../../` fix:**
  - The 16 files that the given `rg` matches and the `old-form-fields.json` fixture are handled correctly.
  - The rule is not complete (#2), but every miss fails loudly.
- **regression.yml:215:** correct. The plugin paths after P1-e/P1-g are `Jellyfin.Plugin.JellyfinEnhanced/Features/MediaTags/…`, `Shared/…` and `Infrastructure/…`, which sit inside the existing `Jellyfin\.Plugin\.JellyfinEnhanced/(…)` group.
- **INV can now fail:** yes.
  - `generate.py --check` compares the regenerated text with the committed file and raises `SystemExit` on any difference (L119-128).
  - The route diff reads the committed file, which `--check` has just proved current.
  - **But it fails on the base today** (#1).

## Findings

### 1. MATERIAL: INV fails on the untouched base, and the "200 routes" figure is already wrong, so step 1 is blocked
- **Evidence:**
  - `python3 tests/inventory/generate.py --check` on today's tree prints `Inventory is stale` (rc=1). `tests/docs/production-inventory.json` is one of the 656 uncommitted changes, so the prerequisite `git add -A` commits it while still stale.
  - Regenerating in memory gives **202 routes against 200 committed**. The new routes include `/JellyfinEnhanced/user-settings/{userId}/bookmark-document`. Five new files are also missing from the committed inventory, among them `Features/Bookmarks/BookmarkDocumentService.cs` and `Transport/BookmarkDocument.cs`.
  - PLAN step 1 says INV "must pass on the untouched base before S0 edits anything", so it can't pass. backend.md S0 says the regenerated route list "(200 today: 197 + 3 CatchUp) must be identical", but it will be 202.
  - An agent therefore either stops, or regenerates ad hoc inside S0 and records a baseline it was told must equal 200.
  - Secondary effect: `docs/advanced/api.md` contains no `bookmark-document`, so `features-api-routes-docs.test.mjs` may fail on the base once the inventory is current. If it does, the npm baseline starts red.
- **Fix:**
  - Add a base-prep commit to the Prerequisite, after the snapshot commit and **before** `git tag restructure-base`:
    - `python3 tests/inventory/generate.py && git commit -am "chore: regenerate production inventory (pre-existing drift)"`
  - In the same commit, document any route that `features-api-routes-docs.test.mjs` reports as undocumented in `docs/advanced/api.md`. The tag goes on that commit.
  - Replace "200 today: 197 + 3 CatchUp" with "the count recorded in `baselines/inventory-routes.txt` at step 1 (202 on 2026-11-08)".
  - State that this regeneration is base preparation, not "fixing a gate by regenerating".

### 2. MINOR: F1's relative-path rule misses several forms (all fail loudly)
- **Evidence:** the given `rg` (`new URL\('\.\./\.\./\.\./|join\(here, '`) and the `'../helpers/`/`'../contracts/` rewrites do not cover:
  - `new URL('../../fixtures/…')` reads of `tests/fixtures`, in 8 moved files: quality-display, status-tags-leaving, custom-tags, source-edition-tags, technical-quality, quality-detection-truth, series-quality-aggregation, and `core-tag-layout.test.mjs:1299`.
  - `new URL('../../docs/production-inventory.json')` in `features-api-routes-docs.test.mjs:10`.
  - The static `import … from '../../../scripts/tag-translation-coverage.mjs'` in `features-tag-translation-coverage.test.mjs:5`.
  - A blanket `'../` rewrite would also corrupt test data: `'../etc/passwd'` in logo-tags:60, `'a/../b'` in awards-tags:78, and `'../../user-settings/…'` in details-providers-rewrite:86/89, which is asserted against an encoded string.
  - Every miss throws ENOENT or a module-not-found error, so `npm test` catches it.
- **Fix:**
  - Find candidates with `rg -n "(new URL\(|from |import\(|join\(here, )'\.\./" tests/frontend/features tests/frontend/core/core-tag-*`.
  - Add one `../` only to specifiers that resolve files. Leave literal test data alone.
  - `${jsRoot}`/`resolve(jsRoot, …)` reads are root-anchored and need no change.

### 3. MINOR: TOOL can trip in behaviour-changing frontend steps, and the plan doesn't say whether updating an anchor is allowed
- **Evidence:**
  - The live frontend anchors target generated `js/**`, for example `requests-page-render-cards.js` and `helpers.js`. B3, B4, C2 and C3 legitimately change that output.
  - The PLAN says "never fix a gate by … relaxing a test". An agent whose refactor stops an anchor matching gets a loud TOOL failure and no guidance.
- **Fix:** add a line to the TOOL row: "If a B3/B4/C2/C3 output change makes a live anchor stop matching, update that case's `before`/`after` in place to the equivalent new text in the same commit. Never add the line to `baselines/mutation-check.txt`."

### 4. MINOR: the `comm` comparison depends on the locale
- **Evidence:**
  - The Python script sorts by code point, while `comm` uses the shell's collation.
  - It is consistent today in en_AU.UTF-8 (verified).
  - Under another locale, a step could report spurious "new" lines or print `comm: file 2 is not in sorted order`. This fails loudly; it never passes silently.
- **Fix:** write the baseline and run the gate with `LC_ALL=C`, for example `mutation_check | LC_ALL=C sort > …` and `… | LC_ALL=C sort | LC_ALL=C comm -13 baseline -`.

## (b) Different lens: paths and build items that moves could break
| Item | Finding |
|---|---|
| `client/tsconfig.json` | `include: ["src/**/*.ts"]`, `rootDir: src`, no `paths`/`baseUrl`. Moves inside `client/src` are safe; broken relative imports fail `client:check` and the build. |
| Frontend test discovery | `helpers/discovery.mjs` walks folders recursively, so the F1 subfolders are found. The F1 count gate catches any drop. |
| Plugin `.csproj` | Default `Compile` glob, so moved `.cs` files are still compiled. Every `EmbeddedResource` is under `Assets/` or `Configuration/` (not `.cs`, not moved; R12). No `None` items depend on moved paths. |
| `InternalsVisibleTo` (JE.Tests, PosterTagsHarness, PosterTagsPipelineHarness) | Keyed by assembly name, so moves don't affect it. |
| `JE.Tests.csproj` | Embeds `../fixtures/*` by `LogicalName`; unaffected. |
| `ClientContracts.csproj` `Compile Include` | Hard-coded paths (`Model/Arr/ArrInstance.cs`, `Model/AnalyticsData.cs`). Covered by P1-g; `contracts:check` (gate F) fails loudly. |
| Poster harness csprojs | `ProjectReference` to the plugin, so file paths don't matter. Namespaces are covered by gate H. |
| jf10/jf12 switch | Both projects reject any non-`jf12` target (`ValidateJellyfinTarget`) and define only `JF12`. No target-conditional file items exist, so there is nothing to break. |
| Docs links | `docs/rewrite/*.md` and test comments mention paths in prose only. `docs.yml` runs `mkdocs build` without `--strict`, so nothing machine-checks these links. The Z/step-12 sweep covers them. Only `migration-inventory.json` is checked, and it is regenerated. |
| `test_regression.py:82` | Calls `read_bytes()` on the real file, so a missed P1-e update fails loudly, not vacuously. |

Nothing in this lens can break silently.

## (c) Cold-execution judgement
The order, gates, rollback and Definition of done are consistent, and the scripts and commands the plan names exist and behave as described. An implementation agent would stop at **step 1**, because INV can't pass on the base (#1). With the base-prep commit and the corrected route count, PLAN.md can be executed from start to finish. #2–#4 are one-line clarifications whose failures are loud.

MATERIAL_FINDINGS: 1
