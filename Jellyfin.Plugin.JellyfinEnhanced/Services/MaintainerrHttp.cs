using System;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The one way the plugin talks to Maintainerr, shared by the Leaving soon reads
    /// (<see cref="LeavingSoonService"/>) and the administrator's actions
    /// (<see cref="MaintainerrActions"/>): the address guard, the named client that never
    /// follows a redirect, the request timeout, the answer size cap and the
    /// <c>X-Api-Key</c> header. The key is never logged and the URL is never logged
    /// either (its path may carry a token).
    /// </summary>
    internal static class MaintainerrHttp
    {
        /// <summary>Largest Maintainerr answer read (bytes).</summary>
        internal const int MaxResponseBytes = 16 * 1024 * 1024;

        /// <summary>The configured base address without a trailing slash, or null when none is set.</summary>
        internal static string? BaseUrl(PluginConfiguration? config)
            => config != null && config.LeavingSoonMaintainerrEnabled && !LeavingSoonService.UsesReclaimerr(config) && LeavingSoonService.IsMaintainerrUrl(config.LeavingSoonMaintainerrUrl) ? config.LeavingSoonMaintainerrUrl.Trim().TrimEnd('/') : null;

        /// <summary>
        /// Send one request and parse its JSON answer. A 3xx answer, a redirect a client
        /// followed anyway, an address the guard refuses, a failure status or an answer over
        /// <see cref="MaxResponseBytes"/> throws (see <see cref="Describe"/>). An empty
        /// success body answers an empty JSON object.
        /// </summary>
        /// <param name="http">The client factory (<see cref="LeavingSoonService.ClientName"/> is used).</param>
        /// <param name="config">The configuration holding the key.</param>
        /// <param name="method">GET, POST or DELETE.</param>
        /// <param name="url">The absolute address.</param>
        /// <param name="body">A JSON body for POST, or null.</param>
        /// <param name="timeout">The request timeout.</param>
        /// <param name="onRedirect">Told where a 3xx pointed (the caller logs the host once).</param>
        /// <param name="token">The caller's cancellation.</param>
        /// <param name="asUser">Reclaimerr only: send this user header instead of the token (its trusted-proxy sign-in).</param>
        internal static async Task<JsonDocument> SendAsync(IHttpClientFactory http, PluginConfiguration config, HttpMethod method, string url, string? body, TimeSpan timeout, Action<Uri, Uri?>? onRedirect, CancellationToken token, (string Name, string Value)? asUser = null, (string Name, string Value)? alsoHeader = null)
        {
            if (!await Helpers.ArrUrlGuard.IsAllowedUrlAsync(url, token).ConfigureAwait(false)) throw new UnauthorizedAccessException();
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
            limit.CancelAfter(timeout);
            var client = http.CreateClient(LeavingSoonService.ClientName);
            var target = new Uri(url);
            using var request = new HttpRequestMessage(method, target);
            request.Headers.Accept.ParseAdd("application/json");
            if (asUser is { } who) request.Headers.TryAddWithoutValidation(who.Name, who.Value);
            else if (LeavingSoonService.UsesReclaimerr(config))
            {
                var bearer = (config.ReclaimerrToken ?? string.Empty).Trim();
                if (bearer.Length > 0) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearer);
            }
            else
            {
                var key = (config.LeavingSoonMaintainerrApiKey ?? string.Empty).Trim();
                if (key.Length > 0) request.Headers.TryAddWithoutValidation("X-Api-Key", key);
            }
            if (alsoHeader is { } extra) request.Headers.TryAddWithoutValidation(extra.Name, extra.Value);
            if (body != null) request.Content = new StringContent(body, Encoding.UTF8, new MediaTypeHeaderValue("application/json"));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, limit.Token).ConfigureAwait(false);
            if ((int)response.StatusCode is >= 300 and < 400)
            {
                onRedirect?.Invoke(target, response.Headers.Location);
                throw new RedirectException();
            }

            // A client that followed a redirect anyway (not ClientName's) answered for another address: refuse it.
            if (response.RequestMessage?.RequestUri is { } answered && answered != target) throw new RedirectException();
            if (response.Content.Headers.ContentLength > MaxResponseBytes) throw new InvalidDataException();
            await using var stream = await response.Content.ReadAsStreamAsync(limit.Token).ConfigureAwait(false);
            using var buffer = new MemoryStream();
            var chunk = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(chunk, limit.Token).ConfigureAwait(false)) > 0)
            {
                if (buffer.Length + read > MaxResponseBytes) throw new InvalidDataException();
                buffer.Write(chunk, 0, read);
            }

            if (!response.IsSuccessStatusCode) throw new MaintainerrException((int)response.StatusCode, ErrorMessage(buffer.ToArray()));
            return buffer.Length == 0 ? JsonDocument.Parse("{}") : JsonDocument.Parse(buffer.ToArray());
        }

        /// <summary>Maintainerr's own reason from an error body (<c>{"message": ...}</c>), clipped, or null.</summary>
        private static string? ErrorMessage(byte[] body)
        {
            if (body.Length == 0) return null;
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
                // Maintainerr says {"message": ...}; Reclaimerr (FastAPI) says {"detail": "..."} or {"detail": [{"msg": ...}]}.
                if (!doc.RootElement.TryGetProperty("message", out var message) && !doc.RootElement.TryGetProperty("detail", out message)) return null;
                var text = message.ValueKind == JsonValueKind.String ? message.GetString()
                    : message.ValueKind == JsonValueKind.Array && message.GetArrayLength() > 0 ? (message[0].ValueKind == JsonValueKind.Object && message[0].TryGetProperty("msg", out var msg) ? msg.ToString() : message[0].ToString())
                    : null;
                if (string.IsNullOrWhiteSpace(text)) return null;
                text = text.Trim();
                return text.Length <= 300 ? text : text[..300];
            }
            catch (JsonException) { return null; }
        }

        /// <summary>A short reason for the admin page and the action answers, without the URL or key.</summary>
        internal static string Describe(Exception ex) => ex switch
        {
            MaintainerrException m => m.Reason ?? ("HTTP " + m.Status.ToString(CultureInfo.InvariantCulture)),
            ReclaimerrApi.VersionException v => v.Message,
            HttpRequestException { StatusCode: { } code } => "HTTP " + ((int)code).ToString(CultureInfo.InvariantCulture),
            HttpRequestException => "not reachable",
            TaskCanceledException or TimeoutException => "timed out",
            LeavingSoonService.DateRangeException => "a delete date is out of range",
            JsonException => "not a Maintainerr collections answer",
            InvalidDataException => "answer too large",
            UnauthorizedAccessException => "address not allowed",
            RedirectException => "redirected (redirects are not followed)",
            _ => "request failed",
        };

        /// <summary>A 3xx answer: never followed.</summary>
        internal sealed class RedirectException : Exception
        {
        }

        /// <summary>A failure status from Maintainerr, with its own reason when the body had one.</summary>
        internal sealed class MaintainerrException : Exception
        {
            public MaintainerrException(int status, string? reason) : base("Maintainerr answered " + status.ToString(CultureInfo.InvariantCulture))
            {
                Status = status;
                Reason = reason;
            }

            public int Status { get; }
            public string? Reason { get; }
        }
    }
}
