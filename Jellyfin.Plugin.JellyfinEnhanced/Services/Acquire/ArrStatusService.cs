using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// Serves title statuses to the status routes: resolves the Jellyfin items for the viewer, reads
    /// the arr snapshots from memory (never calling an arr on the request; a cold snapshot is loaded
    /// in the background and waited for, bounded), composes per viewer and caches the serialized body
    /// per user. Phase 1 of "Requests &amp; downloads".
    /// </summary>
    public sealed class ArrStatusService
    {
        /// <summary>Most Jellyfin item ids per batch request.</summary>
        public const int MaxIds = 100;

        /// <summary>Most title keys per batch request.</summary>
        public const int MaxKeys = 50;

        private static readonly TimeSpan TimeBucket = TimeSpan.FromMinutes(10);

        private static readonly JsonSerializerOptions Json = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        private static readonly ConditionalWeakTable<ArrQueueSnapshot, ILookup<int, ArrQueueEntry>> QueueIndex = new();
        private static readonly ConditionalWeakTable<ArrHistorySnapshot, ILookup<int, ArrHistoryEntry>> HistoryIndex = new();

        private readonly ArrStateStore _store;
        private readonly IArrJellyfinView _view;
        private readonly IArrRequestFacts _requests;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>The service for a Jellyfin installation (DI).</summary>
        public ArrStatusService(ArrStateStore store, IArrJellyfinView view, IArrRequestFacts requests)
            : this(store, view, requests, null, null)
        {
        }

        /// <summary>A service with explicit configuration and clock (tests).</summary>
        internal ArrStatusService(ArrStateStore store, IArrJellyfinView view, IArrRequestFacts requests, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now)
        {
            _store = store;
            _view = view;
            _requests = requests;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>The per-user body cache.</summary>
        public ArrStatusCache Cache { get; } = new();

        /// <summary>The arr state store (for the request counter).</summary>
        public ArrStateStore Store => _store;

        /// <summary>The Jellyfin view.</summary>
        public IArrJellyfinView View => _view;

        /// <summary>True when "Requests &amp; downloads" and its phase 1 (status on pages) are both on.</summary>
        public bool Enabled => _config() is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true };

        /// <summary>
        /// Statuses for poster cards and other compact surfaces: Jellyfin items by id (items the viewer
        /// cannot see are left out) and titles by key (movie and series keys).
        /// </summary>
        public async Task<StatusBody> ForBatchAsync(StatusViewer viewer, IReadOnlyList<Guid> ids, IReadOnlyList<TitleKey> keys, CancellationToken cancellationToken)
        {
            var items = new List<JfItemRef>();
            foreach (var id in ids.Distinct())
            {
                if (_view.Resolve(id, viewer) is { Key: not null } item) items.Add(item);
            }
            var titleKeys = keys.Where(k => !k.Season.HasValue).Distinct().ToList();
            var gather = await GatherAsync(items.Select(i => i.Key!.Title).Concat(titleKeys), loadEpisodes: null, peekEpisodes: items.Where(i => i.Kind is "season" or "episode").Select(i => i.Key!.Title), cancellationToken).ConfigureAwait(false);

            var cacheKey = CacheKey(viewer, "batch", string.Join(",", items.Select(i => i.ItemId.ToString("N", CultureInfo.InvariantCulture)).OrderBy(x => x, StringComparer.Ordinal))
                + "|" + string.Join(",", titleKeys.Select(k => k.ToString()).OrderBy(x => x, StringComparer.Ordinal)), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;

            ApplyRequests(gather, viewer);
            var c = Context(viewer);
            var statuses = new List<TitleStatus>();
            var seriesEpisodes = new Dictionary<Guid, IReadOnlyList<JfEpisode>>();
            foreach (var item in items)
            {
                var facts = gather.Facts[item.Key!.Title];
                switch (item.Kind)
                {
                    case "movie":
                        statuses.Add(StatusComposer.Movie(facts, item, null, c, detail: false));
                        break;
                    case "series":
                        statuses.Add(StatusComposer.SeriesCard(facts, item, c, HiddenFromViewer(facts, item.ItemId, viewer)));
                        break;
                    case "season":
                        if (item.SeriesId is not Guid seriesId) break;
                        if (!seriesEpisodes.TryGetValue(seriesId, out var jf))
                        {
                            jf = _view.Episodes(seriesId, null, viewer, includeVirtual: false);
                            seriesEpisodes[seriesId] = jf;
                        }
                        statuses.Add(StatusComposer.Season(facts, item, jf, c, detail: false));
                        break;
                    case "episode":
                        statuses.Add(StatusComposer.Episode(facts, item, c, detail: false));
                        break;
                }
            }
            foreach (var key in titleKeys)
            {
                var facts = gather.Facts[key];
                var copies = _view.Copies(key, viewer);
                // A viewer with parental limits learns nothing about titles they can't open here:
                // their rating isn't known until the title is in Jellyfin. Anyone else who can't open
                // any copy gets exactly the answer of a title nobody has (the composer sees to it).
                if (!viewer.IsAdmin && viewer.HasParentalLimit && !copies.Any(x => x.Visible)) continue;
                statuses.Add(key.IsMovie
                    ? StatusComposer.Movie(facts, null, copies, c, detail: false)
                    : StatusComposer.SeriesByKey(facts, copies, c, copies.FirstOrDefault(x => x.Visible) is { } shown ? HiddenFromViewer(facts, shown.ItemId, viewer) : null));
            }
            return Cache.Put(cacheKey, Serialize(statuses));
        }

        /// <summary>
        /// The full status of one Jellyfin item for its details page (journey, seasons or episodes).
        /// No statuses (an empty list) when the viewer can't see the item, it is not a movie, series,
        /// season or episode, or it has no provider id: one quiet, cacheable answer for all three, so a
        /// details page of a person, collection or album costs one cheap request and no error.
        /// </summary>
        public async Task<StatusBody> ForItemAsync(StatusViewer viewer, Guid itemId, CancellationToken cancellationToken)
        {
            if (_view.Resolve(itemId, viewer) is not { Key: not null } item)
            {
                var none = CacheKey(viewer, "item", itemId.ToString("N", CultureInfo.InvariantCulture), "none");
                return Cache.Get(none) ?? Cache.Put(none, Serialize(Array.Empty<TitleStatus>()));
            }
            var title = item.Key.Title;
            var episodes = item.Kind is "series" or "season" or "episode" ? new[] { title } : Array.Empty<TitleKey>();
            var gather = await GatherAsync(new[] { title }, loadEpisodes: episodes, peekEpisodes: null, cancellationToken).ConfigureAwait(false);
            var cacheKey = CacheKey(viewer, "item", item.ItemId.ToString("N", CultureInfo.InvariantCulture), gather.Revision);
            if (Cache.Get(cacheKey) is { } hit) return hit;

            ApplyRequests(gather, viewer);
            var c = Context(viewer);
            var facts = gather.Facts[title];
            // Admins see every Sonarr holding a series; its Jellyfin copies tell which are in the library.
            var seriesCopies = viewer.IsAdmin && item.Kind != "movie" && facts.Copies.Count(x => x.Series != null) > 1 ? _view.Copies(title, viewer) : null;
            TitleStatus status;
            switch (item.Kind)
            {
                case "movie":
                    status = StatusComposer.Movie(facts, item, _view.Copies(title, viewer), c, detail: true);
                    break;
                case "series":
                    status = StatusComposer.Series(facts, item, _view.Episodes(item.ItemId, null, viewer, includeVirtual: false), _view.Seasons(item.ItemId, viewer), c, detail: true, seriesCopies);
                    break;
                case "season":
                    status = StatusComposer.Season(facts, item, item.SeriesId is Guid sid ? _view.Episodes(sid, item.Season, viewer, includeVirtual: viewer.DisplayMissingEpisodes) : Array.Empty<JfEpisode>(), c, detail: true, seriesCopies);
                    break;
                default:
                    status = StatusComposer.Episode(facts, item, c, detail: true, seriesCopies);
                    break;
            }
            return Cache.Put(cacheKey, Serialize(new[] { status }));
        }

        /// <summary>
        /// For a viewer with parental limits, the episodes and seasons of a series Jellyfin hides from
        /// them, so the queue-only surfaces (series cards, series keys) don't count their downloads.
        /// Read only when a Sonarr copy of the series has queue rows (a few series per page); null otherwise.
        /// </summary>
        private HiddenParts? HiddenFromViewer(TitleFacts facts, Guid seriesItemId, StatusViewer viewer)
        {
            if (viewer.IsAdmin || !viewer.HasParentalLimit || !facts.Copies.Any(x => x.Series != null && x.Queue.Count > 0)) return null;
            return StatusComposer.SplitHidden(_view.Episodes(seriesItemId, null, viewer, includeVirtual: false), _view.Seasons(seriesItemId, viewer)).Hidden;
        }

        private void ApplyRequests(Gathered gathered, StatusViewer viewer)
        {
            foreach (var (key, facts) in gathered.Facts) facts.Request = _requests.For(key, viewer);
        }

        private ComposeContext Context(StatusViewer viewer)
            => new(viewer, _now().UtcDateTime, _config()?.ArrStatusLookingHours ?? 24);

        private byte[] Serialize(IReadOnlyList<TitleStatus> statuses)
        {
            var config = _config();
            return JsonSerializer.SerializeToUtf8Bytes(new StatusResponse
            {
                Contact = (config?.ArrHouseholdContactName ?? string.Empty).Trim() is { Length: <= 40 } name ? name : string.Empty,
                LookingHours = Math.Clamp(config?.ArrStatusLookingHours ?? 24, 1, 720),
                Items = statuses,
            }, Json);
        }

        /// <summary>
        /// The per-user cache key: user, policy revision, what was asked, the arr facts revision, the
        /// Jellyfin library revision, the request facts revision, the settings that change texts and a
        /// ten-minute time bucket (for time-based wording such as "Still looking").
        /// </summary>
        private string CacheKey(StatusViewer viewer, string route, string what, string factsRevision)
        {
            var config = _config();
            var bucket = _now().UtcTicks / TimeBucket.Ticks;
            var raw = string.Join(
                "|",
                viewer.UserId.ToString("N", CultureInfo.InvariantCulture),
                viewer.PolicyRevision,
                route,
                what,
                factsRevision,
                _view.Revision.ToString(CultureInfo.InvariantCulture),
                _requests.Revision.ToString(CultureInfo.InvariantCulture),
                (config?.ArrHouseholdContactName ?? string.Empty) + "#" + (config?.ArrStatusLookingHours ?? 24).ToString(CultureInfo.InvariantCulture),
                bucket.ToString(CultureInfo.InvariantCulture));
            // Hashed so the key's size does not grow with the request; the user id stays readable as the prefix.
            return viewer.UserId.ToString("N", CultureInfo.InvariantCulture) + ":" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
        }

        private sealed class Gathered
        {
            public Dictionary<TitleKey, TitleFacts> Facts { get; } = new();

            public string Revision { get; set; } = string.Empty;
        }

        /// <summary>
        /// Reads every snapshot the titles need (library, queue, history per instance of each kind
        /// needed; episodes of the series in <paramref name="loadEpisodes"/>, or only those already in
        /// memory for <paramref name="peekEpisodes"/>) and builds the facts plus their revision.
        /// </summary>
        private async Task<Gathered> GatherAsync(IEnumerable<TitleKey> titles, IEnumerable<TitleKey>? loadEpisodes, IEnumerable<TitleKey>? peekEpisodes, CancellationToken ct)
        {
            var result = new Gathered();
            var distinct = titles.Distinct().ToList();
            foreach (var t in distinct) result.Facts[t] = new TitleFacts(t);
            var revision = new StringBuilder();
            var kinds = new List<ArrKind>();
            if (distinct.Any(t => t.IsMovie)) kinds.Add(ArrKind.Radarr);
            if (distinct.Any(t => !t.IsMovie)) kinds.Add(ArrKind.Sonarr);
            var load = new HashSet<TitleKey>(loadEpisodes ?? Array.Empty<TitleKey>());
            var peek = new HashSet<TitleKey>(peekEpisodes ?? Array.Empty<TitleKey>());

            foreach (var kind in kinds)
            {
                var instances = _store.Instances(kind);
                var reads = await Task.WhenAll(instances.Select(async i => (
                    Instance: i,
                    Library: await _store.GetLibraryAsync(i, ct).ConfigureAwait(false),
                    Queue: await _store.GetQueueAsync(i, ct).ConfigureAwait(false),
                    History: await _store.GetHistoryAsync(i, ct).ConfigureAwait(false)))).ConfigureAwait(false);
                foreach (var (instance, library, queue, history) in reads)
                {
                    revision.Append(instance.Id).Append(':').Append(instance.Name).Append(':').Append(instance.Role)
                        .Append(':').Append(string.Join(",", instance.LinkedLibraryIds))
                        .Append(':').Append(string.Join(",", instance.PathMappings.Select(m => m.ArrPath + ">" + m.JellyfinPath)))
                        .Append(':').Append(Stamp(library.LoadedAt)).Append(library.Error?.Kind.ToString() ?? string.Empty)
                        .Append(':').Append(Stamp(queue.LoadedAt)).Append(':').Append(Stamp(history.LoadedAt)).Append(';');
                    var queueIndex = queue.Value != null ? QueueIndex.GetValue(queue.Value, q => q.Records.Where(r => (kind == ArrKind.Radarr ? r.MovieId : r.SeriesId).HasValue).ToLookup(r => (kind == ArrKind.Radarr ? r.MovieId : r.SeriesId)!.Value)) : null;
                    var historyIndex = history.Value != null ? HistoryIndex.GetValue(history.Value, h => h.Records.Where(r => (kind == ArrKind.Radarr ? r.MovieId : r.SeriesId).HasValue).ToLookup(r => (kind == ArrKind.Radarr ? r.MovieId : r.SeriesId)!.Value)) : null;

                    foreach (var title in distinct.Where(t => t.IsMovie == (kind == ArrKind.Radarr)))
                    {
                        var facts = result.Facts[title];
                        if (library.Value == null)
                        {
                            facts.Unreadable.Add(instance.Name + " (" + (library.Error?.Kind.ToString() ?? "loading") + ")");
                            continue;
                        }
                        if (kind == ArrKind.Radarr)
                        {
                            var movie = title.Provider == "tmdb" && title.NumericId is int tmdb ? library.Value.MovieByTmdb(tmdb) : library.Value.MovieByImdb(title.Id);
                            if (movie == null) continue;
                            facts.Copies.Add(new ArrCopyFacts(instance)
                            {
                                Movie = movie,
                                LibraryLoadedAt = library.LoadedAt?.UtcDateTime,
                                LeftQueue = (m, e) => _store.LeftQueueAt(instance, m, e)?.UtcDateTime,
                                Queue = queueIndex?[movie.Id].ToList() ?? new List<ArrQueueEntry>(),
                                History = historyIndex?[movie.Id].ToList() ?? new List<ArrHistoryEntry>(),
                            });
                        }
                        else
                        {
                            var series = title.Provider switch
                            {
                                "tvdb" when title.NumericId is int tvdb => library.Value.SeriesByTvdb(tvdb),
                                "tmdb" when title.NumericId is int tmdb => library.Value.SeriesByTmdb(tmdb),
                                "imdb" => library.Value.SeriesByImdb(title.Id),
                                _ => null,
                            };
                            if (series == null) continue;
                            ArrSnapshotRead<ArrEpisodesSnapshot>? episodes = null;
                            if (load.Contains(title)) episodes = await _store.GetEpisodesAsync(instance, series.Id, ct).ConfigureAwait(false);
                            else if (peek.Contains(title)) episodes = _store.PeekEpisodes(instance, series.Id);
                            if (episodes != null) revision.Append('e').Append(series.Id).Append(':').Append(Stamp(episodes.LoadedAt)).Append(';');
                            facts.Copies.Add(new ArrCopyFacts(instance)
                            {
                                Series = series,
                                Queue = queueIndex?[series.Id].ToList() ?? new List<ArrQueueEntry>(),
                                History = historyIndex?[series.Id].ToList() ?? new List<ArrHistoryEntry>(),
                                Episodes = episodes?.Value,
                                LibraryLoadedAt = library.LoadedAt?.UtcDateTime,
                                EpisodesLoadedAt = episodes?.LoadedAt?.UtcDateTime,
                                LeftQueue = (m, e) => _store.LeftQueueAt(instance, m, e)?.UtcDateTime,
                            });
                        }
                    }
                }
            }
            result.Revision = revision.ToString();
            return result;
        }

        private static string Stamp(DateTimeOffset? at) => at?.UtcTicks.ToString(CultureInfo.InvariantCulture) ?? "-";
    }
}
