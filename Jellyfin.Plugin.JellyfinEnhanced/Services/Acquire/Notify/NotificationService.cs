using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
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
        private static readonly JsonSerializerOptions Json = new();

        private readonly NotifyStore _store;
        private readonly ArrStatusService _status;
        private readonly SeerrRequestReadModel _requests;
        private readonly IArrJellyfinView _view;
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
        private readonly ConcurrentDictionary<string, byte> _dirty = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<Guid, DateTimeOffset> _recentlyAdded = new();
        private readonly SemaphoreSlim _round = new(1, 1);
        private volatile HashSet<string> _interest = new(StringComparer.Ordinal);
        // Guards _dirty together with _firstDirty/_lastDirty: titles are marked from other threads
        // (the bridge's refresh, Jellyfin's library events) while a round drains them.
        private readonly object _dirtyGate = new();
        private DateTimeOffset? _firstDirty;
        private DateTimeOffset? _lastDirty;
        private string? _epoch;
        private long? _cursor;
        private long _seenRequests = -1;
        private DateTimeOffset _nextSweep;
        private DateTimeOffset _nextAdmin;
        private DateTimeOffset _nextPurge;
        private bool _wasEnabled;
        private volatile bool _pauseNoted;
        private CancellationTokenSource? _loop;
        private long _created;
        private int _bridgeSubscribed;

        /// <summary>The service (DI).</summary>
        public NotificationService(NotifyStore store, ArrStatusService status, SeerrRequestReadModel requests, IArrJellyfinView view, ArrChangeFeed feed, ArrStateStore arr, INotifyUsers users, NotifyDispatcher dispatcher, ILibraryManager library, Logger logger, ArrAdminHubService hub, JellyfinBridge bridge)
            : this(store, status, requests, view, feed, arr, users, dispatcher, library, logger, null, null, hub, bridge)
        {
        }

        /// <summary>
        /// A service with explicit configuration and clock (tests; no Jellyfin library events). Without
        /// <paramref name="hub"/> the administrators' checks that read the admin tools' Needs attention
        /// list (outages, low disk, manual imports, OK'd-but-not-in-an-arr, the stuck digest) are skipped;
        /// with <paramref name="bridge"/> a targeted refresh that finds an imported file looks at its title at once.
        /// </summary>
        internal NotificationService(NotifyStore store, ArrStatusService status, SeerrRequestReadModel requests, IArrJellyfinView view, ArrChangeFeed feed, ArrStateStore arr, INotifyUsers users, NotifyDispatcher dispatcher, ILibraryManager? library, Logger? logger, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now, ArrAdminHubService? hub = null, JellyfinBridge? bridge = null)
        {
            _store = store;
            _status = status;
            _requests = requests;
            _view = view;
            _feed = feed;
            _arr = arr;
            _users = users;
            _dispatcher = dispatcher;
            _library = library;
            _hub = hub;
            _bridge = bridge;
            _logger = logger;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
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
            _ = Task.Run(() => LoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
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
            return Task.CompletedTask;
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
                        var now = _now();
                        _nextSweep = now + FirstSweepAfter;
                        _nextAdmin = now + FirstSweepAfter;
                        _nextPurge = now + TimeSpan.FromMinutes(5);
                        RebuildInterest();
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
            var interest = _interest;
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
        internal async Task TickAsync(CancellationToken cancellationToken, bool force = false)
        {
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
                    var revision = _requests.Revision;
                    ScanRequests(now);
                    Interlocked.Exchange(ref _seenRequests, revision);
                }
                if (now >= _nextSweep)
                {
                    _nextSweep = now + SweepEvery;
                    RebuildInterest();
                    lock (_dirtyGate)
                    {
                        foreach (var key in _interest) _dirty[key] = 0;
                        _firstDirty ??= now;
                        _lastDirty = now - QuietDebounce;
                    }
                }
                if (TakeDue(now, force) is { } keys) await EvaluateAsync(keys, null, cancellationToken).ConfigureAwait(false);
                FlushBatches(_now());
                if (now >= _nextAdmin)
                {
                    _nextAdmin = now + AdminEvery;
                    await AdminChecksAsync(cancellationToken).ConfigureAwait(false);
                }
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
        internal void RebuildInterest()
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
            foreach (var key in set.ToList())
            {
                foreach (var alias in Aliases(TitleKey.Parse(key)!)) set.Add(alias);
            }
            _interest = set;
        }

        // The key a title is looked at under: TMDB for a movie, TVDB for a series, when its own key is
        // another one and an arr library or one of Seerr's requests knows the canonical id.
        private TitleKey Canonical(TitleKey key)
        {
            if ((key.IsMovie && key.Provider == "tmdb") || (!key.IsMovie && key.Provider == "tvdb")) return key;
            var prefix = key.IsMovie ? "movie:tmdb:" : "tv:tvdb:";
            var canonical = Aliases(key).FirstOrDefault(a => a.StartsWith(prefix, StringComparison.Ordinal));
            return canonical != null && TitleKey.Parse(canonical) is { } parsed ? parsed : key;
        }

        // The other keys of a title: the canonical feed key (TMDB movie / TVDB series) and the IMDb /
        // TMDB ids the arr libraries and Seerr's requests (titles no arr holds) know it by.
        private IEnumerable<string> Aliases(TitleKey key)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            foreach (var instance in _arr.Instances(key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr))
            {
                if (_arr.PeekLibrary(instance.Id) is not { } library) continue;
                if (key.IsMovie)
                {
                    var movie = key.Provider == "tmdb" && key.NumericId is int t ? library.MovieByTmdb(t) : key.Provider == "imdb" ? library.MovieByImdb(key.Id) : null;
                    if (movie == null) continue;
                    if (movie.TmdbId is > 0) result.Add(ArrTitleKey.Movie(movie.TmdbId.Value));
                    if (!string.IsNullOrEmpty(movie.ImdbId)) result.Add("movie:imdb:" + movie.ImdbId);
                }
                else
                {
                    var series = key.Provider switch
                    {
                        "tvdb" when key.NumericId is int tv => library.SeriesByTvdb(tv),
                        "tmdb" when key.NumericId is int tm => library.SeriesByTmdb(tm),
                        "imdb" => library.SeriesByImdb(key.Id),
                        _ => null,
                    };
                    if (series == null) continue;
                    if (series.TvdbId is > 0) result.Add(ArrTitleKey.Series(series.TvdbId.Value));
                    if (series.TmdbId is > 0) result.Add("tv:tmdb:" + series.TmdbId.Value.ToString(CultureInfo.InvariantCulture));
                    if (!string.IsNullOrEmpty(series.ImdbId)) result.Add("tv:imdb:" + series.ImdbId);
                }
            }
            // Seerr's requests for the title carry its other ids too (a title no arr holds).
            foreach (var r in _requests.ForTitle(key))
            {
                if (r.IsMovie != key.IsMovie) continue;
                if (key.IsMovie && r.TmdbId is > 0) result.Add(ArrTitleKey.Movie(r.TmdbId.Value));
                if (!key.IsMovie && r.TvdbId is > 0) result.Add(ArrTitleKey.Series(r.TvdbId.Value));
                if (!key.IsMovie && r.TmdbId is > 0) result.Add("tv:tmdb:" + r.TmdbId.Value.ToString(CultureInfo.InvariantCulture));
                if (!string.IsNullOrEmpty(r.ImdbId)) result.Add((key.IsMovie ? "movie:imdb:" : "tv:imdb:") + r.ImdbId);
            }
            result.Remove(key.ToString());
            return result;
        }

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

            /// <summary>Series: the user asked for it in 4K only, so only the 4K copies' episodes count.</summary>
            public bool Only4k { get; set; }

            public bool AllSeasons { get; set; }

            public string? RequestedPoster { get; set; }

            public bool HasRequest { get; set; }

            public bool HasFollow { get; set; }
        }

        private List<Interest> InterestsIn(TitleKey title, Guid? onlyUser)
        {
            var keys = new[] { title.ToString() }.Concat(Aliases(title)).Distinct(StringComparer.Ordinal).ToList();
            var follows = _store.FollowsOfTitles(keys);
            var byUser = new Dictionary<Guid, Interest>();
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
            var records = keys.Select(TitleKey.Parse).Where(k => k != null).SelectMany(k => _requests.ForTitle(k!)).GroupBy(r => r.Id).Select(g => g.First()).ToList();
            foreach (var group in records.Where(r => r.RequestedBy.HasValue).GroupBy(r => r.RequestedBy!.Value))
            {
                if (onlyUser.HasValue && group.Key != onlyUser) continue;
                if (muted.Contains(group.Key)) continue;
                var mine = group.ToList();
                if (!mine.Any(r => r.Active)) continue;
                if (!_store.Prefs(group.Key).AutoFollowRequests) continue;
                var i = For(group.Key);
                i.HasRequest = true;
                var scope = RequestsHubService.ScopeOf(mine, group.Key);
                if (title.IsMovie)
                {
                    i.Scope = scope;
                    continue;
                }
                // A 4K request is followed through the 4K copies, like a 4K movie request and the
                // Requests page's 4K entries (a plain follow of the series still hears of every copy).
                i.Only4k = scope.Only4k && !i.HasFollow;
                if (scope.Seasons.Count == 0)
                {
                    i.AllSeasons = true;
                }
                else
                {
                    foreach (var s in scope.Seasons) (i.Seasons ??= new HashSet<int>()).Add(s);
                }
            }
            return byUser.Values.ToList();
        }

        // ================================================================== evaluation

        /// <summary>
        /// Looks at titles for everyone interested in them (or one user): records first looks and
        /// tells about what became ready since the last look.
        /// </summary>
        internal async Task EvaluateAsync(IReadOnlyCollection<string> titleKeys, Guid? onlyUser, CancellationToken cancellationToken)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var raw in titleKeys)
            {
                // One look per title, under its canonical key (TMDB movie, TVDB series) when an arr knows
                // it: the same title announced under another id is the same interest, the same watch state.
                if (TitleKey.Parse(raw)?.Title is not { } parsed || Canonical(parsed) is not { } title || !seen.Add(title.ToString())) continue;
                foreach (var interest in InterestsIn(title, onlyUser))
                {
                    try
                    {
                        if (ActiveViewer(interest.User) is not { } viewer) continue;
                        if (title.IsMovie) await EvaluateMovieAsync(viewer, interest, cancellationToken).ConfigureAwait(false);
                        else EvaluateSeries(viewer, interest);
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

        // The viewer of a user who may be told things: null for a user who is gone or disabled.
        private StatusViewer? ActiveViewer(Guid user) => _users.IsActive(user) ? _view.Viewer(user) : null;

        private async Task EvaluateMovieAsync(StatusViewer viewer, Interest interest, CancellationToken cancellationToken)
        {
            var key = interest.Key;
            // Rows read from here on are only written back to the same database (not a restored one).
            var generation = _store.Generation;
            var scopes = interest.Scope != null ? new Dictionary<TitleKey, ArrStatusService.RequestScope> { [key] = interest.Scope } : null;
            var composed = (await _status.ComposeForAsync(viewer, new[] { key }, scopes, cancellationToken).ConfigureAwait(false)).FirstOrDefault();
            var stage = composed?.Status.Stage ?? "hidden";
            var scopeName = interest.Scope?.Only4k == true ? "m4k" : "m";
            var mark = "ready|" + key + "|" + scopeName;
            var itemId = composed?.Visible?.ItemId;
            // The same Jellyfin item is one event however many ids the title is known by.
            var marks = itemId is Guid item && item != Guid.Empty
                ? new[] { mark, "ready-item|" + item.ToString("N", CultureInfo.InvariantCulture) + "|" + scopeName }
                : new[] { mark };
            var now = _now();
            var watch = _store.Watch(viewer.UserId, key.ToString(), scopeName);
            if (watch == null)
            {
                // First look: remember it; what is already ready is never announced.
                Written(key, _store.InTransaction(generation, tx =>
                {
                    tx.SetWatch(viewer.UserId, key.ToString(), scopeName, stage, stage == StatusStage.Ready ? ReadyItems(null, itemId) : null, now);
                    if (stage == StatusStage.Ready) foreach (var m in marks) tx.TryMark(viewer.UserId, m, now);
                    return true;
                }, false).Done);
                return;
            }
            if (stage != StatusStage.Ready || watch.Value.Stage == StatusStage.Ready)
            {
                if (stage != watch.Value.Stage) Written(key, _store.InTransaction(generation, tx => { tx.SetWatch(viewer.UserId, key.ToString(), scopeName, stage, watch.Value.Known, now); return true; }, false).Done);
                return;
            }
            // Became ready: the new stage, the "handled" marks and the notification commit together, so
            // a failure (or a stop) before the notification exists leaves it to the next look.
            var arrived = composed!.Scoped ? composed.ArrivedAt : composed.Visible?.DateCreated;
            var prefs = _store.Prefs(viewer.UserId);
            bool Handle(NotifyTransaction tx)
            {
                tx.SetWatch(viewer.UserId, key.ToString(), scopeName, stage, ReadyItems(watch.Value.Known, itemId), now);
                var first = true;
                foreach (var m in marks) first &= tx.TryMark(viewer.UserId, m, now);
                return first;
            }
            if (!prefs.Ready || (arrived is DateTime at && now.UtcDateTime - at > ArrivalFreshFor))
            {
                Written(key, _store.InTransaction(generation, Handle, false).Done);
                return;
            }
            var p = TitleParams(key, itemId);
            if (interest.Scope?.Only4k == true) p["variant"] = "4k";
            if (interest.HasRequest) p["requested"] = "1";
            // One event per interest: a title asked for again after it was removed (its state forgotten,
            // a new watch baseline) is a new event; the marks keep a flapping upgrade to one.
            var eventKey = mark + "|" + watch.Value.Baseline.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);
            if (!Notify(viewer.UserId, NotifyKind.Ready, eventKey, key.ToString(), itemId, p, now, prefs, Handle, generation)) Written(key, _store.Generation == generation);
        }

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
            Guid? seriesItem = null;
            foreach (var copy in SeriesCopies(key, viewer, interest.Only4k))
            {
                seriesItem ??= copy.ItemId;
                foreach (var e in _view.Episodes(copy.ItemId, null, viewer, includeVirtual: false))
                {
                    if (e.Hidden || e.Virtual || e.ItemId == Guid.Empty) continue;
                    for (var n = e.Episode; n <= (e.EpisodeEnd ?? e.Episode) && n - e.Episode < 50; n++)
                    {
                        present.TryAdd((e.Season, n), (e.ItemId, e.DateCreated));
                    }
                }
            }
            var watch = _store.Watch(viewer.UserId, key.ToString(), scope);
            var known = ParseKnown(watch?.Known);
            if (watch == null)
            {
                Written(key, _store.InTransaction(generation, tx => { tx.SetWatch(viewer.UserId, key.ToString(), scope, null, SerializeKnown(present.Keys), now); return true; }, false).Done);
                return;
            }
            var arrivals = present.Where(p => !known.Contains(p.Key)).OrderBy(a => a.Key.Season).ThenBy(a => a.Key.Episode).ToList();
            if (arrivals.Count == 0) return;
            var prefs = _store.Prefs(viewer.UserId);
            foreach (var a in arrivals) known.Add(a.Key);
            var minutes = Math.Clamp(_config()?.ArrNotifyBatchMinutes ?? 10, 1, 60);
            // The episodes' marks, the known set and the batch commit together: a failure leaves the
            // arrivals new for the next look; a restore since the watch was read drops them (looked at again).
            var written = _store.InTransaction(generation, tx =>
            {
                var wanted = new List<(int Season, int Episode, Guid Id)>();
                foreach (var (number, (id, added)) in arrivals)
                {
                    var inScope = interest.AllSeasons ? number.Season > 0 : interest.Seasons?.Contains(number.Season) == true;
                    if (!inScope) continue;
                    if (!tx.TryMark(viewer.UserId, markPrefix + key + ":s" + number.Season.ToString(CultureInfo.InvariantCulture) + ":e" + number.Episode.ToString(CultureInfo.InvariantCulture), now)) continue;
                    if (added is DateTime at && now.UtcDateTime - at > ArrivalFreshFor) continue;
                    wanted.Add((number.Season, number.Episode, id));
                }
                tx.SetWatch(viewer.UserId, key.ToString(), scope, null, SerializeKnown(known), now);
                if (wanted.Count > 0 && prefs.Episodes) AddToBatch(tx, viewer.UserId, BatchKey(key, interest.Only4k), wanted, seriesItem, now, minutes);
                return true;
            }, false);
            Written(key, written.Done);
        }

        // The viewer's copies of a series an interest counts: every copy they can open, or for a 4K
        // request the copies of the 4K Sonarr instances (all of them when no 4K Sonarr is set up).
        private List<JfCopy> SeriesCopies(TitleKey key, StatusViewer viewer, bool only4k)
        {
            var copies = _view.Copies(key, viewer);
            var chosen = only4k ? FourKSeriesCopies(key, copies) ?? copies : copies;
            return chosen.Where(c => c.Visible).ToList();
        }

        /// <summary>
        /// The Jellyfin copies of a series that belong to its 4K Sonarr copies (matched like the status
        /// does: linked libraries, path mappings, folder names); null when no 4K Sonarr is set up.
        /// From memory only.
        /// </summary>
        private IReadOnlyList<JfCopy>? FourKSeriesCopies(TitleKey key, IReadOnlyList<JfCopy> copies)
        {
            var instances = _arr.Instances(ArrKind.Sonarr);
            if (!instances.Any(i => i.Role == "4k")) return null;
            var arr = new List<ArrCopyFacts>();
            foreach (var instance in instances)
            {
                if (SonarrSeries(instance, key) is { } series) arr.Add(new ArrCopyFacts(instance) { Series = series });
            }
            return arr.Where(x => x.Instance.Role == "4k").SelectMany(x => StatusComposer.MatchCopies(x, copies, arr.Count)).Distinct().ToList();
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
        }

        private sealed class BatchState
        {
            public string? Series { get; set; }

            public List<BatchEntry> Episodes { get; set; } = new();
        }

        private static void AddToBatch(NotifyTransaction tx, Guid user, string key, List<(int Season, int Episode, Guid Id)> episodes, Guid? seriesItem, DateTimeOffset now, int minutes)
        {
            var existing = tx.Batch(user, key);
            var state = existing is { } b ? Deserialize<BatchState>(b.Episodes) ?? new BatchState() : new BatchState();
            state.Series ??= seriesItem?.ToString("N", CultureInfo.InvariantCulture);
            foreach (var (s, e, id) in episodes)
            {
                if (state.Episodes.Any(x => x.S == s && x.E == e)) continue;
                state.Episodes.Add(new BatchEntry { S = s, E = e, I = id.ToString("N", CultureInfo.InvariantCulture) });
            }
            var first = existing?.FirstAt ?? now;
            // The window runs from the first episode, so a slow trickle can't hold the message back for ever.
            tx.SetBatch(user, key, JsonSerializer.Serialize(state, Json), first, existing?.DueAt ?? now + TimeSpan.FromMinutes(minutes));
        }

        /// <summary>
        /// Sends every batch whose window has closed (tests call it). What a batch names is checked
        /// again for the viewer first (access or parental limits may have changed during the window);
        /// the batch goes away in the same transaction that creates its notification (only the version
        /// that was read: episodes merged into it meanwhile roll the notification back, and the next
        /// round sends the merged batch), and a batch that fails is tried again a minute later. Nothing
        /// read before a restore of the database is written into the restored one.
        /// </summary>
        internal int FlushBatches(DateTimeOffset now)
        {
            var sent = 0;
            var generation = _store.Generation;
            foreach (var (user, key, json) in _store.DueBatches(now))
            {
                try
                {
                    if (FlushBatch(user, key, json, now, generation)) sent++;
                }
                catch (BatchChangedException)
                {
                    // Merged into (or restored) since it was read: the next round sees the new version.
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"Notifications: could not send an episode batch ({ex.GetType().Name}: {ex.Message}); trying again in a minute.");
                    try
                    {
                        _store.InTransaction(generation, tx =>
                        {
                            if (tx.Batch(user, key) is { } b) tx.SetBatch(user, key, b.Episodes, b.FirstAt, now + TimeSpan.FromMinutes(1));
                            return true;
                        }, false);
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

        private bool FlushBatch(Guid user, string key, string json, DateTimeOffset now, long generation)
        {
            var only4k = key.EndsWith("|4k", StringComparison.Ordinal);
            var title = TitleKey.Parse(only4k ? key[..^3] : key);
            var state = Deserialize<BatchState>(json);
            var viewer = ActiveViewer(user);
            var prefs = viewer != null ? _store.Prefs(user) : null;
            if (title == null || state == null || viewer == null || prefs?.Episodes != true)
            {
                DropBatch(user, key, json, generation);
                return false;
            }
            // Only what the viewer can still open (a library or parental limit may have changed), each
            // number linked to an episode item the viewer can open now: the one stored when it was
            // batched while it is still visible, else the copy that still is.
            var copies = SeriesCopies(title, viewer, only4k);
            var open = new Dictionary<(int, int), HashSet<Guid>>();
            foreach (var copy in copies)
            {
                foreach (var e in _view.Episodes(copy.ItemId, null, viewer, includeVirtual: false))
                {
                    if (e.Hidden || e.Virtual || e.ItemId == Guid.Empty) continue;
                    for (var n = e.Episode; n <= (e.EpisodeEnd ?? e.Episode) && n - e.Episode < 50; n++)
                    {
                        if (!open.TryGetValue((e.Season, n), out var ids)) open[(e.Season, n)] = ids = new HashSet<Guid>();
                        ids.Add(e.ItemId);
                    }
                }
            }
            var episodes = state.Episodes.Where(x => open.ContainsKey((x.S, x.E))).OrderBy(x => x.S).ThenBy(x => x.E).ToList();
            if (episodes.Count == 0)
            {
                DropBatch(user, key, json, generation);
                return false;
            }
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
            if (only4k) p["variant"] = "4k";
            if (episodes.Count == 1)
            {
                p["mode"] = "single";
                p["season"] = episodes[0].S.ToString(CultureInfo.InvariantCulture);
                p["episode"] = episodes[0].E.ToString(CultureInfo.InvariantCulture);
                itemId = episodes[0].I ?? itemId;
            }
            else if (seasons.Count == 1 && seriesItem is Guid series && WholeSeason(title, only4k, open.Keys, seasons[0], episodes.Count))
            {
                // A whole season arriving together (a season pack) collapses to one line.
                p["mode"] = "season";
                p["season"] = seasons[0].ToString(CultureInfo.InvariantCulture);
                itemId = _view.Seasons(series, viewer).FirstOrDefault(x => !x.Hidden && x.Season == seasons[0] && x.ItemId != Guid.Empty)?.ItemId.ToString("N", CultureInfo.InvariantCulture) ?? itemId;
            }
            else
            {
                p["mode"] = "many";
            }
            var first = episodes[0];
            var eventKey = (only4k ? "eps4k|" : "eps|") + title + "|s" + first.S.ToString(CultureInfo.InvariantCulture) + "e" + first.E.ToString(CultureInfo.InvariantCulture) + "|" + episodes.Count.ToString(CultureInfo.InvariantCulture) + "|" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join(".", episodes.Select(x => x.S.ToString(CultureInfo.InvariantCulture) + "x" + x.E.ToString(CultureInfo.InvariantCulture))))), 0, 6);
            if (Notify(user, NotifyKind.Episodes, eventKey, title.ToString(), itemId is { } i && Guid.TryParse(i, out var g) ? g : null, p, now, prefs, tx => tx.DeleteBatchIf(user, key, json) ? true : throw new BatchChangedException(), generation)) return true;
            if (_store.Generation != generation) throw new BatchChangedException();
            return false;
        }

        // True when the batch is the whole season: Sonarr knows how many episodes the season has (the
        // copy of the variant asked for), every one of them is here for the viewer and every one is in
        // the batch. A season whose length isn't known never reads as complete (a two-episode premiere
        // is not "Season 3 is ready").
        private bool WholeSeason(TitleKey title, bool only4k, IEnumerable<(int Season, int Episode)> open, int season, int count)
        {
            if (count < 2) return false;
            var instances = _arr.Instances(ArrKind.Sonarr).Where(i => only4k ? i.Role == "4k" : i.Role != "4k").ToList();
            foreach (var instance in instances)
            {
                if (SonarrSeries(instance, title)?.Seasons.FirstOrDefault(x => x.SeasonNumber == season) is not { TotalEpisodeCount: > 0 } stats) continue;
                var have = open.Count(x => x.Season == season);
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
        /// </summary>
        internal void ScanRequests(DateTimeOffset now)
        {
            if (!_requests.Active || !_requests.Loaded) return;
            var all = _requests.All;
            var seen = _store.SeerrSeen();
            var baselineText = _store.Meta("seerr_baseline");
            var changed = new List<(int, int, Guid?)>();
            var titles = new HashSet<string>(StringComparer.Ordinal);
            if (baselineText == null)
            {
                foreach (var r in all) changed.Add((r.Id, r.Status, r.RequestedBy));
                _store.SetSeerrSeen(changed, Array.Empty<int>(), now);
                _store.SetMeta("seerr_baseline", now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));
                RebuildInterest();
                foreach (var r in all.Where(r => r.RequestedBy.HasValue && r.Key != null)) titles.Add(r.Key!.Title.ToString());
                MarkDirty(titles);
                return;
            }
            var baseline = DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(baselineText, CultureInfo.InvariantCulture)).UtcDateTime;
            var admins = (IReadOnlyList<Guid>?)null;
            foreach (var r in all)
            {
                var known = seen.TryGetValue(r.Id, out var previous);
                if (known && previous == r.Status) continue;
                changed.Add((r.Id, r.Status, r.RequestedBy));
                if (r.Key != null) titles.Add(r.Key.Title.ToString());
                var fresh = !known && r.CreatedAt is DateTime created && created >= baseline;
                if (!known && r.Active && r.RequestedBy is Guid asker && r.Key != null
                    && !all.Any(o => o.Id != r.Id && o.Active && o.RequestedBy == asker && o.Key != null && seen.ContainsKey(o.Id) && o.Key.Title.Equals(r.Key.Title)))
                {
                    // A new request from someone with no other request for the title (asked again after
                    // it was removed): what they were told under the old one doesn't stop telling them
                    // this time. An upgrade flapping under the same request is still told once.
                    ForgetTitle(asker, r.Key.Title);
                }
                if (r.Status == SeerrRequestStatus.Declined && r.RequestedBy is Guid requester && (known || fresh) && _users.IsActive(requester))
                {
                    var prefs = _store.Prefs(requester);
                    if (prefs.Declined && r.Key != null)
                    {
                        var p = TitleParams(r.Key.Title, null, r);
                        p["contact"] = Contact();
                        Notify(requester, NotifyKind.Declined, "declined|" + r.Id.ToString(CultureInfo.InvariantCulture), r.Key.Title.ToString(), null, p, now, prefs);
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
                        if (!r.IsMovie && r.Seasons.Count > 0) p["seasons"] = string.Join(", ", r.Seasons.OrderBy(s => s));
                        if (r.Is4k) p["variant"] = "4k";
                        Notify(admin, NotifyKind.Approval, "approval|" + r.Id.ToString(CultureInfo.InvariantCulture), r.Key?.Title.ToString(), null, p, now, null);
                    }
                }
            }
            var ids = new HashSet<int>(all.Select(r => r.Id));
            var gone = seen.Keys.Where(id => !ids.Contains(id)).ToList();
            if (changed.Count > 0 || gone.Count > 0) _store.SetSeerrSeen(changed, gone, now);
            if (gone.Count > 0 || changed.Count > 0)
            {
                RebuildInterest();
                ForgetEndedInterests();
            }
            MarkDirty(titles);
        }

        // A requester with no active request left for a title they don't follow starts afresh next time.
        private void ForgetEndedInterests()
        {
            var active = new HashSet<(Guid, string)>(_requests.All.Where(r => r.Active && r.RequestedBy.HasValue && r.Key != null).Select(r => (r.RequestedBy!.Value, r.Key!.Title.ToString())));
            var followed = new HashSet<(Guid, string)>(_store.AllFollows().Where(f => !f.Muted).Select(f => (f.UserId, TitleKey.Parse(f.Key)?.Title.ToString() ?? f.Key)));
            foreach (var r in _requests.All.Where(r => !r.Active && r.RequestedBy.HasValue && r.Key != null))
            {
                var pair = (r.RequestedBy!.Value, r.Key!.Title.ToString());
                if (active.Contains(pair) || followed.Contains(pair)) continue;
                ForgetTitle(pair.Item1, r.Key!.Title);
            }
        }

        /// <summary>
        /// Forgets what a user was told about a title (its watch state and Ready / episode marks under
        /// every id it is known by, and the Ready marks of its Jellyfin items), so their next interest
        /// in it starts afresh and is told again when it becomes ready.
        /// </summary>
        private void ForgetTitle(Guid user, TitleKey title)
        {
            var canonical = Canonical(title.Title);
            var keys = new[] { title.Title.ToString(), canonical.ToString() }.Concat(Aliases(canonical)).Distinct(StringComparer.Ordinal).ToList();
            var items = new List<Guid>();
            if (_view.Viewer(user) is { } viewer)
            {
                foreach (var k in keys)
                {
                    if (TitleKey.Parse(k) is { } parsed) items.AddRange(_view.Copies(parsed, viewer).Select(c => c.ItemId).Where(id => id != Guid.Empty));
                }
            }
            _store.InTransaction(tx => tx.ForgetTitle(user, keys, items));
        }

        private void MarkDirty(IEnumerable<string> titles)
        {
            var now = _now();
            lock (_dirtyGate)
            {
                var any = false;
                foreach (var t in titles)
                {
                    _dirty[t] = 0;
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
            lock (_dirtyGate)
            {
                if (!_firstDirty.HasValue || !(force || now - _lastDirty >= QuietDebounce || now - _firstDirty >= MaxDebounce)) return null;
                var keys = _dirty.Keys.Take(MaxPerRound).ToList();
                foreach (var k in keys) _dirty.TryRemove(k, out _);
                if (_dirty.IsEmpty)
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
            lock (_dirtyGate) return _dirty.ContainsKey(title) && _firstDirty.HasValue;
        }

        // ================================================================== follows (routes)

        /// <summary>
        /// Follows a title (movie, series or season key), or mutes / unfollows it. A new follow takes
        /// its first look at once, so only what arrives from now on is announced. Returns false when
        /// the user may not follow it or holds too many follows.
        /// </summary>
        public async Task<string> SetFollowAsync(StatusViewer viewer, TitleKey key, bool on, CancellationToken cancellationToken)
        {
            if (!Enabled) return "disabled";
            if (key.Episode.HasValue) return "invalid_key";
            if (on && !_status.MayFollow(viewer, key)) return "not_allowed";
            var now = _now();
            var kind = key.IsMovie ? "title" : key.Season.HasValue ? "season" : "episodes";
            var asked = _requests.AskedBy(key.Title, viewer.UserId);
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
        {
            var prefs = _store.Prefs(userId);
            var requested = prefs.AutoFollowRequests
                ? _requests.ForUser(userId).Where(r => r.Active && r.Key != null).Select(r => r.Key!.Title.ToString()).Distinct(StringComparer.Ordinal).ToList()
                : new List<string>();
            return (_store.Follows(userId), requested);
        }

        // ================================================================== remind

        /// <summary>
        /// "Remind {contact}" on a title that is taking longer than usual: the administrators get it
        /// as an admin event, at most once per user and title every 24 hours. Only for titles the user
        /// can see that really need attention right now; administrators don't remind themselves.
        /// </summary>
        public async Task<RemindOutcome> RemindAsync(StatusViewer viewer, TitleKey key, Guid? itemId, CancellationToken cancellationToken)
        {
            if (!Enabled) return new RemindOutcome("disabled");
            if (viewer.IsAdmin) return new RemindOutcome("admin");
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
            var drafts = _users.Admins().Select(admin => Draft(admin, NotifyKind.Remind, eventKey, statusKey.ToString(), itemId, p, now, null)).ToList();
            var created = _store.InTransaction(tx =>
            {
                if (!tx.ClaimMark(viewer.UserId, mark, now, RemindEvery)) return null;
                return drafts.Where(d => d.Add(tx) != null).ToList();
            });
            if (created == null)
            {
                var last = _store.MarkAt(viewer.UserId, mark) ?? now;
                return new RemindOutcome("too_soon", last + RemindEvery);
            }
            foreach (var d in created) Announce(d);
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
        internal async Task AdminChecksAsync(CancellationToken cancellationToken)
        {
            if (_hub == null) return;
            var config = _config();
            var now = _now();
            var downAfter = TimeSpan.FromMinutes(Math.Clamp(config?.ArrNotifyAdminDownMinutes ?? 10, 1, 1440));
            IReadOnlyList<Guid>? admins = null;
            IReadOnlyList<Guid> Admins() => admins ??= _users.Admins();
            var attention = await _hub.NeedsAttentionAsync(cancellationToken, background: true).ConfigureAwait(false);
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
                            var drafts = Admins().Select(admin => Draft(admin, NotifyKind.InstanceDown, "down|" + instance.Id + "|" + since, null, null, p, now, null)).ToList();
                            NotifyAll(drafts, tx =>
                            {
                                if (tx.Meta("down-told:" + instance.Id) != null) return false;
                                tx.SetMeta("down-told:" + instance.Id, since);
                                return true;
                            });
                        }
                    }
                    continue;
                }
                if (since != null)
                {
                    // Clearing the outage and telling it ended commit together.
                    var told = _store.Meta("down-told:" + instance.Id);
                    var p = new Dictionary<string, string> { ["instance"] = instance.Name };
                    var drafts = told == null ? new List<NotificationDraft>() : Admins().Select(admin => Draft(admin, NotifyKind.InstanceUp, "up|" + instance.Id + "|" + told, null, null, p, now, null)).ToList();
                    NotifyAll(drafts, tx =>
                    {
                        if (tx.Meta("down-told:" + instance.Id) != told) return false;
                        tx.SetMeta(downKey, null);
                        tx.SetMeta("down-told:" + instance.Id, null);
                        return true;
                    });
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
                    foreach (var admin in Admins()) Notify(admin, NotifyKind.LowDisk, "disk|" + item.InstanceId + "|" + item.Title + "|" + day, null, null, p, now, null);
                    continue;
                }
                if (!AlertCodes.Contains(item.Code) || (item.Since is DateTime started && started < baseline)) continue;
                // Once per row and occurrence (a new download, a new OK in Seerr is a new one). The
                // "told" mark commits with the alert and is kept fresh while the row is listed, so the
                // inbox's 90-day housekeeping never makes a row that is still there alert again.
                var eventKey = "attention|" + item.Id + "|" + (item.Since?.Ticks ?? 0).ToString(CultureInfo.InvariantCulture);
                var payload = AttentionPayload(item);
                foreach (var admin in Admins()) Notify(admin, NotifyKind.Attention, eventKey, item.Key, null, payload, now, null, tx => tx.KeepMark(admin, "told|" + eventKey, now));
            }
            StuckDigest(config, attention, Admins, now);
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

        private void StuckDigest(PluginConfiguration? config, IReadOnlyList<AttentionItem> attention, Func<IReadOnlyList<Guid>> admins, DateTimeOffset now)
        {
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
            var drafts = new List<NotificationDraft>();
            if (items.Count > 0)
            {
                var p = new Dictionary<string, string>
                {
                    ["count"] = items.Count.ToString(CultureInfo.InvariantCulture),
                    ["hours"] = ((int)stuckFor.TotalHours).ToString(CultureInfo.InvariantCulture),
                    ["items"] = string.Join("; ", items.Take(10)) + (items.Count > 10 ? $"; and {items.Count - 10} more" : string.Empty),
                };
                drafts.AddRange(admins().Select(admin => Draft(admin, NotifyKind.StuckDigest, "stuck|" + day, null, null, p, now, null)));
            }
            NotifyAll(drafts, tx =>
            {
                if (tx.Meta("digest-day") == day) return false;
                tx.SetMeta("digest-day", day);
                return true;
            });
        }

        // ================================================================== creating notifications

        /// <summary>
        /// Creates a notification (once per user and event) with a delivery for each outbound channel
        /// the user has on, held until their quiet hours end; announces it to the user's open pages.
        /// Returns false when it already existed.
        /// </summary>
        /// <remarks>
        /// <paramref name="first"/> runs in the same transaction before the notification is added (the
        /// event's "handled" state: marks, watch stage, the batch it replaces); when it returns false
        /// its changes commit but no notification is created. With <paramref name="generation"/>, nothing
        /// is written (false) when the database was restored since the event's rows were read.
        /// </remarks>
        internal bool Notify(Guid user, string kind, string eventKey, string? titleKey, Guid? itemId, IReadOnlyDictionary<string, string> payload, DateTimeOffset now, NotifyPrefs? prefs, Func<NotifyTransaction, bool>? first = null, long? generation = null)
        {
            var draft = Draft(user, kind, eventKey, titleKey, itemId, payload, now, prefs);
            var id = _store.InTransaction(generation, tx => first != null && !first(tx) ? null : draft.Add(tx), null).Result;
            if (id == null) return false;
            Announce(draft);
            return true;
        }

        /// <summary>
        /// Adds several notifications (one event for several administrators) in one transaction with
        /// the event's "handled" state (<paramref name="first"/>; when it returns false nothing is added),
        /// then announces the ones that were new.
        /// </summary>
        private void NotifyAll(IReadOnlyList<NotificationDraft> drafts, Func<NotifyTransaction, bool> first)
        {
            var created = _store.InTransaction(tx => first(tx) ? drafts.Where(d => d.Add(tx) != null).ToList() : new List<NotificationDraft>());
            foreach (var d in created) Announce(d);
        }

        /// <summary>A notification ready to be added: its deliveries are decided from the user's settings now.</summary>
        private sealed record NotificationDraft(Guid User, string Kind, string EventKey, string? TitleKey, string? ItemId, IReadOnlyDictionary<string, string> Payload, IReadOnlyList<(string Channel, DateTimeOffset At)> Deliveries, DateTimeOffset Now)
        {
            public long? Add(NotifyTransaction tx) => tx.Add(User, EventKey, Kind, TitleKey, ItemId, Payload, Deliveries, Now);
        }

        private NotificationDraft Draft(Guid user, string kind, string eventKey, string? titleKey, Guid? itemId, IReadOnlyDictionary<string, string> payload, DateTimeOffset now, NotifyPrefs? prefs)
        {
            prefs ??= _store.Prefs(user);
            var config = _config();
            var deliveries = new List<(string, DateTimeOffset)>();
            var external = !NotifyKind.IsAdminKind(kind) || prefs.AdminAlerts;
            var at = QuietHours.EndsAt(prefs, now) ?? now;
            if (external && prefs.Ntfy && NotifyEndpoints.IsTopic(prefs.NtfyTopic) && NotifyEndpoints.NtfyReady(config)) deliveries.Add((NotifyChannel.Ntfy, at));
            if (external && prefs.Email && !string.IsNullOrEmpty(prefs.EmailAddress) && NotifyEndpoints.EmailReady(config)) deliveries.Add((NotifyChannel.Email, at));
            return new NotificationDraft(user, kind, eventKey, titleKey, itemId?.ToString("N", CultureInfo.InvariantCulture), payload, deliveries, now);
        }

        // After a notification committed: the user's open pages and the dispatcher hear of it.
        private void Announce(NotificationDraft draft)
        {
            Interlocked.Increment(ref _created);
            _feed.Bump(new[] { ArrTitleKey.UserInbox(draft.User) });
            if (draft.Deliveries.Count > 0) _dispatcher.Wake();
        }

        /// <summary>Tells the user's open pages that their inbox changed (read elsewhere, something new).</summary>
        public void BumpInbox(Guid user) => _feed.Bump(new[] { ArrTitleKey.UserInbox(user) });

        /// <summary>Sends a test message to one user (in-app, plus each outbound channel they have on).</summary>
        public bool SendTest(Guid user)
        {
            var now = _now();
            return Notify(user, NotifyKind.Test, "test|" + now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture), null, null, new Dictionary<string, string>(), now, null);
        }

        /// <summary>
        /// "Send me a test", at most once per <paramref name="every"/>: the slot is claimed in the same
        /// transaction that adds the test (many requests at once send one). False when it is too soon.
        /// </summary>
        public bool TrySendTest(Guid user, TimeSpan every)
        {
            var now = _now();
            return Notify(user, NotifyKind.Test, "test|" + now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture), null, null, new Dictionary<string, string>(), now, null, tx => tx.ClaimMark(user, "test", now, every));
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

        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            if (e?.Item is not (Movie or Series or Season or Episode)) return;
            if (_recentlyAdded.Count > 5000) _recentlyAdded.Clear();
            _recentlyAdded[e.Item.Id] = _now();
            OnItem(e.Item);
        }

        // Only items added a moment ago: their first metadata read fills in provider ids and numbers.
        private void OnItemUpdated(object? sender, ItemChangeEventArgs e)
        {
            if (e?.Item is not { } item || !_recentlyAdded.TryGetValue(item.Id, out var at)) return;
            if (_now() - at > RecentlyAddedWindow)
            {
                _recentlyAdded.TryRemove(item.Id, out _);
                return;
            }
            OnItem(item);
        }

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
                var interest = _interest;
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
                        && hi >= lo && hi - lo < 5000)
                    {
                        for (var n = lo; n <= hi; n++) set.Add((season, n));
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
    }
}
