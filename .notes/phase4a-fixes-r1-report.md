# Phase 4a Status Tags — fix round 1

Worktree `/home/jake/je-wt/tl-status`, branch `feat/tag-layouts-status`, base `c05ea20f`. All six findings are fixed, with one `fix(tags)` commit per finding. Only `je-lab-tlstatus` (`http://127.0.0.1:18524`) was used. No push, PR, stash or child agents.

## Commits and findings

All commits use Jake <45441845+4eh5xitv6787h645ebv@users.noreply.github.com>.

| Finding | Commit | Result and regression coverage |
|---|---|---|
| 1. Future episodes never age into aired facts | `0af0e592` — `fix(tags): refresh aired facts at premiere boundaries` | `NextEpisodePremiere` records the next relevant boundary. Daily reconciliation includes due containers independently of metadata timestamps; snapshot load also refreshes elapsed boundaries. Older schema-12 snapshots seed missing boundaries from cached episode dates. Two snapshot cases simulate tomorrow becoming aired without a metadata save, including a legacy snapshot without the new field. Clone/content equality and HTTP serialization coverage include the field. |
| 2. Stale sibling facts | `77e55ce5` — `fix(tags): refresh sibling facts after episode changes` | The affected season refreshes every cached sibling's index and contributor list. One sibling query is shared across episode and season work in each incremental/reconciliation pass; sibling media streams are not probed. Add/remove/hide regressions verify last-episode changes, contributor lists and suppression through the existing access/filterRevision path. |
| 3. Specials becoming Series Finale | `40cc394f` — `fix(tags): exclude specials from series finale eligibility` | Series and episode eligibility explicitly uses a regular last-aired episode, excluding season 0. Tests cover S0E8 `standard` on an Ended show, a series aggregate naming a special, and a regular `standard` final episode. |
| 4. Offscreen schedule requests | `21a4dd6e` — `fix(tags): request schedules only for visible current cards` | One shared IntersectionObserver observes schedule readers. Both queueing and dispatch enforce connected/intersecting/current identity guards; batches remain capped at 50. Observer regression covers offscreen, detached, recycled and scrolled-out queued cards, then dispatch on entry. The previous delayed-answer regression now invalidates the record after dispatch so it continues testing stale answers. |
| 5. Upstream failures bypass retry | `89018b6d` — `fix(tags): preserve schedules and retry transient upstream failures` | 429, 5xx and transport exceptions produce a per-ID `{retry:true}` marker, distinct from omitted authoritative no-data. Retry responses use `private, no-store`. The client preserves prior facts and automatically retries visible failed IDs after five minutes through one timer. Tests cover 429/503/exceptions, endpoint marker/cache headers, prior-fact preservation and timer-driven retry. |
| 6. Midnight labels stale | Final commit (`HEAD`) — `fix(tags): refresh date labels at local midnight and return` | A single rearmed timer targets the next local midnight using local calendar arithmetic. Visibility and focus events refresh current cards after suspension. Badge comparison includes local day, and an identical lookup on a different day triggers a live pass. Four regressions verify Tomorrow → Today through midnight, visibility, focus and identical facts. All card types are tracked for date changes. This commit also contains this report; its final hash is in the handoff. |

Schema remains **12**: the optional server-only boundary is additive and legacy snapshots remain usable. `NextEpisodePremiere` is omitted from client JSON; contributor-dependent client fields continue through the existing access/filterRevision path. No new user-visible strings or JS modules were needed.

## Verification

| Check | Result | Evidence |
|---|---|---|
| `node tests/frontend/run.mjs` | **668 passed; 0 failed/skipped** | `.notes/fixes-frontend.log` |
| Final vocabulary test file, UTC | **79 passed; 0 failed/skipped** | `.notes/fixes-vocabulary-final.log` |
| `dotnet test tests/backend -p:JellyfinTarget=jf12 --artifacts-path /tmp/tlstatus-backend` | **936 passed; 0 failed/skipped** | `.notes/fixes-backend.log` |
| Cache compatibility/facts subset | **10 passed** | `.notes/fixes-cache-compatibility.log` |
| jf12 Release build, `/tmp/je-build-tlstatus-jf12` | **0 warnings, 0 errors** | `.notes/fixes-build-jf12.log` |
| jf10 Release build, `/tmp/je-build-tlstatus-jf10` | **0 warnings, 0 errors** | `.notes/fixes-build-jf10.log` |
| Poster parity `--offline` | **40 profiles × 101 entries; 0 differences** | `.notes/fixes-parity.log` |
| Translation validation, en | Passed (base-language comparison is skipped by the validator) | `.notes/fixes-translations.log` |
| Inventory `--check` | Current | `.notes/fixes-inventory.log` |
| `git diff --check` | Passed | Final worktree check |

