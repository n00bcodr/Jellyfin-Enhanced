using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using static Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr
{
    /// <summary>
    /// Seerr user lookup for a Jellyfin user, over the process-wide <see cref="SeerrCaches"/> user caches
    /// (restructure S2.10: moved verbatim from JellyfinEnhancedController; the Seerr routes and Downloads both use it).
    /// No <c>User</c> or <c>IsAdminUser()</c>: callers pass the Jellyfin user id.
    /// </summary>
    public sealed class SeerrUserLookup
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly UserDisplayResolver _userDisplayResolver;

        public SeerrUserLookup(IHttpClientFactory httpClientFactory, Logger logger, UserDisplayResolver userDisplayResolver)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userDisplayResolver = userDisplayResolver;
        }

        public async Task<JellyseerrUser?> GetJellyseerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("Seerr configuration is missing. Cannot look up user ID.");
                return null;
            }

            // Skip blocked users entirely — no lookup, no import, no API calls
            if (IsJellyseerrImportBlocked(jellyfinUserId, config))
            {
                return null;
            }

            bool cacheEnabled = !config.JellyseerrDisableCache && !bypassCache;
            if (cacheEnabled)
            {
                lock (_userCacheLock)
                {
                    if (_userCache.TryGetValue(jellyfinUserId, out var cached))
                    {
                        // Negative entries use a much shorter TTL so transient
                        // failures don't poison discovery for 30 min after recovery.
                        var ttl = cached.User == null ? TimeSpan.FromSeconds(60) : GetUserIdCacheTtl();
                        if (DateTime.UtcNow - cached.CachedAt < ttl)
                        {
                            return cached.User;
                        }
                    }
                }
            }

            // _logger.Info($"Attempting to find Seerr user for Jellyfin User ID: {jellyfinUserId}");
            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/user?take=1000"; // Fetch all users to find a match
                try
                {
                    using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (json, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error != null)
                    {
                        // Distinct error logging by class lets admins triage
                        // (HTML response = reverse proxy, 401 = key wrong, etc.)
                        _logger.Warning($"Failed to fetch users from Seerr at {trimmedUrl}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                        continue;
                    }

                    var usersResponse = System.Text.Json.JsonSerializer.Deserialize<JsonElement>(json!);
                    if (usersResponse.TryGetProperty("results", out var usersArray))
                    {
                        var users = System.Text.Json.JsonSerializer.Deserialize<List<JellyseerrUser>>(usersArray.ToString());
                        var normalizedJellyfinUserId = jellyfinUserId.Replace("-", "");
                        var user = users?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, normalizedJellyfinUserId, StringComparison.OrdinalIgnoreCase));
                        if (user != null)
                        {
                            if (cacheEnabled)
                            {
                                lock (_userCacheLock)
                                {
                                    _userCache[jellyfinUserId] = (user, DateTime.UtcNow);
                                }
                            }
                            return user;
                        }
                        _logger.Info($"No matching Jellyfin User ID found in the {users?.Count ?? 0} users from {trimmedUrl}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"Exception while trying to get Seerr user ID from {trimmedUrl}: {ex.Message}");
                }
            }

            // User not found — attempt just-in-time import into Jellyseerr.
            // `allowAutoImport=false` is passed by read-only callers (e.g. the
            // Permission Audit endpoint, which advertises itself as a non-
            // mutating check). Without this guard, clicking "Run Audit" with
            // auto-import enabled would silently create Seerr users as a side
            // effect — including users an admin may have deliberately kept out
            // of Seerr (but not yet added to the blocklist).
            var importDefinite = false;
            if (allowAutoImport && config.JellyseerrAutoImportUsers)
            {
                _logger.Info($"User not found in Jellyseerr. Attempting just-in-time import for Jellyfin User ID {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)}...");
                var (importedUser, definite) = await TryAutoImportJellyseerrUser(jellyfinUserId, urls, httpClient);
                importDefinite = definite;
                if (importedUser != null)
                {
                    if (cacheEnabled)
                    {
                        lock (_userCacheLock)
                        {
                            _userCache[jellyfinUserId] = (importedUser, DateTime.UtcNow);
                        }
                    }

                    return importedUser;
                }
            }

            // Only negative-cache when the import gave a definite "not importable" answer.
            // Transient failures (network errors, exceptions) should not be cached so the
            // next request can retry immediately.
            if (cacheEnabled && importDefinite)
            {
                lock (_userCacheLock)
                {
                    _userCache[jellyfinUserId] = (null, DateTime.UtcNow);
                }
            }

            _logger.Warning($"Could not find or import a matching Seerr user for Jellyfin User ID {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)} after checking all URLs.");
            return null;
        }

        private async Task<(JellyseerrUser? User, bool Definite)> TryAutoImportJellyseerrUser(string jellyfinUserId, string[] urls, HttpClient httpClient)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var apiKey = config?.JellyseerrApiKey ?? string.Empty;

            // Jellyseerr requires dashless UUIDs — dashed format causes empty email and UNIQUE constraint errors
            var normalizedUserId = jellyfinUserId.Replace("-", "");

            // Track whether we got any HTTP response from Jellyseerr (vs network failures).
            // This determines whether a null result should be negative-cached or retried.
            var reachedJellyseerr = false;

            foreach (var url in urls)
            {
                try
                {
                    var importUri = $"{url.Trim().TrimEnd('/')}/api/v1/user/import-from-jellyfin";
                    var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = new[] { normalizedUserId } });

                    using var importRequest = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Post, importUri, apiKey, bodyJson: requestBody);
                    using var importResponse = await httpClient.SendAsync(importRequest);
                    reachedJellyseerr = true;
                    var (importJson, importError) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(importResponse, importUri);

                    if (importError != null)
                    {
                        // Email collision is a definite failure — a renamed/deleted Jellyfin user left
                        // an orphaned Jellyseerr account with the same email. Won't resolve on retry.
                        if (!string.IsNullOrEmpty(importError.Message)
                            && importError.Message.Contains("UNIQUE constraint failed: user.email", StringComparison.OrdinalIgnoreCase))
                        {
                            _logger.Warning($"Could not auto-import Jellyfin User ID {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)}: an existing Jellyseerr account has a conflicting email (possibly from a previous user that was renamed or deleted). Remove the conflicting user in Jellyseerr to resolve this.");
                            return (null, true);
                        }

                        _logger.Warning($"Failed to auto-import user to Jellyseerr at {url}: code={importError.Code} status={importError.HttpStatus} cf-ray={importError.CfRay} — {importError.Message}");
                        continue;
                    }

                    // The import endpoint returns an array of newly created users.
                    // Parse it directly to avoid a second API call.
                    var importedUsers = JsonSerializer.Deserialize<List<JellyseerrUser>>(importJson!);
                    var user = importedUsers?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, normalizedUserId, StringComparison.OrdinalIgnoreCase));
                    if (user != null)
                    {
                        _logger.Info($"Auto-imported Seerr user ID {user.Id} for Jellyfin User {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)}");
                        return (user, true);
                    }

                    // Some Jellyseerr versions return an empty array even on success (user already existed
                    // but wasn't in the import response). Fall back to a full user list query to find them.
                    _logger.Info($"Import succeeded at {url.Trim()} but user not in response. Doing fresh lookup...");
                    var lookupUri = $"{url.Trim().TrimEnd('/')}/api/v1/user?take=1000";
                    using var lookupRequest = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, lookupUri, apiKey);
                    using var lookupResponse = await httpClient.SendAsync(lookupRequest);
                    var (lookupJson, lookupError) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(lookupResponse, lookupUri);
                    if (lookupError == null && lookupJson != null)
                    {
                        var lookupRoot = JsonSerializer.Deserialize<JsonElement>(lookupJson);
                        if (lookupRoot.TryGetProperty("results", out var usersArray))
                        {
                            var allUsers = JsonSerializer.Deserialize<List<JellyseerrUser>>(usersArray.ToString());
                            var found = allUsers?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, normalizedUserId, StringComparison.OrdinalIgnoreCase));
                            if (found != null)
                            {
                                _logger.Info($"Found Seerr user ID {found.Id} for Jellyfin User {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)} via fresh lookup");
                                return (found, true);
                            }
                        }
                    }
                    else if (lookupError != null)
                    {
                        _logger.Debug($"Fresh lookup at {url.Trim()} failed: code={lookupError.Code} status={lookupError.HttpStatus} cf-ray={lookupError.CfRay}");
                    }

                    // Import succeeded and fresh lookup found nothing — user is genuinely not importable
                    return (null, true);
                }
                catch (HttpRequestException ex)
                {
                    // Network errors, timeouts, etc. are transient — try the next URL
                    _logger.Debug($"Connection error during auto-import for Jellyfin User {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)} at {url}: {ex.Message}");
                }
                catch (JsonException ex)
                {
                    // Invalid Jellyseerr response — log warning but try next URL
                    _logger.Warning($"Invalid response from Jellyseerr during auto-import for Jellyfin User {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)} at {url}: {ex.Message}");
                }
            }

            // Definite only if we actually got an HTTP response from at least one URL.
            // If all URLs failed with exceptions (network down), this is transient and should not be cached.
            return (null, reachedJellyseerr);
        }

        public static bool IsJellyseerrImportBlocked(string jellyfinUserId, Configuration.PluginConfiguration config)
        {
            var blockedIds = JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
            if (blockedIds.Count == 0)
            {
                return false;
            }

            var normalizedId = jellyfinUserId.Replace("-", "");
            return blockedIds.Contains(normalizedId);
        }

        /// <summary>
        /// The Seerr user id for a Jellyfin user when it is in the user-id cache
        /// (unexpired, cache not disabled), without contacting Seerr; null otherwise.
        /// </summary>
        public static string? TryGetCachedJellyseerrUserId(string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config != null && config.JellyseerrDisableCache)
            {
                return null;
            }

            lock (_userIdCacheLock)
            {
                if (_userIdCache.TryGetValue(jellyfinUserId, out var cached) &&
                    DateTime.UtcNow - cached.CachedAt < GetUserIdCacheTtl())
                {
                    return cached.JellyseerrUserId;
                }
            }

            return null;
        }

        public async Task<string?> GetJellyseerrUserId(string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            bool cacheEnabled = config == null || !config.JellyseerrDisableCache;

            // Check cache first (unless disabled)
            var cachedId = TryGetCachedJellyseerrUserId(jellyfinUserId);
            if (cachedId != null)
            {
                return cachedId;
            }

            var user = await GetJellyseerrUser(jellyfinUserId);
            var jellyseerrUserId = user?.Id.ToString();

            if (!string.IsNullOrEmpty(jellyseerrUserId) && cacheEnabled)
            {
                lock (_userIdCacheLock)
                {
                    _userIdCache[jellyfinUserId] = (jellyseerrUserId, DateTime.UtcNow);
                }
            }

            return jellyseerrUserId;
        }
    }
}
