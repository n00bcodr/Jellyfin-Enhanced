# Backend tests

`JE.Tests.csproj` is the single xUnit project for both Jellyfin compatibility targets. Feature directories organize cases; the SDK automatically includes nested C# files, so adding a test does not require editing a file list.

```sh
python3 tests/run.py backend
dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --filter FullyQualifiedName~Privacy
```

Run from the repository root with the runtimes described in the [setup guide](../docs/README.md). Use distinct `--artifacts-path` values when building targets concurrently.

`Api/` covers controller and request-pipeline contracts; `Core/` covers configuration, persistence and core services; `Integrations/` covers external providers using synthetic transports; `PosterTags/` covers native rendering and tag caches; `Privacy/` covers identity, policy and content isolation; `ScheduledTasks/` covers background jobs.

Every cache the plugin keeps (a dictionary, set, list, queue, MemoryCache, ConditionalWeakTable, Lazy memo or held user, found in the plugin's source by `Users/UserCacheScan.cs`) is listed in `tests/fixtures/user-caches/user-caches.tsv`: `stamped` (declared as `Helpers/UserAccessCache.cs`, which follows the user as each request reads them and their Jellyfin user version, and never serves what a computation running across an invalidation produced), `keyed` (its key holds the viewer's access as the asking request read it; the row names the key builder and what it must contain) or `independent` with the reason it doesn't depend on a user's access. `UserCacheRegistryTests` fails on a cache nobody listed, a `stamped` row that isn't the helper, a key builder that no longer keys by the access, and a row whose cache is gone. A new cache that depends on what a user may see is declared as `UserAccessCache`. The scan also sees a snapshot swapped whole (a mutable field of one of the plugin's own types that holds a collection). A value carries the stamp of the inputs it was computed from: `UserCacheStampSourceTests` fails on a version sampled anywhere but the read itself (`UserAuthority.Read`) and the helper's fingerprint ticket, on a version made up (`new`/`default`/`with`), on a held read that puts a value and a version together from different calls, and on a held ticket whose version isn't the `.Stamp` of a read. `UserAccessCacheInterleavingTests` runs the helper's invalidation bookkeeping under every schedule of rollovers, full invalidations, same-key invalidations, a computation and a save with at most two preemptions (three for full invalidations racing each other; a bounded, generated search), and `WrittenStateCacheInterleavingTests` the same for the written-state helper. One read of a person is one stamp: their version and the instant they were read on the monotonic clock (`Helpers/MonotonicClock.cs`); a value computed from the read lives from that instant and never past the deadline of a cache it came through (`UserCacheReadInstantTests`, `UserCacheClockTests`). State JE writes itself and drops on a write is `ticketed` (declared as `Helpers/WrittenStateCache.cs`, on the same ticket protocol, `Helpers/InvalidationLedger.cs`); a cache the scan sees dropped outside the code that fills it needs a `write:` rule the scan can check (`fenced=<generation>`, `locked=<lock>`) or a stated disposition (`self-keyed`, `own-state`, `per-call`, `disposal`, `evicts`), and "invalidated on write" is never a reason. A keyed computation decides with the viewer it is keyed by: the scan follows the code of a `keyed` row's types (and every plugin method they call) and fails on a read of the user or their policy by id, except the one `snapshot:` read the row allows (`UserCacheRound4ScanTests`). An answer lives from when its read began and a fence is sampled before the inputs it covers are read: the scan fails a store that stamps what it keeps with the clock after awaiting its read, and a `fenced=` generation sampled after an await or a configuration read (`UserCacheScanRound5.cs`; a time that isn't an answer's lifetime, such as a schedule or a back-off, is listed with a `deadline:` rule). `UserCacheSeerrDeadlineTests` drives the Seerr chain (an account id copied from a held lookup, prepared facts from held settings, a missing mapping, a reassigned account) and `AccessRevisionTests` the `X-JE-Revision` every JE answer carries. The browser's caches of server answers are listed in `tests/fixtures/user-caches/js-caches.tsv` (state a factory's closure keeps included) and checked by `tests/frontend/core/core-user-caches.test.mjs` and `core-access-contract.test.mjs`.

Reuse fixtures in `Support/` for disposable storage, the plugin singleton and controlled HTTP. Tests changing the singleton must use `[Collection("Plugin singleton")]`. Keep single-feature fakes with their tests. Assert public responses, persistence and observable side effects; do not turn a production implementation into its own expected-value oracle.

Real Jellyfin installations belong to `../host/`, not this project. History replay manifests select these same tests rather than maintaining duplicate implementations.

## Response ownership and media streaming

`PrivacyCommitFilter` attaches the outer HTTP commit owner before resource projections. Unknown routes retain that
owner: JSON, HTML, native title DTOs, lists, status and classified images cannot emit bytes before final validation.
An existing response guard or a route admitted by `PrivacyResponseGuard.Owns` also retains ownership.

`Services/MediaResponseContract.cs` lists the only exception: actual `Jellyfin.Api` controller methods delivering raw
playback bytes or transport playlists. Controller/action strings, binary MIME types and body contents cannot select
the exception. There is no extra buffer or size threshold on these responses; transport writes and flushes remain
progressive. Host authentication, parental admission to playback and range handling remain the host's responsibility.

| Host controller | Streaming actions | Reason |
| --- | --- | --- |
| Audio, Videos | GetAudioStream/GetVideoStream and their ByContainer variants (4) | Raw audio/video, including transcode output and byte ranges |
| UniversalAudio | GetUniversalAudioStream (1) | Raw audio or host redirect |
| DynamicHls | GetLiveHlsStream, GetMasterHlsAudioPlaylist/GetMasterHlsVideoPlaylist, GetVariantHlsAudioPlaylist/GetVariantHlsVideoPlaylist, GetHlsAudioSegment/GetHlsVideoSegment (7) | Playback manifests and media segments |
| HlsSegment | GetHlsAudioSegmentLegacy, GetHlsPlaylistLegacy, GetHlsVideoSegmentLegacy (3) | Legacy playback manifests and segments |
| LiveTv | GetLiveRecordingFile, GetLiveStreamFile (2) | Live/recorded video bytes |
| Subtitle | GetRemoteSubtitles, GetSubtitle, GetSubtitleWithTicks, GetSubtitlePlaylist (4) | Subtitle bytes and transport manifest |
| All other host actions and every JE action | Owned | Protected unless explicitly proven to be raw playback; artwork/trickplay images, title metadata and unknown routes stay conservative |

`PrivacyMediaStreamingTests` uses deterministic transport ordering and a counting sink. Its 200 MiB cases measure
the largest outstanding byte count after every write and bound allocations while reusing one input block. It also
executes MVC file/stream/range and pipe writers through the legacy collage wrapper. Metadata controls change a
privacy dependency before completion and require zero transport bytes and a withheld response, including when the
metadata declares a video MIME type.

The authenticated non-seekable `FileStreamResult` controls retain the round-8 reviewer's producer shape, with both
ordinary flush and explicit `StartAsync`. An awaitable flush barrier checks server transport start and then reads the
client's four-byte prefix while the producer remains open; the assertion uses no sleep or delay race.

`MediaResponseContractArchitectureTests` checks both directions against the pinned host assembly's independent
audio/video/playlist annotations and subtitle file declarations. Its planted controls reject a media action classified
as metadata and a metadata action classified as media. A host upgrade or a new media action must update and review
the explicit contract, rather than broadening it by route prefixes, file extensions or content sniffing.
