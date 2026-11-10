# Bookmark client replacement

The eight existing bookmark script paths are generated from strict TypeScript by
`client/entries/bookmarks.json`. Their order in component-scripts.json is unchanged.
Only the bookmarks entry constructs persistence state; library entries use the
same `JE.bookmarks` and `JE.internals.bookmarksLibrary` bridge. The existing
BookmarkCurrentTime handler continues calling the public modal API.

`state.ts` owns item metadata caching and per-owner mutation queues. Mutations
retain bookmark.json's document shape and extension fields. Updates, deletion,
delete-all, episode backfill, replacement/copy and offset adjustment all serialize
behind preceding work on the same owner. Replacement and offset adjustment save
once and restore the affected records if persistence fails. Saves opt into the
settings facade's `throwOnError` behavior; stale failed saves still fail, while
notifications and UI work are gated by the owner and session epoch. Old saves
can roll back their captured old map without touching a new account's map.

`bookmarks-host.ts` specifies the consumed host surface, validates unknown item
and session responses, and captures identity leases. `domain.ts` contains
timestamp parsing/formatting and presentation filtering. Invalid display records
are excluded from the view without deleting them from saved documents; legacy
metadata-only records remain available through the established lookup API.

The library retains standalone, Plugin Pages, Custom Tabs and native-tab mounting,
item/type grouping, editing, deletion, cleanup, duplicate detection, offset and
replacement dialogs, posters and session playback. Search filters visible cards.
Replacement search pages the existing Jellyfin Items route, explicitly requests
provider IDs and requires the exact episode when episode metadata is known.
Orphan cleanup deletes only confirmed 404 results; transport and authorization
errors retain records. Async metadata/render/dialog work checks its identity lease.
Owned timeouts, navigation listeners, observer subscriptions and dialog focus
lifetimes have explicit cleanup. Player cleanup cancels pending injections and
allows reinitialization.

## Persistence boundary

This slice does **not** provide multi-tab CAS. bookmark.json is still saved through
the existing unconditional whole-document user-settings route. The client queue
coordinates this instance only; two tabs or devices can overwrite one another's
snapshots. Revisioned bookmark persistence, cross-writer conflict handling and
atomic server-side batches remain an outstanding backend slice. No new route,
controller, persistence service, settings facade or host serializer was changed
here.

## Validation

The focused generated-output suite is:

```sh
node --test tests/frontend/features/bookmarks/features-bookmarks.test.mjs \
  tests/frontend/features/bookmarks/features-bookmarks-rewrite.test.mjs \
  tests/frontend/bootstrap/settings-revisions.test.mjs
```

The focused Chromium fixture is `tests/browser/bookmarks-rewrite.spec.cjs`.
It exercises atomic offset failure, focus trapping/restoration, search visibility
and immediate account-change clearing. It uses intercepted fixture responses,
not a live Jellyfin installation.

Build/check generation must hold `/home/jake/projects/je-v12-client-build.lock`.
The parent owns structural inventory, full integration gate, independent review
and real Jellyfin 12 validation. Evidence and per-file hashes for this handoff are
under ignored `artifacts/rewrite-bookmarks/`.