Backend test compilation retains the two existing ASP.NET deprecation warnings (`ASPDEPR004`, `ASPDEPR008`) in `tests/backend/Api/ApiRoutingTests.cs`; both plugin Release builds have zero warnings. An initial Release build hit a transient output-copy retry warning; the sequential final builds above completed with zero warnings.

The focused behavioral regressions were also run against the actual `c05ea20f` production sources: **8 backend failures and 8 frontend failures**, covering every finding. Two frontend control cases passed. New-property initializers belonging to the separate serialization/equality assertions were omitted only for the old-model compilation; the behavioral assertions were retained. Sources were restored byte-for-byte afterward. Evidence: `.notes/fixes-base-backend.log`, `.notes/fixes-base-frontend.log`, `.notes/fixes-base-summary.log`. The additional legacy-snapshot variant was then added and passed in the final compatibility/full suites.

## Lab and screenshots

Deployed using `/home/jake/je-lab/deploy.sh tlstatus /home/jake/je-wt/tl-status`, then invoked the authenticated manual cache rebuild. The lab retained its existing TMDB key and configuration. Cache version advanced from 2 to 3: **4,845 entries, 4,174 episode indexes**. No `NextEpisodePremiere` field leaked into the client response. Evidence: `.notes/fixes-deploy.log`, `.notes/fixes-lab-cache.log`, `.notes/fixes-lab-server.log`.

On the **89-series Shows grid**, a browser-only cache reset allowed request instrumentation before dispatch. Before scrolling: **2 requests, 21 distinct series**. After scrolling: **5 requests, 68 distinct series**. Batch sizes were **20, 1, 21, 21, 5**. All requested IDs had a connected card intersecting the viewport at dispatch: **0 offscreen dispatches**. Evidence: `.notes/fixes-browser-scroll.log`, `.notes/fixes-scroll-summary.json`.

Screenshots are local review artifacts in `.notes/shots/phase4a-fixes/`:

| File | Visible evidence |
|---|---|
| `home-desktop.png` | New Movie, Just Added; New Season, Series Finale and Complete Season on the lower home row. |
| `home-mobile.png` | Home page at 420 px with date badges. |
| `series-desktop.png` | Silo season cards with Complete Season, scrolled into view. |
| `series-mobile.png` | Silo season cards at 420 px, scrolled into view. |
| `shows-before-scroll.png` | Initial Shows grid. |
| `shows-after-scroll.png` | Scrolled Shows grid, including New Season, New Series, Just Added and Series Finale. |

The supplied `/home/jake/je-lab/pw` helper was used. Each browser was closed by the helper. Final captures explicitly select English. No JE console errors/warnings or page errors were observed on home or the series page. The general clean-console/server-log criterion remains limited by the existing Jellyfin socket 403 (`Token is required`) and missing poster/thumbnail/backdrop 404s. No Status Tags server failure was found.

## Documentation, choices and limits

Updated `docs/advanced/api.md` with the per-ID retry marker and HTTP cache behavior; updated `docs/enhanced/tags.md` with viewport/midnight behavior, the additive boundary and sibling refresh/access rules.

Pending choice recorded in `.notes/pending-questions.md`: **F4a-1**, use a per-ID retry marker to preserve the existing ID-keyed response shape; easily replaceable with a retry list in a later API version. No questions block implementation.

Real upstream failure injection, an actual overnight clock crossing, and a real episode premiere occurring during the lab session were not exercised against TMDB/the running server. Transport fixtures and clock-controlled regressions cover those cases. No lab clock, library metadata or upstream service was changed to fabricate them. This round captures representative existing badges rather than re-proving every vocabulary variant from the feature phase. Existing artwork failures still limit episode-card visual evidence.
