# Revisioned bookmark documents

This slice supersedes the unconditional persistence boundary described in
`bookmarks.md`. It targets Jellyfin 12.x and does not establish whole-product
completion or live-host parity.

## Contract and authorization

`GET /JellyfinEnhanced/user-settings/{userId}/bookmark-document` returns the
generated `BookmarkDocumentResponse`: `{ Revision, Document }`. `Document` is JSON
text, not a typed bookmark replacement. This preserves extreme numeric literals
in transport; the browser parses a display view, which is never sent back as a
whole document. Bootstrap carries this exact envelope in
`UserSettings.BookmarkSnapshot`, from one store read. The old bootstrap `Bookmark`
property remains nullable and is now null. Standalone fallback validates the same
generated envelope. Missing files return revision `missing` and an empty map
without writing a file. Malformed JSON, null/non-object roots, invalid bookmark
maps, and ambiguous map casing fail without quarantine or replacement. Invalid
individual display records remain stored.

Both routes use `[Authorize]` and the existing token-principal self/admin access
rule. Cookies, presentation markers, and loopback addresses grant no authority.
GET responses disable caching. No route uses a browser-supplied administrator flag.

`POST .../bookmark-document` accepts `{ Revision, Operations }` and returns the
generated `{ Revision }` receipt. The operation batch runs inside the existing
atomic CAS store. Stale content returns HTTP 409, with reload guidance, before
mutation. A malformed operation aborts the entire batch. The batch limit is
10,000 operations. Persistence retains the existing single-process locking,
atomic rename, content-hash revision, and power-loss limitations documented in
`persistence.md`.

## Operations and preservation

- `create`: a fresh, collision-checked record ID and explicit fields.
- `edit`: an existing record ID, optional expected item ID, and explicit changed
  fields. It never replaces the record or map.
- `delete` / `delete-all`: remove the requested membership while retaining root
  extension fields.
- `copy` / `replace`: identify a stored `SourceId`, verify its item identity, clone
  that raw stored record, apply an offset in seconds and destination metadata, and
  optionally remove the source in the same transaction.
- `offset`: adjust a stored timestamp in seconds, clamp at zero, clear
  `syncedFrom`, and update modification time.
- `backfill`: populate episode metadata only while the stored episode number is
  absent/null; leave already populated records unchanged.

Record IDs are case-sensitive dictionary keys. Clients propose IDs for new
records; the server rejects collisions rather than overwriting existing records.
Copy selections must reference stored record IDs, including when originals are
retained. The real callers already supply these IDs; arbitrary ID-less synthetic
copy inputs now reject. Public bookmark method names and result shapes remain.

Untouched root/record fields stay on the raw store tree. Copy/replace clones the
stored source, retaining unknown data, creation time, label, and provider/episode
identity except the destination fields explicitly changed by that operation.
Unknown values such as `1e400`, `1e-400`, very large integers and high-precision
decimals do not pass through JavaScript or typed DTOs during preservation. Browser
views may approximate those unknown values; they are not persistence sources.
Explicit extension-field edits through `update` remain deliberate edits, rather
than preservation of the old value. Ordinary edits retain existing field casing.
Server modification times are UTC; copied creation time remains unchanged.

## Client queue and identity

`state.ts` retains the per-owner mutation queue, rollback and public outcomes.
The narrow port in `bookmarks-host.ts` submits explicit operations directly;
other settings documents and the shared settings saver are unchanged. The seven
previous `saveUserSettings('bookmark.json', ...)` call sites were the modern
mutation callers. No bookmark DOM module changed.

The queue resolves copy selections after earlier operations settle, rechecks
cleanup item identity, and restores captured records before later work proceeds.
Only a valid success receipt advances the captured owner's revision. Conflicts
retain the loaded token and never fetch/retry against a newer revision. Missing
revisions refuse saves. Neither path falls back to the legacy POST. Invalid
receipts fail closed; if the server committed but its receipt is lost, the next
mutation conflicts and requires reload.

Production snapshots bind the owner to the API client, user, token and base URL;
session leases protect queued work and notifications. Late receipts update only
the captured owner's revision. Conflict guidance is posted after the existing
modal failure toast, with another identity check, so the visible instruction
remains “Reload before saving again.” Existing modal rollback and retry controls
remain available; retry without reload still uses the old revision.

Bookmark loading normalizes known record field names while preserving record
keys verbatim. It does not use recursive camel-case conversion on dictionary IDs.
Corrupt/unavailable snapshots leave no usable revision, even if the display has
an empty default map.

## Compatibility and generation

The existing `bookmark.json` GET/POST and add/delete compatibility endpoints are
unchanged. Legacy writes remain unconditional and may discard unknown data a
legacy typed caller does not supply. Their writes share the store lock and
invalidate modern content revisions. Modern code never silently uses them.

`Transport/BookmarkDocument.cs` is linked into the contract generator without a
plugin project dependency. Request, snapshot and receipt schemas/types are
generated; the shipped validator checks actual serialized responses. Existing
client freshness and build/pack guards remain enabled. Client generation and
focused validation use their shared locks.

Exact commands, results, file hashes, artifact provenance and limits are recorded
in `artifacts/rewrite-bookmark-documents/`. Parent-owned inventory, combined gates,
independent review and real Jellyfin-host runs remain separate.

Explicit field edits use the same lossless JSON-kind conversion as stored document reads. Date-shaped labels and nested extension strings remain exact strings; extension numbers retain their JSON value instead of becoming rounded or non-finite numbers. Create/edit/reload regressions cover both boundaries.
