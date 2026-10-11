using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>A season/episode coordinate.</summary>
    /// <param name="S">Season number.</param>
    /// <param name="E">Episode number.</param>
    public readonly record struct EpisodeCoord(int S, int E) : IComparable<EpisodeCoord>
    {
        /// <inheritdoc />
        public int CompareTo(EpisodeCoord other) => S != other.S ? S.CompareTo(other.S) : E.CompareTo(other.E);
    }

    /// <summary>A library item a scope resolved to, with the coordinates it covers inside that scope (TV only).</summary>
    /// <param name="ItemId">Library item.</param>
    /// <param name="Kind">Its kind (Movie, Series, Season or Episode).</param>
    /// <param name="Coords">
    /// Episode coordinates it covers inside the scope (episodes: a multi-episode file covers several; a collection's
    /// Season item: the present episodes credited to it).
    /// </param>
    public sealed record ResolvedItem(Guid ItemId, BaseItemKind Kind, IReadOnlyList<EpisodeCoord> Coords);

    /// <summary>What a placeholder's scope currently is in the library (see <see cref="ListPlaceholderResolver"/>).</summary>
    public sealed class ScopeResolution
    {
        /// <summary>Nothing found.</summary>
        public static readonly ScopeResolution None = new(Array.Empty<ResolvedItem>(), Array.Empty<ResolvedItem>());

        /// <summary>Creates a resolution.</summary>
        /// <param name="items">Items to put into the list, in list order.</param>
        /// <param name="episodes">Present episodes inside the scope, sorted (fill progress).</param>
        public ScopeResolution(IReadOnlyList<ResolvedItem> items, IReadOnlyList<ResolvedItem> episodes)
        {
            Items = items;
            Episodes = episodes;
        }

        /// <summary>
        /// The items that represent the scope in the list, in order: playlists only ever get Movie/Episode ids
        /// (episodes sorted by season/episode); collections get the Movie, Series, Season or Episode items.
        /// </summary>
        public IReadOnlyList<ResolvedItem> Items { get; }

        /// <summary>
        /// TV scopes: the present episodes inside the scope, sorted by coordinate (what counts as filled; a collection
        /// season with Season items: only the episodes credited to those items).
        /// </summary>
        public IReadOnlyList<ResolvedItem> Episodes { get; }

        /// <summary>True when anything of the scope is in the library.</summary>
        public bool Found => Items.Count > 0;
    }

    /// <summary>
    /// Fill progress and the completion rule of placeholders (design §9, C3). Pure functions over a placeholder.
    /// <list type="bullet">
    /// <item>episodes: complete when every listed episode is filled.</item>
    /// <item>season: the EXPECTED episodes (Seerr season details, incl. an announced next episode) must all be filled
    /// and the season must be finished: every expected episode has aired, or the show has Ended/been Canceled
    /// (<see cref="Placeholder.InProduction"/> false; then only the aired ones are required, plus undated ones numbered
    /// before an aired one: a gap in TMDB's data, not an episode that never aired).</item>
    /// <item>series: the show has Ended/been Canceled and every aired expected episode (seasons ≥ 1) is filled.</item>
    /// <item>Unknown metadata (no expected set, unknown production state) never completes: the placeholder stays.</item>
    /// </list>
    /// </summary>
    public static class PlaceholderProgress
    {
        /// <summary>Most expected episodes stored per placeholder; a longer show never auto-completes.</summary>
        public const int MaxExpected = 1000;

        /// <summary>Whether an episode coordinate belongs to a TV placeholder's scope.</summary>
        /// <param name="placeholder">Placeholder (series, season or episodes).</param>
        /// <param name="coord">Coordinate.</param>
        /// <returns>Whether it is inside the scope.</returns>
        public static bool InScope(Placeholder placeholder, EpisodeCoord coord) => placeholder.Kind switch
        {
            PlaceholderKinds.Series => coord.S >= 1,
            PlaceholderKinds.Season => coord.S == placeholder.SeasonNumber,
            PlaceholderKinds.Episodes => coord.S == placeholder.SeasonNumber && placeholder.Episodes.Any(e => e.S == coord.S && e.E == coord.E),
            _ => false,
        };

        /// <summary>True for the kinds that fill episode by episode (series, season, episodes).</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <returns>Whether it is a TV fill kind.</returns>
        public static bool IsEpisodeFill(Placeholder placeholder) =>
            placeholder.Kind is PlaceholderKinds.Series or PlaceholderKinds.Season or PlaceholderKinds.Episodes;

        /// <summary>The coordinates already filled.</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <returns>Filled coordinates.</returns>
        public static HashSet<EpisodeCoord> FilledCoords(Placeholder placeholder) =>
            placeholder.Filled.Select(f => new EpisodeCoord(f.S, f.E)).ToHashSet();

        /// <summary>The number of episodes the placeholder stands for ("m" of "n of m"): listed episodes, else the expected set.</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <returns>The count (0 = unknown).</returns>
        public static int ExpectedCount(Placeholder placeholder) => placeholder.Kind switch
        {
            PlaceholderKinds.Episodes => placeholder.Episodes.Count,
            PlaceholderKinds.Season or PlaceholderKinds.Series => placeholder.Expected.Count,
            _ => 0,
        };

        /// <summary>How many of those episodes have aired by <paramref name="todayUtc"/> (listed/expected with an air date ≤ today).</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <returns>The aired count.</returns>
        public static int AiredCount(Placeholder placeholder, DateTime todayUtc)
        {
            var source = placeholder.Kind == PlaceholderKinds.Episodes ? placeholder.Episodes : placeholder.Expected;
            return source.Count(e => IsAired(e, todayUtc));
        }

        /// <summary>How many filled episodes are inside the scope.</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <returns>The filled count.</returns>
        public static int FilledInScope(Placeholder placeholder) => FilledCoords(placeholder).Count(c => InScope(placeholder, c));

        /// <summary>Whether an episode has an air date on or before today.</summary>
        /// <param name="episode">Episode.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <returns>Whether it aired.</returns>
        public static bool IsAired(PlaceholderEpisode episode, DateTime todayUtc) =>
            episode.AirDate != null && PlaceholderRules.TryParseDate(episode.AirDate, out var date) && date.Date <= todayUtc.Date;

        /// <summary>
        /// True when a season/series placeholder has filled episodes its expected set doesn't list as aired: the episode
        /// is in the library, so the stored metadata is out of date (or uses another episode numbering).
        /// </summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <returns>Whether the metadata looks stale.</returns>
        public static bool HasUnexpectedFills(Placeholder placeholder, DateTime todayUtc)
        {
            if (placeholder.Kind is not (PlaceholderKinds.Season or PlaceholderKinds.Series) || placeholder.Filled.Count == 0)
            {
                return false;
            }

            var aired = placeholder.Expected.Where(e => IsAired(e, todayUtc)).Select(e => new EpisodeCoord(e.S, e.E)).ToHashSet();
            return placeholder.Filled.Any(f => !aired.Contains(new EpisodeCoord(f.S, f.E)));
        }

        /// <summary>The completion rule (see the class remarks). Movies and custom entries never "complete" here.</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <returns>Whether the placeholder can be retired.</returns>
        public static bool IsComplete(Placeholder placeholder, DateTime todayUtc)
        {
            var filled = FilledCoords(placeholder);
            switch (placeholder.Kind)
            {
                case PlaceholderKinds.Episodes:
                    return placeholder.Episodes.Count > 0 && placeholder.Episodes.All(e => filled.Contains(new EpisodeCoord(e.S, e.E)));
                case PlaceholderKinds.Season:
                {
                    if (placeholder.Expected.Count == 0 || placeholder.Expected.Count >= MaxExpected || placeholder.InProduction == null)
                    {
                        return false;
                    }

                    var allAired = placeholder.Expected.All(e => IsAired(e, todayUtc));
                    var finished = allAired || placeholder.InProduction == false;
                    var lastAired = placeholder.Expected.Where(e => IsAired(e, todayUtc)).Select(e => e.E).DefaultIfEmpty(0).Max();
                    var required = placeholder.InProduction == false
                        ? placeholder.Expected.Where(e => IsAired(e, todayUtc) || (e.AirDate == null && e.E < lastAired)).ToList()
                        : placeholder.Expected;
                    return finished && required.Count > 0 && required.All(e => filled.Contains(new EpisodeCoord(e.S, e.E)));
                }

                case PlaceholderKinds.Series:
                {
                    if (placeholder.InProduction != false || placeholder.Expected.Count == 0 || placeholder.Expected.Count >= MaxExpected)
                    {
                        return false;
                    }

                    var required = placeholder.Expected.Where(e => e.S >= 1 && IsAired(e, todayUtc)).ToList();
                    return required.Count > 0 && required.All(e => filled.Contains(new EpisodeCoord(e.S, e.E)));
                }

                default:
                    return false;
            }
        }

        /// <summary>
        /// The first episode, in episode order, that a TV placeholder still stands for: a listed (episodes) or expected
        /// (season; series: seasons ≥ 1) episode that isn't filled. Without an expected set, the season's episode count
        /// (1..<see cref="Placeholder.EpisodeTotal"/>) or, failing that, the gaps below the filled episodes count (episode
        /// and season numbers start at 1). Null when nothing is missing before or between the filled episodes.
        /// </summary>
        /// <param name="placeholder">Placeholder (series, season or episodes).</param>
        /// <returns>The coordinate, or null.</returns>
        public static EpisodeCoord? FirstMissing(Placeholder placeholder)
        {
            var filled = FilledCoords(placeholder).Where(c => InScope(placeholder, c)).ToHashSet();
            IEnumerable<EpisodeCoord> wanted;
            switch (placeholder.Kind)
            {
                case PlaceholderKinds.Episodes:
                    wanted = placeholder.Episodes.Select(e => new EpisodeCoord(e.S, e.E));
                    break;
                case PlaceholderKinds.Season when placeholder.SeasonNumber is int season:
                    var lastFilled = filled.Select(c => c.E).DefaultIfEmpty(0).Max();
                    var count = placeholder.EpisodeTotal is > 0 and <= MaxExpected ? placeholder.EpisodeTotal.Value : lastFilled;
                    wanted = placeholder.Expected.Count > 0
                        ? placeholder.Expected.Where(e => e.S == season).Select(e => new EpisodeCoord(e.S, e.E))
                        : Enumerable.Range(1, Math.Max(0, count)).Select(e => new EpisodeCoord(season, e));
                    break;
                case PlaceholderKinds.Series:
                    wanted = placeholder.Expected.Count > 0
                        ? placeholder.Expected.Where(e => e.S >= 1).Select(e => new EpisodeCoord(e.S, e.E))
                        : filled.Select(c => c.S).DefaultIfEmpty(0).Max() is var lastSeason and > 0
                            ? Enumerable.Range(1, lastSeason).SelectMany(s => Enumerable.Range(1, Math.Max(1, filled.Where(c => c.S == s).Select(c => c.E).DefaultIfEmpty(0).Max())).Select(e => new EpisodeCoord(s, e)))
                            : Enumerable.Empty<EpisodeCoord>();
                    break;
                default:
                    return null;
            }

            return wanted.Where(c => !filled.Contains(c)).OrderBy(c => c).Select(c => (EpisodeCoord?)c).FirstOrDefault();
        }

        /// <summary>The coordinates of an episode file inside a placeholder's scope.</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="season">Season.</param>
        /// <param name="episode">First episode.</param>
        /// <param name="episodeEnd">Last episode of a multi-episode file, or null.</param>
        /// <returns>The in-scope coordinates (empty when none).</returns>
        public static List<EpisodeCoord> CoordsInScope(Placeholder placeholder, int season, int episode, int? episodeEnd)
        {
            var result = new List<EpisodeCoord>();
            var last = episodeEnd is int end && end >= episode && end - episode < 100 ? end : episode;
            for (var e = episode; e <= last; e++)
            {
                var coord = new EpisodeCoord(season, e);
                if (InScope(placeholder, coord))
                {
                    result.Add(coord);
                }
            }

            return result;
        }
    }

    /// <summary>
    /// Library query results shared by the resolutions of one operation (<see cref="ListPlaceholderResolver.Resolve"/>):
    /// series, episodes and movies by their lookup keys. Single-threaded, short-lived.
    /// </summary>
    public sealed class ResolveMemo
    {
        internal Dictionary<(int? Tmdb, string? Imdb, Guid? User), IReadOnlyList<Guid>> Movies { get; } = new();

        internal Dictionary<(int? Tmdb, int? Tvdb, string? Imdb, Guid? User), IReadOnlyList<Guid>> Series { get; } = new();

        internal Dictionary<(Guid Series, int? Season, Guid? User), IReadOnlyList<LibraryEpisode>> Episodes { get; } = new();
    }

    /// <summary>
    /// The granularity-aware library resolver (design C1). For a placeholder's scope — movie, whole series, season n or
    /// episodes of season n — it returns the library items that represent it in a list plus the present episodes, as seen
    /// by every given user (all must be able to access an item; playlists pass the caller and the owner, swap-in the
    /// owner, collection swap-in nobody = the whole library).
    /// <para>
    /// Contract (also used by POST /resolve and the list-source sync of later phases): matching is by the placeholder's
    /// TMDB id, then TVDB / IMDb ids (TV: the SERIES' ids; an episode's own TMDB id is never used); episodes match by
    /// <c>ParentIndexNumber</c>/<c>IndexNumber</c> (+<c>IndexNumberEnd</c>); virtual "missing" items never count.
    /// Playlists only ever get Movie/Episode ids (series/season scopes expand to their episodes, sorted, specials
    /// excluded from whole-series scopes); collections get the Movie, Series, Season (only once a real episode of it
    /// exists; a collection season's episodes count only through the Season item of the show copy they belong to) or
    /// Episode items. The resolver never mutates anything.
    /// </para>
    /// </summary>
    public sealed class ListPlaceholderResolver
    {
        private readonly IListPlaceholderHost _host;
        private readonly Logger _logger;

        /// <summary>Creates the resolver.</summary>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholderResolver(IListPlaceholderHost host, Logger logger)
        {
            _host = host;
            _logger = logger;
        }

        /// <summary>Resolves a placeholder's scope against the library (see the class remarks).</summary>
        /// <param name="scope">The placeholder (or link data) describing the scope; custom entries resolve to nothing.</param>
        /// <param name="listKind"><see cref="ListKinds.Playlist"/> or <see cref="ListKinds.Collection"/>.</param>
        /// <param name="users">Users that must all be able to access every returned item (empty = no user scope).</param>
        /// <param name="memo">
        /// Optional memo of the library queries, shared by the resolutions of ONE operation (an import of hundreds of
        /// episodes of a few shows looks each show up once). Never keep it beyond that operation: it doesn't see library
        /// changes.
        /// </param>
        /// <returns>The resolution (never null; <see cref="ScopeResolution.None"/> on lookup failures).</returns>
        public ScopeResolution Resolve(Placeholder scope, string listKind, IReadOnlyList<User> users, ResolveMemo? memo = null)
        {
            ArgumentNullException.ThrowIfNull(scope);
            if (scope.Kind == PlaceholderKinds.Custom)
            {
                return ScopeResolution.None;
            }

            try
            {
                return scope.Kind == PlaceholderKinds.Movie
                    ? ResolveMovie(scope, users, memo)
                    : ResolveTv(scope, listKind == ListKinds.Collection, users, memo);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ListPlaceholders] Library lookup for \"{scope.Title}\" failed: {ex.Message}");
                return ScopeResolution.None;
            }
        }

        private ScopeResolution ResolveMovie(Placeholder scope, IReadOnlyList<User> users, ResolveMemo? memo)
        {
            if (scope.TmdbId is not > 0 && string.IsNullOrEmpty(scope.ImdbId))
            {
                return ScopeResolution.None;
            }

            var primary = users.Count > 0 ? users[0] : null;
            var movies = memo == null
                ? _host.FindMovies(scope.TmdbId, scope.ImdbId, primary)
                : Memoized(memo.Movies, (scope.TmdbId, scope.ImdbId, primary?.Id), () => _host.FindMovies(scope.TmdbId, scope.ImdbId, primary));
            foreach (var id in movies)
            {
                if (AccessibleToRest(id, users))
                {
                    return new ScopeResolution(new[] { new ResolvedItem(id, BaseItemKind.Movie, Array.Empty<EpisodeCoord>()) }, Array.Empty<ResolvedItem>());
                }
            }

            return ScopeResolution.None;
        }

        private ScopeResolution ResolveTv(Placeholder scope, bool collection, IReadOnlyList<User> users, ResolveMemo? memo)
        {
            if (scope.TmdbId is not > 0 && scope.TvdbId is not > 0 && string.IsNullOrEmpty(scope.ImdbId))
            {
                return ScopeResolution.None;
            }

            var primary = users.Count > 0 ? users[0] : null;
            var found = memo == null
                ? _host.FindSeries(scope.TmdbId, scope.TvdbId, scope.ImdbId, primary)
                : Memoized(memo.Series, (scope.TmdbId, scope.TvdbId, scope.ImdbId, primary?.Id), () => _host.FindSeries(scope.TmdbId, scope.TvdbId, scope.ImdbId, primary));
            var seriesIds = found.Where(id => AccessibleToRest(id, users)).ToList();
            if (seriesIds.Count == 0)
            {
                return ScopeResolution.None;
            }

            if (collection && scope.Kind == PlaceholderKinds.Series)
            {
                return new ScopeResolution(new[] { new ResolvedItem(seriesIds[0], BaseItemKind.Series, Array.Empty<EpisodeCoord>()) }, Array.Empty<ResolvedItem>());
            }

            // The present in-scope episodes of each copy of the show (one per library), in season/episode order.
            var season = scope.Kind == PlaceholderKinds.Series ? (int?)null : scope.SeasonNumber;
            var copies = new List<(Guid SeriesId, List<ResolvedItem> Episodes)>();
            foreach (var seriesId in seriesIds)
            {
                var own = new List<ResolvedItem>();
                var ownCovered = new HashSet<EpisodeCoord>();
                var library = memo == null
                    ? _host.GetEpisodes(seriesId, season, primary)
                    : Memoized(memo.Episodes, (seriesId, season, primary?.Id), () => _host.GetEpisodes(seriesId, season, primary));
                foreach (var episode in library.OrderBy(e => e.Season).ThenBy(e => e.Episode))
                {
                    var coords = PlaceholderProgress.CoordsInScope(scope, episode.Season, episode.Episode, episode.EpisodeEnd)
                        .Where(c => !ownCovered.Contains(c))
                        .ToList();
                    if (coords.Count == 0 || !AccessibleToRest(episode.Id, users))
                    {
                        continue;
                    }

                    ownCovered.UnionWith(coords);
                    own.Add(new ResolvedItem(episode.Id, BaseItemKind.Episode, coords));
                }

                copies.Add((seriesId, own));
            }

            // One item per coordinate: copies of the show in several libraries never double an episode.
            var episodes = OnePerCoordinate(copies.Select(c => c.Episodes));
            if (!collection || scope.Kind == PlaceholderKinds.Episodes)
            {
                return new ScopeResolution(episodes, episodes);
            }

            // Collection season: a copy's Season item (once a real episode of it is there) holds only that copy's
            // episodes, so an episode counts only through the Season item of the copy it is credited to. The copy that
            // covers the most goes first; another copy's Season item is added only for coordinates the first lacks.
            if (scope.SeasonNumber is not int number)
            {
                return new ScopeResolution(Array.Empty<ResolvedItem>(), episodes);
            }

            var covered = new HashSet<EpisodeCoord>();
            var seasonItems = new List<ResolvedItem>();
            var credited = new List<ResolvedItem>();
            foreach (var copy in copies.Where(c => c.Episodes.Count > 0).OrderByDescending(c => c.Episodes.Sum(e => e.Coords.Count)))
            {
                var adds = copy.Episodes
                    .Select(e => e with { Coords = e.Coords.Where(c => !covered.Contains(c)).ToList() })
                    .Where(e => e.Coords.Count > 0)
                    .ToList();
                if (adds.Count == 0)
                {
                    continue;
                }

                var seasonId = _host.FindSeason(copy.SeriesId, number, primary);
                if (!seasonId.HasValue || !AccessibleToRest(seasonId.Value, users))
                {
                    continue;
                }

                var seasonCoords = adds.SelectMany(e => e.Coords).ToList();
                covered.UnionWith(seasonCoords);
                credited.AddRange(adds);
                seasonItems.Add(new ResolvedItem(seasonId.Value, BaseItemKind.Season, seasonCoords));
            }

            if (seasonItems.Count == 0)
            {
                return new ScopeResolution(Array.Empty<ResolvedItem>(), episodes);
            }

            credited.Sort((a, b) => a.Coords[0].CompareTo(b.Coords[0]));
            return new ScopeResolution(seasonItems, credited);
        }

        private static TValue Memoized<TKey, TValue>(Dictionary<TKey, TValue> cache, TKey key, Func<TValue> load)
            where TKey : notnull
        {
            if (!cache.TryGetValue(key, out var value))
            {
                value = load();
                cache[key] = value;
            }

            return value;
        }

        // Merges per-copy episode lists in order: a coordinate goes to the first copy that has it; sorted by coordinate.
        private static List<ResolvedItem> OnePerCoordinate(IEnumerable<List<ResolvedItem>> copies)
        {
            var covered = new HashSet<EpisodeCoord>();
            var result = new List<ResolvedItem>();
            foreach (var episode in copies.SelectMany(c => c))
            {
                var coords = episode.Coords.Where(c => !covered.Contains(c)).ToList();
                if (coords.Count == 0)
                {
                    continue;
                }

                covered.UnionWith(coords);
                result.Add(coords.Count == episode.Coords.Count ? episode : episode with { Coords = coords });
            }

            result.Sort((a, b) => a.Coords[0].CompareTo(b.Coords[0]));
            return result;
        }

        // The query was scoped to users[0]; every other user is checked per item.
        private bool AccessibleToRest(Guid itemId, IReadOnlyList<User> users)
        {
            for (var i = 1; i < users.Count; i++)
            {
                if (!_host.CanAccessItem(itemId, users[i]))
                {
                    return false;
                }
            }

            return true;
        }
    }
}
