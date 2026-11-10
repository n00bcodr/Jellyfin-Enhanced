# Per-user document revisions

`UserConfigurationManager.ReadUserConfigurationDocument(string userId, string fileName)`
returns an `Infrastructure.Persistence.UserConfigurationDocument`: `Document` is a
complete, detached Newtonsoft `JToken`, `Revision` is an opaque string, and `Exists`
is false only for a missing file. Missing files have revision `missing` and a null
Document. Existing JSON null, empty, malformed, duplicate-key, or non-UTF-8 files
throw `InvalidDataException`; new document APIs never quarantine them. I/O and
permission failures propagate instead of becoming missing documents. UTF-8 BOMs
are accepted and included in the hash. Settings routes must additionally validate
that the JSON has the expected object/schema shape.

`TryUpdateUserConfigurationDocument(string userId, string fileName,
string expectedRevision, Func<JToken?, JToken> update,
out UserConfigurationDocument result)` compares the revision while holding the
same per-document lock used by every `SaveUserConfiguration`, strict read, and
legacy RMW call. On mismatch it returns false with the current document, without
calling the mutation or emitting a save event. On success it returns true with
the committed document/revision. The callback receives the current complete JSON
(or null for missing). Patch the requested fields of this tree to preserve unknown
fields; returning a replacement tree deliberately replaces the whole document.
Callbacks must not perform nested writes to the same document. Validation or
callback exceptions leave stored bytes untouched.

Revisions are `sha256:` plus lowercase SHA-256 of the exact stored bytes. There is
no in-memory counter, JSON wrapper, schema property, or revision sidecar to migrate
or reconcile after interruption. Existing filenames and document shapes remain
unchanged. A fresh manager or process reconstructs the same revision. Every
ordinary save that changes bytes invalidates previous revisions; byte-identical
writes and an exact change-away-and-back intentionally have the same content
revision. This protocol detects content conflicts, not every historical write.

Writes use a unique adjacent temporary file, flush its bytes to disk, close it,
and replace the destination with a same-filesystem rename. A failed write cleans
up its temporary file when possible and emits no save event. After replacement,
each subscriber is invoked independently, so one exception cannot skip later
cache invalidations. There is no separate revision update that can be interrupted.
This is atomic file replacement, not a guarantee that the containing directory
entry survives sudden power loss on every filesystem: directory fsync and
cross-process/distributed locking are not implemented. The supported writer is
one Jellyfin process; external file edits change the next observed hash but cannot
participate in its process-local CAS lock.

User-ID casing and hyphen aliases resolve to the same lock and canonical directory.
Lock keys include the absolute store path. Invalid path segments and symbolic
links beneath the configured store root are rejected. The configured root is
trusted; this is not protection against a local actor concurrently replacing
filesystem entries. Existing case-variant startup migration and legacy
strict/lenient policies remain: lenient reads return defaults for corrupt input;
legacy strict reads retain their optional quarantine behavior and null-property
schema-drift handling. Strict quarantine now shares the writer lock. No new
on-disk migration is necessary. Legacy typed whole-document saves retain their
existing replacement semantics; callers needing unknown-field retention should
mutate the raw document rather than round-tripping it through a reduced DTO.

HTTP preconditions, settings validation/merging, and client conflict handling are
integration work for the endpoint owner. The persistence API alone does not make
legacy blind-write routes reject stale clients.

Trusted store-root symlinks (including ancestors) are resolved before forming lock keys. Symlinks beneath the store root remain rejected. Raw mutations preserve arbitrary JSON numeric values; values outside exact CLR numeric ranges are represented by validated `JRaw` number literals and survive cloning/serialization unchanged. Typed fields retain ordinary numeric tokens where exactly representable.
