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
when the default instance changes. Accepted/imported and independently proved JE aliases remain available from the ledger after restart
or removal from an arr library. Incidental Seerr aliases retain the generation fence described below.

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

The backend selector, public capability mapper and adoption UI are separate integration
work. The native configuration writer already uses the shared atomic transition; the isolation version
remains a server integration setting, and the configuration
page does not expose an adoption control. Provider and client owners must consume the effective backend
contract before the complete JE experience can be declared independent of Seerr.

`SeerrFacts` is the only data accessor. Its request model, migration reader, legacy ownership reader
and lazy ownership cache are private nested types. Consumers cannot inject a raw reader or access its
snapshots. Cache handles retain each answer's admission epoch and check it on every hit; account,
status, proxy, avatar, enrichment, prepared account/server facts and background request caches all use
this boundary. Direct TMDB season reads in strict JE retain their own local cache.

Every MVC answer records whether it consumed Seerr facts, including cached ownership proof. The final
answer checks those dependencies after subsequent arr or policy awaits. Thus Downloads and History
stay usable with local JE ownership, while an answer that consumed the previous Seerr epoch returns
409 with `configuration_changed` or `backend_disabled` and no stale rows. Composed status, hub,
Manage, interest and notification reads use the same publication owner outside MVC too. A production
assembly architecture test rejects references to raw Seerr readers outside the accessor.

Downstream effects retain the dependency through their actual commit: title identity learning and its
feed, request queueing, fulfilment, and outbox settlement. Adoption drains an admitted effect even when
it is waiting for the database writer; the backend monitor is released during that wait. A cancelled
or failed adoption keeps the old configuration and releases the admission fence. Local and arr-only
work acquires no Seerr admission when it consumes no Seerr facts. Previously accepted request/import identities remain valid local history; incidental Seerr aliases follow
the persisted-origin rule below.

The fulfilment alias cache keeps the epochs of its original inputs, and list status adapters validate
the complete multi-read answer. Cached or transformed data cannot become current merely because a
later consumer reads it after adoption. Integrating configuration/lifecycle writers must drain before
acquiring their locks and release their own retained effect before requesting a transition.

Backend-neutral JE readers can capture `EffectiveRequestsBackend.Shared.Current` before reading, call
`Publication.EnlistEffective(capturedSnapshot)`, and use that scope's final `Publish` for a synchronous
cache/answer commit. It checks the same owner's epoch without requiring submissions or Seerr transport.
An effective-epoch change, including a change away and back, withholds the old result. Derived cache
handles retain that epoch. A refused optional Seerr read adds no dependency and cannot invalidate a
fresh neutral bootstrap; dependencies from previously admitted facts are still enforced.

Backend or isolation-version changes also retire the registry's process-wide facts generation. Registered
answer caches keep the generation of their inputs through the common store/lookup envelope. An old entry
is a miss and is evicted; an old prepared object is withheld. This covers ordinary transformed values,
including household-rule facts and Peek, rather than requiring a new check on each reader. Unregistered
scalar, record and plain-class memos fail the inventory guard. A SeerrFree exemption requires a reason
and compiled producer checks, including iterator and async state machines. Public TMDB-by-id responses
remain reusable because they contain independent metadata.

The test assembly can enable taint mode for the complete focused backend selection. Successful Seerr
handouts mark the enclosing operation, and registry envelopes retain that mark across cache hits. A
plain store that drops the mark fails the run. Live admissions, writer clocks, fixed defaults and work
queues have a separate explicit control-state inventory; they are not answer-cache exemptions.

Incidental Seerr-derived aliases on disk carry a process identity and facts generation. The common
alias read view treats a stale origin as unknown after adoption or restart; it keeps the physical
history rows. An additive schema-4 extension marks existing incidental aliases conservatively on its
first open (legacy v0 origins remain usable only in that process and generation). Existing accepted
requests/acquisitions and aliases proved independently by JE remain durable. Explicit acceptance
promotes only associations still visible as current proof, so asking under a hidden old alias cannot
reactivate its retired mapping. A current incidental alias read also carries its dependency into the
publication and downstream write gate.

