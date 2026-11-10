using System;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr
{
    /// <summary>
    /// What the Seerr proxy knows about a failed write (POST) it was asked to forward.
    /// Serialized as the lowercase <c>requestOutcome</c> property of the failure envelope,
    /// with exactly the wire values <c>unknown</c>, <c>rejected</c> and <c>not_sent</c>.
    /// Reads never carry it.
    /// </summary>
    [JsonConverter(typeof(JsonStringEnumConverter<SeerrRequestOutcome>))]
    public enum SeerrRequestOutcome
    {
        /// <summary>
        /// The write was handed to the network and Seerr may have applied it: no
        /// response, an unreadable or unusable response, a 5xx, a redirect, a timeout.
        /// </summary>
        [JsonStringEnumMemberName("unknown")]
        Unknown,

        /// <summary>Seerr answered with an explicit JSON 4xx (quota, permission, duplicate, validation, API key).</summary>
        [JsonStringEnumMemberName("rejected")]
        Rejected,

        /// <summary>JE refused or failed the write before any byte of it reached a Seerr URL.</summary>
        [JsonStringEnumMemberName("not_sent")]
        NotSent,
    }

    /// <summary>Classification rules for <see cref="SeerrRequestOutcome"/>.</summary>
    public static class SeerrRequestOutcomes
    {
        /// <summary>The JSON property name carrying the outcome on a failed write.</summary>
        public const string PropertyName = "requestOutcome";

        /// <summary>The exact wire value for an outcome.</summary>
        /// <param name="outcome">The outcome.</param>
        /// <returns><c>unknown</c>, <c>rejected</c> or <c>not_sent</c>.</returns>
        public static string ToWireValue(this SeerrRequestOutcome outcome) => outcome switch
        {
            SeerrRequestOutcome.Rejected => "rejected",
            SeerrRequestOutcome.NotSent => "not_sent",
            _ => "unknown",
        };

        /// <summary>
        /// Classifies a complete upstream response that <see cref="SeerrHttpHelper.ReadResponseAsync"/>
        /// turned into an error. Only a JSON 4xx (other than 408) is a definite rejection:
        /// that is Seerr's own API error answer. Non-JSON bodies (including 2xx and proxy
        /// block pages), redirects, Cloudflare 52x, 5xx and parse failures stay unknown,
        /// because the write may already have been applied behind them.
        /// </summary>
        /// <param name="error">The structured upstream error.</param>
        /// <returns>The outcome to report to the browser.</returns>
        public static SeerrRequestOutcome ForUpstreamError(SeerrError error)
        {
            ArgumentNullException.ThrowIfNull(error);
            return error.Code switch
            {
                // ReadResponseAsync only produces these for application/json 401/403.
                SeerrErrorCode.Unauthorized or SeerrErrorCode.Forbidden => SeerrRequestOutcome.Rejected,
                SeerrErrorCode.UpstreamError when error.HttpStatus >= 400 && error.HttpStatus <= 499 && error.HttpStatus != 408
                    => SeerrRequestOutcome.Rejected,
                _ => SeerrRequestOutcome.Unknown,
            };
        }

        /// <summary>
        /// True only when the exception proves the connection was never established, so no
        /// request byte left this host: a DNS failure or a refused/unroutable TCP connect.
        /// Everything else after dispatch (timeouts, resets, a response that ended early,
        /// TLS failures, cancellation) is treated as possibly applied.
        /// </summary>
        /// <param name="exception">The exception thrown by <see cref="HttpClient.SendAsync(HttpRequestMessage, System.Threading.CancellationToken)"/>.</param>
        /// <returns>Whether the request provably did not reach the upstream.</returns>
        public static bool IsProvablyUnsent(Exception exception)
        {
            if (exception is not HttpRequestException http
                || (http.HttpRequestError != HttpRequestError.NameResolutionError
                    && http.HttpRequestError != HttpRequestError.ConnectionError))
            {
                return false;
            }

            for (Exception? inner = http.InnerException; inner != null; inner = inner.InnerException)
            {
                if (inner is SocketException socket)
                {
                    return socket.SocketErrorCode is SocketError.ConnectionRefused
                        or SocketError.HostNotFound
                        or SocketError.TryAgain
                        or SocketError.NoData
                        or SocketError.HostUnreachable
                        or SocketError.NetworkUnreachable
                        or SocketError.AddressNotAvailable;
                }
            }

            return false;
        }

        /// <summary>Whether a 2xx body Seerr sent for a write is a complete JSON document.</summary>
        /// <param name="body">The (possibly truncated) body text.</param>
        /// <returns>False for empty, truncated or malformed JSON.</returns>
        public static bool IsUsableWriteResponse(string body)
        {
            if (string.IsNullOrWhiteSpace(body)) return false;
            try
            {
                using var _ = JsonDocument.Parse(body);
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
        }
    }

    /// <summary>
    /// The structured failure body of the Seerr proxy (<c>ProxyJellyseerrRequest</c>). Property names
    /// are pinned lowercase and absent optional fields are omitted, so reads keep their existing wire
    /// shape and only failed writes add <see cref="RequestOutcome"/>.
    /// </summary>
    public sealed class SeerrProxyErrorResponse
    {
        /// <summary>Always <c>true</c> where the existing envelope carried it; omitted on the permission envelopes that never did.</summary>
        [JsonPropertyName("error")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public bool? Error { get; init; }

        /// <summary>The existing machine-readable failure code (for example <c>unreachable</c>, <c>Forbidden</c>, <c>no_request_permission</c>).</summary>
        [JsonPropertyName("code")]
        public required string Code { get; init; }

        /// <summary>The upstream HTTP status when Seerr (or a proxy in front of it) answered.</summary>
        [JsonPropertyName("httpStatus")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public int? HttpStatus { get; init; }

        /// <summary>Sanitized text for non-admins; the technical text (may name the Seerr URL) for Jellyfin administrators.</summary>
        [JsonPropertyName("message")]
        public required string Message { get; init; }

        /// <summary>Cloudflare ray id, administrators only.</summary>
        [JsonPropertyName("cfRay")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? CfRay { get; init; }

        /// <summary>Upstream URL, administrators only.</summary>
        [JsonPropertyName("url")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Url { get; init; }

        /// <summary>Set on every failed write, never on reads.</summary>
        [JsonPropertyName(SeerrRequestOutcomes.PropertyName)]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        [JsonConverter(typeof(JsonStringEnumConverter<SeerrRequestOutcome>))]
        public SeerrRequestOutcome? RequestOutcome { get; init; }

        /// <summary>A JE-generated failure envelope (no upstream status).</summary>
        /// <param name="code">The failure code.</param>
        /// <param name="message">The message, already sanitized for the caller.</param>
        /// <param name="outcome">The write outcome, or null for a read.</param>
        /// <param name="error">Whether to include <c>error: true</c>.</param>
        /// <returns>The envelope.</returns>
        public static SeerrProxyErrorResponse Create(string code, string message, SeerrRequestOutcome? outcome, bool error = true) => new()
        {
            Error = error ? true : null,
            Code = code,
            Message = message,
            RequestOutcome = outcome,
        };
    }
}
