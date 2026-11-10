# Restructure plan: review round 3 (independent, read-only)

Scope: PLAN.md first, then backend.md and frontend.md, checked against the working tree. CHANGELOG, r1 and r2 were used as context only. No builds were run and no repo files were changed.

## (a) Round-2 fixes: verdict
- **DI gate (multiset + per-ServiceType order):** correct and implementable. Verified in `PluginServiceRegistrator.cs`: the 3× `IEventConsumer<PlaybackStartEventArgs>` (L131/133/165), 3× UserDeleted (L167/169/172), 2× UserUpdated (L168/171), 2× `IStartupFilter` (L33–34) and 5 hosted services (L95 factory, L130, L134, L176, L180). Computing "multi-registered" from the collection covers all of them. No new hole: `GetService` last-wins for a duplicated type is covered by (b), and the MVC filter order is covered by the resolved `MvcOptions.Filters` check.
- **EventConsumerRegistration.cs:** correct. `FeatureBoundaryTests` only checks `Features.<A>` → `Features.<B>` (§7.2), so an Infrastructure file that references `MediaTags`/`DetailsProviders` consumer types is allowed. It is also consistent with the P1-g split of `UserTopologyEvents.cs`.
- **HOST bundle rules a/b:** sound. `ClientScriptBundle` is deterministic (manifest-resource reads only, no time or version stamping), so rule (a) is meaningful. BROWSER is required on B3/B4/C2/C3 in PLAN and in each frontend brief. Minor gaps are in #3 and #4.
- **S2.0a / CreateSettingsDefaults:** correct. L5618–5736 reads only `JellyfinEnhanced.Instance` and static `*.ApplyDefaults`. Its only caller is `LoadRevisionedSettings` at L5739. The duplicate anchors at L8930/L9036 exist, so the not-found guard is justified. The test at L230–231 resolves `jsRoot + '../Controllers/…'`, so the repoint target `../Features/Settings/Services/SettingsDefaults.cs` is right. `generate_per_user_props.py` uses `str.index` (it raises). Gate B follows calls transitively into `JeControllerBase`, so the move is invisible to it.

## Findings