Native whole-configuration saves, patches and backup restores share the same serialized transition
owner. An isolation-version change, or a backend change after adoption, cancels and drains old admissions
before taking the configuration lock and committing the new generation. A version-zero selector
save keeps its already-admitted legacy sends and still advances the cache generation; old cache
entries are retired. An unrelated save keeps existing admissions
and does not advance the facts generation. Configuration write acknowledgements report the committed
configuration; ordinary read responses still reject facts consumed under an older generation.

The existing migration commit and rollback use the same transition for their backend switch.
An import releases its own facts admission once the accepted history is durable, before draining
other old work. Migration write acknowledgements contain accepted history counts and keep their
Seerr entry gate; preview and status remain fenced readers.

Only a completed durable migration command receives that acknowledgement treatment. An uncommitted
response on the same route remains subject to the ordinary stale-reader checks.


### Alias provenance rank (E1s round 6)

An existing accepted/imported association and an independently established JE association share
one durable rank. An incidental association learned from a Seerr answer has the lower rank and
retains its original process/facts generation. A missing association is unknown, never durable
proof merely because an origin row is absent. The additive schema-4 origin table represents
these ranks without a destructive migration: existing physical association plus no origin is
durable; an origin row is incidental. No new schema version or irreversible rewrite is needed.

A later incidental join captures the old rank before writing. It cannot replace a durable
association, change its canonical anchor, or give a new alias the authority of an existing
request. A hint that would join two separately retained identities is withheld for independent
proof. Retirement of the incidental alias leaves every accepted association and its request,
job, acquisition and history accessible under the original accepted ids. Provider preference
(TVDB for series, TMDB for movies) applies within the authority available for the join.

Independent JE proof promotes only its own proved ids and already durable connected ids;
incidental members pulled into the group do not gain that rank. The arr-only part of the
resolver is recorded independently before writing the combined incidental join. Acceptance/import promotes only currently
visible associations; asking under an already hidden alias cannot revive its retired mapping.

| Alias writer / entry | Rank enforcement |
|---|---|
| `RequestLedger.Unify` / `UnifyJeAliases` → `Group`, `IndependentGroup`, `UnifyCore` | Capture existing authority before upsert; preserve durable anchors and associations; only new/incidental Seerr associations receive an origin; independent proof does not promote other incidental members |
| `RequestTitleIdentity.Learn` (including `Entry` and background `Reconcile`) | Record all arr-only groups reached by the resolver with independent rank first, then pass combined resolution through the same ranked ledger join; existing effect/database fences remain |
| `RequestLedger.AcceptActiveAliases` from `CreateCore`, `ApproveCore`, and `ImportSeerr` | Explicit acceptance/import upgrades current visible associations only; origin removal is a promotion and cannot affect hidden associations |
| `AcquireDatabase` additive schema-4 initialization | Existing accepted request/acquisition groups stay durable; unaccepted legacy associations receive conservative process/generation origins, once |

Native library poster tags retain their native publication lifecycle across adoption. Their
snapshot is independent native metadata, checked by the compiled producer proof; replacing a
published snapshot with an empty dictionary while keeping its version is not a valid miss.
The proof follows stored callback initializers, static initializer side effects and assignment sites, as well as async/iterator
bodies. Producer discovery recognizes conditional cache stores (`?.Add`) as writers.

The log-only warning throttles in `TitlePresentationResultFilter` and `SpoilerUserResolver`
are explicit operational state. They suppress repeated diagnostics, never answer a provider or
make a delivery decision. Keeping them outside the backend monitor also preserves the privacy
rule that delivery takes no blocking backend lock after its final policy check. The operational
inventory records their exact types and purpose; answer caches remain fenced or proven independent.
The notification source guard follows a private facts-scope body only when every reference is
an invocation from its matching owner inside `SeerrFacts.Compose`/`ComposeAsync`/`BackgroundAsync`; a direct caller
around that scope invalidates the mapping and is a retained negative calibration.
