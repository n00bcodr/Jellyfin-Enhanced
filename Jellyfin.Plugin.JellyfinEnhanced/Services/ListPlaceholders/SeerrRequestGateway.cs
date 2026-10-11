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
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>How a Jellyfin user maps to Seerr.</summary>
    public enum SeerrAccountState
    {
        /// <summary>A Seerr account with this Jellyfin id exists.</summary>
        Linked,

        /// <summary>The admin excluded this user from Seerr (JE's import blocklist).</summary>
        Blocked,

        /// <summary>Seerr answered, but no account has this Jellyfin id.</summary>
        Unlinked,

        /// <summary>Seerr could not be reached (no answer from any configured URL).</summary>
        Unavailable,

        /// <summary>Seerr is off or not configured.</summary>
        NotConfigured,
    }

    /// <summary>A resolved Seerr account.</summary>
    /// <param name="State">Mapping state.</param>
    /// <param name="SeerrUserId">Seerr user id when linked.</param>
    /// <param name="Permissions">Seerr permission bits when linked.</param>
    /// <param name="Config">
    /// Fingerprint of the Seerr configuration (URLs + API key hash) the account was resolved against. Pass it to
    /// <see cref="SeerrRequestGateway.GetAsync"/> / <see cref="SeerrRequestGateway.PostRequestAsync"/> so a run never
    /// talks to another Seerr (where the same user id may be someone else) after the admin changed the configuration.
    /// </param>
    public readonly record struct SeerrAccount(SeerrAccountState State, int SeerrUserId, JellyseerrPermission Permissions, string? Config = null);

    /// <summary>The outcome of one Seerr call.</summary>
    /// <param name="Reached">Some configured URL answered with HTTP (false = transport failure on every URL).</param>
    /// <param name="StatusCode">HTTP status of the answer (0 when not reached).</param>
    /// <param name="Body">JSON body of a 2xx answer.</param>
    public readonly record struct SeerrCallResult(bool Reached, int StatusCode, string? Body)
    {
        /// <summary>True for a 2xx JSON answer.</summary>
        public bool Ok => Reached && StatusCode is >= 200 and < 300 && Body != null;

        /// <summary>
        /// Not reached, but a non-idempotent call (POST) may still have arrived at Seerr: it timed out or the connection
        /// failed after the request could have been sent. Treat it as "maybe done", never as "not sent".
        /// </summary>
        public bool MaybeSent { get; init; }

        /// <summary>Not sent: the Seerr configuration is no longer the one the caller's account was resolved against.</summary>
        public bool ConfigChanged { get; init; }
    }

    /// <summary>
    /// Talks to Seerr on behalf of a Jellyfin user without an HTTP request context (background work such as list
    /// auto-requests): resolves the user's Seerr account with the same rules as JE's request proxy (import blocklist
    /// first, then the Seerr user whose <c>jellyfinUserId</c> matches; no just-in-time import from a background job),
    /// reads Seerr details, and posts requests with <c>X-Api-User</c>. Configured Seerr URLs are tried in order, the URL
    /// that last answered first; for GETs the next URL is tried when one gives no usable answer (transport error,
    /// timeout, non-JSON, 5xx), never after a definite 4xx. POSTs only move on when the request provably never left
    /// (name resolution / connection / TLS setup failed). Account lookups are cached (JE's user-id TTL, 60 s for "not
    /// linked"), keyed by the Seerr configuration.
    /// </summary>
    public sealed class SeerrRequestGateway
    {
        /// <summary>Timeout of one Seerr call.</summary>
        public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(15);

        private static readonly TimeSpan NegativeTtl = TimeSpan.FromSeconds(60);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, (SeerrAccount Account, DateTime CachedAtUtc)> _accounts = new(StringComparer.Ordinal);
        private volatile string? _answeringUrl;

        /// <summary>Creates the gateway (singleton).</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="logger">JE logger.</param>
        public SeerrRequestGateway(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        /// <summary>True when Seerr is enabled and has URLs and an API key.</summary>
        /// <returns>Whether Seerr is usable.</returns>
        public static bool IsConfigured() => TryGetConfig(out _, out _);

        /// <summary>Resolves a Jellyfin user's Seerr account.</summary>
        /// <param name="jellyfinUserId">Jellyfin user id.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The account.</returns>
        public async Task<SeerrAccount> ResolveAccountAsync(Guid jellyfinUserId, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !TryGetConfig(out var urls, out var apiKey))
            {
                return new SeerrAccount(SeerrAccountState.NotConfigured, 0, JellyseerrPermission.NONE);
            }

            var userIdN = jellyfinUserId.ToString("N", System.Globalization.CultureInfo.InvariantCulture);
            if (JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers).Contains(userIdN))
            {
                return new SeerrAccount(SeerrAccountState.Blocked, 0, JellyseerrPermission.NONE);
            }

            var fingerprint = Fingerprint(urls, apiKey);
            var cacheKey = fingerprint + "|" + userIdN;
            var useCache = !config.JellyseerrDisableCache;
            if (useCache && _accounts.TryGetValue(cacheKey, out var cached))
            {
                var ttl = cached.Account.State == SeerrAccountState.Linked
                    ? TimeSpan.FromMinutes(Math.Max(1, config.JellyseerrUserIdCacheTtlMinutes))
                    : NegativeTtl;
                if (DateTime.UtcNow - cached.CachedAtUtc < ttl)
                {
                    return cached.Account;
                }
            }

            var result = await SendAsync(HttpMethod.Get, "/api/v1/user?take=1000", null, null, idempotent: true, fingerprint, cancellationToken).ConfigureAwait(false);
            if (!result.Ok)
            {
                return new SeerrAccount(SeerrAccountState.Unavailable, 0, JellyseerrPermission.NONE);
            }

            var account = new SeerrAccount(SeerrAccountState.Unlinked, 0, JellyseerrPermission.NONE, fingerprint);
            try
            {
                using var document = JsonDocument.Parse(result.Body!);
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("results", out var users) && users.ValueKind == JsonValueKind.Array)
                {
                    foreach (var user in users.EnumerateArray())
                    {
                        if (user.ValueKind == JsonValueKind.Object
                            && user.TryGetProperty("jellyfinUserId", out var linked) && linked.ValueKind == JsonValueKind.String
                            && string.Equals(linked.GetString()?.Replace("-", string.Empty, StringComparison.Ordinal), userIdN, StringComparison.OrdinalIgnoreCase)
                            && user.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number && id.TryGetInt32(out var seerrId) && seerrId > 0)
                        {
                            var permissions = user.TryGetProperty("permissions", out var bits) && bits.ValueKind == JsonValueKind.Number && bits.TryGetInt64(out var value)
                                ? (JellyseerrPermission)value
                                : JellyseerrPermission.NONE;
                            account = new SeerrAccount(SeerrAccountState.Linked, seerrId, permissions, fingerprint);
                            break;
                        }
                    }
                }
            }
            catch (JsonException ex)
            {
                _logger.Warning($"[ListPlaceholders] Unexpected Seerr user list: {ex.Message}");
                return new SeerrAccount(SeerrAccountState.Unavailable, 0, JellyseerrPermission.NONE);
            }

            if (useCache)
            {
                _accounts[cacheKey] = (account, DateTime.UtcNow);
                if (_accounts.Count > 5000)
                {
                    _accounts.Clear(); // pathological; lookups are cheap to redo
                }
            }

            return account;
        }

        /// <summary>GETs a Seerr API path (e.g. <c>/api/v1/movie/550</c>) with the API key only (no user).</summary>
        /// <param name="apiPath">Path starting with <c>/api/v1/</c>.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <param name="config">
        /// <see cref="SeerrAccount.Config"/> of the run's account: when the configuration changed since, nothing is sent
        /// (<see cref="SeerrCallResult.ConfigChanged"/>). Null = any configuration.
        /// </param>
        /// <returns>The result.</returns>
        public Task<SeerrCallResult> GetAsync(string apiPath, CancellationToken cancellationToken, string? config = null) =>
            SendAsync(HttpMethod.Get, apiPath, null, null, idempotent: true, config, cancellationToken);

        /// <summary>
        /// POSTs <c>/api/v1/request</c> as a Seerr user (<c>X-Api-User</c>). The next URL is only tried when the
        /// request provably never reached the previous one (name resolution / connection / TLS setup failed). Any
        /// answer is final, and a timeout or a connection lost mid-request returns at once with
        /// <see cref="SeerrCallResult.MaybeSent"/> set, so one request is never sent twice (several URLs are usually
        /// the same Seerr).
        /// </summary>
        /// <param name="seerrUserId">Seerr user id.</param>
        /// <param name="bodyJson">Request body.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <param name="config">
        /// <see cref="SeerrAccount.Config"/> the Seerr user id belongs to: when the configuration changed since, the
        /// request is not sent (<see cref="SeerrCallResult.ConfigChanged"/>). Null = any configuration.
        /// </param>
        /// <returns>The result (any HTTP status).</returns>
        public Task<SeerrCallResult> PostRequestAsync(int seerrUserId, string bodyJson, CancellationToken cancellationToken, string? config = null) =>
            SendAsync(HttpMethod.Post, "/api/v1/request", seerrUserId.ToString(System.Globalization.CultureInfo.InvariantCulture), bodyJson, idempotent: false, config, cancellationToken);

        /// <summary>Forgets cached account lookups.</summary>
        public void ClearCache() => _accounts.Clear();

        private async Task<SeerrCallResult> SendAsync(HttpMethod method, string apiPath, string? seerrUserId, string? body, bool idempotent, string? config, CancellationToken cancellationToken)
        {
            if (!TryGetConfig(out var urls, out var apiKey))
            {
                return new SeerrCallResult(false, 0, null) { ConfigChanged = config != null };
            }

            // Sent with exactly this snapshot of the configuration, which must be the caller's.
            if (config != null && !string.Equals(Fingerprint(urls, apiKey), config, StringComparison.Ordinal))
            {
                _logger.Debug($"[ListPlaceholders] Seerr {method} {apiPath} not sent: the Seerr configuration changed");
                return new SeerrCallResult(false, 0, null) { ConfigChanged = true };
            }

            // The URL that answered last goes first: a URL that hangs (timeout) would otherwise stop every POST, which
            // can't fail over after a timeout. The D3 details GET right before a POST sets it.
            var answering = _answeringUrl;
            if (answering != null && urls.Length > 1 && Array.IndexOf(urls, answering) > 0)
            {
                urls = urls.Where(u => u == answering).Concat(urls.Where(u => u != answering)).ToArray();
            }

            var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
            var last = new SeerrCallResult(false, 0, null);
            foreach (var url in urls)
            {
                var requestUri = url + apiPath;
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(CallTimeout);
                try
                {
                    using var request = SeerrHttpHelper.BuildRequest(method, requestUri, apiKey, seerrUserId, body);
                    using var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false);
                    var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri, timeout.Token).ConfigureAwait(false);
                    if (error == null)
                    {
                        _answeringUrl = url;
                        return new SeerrCallResult(true, (int)response.StatusCode, json);
                    }

                    // A definite answer (4xx JSON) is final; 5xx / non-JSON / redirects may be one bad URL of several.
                    var usable = error.Code == SeerrErrorCode.UpstreamError || error.Code == SeerrErrorCode.Unauthorized || error.Code == SeerrErrorCode.Forbidden;
                    last = new SeerrCallResult(true, error.HttpStatus, null);
                    if (usable && error.HttpStatus is >= 400 and < 500)
                    {
                        _answeringUrl = url;
                        return last;
                    }

                    _logger.Debug($"[ListPlaceholders] Seerr {method} {apiPath} failed: code={error.Code} status={error.HttpStatus}");
                    if (!idempotent)
                    {
                        return last;
                    }
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    _logger.Debug($"[ListPlaceholders] Seerr {method} {apiPath} timed out after {CallTimeout.TotalSeconds:0} s");
                    if (!idempotent)
                    {
                        // The request may have arrived and still be processed: never send it again elsewhere.
                        return new SeerrCallResult(false, 0, null) { MaybeSent = true };
                    }
                }
                catch (HttpRequestException ex)
                {
                    _logger.Debug($"[ListPlaceholders] Seerr {method} {apiPath} unreachable ({ex.HttpRequestError}): {ex.Message}");
                    if (!idempotent && !NeverSent(ex))
                    {
                        return new SeerrCallResult(false, 0, null) { MaybeSent = true };
                    }
                }
            }

            return last;
        }

        // Failures while setting up the connection: the request itself was never written.
        private static bool NeverSent(HttpRequestException ex) =>
            ex.HttpRequestError is HttpRequestError.NameResolutionError or HttpRequestError.ConnectionError or HttpRequestError.SecureConnectionError;

        private static bool TryGetConfig(out string[] urls, out string apiKey)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            urls = Array.Empty<string>();
            apiKey = string.Empty;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
            {
                return false;
            }

            urls = config.JellyseerrUrls
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/'))
                .Where(u => u.Length > 0)
                .ToArray();
            apiKey = config.JellyseerrApiKey;
            return urls.Length > 0;
        }

        // Account caches belong to one Seerr configuration (URL list + key hash).
        private static string Fingerprint(IEnumerable<string> urls, string apiKey) =>
            string.Join('\n', urls) + "|" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)), 0, 8);
    }
}
