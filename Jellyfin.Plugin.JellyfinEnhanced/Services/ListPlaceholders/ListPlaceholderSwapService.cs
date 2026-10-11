using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>Which placeholders of a pass get their Seerr metadata (re)read first (combinable).</summary>
    [Flags]
    public enum MetadataMode
    {
        /// <summary>No Seerr calls.</summary>
        None = 0,

        /// <summary>Season/series placeholders, data at most an hour old (needed before one is retired).</summary>
        Completion = 1,

        /// <summary>Freshly added placeholders: every kind, normal cache age.</summary>
        New = 2,

        /// <summary>Maintenance: TV placeholders and undated/unreleased/poster-less movies, at most ~a day old.</summary>
        Maintenance = 4,

        /// <summary>
        /// Season/series placeholders, bypassing the cache: an episode arrived that the cached data says hasn't aired
        /// (or doesn't list), so the cached expected set is stale.
        /// </summary>
        Force = 8,
    }

    /// <summary>What one list pass did.</summary>
    /// <param name="Inserted">Real items JE inserted into the list.</param>
    /// <param name="Retired">Placeholders removed because their scope is complete.</param>
    public readonly record struct SwapPassResult(int Inserted, int Retired);

    /// <summary>The result of <see cref="ListPlaceholderSwapService.SwapLockedAsync"/>.</summary>
    /// <param name="Doc">The latest mutable document copy (may hold changes not yet saved).</param>
    /// <param name="Dirty">True when <see cref="Doc"/> has unsaved changes.</param>
    /// <param name="Result">Counts.</param>
    public sealed record SwapOutcome(ListDoc Doc, bool Dirty, SwapPassResult Result);

    /// <summary>
    /// Swap-in (design §9, A5–A8, C1, C3): when a placeholder's title arrives in the library, the real item goes into the
    /// list at the placeholder's spot.
    /// <list type="bullet">
    /// <item>Playlists: movie → the movie is inserted at the placeholder's spot and the placeholder retired. Series /
    /// season / episodes → each arriving episode is inserted in episode order relative to the already filled episodes
    /// (right before the placeholder when it is the latest), recorded in <c>filled</c>; the placeholder stays ("n of m
    /// aired") until <see cref="PlaceholderProgress.IsComplete"/> holds on metadata at most an hour old. Inserts run as
    /// the OWNER, only for items the owner can access, in Jellyfin's coordinate systems
    /// (<see cref="ListPlaylistPlacement"/>), guarded by swap intents (A6) and verified. An item already in the playlist
    /// is never inserted twice (it counts as filled / satisfies the placeholder) — the same rule adds and applies use.</item>
    /// <item>Collections: movie/series → the Movie/Series item is added and the placeholder retired; season → the Season
    /// item is added once a real episode exists, the placeholder stays until complete; episodes → each Episode item is
    /// added, retired when all are there.</item>
    /// <item>Passes are idempotent, run per list under the list lock, and are triggered by library events (coalesced
    /// ~2 s), list views (debounced), startup, maintenance, and right after adds/links. A missing list is terminal;
    /// failures are logged and retried by the next pass.</item>
    /// </list>
    /// </summary>
    public sealed class ListPlaceholderSwapService : IDisposable
    {
        /// <summary>Settle delay that coalesces a burst of library events into one pass.</summary>
        public static readonly TimeSpan DefaultSettleDelay = TimeSpan.FromSeconds(2);

        /// <summary>Minimum spacing of the background pass a list view triggers.</summary>
        public static readonly TimeSpan ViewPassInterval = TimeSpan.FromMinutes(5);

        /// <summary>Max age of the metadata a season/series placeholder is retired on (unless the show has ended).</summary>
        public static readonly TimeSpan CompletionMetadataMaxAge = TimeSpan.FromHours(1);

        /// <summary>Max age of metadata in maintenance passes.</summary>
        public static readonly TimeSpan MaintenanceMetadataMaxAge = TimeSpan.FromHours(20);

        /// <summary>
        /// How long a library match shows as "being added" when passes run but can't swap it in yet (the item isn't
        /// resolvable for the list, e.g. a scan still writing it, or out of the owner's reach). A Jellyfin failure keeps
        /// it alive while retries fail.
        /// </summary>
        public static readonly TimeSpan PendingMatchGrace = TimeSpan.FromMinutes(2);

        /// <summary>Overall time budget for metadata reads inside an interactive request (adds, links).</summary>
        public static readonly TimeSpan InteractiveMetadataBudget = TimeSpan.FromSeconds(6);

        private const int MaxQueuedItems = 50_000;

        // Seerr reads one pass runs at a time: below the metadata service's global limit, so interactive reads and other
        // passes still get a slot while maintenance walks a big list.
        private const int PassMetadataConcurrency = 3;

        private readonly ListPlaceholderStore _store;
        private readonly IListPlaceholderHost _host;
        private readonly IUserManager _userManager;
        private readonly ListPlaceholderResolver _resolver;
        private readonly ListPlaceholderMetadataService _metadata;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<Guid, byte> _changedItems = new();
        private readonly ConcurrentDictionary<string, PassRequest> _queued = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, DateTime> _lastViewPass = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, PendingMatch> _pendingMatches = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, DateTime> _lastForced = new(StringComparer.Ordinal);
        // Per placeholder (MatchKey): when the newest metadata applied to it was fetched. Passes read metadata outside the
        // list lock, so a pass holding an older read (e.g. the maintenance pass's cached one) must not overwrite what a
        // concurrent Force pass applied.
        private readonly ConcurrentDictionary<string, DateTime> _appliedMetadataAt = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, byte> _ownerlessLogged = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _signal = new(0, int.MaxValue);
        private readonly object _workerGate = new();
        private CancellationTokenSource? _stopping;
        private Task? _worker;
        private int _overflowLogged;
        private int _disposed;

        /// <summary>Creates the service (singleton).</summary>
        /// <param name="store">Placeholder store.</param>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="userManager">User manager (playlist owners).</param>
        /// <param name="resolver">Library resolver.</param>
        /// <param name="metadata">Seerr metadata.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholderSwapService(
            ListPlaceholderStore store,
            IListPlaceholderHost host,
            IUserManager userManager,
            ListPlaceholderResolver resolver,
            ListPlaceholderMetadataService metadata,
            Logger logger)
        {
            _store = store;
            _host = host;
            _userManager = userManager;
            _resolver = resolver;
            _metadata = metadata;
            _logger = logger;
        }

        /// <summary>Settle delay of the background worker (tests shorten it).</summary>
        internal TimeSpan SettleDelay { get; set; } = DefaultSettleDelay;

        /// <summary>Clock (tests move it).</summary>
        internal Func<DateTime> UtcNow { get; set; } = () => DateTime.UtcNow;

        /// <summary>Gets the number of remembered "being added" matches (tests).</summary>
        internal int PendingMatchCount => _pendingMatches.Count;

        private static bool Enabled => JellyfinEnhanced.Instance?.Configuration?.ListPlaceholdersEnabled == true;

        // ── Scheduling ───────────────────────────────────────────────────────

        /// <summary>
        /// A library item was added or updated (any thread; returns at once). Movies, episodes, seasons and series are
        /// matched against placeholders after the settle delay; a playlist change re-reconciles that playlist's order.
        /// </summary>
        /// <param name="itemId">The item.</param>
        public void NotifyItemChanged(Guid itemId)
        {
            if (itemId == Guid.Empty || !Enabled)
            {
                return;
            }

            if (_changedItems.Count >= MaxQueuedItems)
            {
                if (Interlocked.Exchange(ref _overflowLogged, 1) == 0)
                {
                    _logger.Debug("[ListPlaceholders] Library change queue is full; the next list view or maintenance run catches up.");
                }

                return;
            }

            _changedItems.TryAdd(itemId, 0);
            Signal();
        }

        /// <summary>A list was viewed: queues a full background pass for it at most every <see cref="ViewPassInterval"/>.</summary>
        /// <param name="listIdN">List id ("N").</param>
        public void RequestViewPass(string listIdN)
        {
            var now = UtcNow();
            if (_lastViewPass.TryGetValue(listIdN, out var last) && now - last < ViewPassInterval)
            {
                return;
            }

            _lastViewPass[listIdN] = now;
            QueuePass(listIdN, null, MetadataMode.None);
        }

        /// <summary>Queues a pass for a list (merged with an already queued one).</summary>
        /// <param name="listIdN">List id ("N").</param>
        /// <param name="placeholderIds">Placeholders to look at (null = all; empty = only reconcile + intents).</param>
        /// <param name="mode">Metadata to read first.</param>
        public void QueuePass(string listIdN, IEnumerable<string>? placeholderIds, MetadataMode mode)
        {
            if (!ListPlaceholderStore.IsValidListId(listIdN))
            {
                return;
            }

            var request = new PassRequest(placeholderIds == null ? null : new HashSet<string>(placeholderIds, StringComparer.Ordinal), mode);
            _queued.AddOrUpdate(listIdN, request, (_, existing) => existing.Merge(request));
            Signal();
        }

        /// <summary>Queues a pass for every list that has a document.</summary>
        /// <param name="mode">Metadata to read first.</param>
        public void QueueAll(MetadataMode mode)
        {
            foreach (var listIdN in _store.EnumerateListIds())
            {
                QueuePass(listIdN, null, mode);
            }
        }

        /// <summary>The library item a placeholder matched while its swap is still pending (or failed and waits for a retry).</summary>
        /// <param name="listIdN">List id.</param>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <returns>The item id or null.</returns>
        public Guid? GetPendingMatch(string listIdN, string placeholderId) =>
            _pendingMatches.TryGetValue(MatchKey(listIdN, placeholderId), out var match) && !IsExpired(match) ? match.ItemId : null;

        /// <summary>Drops everything queued or remembered for a deleted list.</summary>
        /// <param name="listIdN">List id.</param>
        public void ForgetList(string listIdN)
        {
            _queued.TryRemove(listIdN, out _);
            _lastViewPass.TryRemove(listIdN, out _);
            _ownerlessLogged.TryRemove(listIdN, out _);
            foreach (var key in _pendingMatches.Keys.Where(k => k.StartsWith(listIdN + "|", StringComparison.Ordinal)).ToList())
            {
                _pendingMatches.TryRemove(key, out _);
            }

            foreach (var key in _lastForced.Keys.Where(k => k.StartsWith(listIdN + "|", StringComparison.Ordinal)).ToList())
            {
                _lastForced.TryRemove(key, out _);
            }

            foreach (var key in _appliedMetadataAt.Keys.Where(k => k.StartsWith(listIdN + "|", StringComparison.Ordinal)).ToList())
            {
                _appliedMetadataAt.TryRemove(key, out _);
            }
        }

        /// <summary>Starts the background worker (hosted monitor).</summary>
        public void Start()
        {
            lock (_workerGate)
            {
                if (_worker != null)
                {
                    return;
                }

                _stopping = new CancellationTokenSource();
                var token = _stopping.Token;
                _worker = Task.Run(() => WorkerLoopAsync(token), CancellationToken.None);
            }
        }

        /// <summary>Stops the background worker and waits for the running pass.</summary>
        /// <param name="cancellationToken">Gives up waiting.</param>
        /// <returns>A task.</returns>
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            Task? worker;
            lock (_workerGate)
            {
                _stopping?.Cancel();
                worker = _worker;
                _worker = null;
            }

            if (worker != null)
            {
                try
                {
                    await worker.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // shutting down
                }
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            CancellationTokenSource? stopping;
            lock (_workerGate)
            {
                stopping = _stopping;
                _stopping = null;
                _worker = null;
            }

            stopping?.Cancel();
            stopping?.Dispose();
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                _signal.Dispose();
            }
        }

        /// <summary>Processes everything queued right now (worker body; tests call it directly).</summary>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>A task.</returns>
        internal async Task DrainAsync(CancellationToken cancellationToken)
        {
            // F11: a match whose placeholder went away (deleted, dropped by a sync, relinked) is never settled by a pass;
            // it's invisible once its grace has ended, so it goes then.
            foreach (var pair in _pendingMatches)
            {
                if (IsExpired(pair.Value))
                {
                    _pendingMatches.TryRemove(pair);
                }
            }

            if (!Enabled)
            {
                _changedItems.Clear();
                _queued.Clear();
                return;
            }

            MapChangedItems();
            foreach (var listIdN in _queued.Keys.ToList())
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!_queued.TryRemove(listIdN, out var request))
                {
                    continue;
                }

                try
                {
                    await RunListPassAsync(listIdN, request.Ids, request.Mode, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[ListPlaceholders] Swap pass for list {listIdN} failed (retried on the next pass): {ex.Message}");
                }
            }
        }

        // ── Passes ───────────────────────────────────────────────────────────

        /// <summary>Runs a full pass over every list with a document (maintenance).</summary>
        /// <param name="mode">Metadata to read first.</param>
        /// <param name="progress">Progress 0..100.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Summed counts.</returns>
        public async Task<SwapPassResult> RunAllAsync(MetadataMode mode, IProgress<double>? progress, CancellationToken cancellationToken)
        {
            var ids = _store.EnumerateListIds();
            int inserted = 0, retired = 0;
            for (var i = 0; i < ids.Count; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    var result = await RunListPassAsync(ids[i], null, mode, cancellationToken).ConfigureAwait(false);
                    inserted += result.Inserted;
                    retired += result.Retired;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.Warning($"[ListPlaceholders] Pass for list {ids[i]} failed: {ex.Message}");
                }

                progress?.Report(100.0 * (i + 1) / ids.Count);
            }

            return new SwapPassResult(inserted, retired);
        }

        /// <summary>
        /// One pass over one list: reads metadata (outside the lock), then under the list lock completes or rolls back
        /// swap intents, re-reconciles the playlist order, applies the metadata and swaps in whatever of the placeholders'
        /// scopes is now in the library. No-op while the feature is off; a missing list is terminal.
        /// </summary>
        /// <param name="listIdN">List id ("N").</param>
        /// <param name="placeholderIds">Placeholders to look at (null = all; empty = only reconcile + intents).</param>
        /// <param name="mode">Metadata to read first.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>What the pass did.</returns>
        public async Task<SwapPassResult> RunListPassAsync(string listIdN, IReadOnlyCollection<string>? placeholderIds, MetadataMode mode, CancellationToken cancellationToken)
        {
            if (!Enabled || !ListPlaceholderStore.IsValidListId(listIdN))
            {
                return default;
            }

            var list = _host.GetList(Guid.ParseExact(listIdN, "N"));
            if (list == null)
            {
                ForgetList(listIdN); // terminal: the lifecycle sweep removes the document
                return default;
            }

            ListDoc? snapshot;
            try
            {
                snapshot = _store.Load(listIdN);
            }
            catch (InvalidDataException)
            {
                return default; // corrupt document: read-only until an admin fixes it
            }

            if (snapshot == null || (snapshot.Items.Count == 0 && snapshot.Intents.Count == 0))
            {
                return default;
            }

            var metadata = await FetchMetadataAsync(snapshot.Items.Where(p => placeholderIds == null || placeholderIds.Contains(p.Id)), mode, UtcNow(), cancellationToken).ConfigureAwait(false);

            using (await _store.LockAsync(listIdN, cancellationToken).ConfigureAwait(false))
            {
                var doc = _store.LoadForUpdate(listIdN, list.Kind);
                User? owner = list.Kind == ListKinds.Playlist && list.OwnerId != Guid.Empty ? _userManager.GetUserById(list.OwnerId) : null;
                var outcome = await SwapLockedAsync(list, owner, doc, placeholderIds, metadata, null, mode, cancellationToken).ConfigureAwait(false);
                if (outcome.Dirty)
                {
                    _store.Save(outcome.Doc);
                }

                if (outcome.Result.Inserted > 0 || outcome.Result.Retired > 0)
                {
                    _logger.Info($"[ListPlaceholders] List \"{list.Name}\": {outcome.Result.Inserted} item(s) swapped in, {outcome.Result.Retired} placeholder(s) completed.");
                }

                return outcome.Result;
            }
        }

        /// <summary>
        /// The swap core; the caller holds the list lock. Completes/rolls back intents, re-reconciles the canonical
        /// order (playlists) and swaps in the given placeholders. May save the document (intents are persisted before
        /// Jellyfin is mutated), so always continue with the returned <see cref="SwapOutcome.Doc"/> and save it when
        /// <see cref="SwapOutcome.Dirty"/>.
        /// </summary>
        /// <param name="list">The list.</param>
        /// <param name="owner">Playlist owner (null: playlist swaps are skipped).</param>
        /// <param name="doc">Mutable document copy (<see cref="ListPlaceholderStore.LoadForUpdate"/>).</param>
        /// <param name="placeholderIds">Placeholders to look at (null = all).</param>
        /// <param name="metadata">Fetched metadata to merge into placeholders first (by placeholder id), or null.</param>
        /// <param name="freshMetadata">Placeholders whose metadata was already merged and is at most <see cref="CompletionMetadataMaxAge"/> old, or null.</param>
        /// <param name="passMode">
        /// The metadata this pass already read: a season/series that looks complete on older metadata gets a follow-up
        /// <see cref="MetadataMode.Completion"/> pass (unless this was one), one whose filled episodes the expected set
        /// doesn't know as aired a <see cref="MetadataMode.Force"/> pass (unless this was one).
        /// </param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome.</returns>
        public async Task<SwapOutcome> SwapLockedAsync(
            ListInfo list,
            User? owner,
            ListDoc doc,
            IReadOnlyCollection<string>? placeholderIds,
            IReadOnlyDictionary<string, PlaceholderMetadata>? metadata,
            IReadOnlySet<string>? freshMetadata,
            MetadataMode passMode,
            CancellationToken cancellationToken)
        {
            var context = new PassContext(list, owner, doc, UtcNow());
            var fresh = new HashSet<string>(freshMetadata ?? (IEnumerable<string>)Array.Empty<string>(), StringComparer.Ordinal);
            foreach (var pair in metadata ?? new Dictionary<string, PlaceholderMetadata>())
            {
                var placeholder = context.Doc.Items.FirstOrDefault(p => p.Id == pair.Key);
                if (placeholder != null && !TakeMetadata(context.ListIdN, pair.Key, pair.Value))
                {
                    continue; // a concurrent pass already applied a newer read: this one is stale (and not fresh)
                }

                if (placeholder != null && ListPlaceholderMetadataService.Apply(placeholder, pair.Value))
                {
                    context.Dirty = true;
                }

                if (!pair.Value.Partial && DateTime.UtcNow - pair.Value.FetchedAtUtc <= CompletionMetadataMaxAge)
                {
                    fresh.Add(pair.Key);
                }
            }

            await RecoverIntentsAsync(context).ConfigureAwait(false);
            if (list.Kind == ListKinds.Playlist)
            {
                var canonical = Canonical(context.Doc, _host.GetRawEntries(list.Id));
                if (!canonical.SequenceEqual(context.Doc.Order, StringComparer.Ordinal) && context.Doc.Items.Count > 0)
                {
                    context.Doc.Order = canonical;
                    context.Dirty = true;
                }
            }

            var followUps = new List<string>();
            var forced = new List<string>();
            var candidates = context.Doc.Items
                .Where(p => p.Kind != PlaceholderKinds.Custom && (placeholderIds == null || placeholderIds.Contains(p.Id)))
                .Select(p => p.Id)
                .ToList();
            foreach (var placeholderId in candidates)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var placeholder = context.Doc.Items.FirstOrDefault(p => p.Id == placeholderId);
                if (placeholder == null)
                {
                    continue;
                }

                bool ok;
                if (list.Kind == ListKinds.Playlist)
                {
                    if (owner == null)
                    {
                        // An ownerless playlist (Jellyfin keeps an open-access one whose owner was deleted): nothing can
                        // be added as its owner, so a match must not show as "being added".
                        _pendingMatches.TryRemove(MatchKey(context.ListIdN, placeholderId), out _);
                        if (_ownerlessLogged.TryAdd(context.ListIdN, 0))
                        {
                            _logger.Info($"[ListPlaceholders] Playlist \"{list.Name}\" has no owner any more; its placeholders can't be swapped in.");
                        }

                        continue;
                    }

                    var resolution = _resolver.Resolve(placeholder, list.Kind, new[] { owner });
                    ok = await SwapIntoPlaylistAsync(context, placeholderId, resolution).ConfigureAwait(false);
                }
                else
                {
                    var resolution = _resolver.Resolve(placeholder, list.Kind, Array.Empty<User>());
                    ok = await SwapIntoCollectionAsync(context, placeholderId, resolution).ConfigureAwait(false);
                }

                placeholder = context.Doc.Items.FirstOrDefault(p => p.Id == placeholderId);
                if (placeholder != null && PlaceholderProgress.IsEpisodeFill(placeholder) && PlaceholderProgress.IsComplete(placeholder, context.Today))
                {
                    // C3: a stored "ended" can be an older reading (or a show revived since), so seasons and series retire on
                    // fresh metadata; only without Seerr, where nothing could ever confirm it, does the stored state decide.
                    var confirmed = placeholder.Kind == PlaceholderKinds.Episodes || fresh.Contains(placeholderId)
                        || (placeholder.InProduction == false && !ListPlaceholderMetadataService.IsAvailable);
                    // The library already contradicts the metadata (an episode the expected set doesn't know as aired was
                    // filled), which a cached read can't see: read it again first. Retire on the Force pass, or when
                    // MayForce refuses, so a numbering mismatch never pins the placeholder.
                    if (PlaceholderProgress.HasUnexpectedFills(placeholder, context.Today) && (passMode & MetadataMode.Force) == 0
                        && ListPlaceholderMetadataService.IsAvailable && MayForce(context.ListIdN, placeholderId))
                    {
                        forced.Add(placeholderId);
                    }
                    else if (confirmed)
                    {
                        Retire(context, placeholder);
                    }
                    else if ((passMode & MetadataMode.Completion) == 0 && ListPlaceholderMetadataService.IsAvailable)
                    {
                        followUps.Add(placeholderId);
                    }
                }
                else if (placeholder != null && PlaceholderProgress.HasUnexpectedFills(placeholder, context.Today)
                    && (passMode & MetadataMode.Force) == 0 && ListPlaceholderMetadataService.IsAvailable && MayForce(context.ListIdN, placeholderId))
                {
                    forced.Add(placeholderId);
                }

                SettlePendingMatch(context, placeholderId, placeholder, ok);
            }

            if (followUps.Count > 0)
            {
                QueuePass(context.ListIdN, followUps, MetadataMode.Completion);
            }

            if (forced.Count > 0)
            {
                QueuePass(context.ListIdN, forced, MetadataMode.Force);
            }

            return new SwapOutcome(context.Doc, context.Dirty, new SwapPassResult(context.Inserted, context.Retired));
        }

        // ── Playlists ────────────────────────────────────────────────────────

        // Returns false when a Jellyfin mutation failed (the pending match stays; the next pass retries).
        private async Task<bool> SwapIntoPlaylistAsync(PassContext context, string placeholderId, ScopeResolution resolution)
        {
            var placeholder = context.Doc.Items.First(p => p.Id == placeholderId);
            if (placeholder.Kind == PlaceholderKinds.Movie)
            {
                if (!resolution.Found)
                {
                    return true;
                }

                var itemId = resolution.Items[0].ItemId;
                if (OccurrenceCounts(_host.GetRawEntries(context.List.Id)).ContainsKey(itemId))
                {
                    // Already in the playlist (e.g. added by hand): never a second copy, the placeholder is satisfied.
                    // F1: an entry JE didn't add is presence, not sync ownership.
                    Retire(context, placeholder);
                    return true;
                }

                var index = PlaceholderIndex(context.Doc.Order, placeholderId);
                var landed = await InsertRunAsync(context, placeholderId, new[] { itemId }, index).ConfigureAwait(false);
                if (landed == null)
                {
                    return false;
                }

                if (landed.Count > 0)
                {
                    context.Inserted++;
                    Retire(context, context.Doc.Items.First(p => p.Id == placeholderId), new[] { N(itemId) });
                }

                return true;
            }

            if (!PlaceholderProgress.IsEpisodeFill(placeholder))
            {
                return true;
            }

            DropReplacedFills(context, placeholder, resolution);
            var filled = PlaceholderProgress.FilledCoords(placeholder);
            var arriving = resolution.Episodes.Where(e => e.Coords.Any(c => !filled.Contains(c))).ToList();
            if (arriving.Count == 0)
            {
                return true;
            }

            // Episodes already somewhere in the playlist count as filled without a second copy.
            var counts = OccurrenceCounts(_host.GetRawEntries(context.List.Id));
            foreach (var present in arriving.Where(e => counts.ContainsKey(e.ItemId)).ToList())
            {
                Fill(context, placeholder, present, ownedItem: null); // presence, not ownership (F1)
                arriving.Remove(present);
            }

            while (arriving.Count > 0)
            {
                placeholder = context.Doc.Items.First(p => p.Id == placeholderId);
                var (index, run) = PlanRun(context.Doc.Order, placeholder, arriving);
                var landed = await InsertRunAsync(context, placeholderId, run.Select(e => e.ItemId).ToList(), index).ConfigureAwait(false);
                if (landed == null)
                {
                    return false;
                }

                placeholder = context.Doc.Items.First(p => p.Id == placeholderId);
                foreach (var episode in run.Where(e => landed.Contains(e.ItemId)))
                {
                    Fill(context, placeholder, episode, episode.ItemId);
                    context.Inserted++;
                }

                if (landed.Count < run.Count)
                {
                    // Jellyfin rejected some (e.g. the owner lost access meanwhile): leave them for a later pass.
                    _logger.Debug($"[ListPlaceholders] {run.Count - landed.Count} episode(s) of \"{placeholder.Title}\" were not added to list {context.ListIdN}.");
                }

                arriving.RemoveAll(e => run.Contains(e));
            }

            return true;
        }

        /// <summary>
        /// Where the next arriving episodes go: in episode order relative to the filled episodes already in the list
        /// (before the earliest later filled episode), else right before the placeholder; a run is the arriving episodes
        /// that land contiguously at that spot (one Jellyfin insert).
        /// </summary>
        /// <param name="order">Canonical order.</param>
        /// <param name="placeholder">The placeholder.</param>
        /// <param name="arriving">Arriving episodes, sorted by coordinate.</param>
        /// <returns>The order index of the run and its episodes.</returns>
        internal static (int Index, List<ResolvedItem> Run) PlanRun(IReadOnlyList<string> order, Placeholder placeholder, IReadOnlyList<ResolvedItem> arriving)
        {
            var working = order.ToList();
            var filled = placeholder.Filled.Select(f => (Coord: new EpisodeCoord(f.S, f.E), f.ItemId)).ToList();
            var run = new List<ResolvedItem>();
            var start = -1;
            foreach (var episode in arriving)
            {
                var index = InsertIndex(working, placeholder.Id, filled, episode.Coords[0]);
                if (start >= 0 && index != start + run.Count)
                {
                    break;
                }

                if (start < 0)
                {
                    start = index;
                }

                run.Add(episode);
                working = ListPlaceholderOrder.InsertRealItems(working, index, new[] { episode.ItemId }).Order;
                var idN = N(episode.ItemId);
                filled.AddRange(episode.Coords.Select(c => (c, idN)));
            }

            return (start, run);
        }

        private static int InsertIndex(IReadOnlyList<string> order, string placeholderId, List<(EpisodeCoord Coord, string ItemId)> filled, EpisodeCoord coord)
        {
            var placeholderIndex = PlaceholderIndex(order, placeholderId);
            int? Position(string itemIdN)
            {
                int? before = null, after = null;
                for (var i = 0; i < order.Count; i++)
                {
                    if (ListPlaceholderOrder.TryParseReal(order[i], out var id, out _) && N(id) == itemIdN)
                    {
                        if (i < placeholderIndex)
                        {
                            before = i;
                        }
                        else
                        {
                            after ??= i;
                        }
                    }
                }

                return before ?? after;
            }

            var upper = filled.Where(f => f.Coord.CompareTo(coord) > 0).OrderBy(f => f.Coord)
                .Select(f => Position(f.ItemId)).FirstOrDefault(p => p.HasValue);
            if (upper.HasValue)
            {
                return upper.Value;
            }

            var lower = filled.Where(f => f.Coord.CompareTo(coord) < 0).OrderByDescending(f => f.Coord)
                .Select(f => Position(f.ItemId)).FirstOrDefault(p => p.HasValue);
            return lower.HasValue && lower.Value >= placeholderIndex ? lower.Value + 1 : placeholderIndex;
        }

        /// <summary>
        /// Inserts real items at an order index under a persisted swap intent (A6), then verifies with occurrence
        /// counts. Returns the items that landed (empty when Jellyfin dropped them all) or null when Jellyfin threw;
        /// in both cases the intent is cleared and the order re-reconciled in the context's document.
        /// </summary>
        private async Task<HashSet<Guid>?> InsertRunAsync(PassContext context, string placeholderId, IReadOnlyList<Guid> items, int index)
        {
            var listId = context.List.Id;
            var before = OccurrenceCounts(_host.GetRawEntries(listId));
            var order = context.Doc.Order;
            var anchor = ListPlaceholderOrder.RealAnchorBefore(order, index);
            var (desired, inserted) = ListPlaceholderOrder.InsertRealItems(order, index, items);
            var intent = new SwapIntent
            {
                PhId = placeholderId,
                ItemIds = items.Select(N).ToList(),
                Anchor = anchor,
                Index = index,
                OccurrenceCountsBefore = items.Distinct().ToDictionary(N, id => before.TryGetValue(id, out var count) ? count : 0, StringComparer.Ordinal),
                CreatedAt = IntentStamp(),
            };
            context.Doc.Intents.Add(intent);
            _store.Save(context.Doc);
            context.Doc = _store.LoadForUpdate(context.ListIdN, context.List.Kind);
            context.Dirty = false;

            List<string>? placed = null;
            try
            {
                placed = await ListPlaylistPlacement.PlaceAsync(_host, _logger, listId, context.ListIdN, context.Owner!, items, anchor, desired, inserted).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ListPlaceholders] Swapping into list {context.ListIdN} failed (retried on the next pass): {ex.Message}");
            }

            var raw = _host.GetRawEntries(listId);
            var after = OccurrenceCounts(raw);
            var landed = items.Where(id => after.TryGetValue(id, out var count) && count > intent.OccurrenceCountsBefore[N(id)]).ToHashSet();
            context.Doc.Intents.RemoveAll(i => i.CreatedAt == intent.CreatedAt);
            context.Doc.Order = placed
                ?? (landed.Count > 0 ? await SettleLandedAsync(context, anchor, index, items.Where(landed.Contains).ToList()).ConfigureAwait(false) : Canonical(context.Doc, raw));
            context.Dirty = true;
            return placed == null && landed.Count == 0 ? null : landed;
        }

        /// <summary>
        /// F8: the canonical order once new items landed without a finished placement (Jellyfin threw, or a crash left
        /// an intent): their tokens go where the swap planned them (<paramref name="index"/> while it still follows
        /// <paramref name="anchor"/>, else right after the anchor), so a placeholder keeps following its own fills. On
        /// Jellyfin 10.11, where the append and the moves are separate calls, entries left elsewhere are moved after the
        /// anchor once; anything else keeps Jellyfin's order with placeholders reconciled to their anchors.
        /// </summary>
        private async Task<List<string>> SettleLandedAsync(PassContext context, string? anchor, int? index, IReadOnlyList<Guid> landed)
        {
            var order = context.Doc.Order;
            int at;
            if (index is int planned && planned >= 0 && planned <= order.Count
                && string.Equals(ListPlaceholderOrder.RealAnchorBefore(order, planned), anchor, StringComparison.Ordinal))
            {
                at = planned;
            }
            else
            {
                var anchorIndex = anchor == null ? -1 : order.IndexOf(anchor);
                at = anchor == null ? 0 : anchorIndex < 0 ? order.Count : anchorIndex + 1;
            }

            var (desired, inserted) = ListPlaceholderOrder.InsertRealItems(order, at, landed);
            var desiredReal = desired.Where(ListPlaceholderOrder.IsReal).ToList();
            var actual = ListPlaceholderOrder.BuildRealTokens(_host.GetRawEntries(context.List.Id));
            if (!actual.SequenceEqual(desiredReal, StringComparer.Ordinal) && context.Owner != null)
            {
                try
                {
                    actual = await ListPlaylistPlacement.MoveAfterAnchorAsync(_host, _logger, context.List.Id, context.Owner, anchor, inserted).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[ListPlaceholders] Moving new entries of list {context.ListIdN} into place failed; keeping Jellyfin's order: {ex.Message}");
                    actual = ListPlaceholderOrder.BuildRealTokens(_host.GetRawEntries(context.List.Id));
                }
            }

            return actual.SequenceEqual(desiredReal, StringComparer.Ordinal)
                ? desired
                : ListPlaceholderOrder.Reconcile(desired, actual, context.Doc.Items.Select(p => p.Id).ToList());
        }

        // ── Collections ──────────────────────────────────────────────────────

        private async Task<bool> SwapIntoCollectionAsync(PassContext context, string placeholderId, ScopeResolution resolution)
        {
            var placeholder = context.Doc.Items.First(p => p.Id == placeholderId);
            if (!resolution.Found)
            {
                return true;
            }

            // A Season / Episode item goes in only for coordinates that aren't filled yet (an arrival): one the user
            // removed from the collection by hand after it was filled stays out, as in playlists. A replaced episode
            // file is an arrival for its new Episode item, but not for the Season item that already stood for it; it is
            // one for a different Season item (the season folder moved, so Jellyfin made a new Season item as well).
            var filledBefore = PlaceholderProgress.FilledCoords(placeholder);
            var viaBefore = new Dictionary<EpisodeCoord, string?>();
            foreach (var fill in placeholder.Filled)
            {
                viaBefore.TryAdd(new EpisodeCoord(fill.S, fill.E), fill.Via);
            }

            DropReplacedFills(context, placeholder, resolution);
            var members = OccurrenceCounts(_host.GetRawEntries(context.List.Id));
            var filled = PlaceholderProgress.FilledCoords(placeholder);
            bool NewSeasonFor(EpisodeCoord c, Guid seasonItem) =>
                !filled.Contains(c) && viaBefore.TryGetValue(c, out var via) && via != null && !string.Equals(via, N(seasonItem), StringComparison.Ordinal);
            var toAdd = resolution.Items
                .Where(i => i.Kind switch
                {
                    BaseItemKind.Season => i.Coords.Any(c => !filledBefore.Contains(c) || NewSeasonFor(c, i.ItemId)),
                    BaseItemKind.Episode => i.Coords.Any(c => !filled.Contains(c)),
                    _ => true,
                })
                .Select(i => i.ItemId)
                .Where(id => !members.ContainsKey(id))
                .Distinct()
                .ToList();
            var added = new HashSet<Guid>();
            var rejected = new HashSet<Guid>();
            if (toAdd.Count > 0)
            {
                // F9: persisted before Jellyfin is mutated (it writes the members before its event subscribers run), so a
                // crash or a throw after that write still makes what JE added sync-owned.
                var intent = new SwapIntent
                {
                    PhId = placeholderId,
                    ItemIds = toAdd.Select(N).ToList(),
                    OccurrenceCountsBefore = toAdd.ToDictionary(N, _ => 0, StringComparer.Ordinal),
                    CreatedAt = IntentStamp(),
                };
                context.Doc.Intents.Add(intent);
                _store.Save(context.Doc);
                context.Doc = _store.LoadForUpdate(context.ListIdN, context.List.Kind);
                context.Dirty = false;

                // F10: Jellyfin skips members silently, so only ids absent right before the call (read again after the
                // save) and present after it count as added by JE. Ids someone added meanwhile leave the saved intent too
                // (saved again before the call), or a crash would let recovery take them for JE's and make them sync-owned.
                var before = OccurrenceCounts(_host.GetRawEntries(context.List.Id));
                if (toAdd.RemoveAll(before.ContainsKey) > 0)
                {
                    var keep = toAdd.Select(N).ToHashSet(StringComparer.Ordinal);
                    var saved = context.Doc.Intents.FirstOrDefault(i => i.CreatedAt == intent.CreatedAt);
                    if (saved != null)
                    {
                        saved.ItemIds.RemoveAll(id => !keep.Contains(id));
                        foreach (var id in saved.OccurrenceCountsBefore.Keys.Where(id => !keep.Contains(id)).ToList())
                        {
                            saved.OccurrenceCountsBefore.Remove(id);
                        }

                        if (saved.ItemIds.Count == 0)
                        {
                            context.Doc.Intents.Remove(saved);
                        }
                    }

                    _store.Save(context.Doc);
                    context.Doc = _store.LoadForUpdate(context.ListIdN, context.List.Kind);
                    context.Dirty = false;
                }

                var failed = false;
                if (toAdd.Count > 0)
                {
                    try
                    {
                        await _host.AddToCollectionAsync(context.List.Id, toAdd).ConfigureAwait(false);
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[ListPlaceholders] Adding to collection {context.ListIdN} failed (retried on the next pass): {ex.Message}");
                        failed = true;
                    }
                }

                var after = OccurrenceCounts(_host.GetRawEntries(context.List.Id));
                added = toAdd.Where(after.ContainsKey).ToHashSet();
                rejected = toAdd.Where(id => !added.Contains(id)).ToHashSet();
                context.Doc.Intents.RemoveAll(i => i.CreatedAt == intent.CreatedAt);
                context.Dirty = true;
                context.Inserted += added.Count;
                if (failed && added.Count == 0)
                {
                    return false;
                }

                placeholder = context.Doc.Items.First(p => p.Id == placeholderId);
            }

            RecordCollectionSwap(context, placeholder, resolution, added, rejected);
            return true;
        }

        // F1: only what JE added (`added`) becomes sync-owned; members that were already there are presence. F10: what
        // JE tried to add but Jellyfin didn't take (`rejected`) counts for nothing; a title with nothing else keeps its
        // placeholder for the next pass. A season's fills record the Season item they are in the collection through.
        private void RecordCollectionSwap(PassContext context, Placeholder placeholder, ScopeResolution resolution, HashSet<Guid> added, HashSet<Guid> rejected)
        {
            switch (placeholder.Kind)
            {
                case PlaceholderKinds.Movie:
                case PlaceholderKinds.Series:
                    if (!resolution.Items.All(i => rejected.Contains(i.ItemId)))
                    {
                        Retire(context, placeholder, resolution.Items.Where(i => added.Contains(i.ItemId)).Select(i => N(i.ItemId)).ToList());
                    }

                    break;
                case PlaceholderKinds.Season:
                case PlaceholderKinds.Episodes:
                    foreach (var episode in resolution.Episodes)
                    {
                        // A season's episode is in the collection through the Season item of its show copy.
                        var listItem = placeholder.Kind == PlaceholderKinds.Season
                            ? resolution.Items.FirstOrDefault(i => i.Coords.Contains(episode.Coords[0]))?.ItemId
                            : episode.ItemId;
                        if (listItem.HasValue && !rejected.Contains(listItem.Value))
                        {
                            Fill(context, placeholder, episode, added.Contains(listItem.Value) ? listItem : null, placeholder.Kind == PlaceholderKinds.Season ? listItem : null);
                        }
                    }

                    break;
            }
        }

        // ── Bookkeeping ──────────────────────────────────────────────────────

        // Records an episode as filled. `ownedItem` is the list item JE added for it in this swap (the episode itself, or
        // a collection's Season item) and goes into the source's ownership record; null when the entry was already in the
        // list (F1: presence, not ownership). `via` is a collection season's Season item the episode is in the collection
        // through.
        private void Fill(PassContext context, Placeholder placeholder, ResolvedItem episode, Guid? ownedItem, Guid? via = null)
        {
            var filled = PlaceholderProgress.FilledCoords(placeholder);
            var added = false;
            foreach (var coord in episode.Coords.Where(c => !filled.Contains(c)))
            {
                placeholder.Filled.Add(new FilledEpisode { ItemId = N(episode.ItemId), S = coord.S, E = coord.E, Via = via.HasValue ? N(via.Value) : null });
                added = true;
            }

            if (added)
            {
                placeholder.Filled.Sort((a, b) => new EpisodeCoord(a.S, a.E).CompareTo(new EpisodeCoord(b.S, b.E)));
                ListSourceProvenance.OnSwapped(context.Doc, placeholder, ownedItem.HasValue ? new[] { N(ownedItem.Value) } : Array.Empty<string>());
                context.Dirty = true;
            }
        }

        // A filled episode whose library item no longer exists while another item now stands at that coordinate (an
        // upgrade with a new file name gets a new item id; the old list link dangles) no longer counts: the replacement
        // goes in like any arrival. Fills whose item still exists stay, even when that entry was removed from the list
        // by hand.
        private void DropReplacedFills(PassContext context, Placeholder placeholder, ScopeResolution resolution)
        {
            if (placeholder.Filled.Count == 0 || resolution.Episodes.Count == 0)
            {
                return;
            }

            var current = new Dictionary<EpisodeCoord, string>();
            foreach (var episode in resolution.Episodes)
            {
                foreach (var coord in episode.Coords)
                {
                    current.TryAdd(coord, N(episode.ItemId));
                }
            }

            var gone = new Dictionary<string, bool>(StringComparer.Ordinal);
            bool Gone(string itemIdN)
            {
                if (!gone.TryGetValue(itemIdN, out var result))
                {
                    try
                    {
                        result = Guid.TryParseExact(itemIdN, "N", out var id) && _host.GetItem(id) == null;
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[ListPlaceholders] Reading filled item {itemIdN} failed: {ex.Message}");
                        result = false;
                    }

                    gone[itemIdN] = result;
                }

                return result;
            }

            var removed = placeholder.Filled.RemoveAll(f =>
                current.TryGetValue(new EpisodeCoord(f.S, f.E), out var now) && !string.Equals(now, f.ItemId, StringComparison.Ordinal) && Gone(f.ItemId));
            if (removed > 0)
            {
                _logger.Debug($"[ListPlaceholders] {removed} filled episode(s) of \"{placeholder.Title}\" in list {context.ListIdN} were replaced in the library.");
                context.Dirty = true;
            }
        }

        // The "being added" state of a placeholder after a pass: it ends once the matched item is accounted for (the
        // placeholder retired, the item filled, or the item in the list, e.g. a metadata update of an episode or Season
        // item that is already there). A pass that ran fine but couldn't swap the item in yet (e.g. a view pass while
        // the scan is still writing it) keeps it until the grace period ends; a Jellyfin failure keeps it alive for
        // the retry.
        private void SettlePendingMatch(PassContext context, string placeholderId, Placeholder? placeholder, bool ok)
        {
            var key = MatchKey(context.ListIdN, placeholderId);
            if (!_pendingMatches.TryGetValue(key, out var match))
            {
                return;
            }

            if (!ok)
            {
                _pendingMatches.TryUpdate(key, match with { SeenUtc = UtcNow() }, match);
                return;
            }

            var itemIdN = match.ItemId.ToString("N", CultureInfo.InvariantCulture);
            var accounted = placeholder == null
                || placeholder.Filled.Any(f => string.Equals(f.ItemId, itemIdN, StringComparison.Ordinal))
                || _host.GetRawEntries(context.List.Id).Any(e => e.ItemId == match.ItemId);
            if (accounted || IsExpired(match))
            {
                _pendingMatches.TryRemove(KeyValuePair.Create(key, match));
            }
        }

        private bool IsExpired(PendingMatch match) => UtcNow() - match.SeenUtc > PendingMatchGrace;

        private void Retire(PassContext context, Placeholder placeholder, IReadOnlyCollection<string>? itemIds = null)
        {
            context.Doc.Items.Remove(placeholder);
            context.Doc.Order.Remove(ListPlaceholderOrder.PlaceholderToken(placeholder.Id));
            // After the removal: a sync-owned key then owns only the items (F1).
            ListSourceProvenance.OnSwapped(context.Doc, placeholder, itemIds ?? Array.Empty<string>());
            _pendingMatches.TryRemove(MatchKey(context.ListIdN, placeholder.Id), out _);
            context.Retired++;
            context.Dirty = true;
        }

        // A6: intents left by a crash (or a throw) are completed for the items whose occurrence count went up and
        // rolled back (dropped) for the rest; the next pass retries those. Completed playlist items take the spot the
        // intent planned (F8); collection items JE added become sync-owned (F9).
        private async Task RecoverIntentsAsync(PassContext context)
        {
            if (context.Doc.Intents.Count == 0)
            {
                return;
            }

            var counts = OccurrenceCounts(_host.GetRawEntries(context.List.Id));
            foreach (var intent in context.Doc.Intents.ToList())
            {
                context.Doc.Intents.Remove(intent);
                context.Dirty = true;
                var placeholder = context.Doc.Items.FirstOrDefault(p => p.Id == intent.PhId);
                if (placeholder == null)
                {
                    continue;
                }

                var landed = intent.ItemIds
                    .Where(idN => Guid.TryParseExact(idN, "N", out var id)
                        && counts.TryGetValue(id, out var count)
                        && count > (intent.OccurrenceCountsBefore.TryGetValue(idN, out var previous) ? previous : 0))
                    .Select(idN => Guid.ParseExact(idN, "N"))
                    .ToList();
                if (landed.Count == 0)
                {
                    continue;
                }

                _logger.Info($"[ListPlaceholders] Completed an interrupted swap-in of \"{placeholder.Title}\" in list {context.ListIdN}.");
                if (context.List.Kind == ListKinds.Collection)
                {
                    if (placeholder.Kind is PlaceholderKinds.Movie or PlaceholderKinds.Series)
                    {
                        // The title is in the collection through the copy JE added, whichever copy the resolver lists
                        // first now (another library copy may have been scanned since): retire it, owning what landed,
                        // so the swap below never adds a second copy.
                        Retire(context, placeholder, landed.Select(N).ToList());
                        continue;
                    }

                    var resolution = _resolver.Resolve(placeholder, ListKinds.Collection, Array.Empty<User>());
                    if (resolution.Found)
                    {
                        // The scope is resolved again now: an item that arrived after the intent was saved neither landed
                        // nor is a member, so it counts for nothing here (like JE's own rejected adds) and the swap below
                        // adds it; counting it would retire the placeholder with that episode never in the collection.
                        var rejected = intent.ItemIds
                            .Select(idN => Guid.TryParseExact(idN, "N", out var id) ? id : Guid.Empty)
                            .Where(id => id != Guid.Empty && !landed.Contains(id))
                            .Concat(resolution.Items.Select(i => i.ItemId).Where(id => !landed.Contains(id) && !counts.ContainsKey(id)))
                            .ToHashSet();
                        RecordCollectionSwap(context, placeholder, resolution, landed.ToHashSet(), rejected);
                    }

                    continue;
                }

                context.Doc.Order = await SettleLandedAsync(context, intent.Anchor, intent.Index, landed).ConfigureAwait(false);
                if (placeholder.Kind == PlaceholderKinds.Movie)
                {
                    Retire(context, placeholder, landed.Select(N).ToList());
                    continue;
                }

                foreach (var itemId in landed)
                {
                    var facts = _host.GetItemFacts(itemId);
                    if (facts?.Season is int season && facts.Episode is int episode)
                    {
                        var coords = PlaceholderProgress.CoordsInScope(placeholder, season, episode, facts.EpisodeEnd);
                        if (coords.Count > 0)
                        {
                            Fill(context, placeholder, new ResolvedItem(itemId, BaseItemKind.Episode, coords), itemId);
                        }
                    }
                }
            }
        }

        // ── Library events → placeholders ────────────────────────────────────

        private void MapChangedItems()
        {
            if (_changedItems.IsEmpty)
            {
                return;
            }

            Interlocked.Exchange(ref _overflowLogged, 0);
            var ids = _changedItems.Keys.ToList();
            foreach (var id in ids)
            {
                _changedItems.TryRemove(id, out _);
            }

            if (!_store.HasAnyPlaceholders())
            {
                return;
            }

            foreach (var id in ids)
            {
                LibraryItemFacts? facts;
                try
                {
                    facts = _host.GetItemFacts(id);
                }
                catch (Exception ex)
                {
                    _logger.Debug($"[ListPlaceholders] Reading changed item {id:N} failed: {ex.Message}");
                    continue;
                }

                if (facts == null || facts.IsVirtual)
                {
                    continue;
                }

                switch (facts.Kind)
                {
                    case BaseItemKind.Playlist:
                        // A native edit happened: re-reconcile its canonical order (no placeholder work).
                        if (SafeLoad(N(facts.Id)) is { Items.Count: > 0 })
                        {
                            QueuePass(N(facts.Id), Array.Empty<string>(), MetadataMode.None);
                        }

                        break;
                    case BaseItemKind.Movie:
                        MapRefs(facts, Refs("movie", facts.ProviderIds));
                        break;
                    case BaseItemKind.Episode:
                    case BaseItemKind.Season:
                        if (facts.SeriesProviderIds != null)
                        {
                            MapRefs(facts, Refs("tv", facts.SeriesProviderIds));
                        }

                        break;
                    case BaseItemKind.Series:
                        MapRefs(facts, Refs("tv", facts.ProviderIds));
                        break;
                }
            }
        }

        private HashSet<PlaceholderRef> Refs(string mediaType, IReadOnlyDictionary<string, string> ids)
        {
            var refs = new HashSet<PlaceholderRef>();
            if (ids.TryGetValue(MetadataProvider.Tmdb.ToString(), out var tmdb) && int.TryParse(tmdb, NumberStyles.None, CultureInfo.InvariantCulture, out var tmdbId) && tmdbId > 0)
            {
                refs.UnionWith(_store.FindByTmdb(mediaType, tmdbId));
            }

            if (mediaType == "tv" && ids.TryGetValue(MetadataProvider.Tvdb.ToString(), out var tvdb) && int.TryParse(tvdb, NumberStyles.None, CultureInfo.InvariantCulture, out var tvdbId) && tvdbId > 0)
            {
                refs.UnionWith(_store.FindByTvdb(tvdbId));
            }

            if (ids.TryGetValue(MetadataProvider.Imdb.ToString(), out var imdb) && !string.IsNullOrEmpty(imdb))
            {
                refs.UnionWith(_store.FindByImdb(imdb));
            }

            return refs;
        }

        private void MapRefs(LibraryItemFacts facts, HashSet<PlaceholderRef> refs)
        {
            foreach (var reference in refs)
            {
                var doc = SafeLoad(reference.ListId);
                var placeholder = doc?.Items.FirstOrDefault(p => p.Id == reference.PlaceholderId);
                if (placeholder == null)
                {
                    continue;
                }

                var collection = doc!.ListKind == ListKinds.Collection;
                var matches = facts.Kind switch
                {
                    BaseItemKind.Movie => placeholder.Kind == PlaceholderKinds.Movie,
                    BaseItemKind.Episode => facts.Season is int s && facts.Episode is int e
                        && PlaceholderProgress.CoordsInScope(placeholder, s, e, facts.EpisodeEnd).Count > 0,
                    BaseItemKind.Season => collection && placeholder.Kind == PlaceholderKinds.Season && placeholder.SeasonNumber == facts.Season,
                    BaseItemKind.Series => collection && placeholder.Kind == PlaceholderKinds.Series,
                    _ => false,
                };
                if (matches && (collection || HasOwner(reference.ListId)) && !IsAccounted(doc, placeholder, facts))
                {
                    _pendingMatches[MatchKey(reference.ListId, placeholder.Id)] = new PendingMatch(facts.Id, UtcNow());
                }
                else if (facts.Kind is BaseItemKind.Movie or BaseItemKind.Episode)
                {
                    continue; // out of scope (another season, a TV placeholder sharing an IMDb id, …)
                }

                // Series/Season updates can carry the ids the episodes lacked when they arrived: look at every TV
                // placeholder of the show again.
                QueuePass(reference.ListId, new[] { placeholder.Id }, placeholder.MediaType == "tv" ? MetadataMode.Completion : MetadataMode.None);
            }
        }

        // An update of an item the placeholder already has (a filled episode, or the Season item already in the
        // collection, e.g. a metadata refresh) is not an arrival: it must not show as "being added".
        private bool IsAccounted(ListDoc doc, Placeholder placeholder, LibraryItemFacts facts)
        {
            var itemIdN = facts.Id.ToString("N", CultureInfo.InvariantCulture);
            if (placeholder.Filled.Any(f => string.Equals(f.ItemId, itemIdN, StringComparison.Ordinal)))
            {
                return true;
            }

            if (facts.Kind != BaseItemKind.Season || !Guid.TryParseExact(doc.ListId, "N", out var listId))
            {
                return false;
            }

            if (placeholder.Filled.Count > 0)
            {
                // The season already went in once (episodes arrive as Episode events): an update of its Season item is
                // no arrival, also when the user has removed that item from the collection since.
                return true;
            }

            try
            {
                return _host.GetRawEntries(listId).Any(e => e.ItemId == facts.Id);
            }
            catch (Exception ex)
            {
                _logger.Debug($"[ListPlaceholders] Membership check of list {doc.ListId} failed: {ex.Message}");
                return false;
            }
        }

        // ── Helpers ──────────────────────────────────────────────────────────

        private async Task<Dictionary<string, PlaceholderMetadata>> FetchMetadataAsync(IEnumerable<Placeholder> placeholders, MetadataMode mode, DateTime today, CancellationToken cancellationToken)
        {
            var result = new Dictionary<string, PlaceholderMetadata>(StringComparer.Ordinal);
            if (mode == MetadataMode.None)
            {
                return result;
            }

            if (!ListPlaceholderMetadataService.IsAvailable)
            {
                // Without Seerr only posters can be read (from TMDB with JE's key): the ones UseServerPostersAsync
                // couldn't read in its interactive budget, or left empty while no poster source was configured.
                if ((mode & (MetadataMode.New | MetadataMode.Maintenance)) != 0 && ListPlaceholderMetadataService.TmdbAvailable)
                {
                    await FetchTmdbPostersAsync(placeholders, result, cancellationToken).ConfigureAwait(false);
                }

                return result;
            }

            // Per placeholder, the strictest age any requested mode wants (none = not fetched).
            TimeSpan? MaxAge(Placeholder p)
            {
                if (p.Kind == PlaceholderKinds.Custom || p.TmdbId is not > 0)
                {
                    return null;
                }

                TimeSpan? age = null;
                void Want(TimeSpan value) => age = age.HasValue && age.Value < value ? age : value;
                if ((mode & MetadataMode.Completion) != 0 && p.Kind is PlaceholderKinds.Season or PlaceholderKinds.Series)
                {
                    Want(CompletionMetadataMaxAge);
                }

                if ((mode & MetadataMode.Force) != 0 && p.Kind is PlaceholderKinds.Season or PlaceholderKinds.Series)
                {
                    Want(TimeSpan.Zero);
                }

                if ((mode & MetadataMode.Maintenance) != 0
                    && (p.MediaType == "tv" || p.ReleaseDate == null || p.PosterPath == null || p.PosterUnverified == true || !PlaceholderRules.IsReleased(p, today)))
                {
                    Want(MaintenanceMetadataMaxAge);
                }

                if ((mode & MetadataMode.New) != 0)
                {
                    Want(ListPlaceholderMetadataService.CacheTtl);
                }

                return age;
            }

            var wanted = placeholders.Select(p => (Placeholder: p, MaxAge: MaxAge(p))).Where(w => w.MaxAge.HasValue).ToList();
            var fetched = new ConcurrentDictionary<string, PlaceholderMetadata>(StringComparer.Ordinal);
            var options = new ParallelOptions { MaxDegreeOfParallelism = PassMetadataConcurrency, CancellationToken = cancellationToken };
            await Parallel.ForEachAsync(wanted, options, async (w, token) =>
            {
                var p = w.Placeholder;
                try
                {
                    var meta = await _metadata.FetchAsync(p, w.MaxAge!.Value, today, token).ConfigureAwait(false);
                    if (meta != null)
                    {
                        fetched[p.Id] = meta;
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
                {
                    _logger.Debug($"[ListPlaceholders] Metadata for \"{p.Title}\" failed: {ex.Message}");
                }
            }).ConfigureAwait(false);
            foreach (var pair in fetched)
            {
                result[pair.Key] = pair.Value;
            }

            return result;
        }

        // TMDB posters for TMDB placeholders that have none (or only an unverified one a client sent), as poster-only
        // (Partial) metadata: Apply then sets only the poster and keeps every other stored fact. TMDB answers are cached (a title without a poster too), so a daily
        // maintenance pass asks TMDB again at most once per cache period per title.
        private async Task FetchTmdbPostersAsync(IEnumerable<Placeholder> placeholders, Dictionary<string, PlaceholderMetadata> result, CancellationToken cancellationToken)
        {
            var wanted = placeholders.Where(p => p.Kind != PlaceholderKinds.Custom && p.TmdbId is > 0 && (p.PosterPath == null || p.PosterUnverified == true)).ToList();
            var fetched = new ConcurrentDictionary<string, PlaceholderMetadata>(StringComparer.Ordinal);
            var options = new ParallelOptions { MaxDegreeOfParallelism = PassMetadataConcurrency, CancellationToken = cancellationToken };
            await Parallel.ForEachAsync(wanted, options, async (p, token) =>
            {
                try
                {
                    // A title TMDB read without a poster also counts: it replaces (clears) an unverified client poster.
                    var (poster, answered) = await _metadata.ReadTmdbPosterAsync(p, token).ConfigureAwait(false);
                    if (answered)
                    {
                        fetched[p.Id] = new PlaceholderMetadata { FetchedAtUtc = DateTime.UtcNow, PosterPath = PlaceholderRules.IsValidPosterPath(poster) ? poster : null, Partial = true };
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !token.IsCancellationRequested)
                {
                    _logger.Debug($"[ListPlaceholders] TMDB poster for \"{p.Title}\" failed: {ex.Message}");
                }
            }).ConfigureAwait(false);
            foreach (var pair in fetched)
            {
                result[pair.Key] = pair.Value;
            }
        }

        // Whether a playlist's owner still exists (swap-ins run as the owner).
        private bool HasOwner(string listIdN)
        {
            var list = _host.GetList(Guid.ParseExact(listIdN, "N"));
            return list != null && list.OwnerId != Guid.Empty && _userManager.GetUserById(list.OwnerId) != null;
        }

        private ListDoc? SafeLoad(string listIdN)
        {
            try
            {
                return _store.Load(listIdN);
            }
            catch (InvalidDataException)
            {
                return null;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A file held by another program: this event skips the list; the next pass reads it again.
                _logger.Warning($"[ListPlaceholders] Could not read {listIdN}.json ({ex.Message}).");
                return null;
            }
        }

        private static List<string> Canonical(ListDoc doc, IReadOnlyList<RawEntry> raw) =>
            ListPlaceholderOrder.Reconcile(doc.Order, ListPlaceholderOrder.BuildRealTokens(raw), doc.Items.Select(p => p.Id).ToList());

        private static Dictionary<Guid, int> OccurrenceCounts(IReadOnlyList<RawEntry> raw)
        {
            var counts = new Dictionary<Guid, int>();
            foreach (var entry in raw)
            {
                if (entry.Resolved && entry.ItemId.HasValue)
                {
                    counts[entry.ItemId.Value] = counts.TryGetValue(entry.ItemId.Value, out var count) ? count + 1 : 1;
                }
            }

            return counts;
        }

        private static int PlaceholderIndex(IReadOnlyList<string> order, string placeholderId)
        {
            var index = -1;
            var token = ListPlaceholderOrder.PlaceholderToken(placeholderId);
            for (var i = 0; i < order.Count; i++)
            {
                if (string.Equals(order[i], token, StringComparison.Ordinal))
                {
                    index = i;
                    break;
                }
            }

            return index < 0 ? order.Count : index;
        }

        private static string MatchKey(string listIdN, string placeholderId) => listIdN + "|" + placeholderId;

        // Unique intent id (creation time + random suffix).
        private string IntentStamp() =>
            UtcNow().ToString("o", CultureInfo.InvariantCulture) + "/" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);

        // False when a newer full read was already applied to the placeholder (a concurrent pass's), so this one is stale;
        // otherwise records a full read's fetch time. Partial reads (poster-only, or a season read that failed) are never
        // recorded: they keep the expected episodes and must not block a full read fetched before them. The caller holds
        // the list lock.
        private bool TakeMetadata(string listIdN, string placeholderId, PlaceholderMetadata metadata)
        {
            var key = MatchKey(listIdN, placeholderId);
            if (_appliedMetadataAt.TryGetValue(key, out var newest) && metadata.FetchedAtUtc < newest)
            {
                return false;
            }

            if (!metadata.Partial)
            {
                if (_appliedMetadataAt.Count >= MaxQueuedItems)
                {
                    _appliedMetadataAt.Clear();
                }

                _appliedMetadataAt[key] = metadata.FetchedAtUtc;
            }

            return true;
        }

        // At most one uncached metadata read per placeholder and hour: a show numbered differently in the library than
        // on TMDB keeps "unexpected" fills forever and must not cost a Seerr call on every pass.
        private bool MayForce(string listIdN, string placeholderId)
        {
            var key = MatchKey(listIdN, placeholderId);
            var now = UtcNow();
            if (_lastForced.TryGetValue(key, out var last) && now - last < CompletionMetadataMaxAge)
            {
                return false;
            }

            if (_lastForced.Count >= MaxQueuedItems)
            {
                _lastForced.Clear();
            }

            _lastForced[key] = now;
            return true;
        }

        private static string N(Guid id) => id.ToString("N", CultureInfo.InvariantCulture);

        private void Signal()
        {
            try
            {
                if (_signal.CurrentCount == 0)
                {
                    _signal.Release();
                }
            }
            catch (ObjectDisposedException)
            {
                // shutting down
            }
        }

        private async Task WorkerLoopAsync(CancellationToken cancellationToken)
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    await _signal.WaitAsync(cancellationToken).ConfigureAwait(false);
                    try
                    {
                        // Match arrivals right away, so list views show "available, being added" during the settle delay.
                        if (Enabled)
                        {
                            MapChangedItems();
                        }
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.Debug($"[ListPlaceholders] Matching library changes failed: {ex.Message}");
                    }

                    await Task.Delay(SettleDelay, cancellationToken).ConfigureAwait(false);
                    while (_signal.CurrentCount > 0 && _signal.Wait(0))
                    {
                        // events during the settle delay are covered by this drain
                    }

                    try
                    {
                        await DrainAsync(cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.Warning($"[ListPlaceholders] Swap-in worker failed: {ex.Message}");
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }

        private sealed class PassContext
        {
            public PassContext(ListInfo list, User? owner, ListDoc doc, DateTime today)
            {
                List = list;
                Owner = owner;
                Doc = doc;
                Today = today;
                ListIdN = list.Id.ToString("N", CultureInfo.InvariantCulture);
            }

            public ListInfo List { get; }

            public User? Owner { get; }

            public string ListIdN { get; }

            public DateTime Today { get; }

            public ListDoc Doc { get; set; }

            public bool Dirty { get; set; }

            public int Inserted { get; set; }

            public int Retired { get; set; }
        }

        // A library item matched to a placeholder, and when that was last confirmed (event, or a failed swap attempt).
        private readonly record struct PendingMatch(Guid ItemId, DateTime SeenUtc);

        private sealed record PassRequest(HashSet<string>? Ids, MetadataMode Mode)
        {
            public PassRequest Merge(PassRequest other)
            {
                HashSet<string>? ids = null;
                if (Ids != null && other.Ids != null)
                {
                    ids = new HashSet<string>(Ids, StringComparer.Ordinal);
                    ids.UnionWith(other.Ids);
                }

                return new PassRequest(ids, Mode | other.Mode);
            }
        }
    }
}
