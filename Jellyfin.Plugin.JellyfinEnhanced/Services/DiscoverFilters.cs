using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The filters a discover feed takes from the client: passed on to Seerr under
    /// Seerr's names, or translated for TMDB's own discover/tv (the series-by-studio feed).
    /// </summary>
    public static class DiscoverFilters
    {
        // Seerr's discover API accepts these (its QueryFilterOptions, read from
        // Seerr 3.4.1 and tried live). The names carry no `with*` prefix: Seerr
        // rejects `withCompanies` / `withNetworks` / `withOriginalLanguage` as
        // `Unknown query parameter`. `studio` and `network` are part of the route.
        private static readonly string[] SeerrParams =
        {
            "sortBy", "primaryReleaseDateGte", "primaryReleaseDateLte",
            "firstAirDateGte", "firstAirDateLte",
            "voteAverageGte", "voteAverageLte", "voteCountGte", "voteCountLte",
            "withRuntimeGte", "withRuntimeLte",
            "certification", "certificationGte", "certificationLte", "certificationCountry",
            "watchRegion", "language", "genre", "keywords", "excludeKeywords", "watchProviders"
        };

        // A genre page's route already names a genre and a tag page's a keyword;
        // more of the same from the client join it with a comma, Seerr's "all of".
        private static readonly HashSet<string> JoinedWithRoute = new(StringComparer.Ordinal) { "genre", "keywords" };

        private static readonly Regex Date = new(@"^\d{4}-\d{2}-\d{2}$", RegexOptions.Compiled);
        private static readonly Regex Number = new(@"^\d{1,7}(\.\d{1,2})?$", RegexOptions.Compiled);
        private static readonly Regex IdList = new(@"^\d{1,9}([,|]\d{1,9}){0,49}$", RegexOptions.Compiled);
        private static readonly Regex LanguageList = new(@"^[a-z]{2}([,|][a-z]{2}){0,49}$", RegexOptions.Compiled);
        private static readonly Regex Region = new(@"^[A-Z]{2}$", RegexOptions.Compiled);
        private static readonly Regex Certifications = new(@"^[A-Za-z0-9+\- ]{1,12}(\|[A-Za-z0-9+\- ]{1,12}){0,19}$", RegexOptions.Compiled);

        // Seerr's name, TMDB discover/tv's name, and what a value must look like.
        private static readonly (string Seerr, string Tmdb, Regex Shape)[] TmdbTvParams =
        {
            ("firstAirDateGte", "first_air_date.gte", Date), ("firstAirDateLte", "first_air_date.lte", Date),
            ("voteAverageGte", "vote_average.gte", Number), ("voteAverageLte", "vote_average.lte", Number),
            ("voteCountGte", "vote_count.gte", Number), ("voteCountLte", "vote_count.lte", Number),
            ("withRuntimeGte", "with_runtime.gte", Number), ("withRuntimeLte", "with_runtime.lte", Number),
            ("language", "with_original_language", LanguageList),
            ("genre", "with_genres", IdList), ("keywords", "with_keywords", IdList), ("excludeKeywords", "without_keywords", IdList),
            ("watchProviders", "with_watch_providers", IdList), ("watchRegion", "watch_region", Region),
            ("certification", "certification", Certifications), ("certificationGte", "certification.gte", Certifications),
            ("certificationLte", "certification.lte", Certifications), ("certificationCountry", "certification_country", Region)
        };

        /// <summary>
        /// Adds the client's filters to a Seerr discover path that already has a
        /// query (<c>?page=…</c>). <paramref name="read"/> returns the request's
        /// value for a name, or null.
        /// </summary>
        public static string AppendToSeerrPath(string basePath, Func<string, string?> read)
        {
            var path = basePath;
            foreach (var param in SeerrParams)
            {
                var value = read(param);
                if (string.IsNullOrEmpty(value)) continue;
                var own = JoinedWithRoute.Contains(param) ? basePath.IndexOf($"&{param}=", StringComparison.Ordinal) : -1;
                if (own < 0)
                {
                    path += $"&{param}={Uri.EscapeDataString(value)}";
                    continue;
                }
                // The route's own value ends at the next '&', or at the end of the path.
                var end = path.IndexOf('&', own + 1);
                path = path.Insert(end < 0 ? path.Length : end, "%2C" + Uri.EscapeDataString(value));
            }
            return path;
        }

        /// <summary>
        /// The client's filters as TMDB discover/tv parameters (<c>&amp;name=value…</c>,
        /// in a fixed order: the result is part of a cache key). A value that is
        /// not of its parameter's shape is left out.
        /// </summary>
        public static string ToTmdbTvQuery(Func<string, string?> read)
        {
            var query = string.Empty;
            foreach (var (seerr, tmdb, shape) in TmdbTvParams)
            {
                var value = read(seerr);
                if (string.IsNullOrEmpty(value) || !shape.IsMatch(value)) continue;
                query += $"&{tmdb}={Uri.EscapeDataString(value)}";
            }
            return query;
        }
    }
}
