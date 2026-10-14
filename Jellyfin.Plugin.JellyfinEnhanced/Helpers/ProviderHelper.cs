using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    public static class ProviderHelper
    {
        /// <summary>
        /// Returns the ItemId with the highest score based on how many provider IDs match.
        /// Accepts any number of providers.
        /// </summary>
        /// <param name="providers">List of (Provider, Value) tuples.</param>
        /// <param name="itemMap">Dictionary mapping (Provider, Value) to ItemId.</param>
        public static Guid? GetBestItemId(
            IEnumerable<(string Provider, string Value)> providers,
            Dictionary<(string Provider, string Value), Guid> itemMap)
        {
            var scoreMap = new Dictionary<Guid, int>();

            foreach (var (provider, value) in providers)
            {
                if (!string.IsNullOrWhiteSpace(value) &&
                    itemMap.TryGetValue((provider, value), out var itemId))
                {
                    scoreMap[itemId] = scoreMap.GetValueOrDefault(itemId) + 1;
                }
            }

            if (scoreMap.Count == 0)
                return null;

            return scoreMap.MaxBy(kv => kv.Value).Key;
        }

        /// <summary>
        /// Which Jellyfin copy of an arr event one user may see. Jellyfin can hold the same title more than
        /// once (a "TV" and a "TV 4K" or kids' library, each copy its own item), so every copy counts: the
        /// event is visible when the user may open a copy of the series or movie and, when Jellyfin has the
        /// episode in that copy (found by its ids or season and episode number), the episode too (Jellyfin
        /// can hide a single episode by its own rating or tags). A copy of the series without the episode
        /// lets the series decide, as for an episode Jellyfin doesn't have yet. An episode whose series
        /// can't be told counts for every copy.
        /// </summary>
        /// <param name="e">The event, with <see cref="ArrItem.ItemId"/>/<see cref="ArrItem.ItemEpisodeId"/>
        /// holding the copy picked for everyone (tried first).</param>
        /// <param name="candidates">Every item id per provider key, best match first.</param>
        /// <param name="seen">The item as the user may see it; null when it is hidden from them.</param>
        /// <param name="seriesOf">An episode's series whoever may see it; null or empty when unknown.</param>
        /// <param name="episodeInCopy">An unrestricted lookup of the episode covering the event's season
        /// and episode number in a series copy, when its provider ids didn't match. Null when absent;
        /// <see cref="Guid.Empty"/> when the lookup failed (hides this copy without calling <paramref name="seen"/>).
        /// Called only for events with both numbers.</param>
        /// <param name="aliases">The shared title alias resolver (arr libraries and complete Seerr requests).</param>
        /// <returns>Whether Jellyfin has the title at all (else its landing library decides), whether the
        /// user may see it, and the user's own series/movie and episode ids to point the event at.</returns>
        public static (bool InJellyfin, bool Visible, Guid? ItemId, Guid? EpisodeId) PickCallerCopy(
            ArrItem e,
            IReadOnlyDictionary<(string Provider, string Value), List<Guid>> candidates,
            Func<Guid, BaseItem?> seen,
            Func<Guid, Guid?> seriesOf,
            Func<Guid, Guid?>? episodeInCopy = null,
            TitleAliases? aliases = null)
        {
            var titleIds = Ranked(GetProviders(e, aliases), candidates, e.ItemId);
            var episodeIds = Ranked(GetEpisodeProviders(e), candidates, e.ItemEpisodeId);
            if (titleIds.Count == 0 && episodeIds.Count == 0)
                return (false, false, null, null);

            var episodes = episodeIds.Select(id =>
            {
                var item = seen(id);
                var series = (item as Episode)?.SeriesId is Guid known && known != Guid.Empty ? known : seriesOf(id);
                return (Id: id, Open: item != null, Series: series is Guid g && g != Guid.Empty ? g : (Guid?)null);
            }).ToList();

            if (titleIds.Count == 0)
            {
                // Jellyfin matched the episode only: visible when the user may open a copy of it.
                foreach (var episode in episodes)
                {
                    if (episode.Open) return (true, true, null, episode.Id);
                }
                return (true, false, null, null);
            }

            // The user's copies of the series or movie (an episode or season sharing the key isn't one).
            var openTitles = titleIds.Where(id => seen(id) is { } item && item is not (Episode or Season)).ToList();
            static bool InCopy((Guid Id, bool Open, Guid? Series) episode, Guid title) => episode.Series is not Guid s || s == title;

            // A copy of theirs that has the episode and lets them open it.
            foreach (var title in openTitles)
            {
                foreach (var episode in episodes)
                {
                    if (episode.Open && InCopy(episode, title)) return (true, true, title, episode.Id);
                }
            }
            // A copy of theirs without the episode (not downloaded there yet): the series decides.
            foreach (var title in openTitles)
            {
                if (episodes.Any(episode => InCopy(episode, title))) continue;
                if (e.SeasonNumber != null && e.EpisodeNumber != null && episodeInCopy?.Invoke(title) is Guid id)
                {
                    if (id != Guid.Empty && seen(id) != null) return (true, true, title, id);
                    continue;
                }
                return (true, true, title, null);
            }
            return (true, false, null, null);
        }

        // The distinct ids the keys match: the preferred one first, then the ones more keys agree on.
        private static List<Guid> Ranked(
            List<(string Provider, string Value)> keys,
            IReadOnlyDictionary<(string Provider, string Value), List<Guid>> candidates,
            Guid? preferred)
        {
            var score = new Dictionary<Guid, int>();
            var order = new List<Guid>();
            foreach (var key in keys)
            {
                if (!candidates.TryGetValue(key, out var ids)) continue;
                foreach (var id in ids)
                {
                    if (!score.ContainsKey(id)) order.Add(id);
                    score[id] = score.GetValueOrDefault(id) + 1;
                }
            }
            return order.OrderBy(id => id == preferred ? 0 : 1).ThenByDescending(id => score[id]).ToList();
        }

        /// <summary>The title's provider ids, expanded through the shared resolver when given, plus Shoko's series id.</summary>
        public static List<(string Provider, string Value)> GetProviders(ArrItem e, TitleAliases? aliases = null)
            => GetProviders(e, includeNormal: true, includeEpisode: false, aliases);

        public static List<(string Provider, string Value)> GetEpisodeProviders(ArrItem e) 
            => GetProviders(e, includeNormal: false, includeEpisode: true);

        /// <summary>The title and episode provider ids used to find every calendar copy.</summary>
        public static List<(string Provider, string Value)> GetAllProviders(ArrItem e, TitleAliases? aliases = null)
             => GetProviders(e, includeNormal: true, includeEpisode: true, aliases);

        /// <summary>
        /// Builds a provider list from the ARR item based on which ID groups should be included.
        /// </summary>
        /// <param name="e">ARR item containing provider IDs.</param>
        /// <param name="includeNormal">Include series/movie providers (Tvdb/Tmdb/Imdb).</param>
        /// <param name="includeEpisode">Include episode providers (episode Tvdb/Imdb, mapped to Tvdb/Imdb keys).</param>
        /// <param name="aliases">The shared resolver for other title ids, when given.</param>
        /// <returns>Ordered list of (Provider, Value) pairs.</returns>
        private static List<(string Provider, string Value)> GetProviders(ArrItem e, bool includeNormal, bool includeEpisode, TitleAliases? aliases = null)
        {
            var providers = new List<(string, string)>();

            void Add(string p, string? v)
            {
                if (!string.IsNullOrWhiteSpace(v))
                    providers.Add((p, v));
            }

            if (includeNormal)
            {
                foreach (var raw in TitleAliases.FromIds(e.Type == "Movie", e.TmdbId, e.TvdbId, e.ImdbId))
                {
                    if (TitleKey.Parse(raw) is { } provider) Add(TitleAliases.ProviderName(provider), provider.Id);
                }
                if (aliases != null && TitleAliases.KeyOf(e) is { } key)
                {
                    foreach (var alias in aliases.Of(key)) Add(TitleAliases.ProviderName(alias), alias.Id);
                }
                Add("Shoko Series", e.ShokoSeriesId?.ToString());
            }

            if (includeEpisode)
            {
                Add("Tvdb", e.EpisodeTvdbId?.ToString());
                Add("Imdb", e.EpisodeImdbId);
                Add("Shoko Episode", e.ShokoEpisodeId?.ToString());
            }

            return providers.Distinct().ToList();
        }
    }
}
