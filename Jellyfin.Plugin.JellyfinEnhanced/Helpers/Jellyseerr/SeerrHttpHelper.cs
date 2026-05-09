using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// Reason codes for Seerr HTTP failures. Frontend code can switch on these
    /// to display meaningful banners instead of "discovery silently disappeared".
    /// Audit cluster CRIT-1 root cause.
    /// </summary>
    public enum SeerrErrorCode
    {
        Ok = 0,
        Unreachable,            // Network failure, DNS error, refused
        Unauthorized,           // 401 from Seerr — usually wrong API key
        Forbidden,              // 403 — Seerr's own permission denial
        UserUnlinked,           // No matching Seerr user for this Jellyfin user
        UserBlocked,            // User is in JellyseerrImportBlockedUsers
        HtmlResponse,           // Cloudflare/Pangolin/SWAG returned HTML challenge
        UpstreamRedirect,       // 302 to a different host — auth provider redirect
        Cloudflare5xx,          // 520-526 from Cloudflare's edge
        UpstreamError,          // Other 4xx/5xx from Seerr
        ParseError,             // Body received but couldn't deserialize as JSON
        Timeout,                // Request took longer than budget
        UrlNotAllowed,          // ArrUrlGuard rejected the URL
        ConfigInvalid,          // No URL or no API key configured
    }

    /// <summary>
    /// Structured error envelope. JSON-serializable so frontend can read .code.
    /// </summary>
    public class SeerrError
    {
        public SeerrErrorCode Code { get; set; }
        public int HttpStatus { get; set; }
        public string Message { get; set; } = string.Empty;
        public string? CfRay { get; set; }
        public string? Url { get; set; }

        /// <summary>
        /// Default response shape for non-admin callers. Internal Seerr URL is
        /// stripped (audit L3-3 / A5/A6 — F33 redacts JellyseerrBaseUrl from
        /// unauth /public-config; the typed error path must apply the same
        /// redaction to non-admin error responses).
        /// </summary>
        public object ToResponseShape() => new
        {
            error = true,
            code = Code.ToString(),
            httpStatus = HttpStatus,
            message = SanitizeMessage(Message),
            cfRay = CfRay,
        };

        /// <summary>
        /// Admin response shape — keeps the full message + URL for diagnostics.
        /// Audit A6: admins clicking "Test connection" want to see the actual
        /// upstream URL that was probed.
        /// </summary>
        public object ToAdminResponseShape() => new
        {
            error = true,
            code = Code.ToString(),
            httpStatus = HttpStatus,
            message = Message,
            cfRay = CfRay,
            url = Url,
        };

        /// <summary>
        /// Strips internal Seerr URLs out of human-readable error messages so
        /// non-admin callers don't see network topology. Audit B-A5-1.
        /// Match shape (each branch covers a host form, then any path/query):
        ///   - bracketed IPv6 host: `[::ffff:169.254.169.254]`
        ///   - regular host: any non-whitespace, non-quote, non-angle, non-paren char
        /// Then any path/query bytes up to a trailing punctuation/whitespace boundary.
        /// `IgnoreCase` so `HTTPS://internal/...` is also stripped.
        /// </summary>
        public static string SanitizeMessage(string message)
        {
            if (string.IsNullOrEmpty(message)) return message;
            return System.Text.RegularExpressions.Regex.Replace(
                message,
                @"https?://(?:\[[^\]\s]+\]|[^\s)\]""'<>/]+)(?:[^\s)\]""'<>]*?)(?=[.,;:!?)\]""'>]*(?:\s|$))",
                "<seerr-url>",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase
            );
        }
    }

    /// <summary>
    /// Centralized helper for Seerr/TMDB outbound HTTP. Replaces ~31 scattered
    /// IHttpClientFactory.CreateClient() + DefaultRequestHeaders sites that
    /// were missing User-Agent, Accept, AllowAutoRedirect=false, and
    /// Content-Type validation. Audits B3 / CRIT-2 cluster.
    /// </summary>
    public static class SeerrHttpHelper
    {
        // Set once at plugin load so logs and the upstream see a stable identity.
        public static string UserAgent { get; set; } = "JellyfinEnhanced/unknown";

        // Named HttpClient registered in PluginServiceRegistrator with
        // AllowAutoRedirect=false. Use via CreateClient() below to make sure
        // 3xx → login redirects are surfaced as UpstreamRedirect (audit L2-3)
        // instead of silently followed by HttpClient's default behaviour.
        public const string NamedClient = "JellyfinEnhancedSeerr";

        /// <summary>
        /// Creates a Seerr-bound HttpClient with the redirect-disabled handler.
        /// Falls back to the default client if the factory doesn't yet know
        /// about <see cref="NamedClient"/> (e.g. unit-test fixtures without
        /// service registration).
        /// </summary>
        public static HttpClient CreateClient(IHttpClientFactory factory)
        {
            try { return factory.CreateClient(NamedClient); }
            catch { return factory.CreateClient(); }
        }

        private const int MaxBodyBytes = 8 * 1024 * 1024; // 8 MB safety cap

        /// <summary>
        /// Builds an HttpRequestMessage with the JE-standard headers attached.
        /// Use this instead of mutating DefaultRequestHeaders on a pooled client.
        /// </summary>
        public static HttpRequestMessage BuildRequest(
            HttpMethod method,
            string url,
            string apiKey,
            string? apiUserId = null,
            string? bodyJson = null)
        {
            var req = new HttpRequestMessage(method, url);
            req.Headers.UserAgent.ParseAdd(UserAgent);
            req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            req.Headers.Add("X-Api-Key", apiKey);
            if (!string.IsNullOrEmpty(apiUserId))
            {
                req.Headers.Add("X-Api-User", apiUserId);
            }
            if (bodyJson != null)
            {
                req.Content = new StringContent(bodyJson, Encoding.UTF8, "application/json");
            }
            return req;
        }

        /// <summary>
        /// Validates the response Content-Type starts with application/json.
        /// On HTML / text the response is classified as HtmlResponse (Cloudflare
        /// challenge, reverse-proxy auth page, etc.) so callers don't try to
        /// parse it as JSON.
        /// </summary>
        public static bool IsJsonContentType(HttpResponseMessage response)
        {
            var ct = response.Content.Headers.ContentType?.MediaType;
            if (string.IsNullOrEmpty(ct)) return false;
            return ct.Equals("application/json", StringComparison.OrdinalIgnoreCase)
                || ct.StartsWith("application/", StringComparison.OrdinalIgnoreCase) && ct.EndsWith("+json", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Reads up to MaxBodyBytes from the response, classifies failure modes,
        /// and either returns the JSON content or a typed SeerrError. Callers
        /// see structured failures instead of opaque empty results.
        /// </summary>
        public static async Task<(string? Json, SeerrError? Error)> ReadResponseAsync(HttpResponseMessage response, string url, CancellationToken ct = default)
        {
            string? cfRay = null;
            if (response.Headers.TryGetValues("cf-ray", out var rays))
            {
                foreach (var r in rays) { cfRay = r; break; }
            }

            // Cloudflare-edge errors map to a distinct code so admins know to
            // look at Cloudflare logs rather than at Seerr.
            int status = (int)response.StatusCode;
            if (status >= 520 && status <= 530)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.Cloudflare5xx,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Cloudflare returned {status} for {url}. Check Cloudflare logs (cf-ray={cfRay ?? "n/a"})."
                });
            }

            // Auth-provider redirect (302 to login). With AllowAutoRedirect=false
            // these surface as 3xx. AllowAutoRedirect=true would silently follow
            // them and return the login HTML — the same failure mode as #146,
            // #225, #38.
            if (status >= 300 && status < 400 && response.Headers.Location != null)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.UpstreamRedirect,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Got redirect to {response.Headers.Location} — likely a reverse-proxy auth challenge. Configure your proxy to bypass auth for the Jellyfin server's IP."
                });
            }

            // Read body (capped) before classifying further so we can include
            // Cloudflare error pages in logs without OOM-ing on a huge response.
            string body;
            using (var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false))
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            {
                var buffer = new char[8192];
                var sb = new StringBuilder(8192);
                int read;
                while ((read = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                {
                    if (sb.Length + read > MaxBodyBytes) { sb.Append(buffer, 0, MaxBodyBytes - sb.Length); break; }
                    sb.Append(buffer, 0, read);
                }
                body = sb.ToString();
            }

            // HTML body when JSON expected = reverse-proxy auth challenge.
            // This is the single most-reported failure mode in JE history
            // (#146, #225, #38, #449, partly #577) — calling it out distinctly
            // unblocks every silent-failure cluster downstream.
            if (!IsJsonContentType(response))
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.HtmlResponse,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Seerr returned non-JSON response (Content-Type: {response.Content.Headers.ContentType?.MediaType ?? "n/a"}). This usually means Cloudflare, Pangolin, or another reverse-proxy intercepted the request. Configure your proxy to bypass auth challenges for the Jellyfin server's IP."
                });
            }

            if (response.IsSuccessStatusCode)
            {
                return (body, null);
            }

            if (status == 401)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.Unauthorized,
                    HttpStatus = 401,
                    CfRay = cfRay,
                    Url = url,
                    Message = "Seerr rejected the API key. Check the key has not been rotated and matches the Seerr install."
                });
            }
            if (status == 403)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.Forbidden,
                    HttpStatus = 403,
                    CfRay = cfRay,
                    Url = url,
                    Message = "Seerr returned 403. Common causes: API key rotated, user lacks permission, or CSRF protection enabled in Seerr."
                });
            }

            return (null, new SeerrError
            {
                Code = SeerrErrorCode.UpstreamError,
                HttpStatus = status,
                CfRay = cfRay,
                Url = url,
                Message = $"Seerr returned {status} from {url}."
            });
        }

        /// <summary>
        /// Attempts to deserialize a JSON body into T. On parse failure returns
        /// a structured ParseError so callers don't fall through to "user not
        /// found" UX.
        /// </summary>
        public static (T? Result, SeerrError? Error) TryDeserialize<T>(string json, string url)
        {
            try
            {
                var result = JsonSerializer.Deserialize<T>(json);
                return (result, null);
            }
            catch (JsonException ex)
            {
                return (default, new SeerrError
                {
                    Code = SeerrErrorCode.ParseError,
                    HttpStatus = 0,
                    Url = url,
                    Message = $"Failed to parse Seerr response as {typeof(T).Name}: {ex.Message}"
                });
            }
        }
    }
}
