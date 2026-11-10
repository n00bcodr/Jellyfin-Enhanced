# Restructure plan: independent review, round 2

Scope: PLAN.md (entry point) plus backend.md and frontend.md, checked against the working tree (read-only). The round-1 items that CHANGELOG marks as applied are not raised again unless the fix itself is wrong.

## Verdict
The combined order, the dependencies and the rollback mostly hold. The round-1 fixes for F1 (the MediaTags partial controller, no `Features/AdminTags`), F2 (`LoadRevisionedSettings` and `CreateReviewVisibilityContext` on the base class) and F3 (the combined order) match the code. **PLAN.md is not ready to run cold yet.** Three gates or steps would either block an agent or let a regression through. All three need small text fixes. Findings 4–11 are minor fixes that remove places where an agent would get stuck.

## Spot checks (not covered in round 1)
| # | Claim | Result | Evidence |
|---|---|---|---|
| 1 | `LoadRevisionedSettings` (L5738) reads `IsAdminUser()` and needs `CreateSettingsDefaults` | ✅ | L5738–5739: `new Services.SettingsDocumentService(_userConfigurationManager).Read(userId, CreateSettingsDefaults, IsAdminUser())` |
| 2 | `CreateReviewVisibilityContext` (L8301) is used by DetailsProviders and MediaTags | ✅ | callers L8390, L8473 (reviews), L9598 (`GetTagCache`); the body uses `GetCurrentUserId`, `IsAdminUser`, `_logger` |
| 3 | The Platform bootstrap calls `LoadRevisionedSettings` | ✅ | L4322 |
| 4 | The S2.0b extractions read no `User` or `IsAdminUser` | ✅ | `ResolveUserDisplay` (`_userManager` only), `WarnIfArrInstancesCorrupt`, `FindLibraryItemByTmdb`, `TryParseIso` and `GetRootFolderFromPath` contain no auth or `User` tokens |
| 5 | Helpers that move into services in S2.6/S2.9/S2.10/S2.13 read no `User` | ✅ / ❌ | `BuildActiveSessionList`, `LoadUserHiddenContentDocument`, `AddSpoilerBlurPendingInternal` and `GetJellyseerrUser` are clean. **`ParentalBlockedResult` (L763) calls `ControllerBase.StatusCode`** (F4) |
| 6 | The per-user-props generator anchors move in S2.8 | ✅ | `reset-all-users-settings` L8914 (Settings in §1) and `BuildHcDefaultSettings` L6322 both move in S2.8 |
| 7 | The overview-layout scraper anchors are untouched until S2.8/S2.11 | ❌ | Its anchors are at L5622/L5730 **inside `CreateSettingsDefaults`**, which moves in S2.0a (F3) |
| 8 | Phase-1 moves change no compiled output (no path-based `<Compile>`) | ✅ | The csproj files contain only `EmbeddedResource`/`None` items for assets, html and js, and Phase 1 moves none of them |
| 9 | CatchUpController: 3 routes, all `[Authorize]` | ✅ | 3 `[Http*]`; class route is `JellyfinEnhanced/catchup` (F9) |
| 10 | `GET /JellyfinEnhanced/bundle.js` exists for HOST | ✅ | L4468 |
| 11 | DI order matters in only the three listed places | ❌ | Registrations are interleaved across features (F1) |
| 12 | `Features/Bookmarks` and `Infrastructure/Persistence` already exist | ✅ | untracked, as backend §2 says |
| 13 | Step dependencies in the PLAN.md order | ✅ | P1-f after A3 (2→3), B2 after P1-e (3→4), frontend S2 after A3, C1 after A3+B1, F1 after S2.11 (step 10). The overlap between the step 8 lanes and the S2.11 test files is guarded |

## Findings

