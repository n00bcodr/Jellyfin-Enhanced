using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;

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

        public static List<(string Provider, string Value)> GetProviders(ArrItem e) 
            => GetProviders(e, includeNormal: true, includeEpisode: false);

        public static List<(string Provider, string Value)> GetEpisodeProviders(ArrItem e) 
            => GetProviders(e, includeNormal: false, includeEpisode: true);

        public static List<(string Provider, string Value)> GetAllProviders(ArrItem e)
             => GetProviders(e, includeNormal: true, includeEpisode: true);

        /// <summary>
        /// Builds a provider list from the ARR item based on which ID groups should be included.
        /// </summary>
        /// <param name="e">ARR item containing provider IDs.</param>
        /// <param name="includeNormal">Include series/movie providers (Tvdb/Tmdb/Imdb).</param>
        /// <param name="includeEpisode">Include episode providers (episode Tvdb/Imdb, mapped to Tvdb/Imdb keys).</param>
        /// <returns>Ordered list of (Provider, Value) pairs.</returns>
        private static List<(string Provider, string Value)> GetProviders(ArrItem e, bool includeNormal, bool includeEpisode)
        {
            var providers = new List<(string, string)>();

            void Add(string p, string? v)
            {
                if (!string.IsNullOrWhiteSpace(v))
                    providers.Add((p, v));
            }

            if (includeNormal)
            {
                Add("Tvdb", e.TvdbId?.ToString());
                Add("Tmdb", e.TmdbId?.ToString());
                Add("Imdb", e.ImdbId);
            }

            if (includeEpisode)
            {
                Add("Tvdb", e.EpisodeTvdbId?.ToString());
                Add("Imdb", e.EpisodeImdbId);
            }

            return providers;
        }
    }
}
