using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Translates English review text through the admin's LibreTranslate instance, live per request.
    /// Only a small in-memory cache is kept, so nothing is stored on disk and it cannot grow without bound.
    /// </summary>
    public class ReviewTranslationService
    {
        public const int MaxTextLength = 20000;
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

            // Blank lines are kept as-is; only paragraphs with text go to the instance.
            var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
            var toTranslate = lines.Where(l => !string.IsNullOrWhiteSpace(l)).ToArray();
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
            response.EnsureSuccessStatusCode();
            using var doc = await JsonDocument.ParseAsync(
                await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false), cancellationToken: timeout.Token).ConfigureAwait(false);

            var translated = doc.RootElement.GetProperty("translatedText").EnumerateArray().Select(t => t.GetString() ?? string.Empty).ToArray();
            if (translated.Length != toTranslate.Length)
            {
                throw new InvalidOperationException("Translation response did not match the request.");
            }

            var next = 0;
            var result = string.Join('\n', lines.Select(l => string.IsNullOrWhiteSpace(l) ? l : translated[next++]));

            if (_cache.Count >= MaxCacheEntries)
            {
                _cache.Clear();
            }

            _cache[cacheKey] = (DateTime.UtcNow + CacheTtl, result);
            return result;
        }
    }
}
