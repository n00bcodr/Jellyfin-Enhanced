# Shared runtime rewrite slice

The four production entries `js/enhanced/helpers.js`, `icons.js`, `translations.js`
and `themer.js` are generated from strict TypeScript under
`client/src/features/shared/`, owned by `client/entries/shared.json`. This is a
feature slice of the unfinished Jellyfin 12 rewrite, not a product completion or
real-host parity claim. Baseline: `2e0f9251bfe833cb58866e9e245ba62be69a69ad`.

## Ownership and integration

Each entry installs its facade once on the existing JellyfinEnhanced object.
Factories are imported only by their owning entry; consumers use the facade at
call time. Bundling the adapter into several IIFEs creates no additional cache,
subscription or language state. `host.ts` defines finite feature-specific host
interfaces; core types are imported as types only. ApiClient is resolved at call
time. No existing host adapter, core/session/API module, package, loader or
settings implementation was edited.

The ordered manifest still loads session before helpers, helpers before icons,
and themer later, at its original location. Helpers are immediately available
for bootstrap and retain every existing public method. Navigation/item-parent
lookup consumers continue to use `getItemCached`; the navigation implementation
and its own cache ownership remain outside this slice. Translations continue to
load independently through plugin.js at the original dynamic asset URL. The
plugin's `JE.t` interpolation/plural facade is unchanged.

## Behavior and boundaries

Item cache entries remain TTL-based, deduplicate concurrent requests, and support
`userId`, `ttlMs`, and `forceRefresh`. Server, user and token identity now scope
entries. Session leases and invalidation generations prevent A→B→A, spoiler-change
and old-server responses from reaching callers or repopulating caches. Stale
successful lookups resolve to null; real current-request failures still reject.
Older failed promises cannot remove newer cache entries. Jellyfin item payloads
are unknown at ingress: the object envelope and optional Id are validated, while
extension fields remain unknown for feature consumers to validate. There is no
authoritative generated Jellyfin item DTO in the current client contracts.

Protected avatar requests preserve the server base URL and auth headers. Explicit cache clears invalidate in-flight work; ordinary rerenders retain valid
pending downloads for deduplication. A retired completion cannot allocate or
publish a blob URL, hide a newer hydration, or evict a successor promise. Session transitions/unload revoke owned
blob URLs. Hydration checks both its lease and the image's current source before
writing. Public safe-avatar URL behavior is preserved.

Sidebar unregister handles own their registration, so a replaced handle cannot
remove a successor. The last unregister releases the body subscription. Tab
observers retain nested active-tab checks and lifecycle teardown. MUI drawer,
header fallback, sizing, style IDs and mobile auto-close behavior are retained;
removed owned sizing CSS can be reinstalled.

Translations preserve the bundled-first/local-CDN/retry/English sequence, language
normalization/base fallback, versioned 24-hour storage keys, and English-key
provenance. Dictionaries are validated from unknown JSON/cache input. Storage
access failures no longer prevent network loading. Language/session generations
publish dictionary and plural-language metadata together; superseded callers
resolve to the latest load, avoiding stale assignments by existing bootstrap
callers. A language preference changed during a load triggers a fresh load.
Translation markup and interpolation placeholders are preserved verbatim: this
module does not insert translations into the DOM. All 33 locale assets are
unchanged. Public locale files still share the baseline version/language cache
keys across accounts; they contain no user-specific projection.

All 44 icon names and all emoji/Lucide/Material tables are retained. The single
emoji font style keeps its original ID. `wrapEmoji` now treats its input as text
and escapes markup; the trusted static SVG tables retain their markup. Settings
are read at each icon call. Theme detection, four definitions, registration,
variable fallback (including a dynamically replaced default), RGB wrapping and
logo URL extraction are preserved. Theme
registration safely supports arbitrary own keys without assigning prototypes.

External links retain native `is="emby-linkbutton"`, target, rel, text, class,
style-reset and setup callback behavior. Executable/data URL schemes now resolve
to `#`; HTTP(S), mailto, tel, FTP, blob and relative navigation remain supported.
This and escaped emoji text are intentional DOM-boundary hardening changes.

The only mutation in this slice is the existing best-effort opt-in usage counter.
It has no optimistic UI or response state to reconcile; a sent request remains
sent even if the account subsequently changes.

## Evidence and remaining work

`tests/frontend/core/core-shared-runtime.test.mjs` adds 15 generated-asset boundary
and interaction tests. Existing assertions were retained. The final focused run
passed 310 tests, including translation/plural behavior, session/navigation,
spoiler cache invalidation, protected avatar regressions, details consumers,
MUI/header actions, native tabs and settings/tag panels. Exact commands, logs,
baseline comparisons and SHA-256 snapshots are under the ignored directory
`artifacts/rewrite-shared-runtime/`.

Independent review, complete frontend/backend validation, backend endpoint
permissions/content-type behavior, disposable Jellyfin 12 host/browser checks,
real theme rendering/native-shell link handling, account-transition integration
and release validation remain with the parent/integration owner. No backend,
real-host, live installation or deployment was run for this slice. Baseline
comparison proves preserved assets and public shape, not exhaustive behavioral
parity. Item/avatar caches retain baseline lifetime/TTL policy and are not newly
capacity-bounded; translation requests are invalidated logically rather than
aborted at the transport layer.

Parent integration also keeps cancelled/null item lookups out of the legacy Letterboxd unsupported-item cache, allowing a later current lookup. Permanent regressions are in `tests/frontend/core/core-shared-boundaries.test.mjs`; independent recheck evidence is recorded under `artifacts/reviews/`.
