using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Top user reviews for an anime from AniList's public GraphQL API, by AniList id.
    /// Cached in memory only. AniList's documented limit is 90 requests a minute, but it has
    /// been running in a degraded mode that enforces 30 a minute (x-ratelimit-limit: 30), so a
    /// 429 or 403 is remembered until its Retry-After passes and concurrent views of the same
    /// anime share one request.
    /// </summary>
    public class AnilistReviewsService
    {
        private const string Endpoint = "https://graphql.anilist.co";
        private const int MaxReviews = 10;
        private static readonly TimeSpan FoundTtl = TimeSpan.FromHours(12);
        private static readonly TimeSpan MissTtl = TimeSpan.FromHours(2);
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);
        // Wait used when a 429/403 has no usable Retry-After, and the longest wait honoured.
        private static readonly TimeSpan DefaultRetryAfter = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromMinutes(10);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly TimeProvider _clock;
        private readonly ConcurrentDictionary<int, (DateTime ExpiresUtc, AnilistReviewsResult Result)> _cache = new();
        // Ids AniList refused (429/403), until when. Never written on success, so it can't hide a cached result.
        private readonly ConcurrentDictionary<int, DateTime> _limitedUntil = new();
        // One upstream request per id at a time; later callers await the same task.
        private readonly ConcurrentDictionary<int, Lazy<Task<AnilistReviewsResult>>> _inFlight = new();
        // Service-wide pause from the latest 429 (UTC ticks), so other ids skip AniList too.
        private long _pausedUntilTicks;
        private int _remainingExhaustedLogged;

        public AnilistReviewsService(IHttpClientFactory httpClientFactory, Logger logger)
            : this(httpClientFactory, logger, TimeProvider.System)
        {
        }

        internal AnilistReviewsService(IHttpClientFactory httpClientFactory, Logger logger, TimeProvider clock)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _clock = clock;
        }

        private DateTime UtcNow => _clock.GetUtcNow().UtcDateTime;

        public async Task<AnilistReviewsResult> GetReviewsAsync(int anilistId, CancellationToken cancellationToken)
        {
            if (TryGetCached(anilistId, out var cachedResult))
            {
                return cachedResult;
            }

            ThrowIfRateLimited(anilistId);

            // The shared request isn't tied to one caller's token, so a viewer navigating away
            // can't fail the request for everyone else waiting on it; RequestTimeout bounds it.
            var flight = _inFlight.GetOrAdd(anilistId, id => new Lazy<Task<AnilistReviewsResult>>(
                () => FetchSharedAsync(id), LazyThreadSafetyMode.ExecutionAndPublication));
            return await flight.Value.WaitAsync(cancellationToken).ConfigureAwait(false);
        }

        private bool TryGetCached(int anilistId, out AnilistReviewsResult result)
        {
            if (_cache.TryGetValue(anilistId, out var cached) && cached.ExpiresUtc > UtcNow)
            {
                result = cached.Result;
                return true;
            }

            result = AnilistReviewsResult.Empty;
            return false;
        }

        private void ThrowIfRateLimited(int anilistId)
        {
            var now = UtcNow;
            if (_limitedUntil.TryGetValue(anilistId, out var until))
            {
                if (until > now)
                {
                    throw RateLimited(until - now);
                }

                _limitedUntil.TryRemove(new KeyValuePair<int, DateTime>(anilistId, until));
            }

            var pausedUntil = new DateTime(Interlocked.Read(ref _pausedUntilTicks), DateTimeKind.Utc);
            if (pausedUntil > now)
            {
                throw RateLimited(pausedUntil - now);
            }
        }

        private static HttpRequestException RateLimited(TimeSpan wait) =>
            new($"AniList is rate limiting requests; retrying in {Math.Ceiling(wait.TotalSeconds)}s.", null, HttpStatusCode.TooManyRequests);

        private async Task<AnilistReviewsResult> FetchSharedAsync(int anilistId)
        {
            try
            {
                // A caller that missed the cache just before the previous request finished.
                if (TryGetCached(anilistId, out var cachedResult))
                {
                    return cachedResult;
                }

                ThrowIfRateLimited(anilistId);
                return await FetchAsync(anilistId).ConfigureAwait(false);
            }
            finally
            {
                _inFlight.TryRemove(anilistId, out _);
            }
        }

        private async Task<AnilistReviewsResult> FetchAsync(int anilistId)
        {
            var query = "query($v:Int){Media(id:$v,type:ANIME){siteUrl " +
                $"reviews(sort:RATING_DESC,perPage:{MaxReviews}){{nodes{{id summary score rating ratingAmount createdAt siteUrl user{{name siteUrl}} body(asHtml:false)}}}}}}}}";
            var payload = JsonSerializer.Serialize(new { query, variables = new { v = anilistId } });

            using var timeout = new CancellationTokenSource(RequestTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            request.Headers.UserAgent.ParseAdd("JellyfinEnhancedPlugin/1.0 (https://github.com/n00bcodr/Jellyfin-Enhanced)");

            using var response = await _httpClientFactory.CreateClient().SendAsync(request, timeout.Token).ConfigureAwait(false);
            NoteRemaining(response);

            if (response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.Forbidden)
            {
                var now = UtcNow;
                var wait = RetryAfter(response, now);
                var until = now + wait;
                _limitedUntil[anilistId] = until;
                if (response.StatusCode == HttpStatusCode.TooManyRequests)
                {
                    Interlocked.Exchange(ref _pausedUntilTicks, until.Ticks);
                }

                _logger.Warning($"[AniList] {(int)response.StatusCode} for anime {anilistId}; not asking AniList again for {Math.Ceiling(wait.TotalSeconds)}s.");
                throw new HttpRequestException(
                    $"AniList refused the request ({(int)response.StatusCode}); retrying in {Math.Ceiling(wait.TotalSeconds)}s.", null, response.StatusCode);
            }

            AnilistReviewsResult result;
            // 404 means AniList has no such media
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                result = AnilistReviewsResult.Empty;
            }
            else
            {
                response.EnsureSuccessStatusCode();
                using var doc = await JsonDocument.ParseAsync(
                    await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false), cancellationToken: timeout.Token).ConfigureAwait(false);
                result = Parse(doc.RootElement);
            }

            _cache[anilistId] = (UtcNow + (result.Reviews.Count > 0 ? FoundTtl : MissTtl), result);
            return result;
        }

        /// <summary>Retry-After as a delta or an HTTP date, else the default, capped at MaxRetryAfter.</summary>
        internal static TimeSpan RetryAfter(HttpResponseMessage response, DateTime nowUtc)
        {
            var header = response.Headers.RetryAfter;
            TimeSpan? wait = header?.Delta ?? (header?.Date is { } date ? date.UtcDateTime - nowUtc : null);
            if (wait is not { } value || value <= TimeSpan.Zero)
            {
                return DefaultRetryAfter;
            }

            return value > MaxRetryAfter ? MaxRetryAfter : value;
        }

        private void NoteRemaining(HttpResponseMessage response)
        {
            if (!response.Headers.TryGetValues("x-ratelimit-remaining", out var values)
                || !int.TryParse(values.FirstOrDefault(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var remaining))
            {
                return;
            }

            if (remaining > 0)
            {
                Interlocked.Exchange(ref _remainingExhaustedLogged, 0);
            }
            else if (Interlocked.Exchange(ref _remainingExhaustedLogged, 1) == 0)
            {
                _logger.Debug("[AniList] x-ratelimit-remaining reached 0; further requests this minute will be refused.");
            }
        }

        private static AnilistReviewsResult Parse(JsonElement root)
        {
            if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object
                || !data.TryGetProperty("Media", out var media) || media.ValueKind != JsonValueKind.Object)
            {
                return AnilistReviewsResult.Empty;
            }

            var reviews = new List<AnilistReview>();
            if (media.TryGetProperty("reviews", out var reviewsEl) && reviewsEl.TryGetProperty("nodes", out var nodes))
            {
                foreach (var n in nodes.EnumerateArray())
                {
                    var user = n.TryGetProperty("user", out var u) && u.ValueKind == JsonValueKind.Object ? u : default;
                    var createdAt = n.TryGetProperty("createdAt", out var c) && c.ValueKind == JsonValueKind.Number
                        ? DateTimeOffset.FromUnixTimeSeconds(c.GetInt64()).UtcDateTime.ToString("o")
                        : null;
                    reviews.Add(new AnilistReview(
                        Author: user.ValueKind == JsonValueKind.Object ? Str(user, "name") : null,
                        Summary: Str(n, "summary"),
                        Content: CleanBody(Str(n, "body")),
                        Score: n.TryGetProperty("score", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetInt32() : null,
                        Rating: n.TryGetProperty("rating", out var r) && r.ValueKind == JsonValueKind.Number ? r.GetInt32() : 0,
                        RatingAmount: n.TryGetProperty("ratingAmount", out var ra) && ra.ValueKind == JsonValueKind.Number ? ra.GetInt32() : 0,
                        CreatedAt: createdAt,
                        Url: Str(n, "siteUrl")));
                }
            }

            return new AnilistReviewsResult(Str(media, "siteUrl"), reviews);
        }

        private static string? Str(JsonElement el, string name) =>
            el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        /// <summary>Hides ~!spoiler!~ sections and drops embedded media.</summary>
        private static string CleanBody(string? body)
        {
            if (string.IsNullOrWhiteSpace(body))
            {
                return string.Empty;
            }

            var text = Regex.Replace(body, @"~!.*?!~", "[spoiler hidden]", RegexOptions.Singleline);
            text = Regex.Replace(text, @"(?:img\d*|webm|youtube)\([^)]*\)", string.Empty, RegexOptions.IgnoreCase);
            text = Regex.Replace(text, @"</?[a-zA-Z][^>]*>", string.Empty);
            return Regex.Replace(text, @"\n{3,}", "\n\n").Trim();
        }
    }

    public sealed record AnilistReview(string? Author, string? Summary, string Content, int? Score, int Rating, int RatingAmount, string? CreatedAt, string? Url);

    public sealed record AnilistReviewsResult(string? SiteUrl, IReadOnlyList<AnilistReview> Reviews)
    {
        public static readonly AnilistReviewsResult Empty = new(null, Array.Empty<AnilistReview>());
    }
}
