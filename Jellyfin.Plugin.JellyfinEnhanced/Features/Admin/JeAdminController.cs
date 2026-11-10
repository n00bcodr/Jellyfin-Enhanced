using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Admin
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JeAdminController : JeControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly MaintenanceModeService _maintenanceModeService;
        private readonly ISessionManager _sessionManager;
        private readonly WhatsNewService _whatsNewService;
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Shared.Host.HostCompatibilityService _hostCompatibility;
        private readonly IServerConfigurationManager _serverConfigurationManager;
        private readonly INetworkManager _networkManager;

        public JeAdminController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            UserConfigurationManager userConfigurationManager,
            MaintenanceModeService maintenanceModeService,
            ISessionManager sessionManager,
            WhatsNewService whatsNewService,
            Jellyfin.Plugin.JellyfinEnhanced.Shared.Host.HostCompatibilityService hostCompatibility,
            IServerConfigurationManager serverConfigurationManager,
            INetworkManager networkManager)
            : base(userManager, logger, userConfigurationManager)
        {
            _httpClientFactory = httpClientFactory;
            _maintenanceModeService = maintenanceModeService;
            _sessionManager = sessionManager;
            _whatsNewService = whatsNewService;
            _hostCompatibility = hostCompatibility;
            _serverConfigurationManager = serverConfigurationManager;
            _networkManager = networkManager;
        }

        /// <summary>
        /// Builds Jellyfin's own LAN URL from its detected internal bind interfaces
        /// (the same source Jellyfin itself uses for Server Discovery / PlayTo /
        /// LiveTV / SystemInfo) plus the configured internal port -- a genuinely
        /// server-known value, not a guess from whatever origin the admin's browser
        /// happens to be on right now.
        /// </summary>
        private string? GetJellyfinInternalUrl()
        {
            var address = _networkManager.GetInternalBindAddresses()
                .Select(d => d.Address)
                .FirstOrDefault(a => !System.Net.IPAddress.IsLoopback(a));
            if (address == null)
            {
                return null;
            }

            var networkConfig = _serverConfigurationManager.GetNetworkConfiguration();
            var scheme = networkConfig.EnableHttps ? "https" : "http";
            var port = networkConfig.EnableHttps ? networkConfig.InternalHttpsPort : networkConfig.InternalHttpPort;
            var host = address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6
                ? $"[{address}]"
                : address.ToString();
            return $"{scheme}://{host}:{port}";
        }

        /// <summary>
        /// Reads Jellyfin's own "Published server URIs" (Dashboard → Networking →
        /// Advanced) for an "external" or "all" override -- the same mechanism
        /// Jellyfin itself uses to tell clients what URL to use from outside the
        /// LAN. When set, this is a far more reliable source for "Jellyfin's
        /// public URL" than guessing from the admin's current browser origin.
        /// </summary>
        private string? GetJellyfinExternalUrl()
        {
            var overrides = _serverConfigurationManager.GetNetworkConfiguration().PublishedServerUriBySubnet;
            if (overrides == null || overrides.Length == 0)
            {
                return null;
            }

            // "all" always wins in Jellyfin's own resolution (it clears every other
            // override once reached), so prefer it here too if both are present.
            string? externalMatch = null;
            foreach (var entry in overrides)
            {
                var parts = entry.Split('=', 2);
                if (parts.Length != 2)
                {
                    continue;
                }

                var key = parts[0].Trim();
                var url = parts[1].Trim();
                if (string.Equals(key, "all", StringComparison.OrdinalIgnoreCase))
                {
                    return url;
                }
                if (string.Equals(key, "external", StringComparison.OrdinalIgnoreCase))
                {
                    externalMatch = url;
                }
            }

            return externalMatch;
        }

        /// <summary>
        /// Which Jellyfin line this DLL was built for vs which one is running it.
        /// Exposes build/host compatibility for administrator diagnostics.
        /// </summary>
        [HttpGet("host-compat")]
        [Authorize]
        public ActionResult GetHostCompatibility()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            var isStale = _hostCompatibility.IsStale;
            return new JsonResult(new
            {
                builtFor = Jellyfin.Plugin.JellyfinEnhanced.Shared.Host.HostCompatibilityService.BuiltFor,
                hostTarget = _hostCompatibility.HostTarget,
                hostVersion = _hostCompatibility.HostVersionString,
                pluginVersion = JellyfinEnhanced.Instance?.Version.ToString(),
                mismatch = _hostCompatibility.IsMismatch,
                stale = isStale,
                expectedAsset = _hostCompatibility.ExpectedAssetName,
                manifestUrl = Jellyfin.Plugin.JellyfinEnhanced.Shared.Host.HostCompatibilityService.ManifestUrl,
                message = _hostCompatibility.GetCompatibilityMessage(isStale)
            });
        }

        // Admin-only. Backs the "Import from Seerr" picker's URL-mapping pre-fill --
        // both values come from Jellyfin's own server-side network detection rather
        // than guessing from the admin's current browser origin: external from
        // Dashboard -> Networking -> Advanced "Published server URIs" ("external"/
        // "all" override), internal from Jellyfin's own detected LAN bind address.
        // Either may be null if not configured/detectable; the frontend falls back
        // to an editable guess in that case.
        [HttpGet("jellyfin-urls")]
        [Authorize]
        public ActionResult GetJellyfinNetworkUrls()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            return new JsonResult(new { externalUrl = GetJellyfinExternalUrl(), internalUrl = GetJellyfinInternalUrl() });
        }

        /// <summary>
        /// Saves a few plugin configuration fields on top of the configuration the server holds now (the Media Tags
        /// page saves field by field). It reads and writes inside the same critical section as every other save, so
        /// it never puts back an older value of a field it was not asked to change, even one another save (the main
        /// configuration page's) wrote while this request was waiting. Only the Media Tags tab's own fields
        /// (<see cref="MediaTagsPageFields"/>) are accepted; every other field stays with the main page's full save.
        /// A field listed in <c>Expected</c> with the value the caller read before editing it is refused with 409 and
        /// the server's value when that value has changed since; nothing is written then. Admin only.
        /// </summary>
        /// <param name="request">The changed fields and, per field, the value read before the edit.</param>
        /// <returns>
        /// 200 with the stored values, 400 for a field the page does not own or a value outside the field's contract
        /// (<see cref="MediaTagsPageFields.TryNormalize"/>), 409 with the conflicts. A body (the whole `Changes` and `Expected` document) over 8 MiB is refused while
        /// it is read, before the action runs (Jellyfin's exception middleware answers 500).
        /// </returns>
        [HttpPost("admin/configuration")]
        [Authorize]
        [RequestSizeLimit(PluginConfigurationPatch.MaxRequestBytes)]
        [Produces("application/json")]
        public IActionResult PatchConfiguration([FromBody] ConfigurationPatchRequest? request)
        {
            if (!IsAdminUser()) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            if (plugin == null) return StatusCode(503);
            if (request?.Changes == null || request.Changes.Count == 0) return BadRequest(new { error = "No changes." });

            var result = PluginConfigurationPatch.Apply(plugin, request.Changes, request.Expected, MediaTagsPageFields.Allowed);
            if (result.Error != null) return BadRequest(new { error = result.Error });
            if (result.Conflicts.Count > 0) return Conflict(new { conflicts = result.Conflicts });
            return Ok(new { values = result.Values });
        }

        [HttpGet("whats-new")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetWhatsNew()
        {
            if (!IsAdminUser()) return Forbid();

            var state = _whatsNewService.GetState();
            if (state == null)
            {
                return Ok(new { pluginVersion = default(string), newSettings = new Dictionary<string, string>(), mediaTags = new Dictionary<string, object>() });
            }

            // New settings that live on the Media Tags tab: where on it, so the banner can open it there.
            var locations = _whatsNewService.GetMediaTagsLocations();
            var mediaTags = state.NewSettings.Keys
                .Where(locations.ContainsKey)
                .ToDictionary(id => id, id => (object)new { page = Services.WhatsNewService.MediaTagsPageName, tab = locations[id].Tab, group = locations[id].Group }, StringComparer.Ordinal);
            return Ok(new { pluginVersion = state.PluginVersion, newSettings = state.NewSettings, mediaTags });
        }

        [HttpPost("whats-new/dismiss")]
        [Authorize]
        public IActionResult DismissWhatsNew()
        {
            if (!IsAdminUser()) return Forbid();

            _whatsNewService.Dismiss();
            return Ok();
        }

        [HttpGet("arr/validate/sonarr")]
        [Authorize]
        public async Task<IActionResult> ValidateSonarr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            return await ValidateArrService("Sonarr", url, apiKey);
        }

        [HttpGet("arr/validate/radarr")]
        [Authorize]
        public async Task<IActionResult> ValidateRadarr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            return await ValidateArrService("Radarr", url, apiKey);
        }

        private async Task<IActionResult> ValidateArrService(string serviceName, string url, string apiKey)
        {
            if (!IsAdminUser())
                return Forbid();

            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = $"Missing {serviceName} URL or API key" });

            if (!ArrUrlGuard.IsAllowedUrl(url, _logger))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.DefaultRequestHeaders.Clear();
            http.DefaultRequestHeaders.Add("X-Api-Key", apiKey);
            http.Timeout = TimeSpan.FromSeconds(10);

            try
            {
                using var resp = await http.GetAsync($"{url.TrimEnd('/')}/api/v3/system/status");
                if (resp.IsSuccessStatusCode)
                    return Ok(new { ok = true });

                if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
                    resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
                    return StatusCode(401, new { ok = false, message = $"API key is invalid or unauthorized for {serviceName}" });

                return StatusCode((int)resp.StatusCode, new { ok = false, message = $"{serviceName} returned an error (status {(int)resp.StatusCode})" });
            }
            catch (TaskCanceledException)
            {
                return StatusCode(504, new { ok = false, message = $"Connection to {serviceName} timed out. Check the URL is correct." });
            }
            catch (Exception ex)
            {
                _logger.Warning($"{serviceName} validate failed for {url}: {ex.Message}");
                return StatusCode(502, new { ok = false, message = $"Could not reach {serviceName}. Check the URL is correct and the server is running." });
            }
        }

        // ── Maintenance Mode ────────────────────────────────────────────────────

        [Authorize]
        [HttpGet("MaintenanceMode/Status")]
        public IActionResult GetMaintenanceStatus()
        {
            if (!IsAdminUser()) return Forbid();
            var state = _maintenanceModeService.GetStatus();
            return Ok(new
            {
                state.IsActive,
                state.Message,
                state.NotificationMessage,
                state.Action,
                state.Source,
                state.StartedAt,
                state.EndsAt,
                AccountDisabledCount = state.AccountDisabledUserIds.Count,
                RemoteDisabledCount  = state.RemoteDisabledUserIds.Count,
                // The daily window runs on the server's clock (often UTC in containers); the config
                // page shows this so admins set the window in the right time zone.
                ServerLocalTime = DateTime.Now.ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture),
                ServerUtcOffset = FormatUtcOffset(TimeZoneInfo.Local.GetUtcOffset(DateTime.Now))
            });
        }

        [Authorize]
        [HttpPost("MaintenanceMode/Enable")]
        public async Task<IActionResult> EnableMaintenanceMode([FromBody] MaintenanceModeRequest request)
        {
            if (!IsAdminUser()) return Forbid();
            await _maintenanceModeService.EnableAsync(
                request.Message ?? string.Empty,
                request.DurationMinutes,
                request.Action ?? "disable_accounts",
                request.AffectedUserIds,
                request.NotificationMessage).ConfigureAwait(false);
            return Ok(new { success = true });
        }

        /// <summary>"+08:00" / "-05:30" / "+00:00".</summary>
        private static string FormatUtcOffset(TimeSpan offset)
            => (offset < TimeSpan.Zero ? "-" : "+") + offset.Duration().ToString(@"hh\:mm", System.Globalization.CultureInfo.InvariantCulture);

        /// <param name="includeScheduled">
        /// Default true ends whatever window is active. The config page passes false while the daily
        /// schedule is on, so saving with the manual toggle off leaves a scheduled window running.
        /// </param>
        [Authorize]
        [HttpPost("MaintenanceMode/Disable")]
        public async Task<IActionResult> DisableMaintenanceMode([FromQuery] bool includeScheduled = true)
        {
            if (!IsAdminUser()) return Forbid();
            await _maintenanceModeService.DisableAsync(includeScheduled).ConfigureAwait(false);
            return Ok(new { success = true });
        }

        [Authorize]
        [HttpGet("MaintenanceMode/Users")]
        public IActionResult GetMaintenanceModeUsers()
        {
            if (!IsAdminUser()) return Forbid();
            var users = _userManager.GetAllUsers()
                .Where(u => !u.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator))
                // HasImage lets the page skip avatar requests that can only 404.
                .Select(u => new { Id = u.Id.ToString(), u.Username, HasImage = u.ProfileImage != null })
                .OrderBy(u => u.Username)
                .ToList();
            return Ok(users);
        }

        [Authorize]
        [HttpPost("MaintenanceMode/Broadcast")]
        public async Task<IActionResult> BroadcastMaintenanceMessage([FromBody] MaintenanceBroadcastRequest request)
        {
            if (!IsAdminUser()) return Forbid();
            if (request == null || string.IsNullOrWhiteSpace(request.Text))
                return BadRequest("Message text is required.");

            var controllingSessionId = string.Empty;
            try
            {
                var adminSession = _sessionManager.Sessions.FirstOrDefault(s => s.UserId == GetCurrentUserId());
                controllingSessionId = adminSession?.Id ?? string.Empty;
            }
            catch { /* non-fatal */ }

            var (sent, skipped, errors) = await _maintenanceModeService
                .BroadcastAsync(request.Header, request.Text, request.TimeoutMs, controllingSessionId)
                .ConfigureAwait(false);

            return Ok(new { sent, skipped, errors });
        }

        public class MaintenanceBroadcastRequest
        {
            public string? Header { get; set; }
            public string Text { get; set; } = string.Empty;
            public long TimeoutMs { get; set; } = 30000;
        }
    }

    public class MaintenanceModeRequest
    {
        public string? Message { get; set; }
        /// <summary>Popup text for active sessions; kept for the playback reminder. Falls back to Message.</summary>
        public string? NotificationMessage { get; set; }
        /// <summary>0 = until disabled; otherwise auto-disables after this many minutes.</summary>
        public int DurationMinutes { get; set; }
        /// <summary>"none" | "disable_accounts" | "disable_remote" | "both"</summary>
        public string Action { get; set; } = "disable_accounts";
        /// <summary>Specific user IDs to affect. Null or empty = all non-admin users.</summary>
        public List<string>? AffectedUserIds { get; set; }
    }
}
