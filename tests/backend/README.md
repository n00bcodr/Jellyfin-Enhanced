# Backend tests

`JE.Tests.csproj` is the single xUnit project for both Jellyfin compatibility targets. Feature directories organize cases; the SDK automatically includes nested C# files, so adding a test does not require editing a file list.

```sh
python3 tests/run.py backend
dotnet test tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12 --filter FullyQualifiedName~Privacy
```

Run from the repository root with the runtimes described in the [setup guide](../docs/README.md). Use distinct `--artifacts-path` values when building targets concurrently.

`Api/` covers controller and request-pipeline contracts; `Core/` covers configuration, persistence and core services; `Integrations/` covers external providers using synthetic transports; `PosterTags/` covers native rendering and tag caches; `Privacy/` covers identity, policy and content isolation; `ScheduledTasks/` covers background jobs.

Every cache the plugin keeps (a dictionary, set, list, queue, MemoryCache, ConditionalWeakTable, Lazy memo or held user, found in the plugin's source by `Users/UserCacheScan.cs`) is listed in `tests/fixtures/user-caches/user-caches.tsv`: `stamped` (declared as `Helpers/UserAccessCache.cs`, which follows the user as each request reads them and their Jellyfin user version, and never serves what a computation running across an invalidation produced), `keyed` (its key holds the viewer's access as the asking request read it; the row names the key builder and what it must contain) or `independent` with the reason it doesn't depend on a user's access. `UserCacheRegistryTests` fails on a cache nobody listed, a `stamped` row that isn't the helper, a key builder that no longer keys by the access, and a row whose cache is gone. A new cache that depends on what a user may see is declared as `UserAccessCache`. The scan also sees a snapshot swapped whole (a mutable field of one of the plugin's own types that holds a collection). A value carries the stamp of the inputs it was computed from: `UserCacheStampSourceTests` fails on a version sampled anywhere but the read itself (`UserAuthority.Read`) and the helper's fingerprint ticket, on a version made up (`new`/`default`/`with`), on a held read that puts a value and a version together from different calls, and on a held ticket whose version isn't the `.Stamp` of a read. `UserAccessCacheInterleavingTests` runs the helper's invalidation bookkeeping under every schedule of rollovers, full invalidations, same-key invalidations, a computation and a save with at most two preemptions (three for full invalidations racing each other; a bounded, generated search), and `WrittenStateCacheInterleavingTests` the same for the written-state helper. One read of a person is one stamp: their version and the instant they were read on the monotonic clock (`Helpers/MonotonicClock.cs`); a value computed from the read lives from that instant and never past the deadline of a cache it came through (`UserCacheReadInstantTests`, `UserCacheClockTests`). State JE writes itself and drops on a write is `ticketed` (declared as `Helpers/WrittenStateCache.cs`, on the same ticket protocol, `Helpers/InvalidationLedger.cs`); a cache the scan sees dropped outside the code that fills it needs a `write:` rule the scan can check (`fenced=<generation>`, `locked=<lock>`) or a stated disposition (`self-keyed`, `own-state`, `per-call`, `disposal`, `evicts`), and "invalidated on write" is never a reason. A keyed computation decides with the viewer it is keyed by: the scan follows the code of a `keyed` row's types (and every plugin method they call) and fails on a read of the user or their policy by id, except the one `snapshot:` read the row allows (`UserCacheRound4ScanTests`). An answer lives from when its read began and a fence is sampled before the inputs it covers are read: the scan fails a store that stamps what it keeps with the clock after awaiting its read, and a `fenced=` generation sampled after an await or a configuration read (`UserCacheScanRound5.cs`; a time that isn't an answer's lifetime, such as a schedule or a back-off, is listed with a `deadline:` rule). `UserCacheSeerrDeadlineTests` drives the Seerr chain (an account id copied from a held lookup, prepared facts from held settings, a missing mapping, a reassigned account) and `AccessRevisionTests` the `X-JE-Revision` every JE answer carries. Everything that depends on a person's Seerr account holds their Seerr account authority (`Helpers/Jellyseerr/SeerrAccountAuthority.cs`: the person, the Seerr their configuration points at, and the generation of the account link Seerr was last read to hold) or is keyed by it, a row's `authority:` rule says which and the registry test checks it; an instant such a cache (or a `ticketed` one) keeps is on the monotonic clock (`UserCacheScanRound6.cs`; a calendar date is listed with `wall:`). `SeerrAccountAuthorityTests` drives a running lookup across a fresh read that finds the link gone or changed (both caches cold), a confirmed new account's cached answers, a preparation held at its quota read, the 15-second Seerr settings on a stepped wall clock, and the legacy automatic requests across a Seerr repointing and a reassignment. The browser's caches of server answers are listed in `tests/fixtures/user-caches/js-caches.tsv` (state a factory's closure keeps included) and checked by `tests/frontend/core/core-user-caches.test.mjs` and `core-access-contract.test.mjs`.

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

There are 19 unconditional transport actions and two conditional raw-file actions. Master playlists remain
owned: `TitlePresentationResultFilter` resolves the same live identity and title-family reveal as PlaybackInfo,
rebuilds protected subtitle labels, omits protected trickplay references and installs its read-set before validation.
The outer owner validates again after the executor and resource projections finish. Malformed host title quoting
is withheld. Every other image, trickplay image manifest and image-info result also remains owned.

| Pinned host action | Why its body can stream |
| --- | --- |
| Audio.GetAudioStream | AudioHelper file/progressive/transcode payload; no presentation DTO |
| Audio.GetAudioStreamByContainer | Same audio payload in the requested container |
| Videos.GetVideoStream | Video file/transcode bytes and ranges; no generated title document |
| Videos.GetVideoStreamByContainer | Delegates to the same video payload |
| UniversalAudio.GetUniversalAudioStream | AudioHelper payload or host redirect |
| DynamicHls.GetLiveHlsStream | Generated segment timing/URLs; no title-family labels |
| DynamicHls.GetVariantHlsVideoPlaylist | Main transport durations/URLs/codecs; no track titles |
| DynamicHls.GetVariantHlsAudioPlaylist | Same main transport generator; no title fields |
| DynamicHls.GetHlsVideoSegment | File/transcode video segment bytes |
| DynamicHls.GetHlsAudioSegment | File/transcode audio segment bytes |
| HlsSegment.GetHlsAudioSegmentLegacy | Validated transcode-file audio bytes |
| HlsSegment.GetHlsPlaylistLegacy | Rewritten FFmpeg transport timing/URLs; no free-form labels |
| HlsSegment.GetHlsVideoSegmentLegacy | Validated video segment-file bytes |
| LiveTv.GetLiveRecordingFile | Progressive recording-file bytes, no programme DTO |
| LiveTv.GetLiveStreamFile | Progressive live-source bytes, no programme DTO |
| Subtitle.GetRemoteSubtitles | Provider subtitle content, not subtitle search metadata |
| Subtitle.GetSubtitle | Encoded subtitle events, graphical file/ranges or timestamp-mapped VTT |
| Subtitle.GetSubtitleWithTicks | Same subtitle content with a start tick |
| Subtitle.GetSubtitlePlaylist | VTT segment duration/range/URL manifest, no free-form labels |
| Library.GetDownload (conditional) | Only the range-enabled PhysicalFileResult matching a native Audio/Video item's path and audio/video file type; photos, books, metadata and installed classifications retain ownership |
| Library.GetFile (conditional) | Same native physical audio/video and range contract; every other file result remains owned |

The mixed download contract is selected explicitly at resource entry and resolved at its concrete file executor,
before any file byte. It cannot release previously written bytes or an existing privacy/evidence dependency. MIME
alone grants no exception. Host download authorization and the MVC file executor retain their range/HEAD behavior.
`PrivacyGeneratedPlaylistTests` executes the pinned host's shared subtitle generator for both master actions;
`PrivacyRawDownloadTests` executes the actual native download action and its physical-file executor. The architecture
oracle distinguishes generated masters and the generic audio/video file annotation, while both planted label errors
remain findings. Host upgrades require re-auditing these body contracts, not merely accepting playlist annotations.

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
the explicit contract. Route prefixes, MIME declarations and file extensions alone never grant the exception.
