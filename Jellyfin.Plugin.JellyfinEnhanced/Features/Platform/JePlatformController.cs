using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using System.Security.Cryptography;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using static Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Sessions;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.HiddenContent;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Platform
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public partial class JePlatformController : JeControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILibraryManager _libraryManager;
        private readonly Shared.Maintenance.MaintenanceModeService _maintenanceModeService;
        private readonly Features.Platform.Services.CdnAssetService _cdnAssetService;
        private readonly Shared.Analytics.UsageEventCounterService _usageEventCounterService;
        private readonly Features.Platform.Services.AnalyticsReportingService _analyticsReportingService;
        private readonly IPluginManager _pluginManager;
        private readonly UserDisplayResolver _userDisplayResolver;
        private readonly ArrInstanceClient _arrInstanceClient;
        private readonly ActiveSessionsService _activeSessionsService;
        private readonly HiddenContentDocumentService _hiddenContentDocumentService;

        public JePlatformController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            ILibraryManager libraryManager,
            UserConfigurationManager userConfigurationManager,
            MediaBrowser.Controller.Session.ISessionManager sessionManager,
            Shared.Maintenance.MaintenanceModeService maintenanceModeService,
            Features.Platform.Services.CdnAssetService cdnAssetService,
            Shared.Analytics.UsageEventCounterService usageEventCounterService,
            Features.Platform.Services.AnalyticsReportingService analyticsReportingService,
            IPluginManager pluginManager)
            : base(userManager, logger, userConfigurationManager)
        {
            _httpClientFactory = httpClientFactory;
            _libraryManager = libraryManager;
            _maintenanceModeService = maintenanceModeService;
            _cdnAssetService = cdnAssetService;
            _usageEventCounterService = usageEventCounterService;
            _analyticsReportingService = analyticsReportingService;
            _pluginManager = pluginManager;
            _userDisplayResolver = new UserDisplayResolver(userManager);
            _arrInstanceClient = new ArrInstanceClient(httpClientFactory, logger);
            _activeSessionsService = new ActiveSessionsService(sessionManager);
            _hiddenContentDocumentService = new HiddenContentDocumentService(userConfigurationManager, logger, _userDisplayResolver);
        }

        // [AllowAnonymous]: version is loaded by translations.js cache-buster pre-login.
        // Information disclosure of the plugin version is acceptable — Jellyfin core
        // exposes its own version pre-auth too. CVEs against JE are tracked publicly
        // so attackers do not need this endpoint to fingerprint a vulnerable version.
        [HttpGet("version")]
        public ActionResult GetVersion() => Content(JellyfinEnhanced.Instance?.Version.ToString() ?? "unknown");

        /// <summary>
        /// Award wins/nominations for a title or a person, keyed by TMDB id.
        /// "movie"/"tv" return awards the title itself (or a cast/crew member,
        /// "for" that title) received; "person" returns that person's own
        /// full award history across their career. Backed by
        /// WikidataAwardsService's disk cache — Wikidata's public SPARQL endpoint
        /// needs no API key, so this is gated only on the ShowAwards toggle, not
        /// TMDB_API_KEY (that key is unrelated to this lookup).
        /// </summary>
        /// <summary>
        /// Bumps one feature-usage counter (e.g. "seerr.request_submitted") for the
        /// current analytics reporting period. No-ops silently (not an error)
        /// unless analytics AND the usage-counts category are both enabled, so a
        /// client that fires this unconditionally never needs to check config
        /// first. Any authenticated user can call this; it's a fire-and-forget
        /// counter bump, not a privileged action.
        /// </summary>
        [HttpPost("usage/track")]
        [Authorize]
        public IActionResult TrackUsage([FromBody] JsonElement requestBody)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.AnalyticsEnabled || !config.AnalyticsShareUsageCounts)
            {
                return Ok();
            }

            if (!requestBody.TryGetProperty("key", out var keyEl) || keyEl.ValueKind != JsonValueKind.String)
            {
                return BadRequest("Missing 'key'.");
            }

            var key = keyEl.GetString() ?? string.Empty;
            // IsKnownKey restricts this endpoint to the finite set of counters
            // the plugin actually emits: without it, any authenticated user
            // could mint unbounded distinct counter rows or forge "total.*"
            // snapshot keys alongside the real ones.
            if (!Shared.Analytics.UsageEventCounterService.IsValidKey(key))
            {
                return BadRequest("Invalid feature key.");
            }
            if (!Shared.Analytics.UsageEventCounterService.IsKnownKey(key))
            {
                // Loud on purpose: a well-formed-but-unlisted key is almost
                // always a new client counter shipped without the matching
                // KnownKeys entry — silently 400ing it would read as "nobody
                // uses this feature" on the dashboard forever. (key already
                // passed the charset check above, so it's safe to log.)
                _logger.Warning($"[Analytics] Rejected unknown usage key '{key}' — new counters must be added to UsageEventCounterService.KnownKeys in the same change that emits them.");
                return BadRequest("Unknown feature key.");
            }

            _usageEventCounterService.Increment(key);
            return Ok();
        }

        /// <summary>
        /// Returns the exact payload a report would send right now, using the
        /// CURRENTLY DISPLAYED checkbox states from the request body, not
        /// necessarily the saved config, so toggling a checkbox on the
        /// config page and clicking Preview updates immediately, without
        /// requiring Save first. Also returns when/what was last actually
        /// sent (that part always reflects the real saved state). Admin-only
        /// since it reflects the server's full config-flag snapshot.
        ///
        /// Deliberately does NOT call EnsureRegisteredAsync: registering
        /// mints a real row on the backend, and a preview click is not
        /// consent to opt in. If this install has never actually sent a real
        /// report, InstallId is shown as an unregistered placeholder rather
        /// than silently registering just to fill in the preview. Only a
        /// genuine send (config saved with analytics on, or the scheduled
        /// task) ever registers.
        /// </summary>
        [HttpPost("usage/preview")]
        [Authorize]
        public IActionResult PreviewUsageReport([FromBody] JsonElement requestBody)
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return StatusCode(503);
            }

            bool ReadBool(string name, bool fallback) =>
                requestBody.TryGetProperty(name, out var el) && el.ValueKind is JsonValueKind.True or JsonValueKind.False
                    ? el.GetBoolean()
                    : fallback;

            var shareFeatureFlags = ReadBool("shareFeatureFlags", config.AnalyticsShareFeatureFlags);
            var shareUsageCounts = ReadBool("shareUsageCounts", config.AnalyticsShareUsageCounts);
            var shareDataSizes = ReadBool("shareDataSizes", config.AnalyticsShareDataSizes);

            var payload = _analyticsReportingService.BuildPayload(config, shareFeatureFlags, shareUsageCounts, shareDataSizes);
            var displayInstallId = string.IsNullOrEmpty(payload.InstallId)
                ? "(not registered yet; assigned on first real send)"
                : payload.InstallId;

            return new JsonResult(new
            {
                Payload = new
                {
                    InstallId = displayInstallId,
                    payload.PluginVersion,
                    payload.JellyfinVersion,
                    payload.JellyfinTarget,
                    payload.Config,
                    payload.Settings,
                    payload.DataFileSizes,
                    payload.Period,
                    payload.Events,
                },
                LastReportedAt = config.AnalyticsLastReportedAt,
                LastPayloadJson = config.AnalyticsLastPayloadJson,
            });
        }

        // Tag-cache + tag-data both load the user's spoiler state. Strict-read so
        // corruption is detected (rate-limited warn), then fall back to null so the
        // strip silently no-ops rather than 503-ing the unrelated tag-cache request —
        // the user's own /spoiler-blur/series endpoint will 503 next call. See
        // IsMovieInSpoilerScope for scope semantics (direct or via opted-in BoxSet).


        [HttpGet("proxy/avatar")]
        [Authorize]
        public async Task<IActionResult> ProxyAvatar([FromQuery] string path)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(path))
            {
                return NotFound();
            }

            var jellyseerrUrl = config.JellyseerrUrls
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)[0]
                .Trim().TrimEnd('/');

            // Strip query string (?v=timestamp) and fragment — only the path is needed.
            var avatarPath = path.Trim();
            var q = avatarPath.IndexOf('?');
            if (q >= 0) avatarPath = avatarPath[..q];
            var f = avatarPath.IndexOf('#');
            if (f >= 0) avatarPath = avatarPath[..f];

            if (!avatarPath.StartsWith('/'))
                avatarPath = $"/{avatarPath}";

            // Block path traversal, scheme injection, and request smuggling.
            if (avatarPath.Contains("..") || avatarPath.Contains("://") || avatarPath.Contains("@")
                || avatarPath.Contains("\r") || avatarPath.Contains("\n")
                || avatarPath.Contains("%0d", StringComparison.OrdinalIgnoreCase)
                || avatarPath.Contains("%0a", StringComparison.OrdinalIgnoreCase)
                || avatarPath.Contains("%00"))
            {
                _logger.Warning("ProxyAvatar: unsafe characters in path blocked");
                return BadRequest("Invalid avatar path");
            }

            // SSRF guard: only allow known Jellyseerr avatar path prefixes.
            if (!avatarPath.StartsWith("/avatar/", StringComparison.OrdinalIgnoreCase)
                && !avatarPath.StartsWith("/avatarproxy/", StringComparison.OrdinalIgnoreCase)
                && !avatarPath.StartsWith("/api/v1/avatar/", StringComparison.OrdinalIgnoreCase))
            {
                _logger.Warning($"ProxyAvatar: path not in allowed list '{avatarPath}'");
                return BadRequest("Invalid avatar path");
            }

            try
            {
                // include the resolved Seerr URL in the cache key
                // so that switching to a different Seerr instance with the same
                // avatar path doesn't serve stale bytes from the old instance.
                var cacheKey = $"{jellyseerrUrl}|{avatarPath}";

                // Check server-side cache first to avoid hitting upstream Seerr
                // on every request. This is critical for large avatars (e.g., animated
                // GIFs) that would otherwise be re-downloaded on every conditional request.
                if (_avatarCache.TryGetValue(cacheKey, out var cached)
                    && DateTime.UtcNow - cached.CachedAt < _avatarCacheDuration)
                {
                    // Serve 304 if client already has this version
                    if (Request.Headers.TryGetValue("If-None-Match", out var cachedIfNoneMatch)
                        && cachedIfNoneMatch.ToString().Contains(cached.ETag))
                    {
                        Response.Headers["Cache-Control"] = "public, max-age=3600";
                        Response.Headers["ETag"] = cached.ETag;
                        return StatusCode(304);
                    }

                    Response.Headers["Cache-Control"] = "public, max-age=3600";
                    Response.Headers["ETag"] = cached.ETag;
                    return File(cached.Content, cached.ContentType);
                }

                var client = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(10);

                using var avatarRequest = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, $"{jellyseerrUrl}{avatarPath}");
                // explicit User-Agent + Accept so Cloudflare's bot
                // mode doesn't return an HTML challenge page that we'd try to
                // serve as an image.
                avatarRequest.Headers.UserAgent.ParseAdd(Shared.Seerr.SeerrHttpHelper.UserAgent);
                avatarRequest.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("image/*"));
                var response = await client.SendAsync(avatarRequest);
                if (!response.IsSuccessStatusCode)
                {
                    return NotFound();
                }

                // Closed-set MIME whitelist. previously
                // accepted `image/svg+xml`, so a compromised Seerr could serve
                // an SVG with embedded `<script>` that we'd cache for 1 hour.
                // SVG is intentionally excluded — TMDB avatars are always
                // raster formats.
                var contentType = response.Content.Headers.ContentType?.MediaType ?? "image/jpeg";
                var allowedAvatarTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    "image/png", "image/jpeg", "image/jpg", "image/gif",
                    "image/webp", "image/avif", "image/bmp"
                };
                if (!allowedAvatarTypes.Contains(contentType))
                {
                    _logger.Debug($"ProxyAvatar rejected unsafe content-type: {contentType}");
                    return NotFound();
                }

                var content = await response.Content.ReadAsByteArrayAsync();

                // Compute ETag from content hash for conditional request support.
                var hash = SHA256.HashData(content);
                var etag = $"\"{Convert.ToHexString(hash)}\"";

                // Store in server-side cache and evict expired entries periodically
                _avatarCache[cacheKey] = (content, contentType, etag, DateTime.UtcNow);
                if (_avatarCache.Count > 50 || _avatarCache.Count % 10 == 0)
                {
                    foreach (var key in _avatarCache
                        .Where(kv => DateTime.UtcNow - kv.Value.CachedAt > _avatarCacheDuration)
                        .Select(kv => kv.Key)
                        .ToList())
                    {
                        _avatarCache.TryRemove(key, out _);
                    }
                }

                // Serve 304 if client already has this version
                if (Request.Headers.TryGetValue("If-None-Match", out var ifNoneMatch)
                    && ifNoneMatch.ToString().Contains(etag))
                {
                    Response.Headers["Cache-Control"] = "public, max-age=3600";
                    Response.Headers["ETag"] = etag;
                    return StatusCode(304);
                }

                Response.Headers["Cache-Control"] = "public, max-age=3600";
                Response.Headers["ETag"] = etag;

                return File(content, contentType);
            }
            catch (Exception ex)
            {
                _logger.Warning($"ProxyAvatar exception: {ex.Message}");
                return NotFound();
            }
        }

        [Authorize]
        [HttpGet("{viewName}")]
        public ActionResult GetView([FromRoute] string viewName)
        {
            if (JellyfinEnhanced.Instance == null)
            {
                return BadRequest("No plugin instance found");
            }

            IEnumerable<PluginPageInfo> pages = JellyfinEnhanced.Instance.GetViews();

            if (pages == null)
            {
                return NotFound("Pages is null or empty");
            }

            PluginPageInfo? view = pages.FirstOrDefault(pageInfo => pageInfo?.Name == viewName, null);

            if (view == null)
            {
                return NotFound("No matching view found");
            }

            Stream? stream = Infrastructure.Assets.PackedResources.Open(JellyfinEnhanced.Instance.GetType().Assembly, view.EmbeddedResourcePath);

            if (stream == null)
            {
                _logger.Warning($"Failed to get resource {view.EmbeddedResourcePath}");
                return NotFound();
            }

            return File(stream, MimeTypes.GetMimeType(view.EmbeddedResourcePath));
        }
    }
}
