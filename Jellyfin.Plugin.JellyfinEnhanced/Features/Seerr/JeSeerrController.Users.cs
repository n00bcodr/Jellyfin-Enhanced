using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Extensions;
using static Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    public partial class JeSeerrController
    {
        [HttpGet("jellyseerr/user")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrUsers([FromQuery] int take = 1000)
        {
            // Admin-only: this proxies Seerr's full user list, which includes
            // every Seerr user's email, username, plexUsername, permissions,
            // and userType. Without this gate any authenticated Jellyfin user
            // could harvest the entire Seerr roster.
            if (!IsAdminUser())
            {
                return Task.FromResult<IActionResult>(Forbid());
            }
            return ProxyJellyseerrRequest($"/api/v1/user?take={take}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request/tv/{tmdbId}/seasons")]
        [Authorize]
        public async Task<IActionResult> RequestTvSeasons(int tmdbId, [FromBody] JsonElement requestBody)
        {
            // enforce that the body's mediaType
            // is "tv" and the body's mediaId matches the route's tmdbId, so
            // logging/audit trails are consistent and a user with REQUEST_TV
            // (but not REQUEST_MOVIE) can't piggyback a movie request through
            // this route. Seerr would re-validate but JE's permission gate at
            // line ~620 only sees apiPath="/api/v1/request".
            if (tmdbId <= 0)
            {
                return BadRequest(new { error = true, code = "invalid_tmdb_id", message = "TMDB id must be positive." });
            }
            try
            {
                if (requestBody.TryGetProperty("mediaType", out var mtEl)
                    && mtEl.ValueKind == JsonValueKind.String
                    && !string.Equals(mtEl.GetString(), "tv", StringComparison.OrdinalIgnoreCase))
                {
                    return BadRequest(new { error = true, code = "media_type_mismatch", message = "Body mediaType must be 'tv' on the seasons route." });
                }
                if (requestBody.TryGetProperty("mediaId", out var midEl) && midEl.ValueKind == JsonValueKind.Number)
                {
                    if (midEl.GetInt32() != tmdbId)
                    {
                        return BadRequest(new { error = true, code = "media_id_mismatch", message = "Body mediaId must match the {tmdbId} in the URL." });
                    }
                }
            }
            catch (InvalidOperationException)
            {
                // requestBody not a JSON object — let downstream Seerr return its own validation error.
            }
            return await ProxyJellyseerrRequest($"/api/v1/request", HttpMethod.Post, requestBody.ToString());
        }

        [HttpGet("jellyseerr/watchlist")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrWatchlist([FromQuery] int page = 1)
        {
            // Bug discovered live in round-1 e2e: previous endpoint `/api/v1/user/watchlist`
            // returns 400 from Seerr (`request.params.userId should be number`) —
            // Seerr's user-watchlist endpoint expects the userId in the URL path.
            // The discover endpoint reads X-Api-User from the proxy header instead,
            // returning the same shape and matching how the rest of JE's discovery
            // calls work.
            if (page < 1) page = 1;
            return ProxyJellyseerrRequest($"/api/v1/discover/watchlist?page={page}", HttpMethod.Get);
        }

        // Puts one title on the calling user's Seerr watchlist. The browser calls it right after a
        // request when "Requested media goes on the requester's watchlist" is on. The Jellyfin
        // watchlist is filled later by WatchlistMonitor, when the title reaches the library.
        [HttpPost("jellyseerr/watchlist")]
        [Authorize]
        public Task<IActionResult> AddJellyseerrWatchlist([FromBody] JsonElement requestBody)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || !config.AddRequestedMediaToWatchlist)
            {
                return Task.FromResult<IActionResult>(BadRequest(new { error = true, code = "watchlist_disabled", message = "Adding requested media to the watchlist is turned off." }));
            }

            var tmdbId = 0;
            string? mediaType = null;
            if (requestBody.ValueKind == JsonValueKind.Object)
            {
                if (requestBody.TryGetProperty("tmdbId", out var idElement) && idElement.ValueKind == JsonValueKind.Number) idElement.TryGetInt32(out tmdbId);
                if (requestBody.TryGetProperty("mediaType", out var typeElement) && typeElement.ValueKind == JsonValueKind.String) mediaType = typeElement.GetString();
            }

            if (tmdbId <= 0 || (mediaType != "movie" && mediaType != "tv"))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { error = true, code = "invalid_watchlist_item", message = "tmdbId and a mediaType of 'movie' or 'tv' are required." }));
            }

            // Only the two validated fields are forwarded; Seerr answers 500 to an unknown mediaType.
            return ProxyJellyseerrRequest("/api/v1/watchlist", HttpMethod.Post, JsonSerializer.Serialize(new { tmdbId, mediaType }));
        }

        [HttpPost("jellyseerr/sync-watchlist")]
        [Authorize]
        public async Task<IActionResult> SyncJellyseerrWatchlist()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || !config.JellyseerrEnabled || !config.SyncJellyseerrWatchlist)
                {
                    return BadRequest(new { error = "Jellyseerr watchlist sync is not enabled" });
                }

                _logger.Info("[Manual Watchlist Sync] Starting manual Seerr watchlist sync...");

                // The scheduled task's own pass, so a manual sync honours the same
                // blocked users, re-addition prevention and requested-media settings.
                var summary = await new ScheduledTasks.JellyseerrWatchlistSyncTask(
                    _libraryManager, _userManager, _userDataManager, _httpClientFactory, _userConfigurationManager, _logger)
                    .RunAsync(null, CancellationToken.None);
                if (summary == null)
                {
                    return BadRequest(new { error = "Jellyseerr URL or API key is not configured" });
                }

                if (summary.SeerrUnreachable)
                {
                    return StatusCode(502, new { error = "Could not load the user list from any configured Jellyseerr URL." });
                }

                _logger.Info($"[Manual Watchlist Sync] Sync complete. Processed: {summary.ItemsProcessed}, Added: {summary.ItemsAdded}");

                return Ok(new
                {
                    success = true,
                    itemsProcessed = summary.ItemsProcessed,
                    itemsAdded = summary.ItemsAdded,
                    errors = summary.FailedUsers > 0
                        ? Enumerable.Repeat("Failed to sync watchlist for a user.", summary.FailedUsers).ToList()
                        : null
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"[Manual Watchlist Sync] Fatal error: {ex}");
                return StatusCode(500, new { error = "An internal error occurred during watchlist sync." });
            }
        }

        [HttpPost("jellyseerr/import-users")]
        [Authorize]
        public async Task<IActionResult> ImportJellyseerrUsers()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || !config.JellyseerrEnabled)
                {
                    return BadRequest(new { error = "Jellyseerr integration is not enabled" });
                }

                if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
                {
                    return BadRequest(new { error = "Jellyseerr URL or API key not configured" });
                }

                // Claim the throttle slot atomically to prevent concurrent imports
                lock (_importThrottleLock)
                {
                    if ((DateTime.UtcNow - _lastManualImport).TotalSeconds < 30)
                    {
                        return StatusCode(429, new { error = "Import was run recently. Please wait before retrying." });
                    }

                    _lastManualImport = DateTime.UtcNow;
                }

                _logger.Info("[Manual User Import] Starting manual Jellyseerr user import...");

                var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var blockedIds = Shared.Seerr.JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
                var userIds = _userManager.GetAllUsers()
                    .Select(u => u.Id.ToString().Replace("-", ""))
                    .Where(id => !blockedIds.Contains(id))
                    .ToList();
                _logger.Info($"[Manual User Import] Importing {userIds.Count} Jellyfin users...");

                var importResult = await Shared.Seerr.JellyseerrUserImportHelper.BulkImportAsync(
                    userIds, urls, config.JellyseerrApiKey, _httpClientFactory, _logger);

                // only flush user caches when at least one user
                // was actually imported. Previously a 0-imported "success" (all
                // email-collisioned) would wipe every healthy cache entry,
                // forcing a stampede on next request.
                if (importResult.Reached && importResult.Imported > 0)
                {
                    ClearUserCaches();
                }

                // Reset the throttle slot when nothing was imported AND we got
                // any kind of error, so the admin can fix Seerr-side issues
                // and retry without waiting 30s.
                if (importResult.Imported == 0 && importResult.Errors.Count > 0)
                {
                    lock (_importThrottleLock)
                    {
                        _lastManualImport = DateTime.MinValue;
                    }
                }

                if (importResult.Reached)
                {
                    _logger.Info($"[Manual User Import] Completed. {importResult.Imported} new user(s) imported out of {userIds.Count} sent. Errors: {importResult.Errors.Count}");
                    return Ok(new
                    {
                        success = true,
                        usersImported = importResult.Imported,
                        totalUsers = userIds.Count,
                        errors = importResult.Errors,
                    });
                }
                else
                {
                    return StatusCode(502, new
                    {
                        error = "Import failed on all configured Jellyseerr URLs.",
                        errors = importResult.Errors,
                    });
                }
            }
            catch (HttpRequestException ex)
            {
                _logger.Error($"[Manual User Import] Connection error: {ex.Message}");
                return StatusCode(502, new { error = "Failed to connect to Jellyseerr. Check server logs for details." });
            }
            catch (JsonException ex)
            {
                _logger.Error($"[Manual User Import] Invalid Jellyseerr response: {ex.Message}");
                return StatusCode(502, new { error = "Invalid response from Jellyseerr. Check server logs for details." });
            }
        }

        [HttpGet("jellyseerr/settings/partial-requests")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrPartialRequestsSetting()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                // previously returned 200+false, which made the
                // frontend silently flip the request modal to whole-season
                // mode. Returns 503 with structured `code` so the frontend
                // can keep its last-known state instead of regressing.
                _logger.Warning("Seerr integration is not configured or enabled.");
                return StatusCode(503, new { error = true, code = "disabled", message = "Seerr integration not configured." });
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                try
                {
                    var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/settings/main";
                    _logger.Info($"Fetching Seerr partial requests setting from: {requestUri}");

                    using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (responseContent, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error == null && responseContent != null)
                    {
                        using var settings = JsonDocument.Parse(responseContent);
                        var partialRequestsEnabled = false;
                        if (settings.RootElement.TryGetProperty("partialRequestsEnabled", out var prop))
                        {
                            partialRequestsEnabled = prop.GetBoolean();
                        }

                        var enableSpecialEpisodes = false;
                        if (settings.RootElement.TryGetProperty("enableSpecialEpisodes", out var specialProp))
                        {
                            enableSpecialEpisodes = specialProp.GetBoolean();
                        }

                        _logger.Info($"Seerr settings — partialRequests: {partialRequestsEnabled}, specialEpisodes: {enableSpecialEpisodes}");
                        return Ok(new { partialRequestsEnabled, enableSpecialEpisodes });
                    }

                    _logger.Warning($"Failed to fetch Seerr settings from {trimmedUrl}: code={error!.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                }
                catch (Exception ex)
                {
                    _logger.Error($"Failed to connect to Seerr URL: {trimmedUrl}. Error: {ex.Message}");
                }
            }

            // don't silently default to false on outage — that
            // hides admin-configured "partial requests off" UX state. Return
            // 503 so the frontend can keep last-known state.
            _logger.Warning("Could not fetch Seerr settings from any URL — surfacing as 503 unreachable");
            return StatusCode(503, new
            {
                error = true,
                code = "unreachable",
                message = "Could not reach Seerr to read partial-requests setting."
            });
        }

        [HttpGet("tmdb/validate")]
        [Authorize]
        public async Task<IActionResult> ValidateTmdb([FromQuery] string? apiKey)
        {
            // Admin-only: validates an arbitrary API key against TMDB. Any
            // authenticated user could otherwise use this as a free oracle
            // for testing leaked TMDB keys, matching the pattern in every
            // sibling validate endpoint (arr/validate/sonarr|radarr,
            // jellyseerr/validate).
            if (!IsAdminUser())
            {
                return Forbid();
            }

            // The key may also come in the X-Arr-ApiKey header, as on the sibling validate routes, which keeps
            // it out of the request line that Jellyfin and any proxy log.
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                apiKey = Request.Headers["X-Arr-ApiKey"].ToString();
            }

            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return BadRequest(new { ok = false, message = "API key is missing" });
            }

            var httpClient = _httpClientFactory.CreateClient();
            try
            {
                var requestUri = $"https://api.themoviedb.org/3/configuration?api_key={Uri.EscapeDataString(apiKey)}";
                var response = await httpClient.GetAsync(requestUri);

                if (response.IsSuccessStatusCode)
                {
                    return Ok(new { ok = true });
                }

                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    return Unauthorized(new { ok = false, message = "Invalid API Key." });
                }

                return StatusCode((int)response.StatusCode, new { ok = false, message = "Failed to connect to TMDB." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Exception during TMDB API key validation: {ex.Message}");
                return StatusCode(500, new { ok = false, message = "Could not reach TMDB services." });
            }
        }
    }
}