### 1. MATERIAL: the in-order registration snapshot can't stay identical when features are grouped, and order-sensitive multi-registrations are missing from the list
- **Location:** backend.md §2 "DI registration" (L471–478), Phase 2 per-step item 5, and PLAN.md gate BE ("registration snapshot unchanged").
- **Evidence:** `PluginServiceRegistrator.cs` interleaves features:
  - Seerr at L56–63, L102 and L118–120.
  - MediaTags at L68–69, L77–78, L91–98, L112–117 and L195+.
  - DetailsProviders at L83–86 and L121.
  - There are three `IEventConsumer<PlaybackStartEventArgs>` registrations from different features (L131, L133, L165), and 12 `IScheduledTask`s (L110–121) from 4 features.

  Step 5 says to replace a feature's lines with `AddJe<F>()` "at the position of the first moved line". That necessarily reorders lines. The gate snapshots the full list "in order", so the first non-contiguous feature (S2.3 onward) fails G. The agent can't proceed without regenerating the snapshot, which is forbidden. If the gate is loosened, the relative order of the event consumers can change unnoticed, and their execution order is real behaviour.
- **Fix:**
  - Redefine the snapshot as (a) the multiset of `(ServiceType, Impl|factory, Lifetime)` entries, and (b) the **per-ServiceType order** for every service type that is registered more than once (`IStartupFilter`, `IEventConsumer<…>`, `IScheduledTask`, `IHostedService`, and so on), plus the MVC filter order already covered.
  - List the playback event consumers as a fourth order-sensitive place. Either keep them in one ordered `Infrastructure/Hosting/EventConsumerRegistration.cs` (like the MVC filter block), or require that the `AddJe*` call order preserves their per-type order.

### 2. MATERIAL: the HOST bundle check fails by design at steps 6, 7 and 8
- **Location:** PLAN.md gate HOST ("identical after stripping `// client/src/` comment lines") and step order rows 6–8.
- **Evidence:** Steps 6–8 merge frontend B3/B4 (splits; frontend.md says "Check O does **not** apply, because code order inside the bundle changes"), C2 and C3 (code conversions to `FeatureContext`). After any of these, the bundle differs by more than comment lines, so HOST fails every time. The agent then either stops or "fixes" the gate, which PLAN.md forbids.
- **Fix:** Split the bundle check:
  - (a) Always: the served `bundle.js` is byte-identical to the `js/` output of `npm run client:build` on the same commit. This proves packaging.
  - (b) Byte-identical to the previous checkpoint (modulo comment lines) **only when the span since that checkpoint contains just backend steps or frontend steps that passed check O**.
  - Spans that contain B3, B4, C2 or C3 rely on BROWSER plus the HOST UI smoke. Record which rule applied in the step's merge message.

