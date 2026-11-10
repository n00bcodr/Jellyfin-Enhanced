using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services
{
    /// <summary>
    /// Translates English review text through the admin's LibreTranslate instance, live per request.
    /// Only a small in-memory cache is kept, so nothing is stored on disk and it cannot grow without bound.
    /// </summary>
    public class ReviewTranslationService
    {
        public const int MaxTextLength = 20000;

        /// <summary>
        /// Longest piece of text sent as one translation entry. Hosted LibreTranslate plans reject any
        /// entry over 2,000 characters, so longer paragraphs are sent in pieces.
        /// </summary>
        public const int MaxChunkLength = 2000;

        private const int MaxCacheEntries = 200;
        private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(1);
        private static readonly TimeSpan LanguagesTtl = TimeSpan.FromHours(1);
        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, (DateTime ExpiresUtc, string Text)> _cache = new();
        private (string Url, DateTime ExpiresUtc, IReadOnlyList<string> Codes)? _languages;

        public ReviewTranslationService(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        /// <summary>Language codes English can be translated into on the configured instance.</summary>
        public async Task<IReadOnlyList<string>> GetTargetLanguagesAsync(string baseUrl, CancellationToken cancellationToken)
        {
            var snapshot = _languages;
            if (snapshot is { } s && s.Url == baseUrl && s.ExpiresUtc > DateTime.UtcNow)
            {
                return s.Codes;
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(RequestTimeout);
            using var response = await _httpClientFactory.CreateClient()
                .GetAsync(baseUrl + "/languages", timeout.Token).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            using var doc = await JsonDocument.ParseAsync(
                await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false), cancellationToken: timeout.Token).ConfigureAwait(false);

            var codes = new List<string>();
            foreach (var lang in doc.RootElement.EnumerateArray())
            {
                if (lang.TryGetProperty("code", out var code) && code.GetString() == "en" && lang.TryGetProperty("targets", out var targets))
                {
                    codes.AddRange(targets.EnumerateArray().Select(t => t.GetString() ?? string.Empty).Where(t => t.Length > 0));
                }
            }

            _languages = (baseUrl, DateTime.UtcNow + LanguagesTtl, codes);
            return codes;
        }

        /// <summary>Translates English text into the target language, paragraph by paragraph.</summary>
        public async Task<string> TranslateAsync(string baseUrl, string apiKey, string text, string target, CancellationToken cancellationToken)
        {
            var cacheKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(target + "\n" + text)));
            if (_cache.TryGetValue(cacheKey, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return cached.Text;
            }

            // Blank lines are kept as-is; only paragraphs with text go to the instance,
            // split into pieces when a paragraph is longer than one entry may be.
            var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
            var pieces = lines.Select(l => string.IsNullOrWhiteSpace(l) ? null : SplitIntoChunks(l, MaxChunkLength)).ToArray();
            var toTranslate = pieces.Where(p => p != null).SelectMany(p => p!).Where(c => !string.IsNullOrWhiteSpace(c.Text)).Select(c => c.Text).ToArray();
            if (toTranslate.Length == 0)
            {
                return text;
            }

            var body = new Dictionary<string, object>
            {
                ["q"] = toTranslate,
                ["source"] = "en",
                ["target"] = target,
                ["format"] = "text",
            };
            if (!string.IsNullOrEmpty(apiKey))
            {
                body["api_key"] = apiKey;
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(RequestTimeout);
            using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/translate")
            {
                Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
            };
            using var response = await _httpClientFactory.CreateClient().SendAsync(request, timeout.Token).ConfigureAwait(false);
            if (response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.Forbidden)
            {
                var headers = response.Headers.RetryAfter;
                TimeSpan? retryAfter = headers?.Delta ?? (headers?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
                if (retryAfter < TimeSpan.Zero)
                {
                    retryAfter = TimeSpan.Zero;
                }

                throw new TranslationLimitException(response.StatusCode, retryAfter);
            }

            response.EnsureSuccessStatusCode();
            using var doc = await JsonDocument.ParseAsync(
                await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false), cancellationToken: timeout.Token).ConfigureAwait(false);

            var translated = doc.RootElement.GetProperty("translatedText").EnumerateArray().Select(t => t.GetString() ?? string.Empty).ToArray();
            if (translated.Length != toTranslate.Length)
            {
                throw new InvalidOperationException("Translation response did not match the request.");
            }

            var next = 0;
            var result = string.Join('\n', lines.Select((l, i) => pieces[i] is not { } chunks ? l : string.Concat(
                chunks.Select(c => (string.IsNullOrWhiteSpace(c.Text) ? c.Text : translated[next++]) + c.Separator))));

            if (_cache.Count >= MaxCacheEntries)
            {
                _cache.Clear();
            }

            _cache[cacheKey] = (DateTime.UtcNow + CacheTtl, result);
            return result;
        }

        /// <summary>
        /// Splits one paragraph into pieces of at most <paramref name="maxLength"/> characters, cutting after a
        /// sentence where possible, else between words, else mid-word. Each piece keeps the whitespace that followed
        /// it as its separator, so joining every text and separator in order gives back the paragraph. A paragraph
        /// within the limit is one piece with no separator.
        /// </summary>
        internal static List<(string Text, string Separator)> SplitIntoChunks(string line, int maxLength)
        {
            var chunks = new List<(string Text, string Separator)>();
            var start = 0;
            while (line.Length - start > maxLength)
            {
                var end = start + maxLength;
                var cut = LastBreak(line, start, end, sentence: true);
                if (cut <= start)
                {
                    cut = LastBreak(line, start, end, sentence: false);
                }

                if (cut <= start)
                {
                    // No whitespace to cut at: cut hard, but never between the halves of a surrogate pair.
                    cut = char.IsHighSurrogate(line[end - 1]) ? end - 1 : end;
                }

                var next = cut;
                while (next < line.Length && char.IsWhiteSpace(line[next]))
                {
                    next++;
                }

                chunks.Add((line[start..cut], line[cut..next]));
                start = next;
            }

            chunks.Add((line[start..], string.Empty));
            return chunks;
        }

        /// <summary>
        /// The last position in (start, end] where whitespace begins after text, so that line[start..position] fits.
        /// With <paramref name="sentence"/>, the text before it must end a sentence (., !, ? or …, optionally
        /// followed by closing quotes or brackets). Returns -1 when there is none.
        /// </summary>
        private static int LastBreak(string line, int start, int end, bool sentence)
        {
            for (var i = Math.Min(end, line.Length - 1); i > start; i--)
            {
                if (!char.IsWhiteSpace(line[i]) || char.IsWhiteSpace(line[i - 1]))
                {
                    continue;
                }

                if (!sentence)
                {
                    return i;
                }

                var j = i - 1;
                while (j > start && "\"')]»”’".Contains(line[j], StringComparison.Ordinal))
                {
                    j--;
                }

                if (".!?…".Contains(line[j], StringComparison.Ordinal))
                {
                    return i;
                }
            }

            return -1;
        }
    }

    /// <summary>
    /// The translation service refused the request: 429 (rate limited) or 403 (too many limit violations,
    /// or an API key it does not accept). <see cref="RetryAfter"/> is the wait the service asked for, if any.
    /// </summary>
    public sealed class TranslationLimitException : HttpRequestException
    {
        public TranslationLimitException(HttpStatusCode statusCode, TimeSpan? retryAfter)
            : base(statusCode == HttpStatusCode.TooManyRequests
                ? "The translation service is rate limiting requests."
                : "The translation service refused the request (too many requests, or the API key was not accepted).", null, statusCode)
        {
            RetryAfter = retryAfter;
        }

        public TimeSpan? RetryAfter { get; }
    }
}
