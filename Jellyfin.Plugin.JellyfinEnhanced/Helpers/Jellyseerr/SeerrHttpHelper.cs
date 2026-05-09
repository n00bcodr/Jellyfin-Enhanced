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
    public enum SeerrErrorCode
    {
        Ok = 0,
        Unreachable,
        Unauthorized,
        Forbidden,
        UserUnlinked,
        UserBlocked,
        HtmlResponse,
        UpstreamRedirect,
        Cloudflare5xx,
        UpstreamError,
        ParseError,
        Timeout,
        UrlNotAllowed,
        ConfigInvalid,
    }

    // Message holds the technical text (URL, cf-ray, status) for admins/logs.
    // UserMessage is plain English for non-admin callers — never leaks the URL.
    public class SeerrError
    {
        public SeerrErrorCode Code { get; set; }
        public int HttpStatus { get; set; }
        public string Message { get; set; } = string.Empty;
        public string UserMessage { get; set; } = string.Empty;
        public string? CfRay { get; set; }
        public string? Url { get; set; }

        public object ToResponseShape() => new
        {
            error = true,
            code = Code.ToString(),
            httpStatus = HttpStatus,
            message = !string.IsNullOrEmpty(UserMessage) ? UserMessage : DefaultUserMessage(Code),
        };

        public object ToAdminResponseShape() => new
        {
            error = true,
            code = Code.ToString(),
            httpStatus = HttpStatus,
            message = Message,
            cfRay = CfRay,
            url = Url,
        };

        private static string DefaultUserMessage(SeerrErrorCode code) => code switch
        {
            SeerrErrorCode.Unreachable       => "Can't reach Seerr right now. Please try again in a moment.",
            SeerrErrorCode.Unauthorized      => "Seerr couldn't sign in. Ask your administrator to check the Seerr settings.",
            SeerrErrorCode.Forbidden         => "Seerr declined the request. Ask your administrator to check your account permissions.",
            SeerrErrorCode.UserUnlinked      => "Your Seerr account isn't linked yet. Sign in to Seerr once to enable requests.",
            SeerrErrorCode.UserBlocked       => "Your administrator has disabled Seerr for your account.",
            SeerrErrorCode.HtmlResponse      => "Seerr is unreachable. Ask your administrator to check the connection.",
            SeerrErrorCode.UpstreamRedirect  => "Seerr is unreachable. Ask your administrator to check the connection.",
            SeerrErrorCode.Cloudflare5xx     => "Seerr is having connection issues. Please try again in a moment.",
            SeerrErrorCode.UpstreamError     => "Seerr returned an error. Please try again in a moment.",
            SeerrErrorCode.ParseError        => "Got an unexpected response from Seerr. Please try again in a moment.",
            SeerrErrorCode.Timeout           => "Seerr took too long to respond. Please try again in a moment.",
            SeerrErrorCode.UrlNotAllowed     => "Seerr is not configured correctly. Ask your administrator to check the Seerr URL.",
            SeerrErrorCode.ConfigInvalid     => "Seerr is not configured. Ask your administrator to set it up.",
            _                                => "Seerr is unavailable right now.",
        };

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

    public static class SeerrHttpHelper
    {
        public static string UserAgent { get; set; } = "JellyfinEnhanced/unknown";

        // Named client registered with AllowAutoRedirect=false so a 302 to a
        // login URL is detected (UpstreamRedirect) instead of being followed
        // and producing a 200 + login-page HTML body.
        public const string NamedClient = "JellyfinEnhancedSeerr";

        public static HttpClient CreateClient(IHttpClientFactory factory)
        {
            try { return factory.CreateClient(NamedClient); }
            catch { return factory.CreateClient(); }
        }

        private const int MaxBodyBytes = 8 * 1024 * 1024;

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

        public static bool IsJsonContentType(HttpResponseMessage response)
        {
            var ct = response.Content.Headers.ContentType?.MediaType;
            if (string.IsNullOrEmpty(ct)) return false;
            return ct.Equals("application/json", StringComparison.OrdinalIgnoreCase)
                || (ct.StartsWith("application/", StringComparison.OrdinalIgnoreCase) && ct.EndsWith("+json", StringComparison.OrdinalIgnoreCase));
        }

        public static async Task<(string? Json, SeerrError? Error)> ReadResponseAsync(HttpResponseMessage response, string url, CancellationToken ct = default)
        {
            string? cfRay = null;
            if (response.Headers.TryGetValues("cf-ray", out var rays))
            {
                foreach (var r in rays) { cfRay = r; break; }
            }

            int status = (int)response.StatusCode;
            if (status >= 520 && status <= 530)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.Cloudflare5xx,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Cloudflare returned {status} for {url}. Check Cloudflare logs (cf-ray={cfRay ?? "n/a"}).",
                    UserMessage = "Seerr is having connection issues. Please try again in a moment."
                });
            }

            if (status >= 300 && status < 400 && response.Headers.Location != null)
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.UpstreamRedirect,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Got redirect to {response.Headers.Location} — likely a reverse-proxy auth challenge. Configure your proxy to bypass auth for the Jellyfin server's IP.",
                    UserMessage = "Seerr is unreachable. Ask your administrator to check the connection."
                });
            }

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

            // HTML when JSON expected = reverse-proxy auth challenge intercepting
            // the request. Reject before attempting to parse.
            if (!IsJsonContentType(response))
            {
                return (null, new SeerrError
                {
                    Code = SeerrErrorCode.HtmlResponse,
                    HttpStatus = status,
                    CfRay = cfRay,
                    Url = url,
                    Message = $"Seerr returned non-JSON response (Content-Type: {response.Content.Headers.ContentType?.MediaType ?? "n/a"}). This usually means Cloudflare, Pangolin, or another reverse-proxy intercepted the request. Configure your proxy to bypass auth challenges for the Jellyfin server's IP.",
                    UserMessage = "Seerr is unreachable. Ask your administrator to check the connection."
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
                    Message = "Seerr rejected the API key. Check the key has not been rotated and matches the Seerr install.",
                    UserMessage = "Seerr couldn't sign in. Ask your administrator to check the Seerr settings."
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
                    Message = "Seerr returned 403. Common causes: API key rotated, user lacks permission, or CSRF protection enabled in Seerr.",
                    UserMessage = "Seerr declined the request. Ask your administrator to check your account permissions."
                });
            }

            return (null, new SeerrError
            {
                Code = SeerrErrorCode.UpstreamError,
                HttpStatus = status,
                CfRay = cfRay,
                Url = url,
                Message = $"Seerr returned {status} from {url}.",
                UserMessage = "Seerr returned an error. Please try again in a moment."
            });
        }

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
                    Message = $"Failed to parse Seerr response as {typeof(T).Name}: {ex.Message}",
                    UserMessage = "Got an unexpected response from Seerr. Please try again in a moment."
                });
            }
        }
    }
}
