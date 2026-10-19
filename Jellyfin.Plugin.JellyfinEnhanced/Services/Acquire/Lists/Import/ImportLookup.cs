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
    }

    /// <summary>
    /// One upstream answer as an import lookup read it (review round 6, D53 "NotFound = proven absence"): its status, its
    /// value and whether it is DEFINITIVE, i.e. a valid, whole answer that may be remembered. Only a definitive answer is
    /// cached; "not found" or "no titles" needs a valid answer from every source asked whose every row was read.
    /// </summary>
    /// <param name="Status">Status.</param>
    /// <param name="Value">Value when Ok.</param>
    /// <param name="Definitive">A valid, whole answer (every row read): it may be remembered.</param>
    internal readonly record struct LookupAnswer(LookupStatus Status, object? Value, bool Definitive)
    {
        /// <summary>A failure, or an answer that proves nothing: asked again next time.</summary>
        public static LookupAnswer Transient => new(LookupStatus.Transient, null, false);

        /// <summary>A proven absence (TMDB's or every Seerr server's 404, an episode find's valid empty list).</summary>
        public static LookupAnswer NotFound => new(LookupStatus.NotFound, null, true);

        /// <summary>Remembered: a definitive answer (a transient one never is).</summary>
        public bool Remembered => Definitive && Status != LookupStatus.Transient && (Status == LookupStatus.NotFound || Value != null);

        /// <summary>An answer.</summary>
        /// <param name="value">Value.</param>
        /// <param name="definitive">Every row was read.</param>
        /// <returns>The answer.</returns>
        public static LookupAnswer Ok(object value, bool definitive = true) => new(LookupStatus.Ok, value, definitive);
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
    public sealed record TitleDetails(TitleHit Hit, string? ImdbId, int? TvdbId, string? Status, bool? InProduction, IReadOnlyList<SeasonFacts> Seasons);

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
        private const int MaxOverview = 300;
        private static readonly Regex PosterRegex = new("^/[A-Za-z0-9_-]+\\.(jpg|png)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex DateRegex = new("^\\d{4}-\\d{2}-\\d{2}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

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

            var (status, value) = await GetAsync(
                "search|" + normalized,
                "/api/v1/search?query=" + Uri.EscapeDataString(normalized) + "&page=1",
                context,
                ParseSearch,
                cancellationToken).ConfigureAwait(false);
            return new LookupResult<IReadOnlyList<TitleHit>>(status, status == LookupStatus.Ok ? (IReadOnlyList<TitleHit>)value! : null);
        }

        /// <inheritdoc />
        public async Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken)
        {
            if (mediaType is not ("movie" or "tv") || tmdbId <= 0)
            {
                return LookupResult<TitleDetails>.NotFound;
            }

            var id = tmdbId.ToString(CultureInfo.InvariantCulture);
            var (status, value) = await GetAsync(
                "details|" + mediaType + "|" + id,
                "/api/v1/" + mediaType + "/" + id,
                context,
                json => ParseDetails(json, mediaType) is { } details ? LookupAnswer.Ok(details) : LookupAnswer.Transient,
                cancellationToken).ConfigureAwait(false);
            return new LookupResult<TitleDetails>(status, status == LookupStatus.Ok ? (TitleDetails)value! : null);
        }

        /// <inheritdoc />
        public async Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken)
        {
            if (tvTmdbId <= 0 || season < 0)
            {
                return LookupResult<IReadOnlyList<EpisodeFacts>>.NotFound;
            }

            var path = "/api/v1/tv/" + tvTmdbId.ToString(CultureInfo.InvariantCulture) + "/season/" + season.ToString(CultureInfo.InvariantCulture);
            var (status, value) = await GetAsync(
                "season|" + path,
                path,
                context,
                json => ParseSeason(json, season) is { } episodes ? LookupAnswer.Ok(episodes) : LookupAnswer.Transient,
                cancellationToken).ConfigureAwait(false);
            return new LookupResult<IReadOnlyList<EpisodeFacts>>(status, status == LookupStatus.Ok ? (IReadOnlyList<EpisodeFacts>)value! : null);
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

            return new LookupResult<ImdbEpisodeFind>(answer.Status, answer.Value as ImdbEpisodeFind);
        }

        // ── Plumbing ─────────────────────────────────────────────────────────

        private async Task<(LookupStatus Status, object? Value)> GetAsync(
            string cacheKey,
            string apiPath,
            ImportCallContext context,
            Func<string, LookupAnswer> parse,
            CancellationToken cancellationToken)
        {
            if (!TryGetSeerrConfig(out var urls, out var apiKey))
            {
                return (LookupStatus.Transient, null);
            }

            var key = Fingerprint(urls, apiKey) + "|" + cacheKey;
            // A definitive answer is reused with its status, without waiting for the limiter (review round 5, 4c2-R5-4).
            if (_cache.TryGetValue(key, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return (cached.Status, cached.Value);
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
                _logger.Debug($"[Lists] Seerr lookup failed: {ex.Message}");
                answer = LookupAnswer.Transient;
            }

            if (answer.Remembered)
            {
                Remember(key, answer.Status, answer.Value);
            }

            _inFlight.TryRemove(new KeyValuePair<string, SharedLookup>(key, shared));
            shared.Result.TrySetResult((answer.Status, answer.Value));
        }

        // Every configured server in order until one gives a readable answer (review round 6). Each request takes its own
        // turn at the limiter and is counted (4c2-R6-4). The first turn is queued like the shared lookup (cancelled once
        // every waiter is gone: an aborted request or the /resolve deadline); once admitted the lookup runs to the end
        // regardless (its result serves later joiners and the cache). Not found only when EVERY server answered 404
        // (4c2-R6-2): a server that failed, timed out or answered something unreadable proves nothing, so the lookup is
        // transient and asked again.
        private async Task<LookupAnswer> FetchAsync(string[] urls, string apiKey, string apiPath, ImportCallContext context, Func<string, LookupAnswer> parse, SharedLookup shared)
        {
            var notFound = 0;
            for (var i = 0; i < urls.Length; i++)
            {
                IDisposable lease;
                if (i == 0)
                {
                    try
                    {
                        lease = await _limiter.AcquireAsync(context.Owner, context.Background, shared.Abandoned).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        return LookupAnswer.Transient;
                    }

                    if (!shared.TryAdmit())
                    {
                        lease.Dispose();
                        return LookupAnswer.Transient;
                    }
                }
                else
                {
                    lease = await _limiter.AcquireAsync(context.Owner, context.Background, CancellationToken.None).ConfigureAwait(false);
                }

                using (lease)
                {
                    context.CountCall();
                    var url = urls[i] + apiPath;
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
                            var answer = parse(json);
                            if (answer.Status != LookupStatus.Transient)
                            {
                                return answer;
                            }

                            _logger.Debug($"[Lists] Seerr lookup {apiPath} answered something JE can't read");
                            continue;
                        }

                        // Seerr's season route answers EVERY failure with 500 "Unable to retrieve season." (an unknown
                        // season, but also a TMDB 429 or timeout). Seasons are only looked up when the show's details list
                        // them, so a 500 there is retried (transient, never cached), not taken as a missing season.
                        if (status == 404)
                        {
                            notFound++;
                            continue;
                        }

                        _logger.Debug($"[Lists] Seerr lookup {apiPath} failed: {error?.Code} {status}");
                    }
                    catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException or InvalidOperationException)
                    {
                        _logger.Debug($"[Lists] Seerr lookup {apiPath} failed: {ex.Message}");
                    }
                }
            }

            return notFound == urls.Length ? LookupAnswer.NotFound : LookupAnswer.Transient;
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

            public TaskCompletionSource<(LookupStatus Status, object? Value)> Result { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

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

        // Seerr's search answer (review round 6): titles found beside a row JE can't read are used but not kept; only such
        // rows and nothing found is no proof of "no titles" (transient); an empty answer is never kept either (Seerr
        // answers a TMDB error as no results).
        private static LookupAnswer ParseSearch(string json)
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
            {
                return LookupAnswer.Transient;
            }

            var hits = new List<TitleHit>();
            var unusable = 0;
            foreach (var result in results.EnumerateArray())
            {
                switch (ReadRow(result, out var hit))
                {
                    case RowRead.Hit:
                        hits.Add(hit!);
                        break;
                    case RowRead.Unusable:
                        unusable++;
                        break;
                }
            }

            return hits.Count == 0 && unusable > 0 ? LookupAnswer.Transient : LookupAnswer.Ok(hits, hits.Count > 0 && unusable == 0);
        }

        // Null when the answer isn't a whole title (also a season row JE can't read: a season missing from the list would
        // be taken as "no such season").
        private static TitleDetails? ParseDetails(string json, string mediaType)
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var hit = ReadHit(root, mediaType);
            if (hit == null)
            {
                return null;
            }

            string? imdb = ReadString(root, "imdbId", 12);
            int? tvdb = null;
            if (root.TryGetProperty("externalIds", out var external) && external.ValueKind == JsonValueKind.Object)
            {
                imdb ??= ReadString(external, "imdbId", 12);
                tvdb = ReadInt(external, "tvdbId");
            }

            if (imdb != null && !Regex.IsMatch(imdb, "^tt[0-9]{5,10}$"))
            {
                imdb = null;
            }

            var seasons = new List<SeasonFacts>();
            if (mediaType == "tv" && root.TryGetProperty("seasons", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var season in list.EnumerateArray())
                {
                    var number = season.ValueKind == JsonValueKind.Object ? ReadInt(season, "seasonNumber") : null;
                    if (number is not >= 0)
                    {
                        return null;
                    }

                    if (number <= 500)
                    {
                        seasons.Add(new SeasonFacts(number.Value, ReadInt(season, "episodeCount"), ReadDate(season, "airDate"), ReadString(season, "name", 100)));
                    }
                }
            }

            bool? inProduction = root.TryGetProperty("inProduction", out var prod) && prod.ValueKind is JsonValueKind.True or JsonValueKind.False ? prod.GetBoolean() : null;
            return new TitleDetails(hit, imdb, tvdb is > 0 ? tvdb : null, ReadString(root, "status", 40), inProduction, seasons);
        }

        // Null when the answer has no episode list or an episode row JE can't read (an episode missing from the list would
        // be taken as "no such episode").
        private static IReadOnlyList<EpisodeFacts>? ParseSeason(string json, int season)
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty("episodes", out var episodes) || episodes.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var list = new List<EpisodeFacts>();
            foreach (var episode in episodes.EnumerateArray())
            {
                var number = episode.ValueKind == JsonValueKind.Object ? ReadInt(episode, "episodeNumber") : null;
                if (number is not >= 0)
                {
                    return null;
                }

                list.Add(new EpisodeFacts(ReadInt(episode, "seasonNumber") ?? season, number.Value, ReadString(episode, "name", 200), ReadDate(episode, "airDate")));
            }

            return list;
        }

        // One row of a search answer: a title, a deliberate drop (an adult title, a person or another kind that isn't a
        // title), or a row that can't be read (not an object, no type, no id or no title).
        private static RowRead ReadRow(JsonElement element, out TitleHit? hit)
        {
            hit = null;
            var type = element.ValueKind == JsonValueKind.Object && element.TryGetProperty("mediaType", out var declared) && declared.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(declared.GetString())
                ? declared.GetString()
                : null;
            if (type == null)
            {
                return RowRead.Unusable;
            }

            if (type is not ("movie" or "tv") || (element.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True))
            {
                return RowRead.Dropped;
            }

            hit = ReadHit(element, type);
            return hit == null ? RowRead.Unusable : RowRead.Hit;
        }

        private static TitleHit? ReadHit(JsonElement element, string? mediaType)
        {
            if (mediaType is not ("movie" or "tv") || element.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (element.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True)
            {
                return null;
            }

            var id = ReadInt(element, "id");
            var title = mediaType == "movie" ? ReadString(element, "title", 200) : ReadString(element, "name", 200);
            if (id is not > 0 || string.IsNullOrWhiteSpace(title))
            {
                return null;
            }

            var original = mediaType == "movie" ? ReadString(element, "originalTitle", 200) : ReadString(element, "originalName", 200);
            var date = mediaType == "movie" ? ReadDate(element, "releaseDate") : ReadDate(element, "firstAirDate");
            var poster = ReadString(element, "posterPath", 100);
            if (poster != null && !PosterRegex.IsMatch(poster))
            {
                poster = null;
            }

            var overview = ReadString(element, "overview", MaxOverview);
            var popularity = element.TryGetProperty("popularity", out var pop) && pop.ValueKind == JsonValueKind.Number && pop.TryGetDouble(out var p) ? p : 0;
            var votes = ReadInt(element, "voteCount") ?? 0;
            return new TitleHit(mediaType, id.Value, title.Trim(), original, date, poster, overview, popularity, votes);
        }

        private static int? ReadInt(JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var result) ? result : null;

        private static string? ReadString(JsonElement element, string name, int max)
        {
            if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var text = ListRules.CleanText(value.GetString());
            if (text.Length == 0)
            {
                return null;
            }

            return text.Length > max ? text[..max] : text;
        }

        private static string? ReadDate(JsonElement element, string name)
        {
            var value = ReadString(element, name, 10);
            return value != null && DateRegex.IsMatch(value) && ListRules.TryParseDate(value, out _) ? value : null;
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

        // Seerr instance identity (URL list + key hash): a config change never serves another instance's results.
        private static string Fingerprint(string[] urls, string apiKey)
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(apiKey));
            return string.Join('\n', urls) + "|" + Convert.ToHexString(hash, 0, 8);
        }
    }
}
