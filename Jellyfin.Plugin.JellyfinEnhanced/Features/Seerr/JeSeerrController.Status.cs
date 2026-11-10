using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using static Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    public partial class JeSeerrController
    {
        /// <summary>
        /// Whether Seerr is configured and reachable. Every details page and the
        /// search page ask this; the answer comes from the same 30-second probe
        /// cache the proxy uses, so it costs a Seerr round trip at most twice a
        /// minute rather than once per page.
        /// </summary>
        [HttpGet("jellyseerr/status")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrStatus()
        {
            return Ok(SeerrStatusResponse(await IsSeerrReachableCached()));
        }

        /// <summary>The <c>jellyseerr/status</c> response body.</summary>
        internal static object SeerrStatusResponse(bool active) => new { active };

        private async Task<bool> ProbeJellyseerrStatusAsync()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrApiKey) || string.IsNullOrEmpty(config.JellyseerrUrls))
            {
                return false;
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            foreach (var url in urls)
            {
                var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/status";
                try
                {
                    using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (_, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
                    if (error == null)
                    {
                        return true;
                    }
                    _logger.Warning($"Seerr status check failed at {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                }
                catch
                {
                    // Ignore and try next URL
                }
            }

            _logger.Warning("Could not establish a connection with any configured Seerr URL. Status is inactive.");
            return false;
        }

        [HttpGet("jellyseerr/validate")]
        [Authorize]
        public async Task<IActionResult> ValidateJellyseerr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            if (!ArrUrlGuard.IsAllowedUrl(url, _logger))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(10);

            // Use the SeerrHttpHelper so the admin gets the same typed errors
            // (HtmlResponse / Cloudflare5xx / UpstreamRedirect / Unauthorized)
            // as runtime fetches — Round-3 found that the validate path
            // returned a generic "Status check failed" for HTML challenge
            // pages, which is the most-confusing first-setup error.
            var requestUri = $"{url.TrimEnd('/')}/api/v1/user";
            try
            {
                using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get, requestUri, apiKey);
                using var resp = await http.SendAsync(request);
                var (_, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(resp, requestUri);
                if (error == null) return Ok(new { ok = true });

                _logger.Warning($"Seerr validate failed for {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                int httpCode = error.Code switch
                {
                    Shared.Seerr.SeerrErrorCode.HtmlResponse => 502,
                    Shared.Seerr.SeerrErrorCode.UpstreamRedirect => 502,
                    Shared.Seerr.SeerrErrorCode.Cloudflare5xx => 502,
                    _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                };
                return StatusCode(httpCode, new
                {
                    ok = false,
                    code = error.Code.ToString(),
                    cfRay = error.CfRay,
                    message = error.Message
                });
            }
            catch (Exception ex)
            {
                _logger.Warning($"Seerr validate failed for {url}: {ex.Message}");
                return StatusCode(502, new
                {
                    ok = false,
                    code = "Unreachable",
                    message = $"Unable to reach Jellyseerr at {url}: {ex.Message}"
                });
            }
        }

        // Manually trigger Seerr's recently-added library scan against a single URL.
        // Used by the admin "Trigger scan now" button so the test runs against the
        // values currently in the form (which may not be saved yet), exactly like
        // the validate endpoint above.
        [HttpPost("jellyseerr/trigger-recently-added-scan")]
        [Authorize]
        public async Task<IActionResult> TriggerJellyseerrRecentlyAddedScan([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            if (!ArrUrlGuard.IsAllowedUrl(url, _logger))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(15);

            // route via SeerrHttpHelper so a Cloudflare/forward-auth
            // 200+HTML response no longer falsely reports `ok=true` to admins.
            var requestUri = $"{url.TrimEnd('/')}/api/v1/settings/jobs/jellyfin-recently-added-scan/run";
            try
            {
                using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Post, requestUri, apiKey, bodyJson: "{}");
                using var resp = await http.SendAsync(request);
                var (_, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(resp, requestUri);
                if (error == null)
                {
                    _logger.Info($"[SeerrScan] Manually triggered Seerr recently-added scan via admin button — {url}");
                    return Ok(new { ok = true });
                }

                _logger.Warning($"[SeerrScan] Manual trigger failed for {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                int httpCode = error.Code switch
                {
                    Shared.Seerr.SeerrErrorCode.HtmlResponse => 502,
                    Shared.Seerr.SeerrErrorCode.UpstreamRedirect => 502,
                    Shared.Seerr.SeerrErrorCode.Cloudflare5xx => 502,
                    _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                };
                return StatusCode(httpCode, new
                {
                    ok = false,
                    code = error.Code.ToString(),
                    cfRay = error.CfRay,
                    message = error.Message
                });
            }
            catch (Exception ex)
            {
                _logger.Warning($"[SeerrScan] Manual trigger threw for {url}: {ex.Message}");
                return StatusCode(502, new
                {
                    ok = false,
                    code = "Unreachable",
                    message = $"Unable to reach Seerr: {ex.Message}"
                });
            }
        }

        [HttpGet("jellyseerr/user-status")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrUserStatus()
        {
            // report a typed `reason` so the frontend can display
            // a meaningful banner instead of silently hiding discovery sections.
            // Possible reasons: disabled, no_user, blocked, unlinked, unreachable.
            var config = JellyfinEnhanced.Instance?.Configuration;
            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            var withoutLookup = TryBuildSeerrUserStatusWithoutLookup(config, jellyfinUserId, IsAdminUser());
            if (withoutLookup != null)
            {
                return Ok(withoutLookup);
            }

            // Only reached with Seerr configured, a signed-in user that is not
            // blocked, and no cached Seerr user id (or, for a non-admin, no
            // cached Seerr user to read canRequestAdvanced from).
            // GetSeerrUserId uses the user ID cache (30-min TTL).
            // A successful user lookup implicitly proves Seerr is reachable.
            var jellyseerrUserId = await _seerrUserLookup.GetJellyseerrUserId(jellyfinUserId!);
            if (!string.IsNullOrEmpty(jellyseerrUserId))
            {
                var seerrUser = await _seerrUserLookup.GetJellyseerrUser(jellyfinUserId!);
                return Ok(LinkedSeerrUserStatus(jellyseerrUserId, CanRequestAdvanced(IsAdminUser(), seerrUser)));
            }

            // User not found — could be server unreachable, HTML challenge from
            // proxy, or user genuinely not linked. Probe /status to distinguish
            // "unreachable" from "unlinked".
            var statusResult = await GetJellyseerrStatus() as OkObjectResult;
            bool active = false;
            if (statusResult?.Value is not null)
            {
                var json = System.Text.Json.JsonSerializer.Serialize(statusResult.Value);
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("active", out var a))
                    active = a.GetBoolean();
            }
            return Ok(new
            {
                active,
                userFound = false,
                reason = active ? "unlinked" : "unreachable"
            });
        }

        /// <summary>
        /// The <c>jellyseerr/user-status</c> answer when it needs no Seerr round trip:
        /// Seerr not configured, no signed-in user, the user blocked from import, or
        /// the user's Seerr id already in the user-id cache (and, for a non-admin,
        /// their Seerr user in the user cache, for canRequestAdvanced). Null when
        /// the full lookup is required. Shared by the endpoint and the bootstrap payload so
        /// both return the same object.
        /// </summary>
        internal static object? TryBuildSeerrUserStatusWithoutLookup(Configuration.PluginConfiguration? config, string? jellyfinUserId, bool isAdmin)
        {
            if (config == null || !config.JellyseerrEnabled ||
                string.IsNullOrEmpty(config.JellyseerrApiKey) ||
                string.IsNullOrEmpty(config.JellyseerrUrls))
            {
                return new { active = false, userFound = false, reason = "disabled" };
            }

            if (string.IsNullOrEmpty(jellyfinUserId))
            {
                return new { active = false, userFound = false, reason = "no_user" };
            }

            if (Shared.Seerr.SeerrUserLookup.IsJellyseerrImportBlocked(jellyfinUserId, config))
            {
                return new { active = true, userFound = false, reason = "blocked" };
            }

            var cachedId = Shared.Seerr.SeerrUserLookup.TryGetCachedJellyseerrUserId(jellyfinUserId);
            if (cachedId == null) return null;

            // canRequestAdvanced: an admin always may; anyone else needs their
            // Seerr user (permissions), which must already be in the user cache
            // for this answer to need no Seerr round trip.
            if (isAdmin) return LinkedSeerrUserStatus(cachedId, true);
            return TryGetCachedJellyseerrUser(jellyfinUserId, out var seerrUser)
                ? LinkedSeerrUserStatus(cachedId, CanRequestAdvanced(false, seerrUser))
                : null;
        }

        /// <summary>The <c>jellyseerr/user-status</c> answer for a linked user.</summary>
        private static object LinkedSeerrUserStatus(string jellyseerrUserId, bool canRequestAdvanced)
            => new { active = true, userFound = true, jellyseerrUserId = jellyseerrUserId, reason = "linked", canRequestAdvanced };

        /// <summary>
        /// Whether the request modals may offer the advanced options (server,
        /// quality profile, root folder): Jellyfin admins always, anyone else
        /// with an advanced-request permission in Seerr.
        /// </summary>
        private static bool CanRequestAdvanced(bool isAdmin, JellyseerrUser? seerrUser)
            => isAdmin
                || (seerrUser != null && JellyseerrPermissionHelper.HasAnyPermission(seerrUser.Permissions, AdvancedRequestPermissions));

        /// <summary>
        /// The Seerr user GetJellyseerrUser would answer from its cache (an
        /// unexpired entry, positive or negative, cache not disabled), without
        /// contacting Seerr; false when it would have to look the user up.
        /// </summary>
        private static bool TryGetCachedJellyseerrUser(string jellyfinUserId, out JellyseerrUser? user)
        {
            user = null;
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || config.JellyseerrDisableCache)
            {
                return false;
            }

            lock (_userCacheLock)
            {
                if (_userCache.TryGetValue(jellyfinUserId, out var cached))
                {
                    var ttl = cached.User == null ? TimeSpan.FromSeconds(60) : GetUserIdCacheTtl();
                    if (DateTime.UtcNow - cached.CachedAt < ttl)
                    {
                        user = cached.User;
                        return true;
                    }
                }
            }

            return false;
        }

        [HttpGet("jellyseerr/permission-audit")]
        [Authorize]
        public async Task<IActionResult> GetPermissionAudit()
        {
            if (!IsAdminUser()) return Forbid();

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled ||
                string.IsNullOrEmpty(config.JellyseerrApiKey) ||
                string.IsNullOrEmpty(config.JellyseerrUrls))
                return StatusCode(503, "Seerr integration is not configured or enabled.");

            var jellyfinUsers = _userManager.GetAllUsers()
                .GroupBy(u => u.Id)
                .Select(g => g.First())
                .ToList();
            var results = new List<object>();

            foreach (var jfUser in jellyfinUsers)
            {
                var userId = jfUser.Id.ToString("N");
                // allowAutoImport: false — audit must be read-only and must not
                // create Seerr users as a side effect.
                var seerrUser = await _seerrUserLookup.GetJellyseerrUser(userId, bypassCache: true, allowAutoImport: false);

                if (seerrUser == null)
                {
                    // Null has 5 distinct causes: user genuinely unlinked, blocked
                    // by JE config, every Seerr URL HTTP-failed, every URL threw,
                    // or JSON shape mismatch. The UI renders them all as "Not
                    // linked", which misleads admins during transient Seerr
                    // outages. Leave a breadcrumb in the server log so the cause
                    // can be correlated with the preceding WARN/ERROR lines
                    // that GetJellyseerrUser already emits.
                    _logger.Info($"[audit] user {jfUser.Username} ({userId}): GetJellyseerrUser returned null — see preceding log lines for cause");
                    results.Add(new
                    {
                        jellyfinUsername = jfUser.Username,
                        jellyfinUserId   = userId,
                        linked           = false,
                        permissions      = (int?)null,
                        issues           = new[] { "Not linked to a Seerr account" }
                    });
                    continue;
                }

                var perms = seerrUser.Permissions;
                bool isAdmin = JellyseerrPermissionHelper.HasPermission(perms, JellyseerrPermission.ADMIN);

                // Admins inherit all permissions — nothing to flag
                if (isAdmin)
                {
                    results.Add(new
                    {
                        jellyfinUsername = jfUser.Username,
                        jellyfinUserId   = userId,
                        linked           = true,
                        permissions      = (int)perms,
                        issues           = Array.Empty<string>()
                    });
                    continue;
                }

                var issues = new List<string>();

                // Search & request
                if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                    JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV))
                    issues.Add("Cannot make requests (missing REQUEST / REQUEST_MOVIE / REQUEST_TV)");

                // 4K movie requests (only relevant if plugin has 4K enabled)
                if (config.JellyseerrEnable4KRequests &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.REQUEST_4K | JellyseerrPermission.REQUEST_4K_MOVIE))
                    issues.Add("Cannot request 4K movies (missing REQUEST_4K / REQUEST_4K_MOVIE)");

                // 4K TV requests
                if (config.JellyseerrEnable4KTvRequests &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.REQUEST_4K | JellyseerrPermission.REQUEST_4K_TV))
                    issues.Add("Cannot request 4K TV (missing REQUEST_4K / REQUEST_4K_TV)");

                // Advanced request options — only relevant if user can already make requests
                if (config.JellyseerrShowAdvanced)
                {
                    bool canRequest = JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV);
                    if (canRequest && !JellyseerrPermissionHelper.HasPermission(perms, JellyseerrPermission.REQUEST_ADVANCED))
                        issues.Add("Advanced request options are hidden for this user (missing REQUEST_ADVANCED)");
                }

                // Requests page / view — without REQUEST_VIEW they only see their own requests
                if (config.DownloadsPageEnabled &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.REQUEST_VIEW | JellyseerrPermission.MANAGE_REQUESTS))
                    issues.Add("Can only see own requests on Requests page (missing REQUEST_VIEW / MANAGE_REQUESTS) (Can be ignored if on purpose)");

                // Report issues — MANAGE_ISSUES implies CREATE_ISSUES
                if (config.JellyseerrShowReportButton &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.CREATE_ISSUES | JellyseerrPermission.MANAGE_ISSUES))
                    issues.Add("Cannot report issues (missing CREATE_ISSUES or MANAGE_ISSUES)");

                // View issues indicator — MANAGE_ISSUES implies VIEW_ISSUES
                if (config.JellyseerrShowIssueIndicator &&
                    !JellyseerrPermissionHelper.HasAnyPermission(perms,
                        JellyseerrPermission.VIEW_ISSUES | JellyseerrPermission.MANAGE_ISSUES))
                    issues.Add("Cannot view issues from others or count indicator (missing VIEW_ISSUES or MANAGE_ISSUES)");


                results.Add(new
                {
                    jellyfinUsername = jfUser.Username,
                    jellyfinUserId   = userId,
                    linked           = true,
                    permissions      = (int)perms,
                    issues
                });
            }

            return Ok(results);
        }
    }
}
