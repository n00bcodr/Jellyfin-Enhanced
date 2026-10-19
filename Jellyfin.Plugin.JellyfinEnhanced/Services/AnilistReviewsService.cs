using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
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
    /// Cached in memory only, since AniList allows about 90 requests a minute.
    /// </summary>
    public class AnilistReviewsService
    {
        private const string Endpoint = "https://graphql.anilist.co";
        private const int MaxReviews = 10;
        private static readonly TimeSpan FoundTtl = TimeSpan.FromHours(12);
        private static readonly TimeSpan MissTtl = TimeSpan.FromHours(2);
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<int, (DateTime ExpiresUtc, AnilistReviewsResult Result)> _cache = new();

        public AnilistReviewsService(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        public async Task<AnilistReviewsResult> GetReviewsAsync(int anilistId, CancellationToken cancellationToken)
        {
            if (_cache.TryGetValue(anilistId, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return cached.Result;
            }

            var query = "query($v:Int){Media(id:$v,type:ANIME){siteUrl " +
                $"reviews(sort:RATING_DESC,perPage:{MaxReviews}){{nodes{{id summary score rating ratingAmount createdAt siteUrl user{{name siteUrl}} body(asHtml:false)}}}}}}}}";
            var payload = JsonSerializer.Serialize(new { query, variables = new { v = anilistId } });

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(RequestTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
            {
                Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            };
            request.Headers.UserAgent.ParseAdd("JellyfinEnhancedPlugin/1.0 (https://github.com/n00bcodr/Jellyfin-Enhanced)");

            using var response = await _httpClientFactory.CreateClient().SendAsync(request, timeout.Token).ConfigureAwait(false);

            AnilistReviewsResult result;
            // 404 means AniList has no such media
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
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

            _cache[anilistId] = (DateTime.UtcNow + (result.Reviews.Count > 0 ? FoundTtl : MissTtl), result);
            return result;
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
