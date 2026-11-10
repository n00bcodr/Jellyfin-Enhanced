# Requests / downloads TypeScript slice

This replaces the eight `js/arr/requests/*.js` entry implementations for Jellyfin
12.x. It is one feature slice in an incomplete product rewrite, not a release or
whole-product parity certification. Baseline:
`2e0f9251bfe833cb58866e9e245ba62be69a69ad`.

## Ownership and integration

`client/entries/downloads.json` maps the original eight production resource URLs
to `client/src/features/downloads/*-entry.ts`. The actual loader order stays:
styles, data, render helpers, cards, render, actions, init, then custom tab. No
component manifest, core/session/API, settings, calendar, Arr-link family,
backend, package or Plugin Pages wrapper was edited for this slice.

Each entry supplies the narrow `client/src/features/downloads/host.ts` dependencies
to its installer. `JE.internals.requestsPage` is the single state and runtime
owner. Importing the runtime into separate classic bundles does not create
separate owners; repeated evaluation of an entry does not replace state or
register duplicate listeners. The adapter's partial-to-complete facade assertion
is the loader-order compatibility seam. Installers still require their preceding
entries; it is not a promise that arbitrary entry order is supported.

The public `JE.downloadsPage`, `JE.initializeDownloadsPage`, and internal
`requestsPage` methods remain available, including inline pagination/filter
callers and `_state` placement flags used by `PluginPages/DownloadsPage.html`.
The historical requests/downloads naming, route `#/downloads` and `/downloads`,
and production paths are retained.

## Preserved behavior

| Surface | Retained behavior |
| --- | --- |
| Queue | Sonarr/Radarr instance labels/icons, progress/ETA/size, status tabs, title/subtitle/instance search, hidden-content filtering, season-pack grouping |
| Requests | Seerr cards, raw pending request approval independent of media availability, release labels, watch links, all/pending/processing/coming-soon/available filters, whole-row paging |
| Issues | Open/resolved filters, paging, metadata enrichment, reporter/avatar/message cards, issue modal facade, account-scoped sticky 403 denial |
| History | Imported/partial/failed cards, whole-row bounded paging, server `visible` decision |
| Placement | Standalone route/sidebar, existing Plugin Pages wrapper facade, Custom Tabs, native `requests` tab registration |
| Providers | Per-instance queue error notices with recovery-aware deduplication, optional sections and configured polling |
| Integration | Shared avatar helpers, administrator-only Arr link hydration and URL mapping, Seerr detail links, translations, existing CSS and theme injection |

Queue source is exposed through instance badges and instance-name search in the
baseline. These eight baseline entries have no separate source-filter selector,
queue retry/remove mutation, or retry/remove confirmation. They expose Seerr
approve/decline POSTs. No unsupported queue mutation routes were invented. Any
broader retry/remove requirement needs a separately identified source/route and
backend contract; it is not certified here.

## Boundaries and intentional corrections

All transport returns begin as `unknown`. Feature decoders validate consumed
queue/request/history fields, issue/media shapes and Arr-link matches. Missing
optional fields remain accepted for compatibility; malformed consumed fields
fail the corresponding read. Unused provider fields are not copied into a
permissive runtime object. The current backend uses anonymous projections and
Seerr proxy documents: these decoders are local, explicitly bounded adapters,
not generated authoritative server DTOs. Contract generation for these routes
remains backend integration work.

Session epoch, current API account/server, route, view generation, attached
container and active tab checks protect continuations. Independent latest-read
lanes prevent older page/filter responses overwriting newer selections. Issue
metadata uses its own lease and cannot cancel requests loading. Account reset
clears private cards, permissions, issue metadata and notice deduplication. An
existing visible polling lifetime remains available for the new account;
manual refresh also remains available when polling is disabled.

Mutations recheck connected/visible view, current selection and pending state
before sending. They use `skipRetry: true`. A sent write is recorded as pending,
succeeded, failed (definite 4xx), or uncertain (transport/other failure), even if
its originating view becomes stale. Stale completion never refreshes or edits
the new view. A current-view failure restores the action control and asks the
user to refresh/check current status; it does not claim rollback or retry the
write automatically. The bounded in-memory outcome journal is diagnostic
reconciliation, not durable server transaction storage.

Polling checks the actual container and active tab as well as placement flags.
It stops when Plugin Pages removes/hides its container, and custom/native tabs
remount and restart on return. Resource cleanup owns navigation/resize listeners,
readiness timers, observer unsubscriptions, debounce work and the poll timer.
The route watcher remains alive after standalone hide so push-state return can
be observed. Repeated initialize is idempotent.

Additional corrections: queue/request/history read errors have explicit failure
messages instead of looking successfully empty; queue title/subtitle/ETA and
search/status attributes are escaped; progress is bounded to 0–100; status
colors use normalized keys; single-status queues retain search; grouping uses
structured source/instance keys; external navigation rejects non-HTTP(S) URLs;
issue metadata cache is bounded; page size never exceeds its endpoint cap.
Existing assertions were retained. New failure messages currently use English
fallbacks; translating those added strings remains a localization gap.

## Verification and gaps

Exact commands, logs, source/output SHA-256 hashes, additional tests and Chromium
fixtures are under `artifacts/rewrite-downloads/`. Tests load the shipped
production assets, not a separate replacement implementation. The additional
tests are intentionally kept in the task-owned artifact directory; the parent
can promote them to the regular suite during integration.

Focused frontend coverage includes the existing downloads/helper/history
regressions plus stale account/navigation/selection, simultaneous request and
issue hydration, definite and uncertain mutation failures, malformed responses,
markup escaping, duplicate bundle evaluation, instance grouping and inactive
tab continuations. Chromium exercises search, filters, paging, failed approval,
a sent write across account change, custom/native tab remounting, navigation
away with a pending queue and Plugin Pages container removal.

No backend build/test, disposable real Jellyfin host/browser run, live install,
deploy, commit, push or PR was performed by this owner. Existing backend
`[Authorize]`, linked-user filtering, history administrator policy and mutation
permissions remain authoritative and unchanged. Real Jellyfin 12.4.0 placement,
permissions, multi-provider behavior, actual avatar/link endpoints, TV/mobile
focus, visual parity and cross-server journeys still require the parent's
integration runs. Existing backend queue rows provide `instanceName`, not a
stable instance identifier; two instances configured with the identical name
cannot be fully disambiguated without a backend projection change. The typed
adapter accepts an `instanceId` when supplied and prefers it for grouping.

The parent promoted the additional regression cases to `tests/frontend/pages/pages-downloads-boundaries.test.mjs` and the six browser fixtures to `tests/browser/downloads-rewrite.spec.cjs`, so the normal suites discover them. Original implementation evidence remains under `artifacts/rewrite-downloads/`.

Review fixes: request reads retain their originating user, server, API object, base URL, token and session epoch. Actions reconcile session state and require that originating ownership, a current selected request, approval permission and pending status. Beginning a new requests read disables stale selection actions until a successful response. Runtime continuations use the same complete identity snapshot. Provider links join validated HTTP(S) base paths without doubled slashes, retaining reverse-proxy prefixes. Permanent regressions use real emitted session/API code for silent identity changes. Existing mutation fixtures now load an approvable request before exercising writes; their retry/failure assertions are unchanged.
