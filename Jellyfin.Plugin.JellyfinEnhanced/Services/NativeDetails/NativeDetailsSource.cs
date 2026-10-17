#if JF12
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// Public title metadata for the native details facade. Answers are shared between viewers, so
    /// they hold only public TMDB-derived data: the facade never projects Seerr's per-account parts
    /// (requests, requesters, watchlist) into a page.
    /// </summary>
    public interface INativeDetailsSource
    {
        /// <summary>Seerr's movie details, or why there are none.</summary>
        Task<SourceAnswer> MovieAsync(int tmdb, CancellationToken ct);

        /// <summary>Seerr's series details, or why there are none.</summary>
        Task<SourceAnswer> SeriesAsync(int tmdb, CancellationToken ct);

        /// <summary>Seerr's season details (with its episodes), or why there are none.</summary>
        Task<SourceAnswer> SeasonAsync(int tmdb, int season, CancellationToken ct);

        /// <summary>Seerr's first page of recommendations for a title, or null.</summary>
        Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, CancellationToken ct);

        /// <summary>The title's TMDB logo file path (needs JE's TMDB key), or null.</summary>
        Task<string?> LogoPathAsync(bool movie, int tmdb, CancellationToken ct);

        /// <summary>Seerr's person details (name, biography, birth and death, known-for department), or why there are none.</summary>
        Task<SourceAnswer> PersonAsync(int tmdb, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>Seerr's list of TMDB movie or TV genres (id, name), or why there is none.</summary>
        Task<SourceAnswer> GenresAsync(bool movie, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>Seerr's details of a production company (studio), or why there are none.</summary>
        Task<SourceAnswer> StudioAsync(int tmdb, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>Seerr's details of a TV network, or why there are none.</summary>
        Task<SourceAnswer> NetworkAsync(int tmdb, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>
        /// Seerr's combined credits of a person (cast and crew, every title), or why there are none
        /// (<see cref="SourceAnswer.Busy"/> when it isn't cached and <paramref name="viewer"/> may not
        /// start another upstream read now).
        /// </summary>
        /// <param name="tmdb">TMDB person id.</param>
        /// <param name="viewer">The viewer whose read budget an upstream read comes out of.</param>
        /// <param name="ct">Cancellation.</param>
        Task<SourceAnswer> PersonCreditsAsync(int tmdb, Guid viewer, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>
        /// One page of Seerr's movie or series discovery filtered by a genre, studio (movies) or network
        /// (series), in Seerr's discover shape, or why there is none (<see cref="SourceAnswer.Busy"/> as
        /// for <see cref="PersonCreditsAsync"/>).
        /// </summary>
        /// <param name="movie">Movies (else series).</param>
        /// <param name="filter">Seerr's filter: <c>genre</c>, <c>studio</c> or <c>network</c>.</param>
        /// <param name="id">The TMDB genre, company or network id.</param>
        /// <param name="page">Page (1-500).</param>
        /// <param name="sortBy">Seerr's sort, or null for its default.</param>
        /// <param name="viewer">The viewer whose read budget an upstream read comes out of.</param>
        /// <param name="ct">Cancellation.</param>
        Task<SourceAnswer> DiscoverAsync(bool movie, string filter, int id, int page, string? sortBy, Guid viewer, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>
        /// One page of the series a TMDB company produced (TMDB's discover, JE's TMDB key: Seerr filters
        /// series by network only), in Seerr's discover shape, or why there is none
        /// (<see cref="SourceAnswer.Busy"/> as for <see cref="PersonCreditsAsync"/>).
        /// </summary>
        /// <param name="company">TMDB company id.</param>
        /// <param name="page">Page (1-500).</param>
        /// <param name="sortBy">TMDB sort, or null for its default.</param>
        /// <param name="viewer">The viewer whose read budget an upstream read comes out of.</param>
        /// <param name="ct">Cancellation.</param>
        Task<SourceAnswer> CompanySeriesAsync(int company, int page, string? sortBy, Guid viewer, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>
        /// <see cref="MovieAsync(int, CancellationToken)"/> for a page a viewer opens: a read that isn't cached
        /// or already running comes out of <paramref name="viewer"/>'s feed budget
        /// (<see cref="SourceAnswer.Busy"/> when it can't start now).
        /// </summary>
        Task<SourceAnswer> MovieAsync(int tmdb, Guid viewer, CancellationToken ct) => MovieAsync(tmdb, ct);

        /// <summary><see cref="SeriesAsync(int, CancellationToken)"/> out of the viewer's feed budget (see <see cref="MovieAsync(int, Guid, CancellationToken)"/>).</summary>
        Task<SourceAnswer> SeriesAsync(int tmdb, Guid viewer, CancellationToken ct) => SeriesAsync(tmdb, ct);

        /// <summary><see cref="SeasonAsync(int, int, CancellationToken)"/> out of the viewer's feed budget.</summary>
        Task<SourceAnswer> SeasonAsync(int tmdb, int season, Guid viewer, CancellationToken ct) => SeasonAsync(tmdb, season, ct);

        /// <summary><see cref="PersonAsync(int, CancellationToken)"/> out of the viewer's feed budget.</summary>
        Task<SourceAnswer> PersonAsync(int tmdb, Guid viewer, CancellationToken ct) => PersonAsync(tmdb, ct);

        /// <summary><see cref="StudioAsync(int, CancellationToken)"/> out of the viewer's feed budget.</summary>
        Task<SourceAnswer> StudioAsync(int tmdb, Guid viewer, CancellationToken ct) => StudioAsync(tmdb, ct);

        /// <summary><see cref="NetworkAsync(int, CancellationToken)"/> out of the viewer's feed budget.</summary>
        Task<SourceAnswer> NetworkAsync(int tmdb, Guid viewer, CancellationToken ct) => NetworkAsync(tmdb, ct);

        /// <summary>
        /// Seerr's ratings of a title (movies: RT and IMDb combined; series: RT), or why there are none
        /// (<see cref="SourceAnswer.Busy"/> as for <see cref="PersonCreditsAsync"/>).
        /// </summary>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">TMDB id.</param>
        /// <param name="viewer">The viewer whose read budget an upstream read comes out of.</param>
        /// <param name="ct">Cancellation.</param>
        Task<SourceAnswer> RatingsAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>
        /// One page of Seerr's similar or recommended titles of a movie or series, or why there is none
        /// (<see cref="SourceAnswer.Busy"/> as for <see cref="PersonCreditsAsync"/>).
        /// </summary>
        /// <param name="movie">Movie (else series).</param>
        /// <param name="tmdb">The title's TMDB id.</param>
        /// <param name="relation">similar or recommendations.</param>
        /// <param name="page">Page (1-500).</param>
        /// <param name="viewer">The viewer whose read budget an upstream read comes out of.</param>
        /// <param name="ct">Cancellation.</param>
        Task<SourceAnswer> RelatedAsync(bool movie, int tmdb, string relation, int page, Guid viewer, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>
        /// Seerr's details of a TMDB movie collection (name, artwork, parts), or why there are none
        /// (<see cref="SourceAnswer.Busy"/> as for <see cref="PersonCreditsAsync"/>).
        /// </summary>
        /// <param name="collection">TMDB collection id.</param>
        /// <param name="viewer">The viewer whose read budget an upstream read comes out of.</param>
        /// <param name="ct">Cancellation.</param>
        Task<SourceAnswer> CollectionAsync(int collection, Guid viewer, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>
        /// Seerr's TMDB keyword search (id, name), or why there is none (<see cref="SourceAnswer.Busy"/> as
        /// for <see cref="PersonCreditsAsync"/>).
        /// </summary>
        /// <param name="query">The keyword (1-100 characters).</param>
        /// <param name="viewer">The viewer whose read budget an upstream read comes out of.</param>
        /// <param name="ct">Cancellation.</param>
        Task<SourceAnswer> KeywordsAsync(string query, Guid viewer, CancellationToken ct) => Task.FromResult(SourceAnswer.Unavailable);

        /// <summary>
        /// True when the Jellyfin user has a linked Seerr account, false when not, null when it can't
        /// be told (Seerr unreachable and no earlier answer): the page then fails over to the modal
        /// instead of refusing.
        /// </summary>
        Task<bool?> IsSeerrLinkedAsync(Guid userId, CancellationToken ct);
    }

    /// <summary>
    /// One source answer: the data, a title the source says doesn't exist (<see cref="NotFound"/>,
    /// answered 404), a read not started because the viewer or the server has too many running
    /// (<see cref="Busy"/>, answered 429), or none of these because the source can't be reached right
    /// now (answered 503).
    /// </summary>
    /// <param name="Data">The JSON, when there is some.</param>
    /// <param name="NotFound">True when the source answered "no such title" (Seerr's own 404, not a proxy's HTML page).</param>
    /// <param name="Busy">True when the read wasn't started: try again shortly.</param>
    public readonly record struct SourceAnswer(JsonElement? Data, bool NotFound, bool Busy = false)
    {
        /// <summary>The read wasn't started (the viewer's read budget or the server's queue is used up).</summary>
        public static SourceAnswer Throttled => new(null, false, true);

        /// <summary>The source can't answer now (outage, timeout, not configured).</summary>
        public static SourceAnswer Unavailable => default;

        /// <summary>The source says the title (or season) doesn't exist.</summary>
        public static SourceAnswer Missing => new(null, true);

        /// <summary>An answer with data.</summary>
        /// <param name="data">The JSON.</param>
        /// <returns>The answer.</returns>
        public static SourceAnswer Of(JsonElement data) => new(data, false);
    }

    /// <summary>
    /// Seerr (and, for logos and a company's series, TMDB) behind bounded, coalesced caches. Feed
    /// reads (filmographies, discovery pages) a viewer can name without end are admitted: a cached or
    /// already running read costs nothing; a new one comes out of the viewer's budget
    /// (<see cref="FeedBurst"/>, then <see cref="FeedPerSecond"/>) and waits for one of
    /// <see cref="FeedConcurrency"/> upstream slots, with at most <see cref="FeedQueue"/> more queued
    /// server-wide and <see cref="FeedPerViewer"/> outstanding per viewer, slots handed to the
    /// waiting viewers in turn; otherwise it isn't started (<see cref="SourceAnswer.Busy"/>).
    /// </summary>
    public sealed class SeerrNativeDetailsSource : INativeDetailsSource
    {
        /// <summary>New feed reads one viewer may start at once (a person page needs one; a discovery page's first screens about fifteen).</summary>
        internal const int FeedBurst = 60;

        /// <summary>New feed reads one viewer may start per second once the burst is used.</summary>
        internal const double FeedPerSecond = 1;

        /// <summary>Feed reads running upstream at once, server-wide.</summary>
        internal const int FeedConcurrency = 8;

        /// <summary>Feed reads that may wait for an upstream slot, server-wide.</summary>
        internal const int FeedQueue = 40;

        /// <summary>
        /// Feed reads one viewer may have outstanding (running or queued, until the read ends): two
        /// tabs' worth of the client's four parallel requests, and a sixth of the server's room, so one
        /// account can't fill the queue for everyone else.
        /// </summary>
        internal const int FeedPerViewer = 8;

        private const int MaxEntries = 400;
        private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(15);
        private static readonly TimeSpan FailureTtl = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan LinkTtl = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan LinkMissRefresh = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(10);
        private static readonly System.Text.RegularExpressions.Regex TitlePath = new(@"^/api/v1/((?:movie|tv)/[0-9]{1,9}(?:/season/[0-9]{1,4})?|(?:person|studio|network)/[0-9]{1,9})$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        // The linked-account check guards every facade route: one bounded refresh at a time, and a
        // failed refresh is not retried by the callers queued behind it.
        private static readonly TimeSpan LinkRefreshBudget = TimeSpan.FromSeconds(4);
        private static readonly TimeSpan LinkFailureBackoff = TimeSpan.FromSeconds(30);

        private readonly IHttpClientFactory _http;
        private readonly TmdbResponseCache _tmdb;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, (SourceAnswer Value, DateTime At)> _cache = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, Lazy<Task<SourceAnswer>>> _inFlight = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _linkLock = new(1, 1);

        /// <summary>Seerr accounts read per request when telling who is linked.</summary>
        internal const int LinkPageSize = 1000;

        /// <summary>The most pages of Seerr accounts read (beyond that: can't tell).</summary>
        internal const int LinkMaxPages = 20;
        private readonly Func<DateTime> _now;
        private readonly ViewerBudget _feedBudget;
        private readonly FeedScheduler _feeds = new(FeedConcurrency, FeedQueue, FeedPerViewer);
        private HashSet<string>? _linked;
        private string? _linkedFrom;
        private DateTime _linkedAt;
        private DateTime _linkFailedAt;

        /// <summary>Creates the source.</summary>
        public SeerrNativeDetailsSource(IHttpClientFactory http, TmdbResponseCache tmdb, Logger logger)
            : this(http, tmdb, logger, () => DateTime.UtcNow)
        {
        }

        /// <summary>Creates the source with a clock (tests).</summary>
        internal SeerrNativeDetailsSource(IHttpClientFactory http, TmdbResponseCache tmdb, Logger logger, Func<DateTime> now)
        {
            _http = http;
            _tmdb = tmdb;
            _logger = logger;
            _now = now;
            _feedBudget = new ViewerBudget(FeedBurst, FeedPerSecond, now);
        }

        /// <summary>Upstream fetches still running (for tests: none may outlive its fetch).</summary>
        internal int InFlightCount => _inFlight.Count;

        /// <summary>Feed reads started upstream and not finished, running or queued (for tests).</summary>
        internal int FeedReadsPending => _feeds.Outstanding;

        /// <summary>A viewer's feed reads started upstream and not finished (for tests).</summary>
        /// <param name="viewer">The viewer.</param>
        /// <returns>Their running and queued reads.</returns>
        internal int FeedReadsOf(Guid viewer) => _feeds.OutstandingOf(viewer);

        /// <summary>Viewers with a feed read outstanding (for tests: none is kept once its reads end).</summary>
        internal int FeedViewersTracked => _feeds.ViewersTracked;

        /// <inheritdoc />
        public Task<SourceAnswer> MovieAsync(int tmdb, CancellationToken ct) => GetAsync($"/api/v1/movie/{tmdb}", ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeriesAsync(int tmdb, CancellationToken ct) => GetAsync($"/api/v1/tv/{tmdb}", ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, CancellationToken ct) => GetAsync($"/api/v1/tv/{tmdb}/season/{season}", ct);

        /// <inheritdoc />
        public Task<SourceAnswer> PersonAsync(int tmdb, CancellationToken ct) => GetAsync($"/api/v1/person/{tmdb}", ct);

        /// <inheritdoc />
        public Task<SourceAnswer> GenresAsync(bool movie, CancellationToken ct) => GetAsync(movie ? "/api/v1/genres/movie" : "/api/v1/genres/tv", ct);

        /// <inheritdoc />
        public Task<SourceAnswer> StudioAsync(int tmdb, CancellationToken ct) => GetAsync($"/api/v1/studio/{tmdb}", ct);

        /// <inheritdoc />
        public Task<SourceAnswer> NetworkAsync(int tmdb, CancellationToken ct) => GetAsync($"/api/v1/network/{tmdb}", ct);

        /// <inheritdoc />
        public Task<SourceAnswer> MovieAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted($"/api/v1/movie/{tmdb}", viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeriesAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted($"/api/v1/tv/{tmdb}", viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, Guid viewer, CancellationToken ct) => Budgeted($"/api/v1/tv/{tmdb}/season/{season}", viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> PersonAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted($"/api/v1/person/{tmdb}", viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> StudioAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted($"/api/v1/studio/{tmdb}", viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> NetworkAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted($"/api/v1/network/{tmdb}", viewer, ct);

        /// <summary>How long a page's own metadata read waits for room in the viewer's budget before it answers busy.</summary>
        internal TimeSpan PageReadWait { get; set; } = TimeSpan.FromSeconds(3);

        /// <summary>
        /// A page's metadata read: cached or running reads are free, a new one comes out of the viewer's feed
        /// budget. A page can't be retried by jellyfin-web the way a list page can, so a read without room
        /// waits a little (a token refills each second) before it answers busy; only sustained reading past
        /// the budget is refused.
        /// </summary>
        private async Task<SourceAnswer> Budgeted(string path, Guid viewer, CancellationToken ct)
        {
            var until = DateTime.UtcNow + PageReadWait;
            while (true)
            {
                var answer = await FeedAsync(path, viewer, () => FetchAndStoreAsync(path), ct).ConfigureAwait(false);
                if (!answer.Busy || DateTime.UtcNow >= until) return answer;
                await Task.Delay(250, ct).ConfigureAwait(false);
            }
        }

        /// <inheritdoc />
        public Task<SourceAnswer> PersonCreditsAsync(int tmdb, Guid viewer, CancellationToken ct)
        {
            var path = $"/api/v1/person/{tmdb}/combined_credits";
            return FeedAsync(path, viewer, () => FetchAndStoreAsync(path), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> DiscoverAsync(bool movie, string filter, int id, int page, string? sortBy, Guid viewer, CancellationToken ct)
        {
            if (filter is not ("genre" or "studio" or "network" or "keywords") || id <= 0 || page is < 1 or > 500) return Task.FromResult(SourceAnswer.Missing);
            var path = $"/api/v1/discover/{(movie ? "movies" : "tv")}?page={page}&{filter}={id}";
            if (!string.IsNullOrEmpty(sortBy)) path += "&sortBy=" + Uri.EscapeDataString(sortBy);
            return FeedAsync(path, viewer, () => FetchAndStoreAsync(path), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> RatingsAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct)
        {
            if (tmdb <= 0) return Task.FromResult(SourceAnswer.Missing);
            var path = movie ? $"/api/v1/movie/{tmdb}/ratingscombined" : $"/api/v1/tv/{tmdb}/ratings";
            return FeedAsync(path, viewer, () => FetchAndStoreAsync(path), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> RelatedAsync(bool movie, int tmdb, string relation, int page, Guid viewer, CancellationToken ct)
        {
            if (tmdb <= 0 || relation is not ("similar" or "recommendations") || page is < 1 or > 500) return Task.FromResult(SourceAnswer.Missing);
            var path = $"/api/v1/{(movie ? "movie" : "tv")}/{tmdb}/{relation}?page={page}";
            return FeedAsync(path, viewer, () => FetchAndStoreAsync(path), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> CollectionAsync(int collection, Guid viewer, CancellationToken ct)
            => collection <= 0 ? Task.FromResult(SourceAnswer.Missing) : Budgeted($"/api/v1/collection/{collection}", viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> KeywordsAsync(string query, Guid viewer, CancellationToken ct)
        {
            if (string.IsNullOrWhiteSpace(query) || query.Length > 100) return Task.FromResult(SourceAnswer.Missing);
            var path = "/api/v1/search/keyword?query=" + Uri.EscapeDataString(query.Trim().ToLowerInvariant());
            return FeedAsync(path, viewer, () => FetchAndStoreAsync(path), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> CompanySeriesAsync(int company, int page, string? sortBy, Guid viewer, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey();
            if (string.IsNullOrWhiteSpace(key) || company <= 0 || page is < 1 or > 500) return Task.FromResult(SourceAnswer.Unavailable);
            var query = $"?with_companies={company}&page={page}";
            if (TmdbCompanyTvDiscover.IsValidSort(sortBy)) query += "&sort_by=" + sortBy;
            // Kept with the Seerr answers (not a Seerr path: TMDB's own discover).
            var path = "tmdb:discover/tv" + query;
            return FeedAsync(path, viewer, () => StoreAsync(path, CompanySeriesFetchAsync(company, query, key)), ct);
        }

        private async Task<SourceAnswer> CompanySeriesFetchAsync(int company, string query, string key)
        {
            try
            {
                using var timeout = new CancellationTokenSource(FetchTimeout);
                var response = await _tmdb.GetAsync("discover/tv", query, key, timeout.Token).ConfigureAwait(false);
                if (!response.IsSuccess) return response.StatusCode == 404 ? SourceAnswer.Missing : SourceAnswer.Unavailable;
                using var doc = JsonDocument.Parse(TmdbCompanyTvDiscover.ToSeerrShape(response.Content, new Dictionary<int, string>()));
                return SourceAnswer.Of(doc.RootElement.Clone());
            }
            catch (Exception ex)
            {
                _logger.Debug($"Native details: TMDB series of company {company} failed: {ex.Message}");
                return SourceAnswer.Unavailable;
            }
        }

        /// <inheritdoc />
        public async Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, CancellationToken ct)
            => (await GetAsync($"/api/v1/{(movie ? "movie" : "tv")}/{tmdb}/recommendations?page=1", ct).ConfigureAwait(false)).Data;

        /// <inheritdoc />
        public async Task<string?> LogoPathAsync(bool movie, int tmdb, CancellationToken ct)
        {
            var key = JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey();
            if (string.IsNullOrWhiteSpace(key)) return null;
            try
            {
                Services.TmdbResponseCache.TmdbResponse? response = null;
                // One retry for a failed first read (a cold start's first TMDB call can time out).
                for (var attempt = 0; attempt < 2 && (response == null || response.StatusCode >= 500 || response.StatusCode == 429); attempt++)
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(FetchTimeout);
                    try
                    {
                        response = await _tmdb.GetAsync($"{(movie ? "movie" : "tv")}/{tmdb}/images", "?include_image_language=en,null", key, timeout.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested && attempt == 0)
                    {
                        response = null;
                    }
                }

                if (response == null || !response.IsSuccess) return null;
                using var doc = JsonDocument.Parse(response.Content);
                if (!doc.RootElement.TryGetProperty("logos", out var logos) || logos.ValueKind != JsonValueKind.Array) return null;
                string? fallback = null;
                foreach (var logo in logos.EnumerateArray())
                {
                    var path = logo.TryGetProperty("file_path", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
                    if (!NativeDetailsArtwork.IsSafeTmdbPath(path)) continue;
                    var lang = logo.TryGetProperty("iso_639_1", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString() : null;
                    if (lang == "en") return path;
                    fallback ??= path;
                }

                return fallback;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                _logger.Debug($"Native details: no logo for {(movie ? "movie" : "tv")}/{tmdb}: {ex.Message}");
                return null;
            }
        }

        /// <inheritdoc />
        public async Task<bool?> IsSeerrLinkedAsync(Guid userId, CancellationToken ct)
        {
            var id = userId.ToString("N");
            var from = LinkSource();
            var now = _now();
            var linked = Known(from, now);
            if (linked != null && (linked.Contains(id) || now - _linkedAt < LinkMissRefresh))
            {
                return linked.Contains(id);
            }

            // A refresh failed a moment ago: answer from what is known (nothing known = can't tell)
            // without queueing behind another refresh, so a hanging Seerr can't convoy every facade request.
            if (now - _linkFailedAt < LinkFailureBackoff) return linked?.Contains(id);
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(LinkRefreshBudget);
            try
            {
                await _linkLock.WaitAsync(budget.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return Known(from, _now())?.Contains(id);
            }

            try
            {
                if (Known(from, _now()) is { } fresh && _now() - _linkedAt < LinkMissRefresh) return fresh.Contains(id);
                if (_now() - _linkFailedAt < LinkFailureBackoff) return Known(from, _now())?.Contains(id);
                // Every page of Seerr's accounts: one missing page would make its people look unlinked.
                var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var complete = false;
                for (var page = 0; page < LinkMaxPages; page++)
                {
                    SourceAnswer users;
                    try
                    {
                        users = await FetchAsync("/api/v1/user?take=" + LinkPageSize.ToString(System.Globalization.CultureInfo.InvariantCulture) + "&skip=" + (page * LinkPageSize).ToString(System.Globalization.CultureInfo.InvariantCulture), budget.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    {
                        users = SourceAnswer.Unavailable;
                    }

                    if (users.Data is not { } body || !body.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) break;
                    var count = 0;
                    foreach (var user in results.EnumerateArray())
                    {
                        count++;
                        if (user.TryGetProperty("jellyfinUserId", out var j) && j.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(j.GetString()))
                        {
                            set.Add(j.GetString()!.Replace("-", string.Empty, StringComparison.Ordinal));
                        }
                    }

                    var total = body.TryGetProperty("pageInfo", out var info) && info.ValueKind == JsonValueKind.Object && info.TryGetProperty("results", out var r) && r.TryGetInt32(out var n) ? n : (int?)null;
                    if (count < LinkPageSize || (total is int all && (page + 1) * LinkPageSize >= all))
                    {
                        complete = true;
                        break;
                    }
                }

                if (!complete)
                {
                    // Seerr unreachable (or more accounts than are read): the previous answer while it is recent
                    // (none, or an old one: can't tell, so the page falls back instead of acting on stale
                    // access), and no retry for a while.
                    _linkFailedAt = _now();
                    return Known(from, _now())?.Contains(id);
                }

                _linked = set;
                _linkedFrom = from;
                _linkedAt = _now();
                return set.Contains(id);
            }
            finally
            {
                _linkLock.Release();
            }
        }

        /// <summary>
        /// The linked accounts read last, while they are an answer: read from the Seerr configured now
        /// (another URL or key is another set of accounts) and no older than <see cref="LinkTtl"/>, even
        /// when Seerr can't be reached to read them again. Otherwise null (can't tell).
        /// </summary>
        private HashSet<string>? Known(string from, DateTime now)
            => _linked is { } set && string.Equals(_linkedFrom, from, StringComparison.Ordinal) && now - _linkedAt < LinkTtl ? set : null;

        /// <summary>A fingerprint of the configured Seerr (URLs and key), never the key itself.</summary>
        private static string LinkSource()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var text = (config?.JellyseerrUrls ?? string.Empty) + "\n" + (config?.GetJellyseerrApiKey() ?? string.Empty);
            return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text)));
        }

        private bool TryCached(string path, out SourceAnswer value)
        {
            value = default;
            if (!_cache.TryGetValue(path, out var hit) || DateTime.UtcNow - hit.At >= (hit.Value.Data.HasValue ? Ttl : FailureTtl)) return false;
            value = hit.Value;
            return true;
        }

        private Task<SourceAnswer> GetAsync(string path, CancellationToken ct)
        {
            if (TryCached(path, out var hit)) return Task.FromResult(hit);
            return _inFlight.GetOrAdd(path, p => Shared(p, () => FetchAndStoreAsync(p))).Value.WaitAsync(ct);
        }

        /// <summary>
        /// A feed read: answered from the cache or a running read of the same path for free; else
        /// started only when the server's queue and the viewer's share of it have room and the viewer's
        /// budget a token (else <see cref="SourceAnswer.Throttled"/>). The place and the upstream slot
        /// are held by the read itself, not by the caller, so a caller that gives up doesn't free them
        /// while the read still runs.
        /// </summary>
        private Task<SourceAnswer> FeedAsync(string path, Guid viewer, Func<Task<SourceAnswer>> fetch, CancellationToken ct)
        {
            if (TryCached(path, out var hit)) return Task.FromResult(hit);
            if (_inFlight.TryGetValue(path, out var running)) return running.Value.WaitAsync(ct);
            if (!_feeds.TryAdmit(viewer)) return Joined(path, ct) ?? Task.FromResult(SourceAnswer.Throttled);
            if (!_feedBudget.Take(viewer))
            {
                _feeds.Leave(viewer, false);
                return Joined(path, ct) ?? Task.FromResult(SourceAnswer.Throttled);
            }

            var mine = Shared(path, async () =>
            {
                var ran = false;
                try
                {
                    await _feeds.TurnAsync(viewer).ConfigureAwait(false);
                    ran = true;
                    return await fetch().ConfigureAwait(false);
                }
                finally
                {
                    _feeds.Leave(viewer, ran);
                }
            });
            var shared = _inFlight.GetOrAdd(path, mine);
            if (!ReferenceEquals(shared, mine))
            {
                // Another caller started the same read a moment ago: join it, nothing was started.
                _feeds.Leave(viewer, false);
                _feedBudget.Refund(viewer);
            }

            return shared.Value.WaitAsync(ct);
        }

        /// <summary>
        /// A read of the same path that another caller started (or finished) while this one was being
        /// admitted: joined for free instead of answering busy. Null when there is none.
        /// </summary>
        private Task<SourceAnswer>? Joined(string path, CancellationToken ct)
        {
            if (TryCached(path, out var hit)) return Task.FromResult(hit);
            return _inFlight.TryGetValue(path, out var running) ? running.Value.WaitAsync(ct) : null;
        }

        /// <summary>
        /// One upstream fetch shared by every caller of a path. The fetch removes its own entry when it
        /// ends, whether or not anyone still waits (a caller that gave up must not leave it behind).
        /// </summary>
        private Lazy<Task<SourceAnswer>> Shared(string path, Func<Task<SourceAnswer>> fetch)
        {
            Lazy<Task<SourceAnswer>>? lazy = null;
            lazy = new Lazy<Task<SourceAnswer>>(async () =>
            {
                try
                {
                    return await fetch().ConfigureAwait(false);
                }
                finally
                {
                    _inFlight.TryRemove(new KeyValuePair<string, Lazy<Task<SourceAnswer>>>(path, lazy!));
                }
            });
            return lazy;
        }

        private async Task<SourceAnswer> FetchAndStoreAsync(string path)
        {
            // Not tied to one caller: a viewer navigating away must not fail the fetch for others.
            var value = await FetchAsync(path, CancellationToken.None).ConfigureAwait(false);
            // Seerr answers 500 for a title TMDB doesn't have (the same as for a TMDB outage): ask TMDB.
            if (value.Data == null && !value.NotFound && await TmdbSaysMissingAsync(path).ConfigureAwait(false)) value = SourceAnswer.Missing;
            return Store(path, value);
        }

        private async Task<SourceAnswer> StoreAsync(string path, Task<SourceAnswer> fetch) => Store(path, await fetch.ConfigureAwait(false));

        private SourceAnswer Store(string path, SourceAnswer value)
        {
            if (_cache.Count >= MaxEntries)
            {
                foreach (var old in _cache.OrderBy(e => e.Value.At).Take(MaxEntries / 10).ToList())
                {
                    _cache.TryRemove(old.Key, out _);
                }
            }

            _cache[path] = (value, DateTime.UtcNow);
            return value;
        }

        /// <summary>
        /// True only when TMDB itself answers 404 for the title (or season, person, studio or network) a
        /// failed Seerr path names; false without a TMDB key, for other paths, and when TMDB can't be asked either.
        /// </summary>
        private async Task<bool> TmdbSaysMissingAsync(string seerrPath)
        {
            var match = TitlePath.Match(seerrPath);
            var key = JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey();
            if (!match.Success || string.IsNullOrWhiteSpace(key)) return false;
            try
            {
                using var timeout = new CancellationTokenSource(FetchTimeout);
                // Seerr's studio is TMDB's company.
                var tmdbPath = match.Groups[1].Value.StartsWith("studio/", StringComparison.Ordinal) ? "company/" + match.Groups[1].Value.Substring(7) : match.Groups[1].Value;
                var response = await _tmdb.GetAsync(tmdbPath, string.Empty, key, timeout.Token).ConfigureAwait(false);
                return response.StatusCode == 404;
            }
            catch (Exception ex)
            {
                _logger.Debug($"Native details: TMDB check for {seerrPath} failed: {ex.Message}");
                return false;
            }
        }

        private async Task<SourceAnswer> FetchAsync(string path, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var apiKey = config?.GetJellyseerrApiKey();
            if (config == null || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(apiKey)) return SourceAnswer.Unavailable;
            var client = SeerrHttpHelper.CreateClient(_http);
            foreach (var raw in config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var url = raw.Trim().TrimEnd('/') + path;
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(FetchTimeout);
                    using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, url, apiKey);
                    using var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false);
                    var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, url, timeout.Token).ConfigureAwait(false);
                    if (error != null || json == null)
                    {
                        // Only Seerr's own (JSON) 404: a proxy's HTML 404 page in front of it is an outage, so the next URL is asked.
                        if (error is { Code: SeerrErrorCode.UpstreamError, HttpStatus: 404 }) return SourceAnswer.Missing;
                        continue;
                    }

                    using var doc = JsonDocument.Parse(json);
                    return SourceAnswer.Of(doc.RootElement.Clone());
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    _logger.Debug($"Native details: Seerr {path} failed: {ex.Message}");
                }
            }

            return SourceAnswer.Unavailable;
        }
    }
}
#endif
