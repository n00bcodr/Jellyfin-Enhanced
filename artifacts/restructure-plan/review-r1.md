# Review r1: backend.md + frontend.md restructure plans

Read-only review against the working tree at `2e0f9251` with 656 uncommitted changes (`git status --short | wc -l` = 656). Nothing was built or edited except this file.

**Verdict:** Both plans are well evidenced and mostly correct. The gates are a sound idea and mostly implementable. Four material problems must be fixed before any agent starts: the backend still creates `Features/AdminTags`; two `IsAdminUser()` helpers can't be moved as planned without breaking Gate B; there is no combined step order even though both plans edit the same files; and nothing checks the client in a real browser or on a real Jellyfin 12 host until the very end.

## Spot-checked claims (≥10)

| # | Claim | Plan | Result | Evidence |
|---|---|---|---|---|
| 1 | Controller is 13,988 lines with 199 routes | BE §1 | ✅ | `wc -l` = 13988; `grep -cE '^\s*\[Http(Get\|Post\|…)'` = 199 |
| 2 | 198 action methods, 12 anonymous routes (list) | BE §1 | ✅ | A script over the attribute blocks gives 198 methods and 12 without `[Authorize]`, matching the plan's list exactly |
| 3 | "192 `[Authorize]` on JellyfinEnhancedController" | BE §3 | ❌ | 186 real attributes (`grep -cE '^\s*\[Authorize'`). The other 6 grep hits are comments (L1799, 3822, 4282, 4849, 5492…). 186 + 12 = 198 ✓ |
| 4 | `IsAdminUser` L5494, `AuthorizeUserConfigAccess` L5443, `AuthorizeUserAccess` L5468, `GetCurrentUserId` L11570 | BE §3 | ✅ | grep -n |
| 5 | `IsAdminUser()` "called 79 times" | BE §3 | ≈ | 79 is the raw text-hit count, which includes the definition and comments. Real calls: 64 in 59 actions plus 9 in 5 private helpers (see F2) |
| 6 | Registrator has 226 lines; startup filters at L33–34; NativeStatus singleton and hosted service at L94–95; MVC filter block at L210–222 | BE §2 | ✅ | `sed -n` |
| 7 | `typeof(JellyfinEnhancedController).Assembly` appears at "3 test sites" | BE §4 S0 | ❌ | 6 sites: ApiRoutingTests:51, ElsewhereDocumentTests:88, ApiItemLookMutationTests:91,182, ApiAssetTests:133,137 (the last two are resource streams) |
| 8 | `ApiRoutingTests.AssetActivator` (L22–30) always returns the old controller | BE §3 | ✅ | `tests/backend/Api/ApiRoutingTests.cs:22-30` |
| 9 | ClientContracts compiles Model/Arr/ArrInstance.cs and Model/AnalyticsData.cs by path | BE §3 | ✅ | `ClientContracts.csproj`. Program.cs:135 filters only on the `Jellyfin.Plugin.JellyfinEnhanced` namespace prefix, so the S2 namespace changes are safe |
| 10 | `gen-resolution-data.mjs --check` (L8), path at L20, namespace at L260 | BE §3/§4 | ✅ | `sed -n` |
| 11 | "25 hand-maintained manifests under client/entries/*.json" | FE §0 | ❌ | 24 `.json` files (plus README.md) |
| 12 | component-scripts.json has 245 entries | FE §0 | ✅ | python len = 245 |
| 13 | migration-inventory.json has 220 client/src paths | FE §0 | ✅ | `grep -c` = 220 |
| 14 | client-build.mjs rejects non-`.ts` inputs at :198-203 and orphans at :279 | FE §0 | ✅ | `sed -n 195,205p`, `275,282p` |
| 15 | `tag-data.mjs:7` hard-codes `media-tags/rules`; test discovery is recursive | FE §0.1/§2.4 | ✅ | `discovery.mjs:9-18` |
| 16 | tag-pipeline.ts has 2567 lines with `createTagPipeline` at :37; tag-layout.ts has 2241; ui-panel-hidden-content.ts has 114 | FE §1 | ✅ | `wc -l`, grep |
| 17 | admin-tags has "15 files" + 18 sections | FE §1a | ❌ | 14 `*.ts` files (the plan's own name list has 14) + 18 sections ✓ |
| 18 | The npm scripts used in the gates exist | both | ✅ | All 13 scripts (`client:*`, `inventory:*`, `test*`, `contracts:check`, `test:contract-boundary`, `verify:rewrite`, `test:browser`, `test:visual`) are in package.json |
| 19 | Directory.Build.targets runs `client-build.mjs --check` | BE §4 | ✅ | `Directory.Build.targets:10` |
| 20 | Test path readers: docs-links:14-15, awards-tags:71, runtime-generators:14 | FE §0.1 | ✅, one missed | `tests/client-build/tag-data.test.mjs:12` also hard-codes `client/src/features/media-tags/rules` and is not listed (F10) |

## Findings

### 1. MATERIAL: the backend creates `Features/AdminTags`, but the frontend folds admin-tags into media-tags
**Plans:** backend §1 (Counts row "AdminTags", #### AdminTags), §2 Features list and file map (`Helpers/MediaTagsPageFields.cs → Features/AdminTags/Services/`), §4 P1-f and S2.4, §7.2 allow-list `AdminTags→MediaTags`; frontend §1, A3, §4 "Backend name drift".
**Evidence:** The frontend's A3 deletes `client/src/features/admin-tags`. The backend §7.4 parity test ("Feature folder = PascalCase of client/src/features/<kebab>") would then fail against a backend `Features/AdminTags`, so the two plans as written can't both pass S3.
**Fix:** In the backend, drop AdminTags. Its 7 routes (`tag-styles/catalog`, `tag-cache/rebuild|summary`, `admin/leaving-soon[/refresh]`, `admin/media-tags/export|preview`) go into `Features/MediaTags/JeMediaTagsController.Admin.cs`, a partial, which §7.5 allows. `MediaTagsPageFields.cs` goes to `Features/MediaTags/Admin/`. Merge S2.4 into S2.11, or run it as S2.11a just before S2.11, and resolve `PreviewBody` inside MediaTags. Delete the `AdminTags→MediaTags` allow-list edge.

### 2. MATERIAL: two helpers that call `IsAdminUser()` can't move "verbatim" to services, and Gate B breaks when they do
**Plan:** backend §4 S2.8 (`LoadRevisionedSettings → Features/Settings/Services/SettingsDocumentService`), S2.11 (`CreateReviewVisibilityContext → Shared/Reviews/`), §3 Gate B ("follow calls one level deep into private methods of the same type").
**Evidence:** `JellyfinEnhancedController.cs:5738-5739` `LoadRevisionedSettings(...) => new SettingsDocumentService(...).Read(userId, CreateSettingsDefaults, IsAdminUser());` and `:8301 CreateReviewVisibilityContext` both call `IsAdminUser()`, which is a controller member that reads `User`. `CreateReviewVisibilityContext` is used by DetailsProviders (:8390, :8473) and MediaTags (`GetTagCache`, :9598). Non-action helpers that call `IsAdminUser()` (from a script): `ProxyJellyseerrRequest` (5 calls), `LoadRevisionedSettings`, `CreateReviewVisibilityContext`, `ValidateArrService`, `GetAllowedRequestsForCurrentUserAsync`. Once a helper becomes a service method, the admin check has to move to the call site, and Gate B's per-action counts change: actions gain a direct `IsAdminUser` call and lose the attributed nested one. The brief forbids regenerating the snapshot, so the agent is stuck, or it changes the admin semantics to get green.
**Fix:** Keep every helper that calls `IsAdminUser()`/`User` in a controller. Put `CreateReviewVisibilityContext` on `JeControllerBase` as a protected method (it's shared by two features), and keep `LoadRevisionedSettings` as a private method of `JeSettingsController`. Gate B then stays identical by construction. Make Gate B attribute calls transitively through same-assembly *controller and base* methods only, and fail if any `Features/**/Services` type references `ControllerBase.User` or `IsAdminUser`.

### 3. MATERIAL: no combined order, although the plans edit the same files
**Plans:** backend §4 Phase 1 ("conflict-free … merge in any order") and S2.8; frontend §3 B2 and F1.
**Evidence:**
- Both backend P1-e and frontend B2 edit `scripts/tag-data.mjs`, `scripts/generate_technical_ratios.py`, `scripts/build_poster_assets.py`, `tests/client-build/tag-data.test.mjs` and `tests/frontend/features/features-tag-runtime-generators.test.mjs`.
- Backend P1-f, S2.8 and S2.11 edit `features-admin-config-schema.test.mjs`, `features-admin-tags-page-overview-layout.test.mjs`, `admin-tags-rewrite.test.mjs`, `helpers/admin-tags-declarations.mjs`, `features-admin-tags-page-server.test.mjs` and `core-tag-pipeline.test.mjs`. Frontend A3 and F1 edit or rename the same tests.
- Backend P1-f's destination depends on the A3 naming decision (F1).

Each plan's "parallel-safe" claim holds only within that plan.
**Fix: combined order (each row merges to one integration branch before the next starts, unless marked ∥):**
0. The owner commits the 656 changes and tags `restructure-base`. Run backend S0 ∥ frontend S0+S1 (disjoint: `tests/backend/Architecture` vs `tests/frontend/architecture`). Record test counts on both sides.
1. Frontend A1→A3: this fixes the media-tags naming.
2. Backend P1-a…g (∥ among themselves). P1-e runs **before** frontend B2. Then frontend B1→B2, rebased on P1-e.
3. Backend S2.0→S2.15 (sequential) ∥ frontend A4, B3/B4, C1→C3, D1/D2 (disjoint source trees). Exception: no frontend step may touch the backend-path-reading tests listed above while S2.8/S2.11 are open.
4. Frontend F1 (test mirror), after backend S2.11, the last step that edits frontend test text.
5. Backend S3 ∥ frontend C4/E1, then a single cross-repo parity test (F11), then frontend Z.

### 4. MATERIAL: nothing verifies in a real browser or on Jellyfin 12 until the end, and the client splits are not covered
**Plans:** frontend §3 B3/B4 (`npm run test:browser` "if Playwright browsers are installed [UNVERIFIED]"), D2 (`test:visual` [UNVERIFIED]); backend §4 (one smoke test after S2.15 only).
**Evidence:** Playwright browsers are installed (`~/.cache/ms-playwright/chromium-1208`), and `dotnet` is at `~/.local/bin/dotnet`, so both "unverified" conditions hold on this machine. B3 turns the `let` state of a 2,567-line closure into a `PipelineState` object, which is a behaviour-bearing change: check O is disabled, and the tests exercise only the built outputs they happen to load. The backend's DI and route problems from 16 sequential steps would surface only once, at the end, where they are expensive to bisect.
**Fix:** Make `npm run test:browser` mandatory for B3, B4, C2–C3 and D2. Add a real-host smoke test, using the `jellyfin-enhanced` skill's disposable JF12 container and cleaning it up afterwards, at these points: after backend S2.0, after every ~4 Phase 2 steps, after S2.15, and after frontend B3/B4. Each run loads the plugin, compares `GET /JellyfinEnhanced/bundle.js` byte-for-byte with `client/generated-manifest.json` (expect identical for move-only steps), opens the admin page, the Media Tags hub and a poster with tags, checks the scheduled tasks are listed by name, and checks that `/api-docs/openapi.json` returns 200. Pin the jf12 image digest in the brief.

### 5. MINOR: the ServiceRegistration snapshot can't see MVC filter order
**Plan:** backend §2 DI and §6 R6 ("ServiceRegistrationSnapshot compares the order").
**Evidence:** The filter order lives inside the `Configure<MvcOptions>(o => …)` lambda (`PluginServiceRegistrator.cs:210-222`). A `(ServiceType, ImplementationType, Lifetime)` list sees only one `IConfigureOptions<MvcOptions>` instance. The `AddHostedService(sp => …)` registration at :95 has a null `ImplementationType`. A wrong filter order could draw poster tags under the spoiler blur, so this matters.
**Fix:** In the snapshot test, also resolve `IOptions<MvcOptions>` from the built provider and snapshot `Filters.OfType<ServiceFilterType>().Select(f => f.ServiceType.Name)` in order. For factory registrations, record `"factory"`.

### 6. MINOR: Gate A can't see a missing `[ApiController]` or a change in binding source
**Plan:** backend §3 Gate A, S2 brief.
**Evidence:** Attribute routing works without `[ApiController]`, so the snapshot stays green. Without it, complex parameters lose `[FromBody]` inference and the automatic 400 response, a silent change in request shape. Example: `SaveRevisionedSettings(string userId, [FromBody] …)` is explicit, but other actions may rely on inference.
**Fix:** Add to each snapshot entry `apiBehavior = metadata.Any<IApiBehaviorMetadata>()` plus `parameters: [name:BindingSource.Id]` from `ControllerActionDescriptor.Parameters` and `ApiDescription`.

### 7. MINOR: Gate B's matching rule contradicts itself
**Plan:** backend §3 Gate B: "matched by **method name + declaring-type name**, so the move into `JeControllerBase` is invisible".
**Evidence:** S2.0 changes the declaring type from `JellyfinEnhancedController` to `JeControllerBase`, so matching on the declaring type makes the move visible. An agent following the text literally gets a diff and may regenerate the snapshot.
**Fix:** Match on the method name, with the declaring type in `{any type deriving from ControllerBase in the plugin assembly}` ∪ `{UserHelper, RequestIdentityService}`.

### 8. MINOR: the frontend gate's output-key check is a no-op
**Plan:** frontend §3 gate G: `git diff -- client/entries | grep '^[-+] *"js/' | grep -v '"client/src'`.
**Evidence:** Every mapping line is `"js/…": "client/src/…"` (e.g. `client/entries/hidden-content.json:2`), so `grep -v '"client/src'` removes every line and a renamed key prints nothing. The orphan check in the build (`client-build.mjs:279`) and bootstrap-manifest still catch most renames, so the impact is low.
**Fix:** `for f in client/entries/*.json; do diff <(git show restructure-base:$f | jq -S keys) <(jq -S keys $f) || exit 1; done`

### 9. MINOR: factual counts to correct (no impact on the steps)
- Backend: `[Authorize]` count is 186, not 192. `typeof(JellyfinEnhancedController)` appears at 6 test sites, not 3, and the S0 brief should list all 6; the ApiAssetTests ones are resource-stream lookups that S2.15 breaks. `IsAdminUser` has 73 real calls, not 79. "client/src/{…,shared}" should read `client/src/features/shared`.
- Frontend: 24 entry manifests, not 25. 14 admin-tags files, not 15.

### 10. MINOR: the frontend's B2 path-reader list misses `tests/client-build/tag-data.test.mjs:12`
**Evidence:** `const typed = 'client/src/features/media-tags/rules';`. `test:client-build` would catch it, but the brief should name it so the agent doesn't have to debug it.
**Fix:** Add it to §0.1 and to the B2 brief.

### 11. MINOR: naming parity is not defined in one place
**Plans:** frontend header ("settings-panel → SettingsPanel"), backend §2 ("settings-panel served by Settings"), backend §7.4.
**Evidence:** The frontend implies `Features/SettingsPanel`; the backend says there is none. Frontend `features/shared` (helpers, translations, themer) means something different from backend top-level `Shared/` (Arr, Library). Frontend S2 writes READMEs for "all 16 features", including admin-tags, before A3 deletes it.
**Fix:** One combined canonical table, below, checked in as `docs/feature-map.json`. Both parity tests, both README tests and the CONTRIBUTING table read it. Move frontend S2 after A3.

| Feature | Backend `Features/` | Client | Notes |
|---|---|---|---|
| Activity | Activity | features/activity | |
| Bookmarks | Bookmarks | features/bookmarks | |
| Calendar | Calendar | features/calendar | |
| Catchup | Catchup | features/catchup | |
| Chrome | Chrome | features/chrome | branding |
| DetailsProviders | DetailsProviders | features/details-providers | |
| Downloads | Downloads | features/downloads | |
| HiddenContent | HiddenContent | features/hidden-content | + settings/ from settings-panel |
| MediaTags | MediaTags (incl. `.Admin` partial and `Admin/` services) | features/media-tags (incl. admin/, settings/) | admin-tags folded in on both sides |
| Seerr | Seerr | features/seerr | |
| Settings | Settings | features/settings + features/settings-panel (shell) | no backend SettingsPanel |
| SpoilerGuard | SpoilerGuard | features/spoiler-guard | |
| Player | — | features/player | client-only |
| Admin | Admin | admin/config | backend-only feature name |
| Platform | Platform | bootstrap, core, host, pages, features/shared | backend `Shared/`, `Infrastructure/` are layers, not features |

### 12. MINOR: rollback and docs are thin
**Evidence:** Neither plan says how to undo a step that passed its gates but fails on the real host. The frontend plan has no CONTRIBUTING, skill or docs update (the backend's S3 covers only backend paths). The `jellyfin-enhanced` skill and `client/entries/README.md` describe the current paths.
**Fix:** One commit per step, plus a `restructure/<step>` tag. Rollback is `git revert` of that commit, then regenerate (`npm run client:build && npm run inventory:rewrite`). Move the CONTRIBUTING "where things live" table and the skill-notes update into the combined final step, generated from `docs/feature-map.json`.

### 13. MINOR: value vs cost
- **Frontend C3** (convert ~4,000 `JE.` accesses to `FeatureContext` across every feature) is high-churn and type-level only. Most of the benefit comes from rules 3 and 4 (owner-only `internals`, no raw global) and peer facades for the ~17 stateful members. Limit C3 to those and leave injected core members (`t`, `currentSettings`, …) on the existing typed bridge.
- **Frontend D1/D2** (CSS out of TS) touches the build pipeline for low agent-maintenance value. Do them last and treat them as optional.
- **Backend S2.0** bundles the base class, Seerr static caches and about 10 helper extractions into one commit. Split it into S2.0a (base class only, plus Gates A and B unchanged) and S2.0b (helper extractions), so a Gate B diff points at a single cause.
- **Missing, high value:** the shared `docs/feature-map.json` (F11) and a combined `npm run verify:restructure` that runs both plans' gates. Agents then need one command and one map.

MATERIAL_FINDINGS: 4
