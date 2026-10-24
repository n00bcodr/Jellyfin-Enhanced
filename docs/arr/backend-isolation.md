# Request backend isolation

The server supports an explicit isolation version alongside the existing `ArrRequestBackend` choice.
Existing configurations omit `ArrBackendIsolationVersion` or store `0`; their behavior remains unchanged.
An ordinary upgrade or save does not adopt isolation.

With version `1` and backend `je`, the server refuses Seerr HTTP calls before dispatch, including reads,
connection tests, account imports, watchlist synchronization and scans. Saved Seerr connection settings
remain stored. JE automatic requests use the existing TMDB and ledger path; disabling requests does not
reactivate Seerr. Jobs previously sent to Seerr retain their original destination and uncertain delivery
state. They cannot be resent through JE merely because Seerr readback is unavailable.

`GET /JellyfinEnhanced/arr/requested-titles` returns the signed-in person's own local request interests,
including resolved TMDB identities, edition and scope. It requires a real Jellyfin user and returns
`available`, `complete`, `reason`, `backend`, `revision`, `from`, `to`, `titles`, `code` and `retryable`. A `503` means the underlying ownership read is unavailable; consumers must preserve their requested-only restriction. Title membership does not
grant library, parental, edition or episode access. Downloads and History apply their existing audience
checks in addition to this ownership filter. Visibility uses each interest's stored destination, even
when the default instance changes. Learned provider aliases remain available from the ledger after restart
or removal from an arr library.

The HTTP result groups interests by `(mediaType, tmdbId)`. Each title has a normalized TMDB `key`,
known provider `aliases`, and `parts[]` retaining scope, edition (`variant`), seasons, episodes and
request status. The internal ownership projection retains each interest. Neither grouping nor the
window filters historical interests by request or release date.

Optional `from` and `to` must be supplied together, with a positive window of at most 366 days.
The response echoes them in UTC. A windowed read requires Calendar enabled; it otherwise returns
`503` with `reason: "calendar_disabled"`. No-window historical ownership reads remain available with
Calendar and submission switches off. Invalid windows return `400` `invalid_window`. Complete results
have `reason: null`. Successful partial reads return `200`, `complete: false` and a reason such as
`parental_evidence_pending` or `identity_unresolved`, retaining verified titles.

Cold visibility evidence is prepared under a two-second budget, without preparing a Seerr account.
An unresolved interest stays hidden while other verified interests remain in the ownership set.
Queue and History return HTTP `200` with the verified rows, top-level `complete: false` and `reason`,
and the nested `requests: { available: true, complete: false, reason, retryable: true, … }` when ownership
evidence is incomplete. `parental_evidence_pending` means some rows are still being checked;
`identity_unresolved` means an interest cannot yet be mapped. Unresolved wants are excluded, while
verified rows stay visible. HTTP `503` is reserved for an unavailable underlying ownership read,
with `available: false`, no ownership-backed rows and a retryable reason. Incomplete/unavailable
reads carry `Retry-After: 2`; complete empty remains `200`, `complete: true`. Retrying repeats bounded
visibility preparation under the existing evidence cache and backoff policy. Clients must retain
requested-only restrictions and distinguish partial/unavailable from complete empty.

All Seerr publication uses the effective-backend owner's epoch fence: cached status/account facts,
proxy and enrichment/avatar results, bootstrap prefetch, readers, background work and outbox settlement.
It checks after processing, beyond HTTP buffering. Operations holding admission are cancelled and drained
before adoption commits; other old results are discarded at publication. On version 0, ordinary saves
preserve legacy admission and request bytes even when feature flags change between construction and send.
Adoption into version 1 still rejects that old work.
Admin logs identify denied producers and projection failure categories without connection or person data;
repeated diagnostic categories are limited to one per minute.

The backend selector, public capability mapper and atomic adoption workflow are separate integration
work. Until that workflow lands, the isolation version is a server integration setting; the configuration
page does not expose an adoption control. Provider and client owners must consume the effective backend
contract before the complete JE experience can be declared independent of Seerr.
