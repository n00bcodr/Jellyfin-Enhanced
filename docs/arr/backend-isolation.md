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
`available`, `complete`, `backend`, `revision`, `titles`, `code` and `retryable`. A `503` means the projection cannot give a
complete answer; consumers must preserve their requested-only restriction. Title membership does not
grant library, parental, edition or episode access. Downloads and History apply their existing audience
checks in addition to this ownership filter. Visibility uses each interest's stored destination, even
when the default instance changes. Learned provider aliases remain available from the ledger after restart
or removal from an arr library.

Cold visibility evidence is prepared under a two-second budget, without preparing a Seerr account.
An unresolved interest stays hidden while other verified interests remain in the ownership set.
Queue and History return HTTP `503`, `Retry-After: 2` and `requests: { available, complete: false,
code: "requests_unavailable", message: "Requests unavailable. Please retry.", retryable: true }` when
ownership evidence is incomplete; the body may include verified rows. This is distinct from an HTTP `200`
complete empty result. Retrying repeats visibility preparation under the existing evidence cache and backoff
policy. Clients must show unavailable/retry and keep ownership restrictions while that read is incomplete.

Transition admission also covers watchlist processing and request-provider results after the HTTP body
has arrived. Local watchlist saves and proxy cache publication check the admitted epoch. Adoption drains
old work before committing, and outbox settlement rejects results from an earlier backend epoch.
Admin logs identify denied producers and projection failure categories without connection or person data;
repeated diagnostic categories are limited to one per minute.

The backend selector, public capability mapper and atomic adoption workflow are separate integration
work. Until that workflow lands, the isolation version is a server integration setting; the configuration
page does not expose an adoption control. Provider and client owners must consume the effective backend
contract before the complete JE experience can be declared independent of Seerr.
