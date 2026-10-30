# Phase 4a — Status Tags vocabulary completion report

Worktree: `/home/jake/je-wt/tl-status`; branch: `feat/tag-layouts-status`; base: `12b7381`. Only `je-lab-tlstatus` at `http://127.0.0.1:18524` was used. No push, PR, stash or child agents.

## Commits

All commits use Jake <45441845+4eh5xitv6787h645ebv@users.noreply.github.com>.

| Commit | Subject |
|---|---|
| `2de6959b` | feat(tags): add schedule milestone and series status preferences |
| `dbfd0c30` | feat(tags): serve access filtered episode milestones and TMDB schedules |
| `9474d945` | feat(tags): expand status badge priorities and compact labels |
| `8d04226e` | feat(tags): expose badge group controls in both settings panels |
| `e76a48f7` | fix(tags): preserve status lookup bounds and aggregate validity |
| `9ccf1031` | test(tags): cover status vocabulary schedules and filtered cache facts |

The final documentation/evidence commit contains this report; its hash is included in the handoff response and `git log -1`.

## Implementation

- Added Schedule/Milestones defaults on and Series Status default off, wired through user/admin configuration, public-config, seeding, reset, client defaults, both settings panels and generated analytics labels/defaults. Sibling trending settings have no separate hand-maintained analytics/What's New registry entries; discovery remains automatic.
- Expanded the first-match vocabulary and priority per card type. Added localized Tomorrow/weekday/short dates, full/compact labels, schedule/milestone/status CSS modifiers and `data-je-status`.
- Schema 12 includes Jellyfin Status, latest aired episode/date/index, newest season's episode-one air date, season added span/count and episode index/last flag. Full builds reuse episode placements rather than adding one sibling query per episode; on-demand/fallback lookups use the relevant season.
- Episode aggregates track all contributors. Shared entries are cloned and aggregates omitted when contributors are outside a user's access, using the existing access digest/filterRevision path. Contributor IDs are retained on disk and excluded from client JSON. Spoiler Guard strips episode/season air-date/index facts while retaining added-date facts.
- Added authenticated, caller-filtered `GET /JellyfinEnhanced/status-tags/series?ids=…`, capped at 50 IDs. TMDB title and season enrichment share the six-hour response cache, four lookup slots and a 35-start/10-second window. Slots remain occupied until shared upstream work completes after caller cancellation. No user-specific TMDB storage.
- The client batches visible series/parent-series IDs, caches for an hour, retries failures after five minutes, guards cache replacement, dashed/compact ID equivalence, user changes and recycled cards. IndexedDB copies from older entry schemas are discarded.
- Critically corrected inherited choices: earliest available episode was not necessarily episode one; future episodes must not count as aired; hidden middle episodes contribute to aggregate counts; a TMDB fallback finale needs local season-boundary confirmation; arbitrary two-day/minimum-two-episode constraints were removed from Complete Season.

## Verification

| Check | Result | Evidence |
|---|---|---|
| `node tests/frontend/run.mjs` | **659 passed, 0 failed/skipped** | `.notes/frontend.log` |
| `dotnet test tests/backend -p:JellyfinTarget=jf12 --artifacts-path /tmp/tlstatus-backend` | **927 passed, 0 failed/skipped** | `.notes/backend.log` |
| jf12 Release build, `/tmp/je-build-tlstatus-jf12` | **0 warnings, 0 errors** | `.notes/build-jf12.log` |
| jf10 Release build, `/tmp/je-build-tlstatus-jf10` | **0 warnings, 0 errors** | `.notes/build-jf10.log` |
| `node tests/poster/parity/run.mjs --offline` | **40 profiles × 101 entries; 0 differences** | `.notes/parity.log` |
| `node scripts/validate-translations.js validate en` | Passed (validator skips base-language comparison) | `.notes/translations.log` |
| `python3 scripts/generate_config_flag_groups.py` | Regenerated, including readable localized-control labels | `docs/advanced/config-flag-groups.json` |
| `python3 tests/inventory/generate.py --check` | Current | `tests/docs/production-inventory.json` |
| `python3 tests/inventory/test_status_flag_labels.py` | **1 passed** | New translated-control registry regression |
| `git diff --check` | Passed | Final scoped diff |
| Final deployed route, unsigned request | **401** | Live API check |
| Final deployed route, 51 IDs | **400** | Live API check |
| Final deployed route, malformed ID | **200 `{}`** | Live API check |
| `real-viewer`, Status Tags off | **0 badges** | `.notes/browser-viewer-off.log` |

Backend test compilation emits two existing ASP.NET deprecation warnings in `tests/backend/Api/ApiRoutingTests.cs` (ASPDEPR004 and ASPDEPR008). These are separate from both plugin Release builds, which each have zero warnings.

The final assembly was deployed using the provided deploy script. A full lab cache rebuild populated the final schema-12 facts, including 4,174 episode indexes across 4,845 entries. All 89 accessible lab series returned TMDB facts. The configured TMDB key was checked without printing it; it was temporarily cleared for a Seerr fallback attempt and restored in a `finally` block. The lab retains 365-day added/release windows and the administrator's enabled badge preferences for review. Screenshots that change windows or density do so only in their browser context.

## Screenshots

All paths below are relative to `/home/jake/je-wt/tl-status/.notes/shots/phase4a/`. Desktop is 1400 px wide; mobile is 420 px wide. `browser-<name>.log` files alongside this report record console output and badge observations. Evidence lists visible badges separately from hidden DOM observations.

