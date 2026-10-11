using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import
{
    /// <summary>
    /// Who may use JE's Seerr key for import searches (design §5 "/resolve: Seerr linked or admin"): Jellyfin
    /// administrators always; other users when Seerr knows their Jellyfin account and they aren't on the
    /// <c>JellyseerrImportBlockedUsers</c> list. Seerr's <c>GET /api/v1/user/jellyfin/{id}</c> answers 200 or 404; older
    /// Seerr builds without that route fall back to scanning <c>/api/v1/user?take=1000</c> (the same scan the proxy
    /// does). Answers are cached per Seerr instance (URL list + API key): positive ones 30 minutes, negative ones 60
    /// seconds; no account is ever imported here.
    /// </summary>
    public class SeerrUserLink
    {
        private static readonly TimeSpan PositiveTtl = TimeSpan.FromMinutes(30);
        private static readonly TimeSpan NegativeTtl = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, (bool Linked, DateTime ExpiresUtc)> _cache = new(StringComparer.Ordinal);

        /// <summary>Creates the checker.</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="logger">JE logger.</param>
        public SeerrUserLink(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        /// <summary>Whether the user may run Seerr-backed import lookups.</summary>
        /// <param name="user">User.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>Allowed.</returns>
        public virtual async Task<bool> IsAllowedAsync(User user, CancellationToken cancellationToken)
        {
            if (ListAccessService.IsAdmin(user))
            {
                return true;
            }

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
            {
                return false;
            }

            var idN = user.Id.ToString("N", CultureInfo.InvariantCulture);
            if (JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers).Contains(idN))
            {
                return false;
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(u => u.Trim().TrimEnd('/')).Where(u => u.Length > 0).ToArray();
            var cacheKey = Fingerprint(urls, config.JellyseerrApiKey) + "|" + idN;
            if (_cache.TryGetValue(cacheKey, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return cached.Linked;
            }

            bool? linked = null;
            foreach (var baseUrl in urls)
            {
                linked = await LookupAsync(baseUrl, config.JellyseerrApiKey, idN, cancellationToken).ConfigureAwait(false);
                if (linked.HasValue)
                {
                    break;
                }
            }

            if (linked.HasValue)
            {
                _cache[cacheKey] = (linked.Value, DateTime.UtcNow + (linked.Value ? PositiveTtl : NegativeTtl));
            }

            return linked == true;
        }

        // Answers belong to one Seerr configuration (URL list + key hash): another instance is asked again.
        private static string Fingerprint(string[] urls, string apiKey) =>
            string.Join('\n', urls) + "|" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)), 0, 8);

        private async Task<bool?> LookupAsync(string baseUrl, string apiKey, string idN, CancellationToken cancellationToken)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(Timeout);
                var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
                var url = baseUrl + "/api/v1/user/jellyfin/" + idN;
                using (var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, url, apiKey))
                using (var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false))
                {
                    var (json, _) = await SeerrHttpHelper.ReadResponseAsync(response, url, timeout.Token).ConfigureAwait(false);
                    if (json != null)
                    {
                        return true;
                    }

                    if ((int)response.StatusCode is not (404 or 400))
                    {
                        return null;
                    }
                }

                // 404 is either "User not found." or a Seerr without the route: confirm with the user list.
                var listUrl = baseUrl + "/api/v1/user?take=1000";
                using var listRequest = SeerrHttpHelper.BuildRequest(HttpMethod.Get, listUrl, apiKey);
                using var listResponse = await client.SendAsync(listRequest, timeout.Token).ConfigureAwait(false);
                var (listJson, _) = await SeerrHttpHelper.ReadResponseAsync(listResponse, listUrl, timeout.Token).ConfigureAwait(false);
                if (listJson == null)
                {
                    return null;
                }

                using var doc = JsonDocument.Parse(listJson);
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                {
                    return null;
                }

                return results.EnumerateArray().Any(u => u.TryGetProperty("jellyfinUserId", out var id) && id.ValueKind == JsonValueKind.String
                    && string.Equals(id.GetString()?.Replace("-", string.Empty, StringComparison.Ordinal), idN, StringComparison.OrdinalIgnoreCase));
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
            {
                _logger.Debug($"[ListPlaceholders] Seerr user lookup failed: {ex.Message}");
                return null;
            }
        }
    }
}
