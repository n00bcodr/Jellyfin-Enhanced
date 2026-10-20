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
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;

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
        /// The poster is a proven answer although the rest is partial (a Valid TMDB poster read, review round 7): it replaces
        /// an unverified or missing poster, also when it is null (the title has none). Partial metadata otherwise never
        /// clears a poster.
        /// </summary>
        public bool PosterAnswered { get; init; }

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
                var movie = await ListContinuation.Await(() => GetAsync("/api/v1/movie/" + id, new AnswerRequest(placeholder.TmdbId, "movie") { Kind = ResponseContract.MetadataMovie.Name }, maxAge, cancellationToken)).ConfigureAwait(false);
                return movie?.Read == null ? null : FromMovie(movie.Read, movie.FetchedAtUtc);
            }

            var tv = await ListContinuation.Await(() => GetAsync("/api/v1/tv/" + id, new AnswerRequest(placeholder.TmdbId, "tv") { Kind = ResponseContract.MetadataShow.Name }, maxAge, cancellationToken)).ConfigureAwait(false);
            if (tv?.Read == null)
            {
                return null;
            }

            CacheEntry? season = null;
            if (placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && placeholder.SeasonNumber is int number)
            {
                season = await ListContinuation.Await(() => GetAsync("/api/v1/tv/" + id + "/season/" + number.ToString(CultureInfo.InvariantCulture), new AnswerRequest(Season: number, Show: placeholder.TmdbId) { Kind = ResponseContract.MetadataSeason.Name }, maxAge, cancellationToken)).ConfigureAwait(false);
            }

            return FromTv(placeholder, tv.Read, season?.Read, tv.FetchedAtUtc < (season?.FetchedAtUtc ?? DateTime.MaxValue) ? tv.FetchedAtUtc : season!.FetchedAtUtc, todayUtc);
        }

        /// <summary>
        /// Merges fetched metadata into a placeholder: release date, poster, TV ids, expected episodes, production state,
        /// aired count and the air dates of listed episodes are authoritative; overview, year and episode titles are only
        /// filled in when missing. The poster is Seerr's for that title, never one a client sent (it could belong to
        /// another title, one a viewer's parental controls hide). Partial metadata (season details unavailable) leaves
        /// the expected set, aired count and episode air dates alone, only fills in a missing poster, only replaces a
        /// release date it knows and never marks the show as no longer in production. The title is never changed. Review round
        /// 7 (4c2-R7-3): metadata read from an answer that isn't Valid by its contract is partial too, so it never clears a
        /// stored value (a poster included).
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

            // An unverified poster (a client's, kept while nothing could check it) always gives way to the server's; partial
            // metadata only ever fills one in (it never clears one), unless its poster is a proven answer.
            if (!metadata.Partial || ((metadata.PosterPath != null || metadata.PosterAnswered) && (placeholder.PosterPath == null || placeholder.PosterUnverified == true)))
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

        /// <summary>
        /// Movie details as their contract read them (<see cref="ResponseContract.MetadataMovie"/>; Seerr's, or TMDB's in Seerr's
        /// names). Review round 8 (4c2-R8-1): only the contract's typed values are used, never the JSON again, so a value the
        /// contract couldn't use is no value AND made the answer partial; anything but a Valid answer is partial metadata.
        /// </summary>
        /// <param name="movie">The read answer.</param>
        /// <param name="fetchedAtUtc">Fetch time.</param>
        /// <returns>Metadata.</returns>
        internal static PlaceholderMetadata FromMovie(ContractRead movie, DateTime fetchedAtUtc) => new()
        {
            FetchedAtUtc = fetchedAtUtc,
            ReleaseDate = movie.Date("releaseDate"),
            PosterPath = movie.Poster("posterPath"),
            Overview = Clip(movie.Text("overview"), ListRules.MaxOverview),
            ImdbId = movie.Imdb("imdbId") ?? movie.Member("externalIds")?.Imdb("imdbId"),
            Partial = movie.Verdict != ResponseVerdict.Valid,
        };

        /// <summary>Movie details JSON, read by their contract first (against the entry's title: review round 9).</summary>
        /// <param name="movie">JSON.</param>
        /// <param name="fetchedAtUtc">Fetch time.</param>
        /// <param name="tmdbId">The title asked for (null: any).</param>
        /// <returns>Metadata.</returns>
        internal static PlaceholderMetadata FromMovie(JsonElement movie, DateTime fetchedAtUtc, int? tmdbId = null) =>
            FromMovie(ResponseContract.MetadataMovie.Validate(new AnswerRequest(tmdbId, "movie"), movie), fetchedAtUtc);

        /// <summary>TV details JSON (and season JSON), read by their contracts first (against the entry's show and season).</summary>
        /// <param name="placeholder">Placeholder.</param>
        /// <param name="tv">TV details JSON.</param>
        /// <param name="season">Season details JSON, or null.</param>
        /// <param name="fetchedAtUtc">Oldest fetch time of the inputs.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <returns>Metadata.</returns>
        internal static PlaceholderMetadata FromTv(Placeholder placeholder, JsonElement tv, JsonElement? season, DateTime fetchedAtUtc, DateTime todayUtc) =>
            FromTv(
                placeholder,
                ResponseContract.MetadataShow.Validate(new AnswerRequest(placeholder.TmdbId, "tv"), tv),
                season is JsonElement s ? ResponseContract.MetadataSeason.Validate(new AnswerRequest(Season: placeholder.SeasonNumber, Show: placeholder.TmdbId), s) : null,
                fetchedAtUtc,
                todayUtc);

        /// <summary>
        /// TV details (and season details for season/episodes kinds) as their contracts read them
        /// (<see cref="ResponseContract.MetadataShow"/>, <see cref="ResponseContract.MetadataSeason"/>; typed values only, review
        /// round 8) into the metadata of a TV placeholder: release date per kind (C4), expected episodes (C3: season details
        /// plus an announced next episode of that season; series: every episode of seasons ≥ 1 from the season episode counts,
        /// aired up to the last aired regular episode, with the last aired episode's date as an "aired by" date), production
        /// state (only Ended/Canceled count as finished) and aired count. A show answer that isn't Valid is partial (review
        /// round 7: it never sets the expected episodes or clears a value); a season answer that isn't Valid is used like a
        /// failed season read.
        /// </summary>
        /// <param name="placeholder">Placeholder (kind, season, listed episodes).</param>
        /// <param name="tv">The read TV details.</param>
        /// <param name="season">The read season details (season/episodes kinds), or null.</param>
        /// <param name="fetchedAtUtc">Oldest fetch time of the inputs.</param>
        /// <param name="todayUtc">Today (UTC).</param>
        /// <returns>Metadata.</returns>
        internal static PlaceholderMetadata FromTv(Placeholder placeholder, ContractRead tv, ContractRead? season, DateTime fetchedAtUtc, DateTime todayUtc)
        {
            if (season != null && season.Verdict != ResponseVerdict.Valid)
            {
                season = null; // review round 7: never sets the expected episodes or their air dates
            }

            var status = tv.Text("status");
            var ended = status is "Ended" or "Canceled" or "Cancelled";

            // C3: only a terminal status finishes a show. TMDB's inProduction flag is often false between the seasons
            // of a renewed show ("Returning Series"), so it only tells that the show was answered for, never that it ended.
            bool? inProduction = ended ? false : status != null || tv.Bool("inProduction").HasValue ? true : null;
            var external = tv.Member("externalIds");
            var next = Episode(tv.Member("nextEpisodeToAir"));
            var last = Episode(tv.Member("lastEpisodeToAir"));
            var seasons = Seasons(tv);
            var number = placeholder.SeasonNumber;
            string? releaseDate;
            var poster = tv.Poster("posterPath");
            var overview = Clip(tv.Text("overview"), ListRules.MaxOverview);
            List<PlaceholderEpisode>? expected = null;
            List<PlaceholderEpisode>? seasonEpisodes = null;
            var partial = false;
            switch (placeholder.Kind)
            {
                case PlaceholderKinds.Series:
                    releaseDate = tv.Date("firstAirDate");
                    expected = SeriesExpected(seasons, last, next, ended, todayUtc);
                    break;
                case PlaceholderKinds.Season:
                case PlaceholderKinds.Episodes:
                {
                    var seasonInfo = seasons.FirstOrDefault(s => s.Number == number);
                    if (season != null)
                    {
                        seasonEpisodes = SeasonEpisodes(season, number ?? 0);
                        poster = season.Poster("posterPath") ?? poster;
                    }
                    else
                    {
                        // The season read failed (Seerr relays TMDB errors as 500): never derive the expected set from
                        // the show's details alone, or a hiccup would shrink it and could "complete" an airing season.
                        partial = true;
                    }

                    var seasonAir = season?.Date("airDate") ?? seasonInfo?.AirDate;
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

            var seasonFailed = partial;
            if (tv.Verdict != ResponseVerdict.Valid)
            {
                // Review round 7 (4c2-R7-3): a show answer that isn't Valid (a season list, an episode count, the status or
                // an id unknown) never derives the expected episodes or their air dates, and never clears a value.
                partial = true;
                expected = null;
                seasonEpisodes = null;
            }

            var tvdb = external?.Int("tvdbId");
            return new PlaceholderMetadata
            {
                FetchedAtUtc = fetchedAtUtc,
                ReleaseDate = releaseDate,
                PosterPath = poster,
                Overview = overview,
                ImdbId = external?.Imdb("imdbId"),
                TvdbId = tvdb is > 0 ? tvdb : null,
                Expected = expected,
                InProduction = inProduction,
                EpisodeTotal = expected?.Count(e => PlaceholderProgress.IsAired(e, todayUtc)),
                SeasonEpisodes = seasonEpisodes,
                Partial = partial,
                SeasonReadFailed = seasonFailed && seasons.Any(s => s.Number == number),
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

        // The season's episodes (the contract read every row: each has its episode number).
        private static List<PlaceholderEpisode> SeasonEpisodes(ContractRead details, int seasonNumber)
        {
            var result = new List<PlaceholderEpisode>();
            foreach (var episode in details.Rows("episodes"))
            {
                if (episode.Int("episodeNumber") is not int number)
                {
                    continue;
                }

                var s = episode.Int("seasonNumber") ?? seasonNumber;
                if (s != seasonNumber || result.Any(e => e.E == number))
                {
                    continue;
                }

                result.Add(new PlaceholderEpisode
                {
                    S = s,
                    E = number,
                    Title = Clip(episode.Text("name"), ListRules.MaxTitle),
                    AirDate = episode.Date("airDate"),
                });
            }

            result.Sort((a, b) => a.E.CompareTo(b.E));
            return result;
        }

        private static PlaceholderEpisode? Episode(ContractRead? episode) =>
            episode?.Int("seasonNumber") is int season && episode.Int("episodeNumber") is int number
                ? new PlaceholderEpisode { S = season, E = number, AirDate = episode.Date("airDate") }
                : null;

        private static List<SeasonInfo> Seasons(ContractRead tv)
        {
            var result = new List<SeasonInfo>();
            foreach (var season in tv.Rows("seasons"))
            {
                if (season.Int("seasonNumber") is int number && result.All(s => s.Number != number))
                {
                    result.Add(new SeasonInfo(number, Math.Clamp(season.Int("episodeCount") ?? 0, 0, 5000), season.Date("airDate")));
                }
            }

            return result;
        }

        private static PlaceholderEpisode Copy(PlaceholderEpisode e) => new() { S = e.S, E = e.E, Title = e.Title, AirDate = e.AirDate };

        private static string? Clip(string? text, int max) => string.IsNullOrEmpty(text) ? null : text.Length > max ? text[..max] : text;

        private static string Signature(Placeholder p) => JsonSerializer.Serialize(new object?[]
        {
            p.ReleaseDate, p.Year, p.PosterPath, p.PosterUnverified, p.Overview, p.ImdbId, p.TvdbId, p.Expected, p.InProduction, p.EpisodeTotal, p.Episodes,
        });

        private async Task<CacheEntry?> GetAsync(string apiPath, AnswerRequest asked, TimeSpan maxAge, CancellationToken cancellationToken)
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
                    var fetched = await FetchFromSeerrAsync(urls, apiKey, apiPath, asked, scope, fetch.Cancellation.Token).ConfigureAwait(false);
                    if (fetched != null && fetched.Verdict == ResponseVerdict.Valid)
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

        // Every configured server in order by THE fallback table (SeerrFallback, review round 9): a Valid answer by the
        // resource's contract AND the request (the title, show or season asked for: 4c2-R9-1/2) is used; a Partial one is
        // used (never kept) only when no later server answers in full; a Malformed answer (`{}` included: 4c2-R7-3; another
        // title's or season's), an error, a timeout or a 5xx is no proof of anything and the next server is asked; "not
        // found" only when EVERY server answered 404 (a stale address, or a proxy without Seerr's route, answers 404 too).
        // When nothing better came of it, a read whose only failures were Seerr's 500 ("Unable to retrieve …", for unknown
        // ids but also when TMDB failed behind it) is remembered as unknown for a few minutes (never as an absence), and a
        // read no server answered at all pauses reads for a minute. Each request takes its own Seerr slot.
        private async Task<CacheEntry?> FetchFromSeerrAsync(string[] urls, string apiKey, string apiPath, AnswerRequest asked, string scope, CancellationToken cancellationToken)
        {
            var answered = false;
            var only500 = true;
            var schema = SchemaOf(apiPath);
            var read = await SeerrFallback.ReadAsync<CacheEntry>(urls, async (baseUrl, index) =>
            {
                await _concurrency.WaitAsync(cancellationToken).ConfigureAwait(false);
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
                    switch ((int)response.StatusCode)
                    {
                        case 404 when ProviderAbsence.Seerr(404):
                            return new ServerAnswer<CacheEntry>(ServerState.NotFound);
                        case 404:
                            // Review round 10 (ProviderAbsence.Seerr): Seerr's unknown-route answer (a wrong address or a proxy),
                            // never "no such title": that server's failure.
                            only500 = false;
                            return new ServerAnswer<CacheEntry>(ServerState.Unavailable);
                        case >= 500:
                            only500 &= (int)response.StatusCode == 500;
                            return new ServerAnswer<CacheEntry>(ServerState.Unavailable);
                    }

                    var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, url, cts.Token).ConfigureAwait(false);
                    if (error != null || json == null)
                    {
                        only500 = false;
                        _logger.Debug($"[Lists] Seerr details {apiPath} failed: {error?.Code}");
                        return new ServerAnswer<CacheEntry>(ServerState.Unavailable);
                    }

                    using var document = JsonDocument.Parse(json);
                    var answer = schema.Validate(asked, document.RootElement);
                    if (answer.Verdict == ResponseVerdict.Malformed)
                    {
                        only500 = false;
                        _logger.Debug($"[Lists] Seerr details {apiPath} answered something JE can't read ({answer.Reason})");
                        return new ServerAnswer<CacheEntry>(ServerState.Malformed);
                    }

                    var entry = new CacheEntry(answer, DateTime.UtcNow, null) { Verdict = answer.Verdict };
                    if (answer.Verdict != ResponseVerdict.Valid)
                    {
                        _logger.Debug($"[Lists] Seerr details {apiPath} answered in part ({answer.Reason}); asking the next server");
                        return new ServerAnswer<CacheEntry>(ServerState.Partial, entry);
                    }

                    return new ServerAnswer<CacheEntry>(ServerState.Valid, entry);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    only500 = false;
                    answered |= ex is JsonException;
                    _logger.Debug($"[Lists] Seerr details {apiPath} failed: {UpstreamDiagnostics.Code(ex)}");
                    return new ServerAnswer<CacheEntry>(ex is JsonException ? ServerState.Malformed : ServerState.Unavailable);
                }
                finally
                {
                    _concurrency.Release();
                }
            }).ConfigureAwait(false);

            switch (read.State)
            {
                case FallbackState.Valid or FallbackState.Partial:
                    return read.Value;
                case FallbackState.NotFound:
                    return new CacheEntry(null, DateTime.UtcNow, NotFoundTtl);
            }

            if (!answered)
            {
                _unreachableUntil[scope] = DateTime.UtcNow + UnreachableBackoff;
                _logger.Debug($"[Lists] Seerr didn't answer; metadata reads pause for {UnreachableBackoff.TotalSeconds:0} s.");
            }

            // Unknown (never an absence): only Seerr's own 500s, beside 404s, are remembered briefly; anything else is asked again.
            return answered && only500 && read.Servers.Contains(ServerState.Unavailable) ? new CacheEntry(null, DateTime.UtcNow, UnavailableTtl) : null;
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
                var movie = await ListContinuation.Await(() => TmdbPosterAsync("movie/" + id, new AnswerRequest(placeholder.TmdbId), apiKey, cancellationToken)).ConfigureAwait(false);
                return (movie.Poster, movie.Answered);
            }

            if (placeholder.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && placeholder.SeasonNumber is int number)
            {
                var season = await ListContinuation.Await(() => TmdbPosterAsync("tv/" + id + "/season/" + number.ToString(CultureInfo.InvariantCulture), new AnswerRequest(Season: number, Show: placeholder.TmdbId), apiKey, cancellationToken)).ConfigureAwait(false);
                if (season.Poster != null)
                {
                    return (season.Poster, true);
                }

                if (!season.Answered && !season.NotFound)
                {
                    return (null, false); // transient (5xx, 429, timeout): the show's poster would stand in for good
                }
            }

            var show = await ListContinuation.Await(() => TmdbPosterAsync("tv/" + id, new AnswerRequest(placeholder.TmdbId), apiKey, cancellationToken)).ConfigureAwait(false);
            return (show.Poster, show.Answered);
        }

        // The contract of a Seerr metadata resource by its path (movie, show or season).
        private static ResourceSchema SchemaOf(string apiPath) =>
            apiPath.StartsWith("/api/v1/movie/", StringComparison.Ordinal) ? ResponseContract.MetadataMovie
            : apiPath.Contains("/season/", StringComparison.Ordinal) ? ResponseContract.MetadataSeason
            : ResponseContract.MetadataShow;

        // NotFound: TMDB answered 404 (no such title or season), as opposed to a failure that may pass.
        private async Task<(string? Poster, bool Answered, bool NotFound)> TmdbPosterAsync(string apiPath, AnswerRequest asked, string apiKey, CancellationToken cancellationToken)
        {
            var key = "tmdb|" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)), 0, 8) + "|" + apiPath;
            if (_tmdbPosters.TryGetValue(key, out var cached) && DateTime.UtcNow - cached.FetchedAtUtc < CacheTtl)
            {
                return (cached.Poster, true, false);
            }

            // The slot is released by its handle, only when its wait succeeded (also when the continuation then stops).
            using var concurrencyTurn = await ListContinuation.AwaitLock(_concurrency, cancellationToken).ConfigureAwait(false);
            try
            {
                using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                cts.CancelAfter(Timeout);
                // The source transport (no redirects, public addresses only), like every TMDB read of the lists subsystem.
                var client = _httpClientFactory.CreateClient(SourceHttp.ClientName);
                var url = "https://api.themoviedb.org/3/" + apiPath + "?api_key=" + Uri.EscapeDataString(apiKey);
                using var response = await ListContinuation.Await(() => client.GetAsync(url, cts.Token)).ConfigureAwait(false);
                if (!response.IsSuccessStatusCode)
                {
                    // Review round 10 (ProviderAbsence.Tmdb): "no such title or season" only from TMDB's own 404 (its error
                    // object); a proxy's 404 is a failed read (a season's would let the show's poster stand in).
                    var error = response.StatusCode == System.Net.HttpStatusCode.NotFound
                        ? await ListContinuation.Await(() => response.Content.ReadAsStringAsync(cts.Token)).ConfigureAwait(false)
                        : null;
                    return (null, false, ProviderAbsence.Tmdb((int)response.StatusCode, error));
                }

                var body = await ListContinuation.Await(() => response.Content.ReadAsStringAsync(cts.Token)).ConfigureAwait(false);
                using var document = JsonDocument.Parse(body);
                // Review rounds 6 and 7 (ResponseContract.TmdbPoster): "no poster" needs TMDB's answer to say so (poster_path
                // there, a path or null); an answer that isn't Valid is a failed read, never remembered (a season's would let
                // the show's poster stand in). Review round 10 (4c2-R10-4): bound to the title (`id`) or the season
                // (`season_number`, every episode's `show_id`) asked for: an answer without that identity is unbound, not "no poster".
                var read = ResponseContract.TmdbPoster.Validate(asked, document.RootElement);
                if (read.Verdict != ResponseVerdict.Valid)
                {
                    _logger.Debug($"[Lists] TMDB poster {apiPath} answered something JE can't read ({read.Reason})");
                    return (null, false, false);
                }

                var poster = read.Poster("poster_path"); // the contract's typed value (review round 8)
                if (_tmdbPosters.Count >= MaxCacheEntries)
                {
                    _tmdbPosters.Clear();
                }

                _tmdbPosters[key] = (poster, DateTime.UtcNow);
                return (poster, true, false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                _logger.Debug($"[Lists] TMDB poster {apiPath} failed: {UpstreamDiagnostics.Code(ex)}");
                return (null, false, false);
            }
        }

        // The address list every Seerr-backed read of the lists area takes (review round 8, 4c2-R8-4).
        private static bool TryGetSeerrConfig(out string[] urls, out string apiKey) => SeerrAddresses.TryGet(out urls, out apiKey);

        // Cache scope = Seerr URL list + API key hash, so another Seerr's answers are never reused.
        private static string Fingerprint(string[] urls, string apiKey) => SeerrAddresses.Identity(urls, apiKey) + "|";

        // Read: the answer as its contract read it (its typed values; null for "not found" and "unavailable"). NotFoundFor: a
        // "not found" answer and how long it is remembered (null = details). Verdict: the answer's by its contract (only a
        // Valid one is cached).
        private sealed record CacheEntry(ContractRead? Read, DateTime FetchedAtUtc, TimeSpan? NotFoundFor)
        {
            public bool NotFound => NotFoundFor.HasValue;

            public ResponseVerdict Verdict { get; init; } = ResponseVerdict.Valid;
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
