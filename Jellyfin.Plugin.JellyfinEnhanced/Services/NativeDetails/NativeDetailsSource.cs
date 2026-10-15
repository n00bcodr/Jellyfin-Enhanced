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
        /// True when the Jellyfin user has a linked Seerr account, false when not, null when it can't
        /// be told (Seerr unreachable and no earlier answer): the page then fails over to the modal
        /// instead of refusing.
        /// </summary>
        Task<bool?> IsSeerrLinkedAsync(Guid userId, CancellationToken ct);
    }

    /// <summary>
    /// One source answer: the data, a title the source says doesn't exist (<see cref="NotFound"/>,
    /// answered 404), or neither because the source can't be reached right now (answered 503).
    /// </summary>
    /// <param name="Data">The JSON, when there is some.</param>
    /// <param name="NotFound">True when the source answered "no such title" (Seerr 404).</param>
    public readonly record struct SourceAnswer(JsonElement? Data, bool NotFound)
    {
        /// <summary>The source can't answer now (outage, timeout, not configured).</summary>
        public static SourceAnswer Unavailable => default;

        /// <summary>The source says the title (or season) doesn't exist.</summary>
        public static SourceAnswer Missing => new(null, true);

        /// <summary>An answer with data.</summary>
        /// <param name="data">The JSON.</param>
        /// <returns>The answer.</returns>
        public static SourceAnswer Of(JsonElement data) => new(data, false);
    }

    /// <summary>Seerr (and, for logos, TMDB) behind bounded, coalesced caches.</summary>
    public sealed class SeerrNativeDetailsSource : INativeDetailsSource
    {
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
        private readonly Func<DateTime> _now;
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
        }

        /// <summary>Upstream fetches still running (for tests: none may outlive its fetch).</summary>
        internal int InFlightCount => _inFlight.Count;

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
                SourceAnswer users;
                try
                {
                    users = await FetchAsync("/api/v1/user?take=1000", budget.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    users = SourceAnswer.Unavailable;
                }

                if (users.Data is not { } body || !body.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                {
                    // Seerr unreachable: the previous answer while it is recent (none, or an old one: can't
                    // tell, so the page falls back instead of acting on stale access), and no retry for a while.
                    _linkFailedAt = _now();
                    return Known(from, _now())?.Contains(id);
                }

                var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var user in results.EnumerateArray())
                {
                    if (user.TryGetProperty("jellyfinUserId", out var j) && j.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(j.GetString()))
                    {
                        set.Add(j.GetString()!.Replace("-", string.Empty, StringComparison.Ordinal));
                    }
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

        private Task<SourceAnswer> GetAsync(string path, CancellationToken ct)
        {
            if (_cache.TryGetValue(path, out var hit) && DateTime.UtcNow - hit.At < (hit.Value.Data.HasValue ? Ttl : FailureTtl))
            {
                return Task.FromResult(hit.Value);
            }

            return _inFlight.GetOrAdd(path, Shared).Value.WaitAsync(ct);
        }

        /// <summary>
        /// One upstream fetch shared by every caller of a path. The fetch removes its own entry when it
        /// ends, whether or not anyone still waits (a caller that gave up must not leave it behind).
        /// </summary>
        private Lazy<Task<SourceAnswer>> Shared(string path)
        {
            Lazy<Task<SourceAnswer>>? lazy = null;
            lazy = new Lazy<Task<SourceAnswer>>(async () =>
            {
                try
                {
                    return await FetchAndStoreAsync(path).ConfigureAwait(false);
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
                        if (error?.HttpStatus == 404) return SourceAnswer.Missing;
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