### 1. MATERIAL: the route inventory only reads `Controllers/`, and no gate runs its check
- **Location:** `tests/inventory/generate.py:55`; PLAN gates **BE**/**FE**; backend §4 gate F; PLAN "Conflicts in generated files"; Definition of done.
- **Evidence:** `generate.py` extracts routes only `if category == 'Controllers'` (the first path segment under the plugin). Today it lists 200 routes: 197 from `Controllers/JellyfinEnhancedController.cs` and 3 from `CatchUpController.cs`. `tests/docs/production-inventory.json` also lists every file path and category, and every scheduled-task file. `.github/workflows/regression.yml:34-36` and `tests/run.py fast` run `generate.py --check`. `features-api-routes-docs.test.mjs` (part of gate F through `test:frontend`) asserts that `docs/advanced/api.md` matches the inventory routes one-to-one. None of the BE/FE gates or `verify:restructure` runs `generate.py --check`.
- **Failure:**
  - From P1 onward every move makes the checked-in inventory stale. All gates stay green, and the regression CI fails at the end.
  - If an agent regenerates it (P1-g lists `tests/inventory/generate.py, tests/docs/*`), then from S2.1 onward every moved route disappears from `routes`. `features-api-routes-docs` then fails with "rows without a route". The agent is blocked, or "fixes" it by deleting api.md rows, which is the exact gate-relaxing the plan forbids.
  - The P1 steps also all touch the same generated JSON, which contradicts "conflict-free".
- **Fix:**
  - **Generator (S0 or step 1):** change route extraction to every `.cs` file that declares a class deriving from `ControllerBase`/`Controller` (the regex at L56–57 already finds them), not only those under `Controllers/`. Keep `JeControllerBase` contributing no routes, because it has no `[Http*]` attributes. Regenerate once on the base. The route set must be unchanged (200), and only that is allowed to change at this point.
  - **Generator self-test:** update the `test_regression.py:121-160` fixture, which builds a fake `Controllers/Feature.cs`. Add a fixture under `Features/X/`.
  - **Gates:** add `python3 tests/inventory/generate.py --check` to gate F, or to `restructure-gates.sh be` and `fe`. Every move step regenerates the inventory. Add a check that the inventory's `(verb, path)` route set equals the step-1 set, and save that set as `baselines/inventory-routes.txt`.
  - **Conflicts:** add `tests/docs/production-inventory.json` to PLAN's "Conflicts in generated files" list (resolve by re-running `generate.py`).
  - **Definition of done:** add "`generate.py --check` passes, with the route set equal to the baseline".

### 2. MINOR: stale S2.8 and S2.11 notes contradict S2.0a
- **Location:** backend §4 rows S2.8 and S2.11, and the §8 brief "S2.8 must repoint … two frontend tests".
- **Evidence:** S2.0a already repoints `features-admin-tags-page-overview-layout.test.mjs` to `Features/Settings/Services/SettingsDefaults.cs`, and that file's path doesn't change later. S2.8 still lists the test under "point them at the new files". S2.11 still lists it as "if the sliced block moves".
- **Fix:** in S2.8, name only `generate_per_user_props.py` and `features-admin-config-schema.test.mjs` (its `reset-all-users-settings`/`BuildHcDefaultSettings` anchors move then). Remove the overview-layout entry from S2.11. In the brief, say "one frontend test".

### 3. MINOR: there is no stored reference for the previous checkpoint's bundle, and the `bundle` output format is undefined
- **Location:** PLAN "HOST bundle check (b)" and the step-1 baseline command.
- **Evidence:** Only the step-1 sha256 is recorded. Rule (b) compares against the *previous* checkpoint, and the merge message records only which rule applied. `restructure-gates.sh bundle | sha256sum` hashes stdout. If the subcommand runs a TestServer through `dotnet test`, build and test output lands in the hash.
- **Fix:**
  - Have `bundle` write the raw bytes to a file given as an argument, for example `bundle out.js`, and print nothing else.
  - Record `sha256(bundle)` plus the comment-stripped hash in every HOST checkpoint's tag message, or append them to `baselines/bundle-checkpoints.txt`.

### 4. MINOR: rule (b) has no case for non-move frontend steps that should not change output
- **Location:** PLAN "HOST bundle check (b)", span step 1 → step 5.
- **Evidence:** That span contains frontend **S2** (adds README and types-only `public-api.ts` plus a test), which is not a "pure move". Step 6 contains **A4** (type-only). An agent can't tell which bullet applies to S2.
- **Fix:** extend the second bullet: "every frontend step is a pure move **or a types-only/doc-only step (S2, A4)** that passed check O".

### 5. MINOR: the verbatim `LoadRevisionedSettings` breaks at S2.8 (fails loudly)
- **Location:** S2.0a/S2.8. The current body is `new Services.SettingsDocumentService(_userConfigurationManager)` (L5739).
- **Evidence:** It works from `…Infrastructure.Http` only because `Jellyfin.Plugin.JellyfinEnhanced.Services` still exists. S2.8 moves `SettingsDocumentService` to `Features.Settings…`, and the build then fails. Gate B catches it, so nothing breaks silently.
- **Fix:** in the S2.8 row, add "update the `Services.` qualifier in `JeControllerBase.LoadRevisionedSettings` (and in `JellyfinEnhanced.cs:399` `Controllers.JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange` at S2.15)".

## (b) Cold-execution spot-checks (all confirmed unless noted)
1. Event-consumer lines and counts, hosted-service count, and the L95 factory registration: confirmed.
2. `CreateSettingsDefaults` L5618–5736, its single caller L5739, and no `User` access: confirmed.
3. Duplicate anchor pair at L8930/L9036: confirmed.
4. `features-admin-config-schema.test.mjs:73-76` slices a..b and c..d with `indexOf`: confirmed.
5. Poster harnesses use `ProjectReference`/namespaces, not compile-by-path: confirmed.
6. No embedded resources live in the retired folders (`Services/`, `Helpers/`, `Model/`, `ScheduledTasks/`, `EventHandlers/`, `Controllers/`). All `EmbeddedResource` items are under `Assets/`, `PluginPages/`, `Configuration/` and `js/`, so the moves can't break `GetManifestResourceStream`: confirmed.
7. `ClientScriptBundle` is deterministic: confirmed.
8. Readers of the controller path are `generate_per_user_props.py` and the 2 frontend tests, plus `tests/inventory/generate.py`, **which the plan misses as a route source (#1)**.

## (c) Consistency
Step IDs, gate names (BE/FE/BROWSER/HOST, B/G/T/F/R/H, check O), feature names (media-tags/MediaTags, admin-tags folded in) and the links between PLAN and the sub-plans agree. F1's dependency on "S2.11 = last backend step editing frontend test text" holds once #2 is fixed. The only contradictions are the stale rows in #2.

## Verdict
Ready to execute after #1 is fixed. That fix is a small S0 change to the inventory generator plus one added gate command. The rest are minor clarifications.

MATERIAL_FINDINGS: 1
