using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>A qualifying physical source inside a requested scope.</summary>
    /// <param name="ItemId">Exact item to insert/play.</param>
    /// <param name="LogicalItemId">The movie/episode whose media sources were examined.</param>
    /// <param name="SeriesId">Physical series folder, TV only.</param>
    /// <param name="Coords">Episode coordinates inside the requested scope.</param>
    /// <param name="Source">Source dimensions and identity.</param>
    public sealed record ListEditionMatch(Guid ItemId, Guid LogicalItemId, Guid? SeriesId, IReadOnlyList<EpisodeCoord> Coords, ListMediaSource Source);

    /// <summary>Accessible physical series folders and their qualifying sources (movies have no series folders).</summary>
    /// <param name="SeriesIds">Accessible physical series copies, in library order.</param>
    /// <param name="Sources">Qualifying sources, standard sources preferred for a standard request.</param>
    public sealed record ListEditionResolution(IReadOnlyList<Guid> SeriesIds, IReadOnlyList<ListEditionMatch> Sources);

    /// <summary>
    /// Temporary list adapter for the planned shared EditionAvailability service. Given viewers, title/season/episode
    /// scope and edition, resolves accessible playable SOURCES across every physical copy, including grouped folders
    /// and alternate MediaSources. An optional pinned item keeps the query on that shown copy. Standard accepts any
    /// playable source (preferring non-4K); 4K requires that source's dimensions. No arr or folder inference.
    /// Replace this adapter with the shared service at integration; list representation/placement stays in ListResolver.
    /// </summary>
    public sealed class ListEditionAvailability
    {
        private readonly IListHost _host;

        /// <summary>Creates the source resolver.</summary>
        /// <param name="host">Physical library/source facts.</param>
        public ListEditionAvailability(IListHost host) { _host = host; }

        /// <summary>Resolves the scope and edition for every viewer, optionally pinned to a shown physical item.</summary>
        /// <param name="scope">Title, season or episode-range scope, including edition.</param>
        /// <param name="users">All viewers whose current access is required; empty means the server's library.</param>
        /// <param name="pinnedItemId">Shown movie/series copy, or null to search every copy.</param>
        /// <param name="memo">Optional query memo for this operation only.</param>
        /// <returns>Physical folders and qualifying sources; never a virtual or inaccessible source.</returns>
        public ListEditionResolution Resolve(Placeholder scope, IReadOnlyList<User> users, Guid? pinnedItemId = null, ResolveMemo? memo = null)
        {
            var primary = users.Count > 0 ? users[0] : null;
            var sources = new List<ListEditionMatch>();
            var series = new List<Guid>();
            if (scope.Kind == PlaceholderKinds.Movie)
            {
                var movies = Memo(memo?.Movies, (scope.TmdbId, scope.ImdbId, primary?.Id), () => _host.FindMovies(scope.TmdbId, scope.ImdbId, primary));
                foreach (var id in movies.Where(id => (!pinnedItemId.HasValue || id == pinnedItemId) && Accessible(id, users)))
                    AddSources(id, null, Array.Empty<EpisodeCoord>(), scope, users, sources);
            }
            else if (scope.Kind is PlaceholderKinds.Series or PlaceholderKinds.Season or PlaceholderKinds.Episodes)
            {
                var found = Memo(memo?.Series, (scope.TmdbId, scope.TvdbId, scope.ImdbId, primary?.Id), () => _host.FindSeries(scope.TmdbId, scope.TvdbId, scope.ImdbId, primary));
                series.AddRange(found.Where(id => (!pinnedItemId.HasValue || id == pinnedItemId) && Accessible(id, users)));
                var season = scope.Kind == PlaceholderKinds.Series ? (int?)null : scope.SeasonNumber;
                foreach (var id in series)
                {
                    var episodes = Memo(memo?.Episodes, (id, season, primary?.Id), () => _host.GetEpisodes(id, season, primary));
                    foreach (var episode in episodes.OrderBy(e => e.Season).ThenBy(e => e.Episode))
                    {
                        if (pinnedItemId.HasValue && episode.SeriesId != pinnedItemId.Value) continue;
                        var coords = PlaceholderProgress.CoordsInScope(scope, episode.Season, episode.Episode, episode.EpisodeEnd);
                        if (coords.Count > 0 && Accessible(episode.SeriesId, users) && Accessible(episode.Id, users))
                            AddSources(episode.Id, episode.SeriesId, coords, scope, users, sources);
                    }
                }
            }

            return new ListEditionResolution(series, ListRules.EditionOf(scope) == ListRules.Standard
                ? sources.OrderBy(s => FourK(s.Source) ? 1 : 0).ToList()
                : sources);
        }

        private void AddSources(Guid id, Guid? series, IReadOnlyList<EpisodeCoord> coords, Placeholder scope, IReadOnlyList<User> users, List<ListEditionMatch> matches)
        {
            foreach (var source in _host.GetMediaSources(id))
            {
                if (source.Playable && (ListRules.EditionOf(scope) != ListRules.FourK || FourK(source)) && Accessible(source.ItemId, users))
                    matches.Add(new ListEditionMatch(source.ItemId, id, series, coords, source));
            }
        }

        private bool Accessible(Guid id, IReadOnlyList<User> users) => users.All(u => _host.CanAccessItem(id, u));

        private static bool FourK(ListMediaSource source) => source.Width >= 3200 || source.Height >= 2000;

        private static TValue Memo<TKey, TValue>(Dictionary<TKey, TValue>? cache, TKey key, Func<TValue> read) where TKey : notnull
        {
            if (cache == null) return read();
            if (!cache.TryGetValue(key, out var value)) cache[key] = value = read();
            return value;
        }
    }
}
