using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// Adds Seerr's CSRF cookie + header to write requests when Settings > Network >
    /// CSRF Protection is on. Seerr registers its CSRF middleware before API-key auth, so
    /// X-Api-Key alone does not exempt POST/PUT/DELETE. The pair is read from one
    /// GET /api/v1/status per Seerr base URL and sent back by hand: a CookieContainer
    /// would drop the cookies because Seerr marks them Secure and many installs use plain
    /// http inside a Docker network. When Seerr sets no CSRF cookies the request goes out untouched.
    /// </summary>
    public sealed class SeerrCsrfHandler : DelegatingHandler
    {
        private sealed record CsrfPair(string Cookie, string Token);
        private sealed record CacheEntry(CsrfPair? Pair, DateTime FetchedAt);

        // A "no CSRF" answer is rechecked now and then; the 403 retry below also covers the
        // admin turning protection on while the server is running.
        private static readonly TimeSpan NoCsrfTtl = TimeSpan.FromMinutes(10);

        private static readonly ConcurrentDictionary<string, CacheEntry> Cache = new(StringComparer.OrdinalIgnoreCase);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get || request.Method == HttpMethod.Head || request.Method == HttpMethod.Options
                || request.RequestUri == null
                || !request.Headers.TryGetValues("X-Api-Key", out var keys))
            {
                return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            }

            var apiKey = keys.First();
            var baseUrl = BaseUrl(request.RequestUri);
            if (baseUrl == null)
            {
                return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            }

            // Buffer the body so a retry can resend it.
            byte[]? body = null;
            if (request.Content != null)
            {
                body = await request.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            }

            var pair = await GetPairAsync(baseUrl, apiKey, request, forceRefresh: false, cancellationToken).ConfigureAwait(false);
            var response = await base.SendAsync(Apply(Clone(request, body), pair), cancellationToken).ConfigureAwait(false);

            if (response.StatusCode == HttpStatusCode.Forbidden)
            {
                await response.Content.LoadIntoBufferAsync().ConfigureAwait(false);
                var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
                if (text.Contains("csrf", StringComparison.OrdinalIgnoreCase))
                {
                    response.Dispose();
                    pair = await GetPairAsync(baseUrl, apiKey, request, forceRefresh: true, cancellationToken).ConfigureAwait(false);
                    response = await base.SendAsync(Apply(Clone(request, body), pair), cancellationToken).ConfigureAwait(false);
                }
            }

            return response;
        }

        // Everything before /api/v1/ (keeps a reverse-proxy sub-path), or null for non-Seerr URLs.
        private static string? BaseUrl(Uri uri)
        {
            var abs = uri.GetLeftPart(UriPartial.Path);
            var i = abs.IndexOf("/api/v1/", StringComparison.OrdinalIgnoreCase);
            return i < 0 ? null : abs[..i];
        }

        private async Task<CsrfPair?> GetPairAsync(string baseUrl, string apiKey, HttpRequestMessage original, bool forceRefresh, CancellationToken ct)
        {
            if (!forceRefresh && Cache.TryGetValue(baseUrl, out var cached)
                && (cached.Pair != null || DateTime.UtcNow - cached.FetchedAt < NoCsrfTtl))
            {
                return cached.Pair;
            }

            CsrfPair? pair = null;
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/api/v1/status");
                req.Headers.Add("X-Api-Key", apiKey);
                foreach (var ua in original.Headers.UserAgent)
                {
                    req.Headers.UserAgent.Add(ua);
                }

                using var res = await base.SendAsync(req, ct).ConfigureAwait(false);
                string? secret = null, token = null;
                if (res.Headers.TryGetValues("Set-Cookie", out var setCookies))
                {
                    foreach (var header in setCookies)
                    {
                        var nameValue = header.Split(';', 2)[0];
                        var eq = nameValue.IndexOf('=');
                        if (eq <= 0) continue;
                        var name = nameValue[..eq].Trim();
                        var value = nameValue[(eq + 1)..].Trim();
                        if (name == "_csrf") secret = value;
                        else if (name == "XSRF-TOKEN") token = Uri.UnescapeDataString(value);
                    }
                }

                if (secret != null && token != null)
                {
                    pair = new CsrfPair($"_csrf={secret}", token);
                }
            }
            catch (Exception) when (!ct.IsCancellationRequested)
            {
                // Status probe failed: send the write as-is and let it report its own error.
                return null;
            }

            Cache[baseUrl] = new CacheEntry(pair, DateTime.UtcNow);
            return pair;
        }

        private static HttpRequestMessage Apply(HttpRequestMessage request, CsrfPair? pair)
        {
            if (pair != null)
            {
                request.Headers.TryAddWithoutValidation("Cookie", pair.Cookie);
                request.Headers.TryAddWithoutValidation("X-XSRF-TOKEN", pair.Token);
            }

            return request;
        }

        private static HttpRequestMessage Clone(HttpRequestMessage source, byte[]? body)
        {
            var clone = new HttpRequestMessage(source.Method, source.RequestUri) { Version = source.Version };
            foreach (var h in source.Headers)
            {
                clone.Headers.TryAddWithoutValidation(h.Key, h.Value);
            }

            if (body != null)
            {
                clone.Content = new ByteArrayContent(body);
                foreach (var h in source.Content!.Headers)
                {
                    clone.Content.Headers.TryAddWithoutValidation(h.Key, h.Value);
                }
            }

            return clone;
        }
    }
}
