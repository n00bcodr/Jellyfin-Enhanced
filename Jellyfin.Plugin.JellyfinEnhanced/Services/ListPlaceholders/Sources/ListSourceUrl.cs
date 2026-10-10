using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources
{
    /// <summary>Source kinds (what the user linked).</summary>
    public static class SourceKinds
    {
        /// <summary>MDBList list (also the mirror for IMDb / Letterboxd / Trakt / JustWatch lists).</summary>
        public const string Mdblist = "mdblist";

        /// <summary>TMDB list, collection or chart.</summary>
        public const string Tmdb = "tmdb";

        /// <summary>Trakt list, watchlist or chart.</summary>
        public const string Trakt = "trakt";

        /// <summary>IMDb list, watchlist or chart (unofficial, admin opt-in).</summary>
        public const string Imdb = "imdb";

        /// <summary>Letterboxd (never fetched: guidance only).</summary>
        public const string Letterboxd = "letterboxd";
    }

    /// <summary>A recognised list URL. Only these parts are used to build upstream requests — never the URL itself.</summary>
    /// <param name="Kind">One of <see cref="SourceKinds"/>.</param>
    /// <param name="Shape">mdblist: user | external | official; tmdb: list | collection | chart | trending; trakt: list | watchlist | listid | chart; imdb: list | watchlist | chart.</param>
    /// <param name="CanonicalUrl">Normalised URL (what is stored when linking).</param>
    /// <param name="Parts">Validated path parts (user, slug, id, media, chart, period…).</param>
    public sealed record ParsedSourceUrl(string Kind, string Shape, string CanonicalUrl, IReadOnlyDictionary<string, string> Parts)
    {
        /// <summary>A part or empty.</summary>
        /// <param name="name">Part name.</param>
        /// <returns>Value.</returns>
        public string Part(string name) => Parts.TryGetValue(name, out var value) ? value : string.Empty;
    }

    /// <summary>
    /// Recognises list URLs with a strict host allowlist (SSRF guard: the pasted URL is never fetched; fetchers build
    /// their API URLs from the validated parts). Patterns from research/list-sources.md.
    /// </summary>
    public static class ListSourceUrl
    {
        /// <summary>Error: not a URL.</summary>
        public const string InvalidUrl = "invalid_url";

        /// <summary>Error: not a supported list URL.</summary>
        public const string UnsupportedUrl = "unsupported_url";

        /// <summary>Error: Letterboxd (guidance instead of fetching).</summary>
        public const string LetterboxdUnsupported = "letterboxd_unsupported";

        private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled;
        private const string Tail = @"/?(?:json/?)?$";

        private static readonly Regex MdbExternal = new(@"^/lists/(?<user>[A-Za-z0-9._-]{1,64})/external/(?<id>\d{1,10})" + Tail, Options);
        private static readonly Regex MdbOfficial = new(@"^/lists/official/(?<media>movies|shows)/(?<slug>[A-Za-z0-9._-]{1,128})" + Tail, Options);
        private static readonly Regex MdbUser = new(@"^/lists/(?<user>[A-Za-z0-9._-]{1,64})/(?<slug>[A-Za-z0-9._-]{1,128})" + Tail, Options);

        private static readonly Regex TmdbList = new(@"^/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?list/(?<id>\d{1,10})(?:-[A-Za-z0-9_-]*)?/?$", Options);
        private static readonly Regex TmdbCollection = new(@"^/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?collection/(?<id>\d{1,10})(?:-[A-Za-z0-9_-]*)?/?$", Options);
        private static readonly Regex TmdbChart = new(@"^/(?<media>movie|tv)(?:/(?<chart>top-rated|now-playing|upcoming|airing-today|on-the-air|popular))?/?$", Options);
        private static readonly Regex TmdbTrending = new(@"^/trending/(?<media>all|movie|tv)/(?<period>day|week)/?$", Options);

        private static readonly Regex TraktList = new(@"^/users/(?<user>[A-Za-z0-9._-]{1,64})/lists/(?<list>[A-Za-z0-9._-]{1,128})/?$", Options);
        private static readonly Regex TraktWatchlist = new(@"^/users/(?<user>[A-Za-z0-9._-]{1,64})/watchlist/?$", Options);
        private static readonly Regex TraktOfficial = new(@"^/lists/official/(?<list>[A-Za-z0-9._-]{1,128})/?$", Options);
        private static readonly Regex TraktListId = new(@"^/lists/(?<list>\d{1,10})/?$", Options);
        private static readonly Regex TraktChart = new(@"^/(?<media>movies|shows)/(?<chart>trending|popular|anticipated|boxoffice|watched|played|collected|favorited)(?:/(?<period>daily|weekly|monthly|yearly|all))?/?$", Options);

        private static readonly Regex ImdbList = new(@"^/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?list/(?<id>ls\d{5,12})/?$", Options);
        private static readonly Regex ImdbWatchlist = new(@"^/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?user/(?<user>ur\d{5,12}|p\.[a-z0-9]{4,40})/watchlist/?$", Options);
        private static readonly Regex ImdbChart = new(@"^/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?chart/(?<chart>top|toptv|moviemeter|tvmeter|bottom|top-english-movies)/?$", Options);

        /// <summary>Parses a list URL.</summary>
        /// <param name="input">User input.</param>
        /// <param name="source">The recognised source.</param>
        /// <param name="error">Error code when not recognised.</param>
        /// <returns>Whether it is a supported source (Letterboxd returns false with <see cref="LetterboxdUnsupported"/>).</returns>
        public static bool TryParse(string? input, out ParsedSourceUrl? source, out string? error)
        {
            source = null;
            error = null;
            var text = (input ?? string.Empty).Trim();
            if (text.Length == 0 || text.Length > 500)
            {
                error = InvalidUrl;
                return false;
            }

            if (!text.Contains("://", StringComparison.Ordinal))
            {
                text = "https://" + text;
            }

            if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort)
            {
                error = InvalidUrl;
                return false;
            }

            var host = uri.IdnHost.ToLowerInvariant();
            var path = Uri.UnescapeDataString(uri.AbsolutePath);
            if (path.Contains("..", StringComparison.Ordinal))
            {
                error = UnsupportedUrl;
                return false;
            }

            switch (host)
            {
                case "mdblist.com" or "www.mdblist.com":
                    source = Mdblist(path);
                    break;
                case "themoviedb.org" or "www.themoviedb.org":
                    source = Tmdb(path);
                    break;
                case "trakt.tv" or "www.trakt.tv" or "app.trakt.tv":
                    source = Trakt(path);
                    break;
                case "imdb.com" or "www.imdb.com" or "m.imdb.com":
                    source = Imdb(path);
                    break;
                case "letterboxd.com" or "www.letterboxd.com" or "boxd.it":
                    error = LetterboxdUnsupported;
                    return false;
            }

            if (source == null)
            {
                error = UnsupportedUrl;
                return false;
            }

            return true;
        }

        private static ParsedSourceUrl? Mdblist(string path)
        {
            var m = MdbExternal.Match(path);
            if (m.Success)
            {
                return Make(SourceKinds.Mdblist, "external", $"https://mdblist.com/lists/{m.Groups["user"].Value.ToLowerInvariant()}/external/{m.Groups["id"].Value}", ("user", m.Groups["user"].Value.ToLowerInvariant()), ("id", m.Groups["id"].Value));
            }

            m = MdbOfficial.Match(path);
            if (m.Success)
            {
                var media = m.Groups["media"].Value.ToLowerInvariant();
                return Make(SourceKinds.Mdblist, "official", $"https://mdblist.com/lists/official/{media}/{m.Groups["slug"].Value}", ("media", media), ("slug", m.Groups["slug"].Value));
            }

            m = MdbUser.Match(path);
            if (m.Success && !m.Groups["user"].Value.Equals("official", StringComparison.OrdinalIgnoreCase))
            {
                var user = m.Groups["user"].Value.ToLowerInvariant();
                return Make(SourceKinds.Mdblist, "user", $"https://mdblist.com/lists/{user}/{m.Groups["slug"].Value}", ("user", user), ("slug", m.Groups["slug"].Value));
            }

            return null;
        }

        private static ParsedSourceUrl? Tmdb(string path)
        {
            var m = TmdbList.Match(path);
            if (m.Success)
            {
                return Make(SourceKinds.Tmdb, "list", $"https://www.themoviedb.org/list/{Id(m)}", ("id", Id(m)));
            }

            m = TmdbCollection.Match(path);
            if (m.Success)
            {
                return Make(SourceKinds.Tmdb, "collection", $"https://www.themoviedb.org/collection/{Id(m)}", ("id", Id(m)));
            }

            m = TmdbTrending.Match(path);
            if (m.Success)
            {
                var media = m.Groups["media"].Value.ToLowerInvariant();
                var period = m.Groups["period"].Value.ToLowerInvariant();
                return Make(SourceKinds.Tmdb, "trending", $"https://www.themoviedb.org/trending/{media}/{period}", ("media", media), ("period", period));
            }

            m = TmdbChart.Match(path);
            if (m.Success)
            {
                var media = m.Groups["media"].Value.ToLowerInvariant();
                var chart = m.Groups["chart"].Success ? m.Groups["chart"].Value.ToLowerInvariant() : "popular";
                var suffix = chart == "popular" ? string.Empty : "/" + chart;
                return Make(SourceKinds.Tmdb, "chart", $"https://www.themoviedb.org/{media}{suffix}", ("media", media), ("chart", chart));
            }

            return null;
        }

        private static ParsedSourceUrl? Trakt(string path)
        {
            var m = TraktList.Match(path);
            if (m.Success)
            {
                return Make(SourceKinds.Trakt, "list", $"https://trakt.tv/users/{m.Groups["user"].Value}/lists/{m.Groups["list"].Value}", ("user", m.Groups["user"].Value), ("list", m.Groups["list"].Value));
            }

            m = TraktWatchlist.Match(path);
            if (m.Success)
            {
                return Make(SourceKinds.Trakt, "watchlist", $"https://trakt.tv/users/{m.Groups["user"].Value}/watchlist", ("user", m.Groups["user"].Value));
            }

            m = TraktOfficial.Match(path);
            if (m.Success)
            {
                return Make(SourceKinds.Trakt, "listid", $"https://trakt.tv/lists/official/{m.Groups["list"].Value}", ("list", m.Groups["list"].Value));
            }

            m = TraktListId.Match(path);
            if (m.Success)
            {
                return Make(SourceKinds.Trakt, "listid", $"https://trakt.tv/lists/{m.Groups["list"].Value}", ("list", m.Groups["list"].Value));
            }

            m = TraktChart.Match(path);
            if (m.Success)
            {
                var media = m.Groups["media"].Value.ToLowerInvariant();
                var chart = m.Groups["chart"].Value.ToLowerInvariant();
                if (chart == "boxoffice" && media != "movies")
                {
                    return null;
                }

                var period = m.Groups["period"].Success ? m.Groups["period"].Value.ToLowerInvariant() : string.Empty;
                if (period.Length > 0 && chart is not ("watched" or "played" or "collected" or "favorited"))
                {
                    return null;
                }

                return Make(SourceKinds.Trakt, "chart", $"https://trakt.tv/{media}/{chart}" + (period.Length > 0 ? "/" + period : string.Empty), ("media", media), ("chart", chart), ("period", period));
            }

            return null;
        }

        private static ParsedSourceUrl? Imdb(string path)
        {
            var m = ImdbList.Match(path);
            if (m.Success)
            {
                var id = m.Groups["id"].Value.ToLowerInvariant();
                return Make(SourceKinds.Imdb, "list", $"https://www.imdb.com/list/{id}/", ("id", id));
            }

            m = ImdbWatchlist.Match(path);
            if (m.Success)
            {
                var user = m.Groups["user"].Value.ToLowerInvariant();
                return Make(SourceKinds.Imdb, "watchlist", $"https://www.imdb.com/user/{user}/watchlist/", ("user", user));
            }

            m = ImdbChart.Match(path);
            if (m.Success)
            {
                var chart = m.Groups["chart"].Value.ToLowerInvariant();
                return Make(SourceKinds.Imdb, "chart", $"https://www.imdb.com/chart/{chart}/", ("chart", chart));
            }

            return null;
        }

        private static string Id(Match m) => long.Parse(m.Groups["id"].Value, NumberStyles.None, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);

        private static ParsedSourceUrl Make(string kind, string shape, string canonical, params (string Key, string Value)[] parts)
        {
            var dict = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var (key, value) in parts)
            {
                dict[key] = value;
            }

            return new ParsedSourceUrl(kind, shape, canonical, dict);
        }
    }
}
