using Microsoft.AspNetCore.Mvc;
using System.Text;
using System.Text.Json;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using static Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public partial class JeSeerrController : JeControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly SeerrParentalFilter _parentalFilter;
        private readonly Shared.SpoilerGuard.SpoilerSeerrRedactor _spoilerSeerrRedactor;
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;
        private readonly TmdbResponseCache _tmdbResponseCache;
        private readonly UserDisplayResolver _userDisplayResolver;
        private readonly LibraryItemLookup _libraryItemLookup;
        private readonly SeerrUserLookup _seerrUserLookup;
        private readonly Shared.SpoilerGuard.SpoilerPendingService _spoilerPendingService;

        public JeSeerrController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            UserConfigurationManager userConfigurationManager,
            SeerrParentalFilter parentalFilter,
            Shared.SpoilerGuard.SpoilerSeerrRedactor spoilerSeerrRedactor,
            TmdbResponseCache tmdbResponseCache)
            : base(userManager, logger, userConfigurationManager)
        {
            _httpClientFactory = httpClientFactory;
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _parentalFilter = parentalFilter;
            _spoilerSeerrRedactor = spoilerSeerrRedactor;
            _tmdbResponseCache = tmdbResponseCache;
            _userDisplayResolver = new UserDisplayResolver(userManager);
            _libraryItemLookup = new LibraryItemLookup(libraryManager, logger);
            _seerrUserLookup = new SeerrUserLookup(httpClientFactory, logger, _userDisplayResolver);
            _spoilerPendingService = new Shared.SpoilerGuard.SpoilerPendingService(userConfigurationManager, logger, _userDisplayResolver, _libraryItemLookup);
        }

        private async Task<bool> IsSeerrReachableCached()
        {
            var cached = TryGetCachedSeerrReachability();
            if (cached.HasValue)
            {
                return cached.Value;
            }

            bool active = await ProbeJellyseerrStatusAsync();
            lock (_seerrStatusCacheLock)
            {
                _seerrStatusCache = (active, DateTime.UtcNow);
            }
            return active;
        }

        /// <summary>Adds the request's discover filters to a Seerr path (see <see cref="Services.DiscoverFilters"/>).</summary>
        private string AppendDiscoverFilters(string basePath)
        {
            return Services.DiscoverFilters.AppendToSeerrPath(basePath, ReadQueryValue);
        }

        /// <summary>The request's query value for <paramref name="name"/>, or null when it has none.</summary>
        private string? ReadQueryValue(string name)
        {
            return Request.Query.TryGetValue(name, out var value) ? value.ToString() : null;
        }

        private static bool IsCacheableApiPath(string apiPath, HttpMethod method)
        {
            if (method != HttpMethod.Get) return false;

            // /discover/watchlist is mutable per-user state. Caching
            // it for 10 min would mean: user adds movie → next watchlist GET
            // still returns the old payload until TTL expires. /api/v1/issue
            // is also mutable (status changes on assignment / resolution).
            // tightened to /api/v1/issue prefix to avoid
            // accidentally matching future endpoints with "issue" in the name.
            if (apiPath.Contains("/discover/watchlist", StringComparison.OrdinalIgnoreCase)) return false;
            if (apiPath.StartsWith("/api/v1/issue", StringComparison.OrdinalIgnoreCase)) return false;

            // include /search/keyword (typeahead spam) and item-detail
            // endpoints (movie/tv/season — fetched repeatedly by more-info-modal).
            return apiPath.Contains("/discover/") ||
                   apiPath.Contains("/genre") ||
                   apiPath.Contains("/similar") ||
                   apiPath.Contains("/recommendations") ||
                   apiPath.Contains("/person/") ||
                   apiPath.Contains("/collection/") ||
                   apiPath.Contains("/keyword") ||
                   apiPath.Contains("/search") ||
                   apiPath.StartsWith("/api/v1/movie/", StringComparison.OrdinalIgnoreCase) ||
                   apiPath.StartsWith("/api/v1/tv/", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsPublicScopeApiPath(string apiPath)
        {
            // Genre slider, network/studio/keyword discovery — pure TMDB
            // metadata, identical across users.
            if (apiPath.Contains("/discover/genreslider/", StringComparison.OrdinalIgnoreCase)) return true;
            // Query-string-form discovery (the shape JE actually emits).
            // Discovery responses include media.requests/requestedBy etc.
            // BUT the proxy uses X-Api-User header to filter requestedBy
            // server-side, so the body is per-user — except for very simple
            // shapes (no requestedBy filter, no language). Keep these
            // per-user to be safe; only the truly content-only TMDB sliders
            // and direct genre/keyword/person lookups are shared.
            if (apiPath.StartsWith("/api/v1/genres/", StringComparison.OrdinalIgnoreCase)) return true;
            if (apiPath.StartsWith("/api/v1/person/", StringComparison.OrdinalIgnoreCase)) return true;
            if (apiPath.StartsWith("/api/v1/keyword", StringComparison.OrdinalIgnoreCase)) return true;
            // For discover/movies?genre=X and discover/tv?genre=X paths
            // (query-string discovery), the response includes mediaInfo
            // for items the user has watched. Keep per-user.
            // Per-user response includes mediaInfo.requestedBy filtered to
            // the calling user's perspective and 4K availability based on
            // user permission, so KEEP per-user for movie/{id}, tv/{id},
            // collection/{id}, similar/recommendations, search, and
            // /discover/* with any filter.
            return false;
        }

        private static void EvictMovieTvCacheForRequest(string body)
        {
            if (string.IsNullOrEmpty(body)) return;
            try
            {
                using var doc = JsonDocument.Parse(body);
                if (!doc.RootElement.TryGetProperty("mediaId", out var mediaIdEl)) return;
                if (!doc.RootElement.TryGetProperty("mediaType", out var mediaTypeEl)) return;
                var mediaId = mediaIdEl.GetInt32();
                var mediaType = mediaTypeEl.GetString();
                if (mediaType != "movie" && mediaType != "tv") return;
                // The cache key shape is `{userId}:{apiPath}`. We want to match
                // EITHER the bare detail (apiPath ends with `/api/v1/movie/12`)
                // OR a sub-path (apiPath starts with `/api/v1/movie/12/` —
                // for `/similar`, `/recommendations`, `/season/1`, etc).
                var bareSuffix = $":/api/v1/{mediaType}/{mediaId}";
                var subPathInfix = $":/api/v1/{mediaType}/{mediaId}/";
                lock (_responseCacheLock)
                {
                    var keys = _responseCache.Keys
                        .Where(k =>
                            k.EndsWith(bareSuffix, StringComparison.Ordinal)
                            || k.Contains(subPathInfix, StringComparison.Ordinal))
                        .ToList();
                    foreach (var k in keys) _responseCache.Remove(k);
                }
            }
            catch { /* best-effort eviction */ }
        }

        /// <summary>
        /// Runs the caller's parental-rating limit over a proxied Seerr body:
        /// list responses come back filtered, blocked detail/sub-resource
        /// responses become 403. Unrestricted users pass through untouched.
        /// </summary>
        private async Task<IActionResult> ApplyParentalFilterAsync(string json, string apiPath, string jellyfinUserId)
        {
            try
            {
                var result = await _parentalFilter.ApplyAsync(json, apiPath, jellyfinUserId, HttpContext.RequestAborted);
                if (result.Block) return ParentalBlockedResult();
                if (result.RetryLater)
                {
                    // Titles on this page are still being verified (the lookups keep
                    // running server-side): a retryable status makes the client
                    // re-fetch the page instead of showing the unverified rows as gone.
                    Response.Headers["Retry-After"] = "2";
                    return StatusCode(504, new { error = true, code = "parental_pending", message = "Parental rating lookups for this page are still running; retry shortly." });
                }
                // After the parental filter, which reads what this removes, and on the way
                // out of the shared response cache, so one user's guards never reach another.
                return Content(_spoilerSeerrRedactor.RedactSeerr(result.Body, apiPath, jellyfinUserId, HttpContext), "application/json");
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away (also reachable from the response-cache path)
            }
        }

        private async Task<bool> IsRequestBodyParentalBlockedAsync(string body, string jellyfinUserId)
        {
            // Unrestricted users: nothing to check, whatever the body looks like.
            if (!_parentalFilter.TryGetRestrictedPolicy(jellyfinUserId, out _)) return false;

            // Restricted users: a body we cannot identify as an allowed movie/tv
            // title is refused (fail closed), including string ids like "550".
            try
            {
                using var doc = JsonDocument.Parse(body);
                var rootEl = doc.RootElement;
                if (rootEl.ValueKind != JsonValueKind.Object || !rootEl.TryGetProperty("mediaId", out var idEl)) return true;
                int mediaId;
                if (idEl.ValueKind == JsonValueKind.Number)
                {
                    if (!idEl.TryGetInt32(out mediaId)) return true;
                }
                else if (idEl.ValueKind != JsonValueKind.String || !int.TryParse(idEl.GetString(), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out mediaId))
                {
                    return true;
                }
                var mediaType = rootEl.TryGetProperty("mediaType", out var mtEl) && mtEl.ValueKind == JsonValueKind.String ? mtEl.GetString() : null;
                if (mediaType != "movie" && mediaType != "tv") return true;
                return mediaId <= 0 || await _parentalFilter.IsBlockedAsync(mediaType, mediaId, jellyfinUserId);
            }
            catch (JsonException)
            {
                return true;
            }
        }

        // Seerr permissions that allow choosing server, quality profile and root folder on a request (ADMIN implies all).
        private const JellyseerrPermission AdvancedRequestPermissions =
            JellyseerrPermission.ADMIN | JellyseerrPermission.REQUEST_ADVANCED | JellyseerrPermission.MANAGE_REQUESTS;

        private static readonly string[] AdvancedRequestFields = { "serverId", "profileId", "rootFolder", "languageProfileId", "tags" };

        /// <summary>
        /// Removes the advanced options (server, profile, root folder, language profile, tags) from a request body.
        /// Returns the body unchanged when it is not a JSON object.
        /// </summary>
        private static string StripAdvancedRequestOptions(string content)
        {
            try
            {
                if (System.Text.Json.Nodes.JsonNode.Parse(content) is not System.Text.Json.Nodes.JsonObject body)
                {
                    return content;
                }

                foreach (var field in AdvancedRequestFields)
                {
                    body.Remove(field);
                }

                return body.ToJsonString();
            }
            catch (JsonException)
            {
                return content;
            }
        }

        private async Task<IActionResult> ProxyJellyseerrRequest(string apiPath, HttpMethod method, string? content = null)
        {
            // Propagate client disconnects (superseded search queries, page
            // navigations) to the upstream Seerr/TMDB call so we stop doing
            // work nobody will read. Only GETs are cancellable: POSTs (requests,
            // issues) must run to completion even if the browser goes away.
            var ct = method == HttpMethod.Get ? HttpContext.RequestAborted : CancellationToken.None;

            // Writes are not idempotent: every failed write says whether it may have
            // been applied (docs/rewrite/seerr-proxy-outcomes.md), and once one has been
            // handed to the network it is never retried or failed over to another URL.
            var isWrite = method != HttpMethod.Get;
            Shared.Seerr.SeerrRequestOutcome? notSent = isWrite ? Shared.Seerr.SeerrRequestOutcome.NotSent : null;

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("Seerr integration is not configured or enabled.");
                return isWrite
                    ? StatusCode(503, Shared.Seerr.SeerrProxyErrorResponse.Create("not_configured", "Seerr integration is not configured or enabled.", notSent))
                    : StatusCode(503, "Seerr integration is not configured or enabled.");
            }

            // Resolve user ID from authenticated principal (not caller-controlled headers)
            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
            {
                _logger.Warning("Could not resolve Jellyfin user ID from the authenticated principal.");
                return Forbid();
            }

            // resolve the Seerr user ONCE up-front and reuse for
            // both ID-extraction and the non-admin permission check below.
            // Previously made TWO calls (and TWO Seerr round-trips when
            // JellyseerrDisableCache=true), doubling load on debugging admins.
            var seerrUser = await _seerrUserLookup.GetJellyseerrUser(jellyfinUserId);
            var jellyseerrUserId = seerrUser?.Id.ToString();
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.Warning($"Could not find a Jellyseerr user for Jellyfin user {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)}. Aborting request.");
                // When GetJellyseerrUserId returns null because every Seerr URL
                // is returning a Cloudflare/proxy HTML challenge, the generic
                // "user not linked" message misleads the admin. Do one quick
                // reachability probe so the frontend gets a structured reason
                // it can render in a banner, matching /jellyseerr/user-status.
                // The probe is cached so a Seerr outage doesn't fan out N
                // status probes from the negative-user-cache window.
                bool reachable = await IsSeerrReachableCached();

                if (!reachable)
                {
                    // Admins get a pointer to the JE log (which carries the
                    // full code=Cloudflare5xx status=. cf-ray=. line);
                    // non-admins get plain copy.
                    var unreachableMsg = IsAdminUser()
                        ? "Can't reach Seerr. Check the JE log for cf-ray / Content-Type / status details."
                        : "Can't reach Seerr right now. Please try again in a moment.";
                    return StatusCode(502, Shared.Seerr.SeerrProxyErrorResponse.Create("unreachable", unreachableMsg, notSent));
                }
                if (Shared.Seerr.SeerrUserLookup.IsJellyseerrImportBlocked(jellyfinUserId, JellyfinEnhanced.Instance?.Configuration ?? new Configuration.PluginConfiguration()))
                {
                    return StatusCode(403, Shared.Seerr.SeerrProxyErrorResponse.Create("blocked", "Your administrator has disabled Seerr for your account.", notSent));
                }
                return NotFound(Shared.Seerr.SeerrProxyErrorResponse.Create("unlinked", "Current Jellyfin user is not linked to a Jellyseerr user.", notSent));
            }

            // Enforce Seerr permissions for write operations and sensitive reads.
            // Jellyfin admins bypass all permission checks (they can do anything in Seerr).
            // For non-admins, validate before proxying so we return a clear 403 rather than
            // letting Seerr reject the request with a generic error.
            if (!IsAdminUser())
            {
                // reuse the Seerr user we already resolved at
                // line ~647 — no second GetJellyseerrUser call.
                if (seerrUser != null)
                {
                    var perms = seerrUser.Permissions;
                    bool isSeerrAdmin = JellyseerrPermissionHelper.HasPermission(perms, JellyseerrPermission.ADMIN);

                    if (!isSeerrAdmin)
                    {
                        // POST /api/v1/request — make a request
                        if (method == HttpMethod.Post && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase))
                        {
                            if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                                JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV))
                                return StatusCode(403, Shared.Seerr.SeerrProxyErrorResponse.Create("no_request_permission", "You do not have permission to make requests in Seerr.", notSent, error: false));

                            if (content != null && !JellyseerrPermissionHelper.HasAnyPermission(perms, AdvancedRequestPermissions))
                                content = StripAdvancedRequestOptions(content);
                        }

                        // POST /api/v1/issue — report an issue
                        if (method == HttpMethod.Post && apiPath.StartsWith("/api/v1/issue", StringComparison.OrdinalIgnoreCase))
                        {
                            if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                                JellyseerrPermission.CREATE_ISSUES | JellyseerrPermission.MANAGE_ISSUES))
                                return StatusCode(403, Shared.Seerr.SeerrProxyErrorResponse.Create("no_issue_permission", "You do not have permission to report issues in Seerr.", notSent, error: false));
                        }

                        // GET /api/v1/issue — view issues list (any of: ?query, exact, /id)
                        // The /api/v1/issue/{id} path was previously not gated by this
                        // check.— non-admin without VIEW_ISSUES could
                        // fetch any issue by id by guessing.
                        if (method == HttpMethod.Get && (apiPath.StartsWith("/api/v1/issue?", StringComparison.OrdinalIgnoreCase)
                            || apiPath.StartsWith("/api/v1/issue/", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(apiPath, "/api/v1/issue", StringComparison.OrdinalIgnoreCase)))
                        {
                            if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                                JellyseerrPermission.VIEW_ISSUES | JellyseerrPermission.MANAGE_ISSUES))
                                return StatusCode(403, new { code = "no_issue_view_permission", message = "You do not have permission to view issues in Seerr." });
                        }

                        // GET /api/v1/service/sonarr|radarr, /api/v1/service/{type}/{id},
                        // /api/v1/overrideRule, Seerr does not gate this route
                        // behind REQUEST_ADVANCED, so require just the ability to request.
                        if (method == HttpMethod.Get && (
                            apiPath.StartsWith("/api/v1/service/", StringComparison.OrdinalIgnoreCase)
                            || apiPath.StartsWith("/api/v1/overrideRule", StringComparison.OrdinalIgnoreCase)))
                        {
                            if (!JellyseerrPermissionHelper.HasAnyPermission(perms,
                                JellyseerrPermission.REQUEST | JellyseerrPermission.REQUEST_MOVIE | JellyseerrPermission.REQUEST_TV
                                | JellyseerrPermission.REQUEST_ADVANCED | JellyseerrPermission.MANAGE_REQUESTS))
                                return StatusCode(403, new { code = "no_request_permission", message = "You do not have permission to make requests in Seerr." });
                        }
                    }
                }
            }

            // Only Seerr admins may read the override rules (Permission.ADMIN in Seerr 3.x and
            // Jellyseerr 2.x), and Seerr applies them itself when a request is created. The proxy
            // acts as the linked Seerr user, so anyone else has none to read here, not Seerr's 403.
            if (method == HttpMethod.Get && string.Equals(apiPath, "/api/v1/overrideRule", StringComparison.OrdinalIgnoreCase)
                && seerrUser != null && !JellyseerrPermissionHelper.HasPermission(seerrUser.Permissions, JellyseerrPermission.ADMIN))
            {
                return Content("[]", "application/json");
            }

            // Check server-side response cache for cacheable endpoints.
            // bifurcate cache key. Public discovery
            // endpoints return identical content for all users, so include the
            // user-id in the key only for endpoints whose response actually
            // varies per-user (mediaInfo.requests, watchlist, partial-requests
            // setting, requested-by-me filters, etc).
            bool isCacheable = IsCacheableApiPath(apiPath, method) && !config.JellyseerrDisableCache;
            bool isPublicScope = IsPublicScopeApiPath(apiPath);
            var cacheKey = isPublicScope
                ? $"public:{apiPath}"
                : $"{jellyfinUserId}:{apiPath}";
            // Parental ratings (#581): a restricted user may not request a title
            // above their limit, whichever surface the request came from.
            if (method == HttpMethod.Post
                && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase)
                && content != null
                && await IsRequestBodyParentalBlockedAsync(content, jellyfinUserId))
            {
                return StatusCode(403, Shared.Seerr.SeerrProxyErrorResponse.Create("parental_block", "This title is above your parental rating limit.", notSent));
            }

            if (isCacheable)
            {
                string? cachedContent = null;
                lock (_responseCacheLock)
                {
                    if (_responseCache.TryGetValue(cacheKey, out var cached) &&
                        DateTime.UtcNow - cached.CachedAt < GetResponseCacheTtl())
                    {
                        cachedContent = cached.Content;
                    }
                }
                if (cachedContent != null)
                {
                    return await ApplyParentalFilterAsync(cachedContent, apiPath, jellyfinUserId);
                }
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            int lastStatusCode = 502;
            object lastErrorBody = new { error = true, code = "unreachable", message = "Can't reach Seerr right now. Please try again in a moment." };
            // Every write failure that falls through the loop was provably not sent:
            // anything sent returns from inside the loop.
            if (isWrite)
            {
                lastErrorBody = Shared.Seerr.SeerrProxyErrorResponse.Create("unreachable", "Can't reach Seerr right now. Please try again in a moment.", notSent);
            }

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                var requestUri = $"{trimmedUrl.TrimEnd('/')}{apiPath}";
                // High-frequency endpoints that don't need a per-call INFO line.
                // also covers /search/keyword (typeahead) and item-
                // detail endpoints (movie/tv/season) which more-info-modal hits
                // repeatedly.
                bool isQuietEndpoint = apiPath.Contains("/similar")
                    || apiPath.Contains("/recommendations")
                    || apiPath.Contains("/discover/")
                    || apiPath.Contains("/search")
                    || apiPath.Contains("/genre")
                    || apiPath.Contains("/keyword")
                    || apiPath.StartsWith("/api/v1/movie/", StringComparison.OrdinalIgnoreCase)
                    || apiPath.StartsWith("/api/v1/tv/", StringComparison.OrdinalIgnoreCase)
                    || apiPath.StartsWith("/api/v1/person/", StringComparison.OrdinalIgnoreCase);
                bool isIssuePolling = apiPath.Contains("/issue?");

                if (!isQuietEndpoint)
                {
                    var userDisplay = _userDisplayResolver.ResolveUserDisplay(jellyfinUserId);
                    if (isIssuePolling)
                        LogPollingRequest(userDisplay, requestUri, $"{jellyfinUserId}:{apiPath}");
                    else
                        _logger.Info($"Proxying Seerr request for user {userDisplay} to: {requestUri}");
                }

                // Set immediately before the write is handed to HttpClient. From then
                // on the write may reach Seerr, so it ends here whatever happens.
                var writeDispatched = false;
                try
                {
                    string? json = null;
                    Shared.Seerr.SeerrError? error = null;
                    var upstreamStatus = 0;
                    // Seerr answers 5xx when its own TMDB call fails, which happens in
                    // bursts (a cold page fires several TMDB calls at once) and clears
                    // within a second. Retry idempotent GETs a couple of times before
                    // reporting the failure, so a page's first load doesn't come up empty.
                    var attempts = method == HttpMethod.Get ? 3 : 1;
                    for (var attempt = 1; attempt <= attempts; attempt++)
                    {
                        using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                            method, requestUri, config.JellyseerrApiKey, jellyseerrUserId, content);
                        if (content != null && attempt == 1) _logger.Debug($"Request body: {content}");

                        writeDispatched = isWrite;
                        using var response = await httpClient.SendAsync(request, ct);
                        upstreamStatus = (int)response.StatusCode;
                        (json, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri, ct);
                        var transient = error != null && error.HttpStatus >= 500 && error.HttpStatus <= 599
                            && error.Code != Shared.Seerr.SeerrErrorCode.HtmlResponse
                            && error.Code != Shared.Seerr.SeerrErrorCode.Cloudflare5xx;
                        if (!transient || attempt == attempts) break;
                        _logger.Debug($"Seerr returned {error!.HttpStatus} for {apiPath}; retrying ({attempt}/{attempts - 1})");
                        await Task.Delay(TimeSpan.FromMilliseconds(400 * attempt), ct);
                    }

                    // A 2xx that is not a complete JSON document cannot confirm the write
                    // (truncated, empty or garbled), so it is reported as unknown below.
                    if (isWrite && error == null && json != null && !Shared.Seerr.SeerrRequestOutcomes.IsUsableWriteResponse(json))
                    {
                        error = new Shared.Seerr.SeerrError
                        {
                            Code = Shared.Seerr.SeerrErrorCode.ParseError,
                            HttpStatus = upstreamStatus,
                            Url = requestUri,
                            Message = $"Seerr answered {upstreamStatus} from {requestUri} with a body that is not valid JSON; the write may have been applied.",
                            UserMessage = "Got an unexpected response from Seerr. Please try again in a moment."
                        };
                        json = null;
                    }

                    if (error == null && json != null)
                    {
                        // Cache only verified-JSON 2xx responses. The Content-Type
                        // guard inside ReadResponseAsync prevents HTML challenge
                        // pages from being cached as JSON for 10 min.
                        if (isCacheable)
                        {
                            lock (_responseCacheLock)
                            {
                                _responseCache[cacheKey] = (json, DateTime.UtcNow);

                                if (_responseCache.Count > 200 || _responseCache.Count % 50 == 0)
                                {
                                    var staleKeys = _responseCache
                                        .Where(kv => DateTime.UtcNow - kv.Value.CachedAt > GetResponseCacheTtl())
                                        .Select(kv => kv.Key)
                                        .ToList();
                                    foreach (var key in staleKeys)
                                        _responseCache.Remove(key);
                                }
                            }
                        }
                        // a successful POST /api/v1/request changes
                        // mediaInfo.requests on the corresponding /movie/{id}
                        // or /tv/{id} response. Evict cached detail entries
                        // for that media so the next modal open shows fresh
                        // state ("Pending" instead of "Request").
                        if (method == HttpMethod.Post
                            && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase)
                            && content != null)
                        {
                            EvictMovieTvCacheForRequest(content);
                        }
                        return method == HttpMethod.Get
                            ? await ApplyParentalFilterAsync(json, apiPath, jellyfinUserId)
                            : Content(json, "application/json");
                    }

                    _logger.Warning($"Seerr request failed for user {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)} at {trimmedUrl}: code={error!.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");

                    // Map structured error → HTTP status + structured envelope.
                    // The frontend can switch on `code` to display a meaningful
                    // banner instead of "discovery silently disappeared".
                    lastStatusCode = error.Code switch
                    {
                        Shared.Seerr.SeerrErrorCode.HtmlResponse => 502,
                        Shared.Seerr.SeerrErrorCode.UpstreamRedirect => 502,
                        Shared.Seerr.SeerrErrorCode.Cloudflare5xx => 502,
                        Shared.Seerr.SeerrErrorCode.ParseError => 502,
                        Shared.Seerr.SeerrErrorCode.Unauthorized => 401,
                        Shared.Seerr.SeerrErrorCode.Forbidden => 403,
                        _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                    };

                    if (isWrite)
                    {
                        // Seerr (or something in front of it) answered this write: report
                        // that answer; another URL would be a second, independent write.
                        var outcome = Shared.Seerr.SeerrRequestOutcomes.ForUpstreamError(error);
                        return SeerrWriteFailure(lastStatusCode, error.ToProxyErrorResponse(IsAdminUser(), outcome), apiPath, content, trimmedUrl);
                    }

                    // admins keep the upstream URL in the response;
                    // non-admins get a sanitised version that strips it.
                    lastErrorBody = IsAdminUser() ? error.ToAdminResponseShape() : error.ToResponseShape();
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    // The browser aborted the request (superseded search, page
                    // navigation). Not an upstream failure: don't log as error,
                    // don't cache, don't fail over to the next Seerr URL.
                    // 499 = "client closed request"; nobody is listening anyway.
                    // A timeout-caused OperationCanceledException (ct not
                    // cancelled) falls through to the generic handler below.
                    return StatusCode(499);
                }
                catch (Exception ex)
                {
                    _logger.Error($"Failed to connect to Seerr URL for user {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)}: {trimmedUrl}. Error: {ex.Message}");
                    var message = IsAdminUser()
                        ? $"Failed to reach {trimmedUrl}: {ex.Message}"
                        : "Can't reach Seerr right now. Please try again in a moment.";
                    if (!isWrite)
                    {
                        lastErrorBody = new { error = true, code = "unreachable", message };
                        continue;
                    }

                    // A refused connect or failed DNS lookup proves nothing reached this
                    // URL, so the next one may still be tried. Anything else (timeout,
                    // reset, a response cut short) may have been applied.
                    if (writeDispatched && !Shared.Seerr.SeerrRequestOutcomes.IsProvablyUnsent(ex))
                    {
                        return SeerrWriteFailure(502, Shared.Seerr.SeerrProxyErrorResponse.Create("unreachable", message, Shared.Seerr.SeerrRequestOutcome.Unknown), apiPath, content, trimmedUrl);
                    }

                    lastErrorBody = Shared.Seerr.SeerrProxyErrorResponse.Create("unreachable", message, notSent);
                }
            }

            return StatusCode(lastStatusCode, lastErrorBody);
        }

        /// <summary>
        /// Ends a write that was handed to a Seerr URL without a usable success. Never
        /// retried or failed over: the body says whether it may have been applied.
        /// An unknown request outcome also evicts the title's cached details, so the
        /// browser's follow-up status read sees what Seerr actually holds.
        /// </summary>
        /// <param name="status">The proxy HTTP status.</param>
        /// <param name="body">The failure envelope, with its request outcome set.</param>
        /// <param name="apiPath">The Seerr API path written to.</param>
        /// <param name="content">The forwarded request body.</param>
        /// <param name="url">The configured Seerr base URL the write went to (log only).</param>
        /// <returns>The failure result.</returns>
        private ObjectResult SeerrWriteFailure(int status, Shared.Seerr.SeerrProxyErrorResponse body, string apiPath, string? content, string url)
        {
            var outcome = body.RequestOutcome ?? Shared.Seerr.SeerrRequestOutcome.Unknown;
            _logger.Warning($"Seerr write {apiPath} at {url} ended with outcome={outcome.ToWireValue()} status={status}; not retried on another URL.");
            if (outcome == Shared.Seerr.SeerrRequestOutcome.Unknown
                && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase)
                && content != null)
            {
                EvictMovieTvCacheForRequest(content);
            }
            return StatusCode(status, body);
        }

        // Dedup tracker for high-frequency polling log lines.
        // Key = (userId, apiPath), Value = (last logged message, count since last log, last log time)
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (string LastMsg, int Count, DateTime LastLogged)>
            _pollLogDedup = new();
        private static readonly TimeSpan _pollLogInterval = TimeSpan.FromMinutes(5);

        /// <summary>
        /// Logs a high-frequency polling request, consolidating repeated identical calls into a
        /// single summary line every <see cref="_pollLogInterval"/> rather than one line per poll.
        /// </summary>
        private void LogPollingRequest(string userDisplay, string requestUri, string dedupKey)
        {
            var now = DateTime.UtcNow;
            _pollLogDedup.AddOrUpdate(
                dedupKey,
                _ =>
                {
                    // First occurrence — log immediately
                    _logger.Info($"Proxying Seerr request for user {userDisplay} to: {requestUri}");
                    return (requestUri, 0, now);
                },
                (_, existing) =>
                {
                    var newCount = existing.Count + 1;
                    if (now - existing.LastLogged >= _pollLogInterval)
                    {
                        // Enough time has passed — emit a consolidated summary
                        _logger.Info($"Proxying Seerr request for user {userDisplay} to: {requestUri} (repeated {newCount}x in last {_pollLogInterval.TotalMinutes:0}m)");
                        return (requestUri, 0, now);
                    }
                    // Still within the quiet window — suppress
                    return (existing.LastMsg, newCount, existing.LastLogged);
                });
        }
    }
}
