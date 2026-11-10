# Spoiler Guard TypeScript slice

The twelve ordered `js/enhanced/spoilerguard/*.js` entry paths remain registered in
`client/entries/spoiler-guard.json`. Their implementations live under
`client/src/features/spoiler-guard`, with the browser boundary in
`client/src/features/spoiler-guard/host.ts`. This is one implementation slice of the ongoing
Jellyfin 12 rewrite, not a product completion or release claim.

`state.ts` is the only owner of enabled series, movies, collections, pending TMDB
entries, promoted-ID mappings, loaded/error status, and user preferences. Other
entries call the existing `JE.internals.spoilerGuard` facade; `index.ts` preserves
`JE.spoilerBlur`. The adapter checks missing ordered-loader dependencies when
used. Pure ID helpers and response decoding use ES imports. No entry imports
another stateful entry and accidentally creates a second policy store.

The adapter consumes the existing typed session, API request and lifecycle
contracts. Component ownership uses `JE.core.lifecycle` and session leases to
cancel pending work and remove listeners. Settings additionally use the existing
panel `onClose` hook. Watched-state fetch/XHR hooks restore their predecessors on
teardown and can be installed again. Image URL cache busting is presentation only;
all writes still use the authenticated core plugin API. The image identity cookie
is never copied into write payloads, headers, or authorization decisions. Server
policy and protected response shaping remain authoritative.

Preserved behavior includes per-kind detail toggles, pending promotion/removal,
collection inheritance in Seerr, multi-item removal, all thirteen preference
rows and their administrative gates, confirmation/native fallback, fifteen-minute
snooze with corrupt/expired value cleanup, image/srcset/background refresh,
watched refresh, cache invalidation, translations, and optional full reload.
The existing preference document and server storage formats are unchanged.
The prior user-only snooze expiry migrates once to a server/user key without
extending its deadline.

Cancellation now prevents stale confirmations, settings loads/saves, mutations,
Seerr notifications/reopening, watched requests, and reload timers from affecting
a later identity or disposed view. Failed state loads and malformed consumed
response fields fail closed. Movie collection-scope queries wait for state and
reject unavailable policy. Saved preferences adopt the server's returned values.
Seerr clicks during initial loading wait for the state request before writing.

Focused verification runs actual emitted scripts with the existing browser
harness and real emitted core session/lifecycle scripts:

```sh
node --test tests/frontend/features/spoiler-guard/features-spoiler-rewrite.test.mjs \
  tests/frontend/features/spoiler-guard/features-spoiler.test.mjs \
  tests/frontend/features/spoiler-guard/features-spoiler-ui.test.mjs \
  tests/frontend/features/spoiler-guard/features-seerr-spoiler-guard.test.mjs
flock /home/jake/projects/je-v12-client-build.lock npm run client:check
```

The implementation evidence and file hashes are under ignored
`artifacts/spoiler-guard/`. Independent review, complete frontend/backend gates,
inventory refresh, real Jellyfin 12 host/browser and visual checks belong to the
parent integration task. No live installation was performed. The focused harness
does not prove server authorization or real Dashboard/modal layout behavior.
