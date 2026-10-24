using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>The outcome of a "Remind" tap.</summary>
    /// <param name="Code">ok, not_found, not_stuck, too_soon, admin or disabled.</param>
    /// <param name="NextAt">When the user may remind again about this title.</param>
    public sealed record RemindOutcome(string Code, DateTimeOffset? NextAt = null);

    /// <summary>
    /// Tells people when things happen ("Requests &amp; downloads", phase 2). It is driven by the change
    /// feed (arr snapshot changes, Jellyfin library arrivals, Seerr request changes) and by Jellyfin's
    /// own library events for followed titles no arr holds; it never polls an arr for family events.
    /// <list type="bullet">
    /// <item><description><b>Ready</b>: a movie a user asked for or follows becomes playable for that
    /// user (the status composer's "Ready", judged by the part asked for: a 4K request waits for the
    /// 4K copy). Users who can't open the copy (library access, parental limits) are never told.</description></item>
    /// <item><description><b>New episodes</b> of followed or requested series: episodes the user can
    /// open that weren't there before, batched per series for <c>ArrNotifyBatchMinutes</c> from the
    /// first one; a whole season arriving together reads "Season 2 is ready".</description></item>
    /// <item><description><b>Declined</b>: the requester hears that the request was declined.</description></item>
    /// <item><description><b>Requests in Jellyfin Enhanced</b> (phase 3): the request ledger's notices tell the
    /// requester that a request was OK'd or declined (with the reason), once each, surviving a restart; in
    /// Jellyfin Enhanced mode the ledger's requests are interests like Seerr's (Ready and new episodes of exactly
    /// the part asked for).</description></item>
    /// <item><description><b>Admin events</b>: a new request waiting for an OK, an instance unreachable
    /// for a while (and back), low disk, a daily digest of downloads stuck for hours, and household
    /// reminders about stuck titles.</description></item>
    /// </list>
    /// Every user's state (what they were last known to have, which episodes, which events they were
    /// told about) is in the database, so a restart neither repeats nor loses a notification: an
    /// event is recorded once per user and event key. The first look at a new interest only records
    /// what is already there (following something that is already ready tells you nothing).
    /// </summary>
    public sealed class NotificationService : IHostedService, IDisposable
    {
        /// <summary>Items that arrived in Jellyfin longer ago than this are not announced (catch-up after a long outage).</summary>
        internal static readonly TimeSpan ArrivalFreshFor = TimeSpan.FromDays(3);

        private static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan FirstSweepAfter = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan AdminEvery = TimeSpan.FromMinutes(1);
        private static readonly TimeSpan PurgeEvery = TimeSpan.FromHours(12);
        private static readonly TimeSpan QuietDebounce = TimeSpan.FromMilliseconds(400);
        private static readonly TimeSpan MaxDebounce = TimeSpan.FromSeconds(3);
        private static readonly TimeSpan RemindEvery = TimeSpan.FromHours(24);
        private static readonly TimeSpan RecentlyAddedWindow = TimeSpan.FromMinutes(10);
        private const int MaxPerRound = 300;
        private const int MaxRecentlyAdded = 5000;

        /// <summary>A batch whose sending fails this many times in a row is dropped (it must not block the others for ever).</summary>
        internal const int MaxBatchTries = 5;
        private static readonly JsonSerializerOptions Json = new();

        private readonly NotifyStore _store;
        private readonly ArrStatusService _status;
        private readonly SeerrFacts _requests;
        private readonly IArrJellyfinView _view;
        private readonly TitleAliases _aliases;
        private readonly ArrChangeFeed _feed;
        private readonly ArrStateStore _arr;
        private readonly INotifyUsers _users;
        private readonly NotifyDispatcher _dispatcher;
        private readonly ILibraryManager? _library;
        private readonly ArrAdminHubService? _hub;
        private readonly JellyfinBridge? _bridge;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly RequestLedger? _ledger;
        private readonly Func<IEnumerable<string>, StatusViewer, CancellationToken, Task<Dictionary<string, HubTitleMeta>>>? _titleMeta;
        private readonly IRequestPolicy? _policy;
        private ConcurrentDictionary<string, byte> _dirty = new(StringComparer.Ordinal);
        private readonly RecentArrivals _recentlyAdded;
        private readonly SemaphoreSlim _round = new(1, 1);
        private volatile SeerrFacts.Derived<HashSet<string>> _interest = SeerrFacts.Remember(new HashSet<string>(StringComparer.Ordinal));
        // Guards _dirty together with _firstDirty/_lastDirty: titles are marked from other threads
        // (the bridge's refresh, Jellyfin's library events) while a round drains them.
        private readonly object _dirtyGate = new();
        private DateTimeOffset? _firstDirty;
        private DateTimeOffset? _lastDirty;
        private string? _epoch;
        private long? _cursor;
        private long _seenRequests = -1;
        private long? _ledgerCursor;
        private long? _storedLedgerCursor;
        private DateTimeOffset _nextSweep;
        private DateTimeOffset _nextAdmin;
        private DateTimeOffset _nextPurge;
        private bool _wasEnabled;
        private volatile bool _pauseNoted;
        private CancellationTokenSource? _loop;
        private Task? _loopTask;
        private long _created;
        private int _bridgeSubscribed;

        /// <summary>The service (DI).</summary>
        public NotificationService(NotifyStore store, ArrStatusService status, SeerrFacts requests, IArrJellyfinView view, ArrChangeFeed feed, ArrStateStore arr, INotifyUsers users, NotifyDispatcher dispatcher, ILibraryManager library, Logger logger, ArrAdminHubService hub, JellyfinBridge bridge, RequestLedger ledger, RequestHubProjection projection)
            : this(store, status, requests, view, feed, arr, users, dispatcher, library, logger, null, null, hub, bridge, ledger, projection.MetaAsync, projection.Service.Policy)
        {
        }

        /// <summary>
        /// A service with explicit configuration and clock (tests; no Jellyfin library events). Without
        /// <paramref name="hub"/> the administrators' checks that read the admin tools' Needs attention
        /// list (outages, low disk, manual imports, OK'd-but-not-in-an-arr, the stuck digest) are skipped;
        /// with <paramref name="bridge"/> a targeted refresh that finds an imported file looks at its title at once;
        /// with <paramref name="ledger"/> the request ledger's notices are delivered and, in Jellyfin Enhanced mode,
        /// its requests are interests (<paramref name="titleMeta"/> names titles no arr holds yet); with
        /// <paramref name="policy"/> an ask waiting for an OK reaches only the administrators who can see its title.
        /// </summary>
        internal NotificationService(NotifyStore store, ArrStatusService status, SeerrFacts requests, IArrJellyfinView view, ArrChangeFeed feed, ArrStateStore arr, INotifyUsers users, NotifyDispatcher dispatcher, ILibraryManager? library, Logger? logger, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now, ArrAdminHubService? hub = null, JellyfinBridge? bridge = null, RequestLedger? ledger = null, Func<IEnumerable<string>, StatusViewer, CancellationToken, Task<Dictionary<string, HubTitleMeta>>>? titleMeta = null, IRequestPolicy? policy = null)
        {
            _ledger = ledger;
            _titleMeta = titleMeta;
            _policy = policy;
            _store = store;
            _status = status;
            _requests = requests;
            _view = view;
            _feed = feed;
            _arr = arr;
            _aliases = new TitleAliases(arr, requests);
            _users = users;
            _dispatcher = dispatcher;
            _library = library;
            _hub = hub;
            _bridge = bridge;
            _logger = logger;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _recentlyAdded = new RecentArrivals(RecentlyAddedWindow, MaxRecentlyAdded, _now);
        }

        /// <summary>Notifications on and the database usable.</summary>
        public bool Enabled => NotifyFlags.Enabled(_config()) && _store.Available;

        /// <summary>The store (routes).</summary>
        public NotifyStore Store => _store;

        /// <summary>The status service (routes).</summary>
        public ArrStatusService Status => _status;

        /// <summary>Notifications created since start (diagnostics).</summary>
        public long Created => Interlocked.Read(ref _created);

        // ================================================================== lifecycle

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            if (_library != null)
            {
                _library.ItemAdded += OnItemAdded;
                _library.ItemUpdated += OnItemUpdated;
            }
            SubscribeBridge();
            _loop = new CancellationTokenSource();
            var token = _loop.Token;
            _loopTask = Task.Run(() => LoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        /// <remarks>
        /// Waits for the round in progress to end (it is cancelled between titles, batches and checks;
        /// a write already started commits whole), or until Jellyfin stops waiting: nothing is written
        /// once it has returned.
        /// </remarks>
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            if (_library != null)
            {
                _library.ItemAdded -= OnItemAdded;
                _library.ItemUpdated -= OnItemUpdated;
            }
            UnsubscribeBridge();
            try
            {
                _loop?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            if (_loopTask is not { } loop) return;
            try
            {
                await loop.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Jellyfin stopped waiting.
            }
        }

        /// <inheritdoc />
        /// <remarks>Safe to call more than once (registered as itself and as a hosted service).</remarks>
        public void Dispose()
        {
            if (_library != null)
            {
                _library.ItemAdded -= OnItemAdded;
                _library.ItemUpdated -= OnItemUpdated;
            }
            UnsubscribeBridge();
            var loop = Interlocked.Exchange(ref _loop, null);
            if (loop == null) return;
            try
            {
                loop.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            loop.Dispose();
        }

        /// <summary>
        /// A start (or the alerts switched back on): the first sweep and administrators' checks a little later,
        /// housekeeping in five minutes, and the interest set rebuilt.
        /// </summary>
        internal void Begin()
        {
            var now = _now();
            _nextSweep = now + FirstSweepAfter;
            _nextAdmin = now + FirstSweepAfter;
            _nextPurge = now + TimeSpan.FromMinutes(5);
            RebuildInterest();
        }

        private async Task LoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    if (!Enabled)
                    {
                        NoteAlertsPaused();
                        _wasEnabled = false;
                        _cursor = null;
                        await Task.Delay(TimeSpan.FromSeconds(5), token).ConfigureAwait(false);
                        continue;
                    }
                    if (!_wasEnabled)
                    {
                        _wasEnabled = true;
                        Begin();
                    }
                    if (_cursor == null)
                    {
                        _epoch = _feed.Epoch;
                        _cursor = _feed.Cursor;
                    }
                    bool pending;
                    lock (_dirtyGate) pending = _firstDirty.HasValue;
                    var wait = pending ? QuietDebounce : TimeSpan.FromSeconds(2);
                    await _feed.WaitAsync(_cursor.Value, wait, token).ConfigureAwait(false);
                    ReadFeed();
                    await TickAsync(token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Notifications: round failed ({ex.GetType().Name}: {ex.Message}).");
                    try
                    {
                        await Task.Delay(TimeSpan.FromSeconds(5), token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        return;
                    }
                }
            }
        }

        /// <summary>Takes the feed's changes since the last read: title keys someone is interested in become due.</summary>
        internal void ReadFeed()
        {
            if (_cursor == null)
            {
                _epoch = _feed.Epoch;
                _cursor = _feed.Cursor;
                return;
            }
            var read = _feed.Read(_epoch, _cursor.Value);
            _epoch = _feed.Epoch;
            _cursor = read.Cursor;
            if (read.Reset)
            {
                // Too much changed to list: look at everything someone is interested in.
                _nextSweep = _now();
                return;
            }
            Observe(read.Changes.Select(c => c.Key));
        }

        /// <summary>Marks title keys (any feed key; others are ignored) as changed.</summary>
        internal void Observe(IEnumerable<string> keys)
        {
            var interest = _interest.Read(new HashSet<string>(StringComparer.Ordinal));
            var titles = new List<string>();
            foreach (var key in keys)
            {
                if (ArrTitleKey.TitleOf(key) is not { } title) continue;
                // A change of a title nobody follows or asked for needs no look (the Seerr scan
                // brings new requests into the interest set first).
                if (!interest.Contains(title)) continue;
                titles.Add(title);
            }
            if (titles.Count > 0) MarkDirty(titles);
        }

        /// <summary>
        /// One round: Seerr's changes, due titles (after a short quiet spell, or at most a few
        /// seconds), the periodic sweep, batches whose window closed, admin checks and housekeeping.
        /// </summary>
        internal Task TickAsync(CancellationToken cancellationToken, bool force = false)
            => SeerrFacts.BackgroundAsync(token => TickAsyncFactsCore(token, force), cancellationToken);

        private async Task TickAsyncFactsCore(CancellationToken cancellationToken, bool force = false)
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (!Enabled)
            {
                NoteAlertsPaused();
                return;
            }
            _pauseNoted = false;
            await _round.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var now = _now();
                if (_requests.Revision != Interlocked.Read(ref _seenRequests))
                {
                    // Only a list that was actually compared counts as seen: one announced before it
                    // finished loading (or while Seerr can't be read) is compared once it has.
                    var revision = _requests.Revision;
                    var prepared = await PrepareAskVisibilityAsync(cancellationToken).ConfigureAwait(false);
                    if (ScanRequests(now, prepared)) Interlocked.Exchange(ref _seenRequests, revision);
                }
                cancellationToken.ThrowIfCancellationRequested();
                // Phase 3: the ledger's notices (OK'd, declined) and, in JE mode, its requests as interests.
                if (NoticesOn) await DeliverRequestNoticesAsync(now, cancellationToken).ConfigureAwait(false);
                // Outcome alerts waiting for evidence: on their own schedule, whatever else changed (or didn't).
                await RetryAlertWaitsAsync(now, cancellationToken).ConfigureAwait(false);
                // Evidence a bell read found unprepared (its rows were shown without their titles meanwhile).
                await PrepareLaterAsync(cancellationToken).ConfigureAwait(false);
                if (LedgerInterest) ScanLedger();
                else _ledgerCursor = null;
                cancellationToken.ThrowIfCancellationRequested();
                if (now >= _nextSweep)
                {
                    _nextSweep = now + SweepEvery;
                    _recentlyAdded.Prune();
                    RebuildInterest();
                    lock (_dirtyGate)
                    {
                        foreach (var key in _interest.Read(new HashSet<string>(StringComparer.Ordinal))) _dirtyFacts[key] = 0;
                        _firstDirty ??= now;
                        _lastDirty = now - QuietDebounce;
                    }
                }
                if (TakeDue(now, force) is { } keys) await EvaluateAsync(keys, null, cancellationToken).ConfigureAwait(false);
                FlushBatches(_now(), cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                if (now >= _nextAdmin)
                {
                    _nextAdmin = now + AdminEvery;
                    await AdminChecksAsync(cancellationToken).ConfigureAwait(false);
                }
                cancellationToken.ThrowIfCancellationRequested();
                if (now >= _nextPurge)
                {
                    _nextPurge = now + PurgeEvery;
                    var removed = _store.Purge(now, _users.Exists);
                    if (removed > 0) _logger?.Info($"Notifications: housekeeping removed {removed} old or orphaned rows.");
                }
            }
            finally
            {
                _round.Release();
            }
        }

        // ================================================================== interest

        /// <summary>
        /// The title keys anyone follows or asked for (movie and series level), plus the other keys
        /// the arrs know those titles by, so changes announced under either reach them.
        /// </summary>
        internal void RebuildInterest() => _interest = SeerrFacts.Derive(BuildInterest);

        private HashSet<string> BuildInterest()
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var f in _store.AllFollows())
            {
                if (TitleKey.Parse(f.Key) is { } k) set.Add(k.Title.ToString());
            }
            foreach (var r in _requests.All)
            {
                if (r.RequestedBy.HasValue && r.Key is { } k) set.Add(k.Title.ToString());
                if (r.FeedKey is { } feed) set.Add(feed);
            }
            if (LedgerInterest)
            {
                foreach (var key in _ledger!.RequestedTitles())
                {
                    if (TitleKey.Parse(key) is { } k) set.Add(k.Title.ToString());
                }
            }
            foreach (var key in set.ToList())
            {
                foreach (var alias in Aliases(TitleKey.Parse(key)!)) set.Add(alias);
            }
            return set;
        }

        // The key a title is looked at under: TMDB for a movie, TVDB for a series, when its own key is
        // another one and an arr library or one of Seerr's requests knows the canonical id.
        private TitleKey Canonical(TitleKey key) => _aliases.Canonical(key);

        // The other keys of a title: the canonical feed key (TMDB movie / TVDB series) and the IMDb /
        // TMDB ids the arr libraries and Seerr's requests (titles no arr holds) know it by.
        private IEnumerable<string> Aliases(TitleKey key) => _aliases.Of(key).Select(k => k.ToString());

        // The title's requests through the same aliases used for its follows and Jellyfin copies.
        private IReadOnlyList<SeerrRequestRecord> RequestsFor(TitleKey key)
            => new[] { key.Title }.Concat(_aliases.Of(key)).SelectMany(_requests.ForTitle).DistinctBy(r => r.Id).ToList();

        /// <summary>
        /// A user's interest in one title: the part of it they asked for (Seerr) and/or follow, or
        /// nothing when they muted it.
        /// </summary>
        private sealed class Interest
        {
            public Guid User { get; init; }

            public TitleKey Key { get; init; } = null!;

            /// <summary>Movies: the scope of the user's own request (null: a plain follow).</summary>
            public ArrStatusService.RequestScope? Scope { get; set; }

            /// <summary>Series: the seasons to tell about (null: every season).</summary>
            public HashSet<int>? Seasons { get; set; }

            /// <summary>Series: single episodes asked for outside <see cref="Seasons"/> (Jellyfin Enhanced requests).</summary>
            public HashSet<(int Season, int Episode)>? Episodes { get; set; }

            /// <summary>Series: the user asked for it in 4K only, so only the 4K copies' episodes count.</summary>
            public bool Only4k { get; set; }

            public bool AllSeasons { get; set; }

            public string? RequestedPoster { get; set; }

            public bool HasRequest { get; set; }

            public bool HasFollow { get; set; }

            /// <summary>
            /// Jellyfin Enhanced requests: when the first of them was asked for. A first look counts what arrived since
            /// as an arrival (the look came late: a restart, or the part beat the first look), not as already there.
            /// </summary>
            public DateTimeOffset? AskedAt { get; set; }
        }

        private List<Interest> InterestsIn(TitleKey title, Guid? onlyUser)
        {
            var keys = new[] { title.ToString() }.Concat(Aliases(title)).Distinct(StringComparer.Ordinal).ToList();
            var follows = _store.FollowsOfTitles(keys);
            var byUser = new Dictionary<Guid, Interest>();
            // A person's second edition of the same title (Jellyfin Enhanced requests): its own interest.
            var extra = new List<Interest>();
            var muted = new HashSet<Guid>(follows.Where(f => f.Muted && TitleKey.Parse(f.Key)?.Season == null).Select(f => f.UserId));
            Interest For(Guid user)
            {
                if (!byUser.TryGetValue(user, out var i)) byUser[user] = i = new Interest { User = user, Key = title };
                return i;
            }
            foreach (var f in follows.Where(f => !f.Muted))
            {
                if (onlyUser.HasValue && f.UserId != onlyUser) continue;
                var parsed = TitleKey.Parse(f.Key);
                if (parsed == null) continue;
                var i = For(f.UserId);
                i.HasFollow = true;
                if (parsed.Season is int season) (i.Seasons ??= new HashSet<int>()).Add(season);
                else i.AllSeasons = true;
            }
            var records = RequestsFor(title);
            foreach (var group in records.Where(r => r.RequestedBy.HasValue).GroupBy(r => r.RequestedBy!.Value))
            {
                if (onlyUser.HasValue && group.Key != onlyUser) continue;
                if (muted.Contains(group.Key)) continue;
                var mine = group.ToList();
                if (!mine.Any(r => r.Active)) continue;
                if (!_store.Prefs(group.Key).AutoFollowRequests) continue;
                var i = For(group.Key);
                i.HasRequest = true;
                // Each edition asked for is followed through its own copy, as in Jellyfin Enhanced mode (a 4K request
                // after the standard copy arrived waits for the 4K copy); a plain follow of a series hears of every copy.
                var editions = !title.IsMovie && i.HasFollow
                    ? new List<List<SeerrRequestRecord>> { mine }
                    : mine.Where(r => r.Active).GroupBy(r => r.Is4k).OrderBy(e => e.Key).Select(e => e.ToList()).ToList();
                foreach (var edition in editions)
                {
                    var target = i;
                    if (edition != editions[0]) extra.Add(target = new Interest { User = group.Key, Key = title, HasRequest = true, HasFollow = i.HasFollow });
                    var scope = RequestsHubService.ScopeOf(edition, group.Key);
                    if (title.IsMovie)
                    {
                        target.Scope = scope;
                        continue;
                    }
                    // A 4K request is followed through the 4K copies, like a 4K movie request and the
                    // Requests page's 4K entries (a plain follow of the series still hears of every copy).
                    target.Only4k = scope.Only4k && !target.HasFollow;
                    if (scope.Seasons.Count == 0)
                    {
                        target.AllSeasons = true;
                    }
                    else
                    {
                        foreach (var s in scope.Seasons) (target.Seasons ??= new HashSet<int>()).Add(s);
                    }
                }
            }
            if (LedgerInterest)
            {
                // Jellyfin Enhanced mode: the request ledger's requests, judged by exactly the part each person asked for.
                var wants = keys.SelectMany(k => _ledger!.ForTitle(k)).Where(w => w.Status is not ("cancelled" or "declined")).DistinctBy(w => w.Id).ToList();
                foreach (var group in wants.GroupBy(w => w.UserId))
                {
                    if (onlyUser.HasValue && group.Key != onlyUser) continue;
                    if (muted.Contains(group.Key)) continue;
                    if (!_store.Prefs(group.Key).AutoFollowRequests) continue;
                    var i = For(group.Key);
                    i.HasRequest = true;
                    // Each edition asked for is followed through its own copy (a 4K ask after the standard copy
                    // arrived waits for the 4K copy); a plain follow of a series hears of every copy already.
                    var editions = !title.IsMovie && i.HasFollow
                        ? new List<List<RequestWant>> { group.ToList() }
                        : group.GroupBy(w => w.Input.Variant == "4k").OrderBy(e => e.Key).Select(e => e.ToList()).ToList();
                    foreach (var mine in editions)
                    {
                        var target = i;
                        if (mine != editions[0]) extra.Add(target = new Interest { User = group.Key, Key = title, HasRequest = true, HasFollow = i.HasFollow });
                        var scope = LedgerRequestFacts.ScopeOf(mine, group.Key, () => _ledger!.Dispatches(mine[0].Input.Key));
                        var asked = mine.Min(w => w.CreatedAt);
                        if (target.AskedAt == null || asked < target.AskedAt) target.AskedAt = asked;
                        if (title.IsMovie)
                        {
                            target.Scope = scope;
                            continue;
                        }
                        target.Only4k = scope.Only4k && !target.HasFollow;
                        // "Keep getting new episodes": every new episode from now on.
                        if (mine.Any(w => w.Input.Scope == "future")) target.AllSeasons = true;
                        foreach (var s in scope.Seasons) (target.Seasons ??= new HashSet<int>()).Add(s);
                        foreach (var e in scope.Episodes ?? Array.Empty<(int Season, int Episode)>()) (target.Episodes ??= new HashSet<(int Season, int Episode)>()).Add(e);
                    }
                }
            }
            return byUser.Values.Concat(extra).ToList();
        }

        /// <summary>Phase 3 is on with a request backend and the ledger is there: its notices are delivered.</summary>
        private bool NoticesOn => _ledger != null && SharedRequestFacts.Active(_config()) && _ledger.Database.Available;

        /// <summary>Jellyfin Enhanced handles requests: the ledger's requests are interests (Seerr's in Seerr mode).</summary>
        private bool LedgerInterest => _ledger != null && SharedRequestFacts.LedgerAuthority(_config()) && _ledger.Database.Available;

        /// <summary>
        /// Takes the ledger's changes since the last look: the titles whose requests changed are looked at (a new
        /// request's first look records what is already there, so only its arrival is told), and the interest set
        /// is rebuilt so their feed changes are followed. Where the looks got to is kept in the database once every
        /// title taken was looked at, so after a restart the requests made just before it get their first look at
        /// once (not only at the first sweep or when what they ask for arrives, which would be recorded silently).
        /// </summary>
        internal void ScanLedger()
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var first = _ledgerCursor == null;
            if (!first && _ledgerCursor != _storedLedgerCursor && _dirtyFacts.IsEmpty) StoreLedgerCursor(_ledgerCursor!.Value);
            var after = first ? StoredLedgerCursor() : _ledgerCursor;
            var (cursor, titles) = _ledger!.ChangedTitles(after);
            _ledgerCursor = cursor;
            if (after == null)
            {
                // Never looked before: from now on.
                StoreLedgerCursor(cursor);
                RebuildInterest();
                return;
            }
            if (!first && titles.Count == 0) return;
            RebuildInterest();
            MarkDirty(titles);
        }

        private const string LedgerCursorKey = "ledger-cursor";

        private long? StoredLedgerCursor()
        {
            _storedLedgerCursor = long.TryParse(_store.Meta(LedgerCursorKey), NumberStyles.None, CultureInfo.InvariantCulture, out var at) ? at : null;
            return _storedLedgerCursor;
        }

        private void StoreLedgerCursor(long cursor)
        {
            _store.SetMeta(LedgerCursorKey, cursor.ToString(CultureInfo.InvariantCulture));
            _storedLedgerCursor = cursor;
        }

        /// <summary>
        /// Delivers the request ledger's notices (phase 3): an OK (approved, or a waiting ask released by someone
        /// else's OK) and a decline (with its reason) tell the requester, through the inbox and their phone and
        /// e-mail like any alert (their switches, quiet hours); one notification per request and kind. Every notice
        /// is removed in the same transaction that adds its notification, so a restart neither repeats nor loses one.
        /// Notices nobody hears about (asks, sends, an arrival: Ready comes from the requester's interest), ones older
        /// than a few days (a catch-up after notifications were off) and ones the request has moved past since are
        /// removed. A new ask by someone with no other request for the title forgets what they were told about it,
        /// so its arrival is told again (as for a Seerr request asked again).
        /// </summary>
        internal async Task<int> DeliverRequestNoticesAsync(DateTimeOffset now, CancellationToken cancellationToken)
        {
            var told = 0;
            // The batch is decided from the database as it is now: a restore while it is handled (between awaits)
            // leaves the rest of it to the next round, which reads the restored notices and requests.
            var generation = _store.Generation;
            foreach (var n in _ledger!.Notices(200))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_store.Generation != generation) break;
                var want = n.Want;
                var key = TitleKey.Parse(want.Input.Key);
                var kind = n.Kind switch
                {
                    "approve" or "merged" => NotifyKind.Approved,
                    "declined" => NotifyKind.Declined,
                    _ => null,
                };
                if (n.Kind == "create" && key != null && LedgerInterest && _users.IsActive(want.UserId)
                    && !_ledger.ForTitle(want.Input.Key).Any(w => w.Id != want.Id && w.UserId == want.UserId && w.CreatedAt <= want.CreatedAt && w.Status is not ("cancelled" or "declined")))
                {
                    ForgetTitle(want.UserId, key, generation);
                }
                // A new ask that waits for an OK tells the administrators (not the asker), as a request waiting in
                // Seerr does; not one held back at sending (Requests shows it as stuck) or one that moved on since.
                // Only those who can see the title (as their Requests page shows its card), each told its name as
                // they see it: an administrator with a parental limit or without its library is told nothing.
                static bool Asks(RequestWant w) => w.Status == "pending" && w.Reason is ("awaiting_approval" or "over_quota");
                if (n.Kind == "create" && key != null && Asks(want)
                    && _now() - n.At <= ArrivalFreshFor && _users.Admins().Where(a => a != want.UserId && _users.IsActive(a)).ToList() is { Count: > 0 } approvers)
                {
                    // Prepare (4f round 8): every administrator's view of the title and its name as they see it, all awaited
                    // before any of them is decided.
                    var names = new Dictionary<Guid, HubTitleMeta?>();
                    foreach (var approver in approvers)
                    {
                        if (_policy != null) await _policy.PrepareVisibilityAsync(approver, want.Input, cancellationToken).ConfigureAwait(false);
                        names[approver] = _titleMeta != null && ActiveViewer(approver) is { } admin
                            ? (await _titleMeta(new[] { key.ToString() }, admin, cancellationToken).ConfigureAwait(false)).GetValueOrDefault(key.ToString())
                            : null;
                    }

                    // Then the final gate for each administrator, after the last await (4f round 9): the request still waiting for
                    // an OK, still an administrator, active, may see the title, as they are now. Notifications switched off (or
                    // the request unreadable) meanwhile: the notice is left for a later round.
                    if (_store.Generation != generation || !_ledger.Database.Available) break;
                    var asked = _ledger.Find(want.Id) ?? want;
                    var finals = new List<NotifyFinal>();
                    foreach (var approver in approvers)
                    {
                        var ask = TitleParams(key.Title, null);
                        if (names[approver] is { } askMeta)
                        {
                            if (!string.IsNullOrEmpty(askMeta.Title)) ask["title"] = askMeta.Title!.Length > 200 ? askMeta.Title[..200] : askMeta.Title;
                            if (askMeta.Year is > 1800) ask["year"] = askMeta.Year.Value.ToString(CultureInfo.InvariantCulture);
                            if (!string.IsNullOrEmpty(askMeta.Poster)) ask["poster"] = askMeta.Poster!;
                        }
                        ask["user"] = _users.Name(asked.UserId) ?? string.Empty;
                        if (asked.Input.Seasons.Length > 0) ask["seasons"] = string.Join(", ", asked.Input.Seasons.Order());
                        if (asked.Input.Variant == "4k") ask["variant"] = "4k";
                        var verdict = _dispatcher.Final(Alert(approver, NotifyKind.Approval, NotifyDispatcher.AskEventPrefix + asked.Id, key.Title.ToString(), null, ask, n.At));
                        switch (verdict.Effect)
                        {
                            case NotifyEffect.Leave:
                            case NotifyEffect.Postpone:
                                // Switched off, or something to wait for: the notice is left (with the rest) for a later round.
                                return told;
                            case NotifyEffect.Suppress:
                                // Not for this administrator: the notice is taken with the others' rows.
                                break;
                            case NotifyEffect.Act:
                                finals.Add(verdict);
                                break;
                        }
                    }
                    var created = _store.InTransaction(generation, tx => tx.TakeRequestNotice(n.Id) ? finals.Where(f => Add(tx, f) != null).ToList() : new List<NotifyFinal>(), new List<NotifyFinal>()).Result;
                    foreach (var f in created) Announce(f);
                    told += created.Count;
                    continue;
                }
                // Not an alert to the requester (an ask told only to administrators, an auto-OK'd request, their own OK).
                if (kind == null || key == null || (kind == NotifyKind.Approved && n.Approver == want.UserId))
                {
                    _store.InTransaction(generation, tx => tx.TakeRequestNotice(n.Id), false);
                    continue;
                }
                var eventKey = (kind == NotifyKind.Approved ? NotifyDispatcher.ApprovedEventPrefix : NotifyDispatcher.DeclinedEventPrefix) + want.Id;
                var p = TitleParams(key.Title, null);
                p["contact"] = Contact();
                if (ScopeLabel(want.Input) is { } scope) p["scope"] = scope;
                if (want.Input.Variant == "4k") p["variant"] = "4k";
                // Released by someone else's request going out (no OK of its own): "on its way".
                if (n.Kind == "merged") p["shared"] = "1";
                if (kind == NotifyKind.Declined && !string.IsNullOrWhiteSpace(n.DeclineReason)) p["reason"] = n.DeclineReason!.Trim() is var r && r.Length > 300 ? r[..300] : r;
                // Told at all? The final gate before the slow steps: one it refuses now (the request moved on, the requester gone
                // or with the kind off, too old) ends here; notifications switched off leave it and the rest for a later round.
                var early = _dispatcher.Final(Alert(want.UserId, kind, eventKey, key.Title.ToString(), null, p, n.At));
                switch (early.Effect)
                {
                    case NotifyEffect.Leave:
                        return told;
                    case NotifyEffect.Suppress:
                        _store.InTransaction(generation, tx => tx.TakeRequestNotice(n.Id), false);
                        continue;
                    case NotifyEffect.Postpone:
                    case NotifyEffect.Act:
                        // Decided again after the slow steps.
                        break;
                }
                if (_titleMeta != null && ActiveViewer(want.UserId) is { } viewer
                    && (await _titleMeta(new[] { key.ToString() }, viewer, cancellationToken).ConfigureAwait(false)).GetValueOrDefault(key.ToString()) is { } meta)
                {
                    if (!string.IsNullOrEmpty(meta.Title)) p["title"] = meta.Title!.Length > 200 ? meta.Title[..200] : meta.Title;
                    if (meta.Year is > 1800) p["year"] = meta.Year.Value.ToString(CultureInfo.InvariantCulture);
                    if (!string.IsNullOrEmpty(meta.Poster)) p["poster"] = meta.Poster!;
                }
                // The policy's input is the request itself (edition, part, routing), prepared and judged as one (4f round 7).
                if (_policy != null) await _policy.PrepareVisibilityAsync(want.UserId, _dispatcher.OutcomeInput(key, eventKey, p) ?? want.Input, cancellationToken).ConfigureAwait(false);
                // Then the final gate, after the last await (4f round 9: the one outcome policy every channel applies again right
                // before its send): notifications switched off meanwhile leave this notice and the rest for a later round; a title
                // they can't see now or hid, the kind switched off or the request moved on is handled with no notification;
                // evidence that can't be read now moves the notice to the wait queue in the same transaction (its own retries,
                // fair between people, expiring from the notice's own time), so it never holds the ledger's page.
                if (_store.Generation != generation || !_ledger.Database.Available) break;
                var final = _dispatcher.Final(Alert(want.UserId, kind, eventKey, key.Title.ToString(), null, p, n.At));
                switch (final.Effect)
                {
                    case NotifyEffect.Leave:
                        return told;
                    case NotifyEffect.Postpone:
                        {
                            var wait = new AlertWait("notice", n.Id, want.UserId, kind, key.Title.ToString(), eventKey, JsonSerializer.Serialize(p), want.Id, n.At, final.Until!.Value, 0);
                            _store.InTransaction(generation, tx => tx.TakeRequestNotice(n.Id) && tx.AddAlertWait(wait), false);
                            continue;
                        }

                    case NotifyEffect.Suppress:
                        _store.InTransaction(generation, tx => tx.TakeRequestNotice(n.Id), false);
                        continue;
                    case NotifyEffect.Act:
                        if (Notify(final, tx => tx.TakeRequestNotice(n.Id), generation)) told++;
                        else _store.InTransaction(generation, tx => tx.TakeRequestNotice(n.Id), false);
                        continue;
                }
            }
            return told;
        }

        /// <summary>The most visibility preparations a bell read can leave for the rounds (more are asked for again on a later read).</summary>
        internal const int PrepareLaterMax = 200;

        /// <summary>How many of them one round prepares.</summary>
        internal const int PrepareLaterPerRound = 50;

        private readonly ConcurrentDictionary<(Guid User, string Input), MutationInput> _prepareLater = new();

        /// <summary>
        /// A bell read found an outcome row whose evidence isn't prepared (an absent title's rating not verified yet for the
        /// person's parental limits): the row is shown without its title for now (never consumed), and its preparation is left
        /// to the next rounds (4f round 7: missing evidence waits and is prepared independently; the next read decides again).
        /// Bounded: beyond <see cref="PrepareLaterMax"/> pending ones, a later read asks again.
        /// </summary>
        internal void PrepareLater(Guid user, MutationInput input)
        {
            if (_policy == null || _prepareLater.Count >= PrepareLaterMax) return;
            _prepareLater.TryAdd((user, JsonSerializer.Serialize(input)), input);
        }

        /// <summary>How many visibility preparations a bell read left that no round has done yet (tests).</summary>
        internal int PreparingLater => _prepareLater.Count;

        private async Task PrepareLaterAsync(CancellationToken cancellationToken)
        {
            if (_policy == null) return;
            foreach (var (key, input) in _prepareLater.Take(PrepareLaterPerRound).ToList())
            {
                cancellationToken.ThrowIfCancellationRequested();
                await _policy.PrepareVisibilityAsync(key.User, input, cancellationToken).ConfigureAwait(false);
                _prepareLater.TryRemove(key, out _);
            }
        }

        /// <summary>How many waiting outcome alerts one round tries (fairly between people: <see cref="NotifyStore.DueAlertWaits"/>).</summary>
        internal const int AlertWaitsPerRound = 100;

        /// <summary>
        /// The wait queue of outcome alerts (4f round 6): each due one is decided again from the evidence as it is now
        /// (<see cref="Outcome"/>), on its own schedule, independent of the request ledger's notices and of Seerr's changes.
        /// Dropped unsent once the outcome itself is too old (its original time), the requester is gone or turned the kind off,
        /// or the request isn't in that outcome any more; told (its removal and the notification commit together) once it may
        /// be; tried again a little later while the evidence still can't be read. Prepare, then decide (4f rounds 8 and 9): each
        /// wait's evidence is prepared (awaited) first, then the final gate decides it from the state after that await (the
        /// switches, the person, the request, the title); notifications switched off meanwhile leave it and the rest for a later
        /// round.
        /// Returns how many were told.
        /// </summary>
        internal async Task<int> RetryAlertWaitsAsync(DateTimeOffset now, CancellationToken cancellationToken)
        {
            var told = 0;
            var generation = _store.Generation;
            foreach (var wait in _store.DueAlertWaits(now, AlertWaitsPerRound))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (_store.Generation != generation) break;
                var payload = new Dictionary<string, string>(NotifyDispatcher.Payload(wait.Payload), StringComparer.Ordinal);
                // Before its preparation: one the final gate refuses now (too old, the requester gone or with the kind off, the
                // request moved on) is dropped at once; notifications switched off leave it and the rest.
                var early = _dispatcher.Final(WaitAlert(wait, payload));
                switch (early.Effect)
                {
                    case NotifyEffect.Leave:
                        return told;
                    case NotifyEffect.Suppress:
                        _store.DropAlertWait(wait, generation);
                        continue;
                    case NotifyEffect.Postpone:
                    case NotifyEffect.Act:
                        // Decided again after its preparation.
                        break;
                }
                if (_policy != null && TitleKey.Parse(wait.TitleKey) is { } key && _dispatcher.OutcomeInput(key, wait.EventKey, payload) is { } input)
                    await _policy.PrepareVisibilityAsync(wait.User, input, cancellationToken).ConfigureAwait(false);
                if (_store.Generation != generation) break;
                var final = _dispatcher.Final(WaitAlert(wait, payload));
                switch (final.Effect)
                {
                    case NotifyEffect.Leave:
                        return told;
                    case NotifyEffect.Postpone:
                        _store.RetryAlertWait(wait, final.Until!.Value, generation);
                        continue;
                    case NotifyEffect.Suppress:
                        _store.DropAlertWait(wait, generation);
                        continue;
                    case NotifyEffect.Act:
                        if (Notify(final, tx => tx.TakeAlertWait(wait.Source, wait.SourceId), generation)) told++;
                        else _store.DropAlertWait(wait, generation);
                        continue;
                }
            }
            return told;
        }

        // A waiting outcome alert as the final gate is asked about it (its own expiry: the outcome's original time).
        private static NotifyAlert WaitAlert(AlertWait wait, IReadOnlyDictionary<string, string> payload)
            => new(wait.User, wait.Kind, wait.TitleKey, null, wait.EventKey, payload) { Since = wait.OriginalAt };

        /// <summary>
        /// Whether an administrator may see the title an ask waiting for an OK (or a reminder about a title) names, by
        /// the rule the Requests page's cards follow (library access, parental limits, the edition's library): the title
        /// and the seasons (or season) and edition the notification names. Checked again when the inbox is read and
        /// before a phone or e-mail alert held for quiet hours (or retried) goes out. True without a policy (tests) or a title.
        /// </summary>
        internal static bool MaySeeAsk(IRequestPolicy? policy, Guid user, string? titleKey, IReadOnlyDictionary<string, string> payload, RequestLedger? ledger = null, string? eventKey = null)
        {
            const string prefix = "approval|je|";
            if (policy != null && eventKey?.StartsWith(prefix, StringComparison.Ordinal) == true)
                return ledger?.Database.Available == true && ledger.Find(eventKey[prefix.Length..]) is { } want
                    && policy.Evaluate(user, want.Input, want.TargetKey).Visible;
            if (policy == null || TitleKey.Parse(titleKey) is not { } key) return true;
            var seasons = (payload.TryGetValue("seasons", out var list) || payload.TryGetValue("season", out list))
                ? list.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(x => int.TryParse(x, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : -1).Where(n => n >= 0).ToArray()
                : Array.Empty<int>();
            return policy.Evaluate(user, AskInput(key, seasons, payload.TryGetValue("variant", out var variant) && variant == "4k")).Visible;
        }

        // The part of a title an ask waiting for an OK (or a Seerr request's outcome) names, as the visibility check reads it.
        internal static MutationInput AskInput(TitleKey key, IEnumerable<int> seasons, bool fourK)
        {
            var input = key.IsMovie
                ? new MutationInput { Key = key.Title.ToString() }
                : new MutationInput { Key = key.Title.ToString(), Scope = "seasons", Seasons = seasons.ToArray() };
            return fourK ? input with { Variant = "4k" } : input;
        }

        /// <summary>
        /// Before Seerr's requests are compared: loads the rating facts each administrator's view of a new request
        /// waiting for an OK needs (when a parental limit decides it), and the requester's view of a decline (for the outcome
        /// policy), so whoever may see its title is told, not left out because its rating wasn't known yet. Only requests not
        /// seen before, at most a round's worth of each. Returns the ids prepared (null without a policy: nothing to prepare):
        /// <see cref="ScanRequests"/> decides only those this round and leaves the rest unseen for the next (4f round 7: one
        /// bound for preparation and consumption).
        /// </summary>
        private async Task<IReadOnlySet<int>?> PrepareAskVisibilityAsync(CancellationToken cancellationToken)
        {
            if (_policy == null) return null;
            var prepared = new HashSet<int>();
            if (!_requests.Active || !_requests.Loaded) return prepared;
            var (source, all, _) = _requests.Current;
            if (source == null) return prepared;
            var seen = _store.SeerrSeen();
            // A decline not seen yet: the requester's own view of the title, for the outcome policy (an absent title's rating),
            // with the request's edition and seasons (the input the outcome policy judges it by).
            foreach (var declined in all.Where(r => r.Status == SeerrRequestStatus.Declined && r.Key != null && r.RequestedBy.HasValue
                         && !(seen.TryGetValue(r.Id, out var was) && was == r.Status)).Take(MaxPerRound))
            {
                await _policy.PrepareVisibilityAsync(declined.RequestedBy!.Value, AskInput(declined.Key!.Title, declined.IsMovie ? Array.Empty<int>() : declined.Seasons, declined.Is4k), cancellationToken).ConfigureAwait(false);
                prepared.Add(declined.Id);
            }
            var asks = all.Where(r => r.Status == SeerrRequestStatus.Pending && r.Key != null && !seen.ContainsKey(r.Id)).Take(MaxPerRound).ToList();
            if (asks.Count == 0) return prepared;
            var admins = _users.Admins();
            foreach (var r in asks)
            {
                var input = AskInput(r.Key!.Title, r.IsMovie ? Array.Empty<int>() : r.Seasons, r.Is4k);
                foreach (var admin in admins.Where(a => a != r.RequestedBy))
                {
                    await _policy.PrepareVisibilityAsync(admin, input, cancellationToken).ConfigureAwait(false);
                }
                prepared.Add(r.Id);
            }
            return prepared;
        }

        /// <summary>The request policy the administrators' ask notifications are checked against (null in tests without one).</summary>
        internal IRequestPolicy? Policy => _policy;

        /// <summary>The ledger used to recheck a persisted request behind an approval notice.</summary>
        internal RequestLedger? Ledger => _ledger;

        /// <summary>The part of a series a request names, as notifications show it after the title ("S1", "S1–S3", "S1E4"); null for a movie or several episodes.</summary>
        internal static string? ScopeLabel(MutationInput input)
        {
            static string N(int n) => n.ToString(CultureInfo.InvariantCulture);
            if (input.Scope == "movie") return null;
            if (input.Scope == "episodes")
                return input.Episodes.Length == 1 ? "S" + N(input.Episodes[0].Season) + "E" + N(input.Episodes[0].Episode) : null;
            var seasons = input.Seasons.OrderBy(x => x).ToArray();
            if (seasons.Length == 0) return null;
            if (seasons.Length == 1) return "S" + N(seasons[0]);
            return seasons[^1] - seasons[0] == seasons.Length - 1 ? "S" + N(seasons[0]) + "–S" + N(seasons[^1]) : null;
        }

        // ================================================================== evaluation

        /// <summary>
        /// Looks at titles for everyone interested in them (or one user): records first looks and
        /// tells about what became ready since the last look.
        /// </summary>
        internal Task EvaluateAsync(IReadOnlyCollection<string> titleKeys, Guid? onlyUser, CancellationToken cancellationToken)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => EvaluateAsyncFactsCore(titleKeys, onlyUser, token), cancellationToken);

        private async Task EvaluateAsyncFactsCore(IReadOnlyCollection<string> titleKeys, Guid? onlyUser, CancellationToken cancellationToken)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var raw in titleKeys)
            {
                // Stopping: what isn't looked at now is looked at by the first sweep after the restart.
                cancellationToken.ThrowIfCancellationRequested();
                // One look per title, under its canonical key (TMDB movie, TVDB series) when an arr knows
                // it: the same title announced under another id is the same interest, the same watch state.
                if (TitleKey.Parse(raw)?.Title is not { } parsed || Canonical(parsed) is not { } title || !seen.Add(title.ToString())) continue;
                foreach (var listed in InterestsIn(title, onlyUser))
                {
                    try
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (ActiveViewer(listed.User) is not { } viewer) continue;
                        // The interests were listed before the looks before this one were awaited: a series look (no await of
                        // its own) takes the person's interest as it is now; a movie's takes it again after its own await.
                        if (title.IsMovie) await EvaluateMovieAsync(viewer, listed, cancellationToken).ConfigureAwait(false);
                        else if (Current(title, listed) is { } interest) EvaluateSeries(viewer, interest);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        _logger?.Warning($"Notifications: could not look at {title} for a user ({ex.GetType().Name}: {ex.Message}).");
                    }
                }
            }
        }

        /// <summary>
        /// A person's interest in a title as it is now (4f round 8: prepare, then decide): the one under the same watch scope
        /// (standard or 4K only), or null when they no longer follow it or ask for it (muted, unfollowed, the request gone or
        /// not followed any more).
        /// </summary>
        private Interest? Current(TitleKey title, Interest listed)
            => InterestsIn(title, listed.User).FirstOrDefault(i => i.Only4k == listed.Only4k && (i.Scope?.Only4k == true) == (listed.Scope?.Only4k == true));

        // The viewer of a user who may be told things: null for a user who is gone or disabled.
        private StatusViewer? ActiveViewer(Guid user) => _users.IsActive(user) ? _view.Viewer(user) : null;

        private async Task EvaluateMovieAsync(StatusViewer viewer, Interest interest, CancellationToken cancellationToken)
        {
            var key = interest.Key;
            // Rows read from here on are only written back to the same database (not a restored one).
            var generation = _store.Generation;
            var scopes = interest.Scope != null ? new Dictionary<TitleKey, ArrStatusService.RequestScope> { [key] = interest.Scope } : null;
            using var bound = CopyLookupBound.Track();
            var composed = (await _status.ComposeForAsync(viewer, new[] { key }, scopes, cancellationToken).ConfigureAwait(false)).FirstOrDefault();
            // A copy lookup that reached its scan bound is not "not here": nothing is remembered from it (the next look reads again).
            if (bound.Reached) return;
            // Decided after that await: the person's interest as it is now (nothing written when it is gone).
            if (Current(key, interest) is not { } current) return;
            interest = current;
            var stage = composed?.Status.Stage ?? "hidden";
            var scopeName = interest.Scope?.Only4k == true ? "m4k" : "m";
            // An interest in one edition (a request): the copies that played anything at the last look, so a copy that turns into
            // that edition in place is an arrival of it dated by the transition (D53, edition round 20), not by the copy's date.
            // An upgrade in place is a change of what backs the item (round 21): the sources each of those copies had then, as
            // Jellyfin holds them for anyone, so a version the viewer only now may open is no arrival.
            var hadPlaying = interest.Scope == null ? null : PlayingBefore(viewer, key, scopeName);
            var hadSources = interest.Scope == null ? null : SourcesBefore(viewer, key, scopeName);
            if (interest.Scope != null)
            {
                var playing = _status.Editions.Holding(viewer, _view.Copies(key, viewer, _aliases.Of(key)).Display, movie: true, Edition.Any).ToList();
                RememberPlaying(viewer, key, scopeName, playing, generation);
                RememberSources(viewer, key, scopeName, _status.Editions.HeldSources(playing), generation);
            }
            var mark = "ready|" + key + "|" + scopeName;
            var itemId = composed?.Visible?.ItemId;
            // The same Jellyfin item is one event however many ids the title is known by.
            var marks = itemId is Guid item && item != Guid.Empty
                ? new[] { mark, "ready-item|" + item.ToString("N", CultureInfo.InvariantCulture) + "|" + scopeName }
                : new[] { mark };
            var now = _now();
            var watch = _store.Watch(viewer.UserId, key.ToString(), scopeName);
            var arrived = composed == null ? null : composed.Scoped ? composed.ArrivedAt : composed.Visible?.DateCreated;
            if (watch == null && !(stage == StatusStage.Ready && ArrivedSinceAsked(interest, arrived)))
            {
                // First look: remember it; what is already ready is never announced (for a request: what was here
                // before it was asked for).
                Written(key, _store.InTransaction(generation, tx =>
                {
                    tx.SetWatch(viewer.UserId, key.ToString(), scopeName, stage, stage == StatusStage.Ready ? ReadyItems(null, itemId) : null, now);
                    if (stage == StatusStage.Ready) foreach (var m in marks) tx.TryMark(viewer.UserId, m, now);
                    return true;
                }, false).Done);
                return;
            }
            if (watch is { } seen && (stage != StatusStage.Ready || seen.Stage == StatusStage.Ready))
            {
                if (stage != seen.Stage) Written(key, _store.InTransaction(generation, tx => { tx.SetWatch(viewer.UserId, key.ToString(), scopeName, stage, seen.Known, now); return true; }, false).Done);
                return;
            }
            // Became ready (or arrived after it was asked for, before its first look): the new stage, the "handled"
            // marks and the notification commit together, so a failure (or a stop) before the notification exists
            // leaves it to the next look.
            var known = watch?.Known;
            var baseline = watch?.Baseline ?? now;
            bool Handle(NotifyTransaction tx)
            {
                tx.SetWatch(viewer.UserId, key.ToString(), scopeName, stage, ReadyItems(known, itemId), now);
                var first = true;
                foreach (var m in marks) first &= tx.TryMark(viewer.UserId, m, now);
                return first;
            }
            var upgraded = itemId is Guid shown && hadPlaying?.Contains(shown) == true
                && NewSource(_status.Editions.Item(viewer, shown, EditionAvailability.Of(interest.Scope!.Only4k)).Select(h => h.Source), hadSources);
            var p = TitleParams(key, itemId);
            if (interest.Scope?.Only4k == true) p["variant"] = "4k";
            if (interest.HasRequest) p["requested"] = "1";
            // The edition the arrival was judged by, so a delivery held for quiet hours is judged again by the same rule.
            p["edition"] = EditionName(interest.Scope == null ? Edition.Any : EditionAvailability.Of(interest.Scope.Only4k));
            // One event per interest: a title asked for again after it was removed (its state forgotten,
            // a new watch baseline) is a new event; the marks keep a flapping upgrade to one.
            var eventKey = mark + "|" + baseline.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);
            // May the person be told: the final gate, after the look's last await (the same decision every channel makes right
            // before its send). The kind switched off, an arrival too old to announce, a title they can't open or hid (Hidden
            // Content, on any copy of it): handled with no notification. Hidden Content that can't be read now, or notifications
            // switched off meanwhile: nothing written, looked at again (when they are back on, the first sweep looks again).
            // Its origin: when the copy arrived; unknown, this look (it became ready now). A copy upgraded in place to the asked
            // edition arrived by that transition, this look (D53, edition round 20), not by the copy's own date.
            var since = arrived is DateTime at && !upgraded ? new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)) : now;
            var final = _dispatcher.Final(Alert(viewer.UserId, NotifyKind.Ready, eventKey, key.ToString(), itemId?.ToString("N", CultureInfo.InvariantCulture), p, since));
            switch (final.Effect)
            {
                case NotifyEffect.Leave:
                case NotifyEffect.Postpone:
                    // Nothing written: looked at again.
                    return;
                case NotifyEffect.Suppress:
                    Written(key, _store.InTransaction(generation, Handle, false).Done);
                    return;
                case NotifyEffect.Act:
                    if (!Notify(final, Handle, generation)) Written(key, _store.Generation == generation);
                    return;
            }
        }

        // A request's part that arrived after it was asked for (so a first look that came late still tells it).
        private static bool ArrivedSinceAsked(Interest interest, DateTime? arrived)
            => interest.AskedAt is DateTimeOffset asked && arrived is DateTime at && at > asked.UtcDateTime;

        // A movie's watch state keeps the Jellyfin items it was ready as (their "ready-item" marks are
        // forgotten with it: Jellyfin gives a file put back at the same path the same item id).
        private static string? ReadyItems(string? known, Guid? item)
        {
            var ids = (known ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries).ToList();
            if (item is Guid id && id != Guid.Empty)
            {
                var n = id.ToString("N", CultureInfo.InvariantCulture);
                ids.Remove(n);
                ids.Add(n);
            }
            return ids.Count == 0 ? null : string.Join(",", ids.TakeLast(10));
        }

        // A write composed from rows read before a restore was dropped: look at the title again (from
        // the restored state) in the next round.
        private void Written(TitleKey key, bool done)
        {
            if (!done) MarkDirty(new[] { key.ToString() });
        }

        // The batch (and watch scope) a series interest is kept under: 4K requests apart from the rest.
        private static string BatchKey(TitleKey key, bool only4k) => only4k ? key + "|4k" : key.ToString();

        private void EvaluateSeries(StatusViewer viewer, Interest interest)
        {
            var key = interest.Key;
            var now = _now();
            var generation = _store.Generation;
            var scope = interest.Only4k ? "eps4k" : "eps";
            var markPrefix = interest.Only4k ? "ep4k|" : "ep|";
            var present = new Dictionary<(int Season, int Episode), (Guid Id, DateTime? Added)>();
            // The Jellyfin series items each episode is in.
            var inSeries = new Dictionary<(int Season, int Episode), List<Guid>>();
            Guid? seriesItem = null;
            var seriesItems = new HashSet<string>(StringComparer.Ordinal);
            using var bound = CopyLookupBound.Track();
            var edition = EditionOf(interest);
            // Every copy the viewer opens, each episode by its own sources in its own series item, through the one availability
            // predicate (D53, edition round 19 part B): a file's own dimensions decide its edition, never the Sonarr whose folder
            // it sits in (an HD file in the 4K folder is no 4K arrival and consumes no 4K mark; a real 4K file in the standard
            // folder is the 4K request's arrival), and a stub plays nothing.
            var (seriesCopies, files) = Arrived(key, viewer, edition);
            // An edition that became available on an item the viewer already played in another edition (a file replaced in
            // place: Jellyfin keeps the item and its date) is an arrival dated by the observed transition (D53, edition round
            // 20), never by the item's date: the items that played at the last look are remembered for an interest in one edition.
            // Round 21: an upgrade in place is a change of the item's backing source (its version, path or quality), judged against
            // the sources those items had at the last look as Jellyfin holds them for anyone (an access-only change is no arrival).
            var hadPlaying = edition == Edition.Any ? null : PlayingBefore(viewer, key, scope);
            var hadSources = edition == Edition.Any ? null : SourcesBefore(viewer, key, scope);
            var playingNow = edition == Edition.Any ? null : Arrived(key, viewer, Edition.Any).Files.Select(f => f.Episode.ItemId).ToHashSet();
            // As for a movie: a lookup that reached its scan bound leaves the watch (what is here) as it was.
            if (bound.Reached) return;
            if (playingNow != null)
            {
                RememberPlaying(viewer, key, scope, playingNow, generation);
                RememberSources(viewer, key, scope, _status.Editions.HeldSources(playingNow, seriesCopies), generation);
            }
            seriesItem = files.Select(f => (Guid?)f.Series).FirstOrDefault() ?? seriesCopies.FirstOrDefault()?.ItemId;
            foreach (var copy in seriesCopies.Where(c => c.ItemId != Guid.Empty)) seriesItems.Add(copy.ItemId.ToString("N", CultureInfo.InvariantCulture));
            var numbers = EpisodeNumbers(key, interest.Only4k, files.Select(f => f.Episode));
            foreach (var (series, e) in files)
            {
                var range = new EpisodeRange(e.Episode, e.EpisodeEnd);
                foreach (var number in numbers.Where(n => n.Season == e.Season && range.Contains(n.Episode)))
                {
                    present.TryAdd(number, (e.ItemId, e.DateCreated));
                    if (!inSeries.TryGetValue(number, out var items)) inSeries[number] = items = new List<Guid>();
                    if (series != Guid.Empty && !items.Contains(series)) items.Add(series);
                }
            }
            var watch = _store.Watch(viewer.UserId, key.ToString(), scope);
            var known = ParseKnown(watch?.Known);
            if (watch == null)
            {
                // First look: what is here is remembered, never announced; for a request, only what was here before it
                // was asked for (what came since is its arrival: the first look came late).
                var asked = interest.AskedAt?.UtcDateTime;
                known = present.Where(p => asked == null || p.Value.Added is not DateTime added || added <= asked).Select(p => p.Key).ToHashSet();
                if (known.Count == present.Count)
                {
                    Written(key, _store.InTransaction(generation, tx => { tx.SetWatch(viewer.UserId, key.ToString(), scope, null, SerializeKnown(present.Keys), now); return true; }, false).Done);
                    return;
                }
            }
            var arrivals = present.Where(p => !known.Contains(p.Key)).OrderBy(a => a.Key.Season).ThenBy(a => a.Key.Episode).ToList();
            if (arrivals.Count == 0) return;
            var prefs = _store.Prefs(viewer.UserId);
            foreach (var a in arrivals) known.Add(a.Key);
            var minutes = Math.Clamp(_config()?.ArrNotifyBatchMinutes ?? 10, 1, 60);
            // The episodes' marks, the known set and the batch commit together: a failure leaves the
            // arrivals new for the next look; a restore since the watch was read drops them (looked at again).
            // An episode is told once per series item too. Open batches of the same variant that
            // turn out to be one series are merged here, even for different seasons.
            // A joining id's copies are checked too when the batch is sent.
            var written = _store.InTransaction(generation, tx =>
            {
                var wanted = new List<(int Season, int Episode, Guid Id, DateTimeOffset At)>();
                var noted = new HashSet<Guid>();
                foreach (var (number, (id, added)) in arrivals)
                {
                    var inScope = interest.AllSeasons ? number.Season > 0 : interest.Seasons?.Contains(number.Season) == true || interest.Episodes?.Contains(number) == true;
                    if (!inScope) continue;
                    if (!tx.TryMark(viewer.UserId, markPrefix + key + ":s" + number.Season.ToString(CultureInfo.InvariantCulture) + ":e" + number.Episode.ToString(CultureInfo.InvariantCulture), now)) continue;
                    var fresh = true;
                    foreach (var series in inSeries[number])
                    {
                        if (noted.Add(series)) tx.TryMark(viewer.UserId, NotifyTransaction.EpisodeSeriesMark(key.ToString(), series), now);
                        fresh &= tx.TryMark(viewer.UserId, NotifyTransaction.EpisodeItemMark(series, interest.Only4k, number), now);
                    }
                    if (!fresh) continue;
                    var upgraded = hadPlaying?.Contains(id) == true && NewSource(_status.Editions.Item(viewer, id, edition).Select(h => h.Source), hadSources);
                    if (added is DateTime at && now.UtcDateTime - at > ArrivalFreshFor && !upgraded) continue;
                    // Its own arrival travels with it to the flush (4f round 10): when Jellyfin added it, else this look; an
                    // upgrade in place arrived by that transition, this look (D53, edition round 20).
                    var arrival = !upgraded && added is DateTime when && when <= now.UtcDateTime ? new DateTimeOffset(DateTime.SpecifyKind(when, DateTimeKind.Utc)) : now;
                    wanted.Add((number.Season, number.Episode, id, arrival));
                }
                tx.SetWatch(viewer.UserId, key.ToString(), scope, null, SerializeKnown(known), now);
                if (wanted.Count > 0 && prefs.Episodes)
                {
                    var first = wanted[0];
                    AddToBatch(tx, viewer.UserId, MergeOpenBatches(tx, viewer.UserId, BatchKey(key, interest.Only4k), interest.Only4k, seriesItems), key, interest.Only4k, seriesItems, wanted, inSeries.TryGetValue((first.Season, first.Episode), out var items) && items.Count > 0 ? items[0] : seriesItem, now, minutes, edition);
                }
                return true;
            }, false);
            Written(key, written.Done);
        }

        // Sonarr's actual list supplies far-tail numbers without expanding Jellyfin metadata.
        // When no list is cached, synthesize at most 256 numbers per visible file: omitted numbers
        // cannot expose hidden episodes, and delivery rechecks every pending number by membership.
        private HashSet<(int Season, int Episode)> EpisodeNumbers(TitleKey key, bool only4k, IEnumerable<JfEpisode> files)
        {
            var numbers = files.SelectMany(e => new EpisodeRange(e.Episode, e.EpisodeEnd)
                .Numbers(EpisodeRange.MaxSyntheticEpisodes).Select(n => (e.Season, n))).ToHashSet();
            foreach (var instance in _arr.Instances(ArrKind.Sonarr))
            {
                if (only4k && instance.Role != "4k") continue;
                var series = new[] { key.Title }.Concat(_aliases.Of(key)).Select(k => SonarrSeries(instance, k)).FirstOrDefault(s => s != null);
                if (series == null || _arr.PeekEpisodes(instance, series.Id)?.Value is not { } snapshot) continue;
                numbers.UnionWith(snapshot.Episodes.Select(e => (e.SeasonNumber, e.EpisodeNumber)));
            }
            return numbers;
        }

        /// <summary>
        /// The items that played for the viewer (any edition) at the last look of an interest in one edition (see
        /// <see cref="RememberPlaying"/>); null when none was remembered yet (no evidence of an upgrade in place).
        /// </summary>
        private HashSet<Guid>? PlayingBefore(StatusViewer viewer, TitleKey key, string scope)
            => _store.Watch(viewer.UserId, key.ToString(), scope + PlayingSuffix)?.Known is { } known
                ? known.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(x => Guid.TryParseExact(x, "N", out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty).ToHashSet()
                : null;

        /// <summary>Remembers the items that play for the viewer now (any edition), when that changed (see <see cref="PlayingBefore"/>).</summary>
        private void RememberPlaying(StatusViewer viewer, TitleKey key, string scope, IReadOnlyCollection<Guid> playing, long generation)
        {
            var known = string.Join(",", playing.Where(id => id != Guid.Empty).Distinct().Select(id => id.ToString("N", CultureInfo.InvariantCulture)).OrderBy(x => x, StringComparer.Ordinal));
            if (_store.Watch(viewer.UserId, key.ToString(), scope + PlayingSuffix)?.Known == known) return;
            _store.InTransaction(generation, tx => { tx.SetWatch(viewer.UserId, key.ToString(), scope + PlayingSuffix, null, known, _now()); return true; }, false);
        }

        /// <summary>The watch scope suffix of the items that played in any edition (see <see cref="PlayingBefore"/>).</summary>
        private const string PlayingSuffix = "|playing";

        /// <summary>The watch scope suffix of the sources those items had (see <see cref="SourcesBefore"/>).</summary>
        private const string SourcesSuffix = "|sources";

        /// <summary>
        /// The backing sources the playing items had at the last look of an interest in one edition, as Jellyfin holds them for
        /// anyone (see <see cref="RememberSources"/>): each source's identity (its version item and path) with its quality (the
        /// video size, "-" while unread); null when none were remembered yet (no evidence of an upgrade in place).
        /// </summary>
        private Dictionary<string, HashSet<string>>? SourcesBefore(StatusViewer viewer, TitleKey key, string scope)
            => _store.Watch(viewer.UserId, key.ToString(), scope + SourcesSuffix)?.Known is { } known
                ? known.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(x => x.Split(':')).Where(x => x.Length == 2)
                    .GroupBy(x => x[0], StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Select(x => x[1]).ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal)
                : null;

        /// <summary>Remembers the backing sources of the items that play now (library context: whoever may open them), when that changed.</summary>
        private void RememberSources(StatusViewer viewer, TitleKey key, string scope, IEnumerable<JfSource> sources, long generation)
        {
            var known = string.Join(",", sources.Select(s => SourceIdentity(s) + ":" + SourceQuality(s)).Distinct().OrderBy(x => x, StringComparer.Ordinal));
            if (_store.Watch(viewer.UserId, key.ToString(), scope + SourcesSuffix)?.Known == known) return;
            _store.InTransaction(generation, tx => { tx.SetWatch(viewer.UserId, key.ToString(), scope + SourcesSuffix, null, known, _now()); return true; }, false);
        }

        /// <summary>
        /// Whether a qualifying source of an item is new since the last look (D53, edition round 21: arrivals are source changes):
        /// a version or path not held then, or one whose known quality changed (a file replaced in place). A source that was
        /// there and only became visible to the viewer is not new. Nothing remembered: no evidence, no.
        /// </summary>
        private static bool NewSource(IEnumerable<JfSource> qualifying, Dictionary<string, HashSet<string>>? before)
            => before != null && qualifying.Any(s => !before.TryGetValue(SourceIdentity(s), out var qualities)
                || !(qualities.Contains(SourceQuality(s)) || qualities.Contains("-") || SourceQuality(s) == "-"));

        // A source's identity: the item behind the version and its file (never Jellyfin's source id: 10.11 changes it while grouping).
        private static string SourceIdentity(JfSource source)
            => MutationInput.Hash(source.BackingItemId.ToString("N", CultureInfo.InvariantCulture) + "|" + (source.Path ?? string.Empty))[..16];

        // A source's quality as Jellyfin read it ("-" while unread).
        private static string SourceQuality(JfSource source)
            => source.Width > 0 || source.Height > 0 ? (source.Width ?? 0).ToString(CultureInfo.InvariantCulture) + "x" + (source.Height ?? 0).ToString(CultureInfo.InvariantCulture) : "-";

        /// <summary>
        /// The edition an interest is told about: a 4K request's 4K; a standard request's standard (with "Standard requests
        /// need a non-4K copy", a non-4K source); a follow (alone or with a request) hears of whatever plays.
        /// </summary>
        private static Edition EditionOf(Interest interest)
            => interest.Only4k ? Edition.FourK : interest.HasRequest && !interest.HasFollow ? Edition.Standard : Edition.Any;

        /// <summary>The payload name of an edition (a delivery held for quiet hours is judged again by it).</summary>
        internal static string EditionName(Edition edition) => edition switch { Edition.FourK => "4k", Edition.Standard => "standard", _ => "any" };

        /// <summary>
        /// The episodes of a series the viewer has an accessible playable source of <paramref name="edition"/> for, across every
        /// copy they open (each episode by its own sources in its own series item: the folders automatic grouping shows with
        /// it never lend it one), with those copies; one episode item each, dated when its first qualifying source arrived.
        /// </summary>
        private (List<JfCopy> Copies, List<(Guid Series, JfEpisode Episode)> Files) Arrived(TitleKey key, StatusViewer viewer, Edition edition)
        {
            // What a finished lookup found (the callers' watches keep everything as it was when one couldn't finish).
            var copies = _view.Copies(key, viewer, _aliases.Of(key)).Display.Where(c => c.Visible).DistinctBy(c => c.ItemId).ToList();
            var hits = _status.Editions.Episodes(viewer, copies, edition, null).Hits.Where(h => h.ItemId != Guid.Empty);
            var files = hits.GroupBy(h => (h.CopyId, h.ItemId)).Select(g => (g.Key.CopyId, new JfEpisode
            {
                ItemId = g.Key.ItemId,
                Season = g.First().Season!.Value,
                Episode = g.First().Episode!.Value,
                EpisodeEnd = g.First().EpisodeEnd,
                DateCreated = g.Select(h => h.Source.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Min(),
            })).ToList();
            return (copies, files);
        }

        private ArrSeriesEntry? SonarrSeries(ArrConnection instance, TitleKey key)
        {
            if (_arr.PeekLibrary(instance.Id) is not { } library) return null;
            return key.Provider switch
            {
                "tvdb" when key.NumericId is int tv => library.SeriesByTvdb(tv),
                "tmdb" when key.NumericId is int tm => library.SeriesByTmdb(tm),
                "imdb" => library.SeriesByImdb(key.Id),
                _ => null,
            };
        }

        private sealed class BatchEntry
        {
            public int S { get; set; }

            public int E { get; set; }

            public string? I { get; set; }

            /// <summary>When it arrived (Unix ms; 4f round 10). Null only in a batch stored before: <see cref="ReadBatch"/> gives
            /// it that batch's own start.</summary>
            public long? A { get; set; }
        }

        private sealed class BatchState
        {
            public string? Series { get; set; }

            /// <summary>Every visible Jellyfin series item its interests see, in N format.</summary>
            public List<string> Items { get; set; } = new();

            /// <summary>Other title keys whose episodes joined it, without the variant suffix.</summary>
            public List<string> Keys { get; set; } = new();

            public List<BatchEntry> Episodes { get; set; } = new();

            /// <summary>Failed attempts at sending it so far.</summary>
            public int F { get; set; }

            /// <summary>
            /// The edition a batch that isn't 4K was batched under ("standard": a standard request's, judged with "Standard
            /// requests need a non-4K copy"; null or "any": whatever plays). Batches merged into one keep the stricter.
            /// </summary>
            public string? Ed { get; set; }
        }

        // A stored batch, read with its own row's start (4f round 11): a member stored before round 10 has no arrival and takes
        // that start here, before the batch is merged, added to or sent. A merge keeps the earliest start for the merged row, so
        // a member dated after it would take another batch's start (and be dropped as stale too early). The one read of a batch.
        private static BatchState? ReadBatch(string json, DateTimeOffset firstAt)
        {
            var state = Deserialize<BatchState>(json);
            foreach (var x in state?.Episodes ?? new List<BatchEntry>()) x.A ??= firstAt.ToUnixTimeMilliseconds();
            return state;
        }

        // Merge open batches of the same variant that turn out to be one series. Keep the interest's
        // own batch if open, else the earliest; check copies through every joining id when sent.
        private static string MergeOpenBatches(NotifyTransaction tx, Guid user, string own, bool only4k, HashSet<string> seriesItems)
        {
            if (seriesItems.Count == 0) return own;
            var matches = new List<(string Key, BatchState State, DateTimeOffset FirstAt, DateTimeOffset DueAt)>();
            foreach (var (key, _) in tx.Batches(user))
            {
                if (key.EndsWith("|4k", StringComparison.Ordinal) != only4k || tx.Batch(user, key) is not { } batch) continue;
                var state = ReadBatch(batch.Episodes, batch.FirstAt) ?? new BatchState();
                if (key != own && !(state.Items.Count > 0 ? state.Items.Any(seriesItems.Contains) : state.Series is { } series && seriesItems.Contains(series))) continue;
                matches.Add((key, state, batch.FirstAt, batch.DueAt));
            }
            if (matches.Count < 2) return matches.Count == 0 ? own : matches[0].Key;
            var survivor = matches.OrderBy(b => b.Key != own).ThenBy(b => b.FirstAt).ThenBy(b => b.Key, StringComparer.Ordinal).First();
            var title = only4k ? survivor.Key[..^3] : survivor.Key;
            var merged = survivor.State;
            merged.Episodes = merged.Episodes.DistinctBy(e => (e.S, e.E)).ToList();
            merged.Items = merged.Items.Distinct(StringComparer.Ordinal).ToList();
            merged.Keys = merged.Keys.Where(k => k != title).Distinct(StringComparer.Ordinal).ToList();
            var first = survivor.FirstAt;
            var due = survivor.DueAt;
            foreach (var batch in matches)
            {
                if (batch.Key == survivor.Key) continue;
                foreach (var episode in batch.State.Episodes)
                {
                    if (!merged.Episodes.Any(e => e.S == episode.S && e.E == episode.E)) merged.Episodes.Add(episode);
                }
                foreach (var item in batch.State.Items)
                {
                    if (!merged.Items.Contains(item, StringComparer.Ordinal)) merged.Items.Add(item);
                }
                foreach (var key in batch.State.Keys.Append(only4k ? batch.Key[..^3] : batch.Key))
                {
                    if (key != title && !merged.Keys.Contains(key, StringComparer.Ordinal)) merged.Keys.Add(key);
                }
                merged.Series ??= batch.State.Series;
                merged.F = Math.Max(merged.F, batch.State.F);
                if (batch.State.Ed == EditionName(Edition.Standard)) merged.Ed = batch.State.Ed;
                if (batch.FirstAt < first) first = batch.FirstAt;
                if (batch.DueAt < due) due = batch.DueAt;
            }
            tx.SetBatch(user, survivor.Key, JsonSerializer.Serialize(merged, Json), first, due);
            // A stale flush of an absorbed row fails DeleteBatchIf and throws BatchChangedException.
            foreach (var batch in matches)
            {
                if (batch.Key != survivor.Key) tx.DeleteBatch(user, batch.Key);
            }
            return survivor.Key;
        }

        // Keep every series item the interest sees and any joining id needed to check its copies at send time.
        private static void AddToBatch(NotifyTransaction tx, Guid user, string batchKey, TitleKey key, bool only4k, HashSet<string> seriesItems, List<(int Season, int Episode, Guid Id, DateTimeOffset At)> episodes, Guid? seriesItem, DateTimeOffset now, int minutes, Edition edition)
        {
            var existing = tx.Batch(user, batchKey);
            var state = existing is { } b ? ReadBatch(b.Episodes, b.FirstAt) ?? new BatchState() : new BatchState();
            if (edition == Edition.Standard) state.Ed = EditionName(edition);
            foreach (var item in seriesItems)
            {
                if (!state.Items.Contains(item, StringComparer.Ordinal)) state.Items.Add(item);
            }
            if (batchKey != BatchKey(key, only4k) && !state.Keys.Contains(key.ToString(), StringComparer.Ordinal)) state.Keys.Add(key.ToString());
            state.Series ??= seriesItem?.ToString("N", CultureInfo.InvariantCulture);
            foreach (var (s, e, id, at) in episodes)
            {
                if (state.Episodes.Any(x => x.S == s && x.E == e)) continue;
                state.Episodes.Add(new BatchEntry { S = s, E = e, I = id.ToString("N", CultureInfo.InvariantCulture), A = at.ToUnixTimeMilliseconds() });
            }
            var first = existing?.FirstAt ?? now;
            // The window runs from the first episode, so a slow trickle can't hold the message back for ever.
            tx.SetBatch(user, batchKey, JsonSerializer.Serialize(state, Json), first, existing?.DueAt ?? now + TimeSpan.FromMinutes(minutes));
        }

        /// <summary>
        /// Sends every batch whose window has closed (tests call it). What a batch names is checked
        /// again for the viewer first (access or parental limits may have changed during the window);
        /// the batch goes away in the same transaction that creates its notification (only the version
        /// that was read: episodes merged into it meanwhile roll the notification back, and the next
        /// round sends the merged batch), and a batch that fails is tried again a minute later, at
        /// most <see cref="MaxBatchTries"/> times (then it is dropped, so it can't hold up the others
        /// for ever). Nothing read before a restore of the database is written into the restored one.
        /// </summary>
        internal int FlushBatches(DateTimeOffset now, CancellationToken cancellationToken = default)
        {
            var sent = 0;
            var generation = _store.Generation;
            foreach (var (user, key, json, firstAt) in _store.DueBatches(now))
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    if (FlushBatch(user, key, json, firstAt, now, generation)) sent++;
                }
                catch (BatchChangedException)
                {
                    // Merged into (or restored) since it was read: the next round sees the new version.
                }
                catch (Exception ex)
                {
                    try
                    {
                        var dropped = _store.InTransaction(generation, tx =>
                        {
                            if (tx.Batch(user, key) is not { } b) return false;
                            var state = ReadBatch(b.Episodes, b.FirstAt);
                            if (state == null || state.F + 1 >= MaxBatchTries)
                            {
                                tx.DeleteBatch(user, key);
                                return true;
                            }
                            state.F++;
                            tx.SetBatch(user, key, JsonSerializer.Serialize(state, Json), b.FirstAt, now + TimeSpan.FromMinutes(1));
                            return false;
                        }, false).Result;
                        if (dropped) _logger?.Warning($"Notifications: an episode batch could not be sent after {MaxBatchTries} tries and was dropped ({ex.GetType().Name}: {ex.Message}).");
                        else _logger?.Warning($"Notifications: could not send an episode batch ({ex.GetType().Name}: {ex.Message}); trying again in a minute.");
                    }
                    catch (Exception)
                    {
                        // The next round sees it again.
                    }
                }
            }
            return sent;
        }

        // A due batch changed (or the database was restored) between reading it and replacing it with its notification.
        private sealed class BatchChangedException : Exception
        {
        }

        // Forgets the batch that was read (not a version merged into since); throws when it changed.
        private void DropBatch(Guid user, string key, string json, long generation)
        {
            if (!_store.InTransaction(generation, tx => tx.DeleteBatchIf(user, key, json), false).Result) throw new BatchChangedException();
        }

        // A due batch whose recipient's Hidden Content can't be read now: looked at again shortly, dropped (never told) once it
        // has waited too long. Throws when it changed since it was read.
        private void WaitBatch(Guid user, string key, string json, DateTimeOffset now, long generation)
        {
            var dropped = _store.InTransaction(generation, tx =>
            {
                if (tx.Batch(user, key) is not { } b || b.Episodes != json) throw new BatchChangedException();
                if (now - b.FirstAt > NotifyDispatcher.WaitAtMost)
                {
                    tx.DeleteBatch(user, key);
                    return true;
                }
                tx.SetBatch(user, key, json, b.FirstAt, now + NotifyDispatcher.WaitFor);
                return false;
            }, false).Result;
            if (dropped) _logger?.Warning("Notifications: an episode batch was dropped: the recipient's Hidden Content couldn't be read for a day.");
        }

        private bool FlushBatch(Guid user, string key, string json, DateTimeOffset firstAt, DateTimeOffset now, long generation)
        {
            var only4k = key.EndsWith("|4k", StringComparison.Ordinal);
            var title = TitleKey.Parse(only4k ? key[..^3] : key);
            var state = ReadBatch(json, firstAt);
            if (title == null || state == null)
            {
                // Not a batch that can be told (unreadable): forgotten.
                DropBatch(user, key, json, generation);
                return false;
            }
            // What the batch says, for the person as Jellyfin shows things to them now: only what they can still open (a library
            // or parental limit may have changed), each number linked to an episode item they can open now (the one stored when
            // it was batched while it is still visible, else the copy that still is) and, where their Hidden Content can be read,
            // one they haven't hidden. Whether anything of it may be told is the final gate's.
            var viewer = _view.Viewer(user);
            using var bound = CopyLookupBound.Track();
            // The batch's episodes are judged again by the edition they were batched under (D53, edition round 19 part B: the
            // one availability predicate at delivery): an episode whose qualifying source went (replaced by another edition's
            // file, turned into a stub, no longer theirs to open) is left out, and the rest is told as it is now.
            var edition = only4k ? Edition.FourK : state.Ed == EditionName(Edition.Standard) ? Edition.Standard : Edition.Any;
            var (copies, found) = viewer == null ? (new List<JfCopy>(), new List<(Guid Series, JfEpisode Episode)>()) : Arrived(title, viewer, edition);
            foreach (var joined in state.Keys)
            {
                if (viewer == null || TitleKey.Parse(joined) is not { } k) continue;
                var (more, theirs) = Arrived(k, viewer, edition);
                copies.AddRange(more);
                found.AddRange(theirs);
            }
            // A copy lookup that reached its scan bound: the batch is kept for the next round, never dropped as gone.
            if (bound.Reached) return false;
            copies = copies.DistinctBy(c => c.ItemId).ToList();
            var open = new Dictionary<(int, int), HashSet<Guid>>();
            var files = found.Select(f => f.Episode).DistinctBy(e => e.ItemId).ToList();
            var coverage = new EpisodeCoverage(files);
            // A pending batch already supplies every number we need. Check full membership rather
            // than expanding a combined file (even when its metadata claims billions of episodes).
            foreach (var number in state.Episodes.Select(e => (Season: e.S, Episode: e.E)).Distinct())
            {
                foreach (var e in files)
                {
                    if (e.Season != number.Season || !new EpisodeRange(e.Episode, e.EpisodeEnd).Contains(number.Episode)) continue;
                    if (!open.TryGetValue(number, out var ids)) open[number] = ids = new HashSet<Guid>();
                    ids.Add(e.ItemId);
                }
            }
            // A number whose every open copy is hidden (the episode itself, its series or the title on any of its copies) isn't
            // announced; with nothing left the gate refuses the batch (no bell row, toast or delivery).
            var hidden = viewer == null ? null : _dispatcher.Check(user, viewer).Hides(title.ToString());
            foreach (var x in state.Episodes)
            {
                if (hidden == null || !open.TryGetValue((x.S, x.E), out var visible)) continue;
                visible.RemoveWhere(id => hidden(id));
                if (visible.Count == 0) open.Remove((x.S, x.E));
            }
            var episodes = state.Episodes.Where(x => open.ContainsKey((x.S, x.E))).OrderBy(x => x.S).ThenBy(x => x.E).ToList();
            foreach (var x in episodes)
            {
                var visible = open[(x.S, x.E)];
                if (!Guid.TryParse(x.I, out var stored) || !visible.Contains(stored)) x.I = visible.First().ToString("N", CultureInfo.InvariantCulture);
            }
            Guid? seriesItem = Guid.TryParse(state.Series, out var sid) && copies.Any(c => c.ItemId == sid) ? sid : copies.FirstOrDefault()?.ItemId;
            var p = TitleParams(title, seriesItem);
            string? itemId = seriesItem?.ToString("N", CultureInfo.InvariantCulture);
            var seasons = episodes.Select(x => x.S).Distinct().OrderBy(s => s).ToList();
            p["count"] = episodes.Count.ToString(CultureInfo.InvariantCulture);
            p["seasons"] = string.Join(", ", seasons);
            // Each episode with its own arrival (4f round 10; one stored before, its batch's start as read with it): the gate
            // holds each to the catch-up limit, and drops only those past it.
            static DateTimeOffset ArrivalOf(BatchEntry x) => DateTimeOffset.FromUnixTimeMilliseconds(x.A!.Value);
            p["episodeItems"] = JsonSerializer.Serialize(episodes.Select(x => new NotifyEpisode(Guid.Parse(x.I!), x.S, x.E) { At = ArrivalOf(x) }));
            // The batch's origin: its newest episode's arrival (it is too old to tell only when every episode is).
            var since = episodes.Count > 0 ? episodes.Max(ArrivalOf) : firstAt;
            if (only4k) p["variant"] = "4k";
            p["edition"] = EditionName(edition);
            if (episodes.Count == 1)
            {
                p["mode"] = "single";
                p["season"] = episodes[0].S.ToString(CultureInfo.InvariantCulture);
                p["episode"] = episodes[0].E.ToString(CultureInfo.InvariantCulture);
                itemId = episodes[0].I ?? itemId;
            }
            else if (seasons.Count == 1 && seriesItem is Guid series && viewer != null && WholeSeason(title, only4k, coverage, seasons[0], episodes.Count))
            {
                // A whole season arriving together (a season pack) collapses to one line.
                p["mode"] = "season";
                p["season"] = seasons[0].ToString(CultureInfo.InvariantCulture);
                itemId = _view.SeriesFolder(series, viewer).Seasons.FirstOrDefault(x => !x.Hidden && x.Season == seasons[0] && x.ItemId != Guid.Empty)?.ItemId.ToString("N", CultureInfo.InvariantCulture) ?? itemId;
            }
            else
            {
                p["mode"] = "many";
            }
            // One event per interest, like Ready: the same episodes told again after the series was
            // asked for again (its state forgotten, a new watch baseline) are a new event.
            string? eventKey = null;
            if (episodes.Count > 0)
            {
                var first = episodes[0];
                var baseline = _store.Watch(user, title.ToString(), only4k ? "eps4k" : "eps")?.Baseline.ToUnixTimeMilliseconds() ?? 0;
                eventKey = (only4k ? "eps4k|" : "eps|") + title + "|s" + first.S.ToString(CultureInfo.InvariantCulture) + "e" + first.E.ToString(CultureInfo.InvariantCulture) + "|" + episodes.Count.ToString(CultureInfo.InvariantCulture) + "|" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join(".", episodes.Select(x => x.S.ToString(CultureInfo.InvariantCulture) + "x" + x.E.ToString(CultureInfo.InvariantCulture))))), 0, 6) + "|" + baseline.ToString(CultureInfo.InvariantCulture);
            }
            // The final gate on what is about to be told (the same decision every channel makes right before its send): the
            // kind switched off, the person gone, nothing left they can open or haven't hidden: dropped; Hidden Content that
            // can't be read now: kept for a later round (bounded); notifications switched off meanwhile: left as it is.
            var final = _dispatcher.Final(Alert(user, NotifyKind.Episodes, eventKey, title.ToString(), itemId, p, since));
            switch (final.Effect)
            {
                case NotifyEffect.Leave:
                    return false;
                case NotifyEffect.Postpone:
                    WaitBatch(user, key, json, final.At, generation);
                    return false;
                case NotifyEffect.Suppress:
                    DropBatch(user, key, json, generation);
                    return false;
                case NotifyEffect.Act:
                    if (Notify(final, tx => tx.DeleteBatchIf(user, key, json) ? true : throw new BatchChangedException(), generation)) return true;
                    if (_store.Generation != generation) throw new BatchChangedException();
                    return false;
            }

            return false;
        }

        // True when the batch is the whole season: Sonarr knows how many episodes the season has (the
        // copy of the variant asked for), every one of them is here for the viewer and every one is in
        // the batch. A season whose length isn't known never reads as complete (a two-episode premiere
        // is not "Season 3 is ready").
        private bool WholeSeason(TitleKey title, bool only4k, EpisodeCoverage open, int season, int count)
        {
            if (count < 2) return false;
            var instances = _arr.Instances(ArrKind.Sonarr).Where(i => only4k ? i.Role == "4k" : i.Role != "4k").ToList();
            foreach (var instance in instances)
            {
                if (SonarrSeries(instance, title)?.Seasons.FirstOrDefault(x => x.SeasonNumber == season) is not { TotalEpisodeCount: > 0 } stats) continue;
                var have = open.CountInSeason(season);
                return stats.TotalEpisodeCount == count && have == count;
            }
            return false;
        }

        // ================================================================== Seerr requests

        /// <summary>
        /// Compares Seerr's requests with what was seen before: a request declined since tells its
        /// requester; a new request waiting for an OK tells the administrators. The very first scan
        /// only records (old requests are not announced); requests created while notifications were
        /// off count as new. Titles whose requests changed are looked at (a new request starts a
        /// first look), and a requester whose last request for a title went away starts afresh.
        /// What was seen belongs to one Seerr server (<see cref="SeerrFacts.Source"/>):
        /// when Jellyfin Enhanced is pointed at another one (whose request ids are other requests),
        /// the next scan of its list records it afresh like a first scan, telling nobody anything.
        /// </summary>
        /// <param name="now">The time.</param>
        /// <param name="prepared">
        /// The requests whose visibility evidence was prepared this round (<see cref="PrepareAskVisibilityAsync"/>; null: all,
        /// no policy). A decline or an ask that would be told and isn't among them is left unseen (not decided, not consumed)
        /// and the list is compared again next round, when it is prepared.
        /// </param>
        /// <returns>False when there was no list to compare (Seerr off, not read yet), or some of it waits for its evidence.</returns>
        internal bool ScanRequests(DateTimeOffset now, IReadOnlySet<int>? prepared = null)
        {
            if (!_requests.Active || !_requests.Loaded) return false;
            var (source, all, floor) = _requests.Current;
            if (source == null) return false;
            var baselineText = _store.Meta("seerr_baseline");
            var seenSource = _store.Meta(NotifyStore.SeerrSourceKey);
            var changed = new List<(int, int)>();
            var titles = new HashSet<string>(StringComparer.Ordinal);
            if (baselineText == null || (seenSource != null && seenSource != source))
            {
                if (baselineText != null) _logger?.Info("Notifications: Seerr was replaced by another server; its requests are recorded without telling anyone.");
                foreach (var r in all) changed.Add((r.Id, r.Status));
                _store.ResetSeerrSeen(changed, now, source);
                RebuildInterest();
                foreach (var r in all.Where(r => r.RequestedBy.HasValue && r.Key != null)) titles.Add(r.Key!.Title.ToString());
                MarkDirty(titles);
                return true;
            }
            // Seen before this server was noted (an upgrade): the states seen are this server's.
            if (seenSource == null) _store.SetMeta(NotifyStore.SeerrSourceKey, source);
            var seen = _store.SeerrSeen();
            // Below this, what was seen was forgotten (it fell below the requests read): not known is old, not new.
            var forgotten = int.TryParse(_store.Meta(NotifyStore.SeerrForgottenBelowKey), NumberStyles.None, CultureInfo.InvariantCulture, out var fb) ? fb : 0;
            // Event keys carry the server too: a request id another server used before is another event.
            var server = source.Length > 8 ? source[..8] : source;
            var baseline = DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(baselineText, CultureInfo.InvariantCulture)).UtcDateTime;
            var admins = (IReadOnlyList<Guid>?)null;
            var deferred = false;
            foreach (var r in all)
            {
                var known = seen.TryGetValue(r.Id, out var previous);
                if (known && previous == r.Status) continue;
                var old = !known && r.Id < forgotten;
                var fresh = !known && !old && r.CreatedAt is DateTime created && created >= baseline;
                // Evidence not prepared this round (beyond the round's bound, or listed after it was prepared): this change
                // waits, unseen, for the next round's preparation; never decided (or refused) on missing rating facts.
                var tells = (r.Status == SeerrRequestStatus.Declined && r.RequestedBy.HasValue && r.Key != null && (known || fresh))
                            || (r.Status == SeerrRequestStatus.Pending && fresh && r.Key != null);
                if (tells && prepared != null && !prepared.Contains(r.Id))
                {
                    deferred = true;
                    continue;
                }
                changed.Add((r.Id, r.Status));
                if (r.Key != null) titles.Add(r.Key.Title.ToString());
                if (!known && !old && r.Active && r.RequestedBy is Guid asker && r.Key != null
                    && !all.Any(o => o.Id != r.Id && o.Active && o.RequestedBy == asker && o.Key != null && seen.ContainsKey(o.Id) && Canonical(o.Key.Title).Equals(Canonical(r.Key.Title))))
                {
                    // A new request from someone with no other request for the title (asked again after
                    // it was removed): what they were told under the old one doesn't stop telling them
                    // this time. An upgrade flapping under the same request is still told once.
                    ForgetTitle(asker, r.Key.Title);
                }
                if (r.Status == SeerrRequestStatus.Declined && r.RequestedBy is Guid requester && (known || fresh) && r.Key != null)
                {
                    var p = TitleParams(r.Key.Title, null, r);
                    p["contact"] = Contact();
                    // Every dimension the outcome policy reads travels with the alert (4f round 7): the edition (a 4K request
                    // lands in the 4K instance's libraries) and the seasons, through the wait queue to every send and bell read.
                    OutcomeParams(p, r);
                    // The final gate (the requester, their switch, the one outcome policy, as for JE's own notices); evidence that
                    // can't be read now: the decline goes to the wait queue (tried again on its own schedule, not on Seerr's next
                    // change), and the change is seen. Notifications switched off meanwhile: nothing of this list is seen yet.
                    var id = r.Id.ToString(CultureInfo.InvariantCulture);
                    var eventKey = "declined|" + server + "|" + id;
                    // Its origin: when Seerr shows it was declined (4f round 10), held to the catch-up limit like JE's own.
                    var declinedAt = r.UpdatedAt is DateTime updated ? new DateTimeOffset(DateTime.SpecifyKind(updated, DateTimeKind.Utc)) : now;
                    var final = _dispatcher.Final(Alert(requester, NotifyKind.Declined, eventKey, r.Key.Title.ToString(), null, p, declinedAt));
                    switch (final.Effect)
                    {
                        case NotifyEffect.Leave:
                            return false;
                        case NotifyEffect.Postpone:
                            {
                                var wait = new AlertWait("seerr", server + "|" + id, requester, NotifyKind.Declined, r.Key.Title.ToString(), eventKey, JsonSerializer.Serialize(p), id, declinedAt, final.Until!.Value, 0);
                                _store.InTransaction(tx => tx.AddAlertWait(wait));
                                break;
                            }

                        case NotifyEffect.Suppress:
                            // Ended: the change is seen with the rest of the list.
                            break;
                        case NotifyEffect.Act:
                            Notify(final, null);
                            break;
                    }
                }
                if (r.Status == SeerrRequestStatus.Pending && fresh)
                {
                    admins ??= _users.Admins();
                    foreach (var admin in admins)
                    {
                        if (admin == r.RequestedBy) continue;
                        var p = r.Key != null ? TitleParams(r.Key.Title, null, r) : new Dictionary<string, string>();
                        p["user"] = r.RequestedByName ?? (r.RequestedBy is Guid u ? _users.Name(u) : null) ?? string.Empty;
                        OutcomeParams(p, r);
                        // The final gate: an administrator who can see the title (not one with a parental limit or without its
                        // library), still one and active, while the request still waits for an OK.
                        // Its origin: when the request was made in Seerr (4f round 10).
                        var askedAt = r.CreatedAt is DateTime made ? new DateTimeOffset(DateTime.SpecifyKind(made, DateTimeKind.Utc)) : now;
                        var askKey = "approval|" + server + "|" + r.Id.ToString(CultureInfo.InvariantCulture);
                        var final = _dispatcher.Final(Alert(admin, NotifyKind.Approval, askKey, r.Key?.Title.ToString(), null, p, askedAt));
                        switch (final.Effect)
                        {
                            case NotifyEffect.Leave:
                                return false;
                            case NotifyEffect.Postpone:
                                {
                                    // Seerr's list can't be read now: the ask waits in the wait queue (its own retries, at most a day,
                                    // expiring from the ask's own time), as a Seerr decline does; the change is seen.
                                    var wait = new AlertWait("seerr-ask", server + "|" + r.Id.ToString(CultureInfo.InvariantCulture) + "|" + NotifyValues.Id(admin), admin, NotifyKind.Approval,
                                        r.Key?.Title.ToString() ?? string.Empty, askKey, JsonSerializer.Serialize(p), r.Id.ToString(CultureInfo.InvariantCulture), askedAt, final.Until!.Value, 0);
                                    _store.InTransaction(tx => tx.AddAlertWait(wait));
                                    break;
                                }

                            case NotifyEffect.Suppress:
                                // Not for this administrator: the change is seen with the rest of the list.
                                break;
                            case NotifyEffect.Act:
                                Notify(final, null);
                                break;
                        }
                    }
                }
            }
            var ids = new HashSet<int>(all.Select(r => r.Id));
            // Below the list's floor (Seerr holds more than is read) a request not held is unknown,
            // not gone: what was seen of it stays.
            var gone = seen.Keys.Where(id => !ids.Contains(id) && !(floor is int f && id < f)).ToList();
            // ... and it can't be compared again while that lasts: what was seen below the floor is
            // forgotten (the table stays as large as the list held, not as Seerr's lifetime).
            var forget = floor is int below && seen.Keys.Any(id => id < below) ? floor : null;
            if (changed.Count > 0 || gone.Count > 0 || forget != null) _store.SetSeerrSeen(changed, gone, now, forget);
            if (gone.Count > 0 || changed.Count > 0)
            {
                RebuildInterest();
                ForgetEndedInterests();
            }
            MarkDirty(titles);
            return !deferred;
        }

        // A requester with no active request left for a title they don't follow starts afresh next time.
        private void ForgetEndedInterests()
        {
            var active = new HashSet<(Guid, string)>(_requests.All.Where(r => r.Active && r.RequestedBy.HasValue && r.Key != null).Select(r => (r.RequestedBy!.Value, Canonical(r.Key!.Title).ToString())));
            var followed = new HashSet<(Guid, string)>(_store.AllFollows().Where(f => !f.Muted).Select(f => (f.UserId, TitleKey.Parse(f.Key) is { } key ? Canonical(key.Title).ToString() : f.Key)));
            foreach (var r in _requests.All.Where(r => !r.Active && r.RequestedBy.HasValue && r.Key != null))
            {
                var pair = (r.RequestedBy!.Value, Canonical(r.Key!.Title).ToString());
                if (active.Contains(pair) || followed.Contains(pair)) continue;
                ForgetTitle(pair.Item1, r.Key!.Title);
            }
        }

        /// <summary>
        /// Forgets what a user was told about a title (its watch state and Ready / episode marks under
        /// every id it is known by, and the Ready marks of its Jellyfin items), so their next interest
        /// in it starts afresh and is told again when it becomes ready.
        /// </summary>
        private void ForgetTitle(Guid user, TitleKey title, long? generation = null)
        {
            var canonical = Canonical(title.Title);
            var keys = new[] { title.Title.ToString(), canonical.ToString() }.Concat(Aliases(canonical)).Distinct(StringComparer.Ordinal).ToList();
            var items = new List<Guid>();
            if (_view.Viewer(user) is { } viewer)
            {
                foreach (var k in keys)
                {
                    // Every copy the lookup saw (finished or not): forgetting the marks of more items only tells them again.
                    if (TitleKey.Parse(k) is { } parsed) items.AddRange(_view.Copies(parsed, viewer, _aliases.Of(parsed)).Seen.Select(c => c.ItemId).Where(id => id != Guid.Empty));
                }
            }
            // Read before a restore (generation given): not written into the restored data.
            _store.InTransaction(generation, tx => { tx.ForgetTitle(user, keys, items); return true; }, false);
        }

        private void MarkDirty(IEnumerable<string> titles)
        {
            using var __factsOperation2 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var now = _now();
            lock (_dirtyGate)
            {
                var any = false;
                foreach (var t in titles)
                {
                    _dirtyFacts[t] = 0;
                    any = true;
                }
                if (!any) return;
                _firstDirty ??= now;
                _lastDirty = now;
            }
        }

        /// <summary>
        /// The changed titles due for a look (after a short quiet spell, or at most a few seconds;
        /// at once with <paramref name="force"/>), taken off the dirty set; null when none are due.
        /// Taking them and clearing the timers is one step with marking (<see cref="MarkDirty"/>),
        /// so a title marked meanwhile is never left without its timer.
        /// </summary>
        private List<string>? TakeDue(DateTimeOffset now, bool force)
        {
            using var __factsOperation3 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            lock (_dirtyGate)
            {
                if (!_firstDirty.HasValue || !(force || now - _lastDirty >= QuietDebounce || now - _firstDirty >= MaxDebounce)) return null;
                var keys = _dirtyFacts.Keys.Take(MaxPerRound).ToList();
                foreach (var k in keys) _dirtyFacts.TryRemove(k, out _);
                if (_dirtyFacts.IsEmpty)
                {
                    AfterTake?.Invoke();
                    _firstDirty = null;
                    _lastDirty = null;
                }
                return keys;
            }
        }

        /// <summary>Test seam: runs when the taken titles emptied the dirty set, before its timers are cleared.</summary>
        internal Action? AfterTake { get; set; }

        /// <summary>True when changed titles wait for a look and their timer runs (tests).</summary>
        internal bool HasDirty(string title)
        {
            using var __factsOperation4 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            lock (_dirtyGate) return _dirtyFacts.ContainsKey(title) && _firstDirty.HasValue;
        }

        // ================================================================== follows (routes)

        /// <summary>
        /// Follows a title (movie, series or season key), or mutes / unfollows it. A new follow takes
        /// its first look at once, so only what arrives from now on is announced. Returns false when
        /// the user may not follow it or holds too many follows.
        /// </summary>
        public Task<string> SetFollowAsync(StatusViewer viewer, TitleKey key, bool on, CancellationToken cancellationToken)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => SetFollowAsyncFactsCore(viewer, key, on, token), cancellationToken);

        private async Task<string> SetFollowAsyncFactsCore(StatusViewer viewer, TitleKey key, bool on, CancellationToken cancellationToken)
        {
            if (!Enabled) return "disabled";
            if (key.Episode.HasValue) return "invalid_key";
            if (on && !_status.MayFollow(viewer, key)) return "not_allowed";
            var now = _now();
            var kind = key.IsMovie ? "title" : key.Season.HasValue ? "season" : "episodes";
            var asked = RequestsFor(key).Any(r => r.RequestedBy == viewer.UserId) || AskedInLedger(viewer.UserId, key);
            bool ok;
            if (on) ok = _store.SetFollow(viewer.UserId, key.ToString(), kind, muted: false, remove: false, now);
            else if (asked && !key.Season.HasValue) ok = _store.SetFollow(viewer.UserId, key.ToString(), kind, muted: true, remove: false, now);
            else ok = _store.SetFollow(viewer.UserId, key.ToString(), kind, muted: false, remove: true, now);
            if (!ok) return "too_many";
            RebuildInterest();
            if (on)
            {
                await EvaluateAsync(new[] { key.Title.ToString() }, viewer.UserId, cancellationToken).ConfigureAwait(false);
            }
            else if (InterestsIn(Canonical(key.Title), viewer.UserId).Count == 0)
            {
                ForgetTitle(viewer.UserId, key.Title);
            }
            return "ok";
        }

        /// <summary>
        /// What a user follows: explicit follows, mutes, and the titles followed because they asked
        /// for them (when "follow what I request" is on).
        /// </summary>
        public (IReadOnlyList<FollowRow> Follows, IReadOnlyList<string> Requested) FollowsOf(Guid userId)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Compose(() => FollowsOfFactsCore(userId));

        private (IReadOnlyList<FollowRow> Follows, IReadOnlyList<string> Requested) FollowsOfFactsCore(Guid userId)
        {
            var prefs = _store.Prefs(userId);
            var requested = prefs.AutoFollowRequests
                ? _requests.ForUser(userId).Where(r => r.Active && r.Key != null).Select(r => r.Key!.Title.ToString()).Distinct(StringComparer.Ordinal).ToList()
                : new List<string>();
            if (prefs.AutoFollowRequests && LedgerInterest)
            {
                // Jellyfin Enhanced mode: the request ledger's requests are followed the same way.
                requested.AddRange(_ledger!.List(userId, false).Where(w => w.Status is not ("cancelled" or "declined"))
                    .Select(w => TitleKey.Parse(w.Input.Key)?.Title.ToString()).OfType<string>());
                requested = requested.Distinct(StringComparer.Ordinal).ToList();
            }
            return (_store.Follows(userId), requested);
        }

        // In Jellyfin Enhanced mode: the user has a request in the ledger for the title (under any of its keys) that
        // still stands, so turning "Notify me" off mutes it (as for a Seerr request) instead of being undone by it.
        private bool AskedInLedger(Guid user, TitleKey key)
            => LedgerInterest && new[] { key.Title.ToString() }.Concat(Aliases(key)).Distinct(StringComparer.Ordinal)
                .SelectMany(_ledger!.ForTitle).Any(w => w.UserId == user && w.Status is not ("cancelled" or "declined"));

        // ================================================================== remind

        /// <summary>
        /// "Remind {contact}" on a title that is taking longer than usual: the administrators get it
        /// as an admin event, at most once per user and title every 24 hours. Only for titles the user
        /// can see that really need attention right now; administrators don't remind themselves.
        /// </summary>
        public Task<RemindOutcome> RemindAsync(StatusViewer viewer, TitleKey key, Guid? itemId, CancellationToken cancellationToken)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => RemindAsyncFactsCore(viewer, key, itemId, token), cancellationToken);

        private async Task<RemindOutcome> RemindAsyncFactsCore(StatusViewer viewer, TitleKey key, Guid? itemId, CancellationToken cancellationToken)
        {
            if (!Enabled) return new RemindOutcome("disabled");
            if (viewer.IsAdmin) return new RemindOutcome("admin");
            // The reminder's origin: when it was asked for (4f round 10), before anything is awaited.
            var pressed = _now();
            var status = await _status.CurrentAsync(viewer, itemId, itemId.HasValue ? null : key, cancellationToken).ConfigureAwait(false);
            if (status == null) return new RemindOutcome("not_found");
            if (!status.Attention) return new RemindOutcome("not_stuck");
            var statusKey = TitleKey.Parse(status.Key) ?? key;
            // Once per user and title (the movie or series, whichever episode or season page it came
            // from, under whichever id), claimed in the same transaction that tells the administrators.
            var title = Canonical(statusKey.Title);
            var mark = "remind|" + title;
            var now = _now();
            var p = TitleParams(statusKey.Title, itemId);
            p["user"] = _users.Name(viewer.UserId) ?? string.Empty;
            p["reason"] = status.Reason.Code;
            if (statusKey.Season is int s) p["season"] = s.ToString(CultureInfo.InvariantCulture);
            if (statusKey.Episode is int e) p["episode"] = e.ToString(CultureInfo.InvariantCulture);
            var eventKey = "remind|" + NotifyValues.Id(viewer.UserId) + "|" + title + "|" + now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);
            // Only the administrators who can see the title (as their Requests page shows its card), as for an ask
            // waiting for an OK: one with a parental limit or without its library is told nothing. Prepare, then decide (4f
            // rounds 8 and 9): every administrator's view is prepared (awaited) first; then the final gate for each
            // administrator as they are now (still one, active, what they may see). Notifications switched off meanwhile:
            // nothing is told and the reminder isn't spent.
            var input = AskInput(statusKey.Title, statusKey.Season is int season ? new[] { season } : Array.Empty<int>(), false);
            if (_policy != null)
            {
                foreach (var admin in _users.Admins())
                {
                    await _policy.PrepareVisibilityAsync(admin, input, cancellationToken).ConfigureAwait(false);
                }
            }
            var finals = new List<NotifyFinal>();
            foreach (var admin in _users.Admins())
            {
                var final = _dispatcher.Final(Alert(admin, NotifyKind.Remind, eventKey, statusKey.ToString(), itemId?.ToString("N", CultureInfo.InvariantCulture), p, pressed));
                switch (final.Effect)
                {
                    case NotifyEffect.Leave:
                    case NotifyEffect.Postpone:
                        // Nothing told and the reminder isn't spent: it can be asked for again.
                        return new RemindOutcome("disabled");
                    case NotifyEffect.Suppress:
                        // Not for this administrator: the reminder is spent with the others' rows.
                        break;
                    case NotifyEffect.Act:
                        finals.Add(final);
                        break;
                }
            }
            var created = _store.InTransaction(tx =>
            {
                if (!tx.ClaimMark(viewer.UserId, mark, now, RemindEvery)) return null;
                return finals.Where(f => Add(tx, f) != null).ToList();
            });
            if (created == null)
            {
                var last = _store.MarkAt(viewer.UserId, mark) ?? now;
                return new RemindOutcome("too_soon", last + RemindEvery);
            }
            foreach (var f in created) Announce(f);
            return new RemindOutcome("ok", now + RemindEvery);
        }

        // ================================================================== admin events

        /// <summary>Needs attention codes that alert administrators at once (once per row): the spec's "manual import needed" and the Seerr handoff.</summary>
        internal static readonly IReadOnlySet<string> AlertCodes = new HashSet<string>(StringComparer.Ordinal) { AttentionCode.ImportBlocked, AttentionCode.ApprovedNotInArr };

        /// <summary>Needs attention codes about a download in the queue (or one that failed): what the stuck digest lists.</summary>
        internal static readonly IReadOnlySet<string> DownloadCodes = new HashSet<string>(StringComparer.Ordinal)
        {
            AttentionCode.ImportBlocked, AttentionCode.ImportWaiting, AttentionCode.DownloadFailed,
            AttentionCode.DownloadWarning, AttentionCode.DownloadStalled, AttentionCode.ClientUnavailable,
        };

        /// <summary>
        /// Instance outages, low disk, manual imports needed, requests OK'd in Seerr that no
        /// Sonarr/Radarr has, and the daily stuck digest (tests call it). Everything comes from the
        /// admin tools' Needs attention list (the Overview's rows, same thresholds), so an alert and
        /// the list never disagree; without the admin tools nothing is checked. A manual import or an
        /// OK'd request is told once per occurrence, and only when it started after the first check
        /// (rows already listed when the alerts were switched on stay on the Overview only).
        /// </summary>
        internal Task AdminChecksAsync(CancellationToken cancellationToken)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => AdminChecksAsyncFactsCore(token), cancellationToken);

        private async Task AdminChecksAsyncFactsCore(CancellationToken cancellationToken)
        {
            if (_hub == null) return;
            var attention = await _hub.NeedsAttentionAsync(cancellationToken, background: true).ConfigureAwait(false);
            // Decided after that await (4f round 8): the settings, the clock and the administrators as they are now.
            if (!Enabled) return;
            var config = _config();
            var now = _now();
            var downAfter = TimeSpan.FromMinutes(Math.Clamp(config?.ArrNotifyAdminDownMinutes ?? 10, 1, 1440));
            IReadOnlyList<Guid>? admins = null;
            IReadOnlyList<Guid> Admins() => admins ??= _users.Admins();
            var instances = _arr.Instances(ArrKind.Radarr).Concat(_arr.Instances(ArrKind.Sonarr)).ToList();
            foreach (var instance in instances)
            {
                var downKey = "down:" + instance.Id;
                var since = _store.Meta(downKey);
                if (attention.Any(a => a.Code == AttentionCode.InstanceDown && a.InstanceId == instance.Id))
                {
                    if (since == null)
                    {
                        _store.SetMeta(downKey, now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        var start = DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(since, CultureInfo.InvariantCulture));
                        if (now - start >= downAfter && _store.Meta("down-told:" + instance.Id) == null)
                        {
                            // The "told" marker and every administrator's alert commit together: a stop
                            // (or a failure) before the alerts exist leaves the outage to tell next round.
                            var p = new Dictionary<string, string> { ["instance"] = instance.Name, ["minutes"] = ((int)(now - start).TotalMinutes).ToString(CultureInfo.InvariantCulture) };
                            var told = TellAdmins(Admins(), NotifyKind.InstanceDown, "down|" + instance.Id + "|" + since, null, p, now, tx =>
                            {
                                if (tx.Meta("down-told:" + instance.Id) != null) return false;
                                tx.SetMeta("down-told:" + instance.Id, since);
                                return true;
                            });
                            if (!told) return;
                        }
                    }
                    continue;
                }
                if (since != null)
                {
                    // Clearing the outage and telling it ended commit together.
                    var told = _store.Meta("down-told:" + instance.Id);
                    var p = new Dictionary<string, string> { ["instance"] = instance.Name };
                    var cleared = TellAdmins(told == null ? Array.Empty<Guid>() : Admins(), NotifyKind.InstanceUp, "up|" + instance.Id + "|" + told, null, p, now, tx =>
                    {
                        if (tx.Meta("down-told:" + instance.Id) != told) return false;
                        tx.SetMeta(downKey, null);
                        tx.SetMeta("down-told:" + instance.Id, null);
                        return true;
                    });
                    if (!cleared) return;
                }
            }

            var day = now.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            // Only what started after the first check (kept in the database): switching the alerts on,
            // or upgrading, never sends one alert for every old row the list already holds.
            var baseline = AttentionBaseline(now);
            foreach (var item in attention)
            {
                if (item.Code == AttentionCode.LowDisk)
                {
                    // Once a day per root folder, at the admin tools' threshold.
                    if (item.InstanceId == null || item.Title == null || item.Params == null) continue;
                    if (!item.Params.TryGetValue("used", out var usedText) || !int.TryParse(usedText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var used)) continue;
                    var free = item.Params.TryGetValue("free", out var freeText) && long.TryParse(freeText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var bytes) ? bytes : 0;
                    var p = new Dictionary<string, string> { ["instance"] = item.Instance ?? string.Empty, ["path"] = item.Title, ["percent"] = (100 - used).ToString(CultureInfo.InvariantCulture), ["free"] = NotifyTexts.Size(free) };
                    if (!TellAdmins(Admins(), NotifyKind.LowDisk, "disk|" + item.InstanceId + "|" + item.Title + "|" + day, null, p, now, null)) return;
                    continue;
                }
                // A download's occurrence is when the arr added it (its "since" is when JE first saw the
                // problem, which a restart moves on): the baseline and the event key go by it.
                var occurred = item.Occurred ?? item.Since;
                if (!AlertCodes.Contains(item.Code) || (occurred is DateTime started && started < baseline)) continue;
                // Once per row and occurrence (a new download, a new OK in Seerr is a new one). The
                // "told" mark commits with the alert and is kept fresh while the row is listed, so the
                // inbox's 90-day housekeeping never makes a row that is still there alert again.
                var eventKey = "attention|" + item.Id + "|" + (occurred?.Ticks ?? 0).ToString(CultureInfo.InvariantCulture);
                var payload = AttentionPayload(item);
                foreach (var admin in Admins())
                {
                    // A condition as this check observed it: its origin is the check.
                    var final = _dispatcher.Final(Alert(admin, NotifyKind.Attention, eventKey, item.Key, null, payload, now));
                    switch (final.Effect)
                    {
                        case NotifyEffect.Leave:
                            return;
                        case NotifyEffect.Postpone:
                        case NotifyEffect.Suppress:
                            // Nothing queued: the next check observes the row again.
                            break;
                        case NotifyEffect.Act:
                            Notify(final, tx => tx.KeepMark(admin, "told|" + eventKey, now));
                            break;
                    }
                }
            }
            StuckDigest(attention, Admins, now);
        }

        // One administrators' alert for each administrator the final gate lets it go to now, in one transaction with the event's
        // "handled" state (<paramref name="first"/>, which commits even when nobody is told); false (nothing written) when
        // notifications were switched off meanwhile (or something must be waited for: the next check sees it again). Its origin
        // is the check that observed it (<paramref name="observed"/>).
        private bool TellAdmins(IReadOnlyList<Guid> admins, string kind, string eventKey, string? titleKey, IReadOnlyDictionary<string, string> payload, DateTimeOffset observed, Func<NotifyTransaction, bool>? first)
        {
            var finals = new List<NotifyFinal>();
            foreach (var admin in admins)
            {
                var final = _dispatcher.Final(Alert(admin, kind, eventKey, titleKey, null, payload, observed));
                switch (final.Effect)
                {
                    case NotifyEffect.Leave:
                    case NotifyEffect.Postpone:
                        return false;
                    case NotifyEffect.Suppress:
                        // Not for this administrator: the event is handled with the others' rows.
                        break;
                    case NotifyEffect.Act:
                        finals.Add(final);
                        break;
                }
            }
            NotifyAll(finals, first ?? (_ => true));
            return true;
        }

        // When the administrators' Needs attention alerts began (UTC): set at the first check and kept
        // across restarts (a row that started while Jellyfin was down is still told), moved to now
        // when the alerts come back after being switched off (rows that started meanwhile stay on
        // the Overview only, as at the first check).
        private DateTime AttentionBaseline(DateTimeOffset now)
        {
            var paused = _store.Meta(AttentionPausedKey) != null;
            if (!paused && _store.Meta(AttentionSinceKey) is { } text && long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ms))
            {
                return DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime;
            }
            _store.InTransaction(tx =>
            {
                tx.SetMeta(AttentionSinceKey, now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));
                tx.SetMeta(AttentionPausedKey, null);
                return true;
            });
            return now.UtcDateTime;
        }

        private const string AttentionSinceKey = "attention-since";
        private const string AttentionPausedKey = "attention-paused";

        /// <summary>
        /// Notes (once per switch-off, in the database so a restart while off counts too) that the
        /// alerts were switched off after they had begun: the next check starts their baseline afresh.
        /// A plain restart with the alerts on notes nothing.
        /// </summary>
        internal void NoteAlertsPaused()
        {
            if (_pauseNoted || NotifyFlags.Enabled(_config()) || !_store.Available) return;
            try
            {
                if (_store.Meta(AttentionSinceKey) != null && _store.Meta(AttentionPausedKey) == null)
                {
                    _store.SetMeta(AttentionPausedKey, _now().ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));
                }
                _pauseNoted = true;
            }
            catch (Exception ex)
            {
                _logger?.Warning($"Notifications: could not note that the alerts were switched off ({ex.GetType().Name}).");
            }
        }

        // An attention row's parameters for the inbox, pushes and e-mails (what the Overview row says).
        private static Dictionary<string, string> AttentionPayload(AttentionItem item)
        {
            var p = new Dictionary<string, string>(StringComparer.Ordinal) { ["code"] = item.Code, ["title"] = item.Title ?? string.Empty };
            if (item.Year is int year) p["year"] = year.ToString(CultureInfo.InvariantCulture);
            if (!string.IsNullOrEmpty(item.Scope)) p["scope"] = item.Scope!;
            if (!string.IsNullOrEmpty(item.Instance)) p["instance"] = item.Instance!;
            if (item.Code == AttentionCode.ApprovedNotInArr)
            {
                if (!string.IsNullOrEmpty(item.Message)) p["user"] = item.Message!;
                if (item.Params != null && item.Params.TryGetValue("variant", out var variant)) p["variant"] = variant;
            }
            else if (!string.IsNullOrEmpty(item.Message))
            {
                p["message"] = item.Message!.Length > 200 ? item.Message[..200] + "…" : item.Message!;
            }
            return p;
        }

        private void StuckDigest(IReadOnlyList<AttentionItem> attention, Func<IReadOnlyList<Guid>> admins, DateTimeOffset now)
        {
            var config = _config();
            var hour = Math.Clamp(config?.ArrNotifyDigestHour ?? 9, 0, 23);
            var local = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.Local);
            if (local.Hour != hour) return;
            var day = local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (_store.Meta("digest-day") == day) return;
            var stuckFor = TimeSpan.FromHours(Math.Clamp(config?.ArrNotifyAdminStuckHours ?? 6, 1, 168));
            // The downloads Needs attention has listed for hours (the arr's own words: import
            // blocked, failed, warnings, stalled, client unreachable).
            var items = attention
                .Where(a => DownloadCodes.Contains(a.Code) && a.Since is DateTime since && now.UtcDateTime - since >= stuckFor)
                .Select(a => $"{a.Title ?? "?"}{(string.IsNullOrEmpty(a.Scope) ? string.Empty : " " + a.Scope)} ({a.Instance}, {a.Code})")
                .ToList();
            // The day is marked done only once the list was read, in the same transaction as the
            // digests (a failure or a stop before they exist leaves the day's digest to the next round).
            var p = new Dictionary<string, string>
            {
                ["count"] = items.Count.ToString(CultureInfo.InvariantCulture),
                ["hours"] = ((int)stuckFor.TotalHours).ToString(CultureInfo.InvariantCulture),
                ["items"] = string.Join("; ", items.Take(10)) + (items.Count > 10 ? $"; and {items.Count - 10} more" : string.Empty),
            };
            TellAdmins(items.Count > 0 ? admins() : Array.Empty<Guid>(), NotifyKind.StuckDigest, "stuck|" + day, null, p, now, tx =>
            {
                if (tx.Meta("digest-day") == day) return false;
                tx.SetMeta("digest-day", day);
                return true;
            });
        }

        // ================================================================== creating notifications

        /// <summary>An alert as the final gate is asked about it (its identifiers; the gate reads everything else itself).</summary>
        /// <remarks><paramref name="since"/>: its origin, when what it tells happened (4f round 10: every alert carries one; the gate
        /// holds it to the catch-up limit).</remarks>
        private static NotifyAlert Alert(Guid user, string kind, string? eventKey, string? titleKey, string? itemId, IReadOnlyDictionary<string, string> payload, DateTimeOffset since)
            => new(user, kind, titleKey, itemId, eventKey, payload) { Since = since };

        /// <summary>
        /// Creates the notification the final gate let go (<paramref name="final"/>, decided right before with no await in
        /// between): once per user and event, with the deliveries the gate gave it (each channel the person has on, held until
        /// their quiet hours end); announces it to the person's open pages. Returns false when it already existed (or the
        /// verdict isn't to tell).
        /// </summary>
        /// <remarks>
        /// <paramref name="first"/> runs in the same transaction before the notification is added (the
        /// event's "handled" state: marks, watch stage, the batch it replaces); when it returns false
        /// its changes commit but no notification is created. With <paramref name="generation"/>, nothing
        /// is written (false) when the database was restored since the event's rows were read.
        /// </remarks>
        internal bool Notify(NotifyFinal final, Func<NotifyTransaction, bool>? first, long? generation = null)
        {
            switch (final.Effect)
            {
                case NotifyEffect.Act:
                    break;
                case NotifyEffect.Leave:
                case NotifyEffect.Postpone:
                case NotifyEffect.Suppress:
                    // Only a verdict to tell makes a notification (its caller acts on the others).
                    return false;
            }

            if (final.Alert.EventKey == null) return false;
            var id = _store.InTransaction(generation, tx => first != null && !first(tx) ? null : Add(tx, final), null).Result;
            if (id == null) return false;
            Announce(final);
            return true;
        }

        /// <summary>
        /// Adds the notifications the final gate let go (one event for several administrators) in one transaction with the
        /// event's "handled" state (<paramref name="first"/>; when it returns false nothing is added), then announces the ones
        /// that were new.
        /// </summary>
        private void NotifyAll(IReadOnlyList<NotifyFinal> finals, Func<NotifyTransaction, bool> first)
        {
            var created = _store.InTransaction(tx => first(tx) ? finals.Where(f => Add(tx, f) != null).ToList() : new List<NotifyFinal>());
            foreach (var f in created) Announce(f);
        }

        // A notification and its deliveries, as the final gate decided them; null when the person already has it.
        private static long? Add(NotifyTransaction tx, NotifyFinal final)
        {
            switch (final.Effect)
            {
                case NotifyEffect.Act:
                    break;
                case NotifyEffect.Leave:
                case NotifyEffect.Postpone:
                case NotifyEffect.Suppress:
                    return null;
            }

            return final.Alert.EventKey is { } eventKey
                ? tx.Add(final.Alert.User, eventKey, final.Alert.Kind, final.Alert.TitleKey, final.ItemId, final.Payload, final.Deliveries, final.At)
                : null;
        }

        // After a notification committed: the user's open pages and the dispatcher hear of it.
        private void Announce(NotifyFinal final)
        {
            Interlocked.Increment(ref _created);
            _feed.Bump(new[] { ArrTitleKey.UserInbox(final.Alert.User) });
            if (final.Deliveries.Count > 0) _dispatcher.Wake();
        }

        /// <summary>Tells the user's open pages that their inbox changed (read elsewhere, something new).</summary>
        public void BumpInbox(Guid user) => _feed.Bump(new[] { ArrTitleKey.UserInbox(user) });

        /// <summary>Sends a test message to one user (in-app, plus each outbound channel they have on).</summary>
        public bool SendTest(Guid user)
        {
            var now = _now();
            var final = _dispatcher.Final(Alert(user, NotifyKind.Test, "test|" + now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture), null, null, new Dictionary<string, string>(), now));
            switch (final.Effect)
            {
                case NotifyEffect.Act:
                    return Notify(final, null);
                case NotifyEffect.Leave:
                case NotifyEffect.Postpone:
                case NotifyEffect.Suppress:
                    return false;
            }

            return false;
        }

        /// <summary>
        /// "Send me a test", at most once per <paramref name="every"/>: the slot is claimed in the same
        /// transaction that adds the test (many requests at once send one). False when it is too soon.
        /// </summary>
        public bool TrySendTest(Guid user, TimeSpan every)
        {
            var now = _now();
            var final = _dispatcher.Final(Alert(user, NotifyKind.Test, "test|" + now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture), null, null, new Dictionary<string, string>(), now));
            switch (final.Effect)
            {
                case NotifyEffect.Act:
                    return Notify(final, tx => tx.ClaimMark(user, "test", now, every));
                case NotifyEffect.Leave:
                case NotifyEffect.Postpone:
                case NotifyEffect.Suppress:
                    return false;
            }

            return false;
        }

        // Title, year and poster for a title: Jellyfin's name for the item, else the arrs', else Seerr's.
        private Dictionary<string, string> TitleParams(TitleKey title, Guid? itemId, SeerrRequestRecord? record = null)
        {
            var p = new Dictionary<string, string>(StringComparer.Ordinal) { ["type"] = title.IsMovie ? "movie" : "tv" };
            // The arrs' and Seerr's titles first: right after Jellyfin adds an item its name can still be the folder name.
            string? name = null;
            int? year = null;
            foreach (var instance in _arr.Instances(title.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr))
            {
                if (name != null && year != null) break;
                if (_arr.PeekLibrary(instance.Id) is not { } library) continue;
                if (title.IsMovie)
                {
                    var movie = title.Provider == "tmdb" && title.NumericId is int t ? library.MovieByTmdb(t) : title.Provider == "imdb" ? library.MovieByImdb(title.Id) : null;
                    if (movie == null) continue;
                    name ??= movie.Title;
                    year ??= movie.Year;
                }
                else
                {
                    var series = title.Provider switch
                    {
                        "tvdb" when title.NumericId is int tv => library.SeriesByTvdb(tv),
                        "tmdb" when title.NumericId is int tm => library.SeriesByTmdb(tm),
                        "imdb" => library.SeriesByImdb(title.Id),
                        _ => null,
                    };
                    if (series != null) name ??= series.Title;
                }
            }
            var tmdb = record?.TmdbId ?? (title.Provider == "tmdb" ? title.NumericId : null)
                ?? _requests.ForTitle(title).Select(r => r.TmdbId).FirstOrDefault(x => x > 0);
            if (tmdb is int tmdbId && _requests.Meta(title.IsMovie, tmdbId) is { } meta)
            {
                name ??= string.IsNullOrEmpty(meta.Title) ? null : meta.Title;
                year ??= meta.Year;
                if (!string.IsNullOrEmpty(meta.PosterPath)) p["poster"] = meta.PosterPath!;
            }
            if (string.IsNullOrEmpty(name) && itemId is Guid id) name = _users.ItemName(id);
            if (!string.IsNullOrEmpty(name)) p["title"] = name!.Length > 200 ? name[..200] : name;
            if (year is > 1800) p["year"] = year.Value.ToString(CultureInfo.InvariantCulture);
            if (itemId is Guid image) p["image"] = image.ToString("N", CultureInfo.InvariantCulture);
            return p;
        }

        // The edition and seasons of a Seerr request, as an alert about it carries them (the visibility check reads them back).
        private static void OutcomeParams(Dictionary<string, string> p, SeerrRequestRecord r)
        {
            if (!r.IsMovie && r.Seasons.Count > 0) p["seasons"] = string.Join(", ", r.Seasons.OrderBy(s => s));
            if (r.Is4k) p["variant"] = "4k";
        }

        private string Contact()
        {
            var name = (_config()?.ArrHouseholdContactName ?? string.Empty).Trim();
            return name.Length is > 0 and <= 40 ? name : string.Empty;
        }

        // ================================================================== Jellyfin library events

        /// <summary>Follows the Jellyfin bridge's indexed imports (start; tests call it without the loop).</summary>
        internal void SubscribeBridge()
        {
            if (_bridge == null || Interlocked.Exchange(ref _bridgeSubscribed, 1) == 1) return;
            _bridge.Indexed += OnIndexed;
        }

        private void UnsubscribeBridge()
        {
            if (_bridge == null || Interlocked.Exchange(ref _bridgeSubscribed, 0) == 0) return;
            _bridge.Indexed -= OnIndexed;
        }

        /// <summary>
        /// The Jellyfin bridge's targeted refresh found an imported file: the title (when someone
        /// follows or asked for it) is looked at in the next round, without waiting for Jellyfin's
        /// own item events (a new movie carries its provider ids only after its metadata is read).
        /// </summary>
        internal void OnIndexed(string key)
        {
            try
            {
                if (!NotifyFlags.Enabled(_config())) return;
                Observe(new[] { key });
            }
            catch (Exception)
            {
                // Never disturb a refresh.
            }
        }

        private void OnItemAdded(object? sender, ItemChangeEventArgs e) => ItemAdded(e?.Item);

        private void OnItemUpdated(object? sender, ItemChangeEventArgs e) => ItemUpdated(e?.Item);

        /// <summary>Jellyfin added an item (tests call it): remembered for its first metadata updates, and looked at.</summary>
        internal void ItemAdded(BaseItem? item)
        {
            if (item is not (Movie or Series or Season or Episode)) return;
            _recentlyAdded.Add(item.Id);
            OnItem(item);
        }

        /// <summary>
        /// Jellyfin updated an item (tests call it): only items added a moment ago count, their first
        /// metadata read fills in provider ids and numbers. A movie or episode that is still a fresh arrival
        /// (<see cref="RecentArrivals.FreshVideo"/>) counts too: Jellyfin can read a file's dimensions after that moment,
        /// and the probe is when its edition (a 4K request's copy) becomes known, so it is looked at then, not at the next
        /// sweep (the live change feed only carries it while acquisition badges are on).
        /// </summary>
        internal void ItemUpdated(BaseItem? item)
        {
            if (item == null || !(_recentlyAdded.IsRecent(item.Id) || RecentArrivals.FreshVideo(item, _now()))) return;
            OnItem(item);
        }

        /// <summary>The items added lately whose updates still count (tests).</summary>
        internal RecentArrivals RecentlyAdded => _recentlyAdded;

        private void OnItem(BaseItem item)
        {
            try
            {
                if (!NotifyFlags.Enabled(_config())) return;
                var keys = new List<string>();
                if (item is Movie movie)
                {
                    if (int.TryParse(movie.GetProviderId(MetadataProvider.Tmdb), NumberStyles.None, CultureInfo.InvariantCulture, out var tmdb) && tmdb > 0) keys.Add(ArrTitleKey.Movie(tmdb));
                    if (movie.GetProviderId(MetadataProvider.Imdb) is { Length: > 0 } imdb) keys.Add("movie:imdb:" + imdb);
                }
                else
                {
                    var series = item as Series ?? (item as Season)?.Series ?? (item as Episode)?.Series;
                    if (series == null) return;
                    if (int.TryParse(series.GetProviderId(MetadataProvider.Tvdb), NumberStyles.None, CultureInfo.InvariantCulture, out var tvdb) && tvdb > 0) keys.Add(ArrTitleKey.Series(tvdb));
                    if (series.GetProviderId(MetadataProvider.Tmdb) is { Length: > 0 } tmdb) keys.Add("tv:tmdb:" + tmdb);
                    if (series.GetProviderId(MetadataProvider.Imdb) is { Length: > 0 } imdb) keys.Add("tv:imdb:" + imdb);
                }
                var interest = _interest.Read(new HashSet<string>(StringComparer.Ordinal));
                var hits = keys.Where(interest.Contains).ToList();
                if (hits.Count > 0) MarkDirty(hits);
            }
            catch (Exception)
            {
                // Never disturb a library scan.
            }
        }

        // ================================================================== helpers

        private static HashSet<(int Season, int Episode)> ParseKnown(string? text)
        {
            var set = new HashSet<(int, int)>();
            if (string.IsNullOrEmpty(text)) return set;
            foreach (var part in text.Split(';', StringSplitOptions.RemoveEmptyEntries))
            {
                var colon = part.IndexOf(':', StringComparison.Ordinal);
                if (colon <= 0 || !int.TryParse(part.AsSpan(0, colon), NumberStyles.Integer, CultureInfo.InvariantCulture, out var season)) continue;
                foreach (var range in part[(colon + 1)..].Split(',', StringSplitOptions.RemoveEmptyEntries))
                {
                    var dash = range.IndexOf('-', StringComparison.Ordinal);
                    if (dash < 0)
                    {
                        if (int.TryParse(range, NumberStyles.Integer, CultureInfo.InvariantCulture, out var one)) set.Add((season, one));
                        continue;
                    }
                    if (int.TryParse(range.AsSpan(0, dash), NumberStyles.Integer, CultureInfo.InvariantCulture, out var lo)
                        && int.TryParse(range.AsSpan(dash + 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out var hi)
                        && hi >= lo && (long)hi - lo < 5000)
                    {
                        foreach (var n in new EpisodeRange(lo, hi).Numbers(5000)) set.Add((season, n));
                    }
                }
            }
            return set;
        }

        // "1:1-10,12;2:1-3": compact enough for a long-running series.
        private static string SerializeKnown(IEnumerable<(int Season, int Episode)> episodes)
        {
            var parts = new List<string>();
            foreach (var season in episodes.GroupBy(e => e.Season).OrderBy(g => g.Key))
            {
                var numbers = season.Select(e => e.Episode).Distinct().OrderBy(n => n).ToList();
                var ranges = new List<string>();
                for (var i = 0; i < numbers.Count;)
                {
                    var j = i;
                    while (j + 1 < numbers.Count && numbers[j + 1] == numbers[j] + 1) j++;
                    ranges.Add(i == j ? numbers[i].ToString(CultureInfo.InvariantCulture) : numbers[i].ToString(CultureInfo.InvariantCulture) + "-" + numbers[j].ToString(CultureInfo.InvariantCulture));
                    i = j + 1;
                }
                parts.Add(season.Key.ToString(CultureInfo.InvariantCulture) + ":" + string.Join(",", ranges));
            }
            return string.Join(";", parts);
        }

        private static T? Deserialize<T>(string json)
            where T : class
        {
            try
            {
                return JsonSerializer.Deserialize<T>(json, Json);
            }
            catch (JsonException)
            {
                return null;
            }
        }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<string, byte>> _dirtyFactsOwner = new();
        private ConcurrentDictionary<string, byte> _dirtyFacts { get => _dirtyFactsOwner.Read(ref _dirty, () => new(StringComparer.Ordinal)); set => _dirtyFactsOwner.Store(ref _dirty, value); }
    }
}
