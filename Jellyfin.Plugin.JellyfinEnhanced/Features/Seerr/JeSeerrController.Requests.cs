using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Newtonsoft.Json.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    public partial class JeSeerrController
    {
        [HttpGet("jellyseerr/search")]
        [Authorize]
        public Task<IActionResult> JellyseerrSearch([FromQuery] string? query, [FromQuery] int page = 1, [FromQuery] string? language = null)
        {
            // previously returned ASP.NET model-binding's RFC9110-link
            // error envelope when `query` was null/empty. Now we return a clean
            // structured BadRequest matching the rest of the API.
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "missing_query",
                    message = "Search query is required."
                }));
            }
            // Clamp pathological inputs. Use UTF-16 surrogate-safe truncation so
            // we don't split a high/low surrogate pair.— important
            // for emoji or extended-CJK searches.
            if (query.Length > 256)
            {
                var cut = 256;
                if (cut > 0 && char.IsHighSurrogate(query[cut - 1])) cut--;
                query = query.Substring(0, cut);
            }
            if (page < 1) page = 1;

            var path = $"/api/v1/search?query={Uri.EscapeDataString(query)}&page={page}";
            if (!string.IsNullOrEmpty(language))
                path += $"&language={Uri.EscapeDataString(language)}";
            return ProxyJellyseerrRequest(path, HttpMethod.Get);
        }

        [HttpGet("jellyseerr/sonarr")]
        [Authorize]
        public Task<IActionResult> GetSonarrInstances()
        {
            return ProxyJellyseerrRequest("/api/v1/service/sonarr", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/radarr")]
        [Authorize]
        public Task<IActionResult> GetRadarrInstances()
        {
            return ProxyJellyseerrRequest("/api/v1/service/radarr", HttpMethod.Get);
        }

        // Sonarr title lookup for series TMDB has no TVDB id for (#653). Seerr
        // resolves the title through its first Sonarr instance and answers 404
        // when none is configured; the season modal then falls back to a manual
        // TVDB id input. Same request-permission gate as the /service/ reads above.
        [HttpGet("jellyseerr/sonarr/lookup/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetSonarrLookup(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/service/sonarr/lookup/{tmdbId}", HttpMethod.Get);
        }

        // Admin-only: proxies Seerr's own Radarr/Sonarr instance CRUD settings
        // (hostname, port, apiKey, useSsl, baseUrl, ...), NOT the read-only
        // /service/{sonarr,radarr} discovery endpoints above. Seerr's
        // /settings subrouter requires a Seerr Administrator key, and the
        // response includes each instance's real API key, so this stays
        // behind IsAdminUser() regardless of [Authorize] alone. Backs the
        // "Import from Seerr" button on the *arr config tab.
        [HttpGet("jellyseerr/settings/{type}")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrArrSettings(string type)
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            if (type != "radarr" && type != "sonarr")
            {
                return BadRequest(new { error = "Invalid type. Must be 'radarr' or 'sonarr'." });
            }

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return StatusCode(503, new { error = "Seerr integration is not configured or enabled." });
            }

            var jellyseerrUrl = config.JellyseerrUrls
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault()?.Trim();
            if (string.IsNullOrEmpty(jellyseerrUrl))
            {
                return StatusCode(503, new { error = "No valid Seerr URL configured." });
            }

            var httpClient = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/settings/{type}";
            using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey);
            using var response = await httpClient.SendAsync(request);
            var (json, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

            if (error != null)
            {
                _logger.Warning($"[Seerr Arr Settings Import] Failed to fetch {type} settings from Seerr: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} {error.Message}");
                // Seerr's /settings subrouter 403s a non-admin key, which is
                // by far the most common failure here, worth its own message
                // rather than the generic "could not reach Seerr" one.
                if (error.HttpStatus == 403)
                {
                    return StatusCode(403, new { error = "Seerr rejected this request. The configured Seerr API key needs Administrator permission to read Radarr/Sonarr settings." });
                }
                return StatusCode(error.HttpStatus > 0 ? error.HttpStatus : 502, error.ToResponseShape());
            }

            // Pass through Seerr's own array shape unmodified; the frontend
            // reads the fields it needs (name, hostname, port, apiKey,
            // useSsl, baseUrl, is4k) rather than us re-serializing here.
            return Content(json ?? "[]", "application/json");
        }

        [HttpGet("jellyseerr/{type}/{serverId}")]
        [Authorize]
        public Task<IActionResult> GetServiceDetails(string type, int serverId)
        {
            // Allowlist the type segment so only known Seerr service routes are reachable —
            // `/api/v1/service/{type}/{serverId}` is interpolated into the upstream URL, so
            // any user-supplied value would be passed through. Today Seerr only knows
            // sonarr/radarr; reject anything else with 400.
            if (type != "sonarr" && type != "radarr")
            {
                return Task.FromResult<IActionResult>(BadRequest(new { error = true, code = "invalid_service_type", message = "Service type must be 'sonarr' or 'radarr'." }));
            }
            return ProxyJellyseerrRequest($"/api/v1/service/{type}/{serverId}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request")]
        [Authorize]
        public async Task<IActionResult> JellyseerrRequest([FromBody] JsonElement requestBody)
        {
            var result = await ProxyJellyseerrRequest("/api/v1/request", HttpMethod.Post, requestBody.ToString());

            // Auto-on-request Spoiler Guard pending — best-effort, never blocks
            // the request. Gated by SpoilerBlurEnabled + SpoilerAutoEnableOnSeerrRequest.
            // Only a 2xx counts as user intent; 409 fails closed — its body is
            // ambiguous (MEDIA_EXISTS vs quota/permission denial) and SeerrHttpHelper
            // replaces it with a synthesized envelope anyway.
            try
            {
                var cfg = JellyfinEnhanced.Instance?.Configuration;
                if (cfg?.SpoilerBlurEnabled == true
                    && cfg?.SpoilerAutoEnableOnSeerrRequest == true
                    && IsSeerrRequestResultSuccessful(result))
                {
                    // Snapshot identity + body BEFORE Task.Run — HttpContext/User
                    // are invalid after we return; clone the request-scoped JsonElement.
                    var userId = UserHelper.GetCurrentUserId(User);
                    if (userId != null && userId != Guid.Empty)
                    {
                        var capturedUserId = userId.Value;
                        // Clone is detached (own document), safe to read off-thread.
                        JsonElement bodyClone;
                        try { bodyClone = requestBody.Clone(); }
                        catch { bodyClone = default; }

                        if (bodyClone.ValueKind == JsonValueKind.Object)
                        {
                            _ = Task.Run(() => TryAutoEnablePendingFromSeerrRequest(capturedUserId, bodyClone));
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Spoiler Guard auto-on-request hook threw {ex.GetType().Name}: {ex.Message}");
            }

            return result;
        }

        // True only for a 2xx proxy result. 409 fails closed: it's an ambiguous
        // Seerr conflict (MEDIA_EXISTS vs quota/permission denial) whose body
        // SeerrHttpHelper has already replaced, so we can't distinguish — the
        // user can still toggle the modal manually. Null StatusCode counts as OK
        // only for ContentResult (the success path, defaults to 200); a null on
        // ObjectResult/StatusCodeResult is failure, guarding a future
        // Ok(errorEnvelope) misclassification.
        private static bool IsSeerrRequestResultSuccessful(IActionResult result)
        {
            int? status;
            bool allowNullAsOk = false;
            if (result is ContentResult cr)
            {
                status = cr.StatusCode;
                allowNullAsOk = true;
            }
            else if (result is ObjectResult or)
            {
                status = or.StatusCode;
            }
            else if (result is StatusCodeResult sr)
            {
                status = sr.StatusCode;
            }
            else
            {
                return false;
            }

            if (status is null)
            {
                if (!allowNullAsOk) return false;
                status = 200;
            }
            int sc = status.Value;
            return sc >= 200 && sc < 300;
        }

        // Off-thread continuation — must NOT touch HttpContext / User.
        // userId is captured by the caller before Task.Run was scheduled.
        private void TryAutoEnablePendingFromSeerrRequest(Guid userId, JsonElement requestBody)
        {
            try
            {
                if (requestBody.ValueKind != JsonValueKind.Object) return;
                if (!requestBody.TryGetProperty("mediaType", out var mtProp) || mtProp.ValueKind != JsonValueKind.String) return;
                if (!requestBody.TryGetProperty("mediaId", out var miProp)) return;

                var rawType = mtProp.GetString();
                if (string.IsNullOrEmpty(rawType)) return;
                var mediaType = rawType.ToLowerInvariant();
                if (mediaType != "tv" && mediaType != "movie") return;
                // Shared auto-enable scope (content type only — the title
                // isn't in a library yet, so the library filter can't apply).
                if (!Features.SpoilerGuard.PublicApi.SpoilerGuardApi.AutoEnableFilter.AllowsType(JellyfinEnhanced.Instance?.Configuration, mediaType == "tv")) return;

                int tmdbInt;
                if (miProp.ValueKind == JsonValueKind.Number)
                {
                    if (!miProp.TryGetInt32(out tmdbInt) || tmdbInt <= 0) return;
                }
                else if (miProp.ValueKind == JsonValueKind.String)
                {
                    if (!int.TryParse(miProp.GetString(), System.Globalization.NumberStyles.Integer,
                                      System.Globalization.CultureInfo.InvariantCulture, out tmdbInt)
                        || tmdbInt <= 0) return;
                }
                else
                {
                    return;
                }

                var jUser = _userManager.GetUserById(userId);
                if (jUser == null) return;

                var canonicalTmdb = tmdbInt.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var summary = _spoilerPendingService.AddSpoilerBlurPendingInternal(userId, jUser, mediaType, canonicalTmdb, displayName: null);
                if (summary.WroteSomething)
                {
                    _logger.Info($"Spoiler Guard auto-on-request {summary.Promoted} for {mediaType}:{canonicalTmdb} by {_userDisplayResolver.ResolveUserDisplay(userId.ToString("N"))}");
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Spoiler Guard auto-on-request task threw {ex.GetType().Name}: {ex.Message}");
            }
        }

        [HttpGet("jellyseerr/request")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrRequests([FromQuery] int take = 500, [FromQuery] int skip = 0, [FromQuery] string filter = "all")
        {
            return ProxyJellyseerrRequest($"/api/v1/request?take={take}&skip={skip}&filter={Uri.EscapeDataString(filter ?? string.Empty)}", HttpMethod.Get);
        }

        // Returns the user's Seerr quota with a nextResetAt added per side.
        [HttpGet("jellyseerr/quota")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrQuota()
        {
            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString() ?? "";
            var seerrUserId = await _seerrUserLookup.GetJellyseerrUserId(jellyfinUserId);
            var quotaResult = await ProxyJellyseerrRequest($"/api/v1/user/{seerrUserId}/quota", HttpMethod.Get);

            // Reset-time enrichment is best-effort — fall back to the un-enriched
            // result on any failure (malformed body, Seerr admin shape, etc).
            if (quotaResult is ContentResult cr && cr.StatusCode is null or 200)
            {
                try
                {
                    var quota = JObject.Parse(cr.Content ?? "{}");
                    await EnrichQuotaWithResetAsync(quota, seerrUserId!, JellyfinEnhanced.Instance!.Configuration);
                    return Content(quota.ToString(Newtonsoft.Json.Formatting.None), "application/json");
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Quota enrichment skipped ({ex.GetType().Name}): {ex.Message}");
                }
            }

            return quotaResult;
        }

        private async Task EnrichQuotaWithResetAsync(JObject quota, string seerrUserId, PluginConfiguration config)
        {
            // Parallel: independent HTTP calls, sequential would double worst-case latency.
            var movieTask = ComputeNextResetAsync(quota, "movie", seerrUserId, config);
            var tvTask = ComputeNextResetAsync(quota, "tv", seerrUserId, config);
            await Task.WhenAll(movieTask, tvTask);

            // Seerr admins / no-policy users return {"movie":null,"tv":null}; cast safely.
            if (movieTask.Result.HasValue && quota["movie"] is JObject mObj)
            {
                mObj["nextResetAt"] = movieTask.Result.Value.ToString("o");
            }
            if (tvTask.Result.HasValue && quota["tv"] is JObject tObj)
            {
                tObj["nextResetAt"] = tvTask.Result.Value.ToString("o");
            }
        }

        private async Task<DateTime?> ComputeNextResetAsync(JObject quota, string mediaType, string seerrUserId, PluginConfiguration config)
        {
            var side = quota[mediaType] as JObject;
            if (side == null) return null;

            int limit = side["limit"]?.Value<int?>() ?? 0;
            int used = side["used"]?.Value<int?>() ?? 0;
            int days = side["days"]?.Value<int?>() ?? 0;

            // limit=0 is unlimited; no requests means nothing to roll off.
            if (limit <= 0 || used <= 0 || days <= 0) return null;

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(8);

            // Iterate URLs for multi-instance failover, matching ProxyJellyseerrRequest.
            foreach (var rawUrl in urls)
            {
                var trimmedUrl = rawUrl.Trim().TrimEnd('/');
                try
                {
                    // sortDirection=asc returns oldest first; take=20 gives a margin for declined.
                    var requestUri = $"{trimmedUrl}/api/v1/request" +
                                     $"?take=20&skip=0&sortDirection=asc&requestedBy={seerrUserId}&mediaType={mediaType}";

                    using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.JellyseerrApiKey, seerrUserId);
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
                    if (error != null)
                    {
                        _logger.Debug($"ComputeNextResetAsync({mediaType}) on {trimmedUrl} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                        continue;
                    }

                    using var doc = JsonDocument.Parse(content!);
                    if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                    {
                        continue;
                    }

                    // Quota excludes DECLINED (status==3), so we do too.
                    var windowStart = DateTime.UtcNow.AddDays(-days);
                    DateTime? oldestCreatedAt = null;
                    foreach (var req in results.EnumerateArray())
                    {
                        if (req.TryGetProperty("status", out var statusEl) &&
                            statusEl.ValueKind == JsonValueKind.Number &&
                            statusEl.GetInt32() == 3)
                        {
                            continue;
                        }

                        if (!req.TryGetProperty("createdAt", out var createdEl) ||
                            createdEl.ValueKind != JsonValueKind.String)
                        {
                            continue;
                        }

                        if (!DateTime.TryParse(createdEl.GetString(), System.Globalization.CultureInfo.InvariantCulture,
                            System.Globalization.DateTimeStyles.RoundtripKind, out var createdAt))
                        {
                            continue;
                        }

                        var createdAtUtc = createdAt.ToUniversalTime();
                        if (createdAtUtc < windowStart) continue;

                        if (oldestCreatedAt == null || createdAtUtc < oldestCreatedAt.Value)
                        {
                            oldestCreatedAt = createdAtUtc;
                        }
                    }

                    return oldestCreatedAt?.AddDays(days);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"ComputeNextResetAsync({mediaType}) on {trimmedUrl} failed ({ex.GetType().Name}): {ex.Message}");
                }
            }

            return null;
        }
    }
}
