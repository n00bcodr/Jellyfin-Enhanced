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

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>Outcome class of one lookup.</summary>
    public enum LookupStatus
    {
        /// <summary>Answered (an empty search result is still Ok; see the resolver's retry).</summary>
        Ok,

        /// <summary>Definitely not there (unknown season, unknown TMDB find id).</summary>
        NotFound,

        /// <summary>Timeout, Seerr/TMDB error: try again later. Never cached.</summary>
        Transient,
    }

    /// <summary>A lookup result.</summary>
    /// <typeparam name="T">Value type.</typeparam>
    /// <param name="Status">Status.</param>
    /// <param name="Value">Value when Ok.</param>
    public sealed record LookupResult<T>(LookupStatus Status, T? Value)
    {
        /// <summary>A transient failure.</summary>
        public static LookupResult<T> Transient { get; } = new(LookupStatus.Transient, default);

        /// <summary>A definite miss.</summary>
        public static LookupResult<T> NotFound { get; } = new(LookupStatus.NotFound, default);

        /// <summary>
        /// What the answer behind an Ok or NotFound result is worth (review round 7, <see cref="ResponseContract"/>): Valid
        /// (definitive), or Partial (usable, but never proof that something is absent: a season or episode missing from it,
        /// an id it doesn't carry).
        /// </summary>
        public ResponseVerdict Verdict { get; init; } = ResponseVerdict.Valid;
    }

    /// <summary>
    /// One upstream answer as an import lookup read it (review round 6, D53 "NotFound = proven absence"; review round 7, one
    /// contract per resource): its status, its value and its <see cref="ResponseVerdict"/>. Only a Valid answer is
    /// cached (and only when the resource's policy keeps it); "not found" or "no titles" needs a Valid answer from every
    /// source asked.
    /// </summary>
    /// <param name="Status">Status.</param>
    /// <param name="Value">Value when Ok.</param>
    /// <param name="Verdict">What the answer is worth (Malformed answers are Transient).</param>
    /// <param name="Keep">The resource's policy keeps a Valid answer (Seerr's empty search is never kept).</param>
    internal readonly record struct LookupAnswer(LookupStatus Status, object? Value, ResponseVerdict Verdict, bool Keep = true)
    {
        /// <summary>A failure, or an answer that proves nothing: asked again next time.</summary>
        public static LookupAnswer Transient => new(LookupStatus.Transient, null, ResponseVerdict.Malformed);

        /// <summary>A proven absence (TMDB's or every Seerr server's 404, an episode find's valid empty list).</summary>
        public static LookupAnswer NotFound => new(LookupStatus.NotFound, null, ResponseVerdict.Valid);

        /// <summary>A Valid answer: definitive (the TMDB response cache keeps it).</summary>
        public bool Definitive => Verdict == ResponseVerdict.Valid && Status != LookupStatus.Transient;

        /// <summary>Remembered: a definitive answer its resource keeps (a transient one never is).</summary>
        public bool Remembered => Definitive && Keep && (Status == LookupStatus.NotFound || Value != null);

        /// <summary>An answer.</summary>
        /// <param name="value">Value.</param>
        /// <param name="verdict">Its verdict (Malformed makes it Transient).</param>
        /// <returns>The answer.</returns>
        public static LookupAnswer Ok(object value, ResponseVerdict verdict = ResponseVerdict.Valid) =>
            verdict == ResponseVerdict.Malformed ? Transient : new(LookupStatus.Ok, value, verdict);

        /// <summary>The lookup result of this answer.</summary>
        /// <typeparam name="T">Value type.</typeparam>
        /// <returns>The result.</returns>
        public LookupResult<T> Result<T>() => new(Status, Status == LookupStatus.Ok ? (T?)Value : default) { Verdict = Verdict };
    }

    /// <summary>How one row of a search answer read (review round 6).</summary>
    internal enum RowRead
    {
        /// <summary>A title.</summary>
        Hit,

        /// <summary>A valid row deliberately left out: an adult title, a person or another kind that isn't a title.</summary>
        Dropped,

        /// <summary>A row JE can't read (not an object, no type, no id or no title): the answer isn't whole.</summary>
        Unusable,
    }

    /// <summary>
    /// The closed allowlists of a search row's declared media type (review round 9, D53; 4c2-R9-6): a title type is read
    /// ("movie", "tv"); a deliberately unsupported type, named here, is a valid row left out; any other type is a row JE can't
    /// read (the answer is not whole: never kept, never "no titles").
    /// </summary>
    internal static class TitleTypes
    {
        /// <summary>TMDB's search/multi: people are left out (it returns movies, shows and people only).</summary>
        public static readonly IReadOnlySet<string> TmdbExcluded = new HashSet<string>(StringComparer.Ordinal) { "person" };

        /// <summary>Seerr's search: people and collections are left out.</summary>
        public static readonly IReadOnlySet<string> SeerrExcluded = new HashSet<string>(StringComparer.Ordinal) { "person", "collection" };

        /// <summary>The class of a row by its declared type: null for a title type (read it), else Dropped or Unusable.</summary>
        /// <param name="type">The declared type.</param>
        /// <param name="excluded">The provider's named exclusions.</param>
        /// <returns>Null, or the row's class.</returns>
        public static RowRead? Classify(string type, IReadOnlySet<string> excluded) =>
            type is "movie" or "tv" ? null : excluded.Contains(type) ? RowRead.Dropped : RowRead.Unusable;
    }

    /// <summary>A sanitized TMDB title as Seerr returns it in search results and details.</summary>
    /// <param name="MediaType">"movie" or "tv".</param>
    /// <param name="TmdbId">TMDB id.</param>
    /// <param name="Title">Title / name.</param>
    /// <param name="OriginalTitle">Original title / name.</param>
    /// <param name="ReleaseDate">Release / first-air date (yyyy-MM-dd) or null.</param>
    /// <param name="PosterPath">TMDB poster path (validated) or null.</param>
    /// <param name="Overview">Overview (≤ 300 chars) or null.</param>
    /// <param name="Popularity">TMDB popularity.</param>
    /// <param name="VoteCount">TMDB vote count.</param>
    public sealed record TitleHit(string MediaType, int TmdbId, string Title, string? OriginalTitle, string? ReleaseDate, string? PosterPath, string? Overview, double Popularity, int VoteCount)
    {
        /// <summary>Year of <see cref="ReleaseDate"/>.</summary>
        public int? Year => ReleaseDate != null && ReleaseDate.Length >= 4 && int.TryParse(ReleaseDate.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var y) ? y : null;
    }

    /// <summary>One season of a TV title.</summary>
    /// <param name="SeasonNumber">Season number.</param>
    /// <param name="EpisodeCount">TMDB episode count.</param>
    /// <param name="AirDate">Air date or null.</param>
    /// <param name="Name">Name.</param>
    public sealed record SeasonFacts(int SeasonNumber, int? EpisodeCount, string? AirDate, string? Name);

    /// <summary>Details of a movie or TV title.</summary>
    /// <param name="Hit">Common title facts.</param>
    /// <param name="ImdbId">IMDb id.</param>
    /// <param name="TvdbId">TVDB id (TV).</param>
    /// <param name="Status">TMDB status text.</param>
    /// <param name="InProduction">TV: still in production.</param>
    /// <param name="Seasons">TV seasons.</param>
    public sealed record TitleDetails(TitleHit Hit, string? ImdbId, int? TvdbId, string? Status, bool? InProduction, IReadOnlyList<SeasonFacts> Seasons)
    {
        /// <summary>
        /// What the details answer is worth (review round 7): only Valid details prove their ids (an id they don't carry
        /// is absent) and their season list (a season they don't list is missing).
        /// </summary>
        public ResponseVerdict Verdict { get; init; } = ResponseVerdict.Valid;
    }

    /// <summary>One episode of a season.</summary>
    /// <param name="Season">Season.</param>
    /// <param name="Episode">Episode.</param>
    /// <param name="Title">Title.</param>
    /// <param name="AirDate">Air date.</param>
    public sealed record EpisodeFacts(int Season, int Episode, string? Title, string? AirDate);

    /// <summary>An IMDb episode id resolved through TMDB /find.</summary>
    /// <param name="ShowTmdbId">The series' TMDB id.</param>
    /// <param name="Season">Season.</param>
    /// <param name="Episode">Episode.</param>
    /// <param name="Title">Episode title.</param>
    /// <param name="AirDate">Air date.</param>
    public sealed record ImdbEpisodeFind(int ShowTmdbId, int Season, int Episode, string? Title, string? AirDate);

    /// <summary>Who a lookup runs for (limiter fairness) plus a per-request counter of upstream calls.</summary>
    public sealed class ImportCallContext
    {
        private int _calls;

        /// <summary>Creates a context.</summary>
        /// <param name="owner">Fairness owner (user id or job id).</param>
        /// <param name="background">Background priority (scheduled sync).</param>
        public ImportCallContext(string owner, bool background)
        {
            Owner = owner;
            Background = background;
        }

        /// <summary>Fairness owner.</summary>
        public string Owner { get; }

        /// <summary>Background priority.</summary>
        public bool Background { get; }

        /// <summary>Upstream calls this context started (cache hits and joined in-flight calls excluded).</summary>
        public int Calls => Volatile.Read(ref _calls);

        /// <summary>Counts one upstream call.</summary>
        public void CountCall() => Interlocked.Increment(ref _calls);
    }

    /// <summary>
    /// The Seerr (and TMDB /find) lookups the import resolver and the linked-list sync need, behind one seam so the
    /// resolver logic is testable without HTTP. Production: <see cref="SeerrImportLookup"/>.
    /// </summary>
    public interface IImportLookup
    {
        /// <summary>True when titles can be looked up.</summary>
        bool IsConfigured { get; }

        /// <summary>Where titles are looked up: <c>tmdb</c> or <c>seerr</c>.</summary>
        string Provider => "seerr";

        /// <summary>True when IMDb episode ids can be resolved (TMDB API key configured).</summary>
        bool CanFindImdbEpisodes { get; }

        /// <summary>Seerr <c>/api/v1/search</c> (page 1) — plain titles, <c>title year:YYYY</c>, <c>tmdb:</c>/<c>imdb:</c>/<c>tvdb:</c> prefixes.</summary>
        /// <param name="query">Query.</param>
        /// <param name="context">Caller context.</param>
        /// <param name="cancellationToken">Stops this caller waiting.</param>
        /// <returns>Movie and TV hits.</returns>
        Task<LookupResult<IReadOnlyList<TitleHit>>> SearchAsync(string query, ImportCallContext context, CancellationToken cancellationToken);

        /// <summary>Seerr <c>/api/v1/movie/{id}</c> or <c>/api/v1/tv/{id}</c>.</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <param name="context">Caller context.</param>
        /// <param name="cancellationToken">Stops this caller waiting.</param>
        /// <returns>Details.</returns>
        Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken);

        /// <summary>Seerr <c>/api/v1/tv/{id}/season/{n}</c>.</summary>
        /// <param name="tvTmdbId">Series TMDB id.</param>
        /// <param name="season">Season number.</param>
        /// <param name="context">Caller context.</param>
        /// <param name="cancellationToken">Stops this caller waiting.</param>
        /// <returns>Episodes (NotFound on 404; Seerr's 500 for any season failure is transient).</returns>
        Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken);

        /// <summary>TMDB <c>/find/{tt}?external_source=imdb_id</c> for an IMDb EPISODE id (Seerr drops episode results).</summary>
        /// <param name="imdbId">IMDb id.</param>
        /// <param name="context">Caller context (the shared limiter's owner and priority).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The episode coordinates (NotFound when unknown or without a TMDB key).</returns>
        Task<LookupResult<ImdbEpisodeFind>> FindImdbEpisodeAsync(string imdbId, ImportCallContext context, CancellationToken cancellationToken);
    }

    /// <summary>
    /// <see cref="IImportLookup"/> over Seerr's API (admin API key, no <c>X-Api-User</c>: search and details don't vary
    /// by user except watchlists) with E3/E4 semantics:
    /// <list type="bullet">
    /// <item>Every upstream request takes its own turn at the shared <see cref="MetadataCallLimiter"/> and has a 15 s
    /// timeout; the configured Seerr URLs are tried in order until one gives a readable answer (review round 6, 4c2-R6-4:
    /// each fallback request is its own turn).</item>
    /// <item>Only sanitized, whole (every row read), NON-EMPTY results and proven absences are cached (30 min, keyed by
    /// the Seerr instance fingerprint and the normalized query); empty searches and errors never are, so a swallowed TMDB
    /// 429 can recover. "Not found" needs EVERY server's 404: one that failed or answered something unreadable makes the
    /// lookup transient (review round 6, 4c2-R6-2).</item>
    /// <item>Identical concurrent lookups share one upstream call, which is not cancelled when one waiter gives up (its
    /// result still warms the cache for the resubmitted entries).</item>
    /// </list>
    /// </summary>
    public sealed class SeerrImportLookup : IImportLookup
    {
        /// <summary>How long a definitive lookup (found, or not found: review round 5) is reused, with its status.</summary>
        public static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(30);

        /// <summary>Per upstream call timeout.</summary>
        public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(15);

        private const int MaxCacheEntries = 5000;

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly MetadataCallLimiter _limiter;
        private readonly TmdbResponseCache? _tmdb;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, (DateTime ExpiresUtc, LookupStatus Status, object? Value)> _cache = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, SharedLookup> _inFlight = new(StringComparer.Ordinal);

        /// <summary>Creates the lookup (singleton).</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="limiter">Shared Seerr call limiter.</param>
        /// <param name="tmdb">JE's TMDB response cache (IMDb episode ids).</param>
        /// <param name="logger">JE logger.</param>
        public SeerrImportLookup(IHttpClientFactory httpClientFactory, MetadataCallLimiter limiter, TmdbResponseCache tmdb, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _limiter = limiter;
            _tmdb = tmdb;
            _logger = logger;
        }

        /// <summary>Test constructor without the TMDB cache.</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="limiter">Limiter.</param>
        /// <param name="logger">Logger.</param>
        internal SeerrImportLookup(IHttpClientFactory httpClientFactory, MetadataCallLimiter limiter, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _limiter = limiter;
            _logger = logger;
        }

        /// <inheritdoc />
        public bool IsConfigured => TryGetSeerrConfig(out _, out _);

        /// <inheritdoc />
        public bool CanFindImdbEpisodes => _tmdb != null && !string.IsNullOrWhiteSpace(JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey());

        /// <inheritdoc />
        public async Task<LookupResult<IReadOnlyList<TitleHit>>> SearchAsync(string query, ImportCallContext context, CancellationToken cancellationToken)
        {
            var normalized = string.Join(' ', (query ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).ToLowerInvariant();
            if (normalized.Length == 0)
            {
                return new LookupResult<IReadOnlyList<TitleHit>>(LookupStatus.Ok, Array.Empty<TitleHit>());
            }

            var answer = await GetAsync(
                "search|" + normalized,
                "/api/v1/search?query=" + Uri.EscapeDataString(normalized) + "&page=1",
                context,
                ParseSearch,
                cancellationToken).ConfigureAwait(false);
            return answer.Result<IReadOnlyList<TitleHit>>();
        }

        /// <inheritdoc />
        public async Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken)
        {
            if (mediaType is not ("movie" or "tv") || tmdbId <= 0)
            {
                return LookupResult<TitleDetails>.NotFound;
            }

            var id = tmdbId.ToString(CultureInfo.InvariantCulture);
            var answer = await GetAsync(
                "details|" + mediaType + "|" + id,
                "/api/v1/" + mediaType + "/" + id,
                context,
                json => ParseDetails(json, mediaType, tmdbId),
                cancellationToken).ConfigureAwait(false);
            return answer.Result<TitleDetails>();
        }

        /// <inheritdoc />
        public async Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken)
        {
            if (tvTmdbId <= 0 || season < 0)
            {
                return LookupResult<IReadOnlyList<EpisodeFacts>>.NotFound;
            }

            var path = "/api/v1/tv/" + tvTmdbId.ToString(CultureInfo.InvariantCulture) + "/season/" + season.ToString(CultureInfo.InvariantCulture);
            var answer = await GetAsync(
                "season|" + path,
                path,
                context,
                json => ParseSeason(json, tvTmdbId, season),
                cancellationToken).ConfigureAwait(false);
            return answer.Result<IReadOnlyList<EpisodeFacts>>();
        }

        /// <inheritdoc />
        public async Task<LookupResult<ImdbEpisodeFind>> FindImdbEpisodeAsync(string imdbId, ImportCallContext context, CancellationToken cancellationToken)
        {
            var key = JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey();
            if (_tmdb == null || string.IsNullOrWhiteSpace(key) || !Regex.IsMatch(imdbId ?? string.Empty, "^tt[0-9]{5,10}$"))
            {
                return LookupResult<ImdbEpisodeFind>.NotFound;
            }

            // Review round 5: a definitive answer is reused with its status without waiting for the limiter. Review round 6:
            // the request is the TMDB lookup's own (TmdbCall: its own turn at the limiter, TMDB's find answer read by the
            // same reader, so an answer that isn't a valid, empty list is never a remembered "not found").
            var cacheKey = "tmdb-find|" + Fingerprint(new[] { "tmdb" }, key) + "|" + imdbId;
            if (_cache.TryGetValue(cacheKey, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return new LookupResult<ImdbEpisodeFind>(cached.Status, cached.Value as ImdbEpisodeFind);
            }

            var answer = await new TmdbCall(_tmdb, _limiter, _logger, context, key.Trim(), cancellationToken)
                .GetAsync("find/" + imdbId, "?external_source=imdb_id", TmdbImportLookup.ReadEpisodeFind).ConfigureAwait(false);
            if (answer.Remembered)
            {
                Remember(cacheKey, answer.Status, answer.Value);
            }

            return answer.Result<ImdbEpisodeFind>();
        }

        // ── Plumbing ─────────────────────────────────────────────────────────

        private async Task<LookupAnswer> GetAsync(
            string cacheKey,
            string apiPath,
            ImportCallContext context,
            Func<string, LookupAnswer> parse,
            CancellationToken cancellationToken)
        {
            if (!TryGetSeerrConfig(out var urls, out var apiKey))
            {
                return LookupAnswer.Transient;
            }

            var key = Fingerprint(urls, apiKey) + "|" + cacheKey;
            // A definitive answer is reused with its status, without waiting for the limiter (review round 5, 4c2-R5-4).
            if (_cache.TryGetValue(key, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return new LookupAnswer(cached.Status, cached.Value, ResponseVerdict.Valid);
            }

            // One shared call per key; E4: it follows its waiters' cancellation while it is still queued for the limiter.
            SharedLookup shared;
            while (true)
            {
                var mine = new SharedLookup();
                shared = _inFlight.GetOrAdd(key, mine);
                if (shared.TryJoin())
                {
                    if (ReferenceEquals(shared, mine))
                    {
                        _ = RunSharedAsync(key, mine, () => FetchAsync(urls, apiKey, apiPath, context, parse, mine));
                    }

                    break;
                }

                // Abandoned by its last waiter a moment ago: start a fresh one.
                _inFlight.TryRemove(new KeyValuePair<string, SharedLookup>(key, shared));
            }

            try
            {
                return await shared.Result.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                if (shared.Leave())
                {
                    _inFlight.TryRemove(new KeyValuePair<string, SharedLookup>(key, shared));
                }

                throw;
            }
        }

        private async Task RunSharedAsync(string key, SharedLookup shared, Func<Task<LookupAnswer>> fetch)
        {
            LookupAnswer answer;
            try
            {
                answer = await fetch().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Lists] Seerr lookup failed: {UpstreamDiagnostics.Code(ex)}");
                answer = LookupAnswer.Transient;
            }

            if (answer.Remembered)
            {
                Remember(key, answer.Status, answer.Value);
            }

            _inFlight.TryRemove(new KeyValuePair<string, SharedLookup>(key, shared));
            shared.Result.TrySetResult(answer);
        }

        // Every configured server in order by THE fallback table (SeerrFallback, review round 9): a Valid answer is used; a
        // Partial one is the fallback while later servers are asked (4c2-R7-3); a Malformed one (another title's or season's
        // answer included: 4c2-R9-1/2), a failure, a timeout or a 5xx is no proof of anything; "not found" only when EVERY
        // server answered 404 (4c2-R6-2). Each request takes its own turn at the limiter and is counted (4c2-R6-4); the turn
        // is held until that request has ended (its own timeout), whoever still waits for it. The first turn is queued like
        // the shared lookup (cancelled once every waiter is gone: an aborted request or the /resolve deadline); once admitted
        // the lookup runs to the end regardless (its result serves later joiners and the cache).
        private async Task<LookupAnswer> FetchAsync(string[] urls, string apiKey, string apiPath, ImportCallContext context, Func<string, LookupAnswer> parse, SharedLookup shared)
        {
            FallbackResult<LookupAnswer> read;
            try
            {
                read = await SeerrFallback.ReadAsync<LookupAnswer>(urls, (baseUrl, i) => ReadAtAsync(baseUrl, i, apiKey, apiPath, context, parse, shared)).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return LookupAnswer.Transient; // every waiter left while the first request was still queued
            }

            return read.State switch
            {
                FallbackState.Valid or FallbackState.Partial => read.Value,
                FallbackState.NotFound => LookupAnswer.NotFound,
                _ => LookupAnswer.Transient,
            };
        }

        // One server's answer as the fallback table reads it.
        private async Task<ServerAnswer<LookupAnswer>> ReadAtAsync(string baseUrl, int index, string apiKey, string apiPath, ImportCallContext context, Func<string, LookupAnswer> parse, SharedLookup shared)
        {
            IDisposable lease;
            if (index == 0)
            {
                lease = await _limiter.AcquireAsync(context.Owner, context.Background, shared.Abandoned).ConfigureAwait(false);
                if (!shared.TryAdmit())
                {
                    lease.Dispose();
                    throw new OperationCanceledException();
                }
            }
            else
            {
                lease = await _limiter.AcquireAsync(context.Owner, context.Background, CancellationToken.None).ConfigureAwait(false);
            }

            using (lease)
            {
                context.CountCall();
                var url = baseUrl + apiPath;
                try
                {
                    using var timeout = new CancellationTokenSource(CallTimeout);
                    var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, url, apiKey);
                    using var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false);
                    var status = (int)response.StatusCode;
                    var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, url, timeout.Token).ConfigureAwait(false);
                    if (json != null)
                    {
                        LookupAnswer answer;
                        try
                        {
                            answer = parse(json);
                        }
                        catch (JsonException)
                        {
                            answer = LookupAnswer.Transient;
                        }

                        if (answer.Status == LookupStatus.Transient)
                        {
                            _logger.Debug($"[Lists] Seerr lookup {apiPath} answered something JE can't read");
                            return new ServerAnswer<LookupAnswer>(ServerState.Malformed);
                        }

                        if (answer.Verdict != ResponseVerdict.Valid)
                        {
                            _logger.Debug($"[Lists] Seerr lookup {apiPath} answered in part; asking the next server");
                            return new ServerAnswer<LookupAnswer>(ServerState.Partial, answer);
                        }

                        return new ServerAnswer<LookupAnswer>(ServerState.Valid, answer);
                    }

                    // Seerr's season route answers EVERY failure with 500 "Unable to retrieve season." (an unknown season, but
                    // also a TMDB 429 or timeout). Seasons are only looked up when the show's details list them, so a 500
                    // there is retried (transient, never cached), not taken as a missing season.
                    if (status == 404)
                    {
                        return new ServerAnswer<LookupAnswer>(ServerState.NotFound);
                    }

                    _logger.Debug($"[Lists] Seerr lookup {apiPath} failed: {error?.Code} {status}");
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    // Any failure of this server (also a handler's own exception) is that server's: the next is asked.
                    _logger.Debug($"[Lists] Seerr lookup {apiPath} failed: {UpstreamDiagnostics.Code(ex)}");
                }

                return new ServerAnswer<LookupAnswer>(ServerState.Unavailable);
            }
        }

        // One in-flight lookup shared by every caller asking for the same key, with a waiter count so that a lookup
        // still waiting for the limiter is dropped when the last caller stops waiting.
        private sealed class SharedLookup
        {
            private readonly object _gate = new();
            private readonly CancellationTokenSource _abandon = new();
            private int _waiters;
            private bool _admitted;
            private bool _abandoned;

            public TaskCompletionSource<LookupAnswer> Result { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

            public CancellationToken Abandoned => _abandon.Token;

            public bool TryJoin()
            {
                lock (_gate)
                {
                    if (_abandoned)
                    {
                        return false;
                    }

                    _waiters++;
                    return true;
                }
            }

            // A waiter stopped waiting; true when that abandoned the (still queued) lookup.
            public bool Leave()
            {
                lock (_gate)
                {
                    _waiters--;
                    if (_waiters > 0 || _admitted || _abandoned || Result.Task.IsCompleted)
                    {
                        return false;
                    }

                    _abandoned = true;
                    _abandon.Cancel();
                    return true;
                }
            }

            public bool TryAdmit()
            {
                lock (_gate)
                {
                    if (_abandoned)
                    {
                        return false;
                    }

                    _admitted = true;
                    return true;
                }
            }
        }

        private void Remember(string key, LookupStatus status, object? value)
        {
            if (_cache.Count >= MaxCacheEntries)
            {
                var now = DateTime.UtcNow;
                foreach (var entry in _cache.Where(e => e.Value.ExpiresUtc <= now).Select(e => e.Key).ToList())
                {
                    _cache.TryRemove(entry, out _);
                }

                if (_cache.Count >= MaxCacheEntries)
                {
                    foreach (var entry in _cache.OrderBy(e => e.Value.ExpiresUtc).Take(MaxCacheEntries / 5).Select(e => e.Key).ToList())
                    {
                        _cache.TryRemove(entry, out _);
                    }
                }
            }

            _cache[key] = (DateTime.UtcNow + CacheTtl, status, value);
        }

        // Seerr's search answer (review rounds 6 and 7: ResponseContract.SeerrSearch, rows by the movie/show row
        // contracts): titles found beside a row JE can't read are used but not kept; only such rows and nothing found is no
        // proof of "no titles" (transient); a valid empty answer is never kept either (Seerr answers a TMDB error as no
        // results, Q-4C2AFIX5-1).
        private static LookupAnswer ParseSearch(string json)
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var page = ResponseContract.SeerrSearch.Validate(new AnswerRequest(Page: 1), root);
            if (page.Verdict == ResponseVerdict.Malformed)
            {
                return LookupAnswer.Transient;
            }

            var hits = new List<TitleHit>();
            var unusable = 0;
            var verdict = page.Verdict; // the page's own domain rules (review round 9)
            foreach (var result in root.GetProperty("results").EnumerateArray())
            {
                switch (ReadRow(result, out var hit, out var rowVerdict))
                {
                    case RowRead.Hit:
                        hits.Add(hit!);
                        verdict = ResponseContract.Worst(verdict, rowVerdict);
                        break;
                    case RowRead.Unusable:
                        unusable++;
                        break;
                }
            }

            if (hits.Count == 0 && unusable > 0)
            {
                return LookupAnswer.Transient;
            }

            return new LookupAnswer(LookupStatus.Ok, hits, unusable > 0 ? ResponseVerdict.Partial : verdict, Keep: hits.Count > 0);
        }

        // Seerr's movie or TV details by their contract (ResponseContract.SeerrMovieDetails / SeerrTvDetails): Malformed is
        // transient; Partial details (an id or the season list unknown, or a field JE can't use: review round 8) are used,
        // never kept, and never prove an id absent or a season missing (review round 7, 4c2-R7-1/2). Typed values only.
        // Review round 9 (4c2-R9-1): the details are those of the title asked for (its id), else Malformed (the next server).
        private static LookupAnswer ParseDetails(string json, string mediaType, int tmdbId)
        {
            using var doc = JsonDocument.Parse(json);
            var read = (mediaType == "movie" ? ResponseContract.SeerrMovieDetails : ResponseContract.SeerrTvDetails).Validate(new AnswerRequest(tmdbId, mediaType), doc.RootElement);
            return read.Verdict == ResponseVerdict.Malformed ? LookupAnswer.Transient : TypedTitles.Details(read, mediaType, camel: true);
        }

        // A season by its contract (ResponseContract.SeerrSeason): an episode row JE can't read makes it Malformed (an
        // episode missing from the list would be taken as "no such episode"); a row's unreadable display field, Partial.
        // Review round 9 (4c2-R9-2): every episode of the season (and show) asked for, each listed once.
        private static LookupAnswer ParseSeason(string json, int show, int season)
        {
            using var doc = JsonDocument.Parse(json);
            var read = ResponseContract.SeerrSeason.Validate(new AnswerRequest(Season: season, Show: show), doc.RootElement);
            return read.Verdict == ResponseVerdict.Malformed ? LookupAnswer.Transient : LookupAnswer.Ok(TypedTitles.Episodes(read, season, camel: true), read.Verdict);
        }

        // One row of a search answer: a title, a deliberate drop (an adult title, a person or another kind that isn't a
        // title), or a row that can't be read (not an object, no type, or not a title row by its contract).
        private static RowRead ReadRow(JsonElement element, out TitleHit? hit, out ResponseVerdict verdict)
        {
            hit = null;
            verdict = ResponseVerdict.Valid;
            var type = element.ValueKind == JsonValueKind.Object && element.TryGetProperty("mediaType", out var declared) && declared.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(declared.GetString())
                ? declared.GetString()
                : null;
            if (type == null)
            {
                return RowRead.Unusable;
            }

            // Review round 9 (4c2-R9-6): a closed allowlist; an unknown type is a row JE can't read, never a deliberate drop.
            if (TitleTypes.Classify(type, TitleTypes.SeerrExcluded) is { } unkeyed)
            {
                return unkeyed;
            }

            if (element.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True)
            {
                return RowRead.Dropped;
            }

            var read = (type == "movie" ? ResponseContract.SeerrMovieRow : ResponseContract.SeerrTvRow).Read(element);
            verdict = read.Verdict;
            hit = verdict == ResponseVerdict.Malformed ? null : TypedTitles.Hit(read, type, camel: true);
            return hit == null ? RowRead.Unusable : RowRead.Hit;
        }

        // The address list every Seerr-backed read of the lists area takes (review round 8, 4c2-R8-4).
        private static bool TryGetSeerrConfig(out string[] urls, out string apiKey) => SeerrAddresses.TryGet(out urls, out apiKey);

        // Seerr instance identity (URL list + key hash): a config change never serves another instance's results.
        private static string Fingerprint(string[] urls, string apiKey) => SeerrAddresses.Identity(urls, apiKey);
    }

    /// <summary>
    /// The title facts the import lookups take from a contract read (review round 8, D53 "parse once into typed facts"): the
    /// TYPED values of <see cref="ResponseContract"/>'s title rows, details and seasons, in TMDB's names or Seerr's camelCase
    /// of them. Nothing here reads JSON: a value the contract couldn't use is no value (and made the answer Partial).
    /// </summary>
    internal static class TypedTitles
    {
        private const int MaxOverview = 300;

        /// <summary>A title row (search, find, <c>tmdb:N</c>, the title part of details), or null without an id and title.</summary>
        /// <param name="row">The read row.</param>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="camel">Seerr's names.</param>
        /// <returns>The title, or null.</returns>
        public static TitleHit? Hit(ContractRead row, string mediaType, bool camel)
        {
            string N(string name) => camel ? ResponseContract.CamelName(name) : name;
            var movie = mediaType == "movie";
            var id = row.Int("id");
            var title = Clip(row.Text(movie ? "title" : "name"), 200);
            if (id is not > 0 || title == null || row.Bool("adult") == true)
            {
                return null;
            }

            return new TitleHit(mediaType, id.Value, title, Clip(row.Text(N(movie ? "original_title" : "original_name")), 200), row.Date(N(movie ? "release_date" : "first_air_date")),
                row.Poster(N("poster_path")), Clip(row.Text("overview"), MaxOverview), row.Number("popularity") ?? 0, row.Int(N("vote_count")) ?? 0);
        }

        /// <summary>Details (not Malformed): the title, its ids, status, production state and seasons; with the answer's verdict.</summary>
        /// <param name="read">The read details.</param>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="camel">Seerr's names.</param>
        /// <returns>The answer (Transient when it isn't a title JE can use: no id or title, an adult title).</returns>
        public static LookupAnswer Details(ContractRead read, string mediaType, bool camel)
        {
            string N(string name) => camel ? ResponseContract.CamelName(name) : name;
            var hit = Hit(read, mediaType, camel);
            if (hit == null)
            {
                return LookupAnswer.Transient;
            }

            var external = read.Member(N("external_ids"));
            var seasons = new List<SeasonFacts>();
            if (mediaType == "tv")
            {
                foreach (var season in read.Rows("seasons"))
                {
                    var number = season.Int(N("season_number"))!.Value; // required: the contract read every row
                    if (number <= 500)
                    {
                        seasons.Add(new SeasonFacts(number, season.Int(N("episode_count")), season.Date(N("air_date")), Clip(season.Text("name"), 100)));
                    }
                }
            }

            var details = new TitleDetails(hit, read.Imdb(N("imdb_id")) ?? external?.Imdb(N("imdb_id")), external?.Int(N("tvdb_id")), Clip(read.Text("status"), 40), read.Bool(N("in_production")), seasons)
            {
                Verdict = read.Verdict,
            };
            return LookupAnswer.Ok(details, read.Verdict);
        }

        /// <summary>A season's episodes (the contract read every row: each has its episode number).</summary>
        /// <param name="read">The read season.</param>
        /// <param name="season">The season asked for (an episode without its own season number is of it).</param>
        /// <param name="camel">Seerr's names.</param>
        /// <returns>The episodes.</returns>
        public static List<EpisodeFacts> Episodes(ContractRead read, int season, bool camel)
        {
            string N(string name) => camel ? ResponseContract.CamelName(name) : name;
            return read.Rows("episodes")
                .Select(e => new EpisodeFacts(e.Int(N("season_number")) ?? season, e.Int(N("episode_number"))!.Value, Clip(e.Text("name"), 200), e.Date(N("air_date"))))
                .ToList();
        }

        /// <summary>Text cut to <paramref name="max"/> characters; null when empty.</summary>
        /// <param name="text">Text.</param>
        /// <param name="max">Length.</param>
        /// <returns>The text or null.</returns>
        public static string? Clip(string? text, int max) => string.IsNullOrEmpty(text) ? null : text.Length > max ? text[..max] : text;
    }
}
