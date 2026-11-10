# Catch Up and Activity rewrite slice

This slice replaces nine production entries from baseline
`2e0f9251bfe833cb58866e9e245ba62be69a69ad`. It is part of the unfinished Jellyfin
12.x rewrite, not a release or whole-product parity certification.

## Ownership and runtime

`client/entries/social-pages.json` maps the six `js/enhanced/catchup/*.js`
resources and `js/extras/{activity-custom-tab,activity-page,colored-activity-icons}.js`
to strict TypeScript under `client/src/features/{catchup,activity}`. The host
boundaries are `client/src/features/catchup/host.ts` and `client/src/features/activity/host.ts`.
The existing production paths and component-script order remain unchanged:
Catch Up core, styles, deck, admin activity, page, then tab integration.

Only the core entry creates `JE.internals.catchUp`. The other entries consume
that same runtime; bundled decoder/adapter imports have no mutable module state.
`JE.catchUpPage`, `JE.activityPage`, `JE.initializeActivityIcons` and
`JE.stopActivityIconsMonitoring` remain public facades. The native-tab registry,
custom-tab markers and Plugin Pages containers remain the placement boundaries.
The existing styles, translations, icon patterns and theme hooks are retained.
Both `#/home` and `#!/home` routes are recognized.

The Catch Up core factory receives the feature host, current API accessor and
navigation dependency. Transport decoders are pure functions accepting `unknown`.
Adapters expose only the APIs this feature family uses. There are no ambient
window declarations, permissive host bags, compiler suppressions or explicit
`any` types. Browser state and cleanup remain owned by their entry modules;
importing a decoder never initializes another feature.

## Behavior and intentional changes

Catch Up preserves movie/show modes, random unwatched batches, session seen IDs,
dismissal, watchlist Likes, details navigation, watched actions, keyboard and drag
gestures, season selection and rewind. The admin panel retains feed/user/action/
title filters, summaries, relative times, docking preference and refresh polling.
Server authorization is unchanged.

Actions now remain pending on the current card until acknowledged. Repeated
swipes and rewind are blocked while that action is pending. Failed actions and
failed undo reload authoritative deck data instead of pretending success.
Multi-season requests wait for every already-sent write to settle before reload;
partial success is not presented as a reversible all-success entry. A late action
from an earlier view reloads the current deck only while its original identity is
still current. Results from old identities never log or write into the next
account. Logging remains best effort; an account switch can omit the completion
log for an already-sent action, rather than attributing it to the new account.
Rewind preserves the previous visible card order. Pointer cancellation cancels
the gesture rather than committing it.

Session epochs plus captured user/server identity protect asynchronous work,
including a switch away and back to the same account. View generations, route
checks and connected-root checks reject old refills, pickers and page loads.
Detached/replaced decks release keyboard/route listeners; admin panels release
observers, keyboard/resize listeners, timers and debounce work. Activity polling
and rendered private content are cleared on account change.

The legacy `je-catchup-dismissed-<user>` array is retained. On first use, validated
legacy data is copied to a server-qualified key and a legacy-server marker records
its first migration owner. Subsequent writes use the server-qualified key.
Existing mode and dock keys are unchanged. No server-side documents are modified.
Because the old key contained no server identity, its historical server cannot be
inferred; the first server using the migrated browser profile adopts it.

Activity preserves the three sections, chronological reviews/favorites, partial
watch progress, completed watches, live/paused streams, avatar/poster fallbacks,
ratings, text escaping, navigation and configured section visibility. Added type
filter and Load more controls use the existing endpoint: the initial request is
`/activity`, then limits 100, 150 and 200. This is bounded limit expansion, not a
cursor or an exhaustive history API. New control labels have English fallbacks
and translation hooks; no locale files were changed. Out-of-order refresh and
paging responses cannot overwrite newer content. A malformed response is an
error, including when a user changes filters after failure. Stream authorization
errors (401/403/404) remove the section; malformed data/network failures show an
error instead of silently removing it.

Colored dashboard Activity icons retain all localized matching patterns and
colors. Repeated initialization releases the previous subscription and navigation
handle; stop clears pending timers. The processed marker stores the selected
color to avoid endlessly rewriting a hex color normalized to RGB by the browser.

## Evidence and outstanding validation

The exact file hashes, baseline resource hashes, commands, test output and scoped
review are recorded in `artifacts/rewrite-social-pages/`. Tests execute generated
production JavaScript rather than source-only substitutes. Existing Activity test
assertions are unchanged. Added tests cover pending/failed/partial mutations,
rewind, season selection, repeated mounts, account/server/route transitions,
malformed responses, native/custom placement, filters, paging races and icon
subscription cleanup. Chromium fixtures cover complete Catch Up and Activity
interaction journeys.

The Chromium fixtures are **not actual Jellyfin host certification**. This slice
has not run backend tests, the full rewrite gate, real Jellyfin 12.4.0, external
Custom Tabs or Plugin Pages plugins, real user/library authorization scenarios,
or a full localization/visual/mobile matrix. The parent owns inventory updates,
combined validation, independent review and actual-host checks. The supplied
2,808 frontend / 2,792 backend / 55 host checkpoint predates these changes and is
not claimed as validation of this slice. No backend, shared navigation, settings,
player, packages or build infrastructure were edited by this implementation.

Review fixes bind the Catch Up admin panel (including pending authorization) to explicit deck disposal. Activity retirement clears private DOM immediately, before another host becomes the owner. Successful deck loads restore the normal empty state. An obsolete Load more completion cannot roll back a newer feed request's limit. `tests/frontend/pages/pages-social-boundaries.test.mjs` covers these transitions through emitted modules, including the actual request facade's deduplication.
