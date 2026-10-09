using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.Querying;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Manages a server-side pre-computed tag cache for all library items.
    /// The cache is stored in memory (ConcurrentDictionary) and persisted to disk as JSON.
    /// Clients fetch the full cache in one GET request instead of making per-page batch calls.
    /// </summary>
    public class TagCacheService : IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IApplicationPaths _applicationPaths;
        private readonly ILocalizationManager _localization;
        private readonly Logger _logger;

        // Memo for LanguageIdentity: a library uses a few dozen distinct codes,
        // and the culture lookup behind it is a linear scan.
        private readonly ConcurrentDictionary<string, string> _languageIdentities = new(StringComparer.Ordinal);
        private volatile ConcurrentDictionary<string, TagCacheEntry> _cache = new();
        private readonly object _saveLock = new();

        /// <summary>
        /// What one episode contributes to its parents' Series/Season entries:
        /// its audio languages (null when it has no audio/video streams, so it
        /// can't be a tag source) and, when its own entry was built in the same
        /// pass, that entry's stream data. Kept per episode id for the length of
        /// one full build, reconcile or incremental batch (see
        /// <see cref="BuildEntryForItem"/>), so an episode's streams are read once
        /// however many of its parents are rebuilt alongside it.
        /// <see cref="Placement"/> is what the full build needs to file the
        /// episode under its containers without re-querying them; set whenever
        /// the episode's own entry was built in the pass (or the full build
        /// hydrated it for its containers).
        /// </summary>
        private readonly record struct EpisodeScan(string[]? Languages, TagStreamData? StreamData, EpisodePlacement? Placement = null);

        /// <summary>
        /// The fields of an episode its parents' entries read: where it sits in
        /// the tree (<see cref="ParentId"/>, <see cref="SeasonId"/> — together
        /// they decide which containers it belongs to, see
        /// <see cref="BuildContainerEpisodeIndex"/>), whether it is a special
        /// (<see cref="ParentIndexNumber"/>), the genres a container without its
        /// own falls back to, and its scan sort key (<see cref="SortDate"/>,
        /// <see cref="SortName"/>, only compared to break ties). All are stored
        /// columns of the episode's row, so they are what the container's own
        /// episode query would have hydrated.
        /// </summary>
        private readonly record struct EpisodePlacement(
            Guid ParentId,
            Guid SeasonId,
            int? ParentIndexNumber,
            string[] Genres,
            DateTime? SortDate,
            int? SortYear,
            string? SortName)
        {
            public static EpisodePlacement Of(MediaBrowser.Controller.Entities.TV.Episode episode)
            {
                // Jellyfin's PremiereDate sort key: the premiere date, else
                // January 1st of the production year. A year that has no such
                // date is kept as itself so it only ties with the same year.
                var year = episode.PremiereDate == null ? episode.ProductionYear : null;
                var sortDate = episode.PremiereDate
                    ?? (year is >= 1 and <= 9999 ? DateTime.MinValue.AddYears(year.Value - 1) : null);
                return new(
                    episode.ParentId,
                    episode.SeasonId,
                    episode.ParentIndexNumber,
                    episode.Genres,
                    sortDate,
                    sortDate == null ? year : null,
                    episode.SortName);
            }

            /// <summary>Whether the scan's ORDER BY ranks the two equal.</summary>
            public bool SortsEqualTo(in EpisodePlacement other) =>
                SortDate == other.SortDate
                && SortYear == other.SortYear
                && string.Equals(SortName, other.SortName, StringComparison.Ordinal);
        }

        /// <summary>
        /// Per-pass <see cref="EpisodeScan"/> memo, keyed by episode id.
        /// Concurrent because the full build fills it from parallel workers.
        /// <see cref="Pending"/> is set by the incremental passes (flush batch,
        /// reconcile) to the ids being rebuilt in that pass: every other episode
        /// already has a current entry in the live cache, so a container scan
        /// takes its languages from there instead of re-reading its streams (a
        /// 400-episode series touched by one episode change would otherwise open
        /// 400 files). Null for the full build, whose live cache is the previous
        /// generation. <see cref="ContainerIndex"/> is set by the full build only,
        /// between its episode and container passes (see
        /// <see cref="BuildFullCacheBody"/>); while it is set, container scans
        /// read their episodes from it instead of querying the library (all but
        /// its <see cref="ContainerEpisodeIndex.PagedScan"/> containers).
        /// </summary>
        private sealed class EpisodeScanMemo : ConcurrentDictionary<Guid, EpisodeScan>
        {
            public IReadOnlySet<Guid>? Pending { get; init; }

            public ContainerEpisodeIndex? ContainerIndex { get; set; }
        }

        /// <summary>
        /// The full build's answer to every container's episode query, computed
        /// once from one library-wide ordered episode list: for each Series/
        /// Season id, its non-virtual episodes in scan order
        /// (<see cref="Members"/>), plus the few episodes that had no entry of
        /// their own in the episode pass (<see cref="Late"/>, e.g. added after
        /// its id query), hydrated here so a container can read them the way its
        /// scan would have. <see cref="PagedScan"/> lists the containers whose
        /// scan order the list can't reproduce (sort-key ties across one of the
        /// scan's page boundaries); they run their own scan instead. Read-only
        /// once built, so parallel container builds share it without locking.
        /// </summary>
        private sealed class ContainerEpisodeIndex
        {
            public ContainerEpisodeIndex(
                Dictionary<Guid, List<Guid>> members,
                Dictionary<Guid, MediaBrowser.Controller.Entities.TV.Episode> late,
                HashSet<Guid> pagedScan)
            {
                Members = members;
                Late = late;
                PagedScan = pagedScan;
            }

            public Dictionary<Guid, List<Guid>> Members { get; }

            public Dictionary<Guid, MediaBrowser.Controller.Entities.TV.Episode> Late { get; }

            public HashSet<Guid> PagedScan { get; }
        }

        /// <summary>
        /// A container's representative episode, as its entry needs it: genres
        /// for the fallback and the stream data its quality tags come from —
        /// shared from the episode's own entry when this pass built it,
        /// otherwise read from <see cref="Item"/>.
        /// </summary>
        private sealed record RepresentativeEpisode(string[] Genres, TagStreamData? StreamData, BaseItem? Item);

        // Workers per page in the full build. Every item's entry is independent
        // of the others' (episodes only feed containers, which run in a later
        // pass), and the per-item work is Jellyfin read paths (stream rows,
        // alternate versions, parent lookups) plus one Matroska header read, so
        // a few workers overlap the database and file latency. Kept small so a
        // build never crowds out request handling.
        private static readonly int BuildParallelism = Math.Clamp(Environment.ProcessorCount, 1, 4);

        // Guards the {_cacheReleased, _cache, _version, _lastModified} generation
        // as one unit for readers. Publish/release sites mutate all four inside
        // this lock (nested within _saveLock, always in that order), and snapshot
        // readers (GetCacheForUser) take ONLY this lock — its critical sections
        // are a handful of field accesses, so readers never stall behind a
        // multi-second SaveToDisk serialization the way they would on _saveLock.
        private readonly object _publishLock = new();
        private readonly SemaphoreSlim _rebuildLock = new(1, 1);
        private long _version;
        private long _lastModified;
        private long _lastReconciledUtcTicks;
        private Timer? _debounceSaveTimer;
        private volatile bool _dirty;
        private long _firstDirtyTicks; // 0 = nothing dirty since the last disk save
        private long _lastDirtyTicks;  // time of the most recent unsaved change (trailing debounce)

        // Newest LastUpdated any entry of the published cache can carry. Raised
        // BEFORE an entry is stored (RebuildEntry) and set with every publish, so
        // a delta request whose cursor is at or past it knows — without walking
        // the cache — that no entry would pass the LastUpdated filter. Only ever
        // too high (removals don't lower it), which merely costs the walk.
        private long _maxLastUpdated;

        // Number of passes currently mutating the published dictionary in place
        // (a flush batch, the reconcile's rebuild/sweep). Writers bracket their
        // mutations AND the version/timestamp bump that follows them with an
        // InPlaceWriteScope (see BeginInPlaceWrites).
        private int _inPlaceWriters;

        // Mutation epoch: bumped after EVERY change to the cache contents — each
        // in-place entry store or removal (StoreEntry/TryRemoveEntry), every
        // dictionary swap (publish, load, release; inside _publishLock), and once
        // more when an in-place write scope that saw any change exits, however it
        // exits (exception and cancellation included). The shared per-state
        // results below (access digests, serialized items) are keyed by it and
        // only computed, used or stored when a reader saw no writer active and
        // the same epoch before AND after its work (see IsUnchangedSince): the
        // version/timestamp pair alone does not pin the contents, since in-place
        // writes land before (or, on an aborted pass, without) the timestamp bump.
        private long _mutationEpoch;

        // Disk-save cadence: a save runs 30s after the last applied change, but under
        // sustained change (a metadata refresh where values really do change on every
        // item) the trailing debounce would keep pushing the save out — so cap the
        // deferral at 5 minutes from the first unsaved change. Worst case is one
        // full-cache write per 5 minutes instead of one per flush cycle (~30s).
        private static readonly TimeSpan SaveDebounce = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan SaveMaxWait = TimeSpan.FromMinutes(5);

        // While Jellyfin's library scan runs, new and changed items keep arriving
        // for as long as it lasts (hours for a big import) with gaps long enough
        // for the 30s debounce to fire, and every save rewrites the whole file
        // (tens of MB on large libraries): stretch both to 10 minutes, so a scan
        // costs one write per 10 minutes — the most a crash can lose — plus one
        // shortly after it ends. An armed save re-checks the scan state every
        // ScanSavePoll (OnSaveTimer), so the end of a scan is noticed within that
        // interval rather than up to ten minutes later.
        private static readonly TimeSpan ScanSaveDebounce = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan ScanSaveMaxWait = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan ScanSavePoll = TimeSpan.FromSeconds(30);

        // On-disk serialization: nulls omitted. Every nullable property of the
        // persisted types (TagCacheDiskFormat, TagCacheEntry, TagStreamData,
        // TagMediaStream, TagMediaSource) reads back as null whether it was absent
        // or an explicit null, and the non-nullable ones (SchemaVersion, Version,
        // LastModified, LastReconciledUtcTicks, LastUpdated, Items) are never
        // null, so LoadFromDisk (default options) is unaffected and the file is
        // roughly a third smaller. One shared instance: System.Text.Json caches
        // its type metadata per options object.
        private static readonly JsonSerializerOptions DiskJsonOptions = new()
        {
            WriteIndented = false,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        // Incremental cache maintenance. Library-scan events are recorded here (O(1),
        // no DB/probe work) and drained by a debounced background worker so scans are
        // never blocked and repeated hits on the same id coalesce to one rebuild.
        private readonly TagCachePendingChanges _pending = new();
        private Timer? _flushTimer;
        private long _firstPendingTicks; // 0 = nothing pending since last flush
        private int _flushing;           // 0/1 non-reentrancy guard for the worker
        private volatile bool _disposed; // set in Dispose; stops timer resurrection after teardown
        private static readonly TimeSpan FlushDebounce = TimeSpan.FromSeconds(3);
        private static readonly TimeSpan FlushMaxWait = TimeSpan.FromSeconds(30);

        // Bump whenever persisted cache data or its semantics change in a way
        // that makes entries created by an older build incorrect. v2 added
        // SeriesId for Spoiler Guard stripping. v3 preserves authoritative
        // Matroska LanguageBCP47/LanguageIETF audio languages instead of the
        // region-less values exposed by Jellyfin/FFmpeg.
        // v4 picks a real episode with streams as the Series/Season tag source, requires actual audio/video streams and searches beyond the first page.
        // v6 makes Series/Season AudioLanguages the union across all episodes and adds
        // PartialAudioLanguages for languages missing from some of them, and adds
        // OfficialRating (age rating) with the Series fallback for Seasons/Episodes.
        // (It skips v5 so caches written by builds carrying only one of the two are discarded too.)
        // v7 stops storing stream data the client derives from another field anyway
        // (see BuildStreamData / ExtractMediaData): a source Name that is just its
        // Path without the extension, an ItemPath equal to a source Path, and the
        // VideoRangeType of audio streams. Every client reads them with an empty
        // fallback, and the served payload shrinks by roughly a fifth.
        // A schema mismatch discards the stale cache so it can be rebuilt.
        private const int CurrentCacheSchemaVersion = 7;

        // Page size for hydrating library items during full builds and
        // reconciliation. Fetching the whole library with one GetItemList call
        // materializes every BaseItem (full metadata, people, streams) at once,
        // which on very large libraries (tens of thousands of items) can exceed
        // the server's memory and OOM-kill Jellyfin. Fetching ids first and then
        // hydrating in fixed-size pages bounds peak memory to one page of items
        // regardless of library size. The resulting TagCacheEntry objects are
        // small (a few hundred bytes) so the cache itself stays cheap.
        private const int HydrationPageSize = 500;

        // What HydrateInPages loads per item: the stored columns (genres,
        // ratings, name, path, series/season ids and numbers, the version and
        // linked-children data GetMediaSources reads) plus provider ids for the
        // TMDB ids. The default options would also join every image row and
        // every user's user-data row, which no entry reads; the hydrated items
        // are never saved back. A fresh instance per query: Jellyfin may adjust
        // a query's options.
        private static DtoOptions HydrationOptions => new(false)
        {
            Fields = new[] { ItemFields.ProviderIds },
            EnableImages = false,
            EnableUserData = false
        };

        // User access cache: avoids expensive GetItemIds query on every request
        private readonly ConcurrentDictionary<string, UserAccess> _userAccessCache = new();
        private static readonly TimeSpan UserAccessCacheTtl = TimeSpan.FromSeconds(60);

        /// <summary>
        /// One user's cached access set (see <see cref="_userAccessCache"/>) and,
        /// once a request has walked the cache with it, the excluded-key digest
        /// that walk produced for the cache generation it saw.
        /// </summary>
        private sealed class UserAccess
        {
            public UserAccess(HashSet<string> ids, DateTime cachedAt, long generation)
            {
                Ids = ids;
                CachedAt = cachedAt;
                Generation = generation;
            }

            public HashSet<string> Ids { get; }
            public DateTime CachedAt { get; }
            public long Generation { get; }

            /// <summary>
            /// Memo of the <c>accessRevision</c> this set yields for one cache
            /// state (see <see cref="AccessDigest"/>): the digest covers only
            /// which KEYS the set excludes, so for an unchanged state it is the
            /// same on every request and a delta that has nothing newer than its
            /// cursor can answer without the walk (see GetCacheForUser).
            /// </summary>
            public volatile AccessDigest? Digest;
        }

        /// <summary>
        /// The excluded-key digest of one access set over the cache state of
        /// one <see cref="_mutationEpoch"/>, recorded only by a walk that saw
        /// that state unchanged throughout (see <see cref="IsUnchangedSince"/>).
        /// </summary>
        private sealed record AccessDigest(long Epoch, string Revision);

        /// <summary>
        /// A snapshot reader's view of the published generation: the dictionary
        /// with the version/timestamp published alongside it, the newest
        /// LastUpdated it can hold (<see cref="_maxLastUpdated"/>) and the
        /// mutation epoch, all taken under <see cref="_publishLock"/>.
        /// <see cref="Quiescent"/> is whether no in-place writer was active
        /// and the epoch did not move while it was taken (see
        /// CaptureGeneration and IsUnchangedSince).
        /// </summary>
        private readonly record struct CacheGeneration(ConcurrentDictionary<string, TagCacheEntry> Cache, long Version, long Timestamp, long MaxLastUpdated, long Epoch, bool Quiescent);

        /// <summary>
        /// Identifies the content of a shareable serialized <c>items</c> object:
        /// the generation (version/timestamp) and mutation epoch of the cache
        /// state it was serialized from, and the access digest of the entries
        /// that state's filter excluded. Only for responses without a Spoiler
        /// Guard strip (strip state "none"), the only ones that are shared.
        /// Issued by the service only for a walk that saw its state unchanged
        /// throughout (see GetShareableCacheForUser), so callers can't forge one.
        /// </summary>
        public sealed class SerializedItemsKey
        {
            internal SerializedItemsKey(long version, long timestamp, long epoch, string accessRevision)
            {
                Version = version;
                Timestamp = timestamp;
                Epoch = epoch;
                AccessRevision = accessRevision;
            }

            public long Version { get; }
            public long Timestamp { get; }
            public long Epoch { get; }
            public string AccessRevision { get; }

            internal bool Matches(long version, long timestamp, long epoch, string accessRevision) =>
                Version == version && Timestamp == timestamp && Epoch == epoch
                && string.Equals(AccessRevision, accessRevision, StringComparison.Ordinal);
        }

        // Serialized `items` of whole-cache responses (GetTagCache), keyed by
        // SerializedItemsKey: a user without a Spoiler Guard strip gets exactly
        // the state's entries their access set admits, so every such request —
        // and every user with the same access, which for unrestricted users is
        // all of them — can send the same bytes instead of re-serializing tens
        // of MB (and the ETag is a hash of the bytes sent, so it is shared too).
        // Bounded by count and total size, least recently used first; dropped
        // whenever the dictionary is swapped (publish, load, release) and
        // superseded by any newer epoch.
        private sealed class SerializedItems
        {
            public SerializedItems(SerializedItemsKey key, byte[] json, int count)
            {
                Key = key;
                Json = json;
                Count = count;
                LastUsedTicks = DateTime.UtcNow.Ticks;
            }

            public SerializedItemsKey Key { get; }
            public byte[] Json { get; }
            public int Count { get; }
            public long LastUsedTicks { get; set; }
        }

        private readonly List<SerializedItems> _serializedItems = new();
        private readonly object _serializedItemsLock = new();
        private const int SerializedItemsMaxEntries = 4;
        private const long SerializedItemsMaxBytes = 64L * 1024 * 1024;
        // Bumped by InvalidateUserAccess. Each cached access set records the
        // generation it was computed under and is only used while that is still
        // current, so a set computed before a bump (user policy or library
        // changed meanwhile) can serve its own request but never a later one —
        // even if it lands in the dictionary after the clear.
        private long _userAccessGeneration;

        /// <summary>
        /// Drop every cached per-user access set, so the next request filters
        /// with the user's current access. Called when a user's policy changes
        /// and when library changes are applied to the cache: tag-cache deltas
        /// are filtered by this set and clients keep their copy across page
        /// loads, so a stale set would either skip a newly added item for good
        /// (its update is behind the cursor by the time the set refreshes) or
        /// hide an access change from the filterRevision.
        /// </summary>
        public void InvalidateUserAccess()
        {
            Interlocked.Increment(ref _userAccessGeneration);
            _userAccessCache.Clear();
        }

        public static readonly HashSet<BaseItemKind> TaggableTypes = new()
        {
            BaseItemKind.Movie,
            BaseItemKind.Episode,
            BaseItemKind.Series,
            BaseItemKind.Season,
            BaseItemKind.BoxSet,
            BaseItemKind.Video,
        };

        /// <summary>
        /// Series and Season entries are derived from their episodes.
        /// </summary>
        private static bool IsContainerKind(BaseItemKind kind) => kind == BaseItemKind.Series || kind == BaseItemKind.Season;

        public TagCacheService(ILibraryManager libraryManager, IApplicationPaths applicationPaths, ILocalizationManager localizationManager, Logger logger)
        {
            _libraryManager = libraryManager;
            _applicationPaths = applicationPaths;
            _localization = localizationManager;
            _logger = logger;

            // The service is a DI singleton; expose it so the plugin's
            // UpdateConfiguration override can reach the running instance when the
            // admin toggles the Server-Side Tag Cache setting (same pattern as
            // JellyfinEnhanced.Instance — the plugin class has no DI access).
            Instance = this;
        }

        /// <summary>
        /// The running singleton, for the config-save transition hook in
        /// <see cref="JellyfinEnhanced.UpdateConfiguration"/>. Null until DI
        /// constructs the service (and again after disposal).
        /// </summary>
        internal static TagCacheService? Instance { get; private set; }

        /// <summary>
        /// Live read of the admin "Server-Side Tag Cache" setting. Long-running
        /// builds re-check this at page boundaries so an admin turning the cache
        /// off (e.g. under memory pressure) actually stops the work instead of
        /// only preventing the next run.
        /// </summary>
        private static bool ServerModeEnabled => JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode == true;

        /// <summary>
        /// Shared abort condition for every expensive or state-publishing cache
        /// phase (build pages, reconcile rebuild/sweep loops, publishes, saves):
        /// stop when the admin turned the setting off OR the service is being
        /// torn down. Checked mid-run, not just at entry, so neither a disable
        /// nor a shutdown has to wait behind a large-library operation.
        /// </summary>
        private bool ShouldAbortCacheWork => _disposed || !ServerModeEnabled;

        // True whenever the in-memory cache is NOT a published complete state:
        // from construction until the first successful LoadFromDisk/full-build
        // publish, and again between OnServerModeDisabled releasing the cache and
        // the next publish. Distinguishes "empty/placeholder" from "has real
        // entries": an incremental flush landing while unpublished (e.g. after a
        // failed startup build, or in the release->re-enable window) would make
        // the cache non-empty with a stray entry, and gating full builds and
        // snapshot reloads on IsEmpty alone would then mistake that near-empty
        // cache for a complete one — delta-reconciling and even persisting it.
        // While true: flushes defer, SaveToDisk refuses, reconcile full-builds.
        private volatile bool _cacheReleased = true;

        // Serializes server-mode transitions (and orders them after one another)
        // off the config-save thread. ContinueWith chaining keeps strict FIFO
        // order for rapid toggles; each queued transition re-reads the CURRENT
        // setting when it runs, so intermediate flips converge on the final state
        // instead of racing each other's release/reload work.
        private Task _transitionQueue = Task.CompletedTask;
        private readonly object _transitionQueueLock = new();

        public long Version => Interlocked.Read(ref _version);
        public long LastModified => Interlocked.Read(ref _lastModified);
        public int Count => _cache.Count;

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "tag-cache.json");

        /// <summary>
        /// Build the complete tag cache for all library items.
        /// Called by the scheduled task on startup and periodically.
        /// </summary>
        public void BuildFullCache(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            _rebuildLock.Wait(cancellationToken);
            try
            {
                BuildFullCacheCore(progress, cancellationToken, DateTime.UtcNow);
            }
            finally
            {
                _rebuildLock.Release();
            }
        }

        // 0 = idle, 1 = a manual full rebuild is queued or running. Purely a
        // UI-facing guard so a second click gets an immediate "already running"
        // instead of silently queuing behind _rebuildLock; BuildFullCache itself
        // is already safe to call concurrently with anything else in this class.
        private int _manualRebuildInProgress;

        // Number of full builds currently running (BuildFullCacheCore, from any
        // caller: the scheduled task, a reconcile of an empty cache, a manual
        // rebuild), so a manual rebuild requested during one is answered
        // "already in progress" rather than queued to redo the same work.
        private int _fullBuildsRunning;

        /// <summary>
        /// Admin-triggered full rebuild (config page "Rebuild Server Tag Cache"
        /// button). Unlike <see cref="ReconcileCache"/>, this always recomputes
        /// every item regardless of Jellyfin's saved-item timestamps, which is
        /// the only way to pick up a tag-computation change (e.g. this plugin's
        /// own logic changing) for items nobody has actually edited. Runs on a
        /// background thread; returns immediately once started (queued behind
        /// whatever holds the cache — a flush, a reconcile, a server-mode
        /// transition). Returns false — the controller answers "already in
        /// progress" — only when a full build is already running or a manual
        /// one is already queued.
        /// </summary>
        public bool TryStartManualFullRebuild()
        {
            if (Volatile.Read(ref _fullBuildsRunning) != 0
                || Interlocked.CompareExchange(ref _manualRebuildInProgress, 1, 0) != 0)
            {
                return false;
            }

            _ = Task.Run(() =>
            {
                try
                {
                    BuildFullCache(null, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    _logger.Error($"[TagCache] Manual full rebuild failed: {ex.Message}");
                }
                finally
                {
                    Interlocked.Exchange(ref _manualRebuildInProgress, 0);
                }
            });

            return true;
        }

        private void BuildFullCacheCore(IProgress<double>? progress, CancellationToken cancellationToken, DateTime reconciliationStartedUtc)
        {
            Interlocked.Increment(ref _fullBuildsRunning);
            try
            {
                BuildFullCacheBody(progress, cancellationToken, reconciliationStartedUtc);
            }
            finally
            {
                Interlocked.Decrement(ref _fullBuildsRunning);
            }
        }

        private void BuildFullCacheBody(IProgress<double>? progress, CancellationToken cancellationToken, DateTime reconciliationStartedUtc)
        {
            _logger.Info("[TagCache] Starting full cache build...");
            var sw = System.Diagnostics.Stopwatch.StartNew();

            // Ids only — a Guid list is tiny even for huge libraries. The heavy
            // BaseItem hydration happens page by page below so the build never
            // holds more than HydrationPageSize full items at a time.
            // Series/Season last: by the time a container is built, every
            // episode's own entry has already recorded its languages, stream
            // data and placement in the memo below, so containers read no
            // streams and run no episode queries.
            var itemIds = _libraryManager.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = TaggableTypes.Where(kind => !IsContainerKind(kind)).ToArray(),
                TopParentIds = IncludedLibraryIds(),
                IsVirtualItem = false,
                Recursive = true
            });
            var containerIds = _libraryManager.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Series, BaseItemKind.Season },
                TopParentIds = IncludedLibraryIds(),
                IsVirtualItem = false,
                Recursive = true
            });
            var totalCount = itemIds.Count + containerIds.Count;

            _logger.Info($"[TagCache] Found {totalCount} taggable items");

            var newCache = new ConcurrentDictionary<string, TagCacheEntry>();
            var processed = 0;

            // Lives for the whole build because Series/Season come last. Each
            // value only references arrays/objects the episode's cache entry
            // already holds, so the extra cost is one dictionary slot (~50 bytes)
            // per episode, dropped with this frame when the build ends.
            var episodeScans = new EpisodeScanMemo();
            var parallelOptions = new ParallelOptions
            {
                MaxDegreeOfParallelism = BuildParallelism,
                CancellationToken = cancellationToken
            };

            // One pass over a list of ids: each page's entries are built in
            // parallel into a slot per item, then stored in page order, so the
            // dictionary is filled in the same order as a sequential build.
            // BuildEntryForItem never throws (it logs and returns null), and a
            // cancellation surfaces from Parallel.For as the same
            // OperationCanceledException the sequential loop threw. Returns
            // false when the build has to stop (setting disabled / shutdown).
            bool BuildPass(IReadOnlyList<Guid> ids)
            {
                foreach (var page in HydrateInPages(ids, cancellationToken))
                {
                    // Stop promptly if the admin turned the cache off (or the server
                    // is shutting down) mid-build; the partial result is discarded,
                    // not published.
                    if (ShouldAbortCacheWork)
                    {
                        return false;
                    }

                    var entries = new TagCacheEntry?[page.Count];
                    Parallel.For(0, page.Count, parallelOptions, i => entries[i] = BuildEntryForItem(page[i], episodeScans));

                    for (var i = 0; i < page.Count; i++)
                    {
                        if (entries[i] is { } entry)
                        {
                            newCache[page[i].Id.ToString("N").ToLowerInvariant()] = entry;
                        }
                    }

                    // An item deleted between the id query and its page hydration just
                    // doesn't come back, so advance by the page's actual size.
                    processed += page.Count;
                    progress?.Report((double)processed / totalCount * 100);
                }

                return true;
            }

            if (!BuildPass(itemIds))
            {
                _logger.Info("[TagCache] Full build aborted (setting disabled or server shutting down); nothing published.");
                return;
            }

            // Every container's episodes, in scan order, from one ordered query
            // instead of one paged query per container (whose cost grew with the
            // whole library's episode count, see BuildContainerEpisodeIndex).
            if (containerIds.Count > 0)
            {
                var index = BuildContainerEpisodeIndex(containerIds, episodeScans, cancellationToken);
                episodeScans.ContainerIndex = index;
                _logger.Info($"[TagCache] Grouped episodes for {index.Members.Count} containers; {index.PagedScan.Count} with tied episodes across a scan page use their own episode scan");
            }

            if (!BuildPass(containerIds))
            {
                _logger.Info("[TagCache] Full build aborted (setting disabled or server shutting down); nothing published.");
                return;
            }

            // Final gate before publishing (the loop check can't run when the
            // setting flips after the last page). The swap below happens while
            // this thread holds _rebuildLock and OnServerModeDisabled also runs
            // under that lock, so a disable can't interleave with the publish —
            // it either aborts the build here or releases the published cache
            // afterwards.
            if (ShouldAbortCacheWork)
            {
                _logger.Info("[TagCache] Full build aborted (setting disabled or server shutting down); nothing published.");
                return;
            }

            // Atomic reference swap — readers see old or new cache, never partial.
            // Flag, swap AND version/timestamp under _saveLock: a stale-armed save
            // timer can't observe the cleared flag with the placeholder still in
            // _cache, and a snapshot read (GetCacheForUser) can't pair the new
            // dictionary with the previous generation's version/timestamp — a
            // request stamped with a pre-first-publish timestamp of 0 would
            // permanently disable that client's delta refresh.
            var newMaxLastUpdated = MaxLastUpdated(newCache);
            lock (_saveLock)
            {
                lock (_publishLock)
                {
                    _cacheReleased = false;
                    _cache = newCache;
                    Interlocked.Increment(ref _version);
                    Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    Interlocked.Exchange(ref _maxLastUpdated, newMaxLastUpdated);
                    Interlocked.Increment(ref _mutationEpoch);
                    ClearSerializedItems();
                }
            }

            Interlocked.Exchange(ref _lastReconciledUtcTicks, reconciliationStartedUtc.Ticks);
            // Invalidate user access cache since items may have changed
            InvalidateUserAccess();
            progress?.Report(100);

            sw.Stop();
            _logger.Info($"[TagCache] Full cache build complete: {_cache.Count} entries in {sw.Elapsed.TotalSeconds:F1}s");

            SaveToDisk();
        }

        /// <summary>
        /// Reconcile the persisted tag cache with Jellyfin's saved-item timestamps.
        /// Rebuilds only items saved since the previous successful run, then sweeps
        /// cached IDs that no longer exist in the live library.
        /// </summary>
        public void ReconcileCache(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            _rebuildLock.Wait(cancellationToken);
            try
            {
                ReconcileCacheCore(progress, cancellationToken);
            }
            finally
            {
                _rebuildLock.Release();
            }
        }

        private void ReconcileCacheCore(IProgress<double>? progress, CancellationToken cancellationToken)
        {
            var reconciliationStartedUtc = DateTime.UtcNow;
            var previousTicks = Interlocked.Read(ref _lastReconciledUtcTicks);

            // _cacheReleased also forces the full path: after a release, "has a
            // few entries" (e.g. from any stray incremental work) must not be
            // mistaken for a complete cache — a delta reconcile of it would serve
            // a near-empty library as if whole.
            if (_cacheReleased || _cache.IsEmpty)
            {
                _logger.Info("[TagCache] Cache is empty; running full build");
                BuildFullCacheCore(progress, cancellationToken, reconciliationStartedUtc);
                return;
            }

            if (previousTicks <= 0)
            {
                previousTicks = reconciliationStartedUtc.Ticks;
                Interlocked.Exchange(ref _lastReconciledUtcTicks, previousTicks);
                _logger.Info("[TagCache] No previous reconciliation marker; seeding marker and running delta reconciliation");
            }

            var changedSinceUtc = new DateTime(previousTicks, DateTimeKind.Utc).Subtract(TimeSpan.FromMinutes(2));
            _logger.Info($"[TagCache] Reconciling changes since {changedSinceUtc:O}");

            // Same paged hydration as the full build: after a sweeping change
            // (e.g. a full metadata refresh) this delta can cover most of the
            // library, so materializing it with one GetItemList call has the
            // same OOM potential as the unpaged full build.
            var changedIds = _libraryManager.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = TaggableTypes.ToArray(),
                TopParentIds = IncludedLibraryIds(),
                IsVirtualItem = false,
                Recursive = true,
                MinDateLastSaved = changedSinceUtc
            });

            // Series/Season go after everything else and share one per-episode
            // memo with it (see BuildFullCacheCore): after a sweeping change this
            // reads each episode's streams once instead of up to three times.
            var itemsToRebuild = new HashSet<Guid>();
            var containersToRebuild = new HashSet<Guid>();
            foreach (var page in HydrateInPages(changedIds, cancellationToken))
            {
                // Same mid-run gate as the full build: stop when the admin turns
                // the cache off instead of finishing expensive work they opted out of.
                if (ShouldAbortCacheWork)
                {
                    _logger.Info("[TagCache] Reconciliation aborted (setting disabled or server shutting down).");
                    return;
                }

                foreach (var item in page)
                {
                    cancellationToken.ThrowIfCancellationRequested();

                    (IsContainerKind(item.GetBaseItemKind()) ? containersToRebuild : itemsToRebuild).Add(item.Id);

                    if (item is MediaBrowser.Controller.Entities.TV.Episode episode)
                    {
                        if (episode.SeriesId != Guid.Empty)
                        {
                            containersToRebuild.Add(episode.SeriesId);
                        }

                        if (episode.SeasonId != Guid.Empty)
                        {
                            containersToRebuild.Add(episode.SeasonId);
                        }
                    }
                }
            }

            var idsToRebuild = itemsToRebuild.Concat(containersToRebuild).ToList();
            var episodeScans = new EpisodeScanMemo { Pending = idsToRebuild.ToHashSet() };
            // Everything from here mutates the published dictionary in place
            // (rebuilds, the sweep, the version/timestamp bump), so the shared
            // per-generation results stay off until this method returns.
            using var inPlaceWrites = BeginInPlaceWrites();
            var changed = false;
            var rebuilt = 0;
            foreach (var id in idsToRebuild)
            {
                cancellationToken.ThrowIfCancellationRequested();

                // After a sweeping change (full metadata refresh) this loop can
                // cover most of the library, so it needs the same mid-run abort
                // as the hydration pages — otherwise a disable mid-reconcile
                // keeps doing per-item probe work the admin just opted out of.
                if (ShouldAbortCacheWork)
                {
                    _logger.Info("[TagCache] Reconciliation aborted (setting disabled or server shutting down).");
                    return;
                }

                changed |= RebuildEntry(id, episodeScans);
                rebuilt++;
                progress?.Report(idsToRebuild.Count == 0 ? 50 : (double)rebuilt / idsToRebuild.Count * 80);
            }

            var currentIds = _libraryManager.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = TaggableTypes.ToArray(),
                TopParentIds = IncludedLibraryIds(),
                IsVirtualItem = false,
                Recursive = true
            });

            var liveKeys = currentIds
                .Select(id => id.ToString("N").ToLowerInvariant())
                .ToHashSet(StringComparer.Ordinal);

            // Collect the keys to sweep WITHOUT mutating the cache: entry updates
            // above are idempotent and safe to abort mid-way (the marker didn't
            // advance, so the next run redoes them), but removals are not — a
            // removed entry takes its stored SeriesId with it, so an abort after
            // partial removals could persist a cache whose deleted entries can
            // never get their parent repair, with no version bump to make
            // delta-polling clients drop them.
            var keysToSweep = new List<string>();
            foreach (var cachedKey in _cache.Keys)
            {
                cancellationToken.ThrowIfCancellationRequested();

                if (!liveKeys.Contains(cachedKey))
                {
                    keysToSweep.Add(cachedKey);
                }
            }

            // Single commit gate. Everything after it — removals, parent Series/
            // Season repairs, version bump, marker advance, disk save — runs as
            // one unit with no further abort points, so the swept state is only
            // ever observed (and persisted) complete. A disable landing during
            // the commit waits on _rebuildLock for the bounded remainder.
            if (ShouldAbortCacheWork)
            {
                _logger.Info("[TagCache] Reconciliation aborted before commit (setting disabled or server shutting down); nothing saved.");
                return;
            }

            // Parents of swept entries. Removals that happened while the monitor
            // wasn't listening (server-mode-off window, plugin stopped) never
            // enqueued their parent Series rebuild, so a Series entry can keep
            // serving first-episode data derived from a deleted item. The swept
            // entry's stored SeriesId lets the sweep queue that repair here.
            var parentSeriesToRebuild = new HashSet<Guid>();
            foreach (var key in keysToSweep)
            {
                if (TryRemoveEntry(key, out var removedEntry))
                {
                    changed = true;
                    if (removedEntry?.SeriesId != null && Guid.TryParse(removedEntry.SeriesId, out var seriesId))
                    {
                        parentSeriesToRebuild.Add(seriesId);
                    }
                }
            }

            // Log-and-continue on every repair step, never throw: the removals
            // above are already applied, so an exception escaping this loop would
            // skip the version bump and save below — delta-polling clients would
            // then keep the removed (phantom) entries until some unrelated change
            // bumps the version. Failed steps are requeued by their own id via
            // the incremental pipeline (EnqueueUpdate is O(1) and never throws;
            // the flush retries once this lock frees), so a transient failure
            // doesn't strand a parent entry either.
            foreach (var seriesId in parentSeriesToRebuild)
            {
                try
                {
                    changed |= RebuildEntry(seriesId, episodeScans);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[TagCache] Failed to repair series entry {seriesId}: {ex.Message}");
                    EnqueueUpdate(seriesId);
                }

                // The removed entry only records its SeriesId, so the deleted
                // item's former Season can't be identified directly — but Season
                // entries also derive first-episode data, so rebuild all of the
                // affected series' seasons (a handful of items) rather than leave
                // one serving streams from a deleted file indefinitely.
                IReadOnlyList<BaseItem> seasons;
                try
                {
                    seasons = GetSeasonsOfSeries(seriesId);
                }
                catch (Exception ex)
                {
                    // Season ids are unknowable without this query, so they can't
                    // be requeued individually — the one residual staleness gap.
                    _logger.Warning($"[TagCache] Failed to get seasons for series {seriesId}: {ex.Message}");
                    continue;
                }

                foreach (var season in seasons)
                {
                    try
                    {
                        changed |= RebuildEntry(season.Id, episodeScans);
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[TagCache] Failed to repair season entry {season.Id}: {ex.Message}");
                        EnqueueUpdate(season.Id);
                    }
                }
            }

            if (changed)
            {
                // Under both locks so a snapshot read pairs the bumped version
                // with the swept cache state (see the build-publish comment).
                lock (_saveLock)
                {
                    lock (_publishLock)
                    {
                        Interlocked.Increment(ref _version);
                        Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    }
                }

                InvalidateUserAccess();
            }

            Interlocked.Exchange(ref _lastReconciledUtcTicks, reconciliationStartedUtc.Ticks);
            progress?.Report(100);
            SaveToDisk();

            _logger.Info($"[TagCache] Reconciliation complete: {changedIds.Count} changed items, {idsToRebuild.Count} entries checked");
        }

        /// <summary>
        /// Queue an item to be (re)built in the cache. Called by TagCacheMonitor on
        /// ItemAdded/ItemUpdated. This only records the id and arms a debounced
        /// background flush — it performs NO database query and NO media probe, so it
        /// is safe to call on Jellyfin's synchronous library-scan thread. The heavy
        /// BuildEntryForItem work happens off-thread in <see cref="FlushPending"/>,
        /// and a burst of events for the same id collapses to a single rebuild.
        /// </summary>
        public void EnqueueUpdate(Guid itemId)
        {
            if (itemId == Guid.Empty) return;
            _pending.Record(itemId, removed: false); // O(1) record-and-defer, safe on the scan thread
            ScheduleFlush();
        }

        /// <summary>
        /// Queue an item to be removed from the cache. Called by TagCacheMonitor on
        /// ItemRemoved. Like <see cref="EnqueueUpdate"/>, this does no work on the
        /// caller's thread beyond recording the id.
        /// </summary>
        public void EnqueueRemoval(Guid itemId)
        {
            if (itemId == Guid.Empty) return;
            _pending.Record(itemId, removed: true);
            ScheduleFlush();
        }

        /// <summary>
        /// Stamp the first-pending time (if unset) and arm the debounced background flush.
        /// </summary>
        private void ScheduleFlush()
        {
            Interlocked.CompareExchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks, 0);
            ArmFlushTimer(ComputeFlushDelay());
        }

        /// <summary>
        /// Arm (or reset) the single flush timer to fire once after <paramref name="due"/>.
        /// </summary>
        private void ArmFlushTimer(TimeSpan due)
        {
            // Never resurrect a timer after Dispose: a concurrent FlushPending's finally
            // re-arm (or a late library event) could otherwise create a live Timer after
            // Dispose already nulled/disposed it, leaking a callback into a torn-down service.
            if (_disposed) return;

            var existing = _flushTimer;
            if (existing != null)
            {
                try
                {
                    existing.Change(due, Timeout.InfiniteTimeSpan);
                    return;
                }
                catch (ObjectDisposedException) { }
            }

            var timer = new Timer(_ => FlushPending(), null, due, Timeout.InfiniteTimeSpan);
            var old = Interlocked.Exchange(ref _flushTimer, timer);
            if (old != null && !ReferenceEquals(old, timer))
            {
                old.Dispose();
            }

            // Close the check-then-create race with Dispose: if Dispose set _disposed after we
            // passed the guard above but our timer was already published, reclaim and dispose it
            // so we never leave a live callback on a torn-down service.
            if (_disposed)
            {
                var orphan = Interlocked.Exchange(ref _flushTimer, null);
                orphan?.Dispose();
            }
        }

        private TimeSpan ComputeFlushDelay() =>
            ComputeFlushDelay(Interlocked.Read(ref _firstPendingTicks), DateTime.UtcNow, FlushDebounce, FlushMaxWait);

        /// <summary>
        /// Debounced due-time with a hard cap: normally <paramref name="debounce"/> after the last
        /// change, but never later than <paramref name="maxWait"/> after the first pending change,
        /// so a continuous scan that keeps resetting the debounce still flushes periodically. Pure
        /// (clock passed in) so the cap math is unit-testable without wall-clock waits.
        /// </summary>
        internal static TimeSpan ComputeFlushDelay(long firstPendingTicks, DateTime nowUtc, TimeSpan debounce, TimeSpan maxWait)
        {
            if (firstPendingTicks == 0) return debounce;

            var elapsed = nowUtc - new DateTime(firstPendingTicks, DateTimeKind.Utc);
            var remainingCap = maxWait - elapsed;
            if (remainingCap <= TimeSpan.Zero) return TimeSpan.Zero;
            return remainingCap < debounce ? remainingCap : debounce;
        }

        /// <summary>
        /// Drain the pending set and apply each change on a background thread. Never
        /// runs on the scan thread. Non-reentrant: an overlapping timer tick re-arms
        /// instead of running a second concurrent flush.
        /// </summary>
        private void FlushPending()
        {
            // Non-reentrant: if a flush already owns the batch, retry after the debounce.
            // (Retry via ArmFlushTimer, NOT ScheduleFlush: once the first pending change is older
            // than FlushMaxWait, ScheduleFlush would compute a zero delay and busy-spin the timer
            // until the running flush exits.)
            if (Interlocked.Exchange(ref _flushing, 1) == 1)
            {
                ArmFlushTimer(FlushDebounce);
                return;
            }

            var retryLater = false;
            try
            {
                // A full build/reconcile (or a server-mode transition) owns the
                // cache: applying the batch now would write into a dictionary
                // about to be swapped away — after having been drained from
                // _pending. Defer instead; the queued ids apply to the NEW cache
                // once the lock is free. (Wait(0): never block the timer thread
                // for the duration of a large-library build.)
                if (!_rebuildLock.Wait(0))
                {
                    // Restart the cap clock while deferring: the cap exists to stop
                    // a busy scan from starving flushes, but flushes CANNOT run
                    // while a rebuild owns the lock — leaving the stamp past the
                    // cap would make every library event fire a zero-delay timer
                    // tick for the whole build.
                    Interlocked.Exchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks);
                    retryLater = true;
                    return;
                }

                try
                {
                    // Mode check UNDER the lock (transitions also hold it), so the
                    // observation can't race a concurrent release: applying a batch
                    // into a released cache would repopulate memory the admin just
                    // freed and mark it dirty for persistence. Discarding is safe —
                    // the re-enable transition reconciles by item save timestamps,
                    // which covers every id dropped here.
                    if (!ServerModeEnabled)
                    {
                        Interlocked.Exchange(ref _firstPendingTicks, 0);
                        _pending.Drain();
                        return;
                    }

                    // Mode is ON but the cache is still the released placeholder:
                    // an enable catch-up is queued or between its load/reconcile
                    // steps. Applying now would seed a near-empty cache that the
                    // reconcile would then mistake for a live one. Keep the ids
                    // pending instead — they apply after the catch-up publishes.
                    if (_cacheReleased)
                    {
                        Interlocked.Exchange(ref _firstPendingTicks, DateTime.UtcNow.Ticks);
                        retryLater = true;
                        return;
                    }

                    Interlocked.Exchange(ref _firstPendingTicks, 0);
                    var batch = _pending.Drain();
                    using (BeginInPlaceWrites())
                    {
                        var changed = ApplyBatch(batch, RebuildWithBatchMemo(batch), RemoveEntry);
                        // Any library change may alter who can see an item (added,
                        // removed, moved, re-rated, re-tagged) even when its tag entry
                        // is unchanged: access sets computed before it are stale.
                        InvalidateUserAccess();
                        if (changed)
                        {
                            Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                            ScheduleDebouncedSave();
                        }
                    }
                }
                finally
                {
                    _rebuildLock.Release();
                }
            }
            finally
            {
                Interlocked.Exchange(ref _flushing, 0);
                if (retryLater)
                {
                    // Fixed debounce, NOT ScheduleFlush: the cap window has often
                    // already elapsed here, and a zero-delay reschedule would
                    // busy-spin the timer for the whole build.
                    ArmFlushTimer(FlushDebounce);
                }
                else if (!_pending.IsEmpty)
                {
                    // Ids recorded while we were draining/applying: run again (cap-aware).
                    ScheduleFlush();
                }
            }
        }

        /// <summary>
        /// Apply a drained batch: removals -> <paramref name="remove"/>, updates -> <paramref name="rebuild"/>.
        /// A failing entry is logged and skipped, never aborting the rest of the batch. Returns true if any
        /// change modified the cache. The host lookups live behind the delegates so the dispatch, resilience
        /// and change-aggregation can be unit-tested without a live library.
        /// </summary>
        internal bool ApplyBatch(IReadOnlyList<(Guid Id, bool Removed)> batch, Func<Guid, bool> rebuild, Func<Guid, bool> remove)
        {
            var changed = false;
            foreach (var (id, removed) in batch)
            {
                try
                {
                    changed |= removed ? remove(id) : rebuild(id);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[TagCache] Failed to apply pending change for {id}: {ex.Message}");
                }
            }

            return changed;
        }

        /// <summary>
        /// Rebuild callback for one drained batch. An episode change queues the
        /// episode, its Season and its Series together, so one memo per batch
        /// lets the second container reuse the episode streams the first read,
        /// and episodes outside the batch come from their live cache entries.
        /// </summary>
        private Func<Guid, bool> RebuildWithBatchMemo(IReadOnlyList<(Guid Id, bool Removed)> batch)
        {
            var episodeScans = new EpisodeScanMemo { Pending = batch.Select(change => change.Id).ToHashSet() };
            return id => RebuildEntry(id, episodeScans);
        }

        /// <summary>
        /// Library ids to scan: every library except TagCacheExcludedLibraryIds.
        /// Empty array (no exclusions configured) means no restriction.
        /// </summary>
        private Guid[] IncludedLibraryIds()
        {
            var excluded = ExcludedLibraryIds();
            if (excluded.Count == 0) return Array.Empty<Guid>();
            var included = _libraryManager.GetVirtualFolders()
                .Select(f => Guid.TryParse(f.ItemId, out var g) ? g : Guid.Empty)
                .Where(g => g != Guid.Empty && !excluded.Contains(g))
                .ToArray();
            // Everything excluded: a sentinel id matches nothing (an empty array would match all).
            return included.Length > 0 ? included : new[] { Guid.NewGuid() };
        }

        private static HashSet<Guid> ExcludedLibraryIds()
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            var set = new HashSet<Guid>();
            if (cfg?.TagCacheExcludeLibraries != true || string.IsNullOrWhiteSpace(cfg.TagCacheExcludedLibraryIds)) return set;
            var raw = cfg.TagCacheExcludedLibraryIds;
            foreach (var part in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (Guid.TryParse(part, out var id)) set.Add(id);
            }
            return set;
        }

        private bool IsInExcludedLibrary(BaseItem item)
        {
            var excluded = ExcludedLibraryIds();
            if (excluded.Count == 0) return false;
            return _libraryManager.GetCollectionFolders(item).Any(f => excluded.Contains(f.Id));
        }

        /// <summary>
        /// Resolve an id to its live library item and (re)build its cache entry.
        /// Returns true if the cache was modified. Runs on the flush worker only.
        /// <paramref name="episodeScans"/> is the caller's per-episode memo (see
        /// <see cref="BuildEntryForItem"/>), shared across one batch/reconcile.
        /// </summary>
        private bool RebuildEntry(Guid id, EpisodeScanMemo episodeScans)
        {
            var item = _libraryManager.GetItemById<BaseItem>(id);
            if (item == null) return false; // gone before we processed it; ItemRemoved cleans up

            var kind = item.GetBaseItemKind();
            if (!TaggableTypes.Contains(kind)) return false;
            // In-place removal through TryRemoveEntry, so shared response bytes see the mutation epoch move.
            if (IsInExcludedLibrary(item)) return TryRemoveEntry(id.ToString("N").ToLowerInvariant(), out _);

            var entry = BuildEntryForItem(item, episodeScans);
            if (entry == null) return false;

            // Before the no-op guard: tags can be missing while the entry is unchanged
            SyncAudioLanguageTags(item, kind, entry);

            var key = id.ToString("N").ToLowerInvariant();

            // No-op guard: Jellyfin raises ItemUpdated for every item a nightly
            // library scan (or chapter/trickplay task) re-saves, whether or not any
            // tag-relevant data changed. Reporting those rebuilds as changes made
            // every scan re-serialize the entire cache to disk every ~30s for the
            // scan's duration. Keeping the existing entry also preserves its
            // LastUpdated stamp, so delta requests (?since=) correctly skip it.
            if (_cache.TryGetValue(key, out var existing) && TagCacheEntry.ContentEquals(existing, entry))
            {
                return false;
            }

            // Raised before the store so no reader can see the entry under a
            // lower maximum (see _maxLastUpdated).
            RaiseMaxLastUpdated(entry.LastUpdated);
            StoreEntry(key, entry);
            return true;
        }

        /// <summary>
        /// Store an entry into the published dictionary in place and advance the
        /// mutation epoch (see <see cref="_mutationEpoch"/>). Every in-place
        /// store goes through here, inside an <see cref="InPlaceWriteScope"/>.
        /// </summary>
        private void StoreEntry(string key, TagCacheEntry entry)
        {
            _cache[key] = entry;
            Interlocked.Increment(ref _mutationEpoch);
        }

        /// <summary>
        /// Remove an entry from the published dictionary in place, advancing the
        /// mutation epoch when one was removed. Every in-place removal goes
        /// through here, inside an <see cref="InPlaceWriteScope"/>.
        /// </summary>
        private bool TryRemoveEntry(string key, out TagCacheEntry? removed)
        {
            if (!_cache.TryRemove(key, out removed)) return false;
            Interlocked.Increment(ref _mutationEpoch);
            return true;
        }

        /// <summary>Lock-free max update of <see cref="_maxLastUpdated"/>.</summary>
        private void RaiseMaxLastUpdated(long lastUpdated)
        {
            var current = Interlocked.Read(ref _maxLastUpdated);
            while (lastUpdated > current)
            {
                var seen = Interlocked.CompareExchange(ref _maxLastUpdated, lastUpdated, current);
                if (seen == current) return;
                current = seen;
            }
        }

        private static long MaxLastUpdated(IEnumerable<KeyValuePair<string, TagCacheEntry>> entries)
        {
            long max = 0;
            foreach (var kvp in entries)
            {
                if (kvp.Value.LastUpdated > max) max = kvp.Value.LastUpdated;
            }

            return max;
        }

        /// <summary>
        /// Marks the start of a pass that mutates the published dictionary in
        /// place; dispose the returned scope when its mutations AND the
        /// version/timestamp bump that follows them are done (see
        /// <see cref="_inPlaceWriters"/>), on every exit path.
        /// </summary>
        private InPlaceWriteScope BeginInPlaceWrites()
        {
            Interlocked.Increment(ref _inPlaceWriters);
            return new InPlaceWriteScope(this, Interlocked.Read(ref _mutationEpoch));
        }

        /// <summary>
        /// One in-place write pass (see <see cref="BeginInPlaceWrites"/>). On
        /// dispose — normal exit, exception or cancellation alike — it advances
        /// the mutation epoch once more if the epoch moved while it was open
        /// (i.e. any entry was stored or removed: a change may have happened),
        /// BEFORE it stops counting as a writer, so a reader can never see the
        /// writer gone with the epoch it started from (see IsUnchangedSince).
        /// A pass that changed nothing leaves the epoch alone, so the shared
        /// per-state results stay usable across a flush of no-op re-saves.
        /// </summary>
        private sealed class InPlaceWriteScope : IDisposable
        {
            private readonly TagCacheService _owner;
            private readonly long _epochAtStart;
            private int _disposed;

            public InPlaceWriteScope(TagCacheService owner, long epochAtStart)
            {
                _owner = owner;
                _epochAtStart = epochAtStart;
            }

            public void Dispose()
            {
                if (Interlocked.Exchange(ref _disposed, 1) != 0) return;

                if (Interlocked.Read(ref _owner._mutationEpoch) != _epochAtStart)
                {
                    Interlocked.Increment(ref _owner._mutationEpoch);
                }

                Interlocked.Decrement(ref _owner._inPlaceWriters);
            }
        }

        /// <summary>
        /// Syncs a movie's or series' audio-language tags with its freshly built entry.
        /// Runs on the flush worker. The tag write raises ItemUpdated, which queues one
        /// more rebuild that makes no change.
        /// </summary>
        private void SyncAudioLanguageTags(BaseItem item, BaseItemKind kind, TagCacheEntry entry)
        {
            if (kind != BaseItemKind.Movie && kind != BaseItemKind.Series) return;

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.AudioLanguageTagSyncEnabled) return;

            try
            {
                var updated = AudioLanguageTagHelper.BuildUpdatedTags(
                    item.Tags, entry.AudioLanguages, AudioLanguageTagHelper.GetPrefix(config), _localization);
                if (updated == null) return;

                item.Tags = updated;
                item.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, CancellationToken.None).GetAwaiter().GetResult();
                _logger.Info($"[TagCache] Updated audio language tags for '{item.Name}'");
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to update audio language tags for '{item.Name}': {ex.Message}");
            }
        }

        private bool RemoveEntry(Guid id)
        {
            var key = id.ToString("N").ToLowerInvariant();
            if (!TryRemoveEntry(key, out _)) return false;

            // Removals are the one mutation the ?since delta protocol cannot express
            // (a deleted key simply stops appearing), so clients only purge a removed
            // entry when the version changes and they do a full reload. Bump it here:
            // with the no-op rebuild guard, a quiet night no longer bumps the version
            // via reconciliation, which used to mask this gap.
            Interlocked.Increment(ref _version);
            return true;
        }

        /// <summary>
        /// Get cache entries filtered by a user's library access, together with
        /// the version and timestamp belonging to the SAME cache generation.
        /// User access IDs are cached for 60 seconds to avoid expensive DB queries.
        /// Optionally returns only entries modified after a given timestamp, plus
        /// any older entry <paramref name="alsoInclude"/> asks for (the controller
        /// uses it to carry the caller's Spoiler-Guarded entries with every delta,
        /// since what those serve depends on the user's played state, not on
        /// <see cref="TagCacheEntry.LastUpdated"/>). Both come from the one
        /// generation capture, so a delta never mixes two cache generations.
        /// The out values must come from the same _publishLock-guarded capture as
        /// the dictionary reference: pairing a freshly published cache with the
        /// previous generation's version/timestamp would let a client store a
        /// pre-first-publish timestamp of 0 (which disables its delta refresh)
        /// or a version the next poll can't detect a rebuild against.
        /// </summary>
        public Dictionary<string, TagCacheEntry> GetCacheForUser(JUser user, out long version, out long timestamp, long? since = null, Func<string, TagCacheEntry, bool>? alsoInclude = null)
            => GetCacheForUser(user, out version, out timestamp, out _, since, alsoInclude);

        /// <summary>
        /// As <see cref="GetCacheForUser(JUser, out long, out long, long?, Func{string, TagCacheEntry, bool}?)"/>,
        /// also returning <paramref name="accessRevision"/>: a fingerprint of the
        /// cache entries this user can NOT see, computed from the very access set
        /// used to filter the result. It changes whenever an entry stops being
        /// visible to the user (library access, parental limits or tags changed
        /// on the user or on the item), which a filtered delta cannot express,
        /// and not when visible items are added.
        /// </summary>
        public Dictionary<string, TagCacheEntry> GetCacheForUser(JUser user, out long version, out long timestamp, out string accessRevision, long? since = null, Func<string, TagCacheEntry, bool>? alsoInclude = null)
            => GetCacheForUserCore(user, out version, out timestamp, out accessRevision, out _, since, alsoInclude);

        /// <summary>
        /// A whole-cache <see cref="GetCacheForUser(JUser, out long, out long, out string, long?, Func{string, TagCacheEntry, bool}?)"/>
        /// (no delta, no riders) whose serialized form may be shared:
        /// <paramref name="shareKey"/> is set only when the walk saw one
        /// unchanged cache state from capture to finish (see
        /// <see cref="IsUnchangedSince"/>), and is what
        /// <see cref="StoreSerializedItems"/> files the bytes under. Null means
        /// the result is still right for this request but may mix two states,
        /// so it must not be shared.
        /// </summary>
        public Dictionary<string, TagCacheEntry> GetShareableCacheForUser(JUser user, out long version, out long timestamp, out string accessRevision, out SerializedItemsKey? shareKey)
            => GetCacheForUserCore(user, out version, out timestamp, out accessRevision, out shareKey, null, null);

        private Dictionary<string, TagCacheEntry> GetCacheForUserCore(JUser user, out long version, out long timestamp, out string accessRevision, out SerializedItemsKey? shareKey, long? since, Func<string, TagCacheEntry, bool>? alsoInclude)
        {
            accessRevision = "none";
            shareKey = null;
            var generation = CaptureGeneration(out var live);
            version = generation.Version;
            timestamp = generation.Timestamp;
            if (!live)
            {
                return new Dictionary<string, TagCacheEntry>();
            }

            var access = ResolveUserAccess(user);
            var accessibleSet = access.Ids;

            // A delta whose cursor is at or past the newest stamp in this
            // generation, with no guarded riders to pick out, would walk every
            // entry to return none of them; its accessRevision is the one the
            // last walk with this access set produced for this exact cache
            // state (the digest depends only on which keys the set excludes).
            // Every navigation sends such a delta, so this is the common case.
            if (since.HasValue && alsoInclude == null && since.Value >= generation.MaxLastUpdated
                && TryGetAccessDigest(access, generation, out var memoizedRevision))
            {
                accessRevision = memoizedRevision;
                return new Dictionary<string, TagCacheEntry>();
            }

            var result = new Dictionary<string, TagCacheEntry>();
            // Order-independent digest of the excluded keys (sum of a stable
            // 64-bit hash per key, plus the count), so no sort or list is needed.
            ulong excludedSum = 0;
            var excludedCount = 0;
            foreach (var kvp in generation.Cache)
            {
                if (!accessibleSet.Contains(kvp.Key))
                {
                    excludedSum = unchecked(excludedSum + StableKeyHash(kvp.Key));
                    excludedCount++;
                    continue;
                }
                if (since.HasValue && kvp.Value.LastUpdated <= since.Value
                    && (alsoInclude == null || !alsoInclude(kvp.Key, kvp.Value)))
                {
                    continue;
                }

                result[kvp.Key] = kvp.Value;
            }

            accessRevision = FormatAccessRevision(excludedCount, excludedSum);
            // Only a walk that saw one unchanged state leaves results for other
            // requests: its digest as the memo and, for a whole-cache walk, its
            // result as shareable.
            if (StoreAccessDigest(access, generation, accessRevision) && !since.HasValue && alsoInclude == null)
            {
                shareKey = new SerializedItemsKey(generation.Version, generation.Timestamp, generation.Epoch, accessRevision);
            }

            return result;
        }

        private static string FormatAccessRevision(int excludedCount, ulong excludedSum) =>
            excludedCount == 0
                ? "all"
                : excludedCount.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + excludedSum.ToString("x16", System.Globalization.CultureInfo.InvariantCulture);

        /// <summary>
        /// The accessRevision of <paramref name="access"/> for <paramref name="generation"/>:
        /// the memo if there is one, else the same excluded-key digest
        /// <see cref="GetCacheForUser"/> computes, from a keys-only walk (no
        /// result dictionary), memoized the same way. Callers that rely on it
        /// naming exactly the captured state check <see cref="IsUnchangedSince"/>
        /// afterwards.
        /// </summary>
        private string ResolveAccessDigest(UserAccess access, in CacheGeneration generation)
        {
            if (TryGetAccessDigest(access, generation, out var revision)) return revision;

            ulong excludedSum = 0;
            var excludedCount = 0;
            foreach (var kvp in generation.Cache)
            {
                if (!access.Ids.Contains(kvp.Key))
                {
                    excludedSum = unchecked(excludedSum + StableKeyHash(kvp.Key));
                    excludedCount++;
                }
            }

            revision = FormatAccessRevision(excludedCount, excludedSum);
            StoreAccessDigest(access, generation, revision);
            return revision;
        }

        /// <summary>
        /// The published generation as one consistent capture (see
        /// <see cref="CacheGeneration"/>). <paramref name="live"/> is false when
        /// the cache is not in service: a request that passed the controller's
        /// mode gate can still land here after a disable released the caches,
        /// and running the expensive per-user GetItemIds then would park a
        /// large accessible-id set in _userAccessCache for the whole off window
        /// (nothing evicts it while the endpoint 404s). Callers serve empty
        /// instead — the client falls back to batch mode, exactly as if it had
        /// hit the 404.
        /// </summary>
        private CacheGeneration CaptureGeneration(out bool live)
        {
            lock (_publishLock)
            {
                live = ServerModeEnabled && !_cacheReleased;
                // Epoch first, then the writer count, then the generation (see
                // IsUnchangedSince): read the other way round, a whole pass could
                // finish between the metadata reads and the epoch read, pairing
                // the old version/timestamp/max with the new epoch. Swaps can't
                // interleave (they hold _publishLock); in-place passes can, so
                // the epoch and writer count are re-read after the metadata and
                // a capture that saw anything move is not quiescent — it can
                // still be served, but never short-circuited or shared.
                var epoch = Interlocked.Read(ref _mutationEpoch);
                var quiescent = Interlocked.CompareExchange(ref _inPlaceWriters, 0, 0) == 0;
                var cache = _cache;
                var version = Interlocked.Read(ref _version);
                var timestamp = Interlocked.Read(ref _lastModified);
                var maxLastUpdated = Interlocked.Read(ref _maxLastUpdated);
                quiescent = quiescent
                    && Interlocked.CompareExchange(ref _inPlaceWriters, 0, 0) == 0
                    && Interlocked.Read(ref _mutationEpoch) == epoch;
                return new CacheGeneration(cache, version, timestamp, maxLastUpdated, epoch, quiescent);
            }
        }

        /// <summary>
        /// Whether everything a reader saw of the cache between
        /// <paramref name="generation"/>'s capture and now is exactly the state
        /// of its epoch: no in-place writer was active at the capture, none is
        /// active now, and the epoch has not moved. The capture reads the epoch,
        /// then the writer count, then the generation metadata; this check reads
        /// the writer count, then the epoch; every read is a full fence
        /// (Interlocked), so they all fall in one order with the writers' own
        /// Interlocked updates. Writers raise the max before a store, bump the
        /// epoch after each store/removal, bump version/timestamp only in a pass
        /// that stored or removed something, and bump the epoch once more when
        /// such a scope exits, before it leaves the count (see
        /// InPlaceWriteScope); every dictionary swap bumps it inside
        /// _publishLock, where the capture runs. So any write after the
        /// capture's epoch read fails the check: its writer is either counted
        /// at one of the two writer reads, or it entered and left between them
        /// — or before the first, after the epoch read — moving the epoch on
        /// its way out. Every write before that epoch read is visible to the
        /// metadata reads that follow it. Two readers that pass with the same
        /// epoch therefore saw the same contents and the same metadata.
        /// </summary>
        private bool IsUnchangedSince(in CacheGeneration generation) =>
            generation.Quiescent
            && Interlocked.CompareExchange(ref _inPlaceWriters, 0, 0) == 0
            && Interlocked.Read(ref _mutationEpoch) == generation.Epoch;

        /// <summary>
        /// The user's accessible-id set, from <see cref="_userAccessCache"/> while
        /// its entry is current (same access generation, within the TTL), else
        /// computed with one GetItemIds query and cached.
        /// </summary>
        private UserAccess ResolveUserAccess(JUser user)
        {
            var userKey = user.Id.ToString("N");

            // Check user access cache
            if (_userAccessCache.TryGetValue(userKey, out var cached)
                && cached.Generation == Interlocked.Read(ref _userAccessGeneration)
                && DateTime.UtcNow - cached.CachedAt < UserAccessCacheTtl)
            {
                return cached;
            }

            var accessGeneration = Interlocked.Read(ref _userAccessGeneration);
            var accessibleIds = _libraryManager.GetItemIds(new InternalItemsQuery(user)
            {
                IncludeItemTypes = TaggableTypes.ToArray(),
                Recursive = true
            });
            var access = new UserAccess(
                new HashSet<string>(accessibleIds.Select(id => id.ToString("N").ToLowerInvariant())),
                DateTime.UtcNow,
                accessGeneration);

            // Store under _publishLock with the released flag re-checked:
            // the live check in CaptureGeneration is check-then-act, and a
            // disable can complete while the GetItemIds query runs. The disable
            // clears _userAccessCache inside the same lock as it sets the flag,
            // so this store either lands before the clear (and is cleared) or
            // sees the flag and skips — it can never repopulate the access
            // cache for the off window.
            lock (_publishLock)
            {
                if (ServerModeEnabled && !_cacheReleased && Interlocked.Read(ref _userAccessGeneration) == accessGeneration)
                {
                    _userAccessCache[userKey] = access;
                }
            }

            return access;
        }

        /// <summary>
        /// The memoized accessRevision of <paramref name="access"/> for exactly
        /// the state <paramref name="generation"/> captured: a walk recorded one
        /// for its epoch and that state is still unchanged (see
        /// <see cref="IsUnchangedSince"/>).
        /// </summary>
        private bool TryGetAccessDigest(UserAccess access, in CacheGeneration generation, out string revision)
        {
            var digest = access.Digest;
            if (digest != null && digest.Epoch == generation.Epoch && IsUnchangedSince(generation))
            {
                revision = digest.Revision;
                return true;
            }

            revision = "none";
            return false;
        }

        /// <summary>
        /// Record the digest a walk over <paramref name="generation"/> produced,
        /// if the walk saw one unchanged state throughout (otherwise it may
        /// have seen a mix of two). Returns whether it did.
        /// </summary>
        private bool StoreAccessDigest(UserAccess access, in CacheGeneration generation, string revision)
        {
            if (!IsUnchangedSince(generation)) return false;
            access.Digest = new AccessDigest(generation.Epoch, revision);
            return true;
        }

        /// <summary>
        /// The shared serialized <c>items</c> of a whole-cache response for this
        /// user, when one exists for the current cache state and their access
        /// set (see <see cref="_serializedItems"/>). Only for requests whose
        /// items are exactly what <see cref="GetCacheForUser"/> returns for a
        /// full load — no delta, no Spoiler Guard strip. The out values mirror
        /// GetCacheForUser's. The access digest is computed here if this user
        /// has none for the state yet (a keys-only walk), so a copy another
        /// user with the same access made is found on this user's first
        /// request. A copy is only looked up when that digest provably names
        /// the captured state (see <see cref="IsUnchangedSince"/>): during a
        /// mutation a digest can describe the state after it while the version
        /// and timestamp still name the one before, and the bytes filed under
        /// those would hold entries this user can't see. On false,
        /// <paramref name="shareable"/> tells the caller whether the state was
        /// stable (a miss: serialize via <see cref="GetShareableCacheForUser"/>
        /// and <see cref="StoreSerializedItems"/>) or not (serialize this
        /// request on its own, nothing to share).
        /// </summary>
        public bool TryGetSerializedItems(JUser user, out long version, out long timestamp, out string accessRevision, out byte[] itemsJson, out int count, out bool shareable)
        {
            itemsJson = Array.Empty<byte>();
            count = 0;
            accessRevision = "none";
            shareable = false;
            var generation = CaptureGeneration(out var live);
            version = generation.Version;
            timestamp = generation.Timestamp;
            if (!live) return false;

            var access = ResolveUserAccess(user);
            // Captured again after the access query (slow on a cold set), so a
            // flush during it doesn't spoil the check below.
            generation = CaptureGeneration(out live);
            version = generation.Version;
            timestamp = generation.Timestamp;
            if (!live || !generation.Quiescent) return false;

            accessRevision = ResolveAccessDigest(access, generation);
            if (!IsUnchangedSince(generation)) return false;

            shareable = true;
            lock (_serializedItemsLock)
            {
                foreach (var entry in _serializedItems)
                {
                    if (entry.Key.Matches(generation.Version, generation.Timestamp, generation.Epoch, accessRevision))
                    {
                        entry.LastUsedTicks = DateTime.UtcNow.Ticks;
                        itemsJson = entry.Json;
                        count = entry.Count;
                        return true;
                    }
                }
            }

            return false;
        }

        /// <summary>
        /// Keep the serialized <c>items</c> of a whole-cache result
        /// (<see cref="GetShareableCacheForUser"/>) under its key, for the next
        /// request with the same state and access digest. Skipped when the
        /// state has moved on since: that key can never be matched again (the
        /// epoch only grows), and storing it would evict live copies.
        /// </summary>
        public void StoreSerializedItems(SerializedItemsKey key, byte[] itemsJson, int count)
        {
            lock (_serializedItemsLock)
            {
                // Checked under the list lock: a swap bumps the epoch before it
                // clears the list (ClearSerializedItems), so a copy of a released
                // or replaced dictionary is either refused here or cleared there.
                if (Interlocked.Read(ref _mutationEpoch) != key.Epoch) return;

                // Older states can never be served again; a same-key entry is
                // replaced (identical bytes, the newer copy just keeps the usage stamp).
                _serializedItems.RemoveAll(entry => entry.Key.Epoch != key.Epoch
                    || entry.Key.Matches(key.Version, key.Timestamp, key.Epoch, key.AccessRevision));
                _serializedItems.Add(new SerializedItems(key, itemsJson, count));

                // Bound by count and bytes, evicting the least recently used; the
                // entry just added is always kept.
                long totalBytes = 0;
                foreach (var entry in _serializedItems) totalBytes += entry.Json.LongLength;
                while (_serializedItems.Count > 1 && (_serializedItems.Count > SerializedItemsMaxEntries || totalBytes > SerializedItemsMaxBytes))
                {
                    var oldest = 0;
                    for (var i = 1; i < _serializedItems.Count - 1; i++)
                    {
                        if (_serializedItems[i].LastUsedTicks < _serializedItems[oldest].LastUsedTicks) oldest = i;
                    }

                    totalBytes -= _serializedItems[oldest].Json.LongLength;
                    _serializedItems.RemoveAt(oldest);
                }
            }
        }

        /// <summary>Drop every shared serialized copy; called under _publishLock wherever the dictionary is swapped.</summary>
        private void ClearSerializedItems()
        {
            lock (_serializedItemsLock)
            {
                _serializedItems.Clear();
            }
        }

        /// <summary>A hash of a cache key that is stable across processes (string.GetHashCode is randomized).</summary>
        private static ulong StableKeyHash(string key)
        {
            // FNV-1a, 64-bit.
            ulong hash = 14695981039346656037UL;
            foreach (var c in key)
            {
                hash = unchecked((hash ^ c) * 1099511628211UL);
            }

            return hash;
        }

        /// <summary>
        /// The live shared entry for one item (native poster tags). False when the
        /// server tag cache is off, not yet published or has no entry for the item.
        /// The entry is shared across users and must be treated as immutable
        /// (<see cref="TagCacheEntry.Clone"/> before changing it).
        /// </summary>
        public bool TryGetEntry(Guid itemId, out TagCacheEntry entry)
        {
            entry = null!;
            if (!ServerModeEnabled || _cacheReleased) return false;
            var cache = _cache; // one volatile read of the current generation
            if (!cache.TryGetValue(itemId.ToString("N"), out var found) || found == null) return false;
            entry = found;
            return true;
        }

        /// <summary>
        /// Builds the entry an item would have in the server tag cache, without
        /// touching the cache (native poster tags when the cache is off or has no
        /// entry yet). Same derivation as the cache, including the Series/Season
        /// episode scan, so it can be expensive for containers: callers memoize.
        /// Null for non-taggable items or when the build fails.
        /// </summary>
        public TagCacheEntry? BuildEntryOnDemand(BaseItem item)
        {
            if (item == null || !TaggableTypes.Contains(item.GetBaseItemKind())) return null;
            return BuildEntryForItem(item);
        }

        /// <summary>
        /// Queue a server-mode transition after the admin saved a config where
        /// the "Server-Side Tag Cache" setting flipped. Runs on a background
        /// continuation — the config save must never block behind cache work —
        /// and transitions are strictly serialized in save order, with each one
        /// re-reading the CURRENT setting when it actually runs. Rapid toggles
        /// therefore converge on the final state instead of an enable's snapshot
        /// reload racing a later disable's release (both hooks are idempotent).
        /// </summary>
        internal void QueueServerModeTransition()
        {
            lock (_transitionQueueLock)
            {
                _transitionQueue = _transitionQueue.ContinueWith(
                    _ => RunServerModeTransition(),
                    CancellationToken.None,
                    TaskContinuationOptions.None,
                    TaskScheduler.Default);
            }
        }

        private void RunServerModeTransition()
        {
            if (_disposed) return;

            try
            {
                if (ServerModeEnabled)
                {
                    // Subscribe the monitor FIRST so items changed during the
                    // (potentially long) catch-up queue as pending ids — the
                    // flush defers while the rebuild lock is held and applies
                    // them to the new cache after the swap.
                    TagCacheMonitor.Instance?.EnsureSubscribed();
                    OnServerModeEnabled();
                }
                else
                {
                    OnServerModeDisabled();
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"[TagCache] Server-mode transition failed (tags fall back to batch mode until the next refresh): {ex.Message}");
            }
        }

        /// <summary>
        /// Transition to OFF. Persists any unsaved changes first — so the on-disk
        /// snapshot stays current for a later re-enable — then releases the
        /// in-memory cache and discards queued ids. Freeing memory on the running
        /// server is precisely why an admin disables this on a memory-constrained
        /// system, so "off" must mean the memory is actually returned, not just
        /// that the endpoint 404s. Runs under _rebuildLock: an in-flight
        /// build/reconcile sees the flipped setting at its next gate and aborts,
        /// this then waits for that abort, so no rebuild or flush can repopulate
        /// the released cache or overwrite the snapshot afterwards (their gates
        /// and the save timer all re-check the setting).
        /// </summary>
        internal void OnServerModeDisabled()
        {
            _rebuildLock.Wait();
            try
            {
                _pending.Drain();
                Interlocked.Exchange(ref _firstPendingTicks, 0);

                // _saveLock makes save-then-release atomic against the debounce
                // save timer: a timer save either completes here first (and
                // snapshots the still-full cache) or runs after the release and
                // is rejected by SaveToDisk's _cacheReleased guard. (Monitor
                // locks are reentrant, so the nested SaveToDisk is fine.)
                lock (_saveLock)
                {
                    if (_dirty) SaveToDisk();

                    // The user-access clear sits INSIDE _publishLock so it is
                    // atomic with the flag: GetCacheForUser stores into
                    // _userAccessCache only under this lock with the flag
                    // re-checked, so no request can repopulate it post-release.
                    lock (_publishLock)
                    {
                        _cacheReleased = true;
                        _cache = new ConcurrentDictionary<string, TagCacheEntry>();
                        Interlocked.Exchange(ref _maxLastUpdated, 0);
                        Interlocked.Increment(ref _mutationEpoch);
                        ClearSerializedItems();
                        InvalidateUserAccess();
                    }
                }
            }
            finally
            {
                _rebuildLock.Release();
            }

            _logger.Info("[TagCache] Server-Side Tag Cache disabled; in-memory cache released (snapshot kept on disk for re-enable).");
        }

        /// <summary>
        /// Transition to ON. Restores the last persisted snapshot for instant
        /// serving, then reconciles by item save timestamps (a full paged build
        /// if no usable snapshot exists), so changes made during the off window
        /// are caught up immediately instead of waiting for the daily task.
        /// Reloads on _cacheReleased as well as IsEmpty: a single incremental
        /// flush landing between release and re-enable would otherwise make the
        /// cache "non-empty" and skip the reload, serving a near-empty cache as
        /// if complete (the reload replaces such stray entries; the reconcile
        /// re-covers them via their save timestamps).
        /// </summary>
        internal void OnServerModeEnabled()
        {
            if (_cacheReleased || _cache.IsEmpty)
            {
                LoadFromDisk();
            }

            ReconcileCache(null, CancellationToken.None);
        }

        /// <summary>
        /// Load the cache from disk (startup, or the re-enable transition).
        /// Runs under _rebuildLock so the publish can't interleave with a
        /// build's swap or a disable's release, and re-checks the setting under
        /// the lock so a load racing a disable can't resurrect the cache the
        /// disable just released.
        /// </summary>
        public void LoadFromDisk()
        {
            _rebuildLock.Wait();
            try
            {
                if (ShouldAbortCacheWork) return;
                LoadFromDiskCore();
            }
            finally
            {
                _rebuildLock.Release();
            }
        }

        private void LoadFromDiskCore()
        {
            var path = CacheFilePath;
            if (!File.Exists(path))
            {
                _logger.Info("[TagCache] No cache file found, starting empty");
                return;
            }

            try
            {
                // Deserialize straight from the file stream: on very large
                // libraries the serialized cache is tens of MB, and reading it
                // into an intermediate string would transiently double the load
                // cost (UTF-16 string + object graph) for no benefit.
                TagCacheDiskFormat? data;
                using (var stream = File.OpenRead(path))
                {
                    data = JsonSerializer.Deserialize<TagCacheDiskFormat>(stream);
                }

                if (data?.Items != null)
                {
                    // Discard a cache written by an older schema (e.g. predating
                    // SeriesId) rather than serving entries the strip paths can't
                    // process. Starting empty is safe — the refresh task rebuilds it.
                    if (data.SchemaVersion != CurrentCacheSchemaVersion)
                    {
                        _logger.Info($"[TagCache] On-disk cache schema v{data.SchemaVersion} != current v{CurrentCacheSchemaVersion}; discarding {data.Items.Count} entries and rebuilding on next scan.");
                        return;
                    }
                    // Re-gate right before publishing: deserializing a large
                    // snapshot takes long enough for the admin to flip the
                    // setting off mid-load, and publishing then would park the
                    // full cache in memory while the mode is off.
                    if (ShouldAbortCacheWork)
                    {
                        _logger.Info("[TagCache] Disk load aborted (setting disabled or server shutting down); discarding.");
                        return;
                    }

                    var loaded = new ConcurrentDictionary<string, TagCacheEntry>(data.Items);
                    var loadedMaxLastUpdated = MaxLastUpdated(loaded);

                    // Same _saveLock discipline as the build publish: flag, swap
                    // and version/timestamp change together or not at all from a
                    // saver's or snapshot-reader's view.
                    lock (_saveLock)
                    {
                        lock (_publishLock)
                        {
                            _cacheReleased = false;
                            _cache = loaded;
                            Interlocked.Exchange(ref _version, data.Version);
                            Interlocked.Exchange(ref _lastModified, data.LastModified);
                            Interlocked.Exchange(ref _maxLastUpdated, loadedMaxLastUpdated);
                            Interlocked.Increment(ref _mutationEpoch);
                            ClearSerializedItems();
                        }
                    }
                    var reconciledTicks = data.LastReconciledUtcTicks;
                    if (reconciledTicks <= 0 && data.Items.Count > 0)
                    {
                        reconciledTicks = File.GetLastWriteTimeUtc(path).Ticks;
                        _logger.Info($"[TagCache] On-disk cache has no reconciliation marker; using cache file timestamp {new DateTime(reconciledTicks, DateTimeKind.Utc):O}");
                    }
                    Interlocked.Exchange(ref _lastReconciledUtcTicks, reconciledTicks);
                    _logger.Info($"[TagCache] Loaded {_cache.Count} entries from disk (v{data.Version}, schema v{data.SchemaVersion})");
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to load cache from disk: {ex.Message}");
            }
        }

        /// <summary>
        /// Persist the cache to disk using atomic write (temp file + rename).
        /// </summary>
        public void SaveToDisk()
        {
            lock (_saveLock)
            {
                // Released cache must never reach disk: a save timer that passed
                // its dirty/mode check just before the release would otherwise
                // block on this lock and then snapshot the swapped-in empty
                // dictionary, overwriting the good snapshot. The release itself
                // saves BEFORE setting _cacheReleased (under this same lock), and
                // re-enable clears the flag before anything new needs saving.
                if (_cacheReleased)
                {
                    return;
                }
                // Clear the dirty state BEFORE snapshotting, not after the write: a change
                // applied while serialization is in progress isn't in the snapshot, and
                // clearing afterwards would wipe its flag — the armed save timer would then
                // see _dirty == false and skip, leaving that change unpersisted until the
                // next event. Cleared first, a concurrent ScheduleDebouncedSave re-marks
                // dirty and its timer performs a follow-up save that includes the change.
                _dirty = false;
                var previousStamp = Interlocked.Exchange(ref _firstDirtyTicks, 0);

                try
                {
                    var dir = Path.GetDirectoryName(CacheFilePath);
                    if (dir != null) Directory.CreateDirectory(dir);

                    var data = new TagCacheDiskFormat
                    {
                        SchemaVersion = CurrentCacheSchemaVersion,
                        Version = Interlocked.Read(ref _version),
                        LastModified = Interlocked.Read(ref _lastModified),
                        LastReconciledUtcTicks = Interlocked.Read(ref _lastReconciledUtcTicks),
                        Items = new Dictionary<string, TagCacheEntry>(_cache)
                    };

                    // Serialize straight to the temp file: building the whole
                    // payload as one string first would transiently hold tens of
                    // MB of UTF-16 on large libraries (see LoadFromDisk).
                    var tempPath = CacheFilePath + ".tmp";
                    using (var stream = File.Create(tempPath))
                    {
                        JsonSerializer.Serialize(stream, data, DiskJsonOptions);
                    }

                    File.Move(tempPath, CacheFilePath, overwrite: true);

                    _logger.Info($"[TagCache] Saved {_cache.Count} entries to disk");
                }
                catch (Exception ex)
                {
                    // Failed write: restore the dirty state so Dispose's final
                    // `if (_dirty) SaveToDisk()` and the next debounce cycle retry it.
                    // Intentionally NOT re-arming the save timer here: with the cap
                    // window already elapsed the due time would be zero, and a
                    // persistent disk failure would spin fire-fail-rearm. The next
                    // library event, shutdown, or daily reconcile retries instead.
                    // Restore the ORIGINAL first-dirty stamp (not "now"): re-seeding
                    // with the current time would restart the SaveMaxWait cap window
                    // on every failed attempt and stretch the retry cadence. If a
                    // concurrent ScheduleDebouncedSave already stamped a newer window,
                    // keep that one — a slightly later cap is harmless.
                    _dirty = true;
                    if (previousStamp != 0)
                    {
                        Interlocked.CompareExchange(ref _firstDirtyTicks, previousStamp, 0);
                    }

                    _logger.Error($"[TagCache] Failed to save cache to disk: {ex.Message}");
                }
            }
        }

        private void ScheduleDebouncedSave()
        {
            _dirty = true;
            var nowTicks = DateTime.UtcNow.Ticks;
            Interlocked.Exchange(ref _lastDirtyTicks, nowTicks);
            Interlocked.CompareExchange(ref _firstDirtyTicks, nowTicks, 0);
            // During/after shutdown, persist synchronously instead of arming a timer that a
            // torn-down service would never fire. This is what keeps a flush that finishes
            // AFTER Dispose's (bounded) wait from losing its applied changes — it saves them
            // now rather than relying on a debounce timer that will never run.
            if (_disposed)
            {
                if (ServerModeEnabled) SaveToDisk();
                return;
            }

            ArmSaveTimer(ComputeSaveDelay());
        }

        /// <summary>Jellyfin's library scan is running (see ScanSaveDebounce).</summary>
        private bool IsLibraryScanRunning => _libraryManager.IsScanRunning;

        /// <summary>
        /// Due time of the next save check. Trailing debounce with a hard cap
        /// (same math as the flush timer): normally 30s after the last change
        /// but never more than 5 minutes after the first unsaved one, so
        /// sustained real changes can't starve persistence NOR write every
        /// cycle; both stretched to 10 minutes while a library scan runs, and
        /// then no longer than ScanSavePoll so the scan's end is re-checked.
        /// The debounce is measured from the LAST change, so re-evaluating when
        /// the timer fires (OnSaveTimer) gives the same answer as arming it
        /// fresh would — the cadence outside scans is unchanged.
        /// </summary>
        private TimeSpan ComputeSaveDelay()
        {
            var now = DateTime.UtcNow;
            var scanning = IsLibraryScanRunning;
            var sinceLastChange = now - new DateTime(Interlocked.Read(ref _lastDirtyTicks), DateTimeKind.Utc);
            var remainingDebounce = (scanning ? ScanSaveDebounce : SaveDebounce) - sinceLastChange;
            if (remainingDebounce < TimeSpan.Zero) remainingDebounce = TimeSpan.Zero;

            var due = ComputeFlushDelay(Interlocked.Read(ref _firstDirtyTicks), now, remainingDebounce, scanning ? ScanSaveMaxWait : SaveMaxWait);
            return scanning && due > ScanSavePoll ? ScanSavePoll : due;
        }

        /// <summary>
        /// The save timer's callback: saves when the current debounce/cap pair
        /// says the time has come, otherwise re-arms for the remainder (a poll
        /// tick during a scan, or the trailing debounce after one ended).
        /// </summary>
        private void OnSaveTimer()
        {
            // The mode gate keeps a save armed before a disable from writing
            // the post-release (near-empty) cache over the good snapshot;
            // OnServerModeDisabled does its own explicit save-if-dirty first.
            if (!_dirty || !ServerModeEnabled) return;

            // A second of slack absorbs timer jitter so a save armed for its exact
            // due time doesn't re-arm for a few milliseconds instead of running.
            var due = ComputeSaveDelay();
            if (due > TimeSpan.FromSeconds(1))
            {
                ArmSaveTimer(due);
                return;
            }

            SaveToDisk();
        }

        /// <summary>
        /// Arm (or reset) the single save timer to fire <see cref="OnSaveTimer"/>
        /// once after <paramref name="due"/>.
        /// </summary>
        private void ArmSaveTimer(TimeSpan due)
        {
            // Reuse existing timer if possible, otherwise create a new one.
            // Change() resets the countdown without creating a new object.
            var existing = _debounceSaveTimer;
            if (existing != null)
            {
                try
                {
                    existing.Change(due, Timeout.InfiniteTimeSpan);
                    return;
                }
                catch (ObjectDisposedException) { }
            }
            var timer = new Timer(_ => OnSaveTimer(), null, due, Timeout.InfiniteTimeSpan);
            var old = Interlocked.Exchange(ref _debounceSaveTimer, timer);
            if (old != null && !ReferenceEquals(old, timer))
            {
                old.Dispose();
            }

            // Same check-then-create/Dispose race guard as ArmFlushTimer: reclaim a timer
            // published concurrently with Dispose so none is left live after teardown, and
            // persist now since that reclaimed timer will never fire the save.
            if (_disposed)
            {
                var orphan = Interlocked.Exchange(ref _debounceSaveTimer, null);
                orphan?.Dispose();
                if (ServerModeEnabled) SaveToDisk();
            }
        }

        public void Dispose()
        {
            // Mark disposed first so any concurrent flush re-arm / late library event is a no-op
            // (ArmFlushTimer and ScheduleDebouncedSave both bail on _disposed) instead of
            // resurrecting a timer after teardown.
            _disposed = true;

            if (ReferenceEquals(Instance, this))
            {
                Instance = null;
            }

            var flush = Interlocked.Exchange(ref _flushTimer, null);
            flush?.Dispose(); // stops future callbacks; an in-flight one may still be applying

            // Take ownership of the flush guard before persisting. Timer.Dispose() does not wait
            // for a running callback, so without this Dispose could drain an already-emptied
            // _pending, skip the save, and lose the in-flight flush's applied batch (it only
            // schedules a debounced save that never fires during shutdown). Waiting for _flushing
            // to release means that flush has finished and set _dirty, so the save below catches it.
            var acquired = false;
            for (var i = 0; i < 500; i++) // ~5s cap, well under the shutdown grace period
            {
                if (Interlocked.CompareExchange(ref _flushing, 1, 0) == 0)
                {
                    acquired = true;
                    break;
                }

                Thread.Sleep(10);
            }

            // Apply anything still queued in the debounce window so a change made moments before
            // shutdown is persisted — matching the old synchronous handler, which applied to the
            // cache inline and let the trailing SaveToDisk() flush it. Without this, queued-but-
            // unflushed changes (and the fact that startup only rebuilds when the cache is empty)
            // would leave those items stale until the next event or the daily rebuild.
            try
            {
                // Only when the cache is actually in service: while the setting is
                // off (or the cache is an unpublished placeholder) the entries
                // would be applied into a dictionary whose save is refused anyway
                // — guaranteed-discarded per-item probe work that can only delay
                // shutdown. The dropped ids are re-covered by the next full build
                // or timestamp reconcile.
                if (ServerModeEnabled && !_cacheReleased)
                {
                    var batch = _pending.Drain();
                    using (BeginInPlaceWrites())
                    {
                        if (ApplyBatch(batch, RebuildWithBatchMemo(batch), RemoveEntry))
                        {
                            Interlocked.Exchange(ref _lastModified, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                            _dirty = true;
                        }
                    }
                }
                else
                {
                    _pending.Drain();
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to flush pending changes on dispose: {ex.Message}");
            }
            finally
            {
                if (acquired) Interlocked.Exchange(ref _flushing, 0);
            }

            var timer = Interlocked.Exchange(ref _debounceSaveTimer, null);
            timer?.Dispose();
            if (_dirty && ServerModeEnabled) SaveToDisk();
        }

        /// <summary>
        /// Build a TagCacheEntry for a single library item.
        /// For Series/Season, resolves first-episode data server-side and
        /// aggregates audio languages across all episodes.
        /// <paramref name="episodeScans"/> is an optional per-episode memo shared
        /// across one build/reconcile/batch: an episode's own entry records into
        /// it and a parent's scan reads from it (or records what it had to read),
        /// so every episode's streams are read once instead of once for the
        /// episode, once for its season and once for its series.
        /// </summary>
        private TagCacheEntry? BuildEntryForItem(BaseItem item, EpisodeScanMemo? episodeScans = null)
        {
            try
            {
                var kind = item.GetBaseItemKind();
                var isContainer = IsContainerKind(kind);

                // Capture parent series ID for Episodes/Seasons so the Spoiler
                // Guard filter can strip unwatched-episode entries without a
                // library lookup per entry on every GetTagCache request.
                string? seriesIdN = null;
                if (item is MediaBrowser.Controller.Entities.TV.Episode tcEp)
                {
                    if (tcEp.SeriesId != Guid.Empty) seriesIdN = tcEp.SeriesId.ToString("N");
                }
                else if (item is MediaBrowser.Controller.Entities.TV.Season tcSeason)
                {
                    if (tcSeason.SeriesId != Guid.Empty) seriesIdN = tcSeason.SeriesId.ToString("N");
                }

                var entry = new TagCacheEntry
                {
                    Type = kind.ToString(),
                    TmdbId = item.ProviderIds?.TryGetValue("Tmdb", out var tmdbId) == true ? tmdbId : null,
                    Genres = item.Genres,
                    CommunityRating = item.CommunityRating,
                    CriticRating = item.CriticRating,
                    OfficialRating = string.IsNullOrWhiteSpace(item.OfficialRating) ? null : item.OfficialRating,
                    LastUpdated = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    SeriesId = seriesIdN,
                };

                // Parent Series of a Season/Episode, looked up once per item
                // (both fallbacks below read it).
                var series = kind == BaseItemKind.Season || kind == BaseItemKind.Episode ? GetParentSeries(item) : null;

                if (isContainer)
                {
                    var (firstEp, languages, partialLanguages) = ScanContainerEpisodes(item, episodeScans);
                    if (firstEp != null)
                    {
                        if (entry.Genres == null || entry.Genres.Length == 0)
                        {
                            entry.Genres = firstEp.Genres;
                        }

                        // Quality tags still describe one representative episode;
                        // language tags cover every episode (see ScanContainerEpisodes).
                        // The episode's own entry built the identical stream data
                        // when it ran earlier in this pass; share it (never mutated).
                        if (firstEp.StreamData != null)
                        {
                            entry.StreamData = firstEp.StreamData;
                        }
                        else if (firstEp.Item != null)
                        {
                            var (streams, sources, _) = ExtractMediaData(firstEp.Item);
                            entry.StreamData = BuildStreamData(firstEp.Item, streams, sources);
                        }

                        entry.AudioLanguages = languages;
                        entry.PartialAudioLanguages = partialLanguages;
                    }

                    if (kind == BaseItemKind.Season && entry.CommunityRating == null)
                    {
                        if (series != null)
                        {
                            entry.CommunityRating = series.CommunityRating;
                            entry.CriticRating = series.CriticRating;
                            if (entry.Genres == null || entry.Genres.Length == 0)
                            {
                                entry.Genres = series.Genres;
                            }
                        }
                    }

                    // For Season: store parent series TMDB ID + season number for user review key
                    if (kind == BaseItemKind.Season && item is MediaBrowser.Controller.Entities.TV.Season season)
                    {
                        if (series?.ProviderIds?.TryGetValue("Tmdb", out var seriesTmdb) == true)
                            entry.SeriesTmdbId = seriesTmdb;
                        entry.SeasonNumber = season.IndexNumber;
                        // Age rating: a Season rarely carries its own, so fall back to
                        // the Series (same shape as the CommunityRating fallback above).
                        if (entry.OfficialRating == null && !string.IsNullOrWhiteSpace(series?.OfficialRating))
                        {
                            entry.OfficialRating = series.OfficialRating;
                        }
                    }
                }
                else if (kind == BaseItemKind.BoxSet)
                {
                    // A BoxSet has no media streams of its own; derive its language
                    // tags from the union of its manually-linked movie members instead.
                    entry.AudioLanguages = GetCollectionLanguages(item);
                }
                else
                {
                    var (streams, sources, languages) = ExtractMediaData(item);
                    entry.StreamData = BuildStreamData(item, streams, sources);
                    entry.AudioLanguages = languages;

                    if (kind == BaseItemKind.Episode && episodeScans != null && item is MediaBrowser.Controller.Entities.TV.Episode scanned)
                    {
                        // Same "has streams" rule as ExtractAudioLanguages: the
                        // stream list only ever holds audio/video streams.
                        episodeScans[item.Id] = new EpisodeScan(streams.Count > 0 ? languages : null, entry.StreamData, EpisodePlacement.Of(scanned));
                    }

                    if (kind == BaseItemKind.Episode && entry.CommunityRating == null)
                    {
                        if (series != null)
                        {
                            entry.CommunityRating = series.CommunityRating;
                            entry.CriticRating = series.CriticRating;
                        }
                    }

                    // For Episode: store parent series TMDB ID + season/episode numbers for user review key
                    if (kind == BaseItemKind.Episode && item is MediaBrowser.Controller.Entities.TV.Episode ep)
                    {
                        if (series?.ProviderIds?.TryGetValue("Tmdb", out var seriesTmdb) == true)
                            entry.SeriesTmdbId = seriesTmdb;
                        entry.SeasonNumber = ep.ParentIndexNumber;
                        entry.EpisodeNumber = ep.IndexNumber;
                        // Age rating: Episodes inherit the Series rating when they have none.
                        if (entry.OfficialRating == null && !string.IsNullOrWhiteSpace(series?.OfficialRating))
                        {
                            entry.OfficialRating = series.OfficialRating;
                        }
                    }
                }

                return entry;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to build entry for {item.Id}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Stream data for an entry, from the given item's extracted streams/sources.
        /// ItemPath is only kept when it names a file none of the sources already
        /// name: qualitytags.js reads both into the same signal list, so a
        /// duplicate adds bytes (a file name per item, on every full download)
        /// and nothing else.
        /// </summary>
        private static TagStreamData BuildStreamData(BaseItem item, List<TagMediaStream> streams, List<TagMediaSource> sources)
        {
            var itemPath = string.IsNullOrEmpty(item.Path) ? null : Path.GetFileName(item.Path);
            if (itemPath != null && sources.Exists(source => string.Equals(source.Path, itemPath, StringComparison.Ordinal)))
            {
                itemPath = null;
            }

            return new TagStreamData
            {
                Streams = streams,
                Sources = sources,
                ItemName = item.Name,
                ItemPath = itemPath
            };
        }

        private (List<TagMediaStream>, List<TagMediaSource>, string[]) ExtractMediaData(BaseItem item)
        {
            var streams = new List<TagMediaStream>();
            var sources = new List<TagMediaSource>();
            var languages = new HashSet<string>();

            try
            {
                var mediaSources = item.GetMediaSources(false);
                foreach (var source in mediaSources)
                {
                    // A source's Name is normally its file name without the
                    // extension. qualitytags.js only ever reads Name and Path
                    // into the same word-boundary regex signals, so a Name the
                    // Path already contains is dropped; one that says more
                    // (a version label) is kept.
                    var sourceName = source.Name;
                    if (!string.IsNullOrEmpty(source.Path)
                        && string.Equals(sourceName, Path.GetFileNameWithoutExtension(source.Path), StringComparison.Ordinal))
                    {
                        sourceName = null;
                    }

                    sources.Add(new TagMediaSource
                    {
                        Path = string.IsNullOrEmpty(source.Path) ? null : Path.GetFileName(source.Path),
                        Name = sourceName
                    });

                    foreach (var resolved in MediaStreamLanguageResolver.Resolve(source, item.Path))
                    {
                        var s = resolved.Stream;
                        var effectiveLanguage = resolved.Language;

                        if (s.Type != MediaStreamType.Video && s.Type != MediaStreamType.Audio)
                            continue;

                        // Only a video stream's range is read (for the HDR /
                        // Dolby Vision tag); an audio stream's is always
                        // "Unknown", which the client treats like no value.
                        var videoRangeType = s.Type == MediaStreamType.Video ? s.VideoRangeType.ToString() : null;
                        if (string.Equals(videoRangeType, "Unknown", StringComparison.Ordinal))
                        {
                            videoRangeType = null;
                        }

                        streams.Add(new TagMediaStream
                        {
                            Type = s.Type.ToString(),
                            Language = effectiveLanguage,
                            Codec = s.Codec,
                            CodecTag = s.CodecTag,
                            Profile = s.Profile,
                            Height = s.Height,
                            Channels = s.Channels,
                            ChannelLayout = s.ChannelLayout,
                            VideoRangeType = videoRangeType,
                            DisplayTitle = s.DisplayTitle
                        });

                        if (s.Type == MediaStreamType.Audio && NormalizeAudioLanguage(effectiveLanguage) is { } lang)
                        {
                            languages.Add(lang);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to extract media data for {item.Id}: {ex.Message}");
            }

            return (streams, sources, languages.ToArray());
        }

        /// <summary>
        /// Lower-cases a stream language for the tag cache, or returns null when
        /// the track carries no usable language (empty, "und", "root").
        /// </summary>
        private static string? NormalizeAudioLanguage(string? language)
        {
            if (string.IsNullOrEmpty(language)) return null;
            var lang = language.ToLowerInvariant();
            return lang == "und" || lang == "root" ? null : lang;
        }

        /// <summary>
        /// Audio languages of one episode, or null when it has no audio/video
        /// streams at all (unprobed file, disc stub). Same normalization as
        /// <see cref="ExtractMediaData"/>, without building the stream/source
        /// lists the container scan doesn't need.
        /// </summary>
        private static string[]? ExtractAudioLanguages(BaseItem item)
        {
            var hasStreams = false;
            var languages = new HashSet<string>();
            foreach (var source in item.GetMediaSources(false))
            {
                foreach (var resolved in MediaStreamLanguageResolver.Resolve(source, item.Path))
                {
                    var type = resolved.Stream.Type;
                    if (type != MediaStreamType.Video && type != MediaStreamType.Audio) continue;

                    hasStreams = true;
                    if (type == MediaStreamType.Audio && NormalizeAudioLanguage(resolved.Language) is { } lang)
                    {
                        languages.Add(lang);
                    }
                }
            }

            return hasStreams ? languages.ToArray() : null;
        }

        /// <summary>
        /// One pass over a Series/Season's episodes: picks the representative
        /// episode (same rule as <see cref="TagEpisodeSelector.GetFirstEpisode"/>)
        /// and aggregates audio languages across every episode with streams.
        /// Returns the union as <c>Languages</c> and, as <c>Partial</c>, the
        /// languages missing from at least one episode — so the card can show a
        /// dub that only covers part of the show differently from one that covers
        /// all of it (#557). <c>Partial</c> is null when every language is full.
        /// Specials don't count against a Series' full languages (an untranslated
        /// special shouldn't demote a complete dub) unless the container is the
        /// Specials season itself or the series has nothing but specials. Episodes
        /// whose audio has no language tag are neutral: an untagged track says
        /// nothing about which language it is, so it neither adds to the union nor
        /// marks every other language as partial.
        /// The "on every episode" test is <see cref="Covers"/> over
        /// <see cref="LanguageIdentity"/>, not raw-code equality: one season
        /// tagged "eng" and the next "en" (or "fr-FR" vs "fre") is still one
        /// complete English/French dub, while an "es-ES" track that sits next to
        /// "es-419" on some episodes stays partial even if "es-419" is on all.
        /// <paramref name="episodeScans"/> is the pass's per-episode memo (see
        /// <see cref="BuildEntryForItem"/>); episodes missing from it are taken
        /// from their live cache entry when the pass allows it (see
        /// <see cref="EpisodeScanMemo"/>) or read here, and recorded for the
        /// next container. In the full build the episodes come from the memo's
        /// <see cref="EpisodeScanMemo.ContainerIndex"/> rather than a query per
        /// container (except for its <see cref="ContainerEpisodeIndex.PagedScan"/>
        /// containers); both walks feed the same per-episode step in the same
        /// order, so they produce the same entry.
        /// </summary>
        private (RepresentativeEpisode? FirstEpisode, string[] Languages, string[]? Partial) ScanContainerEpisodes(
            BaseItem container,
            EpisodeScanMemo? episodeScans)
        {
            // Union keeps insertion order (deterministic for a stable library), so
            // the order-sensitive ContentEquals compare stays no-op on re-saves.
            var union = new HashSet<string>();
            // Distinct per-episode identity sets: a series has a handful of
            // track layouts however many episodes it has, so these stay tiny.
            var regularSets = new Dictionary<string, string[]>(StringComparer.Ordinal);
            var specialSets = new Dictionary<string, string[]>(StringComparer.Ordinal);
            var containerIsSeason = container is MediaBrowser.Controller.Entities.TV.Season;

            // One episode's contribution, in scan order; the result is the
            // "usable streams" answer the representative pick needs.
            bool Accumulate(int? parentIndexNumber, string[]? languages)
            {
                if (languages == null) return false; // no streams: not a tag source
                if (languages.Length == 0) return true; // streams but untagged audio: neutral

                union.UnionWith(languages);
                var identities = languages.Select(LanguageIdentity).Distinct().OrderBy(id => id, StringComparer.Ordinal).ToArray();
                var isSpecial = parentIndexNumber == 0 && !containerIsSeason;
                (isSpecial ? specialSets : regularSets).TryAdd(string.Join('|', identities), identities);
                return true;
            }

            try
            {
                RepresentativeEpisode? firstEp;
                if (episodeScans?.ContainerIndex is { } index && !index.PagedScan.Contains(container.Id))
                {
                    // Full build: the container's episodes come from the index, in
                    // the order its scan would have returned them, and every one of
                    // them already has its memo record (or is a Late episode, read
                    // here exactly as the scan's callback below would).
                    var members = index.Members.TryGetValue(container.Id, out var ids) ? ids : new List<Guid>();
                    var first = TagEpisodeSelector.SelectRepresentative(
                        members.Select(id => ReadIndexedEpisode(id, index, episodeScans)),
                        containerIsSeason,
                        episode => episode.ParentIndexNumber,
                        episode => Accumulate(episode.ParentIndexNumber, episode.Languages));
                    firstEp = first == null ? null : new RepresentativeEpisode(first.Genres, first.StreamData, first.Item);
                }
                else
                {
                    var first = TagEpisodeSelector.ScanEpisodes(_libraryManager, container, null, episode =>
                    {
                        string[]? languages;
                        if (episodeScans != null && episodeScans.TryGetValue(episode.Id, out var scan))
                        {
                            languages = scan.Languages;
                        }
                        else if (episodeScans?.Pending != null
                            && !episodeScans.Pending.Contains(episode.Id)
                            && _cache.TryGetValue(episode.Id.ToString("N"), out var cached)
                            && string.Equals(cached.Type, "Episode", StringComparison.Ordinal))
                        {
                            // Same "has streams" rule as the episode's own build: its
                            // stream list only ever holds audio/video streams.
                            languages = cached.StreamData?.Streams?.Count > 0 ? cached.AudioLanguages ?? Array.Empty<string>() : null;
                            episodeScans[episode.Id] = new EpisodeScan(languages, cached.StreamData);
                        }
                        else
                        {
                            languages = ExtractAudioLanguages(episode);
                            if (episodeScans != null) episodeScans[episode.Id] = new EpisodeScan(languages, null);
                        }

                        return Accumulate(episode.ParentIndexNumber, languages);
                    }, stopAtFirstRegular: false);

                    // Stream data the pass already built for this episode (its own
                    // entry, or the live cache entry recorded above), if any.
                    firstEp = first == null
                        ? null
                        : new RepresentativeEpisode(
                            first.Genres,
                            episodeScans != null && episodeScans.TryGetValue(first.Id, out var firstScan) ? firstScan.StreamData : null,
                            first);
                }

                // Two regional variants are separate dubs only when some episode
                // carries both as separate tracks; otherwise they're one dub tagged
                // differently from one release to the next.
                var separateDubs = new HashSet<string>(StringComparer.Ordinal);
                foreach (var set in regularSets.Values.Concat(specialSets.Values))
                {
                    for (var i = 0; i < set.Length; i++)
                    {
                        for (var j = i + 1; j < set.Length; j++)
                        {
                            if (SubtagVariants(set[i], set[j])) separateDubs.Add(set[i] + "|" + set[j]);
                        }
                    }
                }

                var counted = regularSets.Count > 0 ? regularSets.Values : specialSets.Values;
                var partial = union
                    .Where(lang =>
                    {
                        var identity = LanguageIdentity(lang);
                        return !counted.All(set => Covers(set, identity, separateDubs));
                    })
                    .ToArray();
                return (firstEp, union.ToArray(), partial.Length > 0 ? partial : null);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to scan episodes for {container.Id}: {ex.Message}");
                return (null, Array.Empty<string>(), null);
            }
        }

        /// <summary>
        /// What a container's scan callback reads from one of its episodes, in
        /// the full build (see <see cref="ReadIndexedEpisode"/>).
        /// </summary>
        private sealed record IndexedEpisode(int? ParentIndexNumber, string[]? Languages, string[] Genres, TagStreamData? StreamData, BaseItem? Item);

        /// <summary>
        /// One indexed episode as the scan callback in
        /// <see cref="ScanContainerEpisodes"/> would see it: the memo record its
        /// own entry left, or — for a Late episode no earlier container has read
        /// yet — its audio languages read now and recorded for the next
        /// container, the same as the callback does for an episode it can't find
        /// in the memo (a read that throws fails this container's scan, as it
        /// did there). Safe to call from parallel container builds.
        /// </summary>
        private static IndexedEpisode ReadIndexedEpisode(Guid id, ContainerEpisodeIndex index, EpisodeScanMemo episodeScans)
        {
            index.Late.TryGetValue(id, out var late);
            if (episodeScans.TryGetValue(id, out var scan) && scan.Placement is { } placement)
            {
                return new IndexedEpisode(placement.ParentIndexNumber, scan.Languages, placement.Genres, scan.StreamData, late);
            }

            // The index only lists episodes that have a placement or a Late item.
            var episode = late ?? throw new InvalidOperationException($"Episode {id} is missing from the container index");
            var languages = ExtractAudioLanguages(episode);
            episodeScans[id] = new EpisodeScan(languages, null, EpisodePlacement.Of(episode));
            return new IndexedEpisode(episode.ParentIndexNumber, languages, episode.Genres, null, episode);
        }

        /// <summary>
        /// Files every non-virtual episode under the Series/Season entries the
        /// full build is about to create, in the order each container's own scan
        /// (<see cref="TagEpisodeSelector.ScanEpisodes"/>) returns them, with one
        /// ordered library-wide id query instead of a paged query per container.
        /// Each of those hydrated its episodes again and filtered on an ancestor
        /// id across the library's episode rows, so their total cost grew with
        /// containers x library episodes (most of a 58k-item build).
        /// <para>
        /// Membership is the scan's own: a recursive ParentId query on a Series
        /// or Season is rewritten by Jellyfin into an AncestorIds filter on that
        /// one id, and an episode's ancestor rows are written with the episode
        /// (<c>Episode.GetAncestorIds</c> at save time): every item up its
        /// ParentId chain, plus its <c>SeasonId</c> (the season it is filed
        /// under even when it sits directly in the series folder). Both are
        /// stored columns, read here from the episode pass's memo; the chain's
        /// folders are the containers themselves (their ParentId read from one
        /// light hydration) and, above or between them, a few library folders
        /// resolved through Jellyfin's item cache. Episodes with no memo record
        /// (no entry of their own this pass, e.g. added after the id query) are
        /// hydrated here and kept as <see cref="ContainerEpisodeIndex.Late"/>,
        /// standing in for the scan's own hydration of them.
        /// </para>
        /// </summary>
        private ContainerEpisodeIndex BuildContainerEpisodeIndex(IReadOnlyList<Guid> containerIds, EpisodeScanMemo episodeScans, CancellationToken cancellationToken)
        {
            var orderedIds = TagEpisodeSelector.GetOrderedEpisodeIds(_libraryManager);

            var late = new Dictionary<Guid, MediaBrowser.Controller.Entities.TV.Episode>();
            var lateIds = orderedIds.Where(id => !(episodeScans.TryGetValue(id, out var scan) && scan.Placement != null)).ToList();
            foreach (var page in HydrateInPages(lateIds, cancellationToken))
            {
                foreach (var item in page)
                {
                    if (item is MediaBrowser.Controller.Entities.TV.Episode episode) late[episode.Id] = episode;
                }
            }

            var containerSet = containerIds.ToHashSet();
            var parentOf = new Dictionary<Guid, Guid>();
            foreach (var page in HydrateInPages(containerIds, cancellationToken))
            {
                foreach (var item in page) parentOf[item.Id] = item.ParentId;
            }

            // Containers on a folder's ParentId chain (the folder included),
            // nearest first; memoized per folder, so a season's episodes walk it once.
            var chains = new Dictionary<Guid, Guid[]>();
            Guid[] ContainersOnChain(Guid folderId)
            {
                var path = new List<Guid>();
                var tail = Array.Empty<Guid>();
                for (var id = folderId; id != Guid.Empty;)
                {
                    if (chains.TryGetValue(id, out var known))
                    {
                        tail = known;
                        break;
                    }

                    // Jellyfin's own walk (BaseItem.GetParents) has no guard; a
                    // cycle or absurd depth here just ends the chain.
                    if (path.Count >= 64 || path.Contains(id)) break;
                    path.Add(id);
                    id = ParentIdOf(id);
                }

                for (var i = path.Count - 1; i >= 0; i--)
                {
                    if (containerSet.Contains(path[i])) tail = tail.Prepend(path[i]).ToArray();
                    chains[path[i]] = tail;
                }

                return path.Count > 0 ? chains[folderId] : tail;
            }

            // Same lookup BaseItem.GetParent does; an unresolvable parent ends the chain there too.
            Guid ParentIdOf(Guid id)
            {
                if (!parentOf.TryGetValue(id, out var parentId))
                {
                    try
                    {
                        parentId = _libraryManager.GetItemById(id)?.ParentId ?? Guid.Empty;
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[TagCache] Failed to resolve folder {id} while grouping episodes: {ex.Message}");
                        parentId = Guid.Empty;
                    }

                    parentOf[id] = parentId;
                }

                return parentId;
            }

            var placed = new List<(Guid Id, EpisodePlacement Placement)>(orderedIds.Count);
            var placementOf = new Dictionary<Guid, EpisodePlacement>(orderedIds.Count);
            foreach (var id in orderedIds)
            {
                if (episodeScans.TryGetValue(id, out var scan) && scan.Placement is { } recorded)
                {
                    placed.Add((id, recorded));
                    placementOf[id] = recorded;
                }
                else if (late.TryGetValue(id, out var episode))
                {
                    var placement = EpisodePlacement.Of(episode);
                    placed.Add((id, placement));
                    placementOf[id] = placement;
                }

                // Otherwise gone since the id query (or not loadable): no scan would return it.
            }

            // Episodes the sort ranks equal (e.g. two versions of one episode,
            // stored as separate items) have no order of their own in the id
            // query. A container's scan loaded its items with their image,
            // provider and user-data rows joined in, and Entity Framework orders
            // such a query by the item key after the requested keys, so within
            // its page the scan returned them by id (as stored: the GUID's
            // string form, which orders the same in either letter case). Do the
            // same here, so the representative and the language order match.
            // That only holds within one page: the page's LIMIT is applied
            // before the key ordering, so which of a tied run lands on each
            // side of a page boundary is up to the database (see PagedScan below).
            for (var start = 0; start < placed.Count;)
            {
                var end = start + 1;
                while (end < placed.Count && placed[end].Placement.SortsEqualTo(placed[start].Placement)) end++;
                if (end - start > 1)
                {
                    placed.Sort(start, end - start, Comparer<(Guid Id, EpisodePlacement Placement)>.Create(
                        (a, b) => string.CompareOrdinal(a.Id.ToString("D"), b.Id.ToString("D"))));
                }

                start = end;
            }

            var members = new Dictionary<Guid, List<Guid>>();
            void Add(Guid containerId, Guid episodeId)
            {
                if (!members.TryGetValue(containerId, out var list)) members[containerId] = list = new List<Guid>();
                list.Add(episodeId);
            }

            foreach (var (id, placement) in placed)
            {
                var chain = placement.ParentId == Guid.Empty ? Array.Empty<Guid>() : ContainersOnChain(placement.ParentId);
                foreach (var containerId in chain) Add(containerId, id);
                if (placement.SeasonId != Guid.Empty
                    && containerSet.Contains(placement.SeasonId)
                    && Array.IndexOf(chain, placement.SeasonId) < 0)
                {
                    Add(placement.SeasonId, id);
                }
            }

            // A tied run that starts on one page of a container's scan and ends
            // on the next can come back in either order across the boundary, so
            // its id order above isn't necessarily the scan's. Only those
            // containers (a run inside one page is fully on that page, so its
            // order there is the id order) are left to their own paged scan,
            // which gives them exactly the entry it always did. A tie needs the
            // same premiere date and sort name (which carries the season and
            // episode numbers), in practice several versions of one episode, and
            // must also cross a 50-episode boundary, so this is rare.
            var pagedScan = new HashSet<Guid>();
            foreach (var (containerId, list) in members)
            {
                for (var start = 0; start < list.Count;)
                {
                    var end = start + 1;
                    while (end < list.Count && placementOf[list[end]].SortsEqualTo(placementOf[list[start]])) end++;
                    if (start / TagEpisodeSelector.ScanPageSize != (end - 1) / TagEpisodeSelector.ScanPageSize)
                    {
                        pagedScan.Add(containerId);
                        break;
                    }

                    start = end;
                }
            }

            return new ContainerEpisodeIndex(members, late, pagedScan);
        }

        /// <summary>
        /// Whether an episode whose audio has the given (ordinal-sorted)
        /// <see cref="LanguageIdentity"/> set carries <paramref name="identity"/>:
        /// the same identity, or the same base language unless both sides name
        /// different region/script subtags that <paramref name="separateDubs"/>
        /// (sorted "a|b" pairs) proves are different dubs. A bare "fre" says
        /// nothing about the region, so it matches "fr-FR" and "fr-CA"; "es-419"
        /// on every episode doesn't complete an "es-ES" track that shares
        /// episodes with it.
        /// </summary>
        private static bool Covers(string[] episodeIdentities, string identity, HashSet<string> separateDubs)
        {
            foreach (var other in episodeIdentities)
            {
                if (string.Equals(other, identity, StringComparison.Ordinal)) return true;
                if (!string.Equals(BaseOf(other), BaseOf(identity), StringComparison.Ordinal)) continue;
                if (!SubtagVariants(other, identity)) return true; // one side is bare

                var pair = string.CompareOrdinal(other, identity) < 0 ? other + "|" + identity : identity + "|" + other;
                if (!separateDubs.Contains(pair)) return true;
            }

            return false;
        }

        /// <summary>
        /// Two different identities of the same base language that both carry a
        /// region/script subtag ("es-419" and "es-es").
        /// </summary>
        private static bool SubtagVariants(string a, string b)
        {
            return a.IndexOf('-') > 0
                && b.IndexOf('-') > 0
                && !string.Equals(a, b, StringComparison.Ordinal)
                && string.Equals(BaseOf(a), BaseOf(b), StringComparison.Ordinal);
        }

        /// <summary>
        /// Base language of a <see cref="LanguageIdentity"/> ("pt-br" → "pt").
        /// </summary>
        private static string BaseOf(string identity)
        {
            var dash = identity.IndexOf('-');
            return dash > 0 ? identity[..dash] : identity;
        }

        /// <summary>
        /// Canonical identity of a stream language code, for deciding whether two
        /// episodes carry "the same" dub. Files are tagged inconsistently — ISO
        /// 639-2 from Jellyfin's probe ("eng", "ger"/"deu") next to Matroska
        /// BCP-47 ("en", "de-DE") — so the base is mapped through Jellyfin's
        /// culture table to its two-letter code and any subtag is kept, lower-cased
        /// ("fre" → "fr", "fr-FR" → "fr-fr"). Unknown codes, and ones such as "zxx"
        /// with no two-letter form, stay as their lower-cased selves so they still
        /// compare consistently with themselves.
        /// </summary>
        private string LanguageIdentity(string code)
        {
            return _languageIdentities.GetOrAdd(code, static (raw, localization) =>
            {
                var lowered = raw.ToLowerInvariant();
                var dash = lowered.IndexOf('-');
                var baseCode = dash > 0 ? lowered[..dash] : lowered;
                var subtag = dash > 0 ? lowered[dash..] : string.Empty;
                try
                {
                    var twoLetter = localization.FindLanguageInfo(baseCode)?.TwoLetterISOLanguageName;
                    if (!string.IsNullOrEmpty(twoLetter))
                    {
                        // A few culture rows carry a region of their own ("pob" → "pt-br").
                        twoLetter = twoLetter.ToLowerInvariant();
                        return twoLetter.Contains('-', StringComparison.Ordinal) ? twoLetter : twoLetter + subtag;
                    }
                }
                catch
                {
                    // A lookup failure only costs canonicalization for this code.
                }

                return lowered;
            }, _localization);
        }

        /// <summary>
        /// Hydrate library items for the given ids in fixed-size pages
        /// (<see cref="HydrationPageSize"/>). Only one page of full BaseItems is
        /// referenced at a time, which keeps full builds and reconciliation
        /// memory-bounded on arbitrarily large libraries. An id that no longer
        /// resolves (deleted between the id query and its page) is simply absent
        /// from the returned page.
        /// Items are loaded with <see cref="HydrationOptions"/>: the stored
        /// columns plus provider ids, which is everything an entry reads.
        /// </summary>
        private IEnumerable<IReadOnlyList<BaseItem>> HydrateInPages(IReadOnlyList<Guid> ids, CancellationToken cancellationToken)
        {
            for (var offset = 0; offset < ids.Count; offset += HydrationPageSize)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var count = Math.Min(HydrationPageSize, ids.Count - offset);
                var pageIds = new Guid[count];
                for (var i = 0; i < count; i++)
                {
                    pageIds[i] = ids[offset + i];
                }

                yield return _libraryManager.GetItemList(new InternalItemsQuery { ItemIds = pageIds, DtoOptions = HydrationOptions });
            }
        }

        /// <summary>
        /// All Season items of a series, for the reconcile sweep's parent repair.
        /// Query failures propagate — the caller logs them and requeues what it
        /// can, so swallowing here would silently disable that retry path.
        /// </summary>
        private IReadOnlyList<BaseItem> GetSeasonsOfSeries(Guid seriesId)
        {
            // IsVirtualItem must match the build/sweep queries: including a
            // virtual season here would add an entry the next sweep's live-id
            // set (virtual-excluded) doesn't contain, so it would be removed,
            // trigger this repair again, and churn the cache version forever.
            return _libraryManager.GetItemList(new InternalItemsQuery
            {
                ParentId = seriesId,
                IncludeItemTypes = new[] { BaseItemKind.Season },
                IsVirtualItem = false,
                Recursive = true
            });
        }

        /// <summary>
        /// Union of audio languages across a BoxSet's linked movie members.
        /// LinkedChildren is a manual join (not a parent pointer), so this is
        /// resolved live rather than tracked incrementally per member; membership
        /// edits already re-enqueue the BoxSet itself (see TagCacheMonitor), and a
        /// member's own file changes are picked up by the next reconciliation.
        /// </summary>
        private string[] GetCollectionLanguages(BaseItem collection)
        {
            try
            {
                if (collection is not Folder folder) return Array.Empty<string>();

                var languages = new HashSet<string>();
                foreach (var member in folder.GetLinkedChildren())
                {
                    if (member.GetBaseItemKind() != BaseItemKind.Movie) continue;

                    var (_, _, memberLanguages) = ExtractMediaData(member);
                    foreach (var lang in memberLanguages) languages.Add(lang);
                }

                return languages.ToArray();
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to get collection languages for {collection.Id}: {ex.Message}");
                return Array.Empty<string>();
            }
        }

        private BaseItem? GetParentSeries(BaseItem item)
        {
            try
            {
                Guid? seriesId = null;
                if (item is MediaBrowser.Controller.Entities.TV.Episode ep)
                    seriesId = ep.SeriesId;
                else if (item is MediaBrowser.Controller.Entities.TV.Season season)
                    seriesId = season.SeriesId;

                if (seriesId.HasValue && seriesId.Value != Guid.Empty)
                {
                    return _libraryManager.GetItemById<BaseItem>(seriesId.Value);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCache] Failed to get parent series for {item.Id}: {ex.Message}");
            }
            return null;
        }

        private class TagCacheDiskFormat
        {
            // On-disk entry schema. Absent (0) in caches written before this
            // field existed, so they read as != CurrentCacheSchemaVersion and
            // are discarded + rebuilt. Distinct from Version (content revision).
            public int SchemaVersion { get; set; }
            public long Version { get; set; }
            public long LastModified { get; set; }
            public long LastReconciledUtcTicks { get; set; }
            public Dictionary<string, TagCacheEntry> Items { get; set; } = new();
        }
    }
}
