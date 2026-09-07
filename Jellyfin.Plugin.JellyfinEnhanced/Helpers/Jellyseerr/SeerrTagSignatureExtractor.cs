using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// Extracts a title's tag signature: the cleaned sets of TMDB keyword and
    /// genre NAMES, kept separate because the two directions of the tag gate
    /// match different surfaces (see <see cref="ParentalTagDecision"/>).
    /// Accepts Seerr detail bodies (<c>/api/v1/movie|tv/{id}</c>: flat
    /// <c>keywords: [{id,name}]</c> and <c>genres: [{id,name}]</c>) and raw TMDB
    /// detail with <c>append_to_response=keywords</c> (movies wrap as
    /// <c>keywords: { keywords: [...] }</c>, tv as <c>keywords: { results: [...] }</c>).
    /// Missing or malformed containers contribute nothing; never throws on shape.
    ///
    /// Adapted from Jellyfin-Canopy (GPL-3.0), Helpers/Seerr/SeerrTagSignatureExtractor.cs.
    /// </summary>
    public static class SeerrTagSignatureExtractor
    {
        /// <summary>
        /// Whether the body carries a keyword container at all. A detail body without
        /// one is not "a title with no keywords" — its tags are unknown, and tag rules
        /// must fail closed on it rather than read the empty set as a clean bill.
        /// </summary>
        public static bool HasKeywordData(JsonElement detail)
            => detail.ValueKind == JsonValueKind.Object
               && detail.TryGetProperty("keywords", out var keywords)
               && keywords.ValueKind is JsonValueKind.Array or JsonValueKind.Object;

        /// <summary>Extracts the keyword and genre name sets from a detail body.</summary>
        public static (HashSet<string> Keywords, HashSet<string> Genres) Extract(JsonElement detail)
        {
            var keywordNames = new List<string?>();
            var genreNames = new List<string?>();
            if (detail.ValueKind == JsonValueKind.Object)
            {
                if (detail.TryGetProperty("keywords", out var keywords))
                {
                    CollectNames(keywords, keywordNames);
                }

                if (detail.TryGetProperty("genres", out var genres))
                {
                    CollectNames(genres, genreNames);
                }
            }

            return (ParentalTagDecision.ToTagSet(keywordNames), ParentalTagDecision.ToTagSet(genreNames));
        }

        private static void CollectNames(JsonElement container, List<string?> names)
        {
            if (container.ValueKind == JsonValueKind.Object)
            {
                if (container.TryGetProperty("keywords", out var wrappedMovie))
                {
                    CollectNames(wrappedMovie, names);
                }

                if (container.TryGetProperty("results", out var wrappedTv))
                {
                    CollectNames(wrappedTv, names);
                }

                return;
            }

            if (container.ValueKind != JsonValueKind.Array)
            {
                return;
            }

            foreach (var entry in container.EnumerateArray())
            {
                if (entry.ValueKind == JsonValueKind.Object
                    && entry.TryGetProperty("name", out var name)
                    && name.ValueKind == JsonValueKind.String)
                {
                    names.Add(name.GetString());
                }
            }
        }
    }
}