| File | What it shows |
|---|---|
| `home-desktop.png` | New Movie, Just Added, New Season, Series Finale, Complete Season (lower row partly below fold) |
| `home-mobile.png` | New Movie, New Season, Series Finale on the home rows |
| `shows-desktop.png` | Shows grid with Just Added and New Season |
| `shows-mobile.png` | Same Shows grid at 420 px, Just Added/New Season |
| `schedule-rank-desktop.png` | Airs Wednesday, Airs Sunday, #21 Today, Series Finale, New Season, New Series, Just Added |
| `vocabulary-desktop.png` | New Season, Series Finale, Complete Season, Just Added on the recently added Shows row; source of the replacement documentation WebP |
| `series-desktop.png` | Silo detail page: New Episode in Next Up and Complete Season on season posters |
| `series-mobile.png` | Complete Season on vertically arranged season posters at 420 px |
| `season-premiere-desktop.png` | Season Premiere on Silo season 3, with added window reduced to one day in this browser context |
| `season-finale-desktop.png` | Season Finale on Silo season 3, with added window 1 / release window 90 in this browser context |
| `season-finale-compact-mobile.png` | The same season card with compact “Finale” at 420 px |
| `series-status-desktop.png` | Ended, Returning and Cancelled, with higher-priority groups disabled in this browser context |
| `personal-controls.png` | All six personal badge-group switches and translated labels |
| `admin-controls.png` | Admin badge-group defaults and descriptions, with Series Status off by default |
| `viewer-off.png` | Viewer home page; Status Tags disabled and no badges |
| `weekly-rank-desktop.png` | Negative Seerr fallback capture: library date badges remained; no weekly rank was provoked |
| `episodes-desktop.png`, `episodes-mobile.png` | Episode-list capture attempts. DOM has Season Premiere/New Episode, but missing thumbnail files leave Jellyfin's image wrappers at opacity 0, so these are **not** visual badge evidence |
| `finale-desktop.png`, `finale-mobile.png` | Episode-list finale capture attempts with the same missing-thumbnail limitation; DOM reports New Episode/Season Finale |
| `episodes-compact-desktop.png` | Compact episode DOM labels (Premiere/New Ep), with the same invisible-thumbnail limitation; not visual evidence |

Inherited `home-1400.png`, `home-420.png` and `shows-420.png` were retained and are not used as current verification evidence. PNGs and raw lab logs remain local review artifacts; the replacement `docs/images/tags/status-tags.webp` is committed.

## Documentation touched

- `docs/enhanced/tags.md`: full badge/source/priority tables, all toggles, TMDB dependency, date and compact formatting, schema/access fields, styling hooks and endpoint.
- `docs/enhanced/enhanced-settings.md`: personal badge-group controls and admin defaults/windows.
- `docs/advanced/api.md`: endpoint auth/cap/filtering, response, cache fields, schema and fallback details.
- `docs/advanced/project-structure.md`: updated status renderer and server/cache responsibility map.
- `docs/advanced/config-flag-groups.json`: regenerated defaults/groups and translated admin-control labels.
- `docs/images/tags/status-tags.webp`: replaced with a current multi-badge lab screenshot.

## Limits and unverified items

- **Airing Today, Returns {date}, Coming Soon and #N This Week were not provoked in the lab.** None of its TMDB next-air dates is today or qualifies for the return-gap/30-day rule; its cached movies/series have no future premiere; clearing the key did not produce a weekly rank. These rules are covered by frontend/service tests. Airs Tomorrow/short-date variants and compact Today/Soon are tested, but only weekday Airs labels and compact Finale were visibly captured in the lab.
- Episode Premiere/Finale/New Episode markup was observed and tested, but actual episode-list screenshot verification is blocked by missing physical `*-thumb.jpg` files in the golden library. Requests return 404; Jellyfin leaves `listItemImage ... lazy-hidden` at opacity 0. The diagnostics inventory the badge and ancestor geometry/opacity in `.notes/browser-episode-diagnostics.log` and `.notes/browser-episode-visibility.log`. No artificial metadata or CSS was added to fake visibility. Season Premiere and Season Finale were instead visibly captured on season cards.
- Browsing captures have no JE Status Tags warning/error or page error on final runs. The initial home navigation had one transient aborted trending fetch; its final recapture did not. A fully clean lab console/log criterion is **not met**: Jellyfin emits socket 403 “Token is required”, missing poster/thumbnail 404s, and dashboard translation-template errors for pre-existing `${...}` expressions (`url`, `img.width`, `trimmedLine`, etc.). An existing CDN award-logo refresh warning also appears. No Status Tags server error was found. These unrelated lab/base-page issues were left outside this feature diff.
- Browser work used the supplied helper because T3 preview status reported `available:false`.
- Native Status Tags remain outside phase 4a; offline native poster parity is unchanged.

## Pending-question rows

Recorded in `.notes/pending-questions.md`:

| ID | Chosen option |
|---|---|
| P4a-1 | Finale badges use the new-release window and require the matching visible library episode |
| P4a-2 | Complete Season describes all locally available non-virtual episodes added within the window, not TMDB acquisition completeness |
| P4a-3 | Jellyfin status first; TMDB may refine Ended to Cancelled |
| P4a-4 | Missing episode_type uses cached/rate-limited season enrichment, then a locally confirmed season-boundary fallback |
| P4a-5 | Hidden contributing episodes conservatively suppress aggregate fields via the existing filterRevision path |
| P4a-6 | Dashboard copy uses embedded English through a local JE.t adapter when injected JE.t is unavailable |