### 3. MATERIAL: S2.0a moves `CreateSettingsDefaults`, which silently retargets a text-scraping test, and the brief leaves the decision to the agent
- **Location:** backend.md S2.0a row (L625) and brief (L736: "with `CreateSettingsDefaults` L5618 *if it has no other controller-only dependency*"); the scraper list (L553) assigns this reader only to S2.8 and S2.11.
- **Evidence:** `tests/frontend/features/features-admin-tags-page-overview-layout.test.mjs:230-231` slices `JellyfinEnhancedController.cs` from the first `var defaultUserSettings = new JellyfinEnhancedUserSettings` (L5622, inside `CreateSettingsDefaults`) to the first `TagLayoutRules.ApplyDefaults(defaultUserSettings` (L5730). A duplicate pair exists in `ResetAllUsersSettings` (L8930/L9036). Once S2.0a moves the method out, `indexOf` finds the duplicate. The test keeps passing but checks different code, so the gate goes green on lost coverage. Putting a roughly 110-line Settings defaults builder into `Infrastructure` also defeats the feature-ownership goal.
- **Fix:**
  - In S2.0a, move `CreateSettingsDefaults` verbatim to a static `Features/Settings/Services/SettingsDefaults.Create()`. It reads only `JellyfinEnhanced.Instance` and `TagLayoutRules`, and no `User`; confirm that, and stop if it does read `User`.
  - Have `JeControllerBase.LoadRevisionedSettings` call it.
  - In the same step, repoint test L230 to the new file and add `assert.ok(start >= 0 && end > start)` plus a minimum `copied.length`.
  - Add the same not-found guard to `features-admin-config-schema.test.mjs:73-76` and `generate_per_user_props.py` (Python's `index` already raises).
  - Remove the "if it has no other dependency" condition from the brief.

### 4. MINOR: `ParentalBlockedResult` can't move into a service verbatim
- **Location:** backend.md S2.10 row.
- **Evidence:** L763–771 is `return StatusCode(403, new { error = true, code = "parental_block", … })`, which is a `ControllerBase` member. It has 7 call sites across Seerr and Downloads.
- **Fix:** Put it on `JeControllerBase` as `protected`, or make it a static `SeerrResults.ParentalBlocked()` that returns `new ObjectResult(...) { StatusCode = 403 }`. Say which one in the row.

### 5. MINOR: the base-class sketch doesn't match the "verbatim bodies" rule
- **Location:** backend.md §3 "Shared base" sketch.
- **Evidence:** The moved bodies use `_userManager` (`IsAdminUser`), `_logger` (`CreateReviewVisibilityContext`) and `_userConfigurationManager` (`LoadRevisionedSettings`). The sketch exposes a `UserManager` property and a one-parameter constructor. The controller keeps `private readonly IUserManager _userManager` (L56, 32 uses). Adding a base member with the same name raises CS0108, which breaks the "warning-neutral" B gate.
- **Fix:** Spell out the base as `protected JeControllerBase(IUserManager userManager, Logger logger, UserConfigurationManager ucm)` with `protected readonly` fields of the **same names**, and say that the derived controller deletes its own copies of those fields.

### 6. MINOR: two promised tests are never scheduled
- **Location:** backend.md §3 (L532, `ServicesDoNotReadUserTests`) and §6 R5 (controller-activation test); the S0 row (L593) and brief (L732) list neither.
- **Fix:** Add both to S0. The activation test resolves every controller type in the plugin assembly with `ActivatorUtilities`. Add both to the Gate G filter (`FullyQualifiedName~Architecture` already matches them if they are placed in `Architecture/`).

### 7. MINOR: two gate commands are no-ops or kill the shell
- **Location:** frontend.md gate G and backend.md gate R.
- **Evidence:** `git diff --stat -- …/component-scripts.json` compares against the index, so it is always empty after a commit or when gates re-run on a merge. The `|| exit 1` in G and the `&& exit 1` in R exit the agent's interactive shell.
- **Fix:**
  - Use `git diff --exit-code restructure-base -- Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json`.
  - Put G, R and the other gates in `scripts/restructure-gates.sh {be|fe|r <pattern>}`, added in step 1, so every gate is one command with a non-zero exit status. `verify:restructure` in step 12 can then call it.

### 8. MINOR: the Phase-1 "renames only" check contradicts P1-g
- **Location:** backend.md Phase 1 check (L607) vs the P1-g row (it splits `UserTopologyEvents.cs` into 3 files, with P1-d's split folded in).
- **Fix:** Exempt that split. Check it instead by confirming the three files' type bodies concatenate to the original's bodies (diff after stripping `using`s and namespace lines).

### 9. MINOR: the S2.1 Catchup route prefix conflicts with the generic brief
- **Location:** backend.md L740 says every new controller declares `[Route("JellyfinEnhanced")]`; `CatchUpController` has `[Route("JellyfinEnhanced/catchup")]`.
- **Fix:** In the S2.1 row, say "rename the class only; keep the class-level route exactly". Gate A would catch the change, but the agent shouldn't have to recover from it.

### 10. MINOR: baselines have no location or command
- **Location:** PLAN.md step 1 ("record both test counts and the jf12 image digest", the HOST baseline).
- **Fix:** Name the files, for example `artifacts/restructure-plan/baselines/{dotnet-tests.txt,npm-tests.txt,jf12-digest.txt,bundle.js.sha256}`, committed on `restructure/integration`. Give the commands:
  - `dotnet test … | grep -E '^(Passed|Failed|Total)'`
  - `npm test 2>&1 | grep -E '^# (tests|pass)'`
  - `docker image inspect --format '{{index .RepoDigests 0}}' <jf12 image>`

### 11. MINOR: rollback mechanics
- **Location:** PLAN.md Rollback.
- **Evidence:**
  - `git branch -f restructure/integration restructure-base` is refused while that branch is checked out in a worktree.
  - After `git revert -m 1`, the regenerated outputs from `client:build`/`inventory:rewrite` are left uncommitted.
- **Fix:**
  - Abandon: `git worktree list`, then remove the worktree holding `restructure/integration` (or `git -C <wt> reset --hard restructure-base`), then move the branch.
  - Revert: add `git commit -am "regen after revert of <step>"` when the regeneration changes anything.

MATERIAL_FINDINGS: 3
