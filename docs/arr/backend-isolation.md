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
`available`, `complete`, `backend`, `revision` and `titles`. A `503` means the projection cannot give a
complete answer; consumers must preserve their requested-only restriction. Title membership does not
grant library, parental, edition or episode access. Downloads and History apply their existing audience
checks in addition to this ownership filter.

The backend selector, public capability mapper and atomic adoption workflow are separate integration
work. Until that workflow lands, the isolation version is a server integration setting; the configuration
page does not expose an adoption control. Provider and client owners must consume the effective backend
contract before the complete JE experience can be declared independent of Seerr.
