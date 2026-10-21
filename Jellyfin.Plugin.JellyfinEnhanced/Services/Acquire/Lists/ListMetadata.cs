using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// Title metadata for one placeholder, read from Seerr (design C3/C4). Only fields Seerr actually answered are set;
    /// <see cref="ListMetadataService.Apply"/> merges them into the stored placeholder.
    /// </summary>
    public sealed class PlaceholderMetadata
    {
        /// <summary>When the underlying Seerr data was fetched (UTC).</summary>
        public DateTime FetchedAtUtc { get; init; }

        /// <summary>Release date per kind (movie release, series first air, season air, first listed episode); null = TBA.</summary>
        public string? ReleaseDate { get; init; }

        /// <summary>TMDB poster path.</summary>
        public string? PosterPath { get; init; }

        /// <summary>Overview.</summary>
        public string? Overview { get; init; }

        /// <summary>IMDb id (movie, or the show's).</summary>
        public string? ImdbId { get; init; }

        /// <summary>The show's TVDB id.</summary>
        public int? TvdbId { get; init; }

        /// <summary>Season/series: the expected episode set (null = not applicable).</summary>
        public List<PlaceholderEpisode>? Expected { get; init; }

        /// <summary>TV: false once the show is Ended/Canceled, true for any other answer (TMDB's own flag never ends a show).</summary>
        public bool? InProduction { get; init; }

        /// <summary>Season/series: aired episode count.</summary>
        public int? EpisodeTotal { get; init; }

        /// <summary>Episodes kind: the season's episodes (titles and air dates of the listed ones are refreshed).</summary>
        public List<PlaceholderEpisode>? SeasonEpisodes { get; init; }

        /// <summary>
        /// True when a season/episodes placeholder's season details could not be read (Seerr/TMDB error) although the
        /// show's details could: the expected episodes, aired count and episode air dates are unknown, so
        /// <see cref="ListMetadataService.Apply"/> keeps the stored ones, and this data never confirms that a
        /// season is complete.
        /// </summary>
        public bool Partial { get; init; }

        /// <summary>
        /// <see cref="Partial"/> for a season the show's details list: its own read failed (Seerr answers 500 alike for
        /// a TMDB error and an unknown season, so the show's season list tells them apart). The show's poster is then no
        /// answer for the season.
        /// </summary>
        public bool SeasonReadFailed { get; init; }
    }

    /// <summary>
    /// Where list core reads public title metadata (release dates, posters, TV ids, expected episodes, production state).
    /// The provisional implementation (<see cref="ListMetadataService"/>) reads Seerr (and posters from TMDB with JE's
    /// key); the import/source track replaces it with the shared TMDB / native-details adapter that also works without
    /// Seerr. A null answer always means "unknown": nothing is ever completed or retired on it.
    /// </summary>
    public interface IListMetadataSource
    {
        /// <summary>Full metadata can be read (dates, expected episodes, production state).</summary>
        bool Available { get; }

        /// <summary>Posters can be read even when <see cref="Available"/> is false.</summary>
        bool PostersAvailable { get; }

        /// <summary>The metadata an entry needs; null when unknown or unavailable.</summary>
        /// <param name="placeholder">Entry.</param>
        /// <param name="maxAge">Cached data older than this is read again.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Metadata or null.</returns>
        Task<PlaceholderMetadata?> FetchAsync(Placeholder placeholder, TimeSpan maxAge, DateTime todayUtc, CancellationToken cancellationToken);

        /// <summary>The entry's poster from the poster source, or null.</summary>
        /// <param name="placeholder">Entry.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Poster path or null.</returns>
        Task<string?> FetchTmdbPosterAsync(Placeholder placeholder, CancellationToken cancellationToken);

        /// <summary>The entry's poster and whether the source answered (a title without a poster also answers).</summary>
        /// <param name="placeholder">Entry.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Poster and whether it answered.</returns>
        Task<(string? Poster, bool Answered)> ReadTmdbPosterAsync(Placeholder placeholder, CancellationToken cancellationToken);
    }

    /// <summary>
    /// Reads placeholder metadata from Seerr (<c>/api/v1/movie/{id}</c>, <c>/api/v1/tv/{id}</c>,
    /// <c>/api/v1/tv/{id}/season/{n}</c>) with the admin API key (no user context: the data is public TMDB data), cached
    /// in memory per Seerr configuration (12 h; callers ask for fresher data with a max age), at most 4 calls at a time.
    /// A 404 is cached as "not found" for 30 minutes; Seerr's 500 ("Unable to retrieve …", for unknown ids/seasons but
    /// also for a TMDB error or rate limit) for 5 minutes. Transport errors are not cached, but when no configured URL
    /// answers at all, reads pause for a minute (a dead Seerr must not hold every pass for the full timeout per path).
    /// A shared fetch is cancelled once every caller waiting for it has given up.
    /// </summary>
    public sealed class ListMetadataService : IListMetadataSource
    {
        /// <summary>Default lifetime of cached Seerr details.</summary>
        public static readonly TimeSpan CacheTtl = TimeSpan.FromHours(12);

        /// <summary>Per-request timeout towards Seerr.</summary>
        public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);

        private static readonly TimeSpan NotFoundTtl = TimeSpan.FromMinutes(30);
        private static readonly TimeSpan UnavailableTtl = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan UnreachableBackoff = TimeSpan.FromMinutes(1);
        private const int MaxCacheEntries = 4000;
        private static readonly Regex ImdbRegex = new("^tt[0-9]{5,10}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex PosterRegex = new("^/[A-Za-z0-9_-]+\\.(jpg|png)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly SemaphoreSlim _concurrency = new(4, 4);
        private readonly ConcurrentDictionary<string, CacheEntry> _cache = new(StringComparer.Ordinal);
        private readonly object _inflightGate = new();
        private readonly Dictionary<string, SharedFetch> _inflight = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, DateTime> _unreachableUntil = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, (string? Poster, DateTime FetchedAtUtc)> _tmdbPosters = new(StringComparer.Ordinal);

        /// <summary>Creates the service (singleton).</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="logger">JE logger.</param>
        public ListMetadataService(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        /// <summary>Per-request timeout of this instance (tests shorten it).</summary>
        internal TimeSpan Timeout { get; set; } = RequestTimeout;

        /// <summary>True when Seerr is configured (metadata can be fetched).</summary>
        public static bool IsAvailable => TryGetSeerrConfig(out _, out _);

        /// <inheritdoc />
        bool IListMetadataSource.Available => IsAvailable;

        /// <inheritdoc />
        bool IListMetadataSource.PostersAvailable => TmdbAvailable;

        /// <summary>
        /// Fetches the metadata a placeholder needs (movie details; TV details + the season's details for season and
        /// episodes kinds). Null when Seerr is off/unreachable, the title is unknown, or it is a custom entry.
        /// </summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="maxAge">Cached data older than this is fetched again.</param>
        /// <param name="todayUtc">Today (UTC), for the aired counts.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The metadata or null.</returns>
        public async Task<PlaceholderMetadata?> FetchAsync(Placeholder placeholder, TimeSpan maxAge, DateTime todayUtc, CancellationToken cancellationToken)
        {
            if (placeholder.Kind == PlaceholderKinds.Custom || placeholder.TmdbId is not > 0 || !IsAvailable)
            {
                return null;
            }

            var id = placeholder.TmdbId.Value.ToString(CultureInfo.InvariantCulture);
            if (placeholder.Kind == PlaceholderKinds.Movie)
            {
                var movie = await ListContinuation.Await(() => GetAsync("/api/v1/movie/" + id, maxAge, cancellationToken)).ConfigureAwait(false);
                return movie == null ? null : FromMovie(movie.Root, movie.FetchedAtUtc);
            }

            var tv = await ListContinuation.Await(() => GetAsync("/api/v1/tv/" + id, maxAge, cancellationToken)).ConfigureAwait(false);
            if (tv == null)
            {
                return null;
            }

            CacheEntry? season = null;
            if (placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && placeholder.SeasonNumber is int number)
            {
                season = await ListContinuation.Await(() => GetAsync("/api/v1/tv/" + id + "/season/" + number.ToString(CultureInfo.InvariantCulture), maxAge, cancellationToken)).ConfigureAwait(false);
            }

            return FromTv(placeholder, tv.Root, season?.Root, tv.FetchedAtUtc < (season?.FetchedAtUtc ?? DateTime.MaxValue) ? tv.FetchedAtUtc : season!.FetchedAtUtc, todayUtc);
        }

        /// <summary>
        /// Merges fetched metadata into a placeholder: release date, poster, TV ids, expected episodes, production state,
        /// aired count and the air dates of listed episodes are authoritative; overview, year and episode titles are only
        /// filled in when missing. The poster is Seerr's for that title, never one a client sent (it could belong to
        /// another title, one a viewer's parental controls hide). Partial metadata (season details unavailable) leaves
        /// the expected set, aired count and episode air dates alone, only fills in a missing poster, only replaces a
        /// release date it knows and never marks the show as no longer in production. The title is never changed.
        /// </summary>
        /// <param name="placeholder">Placeholder (mutable copy).</param>
        /// <param name="metadata">Fetched metadata.</param>
        /// <returns>True when anything changed.</returns>
        public static bool Apply(Placeholder placeholder, PlaceholderMetadata metadata)
        {
            var before = Signature(placeholder);
            if (!metadata.Partial || metadata.ReleaseDate != null)
            {
                placeholder.ReleaseDate = metadata.ReleaseDate;
            }

            if (placeholder.Year == null && metadata.ReleaseDate != null && ListRules.TryParseDate(metadata.ReleaseDate, out var date)
                && date.Year is >= 1870 and <= 2100)
            {
                placeholder.Year = date.Year;
            }

            // An unverified poster (a client's, kept while nothing could check it) always gives way to the server's.
            if (!metadata.Partial || placeholder.PosterPath == null || placeholder.PosterUnverified == true)
            {
                placeholder.PosterPath = metadata.PosterPath;
                placeholder.PosterUnverified = null;
            }

            if (placeholder.Overview == null && !string.IsNullOrEmpty(metadata.Overview))
            {
                placeholder.Overview = metadata.Overview;
            }

            if (metadata.ImdbId != null)
            {
                placeholder.ImdbId = metadata.ImdbId;
            }

            if (placeholder.MediaType == "tv" && metadata.TvdbId is > 0)
            {
                placeholder.TvdbId = metadata.TvdbId;
            }

            if (placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Series)
            {
                if (metadata.Expected != null)
                {
                    placeholder.Expected = metadata.Expected;
                }

                placeholder.EpisodeTotal = metadata.EpisodeTotal ?? placeholder.EpisodeTotal;
            }

            // Partial metadata keeps the stale expected set: "ended" from the show details alone would let that stale
            // set (e.g. undated "TBA" episodes) retire a season, so only "still in production" is taken from it.
            if (placeholder.MediaType == "tv" && metadata.InProduction.HasValue && (!metadata.Partial || metadata.InProduction == true))
            {
                placeholder.InProduction = metadata.InProduction;
            }

            if (placeholder.Kind == PlaceholderKinds.Episodes && metadata.SeasonEpisodes != null)
            {
                foreach (var listed in placeholder.Episodes)
                {
                    var known = metadata.SeasonEpisodes.FirstOrDefault(e => e.S == listed.S && e.E == listed.E);
                    if (known != null)
                    {
                        // C4: TMDB moves (or un-dates) episodes; the stored date must follow, or "aired" counts drift
                        // from the release date refreshed alongside it.
                        listed.Title ??= known.Title;
                        listed.AirDate = known.AirDate;
                    }
                }
            }

            return !string.Equals(before, Signature(placeholder), StringComparison.Ordinal);
        }

        /// <summary>Parses Seerr movie details.</summary>
        /// <param name="movie">JSON.</param>
        /// <param name="fetchedAtUtc">Fetch time.</param>
        /// <returns>Metadata.</returns>
        internal static PlaceholderMetadata FromMovie(JsonElement movie, DateTime fetchedAtUtc)
        {
            var imdb = Str(movie, "imdbId");
            if (imdb == null && movie.TryGetProperty("externalIds", out var external) && external.ValueKind == JsonValueKind.Object)
            {
                imdb = Str(external, "imdbId");
            }

            return new PlaceholderMetadata
            {
                FetchedAtUtc = fetchedAtUtc,
                ReleaseDate = Date(movie, "releaseDate"),
                PosterPath = Poster(movie),
                Overview = Overview(movie),
                ImdbId = imdb != null && ImdbRegex.IsMatch(imdb) ? imdb : null,
            };
        }

        /// <summary>
        /// Parses Seerr TV details (and season details for season/episodes kinds) into the metadata of a TV placeholder:
        /// release date per kind (C4), expected episodes (C3: season details plus an announced next episode of that
        /// season; series: every episode of seasons ≥ 1 from the season episode counts, aired up to the last aired
        /// regular episode, with the last aired episode's date as an "aired by" date), production state (only Ended/Canceled
        /// count as finished) and aired count.
        /// </summary>
        /// <param name="placeholder">Placeholder (kind, season, listed episodes).</param>
        /// <param name="tv">TV details JSON.</param>
        /// <param name="season">Season details JSON (season/episodes kinds), or null.</param>
        /// <param name="fetchedAtUtc">Oldest fetch time of the inputs.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <returns>Metadata.</returns>
        internal static PlaceholderMetadata FromTv(Placeholder placeholder, JsonElement tv, JsonElement? season, DateTime fetchedAtUtc, DateTime todayUtc)
        {
            var status = Str(tv, "status");
            var ended = status is "Ended" or "Canceled" or "Cancelled";

            // C3: only a terminal status finishes a show. TMDB's inProduction flag is often false between the seasons
            // of a renewed show ("Returning Series"), so it only tells that the show was answered for, never that it ended.
            bool? inProduction = ended
                ? false
                : status != null || (tv.TryGetProperty("inProduction", out var production) && production.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    ? true
                    : null;
            string? imdb = null;
            int? tvdb = null;
            if (tv.TryGetProperty("externalIds", out var external) && external.ValueKind == JsonValueKind.Object)
            {
                imdb = Str(external, "imdbId");
                if (external.TryGetProperty("tvdbId", out var tvdbElement) && tvdbElement.ValueKind == JsonValueKind.Number && tvdbElement.TryGetInt32(out var parsed) && parsed > 0)
                {
                    tvdb = parsed;
                }
            }

            var next = Episode(tv, "nextEpisodeToAir");
            var last = Episode(tv, "lastEpisodeToAir");
            var seasons = Seasons(tv);
            var number = placeholder.SeasonNumber;
            string? releaseDate;
            string? poster = Poster(tv);
            string? overview = Overview(tv);
            List<PlaceholderEpisode>? expected = null;
            List<PlaceholderEpisode>? seasonEpisodes = null;
            var partial = false;
            switch (placeholder.Kind)
            {
                case PlaceholderKinds.Series:
                    releaseDate = Date(tv, "firstAirDate");
                    expected = SeriesExpected(seasons, last, next, ended, todayUtc);
                    break;
                case PlaceholderKinds.Season:
                case PlaceholderKinds.Episodes:
                {
                    var seasonInfo = seasons.FirstOrDefault(s => s.Number == number);
                    if (season is JsonElement details && details.ValueKind == JsonValueKind.Object)
                    {
                        seasonEpisodes = SeasonEpisodes(details, number ?? 0);
                        poster = Poster(details) ?? poster;
                    }
                    else
                    {
                        // The season read failed (Seerr relays TMDB errors as 500): never derive the expected set from
                        // the show's details alone, or a hiccup would shrink it and could "complete" an airing season.
                        partial = true;
                    }

                    var seasonAir = season is JsonElement s2 && s2.ValueKind == JsonValueKind.Object ? Date(s2, "airDate") : null;
                    seasonAir ??= seasonInfo?.AirDate;
                    if (placeholder.Kind == PlaceholderKinds.Season)
                    {
                        releaseDate = seasonAir;
                        if (seasonEpisodes != null)
                        {
                            expected = seasonEpisodes.Select(Copy).ToList();
                            if (next != null && next.S == number && !expected.Any(e => e.E == next.E))
                            {
                                expected.Add(next);
                            }

                            expected.Sort((a, b) => a.E.CompareTo(b.E));
                        }
                    }
                    else
                    {
                        // C4: the season read's date of the first listed episode wins even when TMDB un-dated it (Apply
                        // clears the stored one alike); the stored date only stands in when the read didn't list it.
                        var first = placeholder.Episodes.OrderBy(e => e.E).FirstOrDefault();
                        var fresh = first == null ? null : seasonEpisodes?.FirstOrDefault(e => e.E == first.E);
                        releaseDate = (fresh != null ? fresh.AirDate : first?.AirDate) ?? seasonAir;
                    }

                    break;
                }

                default:
                    releaseDate = null;
                    break;
            }

            if (expected != null && expected.Count > PlaceholderProgress.MaxExpected)
            {
                expected = expected.Take(PlaceholderProgress.MaxExpected).ToList();
            }

            return new PlaceholderMetadata
            {
                FetchedAtUtc = fetchedAtUtc,
                ReleaseDate = releaseDate,
                PosterPath = poster,
                Overview = overview,
                ImdbId = imdb != null && ImdbRegex.IsMatch(imdb) ? imdb : null,
                TvdbId = tvdb,
                Expected = expected,
                InProduction = inProduction,
                EpisodeTotal = expected?.Count(e => PlaceholderProgress.IsAired(e, todayUtc)),
                SeasonEpisodes = seasonEpisodes,
                Partial = partial,
                SeasonReadFailed = partial && seasons.Any(s => s.Number == number),
            };
        }

        // Series expected set from the per-season episode counts (no per-season calls): seasons ≥ 1, episodes 1..count.
        // Aired = up to the last aired regular episode (with the last aired episode's date as an "aired by" date); the
        // announced next episode keeps its own date; later ones are unaired (no date). Specials never set the watermark:
        // when the last aired episode is one, the regular episodes before the next regular one have aired, or, without
        // one, every episode of an ended show and of the seasons that have started. An ended show with no last-episode
        // info counts as aired.
        private static List<PlaceholderEpisode> SeriesExpected(List<SeasonInfo> seasons, PlaceholderEpisode? last, PlaceholderEpisode? next, bool ended, DateTime todayUtc)
        {
            var result = new List<PlaceholderEpisode>();
            var lastRegular = last is { S: >= 1 } ? new EpisodeCoord(last.S, last.E) : (EpisodeCoord?)null;
            var nextRegular = next is { S: >= 1 } ? new EpisodeCoord(next.S, next.E) : (EpisodeCoord?)null;
            foreach (var season in seasons.Where(s => s.Number >= 1).OrderBy(s => s.Number))
            {
                var started = season.AirDate != null && ListRules.TryParseDate(season.AirDate, out var premiere) && premiere.Date <= todayUtc.Date;
                for (var e = 1; e <= season.EpisodeCount && result.Count <= PlaceholderProgress.MaxExpected; e++)
                {
                    var coord = new EpisodeCoord(season.Number, e);
                    string? airDate = null;
                    if (lastRegular is EpisodeCoord watermark ? coord.CompareTo(watermark) <= 0
                        : last != null && (nextRegular is EpisodeCoord upcoming ? coord.CompareTo(upcoming) < 0 : ended || started))
                    {
                        airDate = last!.AirDate;
                    }
                    else if (nextRegular == coord)
                    {
                        airDate = next!.AirDate;
                    }
                    else if (last == null && ended)
                    {
                        airDate = season.AirDate;
                    }

                    result.Add(new PlaceholderEpisode { S = coord.S, E = coord.E, AirDate = airDate });
                }
            }

            return result;
        }

        private static List<PlaceholderEpisode> SeasonEpisodes(JsonElement details, int seasonNumber)
        {
            var result = new List<PlaceholderEpisode>();
            if (!details.TryGetProperty("episodes", out var episodes) || episodes.ValueKind != JsonValueKind.Array)
            {
                return result;
            }

            foreach (var episode in episodes.EnumerateArray())
            {
                if (episode.ValueKind != JsonValueKind.Object
                    || !episode.TryGetProperty("episodeNumber", out var n) || n.ValueKind != JsonValueKind.Number || !n.TryGetInt32(out var number) || number < 0)
                {
                    continue;
                }

                var s = episode.TryGetProperty("seasonNumber", out var sn) && sn.ValueKind == JsonValueKind.Number && sn.TryGetInt32(out var parsedSeason) ? parsedSeason : seasonNumber;
                if (s != seasonNumber || result.Any(e => e.E == number))
                {
                    continue;
                }

                var name = ListRules.CleanText(Str(episode, "name"));
                result.Add(new PlaceholderEpisode
                {
                    S = s,
                    E = number,
                    Title = name.Length == 0 ? null : name.Length > ListRules.MaxTitle ? name[..ListRules.MaxTitle] : name,
                    AirDate = Date(episode, "airDate"),
                });
            }

            result.Sort((a, b) => a.E.CompareTo(b.E));
            return result;
        }

        private static PlaceholderEpisode? Episode(JsonElement tv, string name)
        {
            if (!tv.TryGetProperty(name, out var episode) || episode.ValueKind != JsonValueKind.Object
                || !episode.TryGetProperty("seasonNumber", out var s) || s.ValueKind != JsonValueKind.Number || !s.TryGetInt32(out var season)
                || !episode.TryGetProperty("episodeNumber", out var e) || e.ValueKind != JsonValueKind.Number || !e.TryGetInt32(out var number))
            {
                return null;
            }

            return new PlaceholderEpisode { S = season, E = number, AirDate = Date(episode, "airDate") };
        }

        private static List<SeasonInfo> Seasons(JsonElement tv)
        {
            var result = new List<SeasonInfo>();
            if (!tv.TryGetProperty("seasons", out var seasons) || seasons.ValueKind != JsonValueKind.Array)
            {
                return result;
            }

            foreach (var season in seasons.EnumerateArray())
            {
                if (season.ValueKind == JsonValueKind.Object
                    && season.TryGetProperty("seasonNumber", out var n) && n.ValueKind == JsonValueKind.Number && n.TryGetInt32(out var number)
                    && result.All(s => s.Number != number))
                {
                    var count = season.TryGetProperty("episodeCount", out var c) && c.ValueKind == JsonValueKind.Number && c.TryGetInt32(out var parsed) ? Math.Clamp(parsed, 0, 5000) : 0;
                    result.Add(new SeasonInfo(number, count, Date(season, "airDate")));
                }
            }

            return result;
        }

        private static PlaceholderEpisode Copy(PlaceholderEpisode e) => new() { S = e.S, E = e.E, Title = e.Title, AirDate = e.AirDate };

        private static string? Str(JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

        private static string? Date(JsonElement element, string name)
        {
            var value = Str(element, name);
            return value != null && value.Length >= 10 && ListRules.TryParseDate(value[..10], out _) ? value[..10] : null;
        }

        private static string? Poster(JsonElement element)
        {
            var value = Str(element, "posterPath");
            return value != null && PosterRegex.IsMatch(value) ? value : null;
        }

        private static string? Overview(JsonElement element)
        {
            var value = ListRules.CleanText(Str(element, "overview"));
            return value.Length == 0 ? null : value.Length > ListRules.MaxOverview ? value[..ListRules.MaxOverview] : value;
        }

        private static string Signature(Placeholder p) => JsonSerializer.Serialize(new object?[]
        {
            p.ReleaseDate, p.Year, p.PosterPath, p.PosterUnverified, p.Overview, p.ImdbId, p.TvdbId, p.Expected, p.InProduction, p.EpisodeTotal, p.Episodes,
        });

        private async Task<CacheEntry?> GetAsync(string apiPath, TimeSpan maxAge, CancellationToken cancellationToken)
        {
            if (!TryGetSeerrConfig(out var urls, out var apiKey))
            {
                return null;
            }

            var scope = Fingerprint(urls, apiKey);
            var key = scope + apiPath;
            if (_cache.TryGetValue(key, out var cached))
            {
                var ttl = cached.NotFoundFor ?? (maxAge < CacheTtl ? maxAge : CacheTtl);
                if (DateTime.UtcNow - cached.FetchedAtUtc < ttl)
                {
                    return cached.NotFound ? null : cached;
                }
            }

            if (_unreachableUntil.TryGetValue(scope, out var until) && DateTime.UtcNow < until)
            {
                return null; // Seerr didn't answer moments ago: fail fast instead of queueing behind the timeout
            }

            // Single flight per path. The shared fetch caches its own result and removes itself when done (a later call
            // never joins a stale fetch); it is cancelled when every caller waiting for it has given up, which frees its
            // Seerr slot for callers that still wait.
            SharedFetch shared;
            lock (_inflightGate)
            {
                if (!_inflight.TryGetValue(key, out shared!))
                {
                    var fetch = new SharedFetch();
                    // Shared by every caller: never part of (or stopped by) the continuation of the one that started it.
                    using (ListContinuation.Detach())
                    {
                        fetch.Task = Task.Run(() => RunAsync(fetch), CancellationToken.None);
                    }
                    _inflight[key] = shared = fetch;
                }

                shared.Waiters++;
            }

            var completed = false;
            try
            {
                var entry = await ListContinuation.Await(() => shared.Task.WaitAsync(cancellationToken)).ConfigureAwait(false);
                completed = true;
                return entry == null || entry.NotFound ? null : entry;
            }
            finally
            {
                lock (_inflightGate)
                {
                    shared.Waiters--;
                    if (!completed && shared.Waiters == 0 && !shared.Task.IsCompleted)
                    {
                        shared.Cancellation.Cancel();
                        RemoveInflight(key, shared);
                    }
                }
            }

            async Task<CacheEntry?> RunAsync(SharedFetch fetch)
            {
                try
                {
                    var fetched = await FetchFromSeerrAsync(urls, apiKey, apiPath, scope, fetch.Cancellation.Token).ConfigureAwait(false);
                    if (fetched != null)
                    {
                        if (_cache.Count >= MaxCacheEntries)
                        {
                            _cache.Clear();
                        }

                        _cache[key] = fetched;
                    }

                    return fetched;
                }
                catch (OperationCanceledException) when (fetch.Cancellation.IsCancellationRequested)
                {
                    return null; // every caller gave up
                }
                finally
                {
                    lock (_inflightGate)
                    {
                        RemoveInflight(key, fetch);
                    }
                }
            }
        }

        // Caller holds _inflightGate.
        private void RemoveInflight(string key, SharedFetch fetch)
        {
            if (_inflight.TryGetValue(key, out var current) && ReferenceEquals(current, fetch))
            {
                _inflight.Remove(key);
            }
        }

        private async Task<CacheEntry?> FetchFromSeerrAsync(string[] urls, string apiKey, string apiPath, string scope, CancellationToken cancellationToken)
        {
            await _concurrency.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var answered = false;
                foreach (var baseUrl in urls)
                {
                    try
                    {
                        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                        cts.CancelAfter(Timeout);
                        var url = baseUrl + apiPath;
                        var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
                        using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, url, apiKey);
                        using var response = await client.SendAsync(request, cts.Token).ConfigureAwait(false);
                        answered = true;
                        _unreachableUntil.TryRemove(scope, out _);
                        if ((int)response.StatusCode == 404)
                        {
                            return new CacheEntry(default, DateTime.UtcNow, NotFoundTtl);
                        }

                        if ((int)response.StatusCode == 500)
                        {
                            // Seerr answers 500 "Unable to retrieve …" for unknown TMDB ids and seasons, but also when
                            // TMDB failed or rate-limited it: remembered only briefly.
                            return new CacheEntry(default, DateTime.UtcNow, UnavailableTtl);
                        }

                        var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, url, cts.Token).ConfigureAwait(false);
                        if (error != null || json == null)
                        {
                            _logger.Debug($"[Lists] Seerr details {apiPath} failed: {error?.Code}");
                            continue;
                        }

                        using var document = JsonDocument.Parse(json);
                        if (document.RootElement.ValueKind != JsonValueKind.Object)
                        {
                            continue;
                        }

                        return new CacheEntry(document.RootElement.Clone(), DateTime.UtcNow, null);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException)
                    {
                        answered |= ex is JsonException;
                        _logger.Debug($"[Lists] Seerr details {apiPath} failed: {ex.Message}");
                    }
                }

                if (!answered)
                {
                    _unreachableUntil[scope] = DateTime.UtcNow + UnreachableBackoff;
                    _logger.Debug($"[Lists] Seerr didn't answer; metadata reads pause for {UnreachableBackoff.TotalSeconds:0} s.");
                }

                return null;
            }
            finally
            {
                _concurrency.Release();
            }
        }

        /// <summary>True when JE has a TMDB API key (the parental filter then reads ratings from TMDB, Seerr or not).</summary>
        public static bool TmdbAvailable => !string.IsNullOrWhiteSpace(JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey());

        /// <summary>
        /// Reads a TMDB placeholder's poster straight from TMDB with JE's TMDB key (used when Seerr isn't configured):
        /// the title's poster, or the season's for season and episodes kinds (the show's when the season has none).
        /// Cached like Seerr details. Null without a key, for unknown titles and on errors.
        /// </summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The poster path or null.</returns>
        public async Task<string?> FetchTmdbPosterAsync(Placeholder placeholder, CancellationToken cancellationToken) =>
            (await ListContinuation.Await(() => ReadTmdbPosterAsync(placeholder, cancellationToken)).ConfigureAwait(false)).Poster;

        /// <summary>
        /// <see cref="FetchTmdbPosterAsync"/> that also says whether TMDB answered: Answered is true when TMDB read the
        /// title successfully (its poster may still be null: the title has none), false without a key, for a custom
        /// entry and when the lookup failed (HTTP error, timeout, unknown title). A season's poster falls back to the
        /// show's only when TMDB answered for the season (no poster, or no such season); a season read that failed
        /// otherwise is a failed lookup.
        /// </summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The poster path (or null) and whether TMDB answered.</returns>
        public async Task<(string? Poster, bool Answered)> ReadTmdbPosterAsync(Placeholder placeholder, CancellationToken cancellationToken)
        {
            var apiKey = JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey();
            if (placeholder.Kind == PlaceholderKinds.Custom || placeholder.TmdbId is not > 0 || string.IsNullOrWhiteSpace(apiKey))
            {
                return (null, false);
            }

            var id = placeholder.TmdbId.Value.ToString(CultureInfo.InvariantCulture);
            if (placeholder.Kind == PlaceholderKinds.Movie)
            {
                var movie = await ListContinuation.Await(() => TmdbPosterAsync("movie/" + id, apiKey, cancellationToken)).ConfigureAwait(false);
                return (movie.Poster, movie.Answered);
            }

            if (placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && placeholder.SeasonNumber is int number)
            {
                var season = await ListContinuation.Await(() => TmdbPosterAsync("tv/" + id + "/season/" + number.ToString(CultureInfo.InvariantCulture), apiKey, cancellationToken)).ConfigureAwait(false);
                if (season.Poster != null)
                {
                    return (season.Poster, true);
                }

                if (!season.Answered && !season.NotFound)
                {
                    return (null, false); // transient (5xx, 429, timeout): the show's poster would stand in for good
                }
            }

            var show = await ListContinuation.Await(() => TmdbPosterAsync("tv/" + id, apiKey, cancellationToken)).ConfigureAwait(false);
            return (show.Poster, show.Answered);
        }

        // NotFound: TMDB answered 404 (no such title or season), as opposed to a failure that may pass.
        private async Task<(string? Poster, bool Answered, bool NotFound)> TmdbPosterAsync(string apiPath, string apiKey, CancellationToken cancellationToken)
        {
            var key = "tmdb|" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)), 0, 8) + "|" + apiPath;
            if (_tmdbPosters.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.FetchedAtUtc < CacheTtl)
            {
                return (cached.Poster, true, false);
            }

            // The slot is released by its handle, only when its wait succeeded (also when the continuation then stops).
            using var concurrencyTurn = await ListContinuation.AwaitLock(_concurrency, cancellationToken).ConfigureAwait(false);
            // The poster lives from when its read began.
            var readAt = DateTime.UtcNow;
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                cts.CancelAfter(Timeout);
                var client = _httpClientFactory.CreateClient();
                var url = "https://api.themoviedb.org/3/" + apiPath + "?api_key=" + Uri.EscapeDataString(apiKey);
                using var response = await ListContinuation.Await(() => client.GetAsync(url, cts.Token)).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    return (null, false, response.StatusCode == System.Net.HttpStatusCode.NotFound);
                }

                var body = await ListContinuation.Await(() => response.Content.ReadAsStringAsync(cts.Token)).ConfigureAwait(false);
                using var document = JsonDocument.Parse(body);
                var poster = document.RootElement.ValueKind == JsonValueKind.Object ? Str(document.RootElement, "poster_path") : null;
                poster = poster != null && PosterRegex.IsMatch(poster) ? poster : null;
                if (_tmdbPosters.Count >= MaxCacheEntries)
                {
                    _tmdbPosters.Clear();
                }

                _tmdbPosters[key] = (poster, readAt);
                return (poster, true, false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException)
            {
                _logger.Debug($"[Lists] TMDB poster {apiPath} failed: {ex.Message}");
                return (null, false, false);
            }
        }

        private static bool TryGetSeerrConfig(out string[] urls, out string apiKey)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            urls = Array.Empty<string>();
            apiKey = string.Empty;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()))
            {
                return false;
            }

            urls = config.JellyseerrUrls
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/'))
                .Where(u => u.Length > 0)
                .ToArray();
            apiKey = config.GetJellyseerrApiKey();
            return urls.Length > 0;
        }

        // Cache scope = Seerr URL list + API key hash, so another Seerr's answers are never reused.
        private static string Fingerprint(string[] urls, string apiKey) =>
            string.Join('\n', urls) + "|" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)), 0, 8) + "|";

        // NotFoundFor: a "not found" answer and how long it is remembered (null = details).
        private sealed record CacheEntry(JsonElement Root, DateTime FetchedAtUtc, TimeSpan? NotFoundFor)
        {
            public bool NotFound => NotFoundFor.HasValue;
        }

        private sealed class SharedFetch
        {
            public CancellationTokenSource Cancellation { get; } = new();

            public Task<CacheEntry?> Task { get; set; } = null!;

            public int Waiters { get; set; }
        }

        private sealed record SeasonInfo(int Number, int EpisodeCount, string? AirDate);
    }
}
