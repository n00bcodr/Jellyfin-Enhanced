using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>What the poster collage does for one list.</summary>
    public enum CollageDecision
    {
        /// <summary>Nothing to do.</summary>
        None,

        /// <summary>Render the collage and set it as the list's primary image.</summary>
        Set,

        /// <summary>Delete JE's collage and let Jellyfin build its own image from the list's items.</summary>
        Remove,

        /// <summary>Forget the record of a collage that is no longer the list's image (replaced by someone else).</summary>
        Forget,
    }

    /// <summary>The poster collage rules (pure, unit-tested).</summary>
    public static class CollageRules
    {
        /// <summary>Decides what to do with a list's primary image.</summary>
        /// <param name="enabled">List Placeholders and the poster collage setting are both on.</param>
        /// <param name="wantCollage">The list has no real items and at least one placeholder with a poster.</param>
        /// <param name="hasImage">The list has a primary image.</param>
        /// <param name="isOurs">That image is the collage JE set (same path and content as recorded).</param>
        /// <param name="isJellyfinCollage">
        /// That image is the collage Jellyfin built from the list's items: JE saw this very file (same path and
        /// content) in the list's internal metadata folder while the list had real items, and it has the exact shape
        /// Jellyfin's playlist collage has (a 600x600 PNG). Its folder alone is no proof (Jellyfin also saves uploads
        /// there when the list's own folder isn't writable), so anything else is treated as an image someone chose.
        /// </param>
        /// <param name="keysUnchanged">The posters JE would use now are the ones its collage was built from.</param>
        /// <param name="hasMarker">JE has a record of a collage for this list.</param>
        /// <returns>The decision.</returns>
        public static CollageDecision Decide(bool enabled, bool wantCollage, bool hasImage, bool isOurs, bool isJellyfinCollage, bool keysUnchanged, bool hasMarker)
        {
            if (!enabled)
            {
                // Turned off: JE takes back only its own collage.
                return isOurs ? CollageDecision.Remove : hasMarker ? CollageDecision.Forget : CollageDecision.None;
            }

            if (wantCollage)
            {
                if (!hasImage)
                {
                    return CollageDecision.Set;
                }

                if (isOurs)
                {
                    return keysUnchanged ? CollageDecision.None : CollageDecision.Set;
                }

                // A collage Jellyfin generated while the list had items is stale now that it has none: replace it.
                // Anything else is an image someone chose and is never touched.
                return isJellyfinCollage ? CollageDecision.Set : hasMarker ? CollageDecision.Forget : CollageDecision.None;
            }

            return isOurs ? CollageDecision.Remove : hasMarker ? CollageDecision.Forget : CollageDecision.None;
        }
    }

    /// <summary>
    /// Gives placeholder-only playlists and collections a poster collage built from their placeholders' TMDB posters
    /// (<c>ListPlaceholdersPosterCollage</c>, off by default; needs <c>ListPlaceholdersEnabled</c>). A list with no
    /// real items otherwise shows Jellyfin's generic icon. The collage is set only while the list has no real items,
    /// never replaces an image someone chose, and is removed as soon as a real item arrives (Jellyfin then builds a
    /// playlist's image from its items; it builds none for unlocked collections, which go back to the default look).
    /// <list type="bullet">
    /// <item>Triggers, debounced per list (<see cref="Debounce"/>, at most <see cref="MaxDelay"/>): every saved or deleted
    /// placeholder document (add, remove, link, apply, create, import, sync, swap-in, maintenance), every native
    /// playlist/collection edit, a pass after startup, the daily maintenance task and turning the setting on or off.</item>
    /// <item>At most <see cref="MaxConcurrency"/> lists are processed at once; a list is never processed twice at once.</item>
    /// <item>The collage is one image every viewer of the list sees, so when users with parental controls can see the
    /// list it only uses placeholders that pass every such user's filter (fail closed, like the list's rows), and draws
    /// for each the poster Seerr has for that title (TMDB's, read with JE's key, when Seerr is off) rather than the
    /// stored one; a title whose poster can't be read is left out. When that was because Seerr or TMDB didn't answer,
    /// the list is checked again with the same growing delay as failed downloads (fail closed meanwhile: a collage
    /// that is left with nothing is removed). A parental-control change re-checks every list.</item>
    /// <item>Posters that can't be downloaded for a while (timeouts, 5xx, 429) are retried with a growing delay
    /// (<see cref="RetryBase"/> doubling up to <see cref="RetryMax"/>) and left out until then, so a flaky poster never
    /// makes JE rewrite the same image over and over (each write fires Jellyfin's ItemUpdated, which re-triggers JE).
    /// A collage whose posters didn't change is never written again.</item>
    /// <item>When a collage shows a poster a viewer with parental controls may no longer see and can't be rebuilt right
    /// now, JE removes it and retries later (fail closed: no image beats a blocked poster).</item>
    /// <item>Never throws into callers: failures are logged and the next trigger tries again.</item>
    /// </list>
    /// </summary>
    public sealed class ListPlaceholderCollageService : IHostedService, IDisposable
    {
        /// <summary>Lists processed at the same time.</summary>
        public const int MaxConcurrency = 2;

        /// <summary>Distinct poster candidates looked at (the first four that load are used).</summary>
        public const int MaxCandidates = 8;

        /// <summary>Most placeholders of one list checked against the parental filters of its restricted viewers.</summary>
        public const int MaxParentalChecks = 48;

        /// <summary>TMDB poster size used for the collage (342 px wide).</summary>
        public const string PosterBaseUrl = "https://image.tmdb.org/t/p/w342";

        /// <summary>
        /// Side of the square PNG collage Jellyfin builds for a playlist from its items (BaseDynamicImageProvider
        /// CreateSquareCollage, saved as poster.png in the internal metadata folder). Collections get no collage from
        /// Jellyfin: CollectionImageProvider only runs for locked collections and copies one item's poster.
        /// </summary>
        public const int JellyfinPlaylistCollageSize = 600;

        private readonly ListPlaceholderStore _store;
        private readonly IListPlaceholderHost _host;
        private readonly IListImageHost _images;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILibraryManager _libraryManager;
        private readonly ListAccessService _access;
        private readonly IUserManager _userManager;
        private readonly ListPlaceholderMetadataService _metadata;
        private readonly ListCollageMarkerStore _markers;

        // Jellyfin's own collages JE saw on lists while they had real items (path + content): the only unmarked
        // images JE may replace once such a list has only placeholders left.
        private readonly ListCollageMarkerStore _nativeCollages;
        private readonly Logger _logger;

        private readonly object _gate = new();
        private readonly Dictionary<string, (DateTime Due, DateTime First)> _pending = new(StringComparer.Ordinal);
        private readonly HashSet<string> _running = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _listGates = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _signal = new(0, int.MaxValue);
        private readonly SemaphoreSlim _slots = new(MaxConcurrency, MaxConcurrency);

        // Posters that failed temporarily, per list (in memory: the startup pass re-checks every list anyway).
        private readonly ConcurrentDictionary<string, PosterRetry> _retries = new(StringComparer.Ordinal);

        // Lists with restricted viewers whose posters couldn't be verified (Seerr or TMDB didn't answer): checked again
        // with the same growing delay, since the provider coming back fires no event (attempts, next check).
        private readonly ConcurrentDictionary<string, (int Attempts, DateTime Until)> _verifyRetries = new(StringComparer.Ordinal);

        // Evaluations the worker started that haven't finished (StopAsync waits for them).
        private readonly HashSet<Task> _inFlight = new();

        private CancellationTokenSource? _stopping;
        private Task? _worker;
        private Task? _startupPass;
        private bool _subscribed;
        private bool _lastEnabled;
        private int _evaluations;

        /// <summary>Creates the service.</summary>
        /// <param name="store">Placeholder documents.</param>
        /// <param name="host">Jellyfin list facts (does the list exist, which entries resolve).</param>
        /// <param name="images">Image operations.</param>
        /// <param name="httpClientFactory">HTTP clients (TMDB poster downloads).</param>
        /// <param name="libraryManager">Library manager (native list edits).</param>
        /// <param name="access">List access (restricted viewers and their parental filter).</param>
        /// <param name="userManager">User manager (parental-control changes).</param>
        /// <param name="metadata">Seerr title metadata (the server's own poster of each title).</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholderCollageService(
            ListPlaceholderStore store,
            IListPlaceholderHost host,
            IListImageHost images,
            IHttpClientFactory httpClientFactory,
            ILibraryManager libraryManager,
            ListAccessService access,
            IUserManager userManager,
            ListPlaceholderMetadataService metadata,
            Logger logger)
        {
            _store = store;
            _host = host;
            _images = images;
            _httpClientFactory = httpClientFactory;
            _libraryManager = libraryManager;
            _access = access;
            _userManager = userManager;
            _metadata = metadata;
            _logger = logger;
            _markers = new ListCollageMarkerStore(store, logger);
            _nativeCollages = new ListCollageMarkerStore(store, logger, Path.Combine("collages", "native"));
        }

        /// <summary>Quiet time after the last change of a list before its collage is updated.</summary>
        internal TimeSpan Debounce { get; set; } = TimeSpan.FromSeconds(15);

        /// <summary>Longest a list waits while changes keep coming.</summary>
        internal TimeSpan MaxDelay { get; set; } = TimeSpan.FromSeconds(60);

        /// <summary>Delay before the pass over every list after startup.</summary>
        internal TimeSpan StartupDelay { get; set; } = TimeSpan.FromMinutes(2);

        /// <summary>Timeout of one poster download.</summary>
        internal TimeSpan PosterTimeout { get; set; } = TimeSpan.FromSeconds(15);

        /// <summary>Largest poster accepted (bytes).</summary>
        internal int MaxPosterBytes { get; set; } = 2 * 1024 * 1024;

        /// <summary>Wait before the first retry of posters that failed temporarily (doubles on every further failure).</summary>
        internal TimeSpan RetryBase { get; set; } = TimeSpan.FromMinutes(5);

        /// <summary>Longest wait between retries of posters that keep failing.</summary>
        internal TimeSpan RetryMax { get; set; } = TimeSpan.FromHours(6);

        /// <summary>Evaluations run so far (tests).</summary>
        internal int Evaluations => Volatile.Read(ref _evaluations);

        /// <summary>The collage markers (tests).</summary>
        internal ListCollageMarkerStore Markers => _markers;

        /// <summary>The records of Jellyfin's own collages JE saw (tests).</summary>
        internal ListCollageMarkerStore NativeCollages => _nativeCollages;

        /// <summary>When the posters of a list that failed temporarily are retried, or null when none wait (tests).</summary>
        /// <param name="listIdN">List id ("N").</param>
        /// <returns>The retry time (UTC) or null.</returns>
        internal DateTime? RetryUntil(string listIdN) => _retries.TryGetValue(listIdN, out var retry) ? retry.Until : null;

        /// <summary>When a list whose posters couldn't be verified is checked again, or null (tests).</summary>
        /// <param name="listIdN">List id ("N").</param>
        /// <returns>The check time (UTC) or null.</returns>
        internal DateTime? VerifyRetryUntil(string listIdN) => _verifyRetries.TryGetValue(listIdN, out var retry) ? retry.Until : null;

        /// <summary>When a list is due to be processed next, or null when it isn't queued (tests).</summary>
        /// <param name="listIdN">List id ("N").</param>
        /// <returns>The due time (UTC) or null.</returns>
        internal DateTime? PendingDue(string listIdN)
        {
            lock (_gate)
            {
                return _pending.TryGetValue(listIdN, out var pending) ? pending.Due : null;
            }
        }

        /// <summary>True when List Placeholders and the poster collage are both on.</summary>
        /// <param name="config">Configuration (null = the plugin's current one).</param>
        /// <returns>Whether the collage is enabled.</returns>
        public static bool IsEnabled(PluginConfiguration? config = null)
        {
            config ??= JellyfinEnhanced.Instance?.Configuration;
            return config?.ListPlaceholdersEnabled == true && config.ListPlaceholdersPosterCollage;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _stopping = new CancellationTokenSource();
            var token = _stopping.Token;
            _lastEnabled = IsEnabled();
            _store.Changed += OnDocumentChanged;
            _libraryManager.ItemUpdated += OnLibraryItemUpdated;
            _userManager.OnUserUpdated += OnUserUpdated;
            if (JellyfinEnhanced.Instance is { } plugin)
            {
                plugin.ConfigurationChanged += OnConfigurationChanged;
            }

            _subscribed = true;
            _worker = Task.Run(() => WorkerAsync(token), CancellationToken.None);
            _startupPass = Task.Run(
                async () =>
                {
                    try
                    {
                        await Task.Delay(StartupDelay, token).ConfigureAwait(false);
                        if (IsEnabled())
                        {
                            QueueAll();
                        }
                        else
                        {
                            // Off: take back any collage left behind (a removal that failed, a config edited offline).
                            QueueMarkers();
                        }
                    }
                    catch (OperationCanceledException)
                    {
                        // stopping
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"[ListPlaceholders] Startup collage pass could not be queued: {ex.Message}");
                    }
                },
                CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <summary>
        /// Stops the worker and waits (until <paramref name="cancellationToken"/> fires) for the evaluations it started:
        /// parts of an evaluation don't observe cancellation (an image delete and what follows it) and must not run on
        /// against services that are being disposed.
        /// </summary>
        /// <param name="cancellationToken">The host's shutdown timeout.</param>
        /// <returns>A task.</returns>
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            Unsubscribe();
            _stopping?.Cancel();
            foreach (var task in new[] { _worker, _startupPass })
            {
                if (task == null)
                {
                    continue;
                }

                try
                {
                    await task.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // shutting down
                }
            }

            Task[] inFlight;
            lock (_gate)
            {
                inFlight = _inFlight.ToArray();
            }

            try
            {
                await Task.WhenAll(inFlight).WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // shutting down: the host stopped waiting
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            Unsubscribe();
            var stopping = Interlocked.Exchange(ref _stopping, null);
            stopping?.Cancel();
            bool idle;
            lock (_gate)
            {
                idle = _inFlight.Count == 0;
            }

            // Evaluations still running (the host stopped waiting for them) keep using its token: left to the GC then.
            if (idle)
            {
                stopping?.Dispose();
            }
        }

        /// <summary>
        /// Queues a (debounced) collage update of a list. Cheap and non-blocking: safe from library event threads and
        /// while holding a list lock.
        /// </summary>
        /// <param name="listIdN">List id ("N").</param>
        public void Notify(string listIdN) => Schedule(listIdN, Debounce);

        /// <summary>Queues every list with placeholders or a collage (startup, maintenance, setting turned on or off).</summary>
        public void QueueAll() => QueueAll(TimeSpan.Zero);

        /// <summary>
        /// Queues every list with a collage JE set, so a collage left behind while the feature is off is taken back
        /// (startup and daily maintenance while off), and every list with a record of Jellyfin's collage, so the record
        /// of a list deleted meanwhile goes away.
        /// </summary>
        public void QueueMarkers()
        {
            try
            {
                foreach (var id in _markers.EnumerateListIds().Union(_nativeCollages.EnumerateListIds(), StringComparer.Ordinal))
                {
                    Schedule(id, TimeSpan.Zero);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.Warning($"[ListPlaceholders] Could not list the poster collages: {ex.Message}");
            }
        }

        /// <summary>Waits until nothing is queued or running (tests).</summary>
        /// <param name="timeout">Give up after this long.</param>
        /// <returns>A task.</returns>
        internal async Task WhenIdleAsync(TimeSpan timeout)
        {
            var until = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < until)
            {
                lock (_gate)
                {
                    if (_pending.Count == 0 && _running.Count == 0)
                    {
                        return;
                    }
                }

                await Task.Delay(10).ConfigureAwait(false);
            }

            throw new TimeoutException("The collage queue did not drain.");
        }

        /// <summary>
        /// Brings one list's primary image in line with the rules (see <see cref="CollageRules.Decide"/>). Never throws
        /// (except on cancellation).
        /// </summary>
        /// <param name="listIdN">List id ("N").</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>What was done.</returns>
        public async Task<CollageDecision> EvaluateAsync(string listIdN, CancellationToken cancellationToken)
        {
            if (!ListPlaceholderStore.IsValidListId(listIdN))
            {
                return CollageDecision.None;
            }

            var gate = _listGates.GetOrAdd(listIdN, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                Interlocked.Increment(ref _evaluations);
                return await EvaluateLockedAsync(listIdN, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ListPlaceholders] Poster collage of list {listIdN} failed: {ex.Message}");
                return CollageDecision.None;
            }
            finally
            {
                gate.Release();
            }
        }

        /// <summary>
        /// The distinct, valid TMDB poster paths of a list's placeholders in list order: a playlist's canonical order,
        /// a collection's release-date order.
        /// </summary>
        /// <param name="doc">The placeholder document.</param>
        /// <param name="listKind">The list kind.</param>
        /// <param name="exclude">Poster paths to skip.</param>
        /// <param name="max">Most paths returned.</param>
        /// <returns>Poster paths.</returns>
        internal static List<string> PosterCandidates(ListDoc doc, string listKind, ICollection<string>? exclude = null, int max = MaxCandidates) =>
            DistinctPosters(PosterPlaceholders(doc, listKind, exclude), max);

        /// <summary>
        /// The placeholders with a valid TMDB poster path (not in <paramref name="exclude"/>) in list order: a playlist's
        /// canonical order, a collection's release-date order.
        /// </summary>
        /// <param name="doc">The placeholder document.</param>
        /// <param name="listKind">The list kind.</param>
        /// <param name="exclude">Poster paths to skip.</param>
        /// <returns>The placeholders.</returns>
        internal static List<Placeholder> PosterPlaceholders(ListDoc doc, string listKind, ICollection<string>? exclude = null)
        {
            IEnumerable<Placeholder> ordered;
            if (listKind == ListKinds.Playlist)
            {
                var byId = new Dictionary<string, Placeholder>(StringComparer.Ordinal);
                foreach (var item in doc.Items)
                {
                    byId.TryAdd(item.Id, item);
                }

                var inOrder = new List<Placeholder>(doc.Items.Count);
                foreach (var token in doc.Order)
                {
                    var id = ListPlaceholderOrder.PlaceholderIdOf(token);
                    if (id != null && byId.Remove(id, out var placeholder))
                    {
                        inOrder.Add(placeholder);
                    }
                }

                // Placeholders the order doesn't mention yet (reconciled on the next view) go last, in document order.
                inOrder.AddRange(doc.Items.Where(i => byId.ContainsKey(i.Id)));
                ordered = inOrder;
            }
            else
            {
                ordered = ListPlaceholderOrder.SortForCollection(doc.Items);
            }

            return ordered
                .Where(p => p.PosterPath != null && PlaceholderRules.IsValidPosterPath(p.PosterPath) && (exclude == null || !exclude.Contains(p.PosterPath)))
                .ToList();
        }

        private static List<string> DistinctPosters(IEnumerable<Placeholder> placeholders, int max)
        {
            var result = new List<string>(max);
            foreach (var placeholder in placeholders)
            {
                if (result.Count >= max)
                {
                    break;
                }

                if (!result.Contains(placeholder.PosterPath!, StringComparer.Ordinal))
                {
                    result.Add(placeholder.PosterPath!);
                }
            }

            return result;
        }

        /// <summary>
        /// The poster candidates every restricted viewer of the list may see (<see cref="PosterCandidates"/> when nobody
        /// with parental controls can see it). Each viewer's filter is applied as on the list's rows: blocked titles,
        /// custom and unverifiable entries (unless that viewer added them) and lookups over budget are left out. Each
        /// title that passes contributes the server's poster for it (<see cref="ServerPostersAsync"/>), not the stored one;
        /// titles without a TMDB id or whose poster can't be read are left out. At most <see cref="MaxParentalChecks"/>
        /// placeholders are checked.
        /// </summary>
        /// <returns>The posters, whether a restricted viewer's filter was applied, and whether a title that passed was
        /// left out because its poster source didn't answer (it may be allowed once it does).</returns>
        private async Task<(List<string> Posters, bool Restricted, bool Unverified)> AllowedPosterCandidatesAsync(ListDoc doc, ListInfo list, ICollection<string>? exclude, CancellationToken cancellationToken)
        {
            var ordered = PosterPlaceholders(doc, list.Kind, exclude);
            var viewers = ordered.Count == 0 ? Array.Empty<User>() : _access.GetRestrictedViewers(list);
            if (viewers.Count == 0)
            {
                return (DistinctPosters(ordered, MaxCandidates), false, false);
            }

            var unverified = false;

            var result = new List<string>(MaxCandidates);
            var index = 0;
            var checkedCount = 0;
            while (result.Count < MaxCandidates && index < ordered.Count && checkedCount < MaxParentalChecks)
            {
                var batch = new List<Placeholder>(MaxCandidates);
                while (index < ordered.Count && batch.Count < MaxCandidates && checkedCount < MaxParentalChecks)
                {
                    var placeholder = ordered[index++];
                    if (!result.Contains(placeholder.PosterPath!, StringComparer.Ordinal))
                    {
                        batch.Add(placeholder);
                        checkedCount++;
                    }
                }

                foreach (var viewer in viewers)
                {
                    if (batch.Count == 0)
                    {
                        break;
                    }

                    var hidden = await _access.GetHiddenPlaceholderIdsAsync(batch, viewer, cancellationToken).ConfigureAwait(false);
                    batch.RemoveAll(p => hidden.Contains(p.Id));
                }

                var posters = await ServerPostersAsync(batch, cancellationToken).ConfigureAwait(false);
                foreach (var (poster, answered) in posters)
                {
                    unverified |= !answered;
                    if (result.Count < MaxCandidates && poster != null && !result.Contains(poster, StringComparer.Ordinal)
                        && (exclude == null || !exclude.Contains(poster)))
                    {
                        result.Add(poster);
                    }
                }
            }

            return (result, true, unverified);
        }

        // The server's poster for each placeholder's title, in order: Seerr's (cached metadata), or TMDB's read with JE's
        // key when Seerr is off (as UseServerPostersAsync stores them). Poster null for a custom entry, a title the source
        // doesn't know or can't answer for now, or one without a valid poster. Answered is false when the source gave no
        // answer for a TMDB title (Seerr unreachable or unknown title; any TMDB poster miss): a later check may differ.
        private async Task<(string? Poster, bool Answered)[]> ServerPostersAsync(IReadOnlyList<Placeholder> placeholders, CancellationToken cancellationToken)
        {
            var today = DateTime.UtcNow;
            var seerr = ListPlaceholderMetadataService.IsAvailable;
            var tmdb = !seerr && ListPlaceholderMetadataService.TmdbAvailable;
            return await Task.WhenAll(placeholders.Select(async placeholder =>
            {
                if (placeholder.Kind == PlaceholderKinds.Custom || placeholder.TmdbId is not > 0 || (!seerr && !tmdb))
                {
                    return ((string?)null, true);
                }

                if (seerr)
                {
                    var metadata = await _metadata.FetchAsync(placeholder, ListPlaceholderMetadataService.CacheTtl, today, cancellationToken).ConfigureAwait(false);
                    return (metadata?.PosterPath is { } poster && PlaceholderRules.IsValidPosterPath(poster) ? poster : null, metadata != null);
                }

                var fromTmdb = await _metadata.FetchTmdbPosterAsync(placeholder, cancellationToken).ConfigureAwait(false);
                return (PlaceholderRules.IsValidPosterPath(fromTmdb) ? fromTmdb : null, fromTmdb != null);
            })).ConfigureAwait(false);
        }

        private async Task<CollageDecision> EvaluateLockedAsync(string listIdN, CancellationToken cancellationToken)
        {
            var enabled = IsEnabled();
            var marker = _markers.Load(listIdN);

            // A record of Jellyfin's collage keeps the list on the books until JE sees the list is gone, so the record of
            // a deleted list (document already gone, or deleted while the feature was off) doesn't stay behind.
            var hasNative = _nativeCollages.Exists(listIdN);
            if (!enabled && marker == null && !hasNative)
            {
                _retries.TryRemove(listIdN, out _);
                _verifyRetries.TryRemove(listIdN, out _);
                return CollageDecision.None;
            }

            ListDoc? doc;
            try
            {
                doc = _store.Load(listIdN);
            }
            catch (InvalidDataException)
            {
                return CollageDecision.None; // corrupt document: the store already logged it; touch nothing
            }

            if (doc == null && marker == null && !hasNative)
            {
                _retries.TryRemove(listIdN, out _);
                _verifyRetries.TryRemove(listIdN, out _);
                return CollageDecision.None;
            }

            var listId = Guid.ParseExact(listIdN, "N");
            var list = _host.GetList(listId);
            var image = list == null ? ListImageState.Missing : _images.GetPrimaryImage(listId);
            if (list == null || !image.ListExists)
            {
                _nativeCollages.Delete(listIdN);
                _retries.TryRemove(listIdN, out _);
                _verifyRetries.TryRemove(listIdN, out _);
                if (marker != null)
                {
                    _markers.Delete(listIdN);
                }

                return marker != null ? CollageDecision.Forget : CollageDecision.None;
            }

            var sha = new Lazy<string?>(() => image.IsLocalFile ? _images.HashFile(image.Path!) : null);
            marker = AdoptPendingWrite(listIdN, marker, image, sha);
            var isOurs = marker != null && IsSameImage(image, marker, sha);
            var hasReal = enabled && _host.GetRawEntries(listId).Any(e => e.Resolved);
            var isJellyfinCollage = false;
            if (enabled && image.IsGenerated && !isOurs)
            {
                var native = _nativeCollages.Load(listIdN);
                isJellyfinCollage = native != null && IsSameImage(image, native, sha);
                if (hasReal && !isJellyfinCollage && sha.Value != null && LooksLikeJellyfinCollage(list, image))
                {
                    // Jellyfin's dynamic provider owns the internal metadata image of a playlist with items (it
                    // overwrites it on every refresh): remember this one, so it can be replaced once only placeholders
                    // are left. An image of any other shape there is an upload Jellyfin couldn't save next to the list.
                    _nativeCollages.Save(new ListCollageMarker
                    {
                        ListId = listIdN,
                        ImagePath = image.Path!,
                        Sha256 = sha.Value,
                        SetAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                    });
                    isJellyfinCollage = true;
                }
            }

            // Posters that failed temporarily are left out until their retry is due.
            var now = DateTime.UtcNow;
            _retries.TryGetValue(listIdN, out var retry);
            var waiting = retry != null && now < retry.Until ? retry.Keys : (IReadOnlyCollection<string>)Array.Empty<string>();
            var (allowed, restricted, unverified) = enabled && !hasReal && doc != null
                ? await AllowedPosterCandidatesAsync(doc, list, isOurs ? marker!.FailedKeys : null, cancellationToken).ConfigureAwait(false)
                : (new List<string>(), false, false);
            UpdateVerifyRetry(listIdN, restricted && unverified, now);
            var candidates = waiting.Count == 0 ? allowed : allowed.Where(k => !waiting.Contains(k)).ToList();
            var wanted = candidates.Take(ListPlaceholderCollageRenderer.MaxPosters).ToList();
            var keysUnchanged = isOurs && marker!.PosterKeys.SequenceEqual(wanted, StringComparer.Ordinal);
            var decision = CollageRules.Decide(enabled, allowed.Count > 0, image.HasImage, isOurs, isJellyfinCollage, keysUnchanged, marker != null);

            if (decision != CollageDecision.Set)
            {
                if (retry != null && (waiting.Count == 0 || decision != CollageDecision.None))
                {
                    _retries.TryRemove(listIdN, out _);
                }
                else if (retry != null)
                {
                    ScheduleRetry(listIdN, retry.Until - now); // processed early by another trigger: keep the retry
                }
            }

            switch (decision)
            {
                case CollageDecision.Set:
                    SetResult result;
                    try
                    {
                        result = candidates.Count == 0
                            ? new SetResult(SetOutcome.Failed, new List<string>()) // every allowed poster waits for its retry
                            : await SetAsync(listIdN, listId, list.Kind, candidates, isOurs ? marker : null, cancellationToken).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.Warning($"[ListPlaceholders] Could not set the poster collage of list {listIdN}: {ex.Message}");
                        result = new SetResult(SetOutcome.Failed, new List<string>());
                    }

                    UpdateRetry(listIdN, retry, waiting, result.Transient, now);
                    if (result.Outcome == SetOutcome.Failed && isOurs && restricted && marker!.PosterKeys.Any(k => !allowed.Contains(k, StringComparer.Ordinal)))
                    {
                        // The collage shows a poster a viewer with parental controls may no longer see and can't be
                        // rebuilt right now: fail closed. The retry (or the next change) builds the new one.
                        return await RemoveAsync(listIdN, listId, image, sha, "it shows a poster a viewer with parental controls may not see and could not be rebuilt yet").ConfigureAwait(false);
                    }

                    return result.Outcome == SetOutcome.Written ? CollageDecision.Set : CollageDecision.None;
                case CollageDecision.Remove:
                    return await RemoveAsync(listIdN, listId, image, sha, enabled ? "it has real items or no posters now" : "the collage is turned off").ConfigureAwait(false);
                case CollageDecision.Forget:
                    _markers.Delete(listIdN);
                    _logger.Debug($"[ListPlaceholders] List {listIdN} has an image JE didn't set; leaving it alone.");
                    return decision;
                default:
                    return decision;
            }
        }

        // Deletes JE's collage (only while it is still the image checked) and lets Jellyfin rebuild the list's image.
        private async Task<CollageDecision> RemoveAsync(string listIdN, Guid listId, ListImageState image, Lazy<string?> sha, string reason)
        {
            var deleted = await _images.DeletePrimaryImageAsync(listId, image.Path!, sha.Value).ConfigureAwait(false);
            if (!deleted)
            {
                // The image changed meanwhile. It may be JE's own collage whose write was interrupted after the file was
                // saved: then it is recorded and checked again. Anything else is left alone.
                var current = _images.GetPrimaryImage(listId);
                var currentSha = new Lazy<string?>(() => current.IsLocalFile ? _images.HashFile(current.Path!) : null);
                var adopted = AdoptPendingWrite(listIdN, _markers.Load(listIdN), current, currentSha);
                if (adopted != null && IsSameImage(current, adopted, currentSha))
                {
                    Notify(listIdN);
                    return CollageDecision.None;
                }
            }

            _markers.Delete(listIdN);
            if (!deleted)
            {
                _logger.Debug($"[ListPlaceholders] The image of list {listIdN} changed before JE could remove its collage; leaving it alone.");
                return CollageDecision.Forget;
            }

            _images.QueueImageRefresh(listId);
            _logger.Info($"[ListPlaceholders] Removed the poster collage of list {listIdN} ({reason}).");
            return CollageDecision.Remove;
        }

        // An image with the exact shape of the collage Jellyfin builds for a playlist from its items.
        private bool LooksLikeJellyfinCollage(ListInfo list, ListImageState image) =>
            list.Kind == ListKinds.Playlist
            && image.IsLocalFile
            && string.Equals(Path.GetExtension(image.Path), ".png", StringComparison.OrdinalIgnoreCase)
            && _images.GetPngSize(image.Path!) is (JellyfinPlaylistCollageSize, JellyfinPlaylistCollageSize);

        // Records the posters that failed temporarily and queues their retry with a growing delay; forgets the retry
        // once nothing waits any more.
        private void UpdateRetry(string listIdN, PosterRetry? retry, IReadOnlyCollection<string> waiting, List<string> failedNow, DateTime now)
        {
            if (failedNow.Count == 0)
            {
                if (waiting.Count == 0)
                {
                    _retries.TryRemove(listIdN, out _);
                }
                else
                {
                    ScheduleRetry(listIdN, retry!.Until - now);
                }

                return;
            }

            var attempts = (retry?.Attempts ?? 0) + 1;
            var delay = RetryDelay(attempts);
            var keys = new HashSet<string>(waiting, StringComparer.Ordinal);
            keys.UnionWith(failedNow);
            _retries[listIdN] = new PosterRetry(attempts, now + delay, keys);
            _logger.Debug($"[ListPlaceholders] {failedNow.Count} poster(s) of list {listIdN} could not be downloaded; retrying in {delay}.");
            ScheduleRetry(listIdN, delay);
        }

        // A list whose allowed posters may be incomplete because a poster source didn't answer is checked again (growing
        // delay); once every title could be checked, the record goes.
        private void UpdateVerifyRetry(string listIdN, bool unverified, DateTime now)
        {
            if (!unverified)
            {
                _verifyRetries.TryRemove(listIdN, out _);
                return;
            }

            _verifyRetries.TryGetValue(listIdN, out var previous);
            if (previous.Attempts > 0 && now < previous.Until)
            {
                ScheduleRetry(listIdN, previous.Until - now); // checked early by another trigger: keep the planned check
                return;
            }

            var attempts = previous.Attempts + 1;
            var delay = RetryDelay(attempts);
            _verifyRetries[listIdN] = (attempts, now + delay);
            _logger.Debug($"[ListPlaceholders] Posters of list {listIdN} could not all be verified for its restricted viewers; checking again in {delay}.");
            ScheduleRetry(listIdN, delay);
        }

        private TimeSpan RetryDelay(int attempts)
        {
            var delay = RetryBase;
            for (var i = 1; i < attempts && delay < RetryMax; i++)
            {
                delay += delay;
            }

            return delay < RetryMax ? delay : RetryMax;
        }

        // JE's last write saved the file but failed or was interrupted before it was recorded: when the list's image is that
        // very file (the pending content, in the internal metadata folder where JE saves), it is recorded as JE's now.
        private ListCollageMarker? AdoptPendingWrite(string listIdN, ListCollageMarker? marker, ListImageState image, Lazy<string?> sha)
        {
            if (marker?.PendingSha256 == null || !image.IsGenerated || sha.Value == null
                || !string.Equals(sha.Value, marker.PendingSha256, StringComparison.OrdinalIgnoreCase))
            {
                return marker;
            }

            marker.ImagePath = image.Path!;
            marker.Sha256 = marker.PendingSha256;
            marker.PosterKeys = marker.PendingPosterKeys ?? new List<string>();
            marker.PendingSha256 = null;
            marker.PendingPosterKeys = null;
            marker.SetAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            _markers.Save(marker);
            _nativeCollages.Delete(listIdN);
            _logger.Debug($"[ListPlaceholders] Recorded the poster collage of list {listIdN} whose write was interrupted.");
            return marker;
        }

        // The list's primary image is the recorded one: same path and same content.
        private static bool IsSameImage(ListImageState image, ListCollageMarker record, Lazy<string?> sha) =>
            image.IsLocalFile
            && string.Equals(image.Path, record.ImagePath, StringComparison.OrdinalIgnoreCase)
            && sha.Value != null
            && string.Equals(sha.Value, record.Sha256, StringComparison.OrdinalIgnoreCase);

        /// <summary>Downloads the posters, renders the collage and saves it (unless it would be the same image).</summary>
        /// <param name="listIdN">List id ("N").</param>
        /// <param name="listId">List id.</param>
        /// <param name="listKind">List kind.</param>
        /// <param name="candidates">Poster paths to try, in order.</param>
        /// <param name="ours">The marker of JE's collage when it is the list's image now.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>What happened, and the posters that failed temporarily.</returns>
        private async Task<SetResult> SetAsync(string listIdN, Guid listId, string listKind, List<string> candidates, ListCollageMarker? ours, CancellationToken cancellationToken)
        {
            var posters = new List<byte[]>(ListPlaceholderCollageRenderer.MaxPosters);
            var used = new List<string>(ListPlaceholderCollageRenderer.MaxPosters);
            var failed = new List<string>(ours?.FailedKeys ?? new List<string>());
            var transient = new List<string>();
            try
            {
                foreach (var key in candidates)
                {
                    if (posters.Count == ListPlaceholderCollageRenderer.MaxPosters)
                    {
                        break;
                    }

                    var (bytes, permanent) = await FetchPosterAsync(key, cancellationToken).ConfigureAwait(false);
                    if (bytes != null && !ListPlaceholderCollageRenderer.CanDecode(bytes))
                    {
                        // A 200 with a corrupt or truncated body: skip it like a missing poster and try the next one.
                        _logger.Debug($"[ListPlaceholders] Poster {key} could not be decoded.");
                        (bytes, permanent) = (null, true);
                    }

                    if (bytes != null)
                    {
                        posters.Add(bytes);
                        used.Add(key);
                    }
                    else if (permanent)
                    {
                        if (!failed.Contains(key, StringComparer.Ordinal))
                        {
                            failed.Add(key);
                        }
                    }
                    else
                    {
                        transient.Add(key);
                    }
                }
            }
            catch (Exception ex) when (ex is TypeInitializationException or DllNotFoundException or EntryPointNotFoundException)
            {
                _logger.Warning($"[ListPlaceholders] Could not decode posters for the collage of list {listIdN}: {ex.GetType().Name}: {ex.Message}");
                return new SetResult(SetOutcome.Failed, new List<string>());
            }

            if (posters.Count == 0)
            {
                _logger.Debug($"[ListPlaceholders] No poster of list {listIdN} could be downloaded; no collage for now.");
                return new SetResult(SetOutcome.Failed, transient);
            }

            if (ours != null && used.SequenceEqual(ours.PosterKeys, StringComparer.Ordinal))
            {
                // The list already shows exactly this collage (a poster that failed again before it): writing it again
                // would only fire Jellyfin's ItemUpdated and bring JE straight back here.
                if (!failed.SequenceEqual(ours.FailedKeys, StringComparer.Ordinal))
                {
                    ours.FailedKeys = failed;
                    _markers.Save(ours);
                }

                return new SetResult(SetOutcome.Unchanged, transient);
            }

            byte[]? jpeg;
            try
            {
                jpeg = ListPlaceholderCollageRenderer.Render(posters, listKind == ListKinds.Playlist);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // e.g. a host without a usable SkiaSharp (TypeInitializationException / DllNotFoundException).
                _logger.Warning($"[ListPlaceholders] Could not render the poster collage of list {listIdN}: {ex.GetType().Name}: {ex.Message}");
                return new SetResult(SetOutcome.Failed, transient);
            }

            if (jpeg == null)
            {
                _logger.Debug($"[ListPlaceholders] The posters of list {listIdN} could not be decoded; no collage.");
                return new SetResult(SetOutcome.Failed, transient);
            }

            // Re-check right before writing: the feature may have been turned off, or a real item or someone's image
            // may have arrived during the downloads. The image host checks the image once more right before saving.
            var before = _images.GetPrimaryImage(listId);
            var beforeSha = new Lazy<string?>(() => before.IsLocalFile ? _images.HashFile(before.Path!) : null);
            var marker = AdoptPendingWrite(listIdN, _markers.Load(listIdN), before, beforeSha);
            var native = before.IsGenerated ? _nativeCollages.Load(listIdN) : null;
            var replaceable = !before.HasImage
                || (marker != null && IsSameImage(before, marker, beforeSha))
                || (native != null && IsSameImage(before, native, beforeSha));
            if (!IsEnabled() || !before.ListExists || !replaceable || _host.GetRawEntries(listId).Any(e => e.Resolved))
            {
                _logger.Debug($"[ListPlaceholders] List {listIdN} changed while its collage was being built; skipped.");
                Notify(listIdN);
                return new SetResult(SetOutcome.Superseded, transient);
            }

            // Recorded before the write: if it fails or is interrupted after the file was saved (the item update), the image
            // is still known as JE's (AdoptPendingWrite) instead of looking like someone else's from then on. An exception
            // keeps the record, since the file may have been saved.
            var sha256 = Convert.ToHexString(SHA256.HashData(jpeg)).ToLowerInvariant();
            var pending = marker ?? new ListCollageMarker { ListId = listIdN };
            pending.PendingSha256 = sha256;
            pending.PendingPosterKeys = used;
            _markers.Save(pending);
            var path = await _images.SetPrimaryImageAsync(listId, jpeg, before.HasImage ? before.Path : null, before.HasImage ? beforeSha.Value : null, cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrEmpty(path))
            {
                // Nothing was written: the record goes back to what it was.
                if (marker != null)
                {
                    marker.PendingSha256 = null;
                    marker.PendingPosterKeys = null;
                    _markers.Save(marker);
                }
                else
                {
                    _markers.Delete(listIdN);
                }

                Notify(listIdN);
                return new SetResult(SetOutcome.Superseded, transient);
            }

            _markers.Save(new ListCollageMarker
            {
                ListId = listIdN,
                ImagePath = path,
                Sha256 = sha256,
                PosterKeys = used,
                FailedKeys = failed,
                SetAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
            });
            _nativeCollages.Delete(listIdN);
            _logger.Info($"[ListPlaceholders] Set a poster collage ({used.Count} poster(s)) on list {listIdN}.");
            if (!IsEnabled())
            {
                // Turned off while the image was being written: take it back.
                Schedule(listIdN, TimeSpan.Zero);
            }

            return new SetResult(SetOutcome.Written, transient);
        }

        /// <summary>Downloads one TMDB poster. Permanent = TMDB answered with a client error or the file is unusable.</summary>
        private async Task<(byte[]? Bytes, bool Permanent)> FetchPosterAsync(string posterPath, CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(PosterTimeout);
            try
            {
                var client = _httpClientFactory.CreateClient();
                using var request = new HttpRequestMessage(HttpMethod.Get, PosterBaseUrl + posterPath);
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    var status = (int)response.StatusCode;
                    _logger.Debug($"[ListPlaceholders] Poster {posterPath} answered {status}.");
                    return (null, status is >= 400 and < 500 && response.StatusCode != HttpStatusCode.TooManyRequests && response.StatusCode != HttpStatusCode.RequestTimeout);
                }

                var mediaType = response.Content.Headers.ContentType?.MediaType;
                if (mediaType != null && !mediaType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                {
                    return (null, true);
                }

                if (response.Content.Headers.ContentLength is long length && length > MaxPosterBytes)
                {
                    return (null, true);
                }

                using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
                using var buffer = new MemoryStream();
                var chunk = new byte[81920];
                int read;
                while ((read = await stream.ReadAsync(chunk, timeout.Token).ConfigureAwait(false)) > 0)
                {
                    if (buffer.Length + read > MaxPosterBytes)
                    {
                        return (null, true);
                    }

                    buffer.Write(chunk, 0, read);
                }

                return buffer.Length == 0 ? (null, false) : (buffer.ToArray(), false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                _logger.Debug($"[ListPlaceholders] Poster {posterPath} timed out.");
                return (null, false);
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException)
            {
                _logger.Debug($"[ListPlaceholders] Poster {posterPath} could not be downloaded: {ex.Message}");
                return (null, false);
            }
        }

        private void QueueAll(TimeSpan delay)
        {
            try
            {
                foreach (var id in _store.EnumerateListIds().Union(_markers.EnumerateListIds(), StringComparer.Ordinal).Union(_nativeCollages.EnumerateListIds(), StringComparer.Ordinal))
                {
                    Schedule(id, delay);
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.Warning($"[ListPlaceholders] Could not list documents for the collage pass: {ex.Message}");
            }
        }

        private void Schedule(string listIdN, TimeSpan delay)
        {
            if (!ListPlaceholderStore.IsValidListId(listIdN))
            {
                return;
            }

            var now = DateTime.UtcNow;
            lock (_gate)
            {
                if (_pending.TryGetValue(listIdN, out var pending))
                {
                    var due = now + delay;
                    var cap = pending.First + MaxDelay;
                    _pending[listIdN] = (due < cap ? due : cap, pending.First);
                }
                else
                {
                    _pending[listIdN] = (now + delay, now);
                }
            }

            Signal();
        }

        // Queues a retry: never postpones a pass that is already queued, and a later change isn't held back by it.
        private void ScheduleRetry(string listIdN, TimeSpan delay)
        {
            var due = DateTime.UtcNow + (delay > TimeSpan.Zero ? delay : TimeSpan.Zero);
            lock (_gate)
            {
                if (_pending.TryGetValue(listIdN, out var pending))
                {
                    if (due < pending.Due)
                    {
                        _pending[listIdN] = (due, pending.First);
                    }
                }
                else
                {
                    _pending[listIdN] = (due, due);
                }
            }

            Signal();
        }

        private void Signal()
        {
            if (_signal.CurrentCount == 0)
            {
                _signal.Release();
            }
        }

        private async Task WorkerAsync(CancellationToken cancellationToken)
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    var due = new List<string>();
                    TimeSpan? wait = null;
                    lock (_gate)
                    {
                        var now = DateTime.UtcNow;
                        foreach (var (id, pending) in _pending)
                        {
                            if (_running.Contains(id))
                            {
                                continue; // runs again after the current evaluation finishes
                            }

                            if (pending.Due <= now)
                            {
                                due.Add(id);
                            }
                            else if (wait == null || pending.Due - now < wait)
                            {
                                wait = pending.Due - now;
                            }
                        }

                        foreach (var id in due)
                        {
                            _pending.Remove(id);
                            _running.Add(id);
                        }
                    }

                    foreach (var id in due)
                    {
                        var run = RunOneAsync(id, cancellationToken);
                        lock (_gate)
                        {
                            if (!run.IsCompleted)
                            {
                                _inFlight.Add(run);
                            }
                        }

                        _ = run.ContinueWith(
                            finished =>
                            {
                                lock (_gate)
                                {
                                    _inFlight.Remove(finished);
                                }
                            },
                            CancellationToken.None,
                            TaskContinuationOptions.ExecuteSynchronously,
                            TaskScheduler.Default);
                    }

                    if (due.Count == 0)
                    {
                        await _signal.WaitAsync(wait ?? Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
        }

        private async Task RunOneAsync(string listIdN, CancellationToken cancellationToken)
        {
            try
            {
                await _slots.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    await EvaluateAsync(listIdN, cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    _slots.Release();
                }
            }
            catch (OperationCanceledException)
            {
                // stopping
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ListPlaceholders] Poster collage of list {listIdN} failed: {ex.Message}");
            }
            finally
            {
                lock (_gate)
                {
                    _running.Remove(listIdN);
                }

                Signal();
            }
        }

        private void OnDocumentChanged(string listIdN)
        {
            if (IsEnabled() || _markers.Exists(listIdN))
            {
                Notify(listIdN);
            }
        }

        private void OnLibraryItemUpdated(object? sender, ItemChangeEventArgs e)
        {
            // Native edits of a list (items added, removed, moved, shared) and image updates: JE records the collage
            // Jellyfin builds for a list with items. JE's own image writes trigger one cheap no-op evaluation.
            if (e?.Item is Playlist or BoxSet && IsEnabled())
            {
                Notify(e.Item.Id.ToString("N", CultureInfo.InvariantCulture));
            }
        }

        private void OnConfigurationChanged(object? sender, BasePluginConfiguration configuration)
        {
            var enabled = IsEnabled(configuration as PluginConfiguration);
            if (enabled == _lastEnabled)
            {
                return;
            }

            _lastEnabled = enabled;
            if (enabled)
            {
                QueueAll();
            }
            else
            {
                // Turned off: take back the collages JE set, and re-check the lists being processed right now (a first
                // collage being built has no marker yet).
                List<string> running;
                lock (_gate)
                {
                    running = _running.ToList();
                }

                QueueMarkers();
                foreach (var id in running)
                {
                    Schedule(id, TimeSpan.Zero);
                }
            }
        }

        private void OnUserUpdated(object? sender, GenericEventArgs<User> e)
        {
            // Fired when a user's policy (parental controls) changes: which posters a list's restricted viewers may
            // see can change for any list.
            if (IsEnabled())
            {
                QueueAll(Debounce);
            }
        }

        private void Unsubscribe()
        {
            if (!_subscribed)
            {
                return;
            }

            _subscribed = false;
            _store.Changed -= OnDocumentChanged;
            _libraryManager.ItemUpdated -= OnLibraryItemUpdated;
            _userManager.OnUserUpdated -= OnUserUpdated;
            if (JellyfinEnhanced.Instance is { } plugin)
            {
                plugin.ConfigurationChanged -= OnConfigurationChanged;
            }
        }

        /// <summary>What <see cref="SetAsync"/> did.</summary>
        private enum SetOutcome
        {
            /// <summary>The collage was saved as the list's image.</summary>
            Written,

            /// <summary>The list already shows exactly this collage; nothing was written.</summary>
            Unchanged,

            /// <summary>No collage could be made (no usable poster, no renderer, the write failed).</summary>
            Failed,

            /// <summary>The list changed while the collage was being built; another pass is queued.</summary>
            Superseded,
        }

        /// <summary>The outcome of one collage build and the posters that failed temporarily.</summary>
        private sealed record SetResult(SetOutcome Outcome, List<string> Transient);

        /// <summary>Posters of one list that failed temporarily: left out until <paramref name="Until"/>.</summary>
        private sealed record PosterRetry(int Attempts, DateTime Until, IReadOnlyCollection<string> Keys);
    }
}
