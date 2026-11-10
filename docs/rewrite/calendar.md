# Calendar TypeScript slice

Implemented against baseline `2e0f9251bfe833cb58866e9e245ba62be69a69ad` on Lenovo. This is seven calendar entries, not a whole-product rewrite or release certification.

## Ownership and loading

`client/entries/calendar.json` maps exactly the seven existing `js/arr/calendar/*.js` production paths. The server component order remains styles, data, event rendering, view rendering, actions, initialization, then Custom Tabs. The public `JE.calendarPage`, `JE.initializeCalendarPage`, and `JE.internals.calendarPage` facades remain available. Plugin Pages HTML, shared helpers, native-tabs, requests/downloads, core modules, transport generation, packages and backend code were not edited by this slice.

The narrow `client/src/features/calendar/host.ts` adapter describes only consumed host capabilities. `domain.ts` validates unknown calendar, request, user-data and preference documents and implements civil-date parsing. `lifetime.ts` receives its host dependency explicitly. The data entry owns state; lifecycle generations live on `JE.internals.calendarLifetime`, not bundled module-local variables. Re-evaluating the data entry preserves the sole owner. Each entry still installs its own facade slots in the original order; the adapter's staged-facade assertion is not a transport cast.

Helpers/native-tabs are resolved at call/readiness time. The current API client is resolved when building Shoko URLs/posters, allowing client replacement. UI teardown disposes location subscriptions, navigation listeners, sidebar registration, custom-tab readiness polling, watcher and click-handler ownership. The data owner's session reset subscription deliberately survives UI teardown/reinitialization.

## Baseline behavior and deliberate fixes

Retained: month/week/day/30-day agenda; list/backdrop/cards; week-start and time-format configuration; today/period navigation; legends and OR/AND/NOT filters; force-only-requested filtering; watched/favorite indicators; monitored preferences; same-day season episode collapsing/expansion and finale labels; multi-instance labels and errors; provider search and episode/series navigation; Shoko URL mappings and Jellyfin posters; standalone, Plugin Pages, Custom Tabs and native-tab facades; original calendar CSS and theme injection.

The seven baseline files consume Seerr request status through paginated `/arr/requests?userOnly=true`; they do not implement request submission. That consumer is preserved and validated. Actual Seerr request mutations remain with the separate requests implementation and backend.

Intentional fixes:

- Session epoch/lease, view and per-request generations reject stale account/server/refresh continuations, including logout and return. Delayed provider navigation and further request pages stop after invalidation. Detached or inactive custom containers reject results.
- Calendar transport/shape errors display an explicit retry state instead of a successful empty calendar. Instance errors retain escaped, deduplicated notifications. Failed request pagination neither installs partial results nor marks the request cache loaded; retries remain possible. Disabling the optional Requests filter allows the other calendar sources to display again.
- All local calendar preferences use user **and server** scope when the session exposes its server identity. Unscoped and earlier user-scoped keys migrate once, with deletion only after successful scoped storage. Filter restoration resets on identity change; each refresh reloads the current preferences. The existing core settings writer still owns view/display settings persistence; writes receive a snapshot, and failures notify only the originating current lease. No calendar Arr mutation is introduced.
- Date-only releases are local civil dates, never UTC-midnight conversions. Timestamped releases retain local timezone conversion. Episode grouping uses the displayed local day. Calendar-day arithmetic retains DST boundaries rather than adding fixed 24-hour durations.
- Day view now applies the same existing Hidden Content filter as the other three views.
- Initialization is idempotent, showing a standalone page restarts its location watcher, and custom/native remounts dispose previous work.

Null or undated event records continue to be omitted, as in the baseline. Present consumed fields must have the expected primitive/array shape; invalid dated events fail the response. Optional provider IDs and metadata retain their optional semantics.

## Evidence

Exact owned file hashes, source/production file list, baseline facade/style comparison, commands and original implementation evidence are under `artifacts/rewrite-calendar/`. The parent integrated the boundary cases into `tests/frontend/pages/pages-calendar-boundaries.test.mjs` and the browser journey into `tests/browser/calendar-rewrite.spec.cjs`. The permanent date case checks UTC, New York spring/fall DST transitions and Perth on every run. Tests execute shipped generated assets, not copied implementations. Existing assertions are unchanged.

- Existing calendar suite: 15 passing.
- Additional generated-asset boundary cases: 14 passing; combined calendar run: 29 passing in America/New_York. Additional timezone run covers Australia/Perth.
- Native-tabs/header/Hidden Content caller suites: 29 passing.
- Chromium interaction: one passing journey covering actual inline view controls, collapse/expand, cards, transport error/retry, stale-account navigation rejection, and a custom-container remount.
- Strict staged typecheck and shared client build passed. Generation uses `/home/jake/projects/je-v12-client-build.lock`; focused checks use `/home/jake/projects/je-v12-validation.lock` and `DOTNET_PROCESSOR_COUNT=2`.

## Remaining validation

The backend is unchanged and was not rebuilt or tested by this implementation sub-agent. Real Sonarr/Radarr/Shoko/Seerr responses, authorization/library-access enforcement, actual request submission and mutation reconciliation on those services remain backend/integration validation gaps. The Chromium fixture is not a Jellyfin 12.4.0 host run and is not a visual parity certification. Plugin Pages wrapper execution, full host bundle/fallback delivery, mobile layouts, real native-tab integration, all locales and actual server switching still require parent-owned host validation. Native/Custom Tabs mount/disposal is additionally covered through the generated entry in the DOM harness.

Independent review, inventory refresh, full combined validation and real-host runs remain parent-owned. No commit, push, deployment, live install or PR was performed.

Review fixes: calendar preference saves pass the loaded settings object to the shared writer, retaining inheritance, identity binding and date context. Collapsed groups use the lowest numbered episode as their representative. Item navigation has its own generation; a new click supersedes the old one, and refresh, period/view and filter changes cancel pending navigation without invalidating request caches. Permanent caller regressions are in `tests/frontend/pages/pages-calendar-regressions.test.mjs`.
