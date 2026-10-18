using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>
    /// Feeds <see cref="ArrChangeFeed"/>: every time a snapshot changes (a refresh or a live patch)
    /// it works out which titles changed (<see cref="ArrChangeDetector"/>) and bumps their keys.
    /// New history events whose files changed also get their library entry re-read. Jellyfin's own
    /// library adds and removes bump the titles the arrs know about (that is when a title becomes
    /// "Ready"); so do recent updates and, with acquisition badges on, updates of old primaries. A new episode only
    /// gets its season and episode numbers (and so becomes "Ready" on its season page) when its
    /// metadata is read, after it was added. Changes are gathered off the scanner thread and handled
    /// once a second. Does nothing while phase 1 is off.
    /// </summary>
    public sealed class ArrChangeTracker : IHostedService, IDisposable
    {
        private static readonly TimeSpan ItemFlushDelay = TimeSpan.FromSeconds(1);

        /// <summary>How long after being added an item's updates still count as part of its arrival.</summary>
        internal static readonly TimeSpan RecentlyAddedWindow = TimeSpan.FromMinutes(10);

        private const int MaxRecentlyAdded = 5000;

        private readonly ArrStateStore _store;
        private readonly ArrChangeFeed _feed;
        private readonly ArrLiveRouter _router;
        private readonly ILibraryManager? _libraryManager;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly ConcurrentQueue<ItemChange> _items = new();
        private readonly Timer _itemTimer;
        private readonly RecentArrivals _recentlyAdded;
        private readonly TimeSpan _itemFlushDelay;
        private int _itemFlushArmed;
        private bool _started;

        /// <summary>Creates the tracker (DI).</summary>
        public ArrChangeTracker(ArrStateStore store, ArrChangeFeed feed, ArrLiveRouter router, ILibraryManager libraryManager, Logger logger)
            : this(store, feed, router, libraryManager, logger, () => JellyfinEnhanced.Instance?.Configuration)
        {
        }

        /// <summary>
        /// Creates the tracker with explicit sources (tests). With <paramref name="itemFlushDelay"/>
        /// <see cref="Timeout.InfiniteTimeSpan"/> queued library changes are recorded only by
        /// <see cref="FlushItems"/> calls (the timer never does it on its own).
        /// </summary>
        internal ArrChangeTracker(ArrStateStore store, ArrChangeFeed feed, ArrLiveRouter router, ILibraryManager? libraryManager, Logger? logger, Func<PluginConfiguration?> config, Func<DateTimeOffset>? now = null, TimeSpan? itemFlushDelay = null)
        {
            _recentlyAdded = new RecentArrivals(RecentlyAddedWindow, MaxRecentlyAdded, now);
            _itemFlushDelay = itemFlushDelay ?? ItemFlushDelay;
            _store = store;
            _feed = feed;
            _router = router;
            _libraryManager = libraryManager;
            _logger = logger;
            _config = config;
            _itemTimer = new Timer(_ =>
            {
                try
                {
                    FlushItems();
                }
                catch (Exception ex)
                {
                    // A timer callback must never throw (it would end the process).
                    _logger?.Warning($"Arr live: recording Jellyfin library changes failed ({ex.GetType().Name}).");
                }
            }, null, Timeout.Infinite, Timeout.Infinite);
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            Start();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (!_started) return Task.CompletedTask;
            _started = false;
            _store.SnapshotChanged -= OnSnapshotChanged;
            _store.PipelineChanged -= OnPipelineChanged;
            _store.QueueHealthChanged -= OnQueueHealthChanged;
            if (_libraryManager != null)
            {
                _libraryManager.ItemAdded -= OnItemAdded;
                _libraryManager.ItemUpdated -= OnItemUpdated;
                _libraryManager.ItemRemoved -= OnItemRemoved;
            }
            _itemTimer.Change(Timeout.Infinite, Timeout.Infinite);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public void Dispose() => _itemTimer.Dispose();

        /// <summary>The items added lately whose updates still count as their arrival (tests).</summary>
        internal RecentArrivals RecentlyAdded => _recentlyAdded;

        /// <summary>Subscribes to the store and Jellyfin's library (idempotent).</summary>
        internal void Start()
        {
            if (_started) return;
            _started = true;
            _store.SnapshotChanged += OnSnapshotChanged;
            _store.PipelineChanged += OnPipelineChanged;
            _store.QueueHealthChanged += OnQueueHealthChanged;
            if (_libraryManager != null)
            {
                _libraryManager.ItemAdded += OnItemAdded;
                _libraryManager.ItemUpdated += OnItemUpdated;
                _libraryManager.ItemRemoved += OnItemRemoved;
            }
        }

        /// <summary>
        /// Bumps the titles behind arr ids of one instance (for example the targets of a search
        /// command that started or finished). Unknown ids are skipped.
        /// </summary>
        public int BumpTitles(string instanceId, IEnumerable<int> arrIds)
        {
            if (!ArrLiveFlags.Enabled(_config())) return 0;
            var library = _store.PeekLibrary(instanceId);
            if (library == null) return 0;
            var keys = new List<string>();
            foreach (var id in arrIds)
            {
                if (library.MovieById(id)?.TmdbId is > 0 and var tmdb) keys.Add(ArrTitleKey.Movie(tmdb));
                if (library.SeriesById(id)?.TvdbId is > 0 and var tvdb) keys.Add(ArrTitleKey.Series(tvdb));
            }
            return keys.Count == 0 ? 0 : _feed.Bump(keys, instanceId);
        }

        /// <summary>Handles one snapshot change (public for tests and for future snapshot kinds).</summary>
        internal void OnSnapshotChanged(ArrSnapshotChange change)
        {
            if (!ArrLiveFlags.Enabled(_config())) return;
            var id = change.Instance.Id;
            var kind = change.Instance.Kind;
            if (change.Before == null)
            {
                FirstLoad(change);
                return;
            }
            IReadOnlyCollection<string> keys;
            switch (change.Kind)
            {
                case ArrSnapshotKind.Queue:
                    keys = ArrChangeDetector.Queue(kind, change.Before as ArrQueueSnapshot, (ArrQueueSnapshot)change.After, _store.PeekLibrary(id), change.Departed);
                    break;
                case ArrSnapshotKind.Library:
                    keys = ArrChangeDetector.Library(change.Before as ArrLibrarySnapshot, (ArrLibrarySnapshot)change.After, change.ChangedIds);
                    break;
                case ArrSnapshotKind.History:
                {
                    var (historyKeys, reread) = ArrChangeDetector.History(kind, change.Before as ArrHistorySnapshot, (ArrHistorySnapshot)change.After, _store.PeekLibrary(id));
                    keys = historyKeys;
                    if (reread.Count > 0) _router.Hint(id, ArrLiveKinds.None, reread);
                    break;
                }
                case ArrSnapshotKind.Episodes:
                    keys = ArrChangeDetector.Episodes(change.Before as ArrEpisodesSnapshot, (ArrEpisodesSnapshot)change.After, _store.PeekLibrary(id));
                    break;
                default:
                    return;
            }
            if (keys.Count > 0) _feed.Bump(keys, id);
        }

        /// <summary>
        /// An instance's queue or history expired (or was read again after it had): every title it
        /// holds now reads differently ("can't be checked", or live again) though no snapshot
        /// changed, so they are announced like a first load (too many: a reset for everyone).
        /// </summary>
        internal void OnPipelineChanged(ArrConnection instance, bool expired)
        {
            if (!ArrLiveFlags.Enabled(_config())) return;
            var library = _store.PeekLibrary(instance.Id);
            if (library == null) return;
            var keys = ArrChangeDetector.FirstLoad(instance.Kind, ArrSnapshotKind.Library, library, library);
            if (keys == null)
            {
                _feed.ResetAll();
                return;
            }
            if (keys.Count > 0) _feed.Bump(keys, instance.Id);
        }

        /// <summary>
        /// An instance's queue reads started failing (or work again): the downloads it shows are no
        /// longer fresh (their time left goes) or are again, though the queue itself didn't change,
        /// so the titles in it are announced (too many: a reset for everyone).
        /// </summary>
        internal void OnQueueHealthChanged(ArrConnection instance, bool failing)
        {
            if (!ArrLiveFlags.Enabled(_config())) return;
            if (_store.PeekQueue(instance.Id) is not { } queue) return;
            var keys = ArrChangeDetector.FirstLoad(instance.Kind, ArrSnapshotKind.Queue, queue, _store.PeekLibrary(instance.Id));
            if (keys == null)
            {
                _feed.ResetAll();
                return;
            }
            if (keys.Count > 0) _feed.Bump(keys, instance.Id);
        }

        // A snapshot's first load: statuses served while it was cold said "loading" (or lacked its
        // facts), so the titles it holds are announced; too many of them is a reset for everyone.
        private void FirstLoad(ArrSnapshotChange change)
        {
            var keys = ArrChangeDetector.FirstLoad(change.Instance.Kind, change.Kind, change.After, _store.PeekLibrary(change.Instance.Id));
            if (keys == null)
            {
                _feed.ResetAll();
                return;
            }
            if (keys.Count > 0) _feed.Bump(keys, change.Instance.Id);
        }

        // Scanner thread: read the provider ids now (cheap), resolve and bump later.
        private void OnItemAdded(object? sender, ItemChangeEventArgs e)
        {
            if (e?.Item is { } item && _started && item is Movie or Series or Season or Episode) _recentlyAdded.Add(item.Id);
            Enqueue(e?.Item);
        }

        // An old primary can gain a new MediaSource. Announce its title as well as the metadata
        // updates that finish a recent arrival; Enqueue still coalesces them off the scanner thread.
        private void OnItemUpdated(object? sender, ItemChangeEventArgs e)
        {
            if (e?.Item is not { } item) return;
            if (!_recentlyAdded.IsRecent(item.Id) && !Acquire.Stamps.AcquisitionStampFlags.Badges(_config())) return;
            Enqueue(item);
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e) => Enqueue(e?.Item);

        private void Enqueue(BaseItem? item)
        {
            try
            {
                if (item == null || !_started || !ArrLiveFlags.Enabled(_config())) return;
                ItemChange? change = item switch
                {
                    Movie m => new ItemChange(true, m.GetProviderId(MetadataProvider.Tmdb), null, null, m.GetProviderId(MetadataProvider.Imdb), null, null),
                    Series s => new ItemChange(false, null, s.GetProviderId(MetadataProvider.Tvdb), s.GetProviderId(MetadataProvider.Tmdb), s.GetProviderId(MetadataProvider.Imdb), null, null),
                    Season season => new ItemChange(false, null, season.Series?.GetProviderId(MetadataProvider.Tvdb), season.Series?.GetProviderId(MetadataProvider.Tmdb), season.Series?.GetProviderId(MetadataProvider.Imdb), season.IndexNumber, null),
                    Episode ep => new ItemChange(false, null, ep.Series?.GetProviderId(MetadataProvider.Tvdb), ep.Series?.GetProviderId(MetadataProvider.Tmdb), ep.Series?.GetProviderId(MetadataProvider.Imdb), ep.ParentIndexNumber, ep.IndexNumber),
                    _ => null,
                };
                if (change == null) return;
                _items.Enqueue(change);
                if (Interlocked.CompareExchange(ref _itemFlushArmed, 1, 0) == 0) _itemTimer.Change(_itemFlushDelay, Timeout.InfiniteTimeSpan);
            }
            catch (Exception)
            {
                // Never disturb a library scan.
            }
        }

        /// <summary>Bumps the arr-known titles among the queued Jellyfin library changes.</summary>
        internal int FlushItems()
        {
            Interlocked.Exchange(ref _itemFlushArmed, 0);
            if (_recentlyAdded.Count > 500) _recentlyAdded.Prune();
            var leaves = new HashSet<string>(StringComparer.Ordinal);
            var libraries = _store.Registry.All().Where(c => c.Usable).Select(c => (c.Kind, Library: _store.PeekLibrary(c.Id))).Where(x => x.Library != null).ToList();
            while (_items.TryDequeue(out var item))
            {
                if (item.IsMovie)
                {
                    // A movie Jellyfin knows only by IMDb id is announced under its Radarr copy's TMDB id.
                    int? movieTmdb = int.TryParse(item.Tmdb, out var tmdb) && tmdb > 0 ? tmdb : null;
                    if (movieTmdb == null && !string.IsNullOrWhiteSpace(item.Imdb))
                    {
                        movieTmdb = libraries.Where(l => l.Kind == ArrKind.Radarr).Select(l => l.Library!.MovieByImdb(item.Imdb)?.TmdbId).FirstOrDefault(x => x is > 0);
                    }
                    if (movieTmdb is int mt && libraries.Any(l => l.Kind == ArrKind.Radarr && l.Library!.MovieByTmdb(mt) != null)) leaves.Add(ArrTitleKey.Movie(mt));
                    continue;
                }
                int? tvdb = int.TryParse(item.Tvdb, out var v) && v > 0 ? v : null;
                if (tvdb == null && int.TryParse(item.SeriesTmdb, out var st) && st > 0)
                {
                    tvdb = libraries.Where(l => l.Kind == ArrKind.Sonarr).Select(l => l.Library!.SeriesByTmdb(st)?.TvdbId).FirstOrDefault(x => x is > 0);
                }
                if (tvdb == null && !string.IsNullOrWhiteSpace(item.Imdb))
                {
                    tvdb = libraries.Where(l => l.Kind == ArrKind.Sonarr).Select(l => l.Library!.SeriesByImdb(item.Imdb)?.TvdbId).FirstOrDefault(x => x is > 0);
                }
                if (tvdb is not int t || !libraries.Any(l => l.Kind == ArrKind.Sonarr && l.Library!.SeriesByTvdb(t) != null)) continue;
                if (ArrChangeDetector.LeafKey(ArrKind.Sonarr, null, t, null, null, item.Season, item.Episode, null) is { } leaf) leaves.Add(leaf);
            }
            if (leaves.Count == 0 || !ArrLiveFlags.Enabled(_config())) return 0;
            return _feed.Bump(ArrChangeDetector.Expand(leaves));
        }

        private sealed record ItemChange(bool IsMovie, string? Tmdb, string? Tvdb, string? SeriesTmdb, string? Imdb, int? Season, int? Episode);
    }
}
