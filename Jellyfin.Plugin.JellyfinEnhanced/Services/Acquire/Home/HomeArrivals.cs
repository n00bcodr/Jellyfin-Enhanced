using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home
{
    /// <summary>
    /// When each piece of content first arrived in Jellyfin, so "Just arrived for you" can leave out upgrades. A piece
    /// of content is a movie (independent of edition) or an episode
    /// (<c>tv:tvdb:81189:s1:e5</c>), keyed from the Jellyfin item's own provider ids. The first date only ever moves
    /// earlier: a replacement file (a new item with a new creation date) keeps the date the content first came in.
    /// Kept in <c>acquire.db</c> (schema 6). Filled from the library once home rows are on (one background pass at
    /// start-up), then from library events, which only hand the item id to a background worker (no I/O on Jellyfin's
    /// scan thread). Content first seen while reading home rows is recorded then, at its own creation date.
    /// </summary>
    public sealed class HomeArrivals : IHostedService, IDisposable
    {
        /// <summary>Most items one seeding page reads.</summary>
        private const int SeedPage = 500;

        private readonly AcquireDatabase _db;
        private readonly AcquisitionStampStore _stamps;
        private readonly IStampLibrary? _sources;
        private readonly ILibraryManager? _library;
        private readonly Logger? _logger;
        private readonly Func<bool> _enabled;
        private readonly ConcurrentDictionary<string, long> _known = new(StringComparer.Ordinal);
        private readonly Channel<(Guid Id, DateTime At, long Generation)> _added = Channel.CreateBounded<(Guid Id, DateTime At, long Generation)>(new BoundedChannelOptions(4096) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
        private readonly CancellationTokenSource _stop = new();
        private long _loadedGeneration = -1;
        private long _loadedArrivalRevision = -1;
        private long _revision;
        private int _seeded;
        private Task? _worker;

        /// <summary>Creates the store (DI).</summary>
        /// <param name="db">The acquire database.</param>
        /// <param name="library">Jellyfin's library.</param>
        /// <param name="logger">Logger.</param>
        public HomeArrivals(AcquireDatabase db, ILibraryManager library, Logger logger, IStampLibrary? sources = null)
            : this(db, library, logger, () => HomeFlags.Rows(JellyfinEnhanced.Instance?.Configuration), sources)
        {
        }

        /// <summary>Creates the store with an explicit switch (tests).</summary>
        /// <param name="db">The acquire database.</param>
        /// <param name="library">Jellyfin's library (null: no seeding or events).</param>
        /// <param name="logger">Logger.</param>
        /// <param name="enabled">Whether home rows are on.</param>
        internal HomeArrivals(AcquireDatabase db, ILibraryManager? library, Logger? logger, Func<bool> enabled, IStampLibrary? sources = null)
        {
            _db = db;
            _stamps = new AcquisitionStampStore(db);
            _sources = sources;
            _library = library;
            _logger = logger;
            _enabled = enabled;
        }

        /// <summary>Changes whenever a first date was recorded or moved (part of the home rows' cache key).</summary>
        public long Revision => Interlocked.Read(ref _revision) + Interlocked.Read(ref _db.ArrivalRevision) + (_db.Generation * 1_000_000_007L);

        /// <summary>The authoritative first observation of a source, shared with acquisition badges.</summary>
        /// <param name="source">Stable source identity.</param>
        /// <returns>Arrival, or null until observed.</returns>
        public DateTime? SourceAt(string source) => _stamps.SourceArrival(source);

        /// <summary>An edition's arrival, separate from first content.</summary>
        /// <param name="content">Content key.</param>
        /// <param name="fourK">Requested edition.</param>
        /// <returns>Arrival, or null.</returns>
        public DateTime? EditionAt(string content, bool fourK)
        {
            var key = TitleKey.Parse(ContentArrivalHistory.ContentKey(content));
            if (key == null) return null;
            var part = key.IsMovie ? "m|" + key.Title : "e|" + key.Title + "|s" + key.Season + "e" + key.Episode;
            return _stamps.EditionArrival(new[] { part + (fourK ? "|4k" : "|std") });
        }

        /// <summary>The first-arrival date of a piece of content, or null when it was never recorded.</summary>
        /// <param name="content">Content key.</param>
        /// <returns>The UTC date, or null.</returns>
        public DateTime? FirstAt(string content)
        {
            Load();
            return _known.TryGetValue(ContentArrivalHistory.ContentKey(content), out var ms) ? DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime : null;
        }

        /// <summary>
        /// The first-arrival date of a piece of content, recording <paramref name="seen"/> (the item's own creation
        /// date) when nothing earlier is known. Returns the earlier of the two.
        /// </summary>
        /// <param name="content">Content key.</param>
        /// <param name="seen">When the copy seen now was created.</param>
        /// <returns>The first-arrival date.</returns>
        public DateTime FirstAtOrRecord(string content, DateTime seen)
        {
            var known = FirstAt(content);
            if (known is DateTime at && at <= seen) return at;
            Record(new[] { (content, seen) });
            // Another writer may have found an older copy while this one was being recorded.
            return FirstAt(content) is DateTime first && first < seen ? first : seen;
        }

        /// <summary>The content keys of a library item (a movie: its edition; an episode: each episode number it holds).</summary>
        /// <param name="item">The item.</param>
        /// <param name="seriesKey">The episode's series key (looked up when null).</param>
        /// <returns>The content keys (empty for anything else or an item without provider ids).</returns>
        public static IReadOnlyList<string> ContentOf(BaseItem item, TitleKey? seriesKey = null)
        {
            switch (item)
            {
                case Movie movie when !movie.IsVirtualItem:
                    return TitleKey.ForMovie(movie.GetProviderId(MetadataProvider.Tmdb), movie.GetProviderId(MetadataProvider.Imdb)) is { } key
                        ? new[] { MovieContent(key, IsFourK(movie)) }
                        : Array.Empty<string>();
                case Episode episode when !episode.IsVirtualItem && episode.IndexNumber is int first && episode.ParentIndexNumber is int season:
                    var series = seriesKey ?? SeriesKey(episode.Series);
                    if (series == null) return Array.Empty<string>();
                    var last = Math.Max(first, episode.IndexNumberEnd ?? first);
                    // A multi-episode file holds each of its numbers (bounded).
                    return Enumerable.Range(first, Math.Min(last - first + 1, 20)).Select(n => EpisodeContent(series, season, n)).ToList();
                default:
                    return Array.Empty<string>();
            }
        }

        /// <summary>A movie edition's content key.</summary>
        /// <param name="movie">The movie's key (from the Jellyfin item).</param>
        /// <param name="fourK">The copy is 4K.</param>
        /// <returns>The key.</returns>
        public static string MovieContent(TitleKey movie, bool fourK) => movie.Title + (fourK ? "|4k" : "|std");

        /// <summary>The same movie's other edition (<c>|std</c> ↔ <c>|4k</c>), or null for an episode.</summary>
        /// <param name="content">A content key.</param>
        /// <returns>The other edition's key, or null.</returns>
        public static string? OtherEdition(string content)
            => content.EndsWith("|std", StringComparison.Ordinal) ? content[..^4] + "|4k"
                : content.EndsWith("|4k", StringComparison.Ordinal) ? content[..^3] + "|std"
                : null;

        /// <summary>An episode's content key.</summary>
        /// <param name="series">The series key (from the Jellyfin item).</param>
        /// <param name="season">Season number.</param>
        /// <param name="episode">Episode number.</param>
        /// <returns>The key.</returns>
        public static string EpisodeContent(TitleKey series, int season, int episode) => series.Title.WithEpisode(season, episode).ToString();

        /// <summary>A series item's key from its own provider ids.</summary>
        /// <param name="series">The series item.</param>
        /// <returns>The key, or null.</returns>
        public static TitleKey? SeriesKey(BaseItem? series)
            => series == null ? null : TitleKey.ForSeries(series.GetProviderId(MetadataProvider.Tvdb), series.GetProviderId(MetadataProvider.Tmdb), series.GetProviderId(MetadataProvider.Imdb));

        /// <summary>A movie copy is 4K (its video is at least 3200 pixels wide or 2000 high), as list swap-in decides.</summary>
        /// <param name="item">The item.</param>
        /// <returns>Whether it is 4K.</returns>
        public static bool IsFourK(BaseItem item) => item.Width >= 3200 || item.Height >= 2000;

        /// <summary>Records first-arrival dates; each only ever moves earlier.</summary>
        /// <param name="seen">(content, creation date) pairs.</param>
        public void Record(IReadOnlyCollection<(string Content, DateTime At)> seen)
        {
            if (seen.Count == 0 || !_db.Available) return;
            var generation = _db.Generation;
            Load();
            seen = seen.Select(s => (ContentArrivalHistory.ContentKey(s.Content), s.At)).ToList();
            var changed = seen.Where(s => !_known.TryGetValue(s.Content, out var ms) || Ms(s.At) < ms).ToList();
            if (changed.Count == 0) return;
            try
            {
                var written = _db.WriteIf(generation, (c, t) =>
                {
                    foreach (var (content, at) in changed)
                    {
                        ContentArrivalHistory.Record(c, t, content, Ms(at));
                    }
                    return true;
                }, false);
                if (!written.Done) return;
            }
            catch (Exception ex)
            {
                _logger?.Warning("[Home] Could not record first arrivals: " + ex.Message);
                return;
            }
            Interlocked.Increment(ref _db.ArrivalRevision);
            foreach (var (content, at) in changed) _known.AddOrUpdate(content, Ms(at), (_, old) => Math.Min(old, Ms(at)));
            Interlocked.Increment(ref _revision);
        }

        /// <summary>Records every movie and episode in the library (once per start while home rows are on).</summary>
        /// <param name="ct">Cancellation.</param>
        /// <returns>How many pieces of content were seen.</returns>
        internal int Seed(CancellationToken ct)
        {
            if (_library == null || !_db.Available) return 0;
            var seen = 0;
            var series = new Dictionary<Guid, TitleKey?>();
            foreach (var kind in new[] { BaseItemKind.Movie, BaseItemKind.Episode })
            {
                for (var start = 0; !ct.IsCancellationRequested; start += SeedPage)
                {
                    var page = _library.GetItemList(new InternalItemsQuery
                    {
                        IncludeItemTypes = new[] { kind },
                        IsVirtualItem = false,
                        Recursive = true,
                        StartIndex = start,
                        Limit = SeedPage,
                        OrderBy = new[] { (ItemSortBy.DateCreated, JSortOrder.Ascending) },
                        DtoOptions = new DtoOptions(false),
                    });
                    var batch = new List<(string, DateTime)>();
                    foreach (var item in page)
                    {
                        TitleKey? key = null;
                        if (item is Episode episode)
                        {
                            if (!series.TryGetValue(episode.SeriesId, out key)) series[episode.SeriesId] = key = SeriesKey(episode.Series);
                            if (key == null) continue;
                        }
                        if (_sources?.Item(item.Id) is { } sourceItem)
                        {
                            var generation = _db.Generation;
                            _stamps.ObserveSources(new[] { sourceItem }, null, generation);
                            foreach (var source in sourceItem.SourceItems())
                            {
                                var at = source.SourceId is { } identity ? SourceAt(identity) : source.DateCreated;
                                if (at is not DateTime known || known == DateTime.MinValue) continue;
                                foreach (var content in ContentOf(item, key)) batch.Add((content, known));
                            }
                        }
                        else foreach (var content in ContentOf(item, key)) batch.Add((content, Utc(item.DateCreated)));
                    }
                    seen += batch.Count;
                    Record(batch);
                    if (page.Count < SeedPage) break;
                }
            }
            return seen;
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            if (_library == null) return Task.CompletedTask;
            _library.ItemAdded += OnItemChanged;
            _library.ItemUpdated += OnItemChanged;
            _worker = Task.Run(() => RunAsync(_stop.Token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            if (_library != null)
            {
                _library.ItemAdded -= OnItemChanged;
                _library.ItemUpdated -= OnItemChanged;
            }
            _stop.Cancel();
            if (_worker != null)
            {
                try
                {
                    await _worker.WaitAsync(cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    // Stopping.
                }
            }
        }

        /// <inheritdoc />
        public void Dispose() => _stop.Dispose();

        /// <summary>Seeds once home rows are on (also when they are turned on later).</summary>
        internal void EnsureSeeded()
        {
            if (_library == null || !_enabled() || Interlocked.Exchange(ref _seeded, 1) == 1) return;
            _ = Task.Run(() =>
            {
                try
                {
                    var count = Seed(_stop.Token);
                    _logger?.Info("[Home] First-arrival dates read from the library: " + count.ToString(CultureInfo.InvariantCulture) + " pieces of content.");
                }
                catch (Exception ex)
                {
                    Interlocked.Exchange(ref _seeded, 0);
                    _logger?.Warning("[Home] Reading first-arrival dates from the library failed: " + ex.Message);
                }
            });
        }

        // Library events fire on Jellyfin's scan thread: only the cheap kind check and a hand-off here.
        private void OnItemChanged(object? sender, ItemChangeEventArgs e)
        {
            if (e.Item is not (Movie or Episode) || !_enabled()) return;
            _added.Writer.TryWrite((e.Item.Id, DateTime.UtcNow, _db.Generation));
        }

        private async Task RunAsync(CancellationToken ct)
        {
            try
            {
                EnsureSeeded();
                while (await _added.Reader.WaitToReadAsync(ct).ConfigureAwait(false))
                {
                    var batch = new List<(string, DateTime)>();
                    var ids = new Dictionary<Guid, (DateTime At, long Generation)>();
                    while (ids.Count < 200 && _added.Reader.TryRead(out var change)) ids.TryAdd(change.Id, (change.At, change.Generation));
                    EnsureSeeded();
                    foreach (var (id, change) in ids)
                    {
                        if (_sources?.Item(id) is { } sourceItem) _stamps.ObserveSources(new[] { sourceItem }, change.At, change.Generation);
                        if (_library!.GetItemById(id) is not { } item) continue;
                        foreach (var content in ContentOf(item)) batch.Add((content, Utc(item.DateCreated)));
                    }
                    Record(batch);
                }
            }
            catch (OperationCanceledException)
            {
                // Stopping.
            }
            catch (Exception ex)
            {
                _logger?.Warning("[Home] First-arrival worker stopped: " + ex.Message);
            }
        }

        // The known dates, read once per database generation (a restore replaces them).
        private void Load()
        {
            var generation = _db.Generation;
            if ((Interlocked.Read(ref _loadedGeneration) == generation && Interlocked.Read(ref _loadedArrivalRevision) == Interlocked.Read(ref _db.ArrivalRevision)) || !_db.Available) return;
            lock (_known)
            {
                if (_loadedGeneration == generation && _loadedArrivalRevision == Interlocked.Read(ref _db.ArrivalRevision)) return;
                try
                {
                    var revision = Interlocked.Read(ref _db.ArrivalRevision);
                    var rows = _db.Read(c =>
                    {
                        var list = new List<(string, long)>();
                        using var cmd = NotifyStore.Command(c, null, "SELECT content,first_at FROM home_arrivals");
                        using var reader = cmd.ExecuteReader();
                        while (reader.Read()) list.Add((reader.GetString(0), reader.GetInt64(1)));
                        return list;
                    });
                    _known.Clear();
                    foreach (var (content, at) in rows) _known.AddOrUpdate(ContentArrivalHistory.ContentKey(content), at, (_, old) => Math.Min(old, at));
                    Interlocked.Exchange(ref _loadedArrivalRevision, revision);
                    Interlocked.Exchange(ref _loadedGeneration, generation);
                    Interlocked.Increment(ref _revision);
                }
                catch (Exception ex)
                {
                    _logger?.Warning("[Home] Could not read first arrivals: " + ex.Message);
                }
            }
        }

        private static long Ms(DateTime at) => new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

        private static DateTime Utc(DateTime at) => at.Kind == DateTimeKind.Local ? at.ToUniversalTime() : DateTime.SpecifyKind(at, DateTimeKind.Utc);
    }
}
