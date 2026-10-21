using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Newtonsoft.Json.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Common.Plugins;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JellyfinEnhancedController : ControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly IUserManager _userManager;
        private readonly Services.SeerrParentalFilter _parentalFilter;
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IDtoService _dtoService;
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly IItemRepository _itemRepository;
        private readonly IDbContextFactory<JellyfinDbContext> _dbContextFactory;
        private readonly Services.TagCacheService _tagCacheService;
        private readonly MediaBrowser.Controller.Session.ISessionManager _sessionManager;
        private readonly Services.MaintenanceModeService _maintenanceModeService;
        private readonly Services.CdnAssetService _cdnAssetService;
        private readonly Services.SpoilerUserResolver _spoilerResolver;
        private readonly Services.SpoilerTagDataStripper _spoilerTagDataStripper;
        private readonly Services.WikidataAwardsService _wikidataAwardsService;
        private readonly Services.MdblistService _mdblistService;
        private readonly Services.DoesTheDogDieService _doesTheDogDieService;
        private readonly Services.WhatsNewService _whatsNewService;
        private readonly Services.UsageEventCounterService _usageEventCounterService;
        private readonly Services.AnalyticsReportingService _analyticsReportingService;
        private readonly Services.HostCompatibilityService _hostCompatibility;
        private readonly Services.TmdbResponseCache _tmdbResponseCache;
        private readonly Services.ItemStatsService _itemStats;
        private readonly IServerConfigurationManager _serverConfigurationManager;
        private readonly INetworkManager _networkManager;
        private readonly Services.SpoilerExistingTitlesApplier _spoilerExistingApplier;
        private readonly MediaBrowser.Model.Tasks.ITaskManager _taskManager;
        private readonly IPluginManager _pluginManager;
        private readonly Services.SpoilerPresentation? _presentation;

        // Server-side cache for proxied avatar images to avoid re-fetching from
        // upstream Seerr on every request. Entries expire after 1 hour.
        private static readonly ConcurrentDictionary<string, (byte[] Content, string ContentType, string ETag, DateTime CachedAt)> _avatarCache = new();
        private static readonly TimeSpan _avatarCacheDuration = TimeSpan.FromHours(1);

        // Cache for Seerr user ID lookups (JellyfinUserId -> SeerrUserId)
        private static readonly Dictionary<string, (string JellyseerrUserId, DateTime CachedAt)> _userIdCache = new();
        private static readonly object _userIdCacheLock = new();

        // Cache for Seerr user lookups (JellyfinUserId -> full Seerr user payload, null = negative cache)
        private static readonly Dictionary<string, (JellyseerrUser? User, DateTime CachedAt)> _userCache = new();
        private static readonly object _userCacheLock = new();
        private static long _userCacheGeneration;

        // Cache for Seerr proxy responses (discovery/search endpoints)
        private static readonly Dictionary<string, (string Content, DateTime CachedAt)> _responseCache = new();
        private static readonly object _responseCacheLock = new();

        // Moves on every drop of the Seerr response and TMDB enrichment caches (a settings save, a request that changes a
        // title), before the drop and under the cache's lock: a read that began under an older value isn't stored.
        private static long _seerrResponseGeneration;

        // Throttle for manual user import
        private static DateTime _lastManualImport = DateTime.MinValue;
        private static readonly object _importThrottleLock = new();

        // cache the result of /api/v1/status probes so a Seerr outage
        // doesn't cause every failed proxy call to issue a fresh status check.
        // Negative-cached for 30s; positive results expire on the same TTL.
        private static (bool Active, DateTime CachedAt)? _seerrStatusCache;
        private static readonly object _seerrStatusCacheLock = new();
        private static readonly TimeSpan _seerrStatusCacheTtl = TimeSpan.FromSeconds(30);

        private async Task<bool> IsSeerrReachableCached()
        {
            var cached = TryGetCachedSeerrReachability();
            if (cached.HasValue)
            {
                return cached.Value;
            }

            // Taken before the probe: a settings save while it runs (another Seerr) doesn't keep its answer, and the answer
            // lives from the probe's start.
            var generation = Interlocked.Read(ref _seerrResponseGeneration);
            var probedAt = DateTime.UtcNow;
            bool active = await ProbeJellyseerrStatusAsync();
            lock (_seerrStatusCacheLock)
            {
                if (generation == Interlocked.Read(ref _seerrResponseGeneration)) _seerrStatusCache = (active, probedAt);
            }
            return active;
        }

        /// <summary>
        /// The answer <see cref="IsSeerrReachableCached"/> would give right now if it
        /// can be given from the probe cache alone; null when a probe would be needed.
        /// </summary>
        private static bool? TryGetCachedSeerrReachability()
        {
            lock (_seerrStatusCacheLock)
            {
                if (_seerrStatusCache.HasValue
                    && DateTime.UtcNow - _seerrStatusCache.Value.CachedAt < _seerrStatusCacheTtl)
                {
                    return _seerrStatusCache.Value.Active;
                }
            }

            return null;
        }

        // Cache for request-page TMDB enrichments (movie/tv detail lookups via Jellyseerr)
        private static readonly Dictionary<string, (TmdbEnrichmentResult Data, DateTime CachedAt)> _tmdbEnrichmentCache = new();
        private static readonly object _tmdbEnrichmentCacheLock = new();
        private static readonly ConcurrentDictionary<string, Task<TmdbEnrichmentResult>> _tmdbEnrichmentInFlight = new();

        private static TimeSpan GetResponseCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        private static TimeSpan GetUserIdCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrUserIdCacheTtlMinutes ?? 30;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        private static TimeSpan GetTmdbEnrichmentCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        private sealed class TmdbEnrichmentResult
        {
            public string? Title { get; init; }
            public int? Year { get; init; }
            public string? PosterUrl { get; init; }
            public string? DigitalReleaseDate { get; init; }
            public string? TheatricalReleaseDate { get; init; }
            public string? InitialAirDate { get; init; }
            public string? NextAirDate { get; init; }
        }

        private static readonly HashSet<string> BrandingFileNames = new(new[]
        {
            "icon-transparent.png",
            "banner-light.png",
            "banner-dark.png",
            "favicon.ico",
            "apple-touch-icon.png"
        }, StringComparer.OrdinalIgnoreCase);

        private readonly Services.Arr.ArrClientFactory? _arrClientFactory;
        private readonly Services.Arr.ArrStateStore? _arrState;
        private readonly Services.Arr.Live.IArrFeedAudience? _feedAudience;
        private readonly Services.Acquire.ArrInstanceLibraries? _instanceLibraries;
        private readonly Services.Acquire.TitleAliases? _titleAliases;

        // The server's Jellyfin view: the one availability rule's facts (the calendar's Available and Play).
        private readonly Services.Acquire.IArrJellyfinView? _arrView;

        public JellyfinEnhancedController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            IDtoService dtoService,
            UserConfigurationManager userConfigurationManager,
            IItemRepository itemRepository,
            IDbContextFactory<JellyfinDbContext> dbContextFactory,
            Services.TagCacheService tagCacheService,
            MediaBrowser.Controller.Session.ISessionManager sessionManager,
            Services.MaintenanceModeService maintenanceModeService,
            Services.CdnAssetService cdnAssetService,
            Services.SpoilerUserResolver spoilerResolver,
            Services.SpoilerTagDataStripper spoilerTagDataStripper,
            Services.WikidataAwardsService wikidataAwardsService,
            Services.MdblistService mdblistService,
            Services.DoesTheDogDieService doesTheDogDieService,
            Services.SeerrParentalFilter parentalFilter,
            Services.WhatsNewService whatsNewService,
            Services.UsageEventCounterService usageEventCounterService,
            Services.AnalyticsReportingService analyticsReportingService,
            Services.HostCompatibilityService hostCompatibility,
            Services.TmdbResponseCache tmdbResponseCache,
            Services.ItemStatsService itemStats,
            IServerConfigurationManager serverConfigurationManager,
            INetworkManager networkManager,
            Services.SpoilerExistingTitlesApplier spoilerExistingApplier,
            MediaBrowser.Model.Tasks.ITaskManager taskManager,
            IPluginManager pluginManager,
            Services.Arr.ArrClientFactory arrClientFactory,
            Services.Arr.ArrStateStore arrState,
            Services.Arr.Live.IArrFeedAudience feedAudience,
            Services.Acquire.ArrInstanceLibraries instanceLibraries,
            Services.Acquire.TitleAliases titleAliases,
            Services.Acquire.IArrJellyfinView arrView, Services.SpoilerPresentation? presentation = null)
        {
            _presentation = presentation;
            _arrView = arrView;
            _instanceLibraries = instanceLibraries;
            _titleAliases = titleAliases ?? (arrState != null ? new Services.Acquire.TitleAliases(arrState, null) : null);
            _arrClientFactory = arrClientFactory;
            _arrState = arrState;
            _feedAudience = feedAudience;
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _dtoService = dtoService;
            _userConfigurationManager = userConfigurationManager;
            _itemRepository = itemRepository;
            _dbContextFactory = dbContextFactory;
            _tagCacheService = tagCacheService;
            _sessionManager = sessionManager;
            _maintenanceModeService = maintenanceModeService;
            _cdnAssetService = cdnAssetService;
            _spoilerResolver = spoilerResolver;
            _spoilerTagDataStripper = spoilerTagDataStripper;
            _wikidataAwardsService = wikidataAwardsService;
            _mdblistService = mdblistService;
            _doesTheDogDieService = doesTheDogDieService;
            _parentalFilter = parentalFilter;
            _whatsNewService = whatsNewService;
            _usageEventCounterService = usageEventCounterService;
            _analyticsReportingService = analyticsReportingService;
            _hostCompatibility = hostCompatibility;
            _tmdbResponseCache = tmdbResponseCache;
            _itemStats = itemStats;
            _serverConfigurationManager = serverConfigurationManager;
            _networkManager = networkManager;
            _spoilerExistingApplier = spoilerExistingApplier;
            _taskManager = taskManager;
            _pluginManager = pluginManager;
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

        private async Task<JellyseerrUser?> GetJellyseerrUser(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
            => (await GetJellyseerrUserRead(jellyfinUserId, bypassCache, allowAutoImport)).User;

        // The Seerr user and when the read that found them began (a held answer's own read): a cache that keeps something
        // worked out from it (the account id) ends when this read does, never later.
        private async Task<(JellyseerrUser? User, DateTime ReadAt)> GetJellyseerrUserRead(string jellyfinUserId, bool bypassCache = false, bool allowAutoImport = true)
        {
            // Taken before anything is read: the generation fences a store after a clear, the instant starts the lifetime.
            var generation = Interlocked.Read(ref _userCacheGeneration);
            var readAt = DateTime.UtcNow;
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                _logger.Warning("Seerr configuration is missing. Cannot look up user ID.");
                return (null, readAt);
            }

            // Skip blocked users entirely — no lookup, no import, no API calls
            if (IsJellyseerrImportBlocked(jellyfinUserId, config))
            {
                return (null, readAt);
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
                            return (cached.User, cached.CachedAt);
                        }
                    }
                }
            }

            // _logger.Info($"Attempting to find Seerr user for Jellyfin User ID: {jellyfinUserId}");
            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/user?take=1000"; // Fetch all users to find a match
                try
                {
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.GetJellyseerrApiKey());
                    using var response = await httpClient.SendAsync(request);
                    var (json, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

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
                                    if (generation == Interlocked.Read(ref _userCacheGeneration))
                                        _userCache[jellyfinUserId] = (user, readAt);
                                }
                            }
                            return (user, readAt);
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
                _logger.Info($"User not found in Jellyseerr. Attempting just-in-time import for Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)}...");
                var (importedUser, definite) = await TryAutoImportJellyseerrUser(jellyfinUserId, urls, httpClient);
                importDefinite = definite;
                if (importedUser != null)
                {
                    if (cacheEnabled)
                    {
                        lock (_userCacheLock)
                        {
                            if (generation == Interlocked.Read(ref _userCacheGeneration))
                                _userCache[jellyfinUserId] = (importedUser, readAt);
                        }
                    }

                    return (importedUser, readAt);
                }
            }

            // Only negative-cache when the import gave a definite "not importable" answer.
            // Transient failures (network errors, exceptions) should not be cached so the
            // next request can retry immediately.
            if (cacheEnabled && importDefinite)
            {
                lock (_userCacheLock)
                {
                    if (generation == Interlocked.Read(ref _userCacheGeneration))
                        _userCache[jellyfinUserId] = (null, readAt);
                }
            }

            _logger.Warning($"Could not find or import a matching Seerr user for Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)} after checking all URLs.");
            return (null, readAt);
        }

        private async Task<(JellyseerrUser? User, bool Definite)> TryAutoImportJellyseerrUser(string jellyfinUserId, string[] urls, HttpClient httpClient)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var apiKey = config?.GetJellyseerrApiKey() ?? string.Empty;

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

                    using var importRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Post, importUri, apiKey, bodyJson: requestBody);
                    using var importResponse = await httpClient.SendAsync(importRequest);
                    reachedJellyseerr = true;
                    var (importJson, importError) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(importResponse, importUri);

                    if (importError != null)
                    {
                        // Email collision is a definite failure — a renamed/deleted Jellyfin user left
                        // an orphaned Jellyseerr account with the same email. Won't resolve on retry.
                        if (!string.IsNullOrEmpty(importError.Message)
                            && importError.Message.Contains("UNIQUE constraint failed: user.email", StringComparison.OrdinalIgnoreCase))
                        {
                            _logger.Warning($"Could not auto-import Jellyfin User ID {ResolveUserDisplay(jellyfinUserId)}: an existing Jellyseerr account has a conflicting email (possibly from a previous user that was renamed or deleted). Remove the conflicting user in Jellyseerr to resolve this.");
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
                        _logger.Info($"Auto-imported Seerr user ID {user.Id} for Jellyfin User {ResolveUserDisplay(jellyfinUserId)}");
                        return (user, true);
                    }

                    // Some Jellyseerr versions return an empty array even on success (user already existed
                    // but wasn't in the import response). Fall back to a full user list query to find them.
                    _logger.Info($"Import succeeded at {url.Trim()} but user not in response. Doing fresh lookup...");
                    var lookupUri = $"{url.Trim().TrimEnd('/')}/api/v1/user?take=1000";
                    using var lookupRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, lookupUri, apiKey);
                    using var lookupResponse = await httpClient.SendAsync(lookupRequest);
                    var (lookupJson, lookupError) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(lookupResponse, lookupUri);
                    if (lookupError == null && lookupJson != null)
                    {
                        var lookupRoot = JsonSerializer.Deserialize<JsonElement>(lookupJson);
                        if (lookupRoot.TryGetProperty("results", out var usersArray))
                        {
                            var allUsers = JsonSerializer.Deserialize<List<JellyseerrUser>>(usersArray.ToString());
                            var found = allUsers?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, normalizedUserId, StringComparison.OrdinalIgnoreCase));
                            if (found != null)
                            {
                                _logger.Info($"Found Seerr user ID {found.Id} for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} via fresh lookup");
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
                    _logger.Debug($"Connection error during auto-import for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} at {url}: {ex.Message}");
                }
                catch (JsonException ex)
                {
                    // Invalid Jellyseerr response — log warning but try next URL
                    _logger.Warning($"Invalid response from Jellyseerr during auto-import for Jellyfin User {ResolveUserDisplay(jellyfinUserId)} at {url}: {ex.Message}");
                }
            }

            // Definite only if we actually got an HTTP response from at least one URL.
            // If all URLs failed with exceptions (network down), this is transient and should not be cached.
            return (null, reachedJellyseerr);
        }

        private static bool IsJellyseerrImportBlocked(string jellyfinUserId, Configuration.PluginConfiguration config)
        {
            var blockedIds = Helpers.Jellyseerr.JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
            if (blockedIds.Count == 0)
            {
                return false;
            }

            var normalizedId = jellyfinUserId.Replace("-", "");
            return blockedIds.Contains(normalizedId);
        }

        /// <summary>Clears Seerr user lookups and fences cache writes from reads already running.</summary>
        internal static void ClearUserCaches()
        {
            lock (_userCacheLock)
            {
                Interlocked.Increment(ref _userCacheGeneration);
                _userCache.Clear();
            }

            lock (_userIdCacheLock)
            {
                _userIdCache.Clear();
            }
        }

        /// <summary>
        /// Seerr was just read and links <paramref name="seerrUserId"/> (null: no account) to the person: a lookup this
        /// proxy holds for them that names another account ends now, and lookups running now aren't kept (the generation
        /// moves), so the proxy never acts in Seerr as an account that is no longer the person's for the rest of its own
        /// lifetime.
        /// </summary>
        /// <param name="jellyfinUserId">The person.</param>
        /// <param name="seerrUserId">Their Seerr account as just read.</param>
        internal static void ForgetSeerrAccountOtherThan(Guid jellyfinUserId, int? seerrUserId)
        {
            var person = jellyfinUserId.ToString("N");
            static bool Same(string key, string person) => string.Equals(key.Replace("-", string.Empty), person, StringComparison.OrdinalIgnoreCase);
            var id = seerrUserId?.ToString(System.Globalization.CultureInfo.InvariantCulture);
            lock (_userCacheLock)
            {
                var stale = _userCache.Where(e => Same(e.Key, person) && e.Value.User?.Id.ToString(System.Globalization.CultureInfo.InvariantCulture) != id).Select(e => e.Key).ToList();
                if (stale.Count > 0)
                {
                    Interlocked.Increment(ref _userCacheGeneration);
                    foreach (var key in stale) _userCache.Remove(key);
                }
            }

            lock (_userIdCacheLock)
            {
                var stale = _userIdCache.Where(e => Same(e.Key, person) && e.Value.JellyseerrUserId != id).Select(e => e.Key).ToList();
                if (stale.Count > 0)
                {
                    Interlocked.Increment(ref _userCacheGeneration);
                    foreach (var key in stale) _userIdCache.Remove(key);
                }
            }
        }

        /// <summary>Clears Seerr answers and user lookups when its settings are saved.</summary>
        public static void ClearAllSeerrCachesOnConfigChange()
        {
            ClearUserCaches();
            SeerrAskedProofCache.Shared.Clear();
            lock (_responseCacheLock)
            {
                Interlocked.Increment(ref _seerrResponseGeneration);
                _responseCache.Clear();
            }
            lock (_tmdbEnrichmentCacheLock)
            {
                Interlocked.Increment(ref _seerrResponseGeneration);
                _tmdbEnrichmentCache.Clear();
            }
            // Avatar cache may reference the OLD Seerr URL — clear it too.
            _avatarCache.Clear();
            // also flush the cached status probe so admins see fresh
            // reachability immediately after fixing config (a probe running now is fenced by the generation above).
            lock (_seerrStatusCacheLock) { _seerrStatusCache = null; }
            // Arr queue/history/calendar/links come from ArrStateStore, which starts over by itself
            // for an instance whose URL or key changed (its client is rebuilt).
        }

        /// <summary>
        /// The Seerr user id for a Jellyfin user when it is in the user-id cache
        /// (unexpired, cache not disabled, user not import-blocked), without contacting Seerr; null otherwise.
        /// </summary>
        private static string? TryGetCachedJellyseerrUserId(string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config != null && (config.JellyseerrDisableCache || IsJellyseerrImportBlocked(jellyfinUserId, config)))
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

        private async Task<string?> GetJellyseerrUserId(string jellyfinUserId)
        {
            // Taken before anything is read (a clear after it fences the store below).
            var generation = Interlocked.Read(ref _userCacheGeneration);
            var config = JellyfinEnhanced.Instance?.Configuration;
            bool cacheEnabled = config == null || !config.JellyseerrDisableCache;

            // Check cache first (unless disabled)
            var cachedId = TryGetCachedJellyseerrUserId(jellyfinUserId);
            if (cachedId != null)
            {
                return cachedId;
            }

            // The id lives from the read of the user it came from (a held one may be nearly as old as its own limit).
            var (user, readAt) = await GetJellyseerrUserRead(jellyfinUserId);
            var jellyseerrUserId = user?.Id.ToString();

            if (!string.IsNullOrEmpty(jellyseerrUserId) && cacheEnabled)
            {
                lock (_userIdCacheLock)
                {
                    if (generation == Interlocked.Read(ref _userCacheGeneration))
                        _userIdCache[jellyfinUserId] = (jellyseerrUserId, readAt);
                }
            }

            return jellyseerrUserId;
        }

        // Seerr's discover API accepts these params (verified live against
        // Seerr 3.2.0). The correct names are `keywords`, `watchProviders`,
        // `watchRegion` — no `with*` prefix; Seerr rejects `withCompanies`
        // / `withNetworks` / `withOriginalLanguage` as `Unknown query parameter`.
        // `studio` and `network` are accepted on /discover/movies and
        // /discover/tv respectively (handled via path routes).
        private static readonly string[] DiscoverFilterParams = {
            "sortBy", "primaryReleaseDateGte", "primaryReleaseDateLte",
            "firstAirDateGte", "firstAirDateLte",
            "voteAverageGte", "voteAverageLte",
            "withRuntimeGte", "withRuntimeLte",
            "certification", "watchRegion", "language",
            "keywords", "watchProviders"
        };

        private string AppendDiscoverFilters(string basePath)
        {
            var sb = new StringBuilder(basePath);
            foreach (var param in DiscoverFilterParams)
            {
                if (Request.Query.TryGetValue(param, out var value) && !string.IsNullOrEmpty(value))
                {
                    sb.Append($"&{param}={Uri.EscapeDataString(value!)}");
                }
            }
            return sb.ToString();
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
                    Interlocked.Increment(ref _seerrResponseGeneration);
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

        private IActionResult ParentalBlockedResult()
        {
            return StatusCode(403, new
            {
                error = true,
                code = "parental_block",
                message = "This title is above your parental rating limit."
            });
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
                var surface = apiPath.Contains("/search", StringComparison.OrdinalIgnoreCase) ? "search"
                    : apiPath.Contains("/similar", StringComparison.OrdinalIgnoreCase) || apiPath.Contains("/recommendations", StringComparison.OrdinalIgnoreCase) ? "recommendations"
                    : apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase) ? "requests" : "discovery";
                var kind = apiPath.StartsWith("/api/v1/movie/", StringComparison.OrdinalIgnoreCase) || apiPath.Contains("/discover/movies", StringComparison.OrdinalIgnoreCase) ? "movie"
                    : apiPath.StartsWith("/api/v1/tv/", StringComparison.OrdinalIgnoreCase) || apiPath.Contains("/discover/tv", StringComparison.OrdinalIgnoreCase) ? "tv" : null;
                // Both raw-cache hits and misses reach this caller boundary.
                var projected = Services.TitleFeedProjection.Hidden(result.Body,
                    Services.HiddenContentPolicy.Load(_userConfigurationManager, Guid.Parse(jellyfinUserId), HttpContext, _libraryManager), surface, kind, Services.ProviderPresentationSchema.ProviderResource(apiPath));
                Response.Headers["Cache-Control"] = "private, no-store";
                var segments = apiPath.Split('?', 2)[0].Split('/', StringSplitOptions.RemoveEmptyEntries);
                var title = segments.Length >= 4 && segments[2] is "movie" or "tv"
                    ? Services.HiddenContentPolicy.OwningTitle(segments[2], segments[3]) : null;
                var seasonIndex = Array.IndexOf(segments, "season");
                var seasonNumber = seasonIndex >= 0 && seasonIndex + 1 < segments.Length && int.TryParse(segments[seasonIndex + 1], out var seasonValue) ? seasonValue : 0;
                projected = _presentation?.Load(Guid.Parse(jellyfinUserId), HttpContext).ProjectResource(projected, title, Services.ProviderPresentationSchema.ProviderResource(apiPath), kind,
                    scopeKind: seasonIndex >= 0 ? "season" : null, season: seasonNumber) ?? projected;
                return ProjectForCaller(projected);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away (also reachable from the response-cache path)
            }
        }

        /// <summary>Refusal for a Seerr request write after requests moved to Jellyfin Enhanced (no Seerr call is made).</summary>
        private IActionResult RequestsHandledByJe()
            => StatusCode(409, new { error = true, code = "requests_in_je", message = "Requests are handled by Jellyfin Enhanced now." });

        /// <summary>
        /// Lets one Seerr request write through, or refuses it: while requests move from Seerr to Jellyfin
        /// Enhanced (409 <c>migration_busy</c>) and once Jellyfin Enhanced handles requests (409
        /// <c>requests_in_je</c>). The pass is held until the write is done, so a move starts only after the
        /// writes already in flight finished; the handling is read live after entering.
        /// </summary>
        /// <param name="refusal">The refusal to return when no pass is given.</param>
        /// <returns>The pass to dispose when the write is done (null when no fence is registered), or null with a refusal.</returns>
        private IDisposable? EnterSeerrRequestWrite(out IActionResult? refusal)
        {
            refusal = null;
            var fence = HttpContext?.RequestServices?.GetService(typeof(Services.Acquire.Requests.SeerrRequestWriteFence)) as Services.Acquire.Requests.SeerrRequestWriteFence;
            var pass = fence?.TryEnterWrite();
            if (fence != null && pass == null)
            {
                refusal = StatusCode(409, new { error = true, code = "migration_busy", message = "Requests are moving to Jellyfin Enhanced right now; try again in a moment." });
                return null;
            }
            if (Services.Acquire.Requests.SharedRequestFacts.LedgerAuthority(JellyfinEnhanced.Instance?.Configuration))
            {
                pass?.Dispose();
                refusal = RequestsHandledByJe();
                return null;
            }
            return pass;
        }

        /// <summary>
        /// Sends a Seerr body to the caller: its library links kept to what they may open
        /// (<see cref="ProjectLibraryCopiesForCaller"/>), then its download rows projected for them
        /// (<see cref="ProjectDownloadsForCaller"/>). The response cache keeps Seerr's own body.
        /// </summary>
        private IActionResult ProjectForCaller(string body)
        {
            if (!ProjectLibraryCopiesForCaller(body, out var visible))
                return StatusCode(502, new { error = true, code = "invalid_upstream", message = "Seerr sent an answer that couldn't be read." });
            return ProjectDownloadsForCaller(visible);
        }

        /// <summary>
        /// Seerr names the Jellyfin item of every title it knows, whichever library holds it: each named item
        /// is checked against Jellyfin for the caller, so titles from libraries they can't open (or above their
        /// parental limit, or behind a blocked tag) don't reach them with their ids (see
        /// <see cref="Helpers.Jellyseerr.SeerrLibraryAccessProjector"/>). Applies to administrators too (a
        /// restricted administrator account is still restricted); without a caller every named item counts
        /// as hidden.
        /// </summary>
        private bool ProjectLibraryCopiesForCaller(string body, out string projected)
        {
            projected = body;
            if (_libraryManager == null) return true;
            var userId = UserHelper.GetCurrentUserId(User);
            var user = userId is { } id && id != Guid.Empty ? _userManager?.GetUserById(id) : null;
            return Helpers.Jellyseerr.SeerrLibraryAccessProjector.TryProject(
                body,
                item => LibraryCopyFor(item, user),
                (type, tmdb) => user == null ? null : FindLibraryItemByTmdb(user, type, tmdb.ToString(System.Globalization.CultureInfo.InvariantCulture))?.Id,
                out projected);
        }

        /// <summary>A Jellyfin item id Seerr names, or null when the item exists but <paramref name="user"/> can't open it.</summary>
        private string? VisibleJellyfinId(string? id, Jellyfin.Database.Implementations.Entities.User? user)
        {
            if (_libraryManager == null || id == null || !Guid.TryParse(id, out var item) || item == Guid.Empty) return id;
            return LibraryCopyFor(item, user) == Helpers.Jellyseerr.SeerrLibraryCopy.Hidden ? null : id;
        }

        /// <summary>How a Jellyfin item Seerr names looks to <paramref name="user"/> (null: hidden whenever it exists).</summary>
        private Helpers.Jellyseerr.SeerrLibraryCopy LibraryCopyFor(Guid item, Jellyfin.Database.Implementations.Entities.User? user)
        {
            if (user != null && _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(item, user) != null)
                return Helpers.Jellyseerr.SeerrLibraryCopy.Visible;
            return _libraryManager.GetItemById(item) != null
                ? Helpers.Jellyseerr.SeerrLibraryCopy.Hidden
                : Helpers.Jellyseerr.SeerrLibraryCopy.Missing;
        }

        /// <summary>
        /// Sends a Seerr body to the caller: administrators get it as Seerr sent it; everyone else gets the
        /// download rows without release names, download ids or arr ids (status, size, ETA, episode and an
        /// opaque group only). A body that can't be read is not passed on. The response cache keeps Seerr's
        /// own body, so the projection runs per caller on every answer, cached or fresh.
        /// </summary>
        private IActionResult ProjectDownloadsForCaller(string body)
        {
            if (IsAdminUser()) return Content(body, "application/json");
            if (!Helpers.Jellyseerr.SeerrDownloadStatusProjector.TryProject(body, DateTimeOffset.UtcNow, out var projected))
                return StatusCode(502, new { error = true, code = "invalid_upstream", message = "Seerr sent an answer that couldn't be read." });
            return Content(projected, "application/json");
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

        /// <summary>
        /// A read of Seerr's Radarr/Sonarr servers or one server's profiles and folders (<c>/api/v1/service/…</c>), other
        /// than the Sonarr title lookup (<c>/api/v1/service/sonarr/lookup/…</c>) that requests for some series need.
        /// </summary>
        private static bool IsSeerrServiceRead(string apiPath)
            => apiPath.StartsWith("/api/v1/service/", StringComparison.OrdinalIgnoreCase)
               && !apiPath.StartsWith("/api/v1/service/sonarr/lookup/", StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// A request was made, answered or removed through Jellyfin Enhanced: the Requests &amp;
        /// downloads read model of Seerr's requests reads them again in about a second (it is a
        /// no-op while that feature is off).
        /// </summary>
        private void SeerrRequestsChanged()
        {
            try
            {
                (HttpContext?.RequestServices?.GetService(typeof(Services.Acquire.SeerrRequestReadModel)) as Services.Acquire.SeerrRequestReadModel)?.RequestRefresh();
            }
            catch (ObjectDisposedException)
            {
                // Shutting down.
            }
        }

        // Phase 3 uses the ledger edition policy; Jellyfin administrator status alone does not grant Seerr 4K.
        private async Task<bool> LegacyCanRequest4kAsync(Configuration.PluginConfiguration config, bool movie, JellyseerrPermission permissions)
        {
            var bits = JellyseerrPermission.REQUEST_4K | (movie ? JellyseerrPermission.REQUEST_4K_MOVIE : JellyseerrPermission.REQUEST_4K_TV);
            var permission = JellyseerrPermissionHelper.HasPermission(permissions, JellyseerrPermission.ADMIN) || JellyseerrPermissionHelper.HasAnyPermission(permissions, bits);
            if (!permission || !Services.Acquire.Requests.RequestPolicy.EditionEnabled(config, movie)) return false;
            var url = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim();
            if (url == null) return false;
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                var client = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                var uri = url.TrimEnd('/') + "/api/v1/settings/main";
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, uri, config.GetJellyseerrApiKey());
                using var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false);
                var (body, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, uri, timeout.Token).ConfigureAwait(false);
                if (error != null || body == null) return false;
                using var settings = JsonDocument.Parse(body);
                var enabled = settings.RootElement.TryGetProperty(movie ? "movie4kEnabled" : "series4kEnabled", out var value) && value.ValueKind == JsonValueKind.True;
                return Services.Acquire.Requests.RequestPolicy.Can4k(JellyfinEnhanced.Instance?.Configuration ?? config, movie, "seerr", false, false, enabled, permission);
            }
            catch (Exception) { return false; }
        }

        // upstreamNotFound: the JSON to answer when Seerr itself answers 404 (never for the proxy's own 404s, e.g. "unlinked").
        private async Task<IActionResult> ProxyJellyseerrRequest(string apiPath, HttpMethod method, string? content = null, string? upstreamNotFound = null)
        {
            if (method == HttpMethod.Get || !apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase))
                return await ProxyJellyseerrRequestCore(apiPath, method, content, upstreamNotFound);
            // After the hand-over to Jellyfin Enhanced (phase 3, JE request handling) JE never writes a request
            // to Seerr again: new asks, approvals and cancels go through JE's own request API. While a move runs
            // the write waits outside (refused); one already running holds the move off until it is done.
            using var write = EnterSeerrRequestWrite(out var refusal);
            if (refusal != null) return refusal;
            return await ProxyJellyseerrRequestCore(apiPath, method, content, upstreamNotFound);
        }

        private async Task<IActionResult> ProxyJellyseerrRequestCore(string apiPath, HttpMethod method, string? content, string? upstreamNotFound)
        {
            // Propagate client disconnects (superseded search queries, page
            // navigations) to the upstream Seerr/TMDB call so we stop doing
            // work nobody will read. Only GETs are cancellable: POSTs (requests,
            // issues) must run to completion even if the browser goes away.
            var ct = method == HttpMethod.Get ? HttpContext.RequestAborted : CancellationToken.None;

            // Taken before the first read (the configuration, the person's Seerr account): a drop while this runs means its
            // answer may come from the configuration before the change; the answer lives from here.
            var responseGeneration = Interlocked.Read(ref _seerrResponseGeneration);
            var requestStart = DateTime.UtcNow;
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                _logger.Warning("Seerr integration is not configured or enabled.");
                return StatusCode(503, "Seerr integration is not configured or enabled.");
            }

            // Resolve user ID from authenticated principal (not caller-controlled headers)
            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
            {
                _logger.Warning("Could not resolve Jellyfin user ID from the authenticated principal.");
                return Forbid();
            }

            // Administrator Seerr request options (phase 4): while that switch is on, choosing a Seerr server,
            // profile or root folder is a Jellyfin administrator's alone, whatever the person's Seerr permissions.
            // Others can't read Seerr's servers (the title lookup some series need stays open: it names no server,
            // profile or folder), and their request bodies are sent without those choices. Switch off: as before.
            var seerrOptionsBoundary = Services.Acquire.Requests.HouseholdFlags.SeerrOptions(config) && !IsAdminUser();
            if (seerrOptionsBoundary && method == HttpMethod.Get && IsSeerrServiceRead(apiPath))
                return StatusCode(403, new { code = "admin_required", message = "Only an administrator can see Seerr's servers." });
            if (seerrOptionsBoundary && method == HttpMethod.Post && content != null && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase))
                content = StripAdvancedRequestOptions(content);

            // resolve the Seerr user ONCE up-front and reuse for
            // both ID-extraction and the non-admin permission check below.
            // Previously made TWO calls (and TWO Seerr round-trips when
            // JellyseerrDisableCache=true), doubling load on debugging admins.
            var seerrUser = await GetJellyseerrUser(jellyfinUserId);
            var jellyseerrUserId = seerrUser?.Id.ToString();
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.Warning($"Could not find a Jellyseerr user for Jellyfin user {ResolveUserDisplay(jellyfinUserId)}. Aborting request.");
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
                    return StatusCode(502, new
                    {
                        error = true,
                        code = "unreachable",
                        message = unreachableMsg
                    });
                }
                if (IsJellyseerrImportBlocked(jellyfinUserId, JellyfinEnhanced.Instance?.Configuration ?? new Configuration.PluginConfiguration()))
                {
                    return StatusCode(403, new
                    {
                        error = true,
                        code = "blocked",
                        message = "Your administrator has disabled Seerr for your account."
                    });
                }
                return NotFound(new
                {
                    error = true,
                    code = "unlinked",
                    message = "Current Jellyfin user is not linked to a Jellyseerr user."
                });
            }

            if (config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled && method == HttpMethod.Post && apiPath == "/api/v1/request" && content != null)
            {
                try
                {
                    using var input = JsonDocument.Parse(content);
                    if (input.RootElement.TryGetProperty("is4k", out var edition) && edition.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                        return BadRequest(Services.Acquire.Requests.RequestOutcome.Refused("invalid_input", 400));
                    if (input.RootElement.TryGetProperty("is4k", out var fourK) && fourK.ValueKind == JsonValueKind.True)
                    {
                        var movie = input.RootElement.TryGetProperty("mediaType", out var type) && type.GetString() == "movie";
                        if (!await LegacyCanRequest4kAsync(config, movie, seerrUser!.Permissions).ConfigureAwait(false))
                            return StatusCode(403, Services.Acquire.Requests.RequestOutcome.Refused("requests_4k_required"));
                    }
                }
                catch (Exception ex) when (ex is JsonException or InvalidOperationException) { return BadRequest(Services.Acquire.Requests.RequestOutcome.Refused("invalid_input", 400)); }
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
                                return StatusCode(403, new { code = "no_request_permission", message = "You do not have permission to make requests in Seerr." });

                            if (content != null && !JellyseerrPermissionHelper.HasAnyPermission(perms, AdvancedRequestPermissions))
                                content = StripAdvancedRequestOptions(content);
                        }

                        // POST /api/v1/issue — report an issue
                        if (method == HttpMethod.Post && apiPath.StartsWith("/api/v1/issue", StringComparison.OrdinalIgnoreCase))
                        {
                            if (!CanReportIssues(false, seerrUser))
                                return StatusCode(403, new { code = "no_issue_permission", message = "You do not have permission to report issues in Seerr." });
                        }

                        // GET /api/v1/issue — view issues list (any of: ?query, exact, /id)
                        // The /api/v1/issue/{id} path was previously not gated by this
                        // check.— non-admin without VIEW_ISSUES could
                        // fetch any issue by id by guessing.
                        if (method == HttpMethod.Get && (apiPath.StartsWith("/api/v1/issue?", StringComparison.OrdinalIgnoreCase)
                            || apiPath.StartsWith("/api/v1/issue/", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(apiPath, "/api/v1/issue", StringComparison.OrdinalIgnoreCase)))
                        {
                            if (!CanViewIssues(false, seerrUser))
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
                return ParentalBlockedResult();
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
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            int lastStatusCode = 502;
            object lastErrorBody = new { error = true, code = "unreachable", message = "Can't reach Seerr right now. Please try again in a moment." };

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
                    var userDisplay = ResolveUserDisplay(jellyfinUserId);
                    if (isIssuePolling)
                        LogPollingRequest(userDisplay, requestUri, $"{jellyfinUserId}:{apiPath}");
                    else
                        _logger.Info($"Proxying Seerr request for user {userDisplay} to: {requestUri}");
                }

                try
                {
                    string? json = null;
                    Helpers.Jellyseerr.SeerrError? error = null;
                    // Seerr answers 5xx when its own TMDB call fails, which happens in
                    // bursts (a cold page fires several TMDB calls at once) and clears
                    // within a second. Retry idempotent GETs a couple of times before
                    // reporting the failure, so a page's first load doesn't come up empty.
                    var attempts = method == HttpMethod.Get ? 3 : 1;
                    for (var attempt = 1; attempt <= attempts; attempt++)
                    {
                        using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            method, requestUri, config.GetJellyseerrApiKey(), jellyseerrUserId, content);
                        if (content != null && attempt == 1) _logger.Debug($"Request body: {content}");

                        using var response = await httpClient.SendAsync(request, ct);
                        (json, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri, ct);
                        var transient = error != null && error.HttpStatus >= 500 && error.HttpStatus <= 599
                            && error.Code != Helpers.Jellyseerr.SeerrErrorCode.HtmlResponse
                            && error.Code != Helpers.Jellyseerr.SeerrErrorCode.Cloudflare5xx;
                        if (!transient || attempt == attempts) break;
                        _logger.Debug($"Seerr returned {error!.HttpStatus} for {apiPath}; retrying ({attempt}/{attempts - 1})");
                        await Task.Delay(TimeSpan.FromMilliseconds(400 * attempt), ct);
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
                                if (responseGeneration == Interlocked.Read(ref _seerrResponseGeneration)) _responseCache[cacheKey] = (json, requestStart);

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
                        if (method != HttpMethod.Get && apiPath.StartsWith("/api/v1/request", StringComparison.OrdinalIgnoreCase))
                        {
                            SeerrRequestsChanged();
                        }
                        return method == HttpMethod.Get
                            ? await ApplyParentalFilterAsync(json, apiPath, jellyfinUserId)
                            : ProjectForCaller(json);
                    }

                    if (upstreamNotFound != null && error is { Code: Helpers.Jellyseerr.SeerrErrorCode.UpstreamError, HttpStatus: 404 })
                        return Content(upstreamNotFound, "application/json");

                    _logger.Warning($"Seerr request failed for user {ResolveUserDisplay(jellyfinUserId)} at {trimmedUrl}: code={error!.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");

                    // Map structured error → HTTP status + structured envelope.
                    // The frontend can switch on `code` to display a meaningful
                    // banner instead of "discovery silently disappeared".
                    lastStatusCode = error.Code switch
                    {
                        Helpers.Jellyseerr.SeerrErrorCode.HtmlResponse => 502,
                        Helpers.Jellyseerr.SeerrErrorCode.UpstreamRedirect => 502,
                        Helpers.Jellyseerr.SeerrErrorCode.Cloudflare5xx => 502,
                        Helpers.Jellyseerr.SeerrErrorCode.Unauthorized => 401,
                        Helpers.Jellyseerr.SeerrErrorCode.Forbidden => 403,
                        _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                    };
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
                    _logger.Error($"Failed to connect to Seerr URL for user {ResolveUserDisplay(jellyfinUserId)}: {trimmedUrl}. Error: {ex.Message}");
                    if (IsAdminUser())
                    {
                        lastErrorBody = new { error = true, code = "unreachable", message = $"Failed to reach {trimmedUrl}: {ex.Message}" };
                    }
                    else
                    {
                        lastErrorBody = new { error = true, code = "unreachable", message = "Can't reach Seerr right now. Please try again in a moment." };
                    }
                }
            }

            return StatusCode(lastStatusCode, lastErrorBody);
        }

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
        private static object SeerrStatusResponse(bool active) => new { active };

        private async Task<bool> ProbeJellyseerrStatusAsync()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.GetJellyseerrApiKey()) || string.IsNullOrEmpty(config.JellyseerrUrls))
            {
                return false;
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(15);

            foreach (var url in urls)
            {
                var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/status";
                try
                {
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.GetJellyseerrApiKey());
                    using var response = await httpClient.SendAsync(request);
                    var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
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

        /// <summary>Tag colour overrides for the Jellyfin Web overlays (empty unless the target includes web).</summary>
        [HttpGet("tag-styles")]
        [Authorize]
        public ActionResult GetTagStyles()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return StatusCode(503);
            var set = config.TagStylesEnabled && config.TagStyleTarget is "web" or "both" ? TagStyleSet.Parse(config.TagStyleOverrides) : TagStyleSet.Empty;
            return new JsonResult(set.ToWebModel());
        }

        /// <summary>The shipped default tag colours the config page's style editor starts from.</summary>
        [HttpGet("tag-styles/catalog")]
        [Authorize]
        public ActionResult GetTagStyleCatalog()
        {
            if (!IsAdminUser()) return Forbid();
            return new JsonResult(new
            {
                quality = TagStyleCatalog.Quality.Select(q => new { label = q.Label, background = q.Background, color = q.Text }),
                age = TagStyleCatalog.AgeGroups.Select(g => new { id = g.Id, background = g.Background, border = g.Border, color = g.Text, ratings = g.Ratings }),
            });
        }

        [HttpGet("jellyseerr/validate")]
        [Authorize]
        public async Task<IActionResult> ValidateJellyseerr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey)
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            // The config page shows saved keys masked; a masked value means "test the saved key"
            // (only against a saved Seerr URL, so the key can't be pointed at another server).
            var submittedKey = apiKey;
            apiKey = ResolveSubmittedSecret(apiKey, nameof(PluginConfiguration.JellyseerrApiKey), url, SavedSeerrUrls());
            if (string.IsNullOrWhiteSpace(apiKey) && Services.Secrets.SecretValue.IsPlaceholder(Services.Secrets.SecretValue.FromWire(submittedKey)) && JellyfinEnhanced.Instance?.Secrets?.IsAvailable == false)
                return StatusCode(503, new { ok = false, code = "SecretsUnavailable", message = "Saved keys can't be read right now (secrets.json is unreadable; see the server log). Type the key to test." });
            if (string.IsNullOrWhiteSpace(apiKey) && Services.Secrets.SecretValue.IsPlaceholder(Services.Secrets.SecretValue.FromWire(submittedKey)))
                return BadRequest(new { ok = false, code = "KeyNotForThisUrl", message = "The saved API key is only used with the saved Seerr URL. Type the key again to test this address." });

            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(10);

            // Use the SeerrHttpHelper so the admin gets the same typed errors
            // (HtmlResponse / Cloudflare5xx / UpstreamRedirect / Unauthorized)
            // as runtime fetches — Round-3 found that the validate path
            // returned a generic "Status check failed" for HTML challenge
            // pages, which is the most-confusing first-setup error.
            var requestUri = $"{url.TrimEnd('/')}/api/v1/user";
            try
            {
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Get, requestUri, apiKey);
                using var resp = await http.SendAsync(request);
                var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(resp, requestUri);
                if (error == null) return Ok(new { ok = true });

                _logger.Warning($"Seerr validate failed for {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                int httpCode = error.Code switch
                {
                    Helpers.Jellyseerr.SeerrErrorCode.HtmlResponse => 502,
                    Helpers.Jellyseerr.SeerrErrorCode.UpstreamRedirect => 502,
                    Helpers.Jellyseerr.SeerrErrorCode.Cloudflare5xx => 502,
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

            var submittedKey = apiKey;
            apiKey = ResolveSubmittedSecret(apiKey, nameof(PluginConfiguration.JellyseerrApiKey), url, SavedSeerrUrls());
            if (string.IsNullOrWhiteSpace(apiKey) && Services.Secrets.SecretValue.IsPlaceholder(Services.Secrets.SecretValue.FromWire(submittedKey)) && JellyfinEnhanced.Instance?.Secrets?.IsAvailable == false)
                return StatusCode(503, new { ok = false, code = "SecretsUnavailable", message = "Saved keys can't be read right now (secrets.json is unreadable; see the server log). Type the key to test." });
            if (string.IsNullOrWhiteSpace(apiKey) && Services.Secrets.SecretValue.IsPlaceholder(Services.Secrets.SecretValue.FromWire(submittedKey)))
                return BadRequest(new { ok = false, code = "KeyNotForThisUrl", message = "The saved API key is only used with the saved Seerr URL. Type the key again to test this address." });

            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(15);

            // route via SeerrHttpHelper so a Cloudflare/forward-auth
            // 200+HTML response no longer falsely reports `ok=true` to admins.
            var requestUri = $"{url.TrimEnd('/')}/api/v1/settings/jobs/jellyfin-recently-added-scan/run";
            try
            {
                using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                    HttpMethod.Post, requestUri, apiKey, bodyJson: "{}");
                using var resp = await http.SendAsync(request);
                var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(resp, requestUri);
                if (error == null)
                {
                    _logger.Info($"[SeerrScan] Manually triggered Seerr recently-added scan via admin button — {url}");
                    return Ok(new { ok = true });
                }

                _logger.Warning($"[SeerrScan] Manual trigger failed for {url}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                int httpCode = error.Code switch
                {
                    Helpers.Jellyseerr.SeerrErrorCode.HtmlResponse => 502,
                    Helpers.Jellyseerr.SeerrErrorCode.UpstreamRedirect => 502,
                    Helpers.Jellyseerr.SeerrErrorCode.Cloudflare5xx => 502,
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
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId!);
            if (!string.IsNullOrEmpty(jellyseerrUserId))
            {
                var seerrUser = await GetJellyseerrUser(jellyfinUserId!);
                return Ok(LinkedSeerrUserStatus(jellyseerrUserId, CanRequestAdvanced(IsAdminUser(), seerrUser), CanViewIssues(IsAdminUser(), seerrUser), CanReportIssues(IsAdminUser(), seerrUser)));
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
        private static object? TryBuildSeerrUserStatusWithoutLookup(Configuration.PluginConfiguration? config, string? jellyfinUserId, bool isAdmin)
        {
            if (config == null || !config.JellyseerrEnabled ||
                string.IsNullOrEmpty(config.GetJellyseerrApiKey()) ||
                string.IsNullOrEmpty(config.JellyseerrUrls))
            {
                return new { active = false, userFound = false, reason = "disabled" };
            }

            if (string.IsNullOrEmpty(jellyfinUserId))
            {
                return new { active = false, userFound = false, reason = "no_user" };
            }

            if (IsJellyseerrImportBlocked(jellyfinUserId, config))
            {
                return new { active = true, userFound = false, reason = "blocked" };
            }

            var cachedId = TryGetCachedJellyseerrUserId(jellyfinUserId);
            if (cachedId == null) return null;

            // canRequestAdvanced and canViewIssues: an admin always may; anyone
            // else needs their Seerr user (permissions), which must already be in
            // the user cache for this answer to need no Seerr round trip.
            if (isAdmin) return LinkedSeerrUserStatus(cachedId, true, true, true);
            return TryGetCachedJellyseerrUser(jellyfinUserId, out var seerrUser)
                ? LinkedSeerrUserStatus(cachedId, CanRequestAdvanced(false, seerrUser), CanViewIssues(false, seerrUser), CanReportIssues(false, seerrUser))
                : null;
        }

        /// <summary>The <c>jellyseerr/user-status</c> answer for a linked user.</summary>
        private static object LinkedSeerrUserStatus(string jellyseerrUserId, bool canRequestAdvanced, bool canViewIssues, bool canReportIssues)
            => new { active = true, userFound = true, jellyseerrUserId = jellyseerrUserId, reason = "linked", canRequestAdvanced, canViewIssues, canReportIssues };

        // D46 action capabilities: reporting and reading issues are independent Seerr permissions.
        /// <summary>The exact write permission used by the issue proxy and its client capability.</summary>
        private static bool CanReportIssues(bool isAdmin, JellyseerrUser? seerrUser)
            => isAdmin || seerrUser == null
                || JellyseerrPermissionHelper.HasPermission(seerrUser.Permissions, JellyseerrPermission.ADMIN)
                || JellyseerrPermissionHelper.HasAnyPermission(seerrUser.Permissions, JellyseerrPermission.CREATE_ISSUES | JellyseerrPermission.MANAGE_ISSUES);

        /// <summary>
        /// Whether the issue list and issues may be read through the Seerr proxy
        /// (its 403 gate): Jellyfin admins always, anyone else with Seerr's
        /// admin, view-issues or manage-issues permission. Without a Seerr user to
        /// judge by, the proxy doesn't refuse (Seerr decides), so neither does this.
        /// Pages read it from <c>jellyseerr/user-status</c> so they don't ask for
        /// an issue list they would be refused.
        /// </summary>
        private static bool CanViewIssues(bool isAdmin, JellyseerrUser? seerrUser)
            => isAdmin || seerrUser == null
                || JellyseerrPermissionHelper.HasPermission(seerrUser.Permissions, JellyseerrPermission.ADMIN)
                || JellyseerrPermissionHelper.HasAnyPermission(seerrUser.Permissions, JellyseerrPermission.VIEW_ISSUES | JellyseerrPermission.MANAGE_ISSUES);

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
                string.IsNullOrEmpty(config.GetJellyseerrApiKey()) ||
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
                var seerrUser = await GetJellyseerrUser(userId, bypassCache: true, allowAutoImport: false);

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
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
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

            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            var requestUri = $"{jellyseerrUrl.TrimEnd('/')}/api/v1/settings/{type}";
            using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.GetJellyseerrApiKey());
            using var response = await httpClient.SendAsync(request);
            var (json, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

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

            // Pass through Seerr's own array shape; the frontend reads the fields
            // it needs (name, hostname, port, useSsl, baseUrl, is4k, id). Each
            // real arr API key is swapped for a short-lived server-side handle:
            // the key never reaches the browser, and saving the imported
            // instance (or testing it) resolves the handle on the server.
            return Content(ReplaceImportedArrKeys(json), "application/json");
        }

        /// <summary>
        /// Replaces every <c>apiKey</c> in Seerr's arr settings array with an import handle from the
        /// secrets store. Anything unparseable becomes an empty array rather than leaking through.
        /// </summary>
        internal static string ReplaceImportedArrKeys(string? json)
        {
            if (string.IsNullOrWhiteSpace(json)) return "[]";
            System.Text.Json.Nodes.JsonNode? root;
            try { root = System.Text.Json.Nodes.JsonNode.Parse(json); }
            catch (System.Text.Json.JsonException) { return "[]"; }
            if (root is not System.Text.Json.Nodes.JsonArray rows) return "[]";
            var store = JellyfinEnhanced.Instance?.Secrets;
            foreach (var row in rows.OfType<System.Text.Json.Nodes.JsonObject>())
            {
                var key = row["apiKey"] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<string>(out var k) ? k : null;
                // Bound to the arr's own address (as the config page rebuilds it), so the handle
                // only works for that server.
                var host = row["hostname"]?.GetValueKind() == System.Text.Json.JsonValueKind.String ? row["hostname"]!.GetValue<string>() : null;
                var port = row["port"]?.GetValueKind() == System.Text.Json.JsonValueKind.Number ? row["port"]!.GetValue<int>() : 0;
                var ssl = row["useSsl"]?.GetValueKind() == System.Text.Json.JsonValueKind.True;
                var boundUrl = string.IsNullOrEmpty(host) || port <= 0 ? null : (ssl ? "https://" : "http://") + host + ":" + port.ToString(System.Globalization.CultureInfo.InvariantCulture);
                row["apiKey"] = string.IsNullOrEmpty(key) || store == null || boundUrl == null ? string.Empty : store.AddPending(key, boundUrl);
            }
            return rows.ToJsonString();
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
                builtFor = Services.HostCompatibilityService.BuiltFor,
                hostTarget = _hostCompatibility.HostTarget,
                hostVersion = _hostCompatibility.HostVersionString,
                pluginVersion = JellyfinEnhanced.Instance?.Version.ToString(),
                mismatch = _hostCompatibility.IsMismatch,
                stale = isStale,
                expectedAsset = _hostCompatibility.ExpectedAssetName,
                manifestUrl = Services.HostCompatibilityService.ManifestUrl,
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
                if (!Services.SpoilerAutoEnableFilter.AllowsType(JellyfinEnhanced.Instance?.Configuration, mediaType == "tv")) return;

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
                var summary = AddSpoilerBlurPendingInternal(userId, jUser, mediaType, canonicalTmdb, displayName: null);
                if (summary.WroteSomething)
                {
                    _logger.Info($"Spoiler Guard auto-on-request {summary.Promoted} for {mediaType}:{canonicalTmdb} by {ResolveUserDisplay(userId.ToString("N"))}");
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
            return ProxyJellyseerrRequest($"/api/v1/request?take={take}&skip={skip}&filter={filter}", HttpMethod.Get);
        }

        // Returns the user's Seerr quota with a nextResetAt added per side.
        [HttpGet("jellyseerr/quota")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrQuota()
        {
            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString() ?? "";
            var seerrUserId = await GetJellyseerrUserId(jellyfinUserId);
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
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
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

                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.GetJellyseerrApiKey(), seerrUserId);
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
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

        [HttpGet("jellyseerr/tv/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetTvShow(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/season/{seasonNumber}")]
        [Authorize]
        public Task<IActionResult> GetTvSeason(int tmdbId, int seasonNumber)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/season/{seasonNumber}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetMovie(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}", HttpMethod.Get);
        }

        /// <summary>
        /// Batched collection lookup for the Seerr search row: the collection each
        /// movie of one rendered batch of results belongs to, in one request
        /// instead of a proxied Seerr movie detail per movie plus a TMDB movie
        /// detail for each one Seerr names no collection for. Same sources, order
        /// and gating as those per-movie calls: the caller's Seerr movie detail
        /// through ProxyJellyseerrRequest (its response cache, Seerr user and
        /// permission checks, parental gate) first; TMDB's movie detail through
        /// TmdbResponseCache, with the passthrough's parental gate, only when
        /// Seerr's detail has no collection and a TMDB key is configured.
        /// ids: comma-separated TMDB movie ids (distinct, max 100).
        /// Response: { "results": { "603": { id, name, posterPath, backdropPath } | null } }
        /// where null means no collection; an id whose lookup failed or was
        /// refused to this caller is left out, so the client asks again later.
        /// </summary>
        [HttpGet("jellyseerr/movie-collections")]
        [Authorize]
        public async Task<IActionResult> GetMovieCollectionsBatch([FromQuery] string? ids)
        {
            // Per-user body (Seerr user, parental gating): never kept by the browser.
            Response.Headers["Cache-Control"] = "no-store";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                return StatusCode(503, "Seerr integration is not configured or enabled.");
            }

            if (!Services.MovieCollectionsBatch.TryParseIds(ids, out var requested, out var idsError))
            {
                return BadRequest(idsError);
            }

            var callerId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(callerId))
            {
                return Forbid();
            }

            var results = new ConcurrentDictionary<int, Services.MovieCollectionsBatch.Collection?>();

            // Resolve the caller's Seerr user once, so the per-movie proxy calls
            // below read it from the cache instead of all looking it up cold at
            // the same time. Without one (unlinked, blocked, Seerr unreachable)
            // every per-movie call fails, so every id stays unknown.
            if (await GetJellyseerrUser(callerId) == null)
            {
                return Content(Services.MovieCollectionsBatch.Serialize(requested, results), "application/json");
            }

            var tmdbKey = config.GetTmdbApiKey();
            // The client's TmdbEnabled flag (GetPublicConfig) gated the TMDB fallback.
            var tmdbEnabled = !string.IsNullOrWhiteSpace(tmdbKey);
            var aborted = HttpContext.RequestAborted;
            // As many Seerr detail calls at once as the client used to make; a cold
            // detail makes Seerr call TMDB, which answers bursts with 5xx.
            using var slots = new SemaphoreSlim(4);
            var failures = 0;
            string? lastError = null;

            async Task LoadAsync(int tmdbId)
            {
                await slots.WaitAsync(aborted).ConfigureAwait(false);
                try
                {
                    // Anything but a readable 200 (refused by the parental gate or
                    // Seerr permissions, upstream failure, cancelled) leaves the id
                    // unknown, as the failed call left it for the client.
                    var seerr = await ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}", HttpMethod.Get).ConfigureAwait(false);
                    if (seerr is not ContentResult { StatusCode: null or 200, Content: { } json }
                        || !Services.MovieCollectionsBatch.TryReadSeerrCollection(json, out var collection))
                    {
                        return;
                    }

                    if (collection != null || !tmdbEnabled)
                    {
                        results[tmdbId] = collection;
                        return;
                    }

                    // The passthrough's gate for "movie/{id}" (TmdbAccess.GateTitle).
                    if (await _parentalFilter.IsBlockedAsync("movie", tmdbId, callerId, aborted).ConfigureAwait(false))
                    {
                        return;
                    }

                    // Same cache entry (path, empty query, bundle) as the
                    // passthrough's GET tmdb/movie/{id}.
                    var response = await _tmdbResponseCache.GetAsync($"movie/{tmdbId}", string.Empty, tmdbKey, aborted, bundle: true).ConfigureAwait(false);
                    if (response.IsSuccess && Services.MovieCollectionsBatch.TryReadTmdbCollection(response.Content, out var tmdbCollection))
                    {
                        results[tmdbId] = tmdbCollection;
                    }
                }
                catch (OperationCanceledException) when (aborted.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or InvalidOperationException)
                {
                    // TMDB failures as GetWatchProvidersBatch sees them; logged once
                    // per batch below. Seerr failures are logged by the proxy.
                    Interlocked.Increment(ref failures);
                    lastError = ex.Message;
                }
                finally
                {
                    slots.Release();
                }
            }

            try
            {
                await Task.WhenAll(requested.Select(LoadAsync)).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (aborted.IsCancellationRequested)
            {
                return StatusCode(499);
            }

            if (aborted.IsCancellationRequested)
            {
                return StatusCode(499); // the proxy calls answered 499 instead of throwing
            }

            if (failures > 0)
            {
                _logger.Warning($"Movie collections batch: {failures} of {requested.Count} TMDB lookups failed ({lastError}).");
            }

            return Content(Services.MovieCollectionsBatch.Serialize(requested, results), "application/json");
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/similar")]
        [Authorize]
        public Task<IActionResult> GetSimilarMovies(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/similar?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/recommendations")]
        [Authorize]
        public Task<IActionResult> GetRecommendedMovies(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/recommendations?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}/ratingscombined")]
        [Authorize]
        public Task<IActionResult> GetMovieRatingsCombined(int tmdbId)
        {
            // Seerr answers 404 for a movie nobody rates yet (an unreleased one): no ratings, as for series below.
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/ratingscombined", HttpMethod.Get, upstreamNotFound: "null");
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/similar")]
        [Authorize]
        public Task<IActionResult> GetSimilarTvShows(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/similar?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/recommendations")]
        [Authorize]
        public Task<IActionResult> GetRecommendedTvShows(int tmdbId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/recommendations?page={page}", HttpMethod.Get);
        }

        /// <summary>A series' Rotten Tomatoes ratings; <c>null</c> when it has none.</summary>
        /// <param name="tmdbId">TMDB id.</param>
        /// <returns>The ratings, null, or the proxy's error.</returns>
        [HttpGet("jellyseerr/tv/{tmdbId}/ratings")]
        [Authorize]
        public Task<IActionResult> GetTvRatingsCombined(int tmdbId)
        {
            // Seerr answers 404 when Rotten Tomatoes doesn't know a series: no ratings, which is an answer
            // (the page would otherwise log a failed request for every such series). The proxy's own 404
            // (a viewer without a Seerr account) stays as it is.
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/ratings", HttpMethod.Get, upstreamNotFound: "null");
        }

        [HttpGet("jellyseerr/discover/tv/network/{networkId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByNetwork(int networkId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&network={networkId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/studio/{studioId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByStudio(int studioId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&studio={studioId}"), HttpMethod.Get);
        }

        /// <summary>
        /// Series produced by a TMDB company (studio) — the TV half of a
        /// studio feed. Seerr's /discover/tv filters by network only, so this
        /// asks TMDB's discover/tv?with_companies directly (through the shared
        /// TMDB response cache) and answers in Seerr's discover shape; see
        /// TmdbCompanyTvDiscover for what the rows carry. Same per-user
        /// parental gate as the Seerr-proxied discover feeds.
        /// </summary>
        [HttpGet("jellyseerr/discover/tv/studio/{studioId}")]
        [Authorize]
        public async Task<IActionResult> DiscoverTvByStudio(int studioId, [FromQuery] int page = 1, [FromQuery] string? sortBy = null)
        {
            // Per-user body (library ids, parental filtering): never kept by the browser.
            Response.Headers["Cache-Control"] = "no-store";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled)
            {
                return StatusCode(503, "Seerr integration is not configured or enabled.");
            }
            if (string.IsNullOrEmpty(config.GetTmdbApiKey()))
            {
                return StatusCode(503, "TMDB API key is not configured.");
            }
            if (studioId <= 0 || page < 1 || page > 500)
            {
                return BadRequest(new { error = true, code = "invalid_parameters", message = "studioId must be positive and page between 1 and 500." });
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null)
            {
                return Forbid();
            }

            var query = $"?with_companies={studioId}&page={page}";
            if (Services.TmdbCompanyTvDiscover.IsValidSort(sortBy))
            {
                query += $"&sort_by={sortBy}";
            }

            try
            {
                var response = await _tmdbResponseCache.GetAsync("discover/tv", query, config.GetTmdbApiKey(), HttpContext.RequestAborted);
                if (!response.IsSuccess)
                {
                    _logger.Warning($"TMDB discover/tv for company {studioId} (page {page}) returned {response.StatusCode}.");
                    return StatusCode(502, new { error = true, code = "tmdb_error", message = "TMDB did not answer the series-by-studio lookup." });
                }

                // One indexed provider-id lookup per row, scoped to what this user
                // may see, so in-library series link into Jellyfin and honour the
                // exclude-library-items setting like the Seerr-fed cards do. Those
                // rows (usually few) take Seerr's own mediaInfo, the same detail
                // call the More Info modal makes, so a partly available series
                // keeps "Request missing" instead of reading as fully available.
                var jUser = _userManager.GetUserById(userId.Value);
                var mediaInfo = new Dictionary<int, string>();
                if (jUser != null)
                {
                    var inLibrary = new List<(int TmdbId, Guid ItemId)>();
                    foreach (var tmdbId in Services.TmdbCompanyTvDiscover.ReadRowIds(response.Content))
                    {
                        var item = FindLibraryItemByTmdb(jUser, "tv", tmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture));
                        if (item != null) inLibrary.Add((tmdbId, item.Id));
                    }
                    var seerrInfo = await Task.WhenAll(inLibrary.Select(row => GetSeerrTvMediaInfoAsync(row.TmdbId)));
                    for (var i = 0; i < inLibrary.Count; i++)
                    {
                        mediaInfo[inLibrary[i].TmdbId] = seerrInfo[i] ?? Services.TmdbCompanyTvDiscover.LibraryMediaInfo(inLibrary[i].ItemId);
                    }
                }
                var body = Services.TmdbCompanyTvDiscover.ToSeerrShape(response.Content, mediaInfo);

                return await ApplyParentalFilterAsync(body, $"/api/v1/discover/tv?studio={studioId}&page={page}", userId.Value.ToString());
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch series for company {studioId} from TMDB. Error: {ex.Message}");
                return StatusCode(502, new { error = true, code = "tmdb_error", message = "Failed to connect to TMDB." });
            }
        }

        /// <summary>
        /// Seerr's mediaInfo for a series, read through the caller's proxied
        /// /api/v1/tv/{id} (same response cache and parental gate as the More
        /// Info modal). Null when Seerr has no record of it or does not answer.
        /// </summary>
        private async Task<string?> GetSeerrTvMediaInfoAsync(int tmdbId)
        {
            var result = await ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}", HttpMethod.Get);
            return result is ContentResult { StatusCode: null or 200, Content: { } json }
                ? Services.TmdbCompanyTvDiscover.ExtractMediaInfo(json)
                : null;
        }

        [HttpGet("jellyseerr/discover/trending")]
        [Authorize]
        public Task<IActionResult> DiscoverTrending([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/trending?page={page}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies")]
        [Authorize]
        public Task<IActionResult> DiscoverMovies([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv")]
        [Authorize]
        public Task<IActionResult> DiscoverTv([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/upcoming")]
        [Authorize]
        public Task<IActionResult> DiscoverUpcomingMovies([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies/upcoming?page={page}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/upcoming")]
        [Authorize]
        public Task<IActionResult> DiscoverUpcomingTv([FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv/upcoming?page={page}"), HttpMethod.Get);
        }

        [HttpGet("studio/{studioId}")]
        [Authorize]
        public IActionResult GetStudioInfo(Guid studioId)
        {
            try
            {
                var studio = _libraryManager.GetItemById(studioId);
                if (studio == null)
                {
                    return NotFound(new { message = "Studio not found" });
                }

                // Get TMDB ID from provider IDs if available
                string? tmdbId = null;
                if (studio.ProviderIds != null && studio.ProviderIds.TryGetValue("Tmdb", out var id))
                {
                    tmdbId = id;
                }

                return Ok(new
                {
                    id = studio.Id,
                    name = studio.Name,
                    tmdbId = tmdbId,
                    type = studio.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get studio info for {studioId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get studio info" });
            }
        }

        [HttpGet("boxset/{boxsetId}")]
        [Authorize]
        public IActionResult GetBoxSetInfo(Guid boxsetId)
        {
            try
            {
                var boxset = _libraryManager.GetItemById(boxsetId);
                if (boxset == null || boxset.GetType().Name != "BoxSet")
                {
                    return NotFound(new { message = "BoxSet not found" });
                }

                // Get TMDB collection ID from provider IDs
                string? tmdbId = null;
                if (boxset.ProviderIds != null && boxset.ProviderIds.TryGetValue("Tmdb", out var id))
                {
                    tmdbId = id;
                }

                return Ok(new
                {
                    id = boxset.Id,
                    name = boxset.Name,
                    tmdbId = tmdbId,
                    type = boxset.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get boxset info for {boxsetId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get boxset info" });
            }
        }

        [HttpGet("person/{personId}")]
        [Authorize]
        public async Task<IActionResult> GetPersonInfo(Guid personId, [FromQuery] Guid? itemId = null)
        {
            try
            {
                var person = _libraryManager.GetItemById(personId);
                if (person == null)
                {
                    return NotFound(new { message = "Person not found" });
                }

                var itemPremiereDate = ResolveVisibleItemPremiereDate(itemId);
                return Ok(await BuildPersonInfoAsync(person, itemPremiereDate, HttpContext.RequestAborted));
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get person info for {personId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get person info" });
            }
        }

        private const int MaxPeopleInfoBatchSize = 100;
        // Per request; TmdbResponseCache caps the upstream calls in flight
        // across all requests (and multiplexes them over one HTTP/2
        // connection), so a cast row resolves in about one TMDB round trip.
        private const int PeopleInfoTmdbConcurrency = 16;
        // One slow TMDB lookup must not hold a whole cast batch (or a single
        // person request) hostage: past this, fall back to Jellyfin-only data.
        private static readonly TimeSpan PersonTmdbTimeout = TimeSpan.FromSeconds(6);

        /// <summary>
        /// Batch form of <see cref="GetPersonInfo"/> for the People Tags cast
        /// row: one request for every cast card instead of one per actor.
        /// <c>ids</c> is a comma-separated list of person GUIDs (N or D format,
        /// malformed entries ignored, duplicates collapsed, at most
        /// <see cref="MaxPeopleInfoBatchSize"/> distinct ids). Returns
        /// <c>{ people: { "&lt;personId N&gt;": { ...same shape as person/{id}... } } }</c>;
        /// ids that are not Person entities are omitted.
        /// </summary>
        [HttpGet("people/info")]
        [Authorize]
        public async Task<IActionResult> GetPeopleInfo([FromQuery] string? ids, [FromQuery] Guid? itemId = null)
        {
            var personIds = new HashSet<Guid>();
            var parsedIds = (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(raw => Guid.TryParse(raw, out var parsed) ? parsed : Guid.Empty)
                .Where(parsed => parsed != Guid.Empty);
            foreach (var parsed in parsedIds)
            {
                personIds.Add(parsed);
                if (personIds.Count > MaxPeopleInfoBatchSize)
                {
                    return BadRequest(new { message = $"At most {MaxPeopleInfoBatchSize} person ids per request." });
                }
            }

            if (personIds.Count == 0)
            {
                return BadRequest(new { message = "No valid person ids supplied." });
            }

            var ct = HttpContext.RequestAborted;
            try
            {
                var people = _libraryManager.GetItemList(new InternalItemsQuery
                {
                    ItemIds = personIds.ToArray(),
                    IncludeItemTypes = new[] { BaseItemKind.Person }
                })
                    .OfType<MediaBrowser.Controller.Entities.Person>()
                    .GroupBy(p => p.Id)
                    .Select(g => g.First())
                    .ToList();

                // Resolved once for the whole batch rather than per person.
                var itemPremiereDate = ResolveVisibleItemPremiereDate(itemId);

                using var tmdbGate = new SemaphoreSlim(PeopleInfoTmdbConcurrency);
                var tasks = people.Select(async person =>
                {
                    await tmdbGate.WaitAsync(ct).ConfigureAwait(false);
                    try
                    {
                        return (Key: person.Id.ToString("N"), Info: await BuildPersonInfoAsync(person, itemPremiereDate, ct).ConfigureAwait(false));
                    }
                    finally
                    {
                        tmdbGate.Release();
                    }
                }).ToList();

                var results = await Task.WhenAll(tasks).ConfigureAwait(false);
                ct.ThrowIfCancellationRequested();

                var map = new Dictionary<string, object>(results.Length, StringComparer.OrdinalIgnoreCase);
                foreach (var (key, info) in results)
                {
                    map[key] = info;
                }

                return Ok(new { people = map });
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away (navigated off / superseded)
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException or System.Data.Common.DbException)
            {
                // What the library/database layer throws.
                _logger.Error($"Failed to get batch person info ({personIds.Count} ids): {ex.Message}");
                return StatusCode(500, new { message = "Failed to get person info" });
            }
        }

        /// <summary>
        /// PremiereDate of the item used for "age at release", honoured only
        /// when that item is visible to the calling user (library access and
        /// parental rules); otherwise null so no age-at-release is derived.
        /// </summary>
        private DateTime? ResolveVisibleItemPremiereDate(Guid? itemId)
        {
            if (!itemId.HasValue || itemId.Value == Guid.Empty)
            {
                return null;
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId.Value == Guid.Empty)
            {
                return null;
            }

            try
            {
                var user = _userManager.GetUserById(userId.Value);
                if (user == null)
                {
                    return null;
                }

                // The user overload returns null when the item is not visible
                // to this user.
                var item = _libraryManager.GetItemById<BaseItem>(itemId.Value, user);
                return item?.PremiereDate;
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException or System.Data.Common.DbException)
            {
                // What the library/database layer throws.
                _logger.Warning($"Could not resolve item {itemId.Value} for person ages: {ex.GetType().Name}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Shared response object for person/{id} and people/info. The shape
        /// is part of the client contract (peopletags.js, person-discovery.js).
        /// </summary>
        private async Task<object> BuildPersonInfoAsync(BaseItem person, DateTime? itemPremiereDate, CancellationToken cancellationToken)
        {
            // Get TMDB ID from provider IDs if available
            string? tmdbId = null;
            if (person.ProviderIds != null && person.ProviderIds.TryGetValue("Tmdb", out var id))
            {
                tmdbId = id;
            }

            // Get person-specific data
            // Note: PremiereDate on Person items stores birth date, EndDate stores death date
            var birthDate = person.PremiereDate;
            var endDate = person.EndDate;
            var birthPlace = person.ProductionLocations?.FirstOrDefault() ?? null;

            // Try to enrich with TMDB data if available
            if (!string.IsNullOrEmpty(tmdbId) && int.TryParse(tmdbId, out var tmdbPersonId))
            {
                using var tmdbTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                tmdbTimeout.CancelAfter(PersonTmdbTimeout);
                try
                {
                    // _logger.Info($"Fetching TMDB data for person {person.Id} (TMDB ID: {tmdbPersonId})");
                    var tmdbPersonData = await GetTmdbPersonData(tmdbPersonId, tmdbTimeout.Token).ConfigureAwait(false);
                    if (tmdbPersonData != null)
                    {
                        // _logger.Info($"TMDB data received: BirthPlace={tmdbPersonData.BirthPlace}, BirthDate={tmdbPersonData.BirthDate}, DeathDate={tmdbPersonData.DeathDate}");

                        // Use TMDB death date if Jellyfin doesn't have it
                        if (!endDate.HasValue && tmdbPersonData.DeathDate.HasValue)
                        {
                            endDate = tmdbPersonData.DeathDate;
                        }

                        // Use TMDB birth date if Jellyfin doesn't have it
                        if (!birthDate.HasValue && tmdbPersonData.BirthDate.HasValue)
                        {
                            birthDate = tmdbPersonData.BirthDate;
                        }

                        // Always prefer TMDB birthplace
                        if (!string.IsNullOrEmpty(tmdbPersonData.BirthPlace))
                        {
                            birthPlace = tmdbPersonData.BirthPlace;
                            // _logger.Debug($"Using TMDB birthplace: {birthPlace}");
                        }
                    }
                    else
                    {
                        _logger.Warning($"No TMDB data returned for person {person.Id} (TMDB ID: {tmdbPersonId})");
                    }
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && tmdbTimeout.IsCancellationRequested)
                {
                    _logger.Warning($"TMDB lookup for person {person.Id} (TMDB ID: {tmdbPersonId}) exceeded {PersonTmdbTimeout.TotalSeconds:0}s; using Jellyfin data only");
                }
                catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
                {
                    _logger.Warning($"Failed to enrich person {person.Id} with TMDB data: {ex.Message}");
                    // Continue with Jellyfin data only
                }
            }
            else
            {
                // _logger.Debug($"No TMDB ID available for person {person.Id}");
            }

            int? currentAge = null;
            int? ageAtItemRelease = null;
            int? ageAtDeath = null;
            bool isDeceased = endDate.HasValue && endDate.Value < DateTime.Now;

            // Calculate current age or age at death
            if (birthDate.HasValue)
            {
                if (isDeceased)
                {
                    // If deceased, calculate age at death
                    ageAtDeath = CalculateAge(birthDate.Value, endDate!.Value); // isDeceased implies a death date
                }
                else
                {
                    // If alive, calculate current age
                    currentAge = CalculateAge(birthDate.Value, DateTime.Now);
                }

                // Calculate age at item release if a visible item was provided
                if (itemPremiereDate.HasValue)
                {
                    ageAtItemRelease = CalculateAge(birthDate.Value, itemPremiereDate.Value);
                }
            }

            return new
            {
                id = person.Id,
                name = person.Name,
                tmdbId = tmdbId,
                type = person.GetType().Name,
                birthDate = birthDate?.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                deathDate = endDate?.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                birthPlace = birthPlace,
                isDeceased = isDeceased,
                currentAge = currentAge,
                ageAtDeath = ageAtDeath,
                ageAtItemRelease = ageAtItemRelease
            };
        }

        private async Task<TmdbPersonData?> GetTmdbPersonData(int tmdbPersonId, CancellationToken cancellationToken = default)
        {
            try
            {
                // Get TMDB API key from configuration
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || string.IsNullOrEmpty(config.GetTmdbApiKey()))
                {
                    _logger.Warning("TMDB API key not configured in plugin settings");
                    return null;
                }

                // _logger.Debug($"Fetching TMDB person data from: https://api.themoviedb.org/3/person/{tmdbPersonId}");
                var response = await _tmdbResponseCache.GetAsync($"person/{tmdbPersonId}", string.Empty, config.GetTmdbApiKey(), cancellationToken);

                if (!response.IsSuccess)
                {
                    _logger.Warning($"TMDB API request failed with status {(System.Net.HttpStatusCode)response.StatusCode}");
                    return null;
                }

                var content = response.Content;
                var jsonElement = JsonSerializer.Deserialize<JsonElement>(content);

                DateTime? birthDate = null;
                DateTime? deathDate = null;
                string? birthPlace = null;

                // Parse birth date
                if (jsonElement.TryGetProperty("birthday", out var birthdayProp) &&
                    birthdayProp.ValueKind != JsonValueKind.Null &&
                    TryParseIso(birthdayProp.GetString()) is DateTime birth)
                {
                    birthDate = birth;
                }

                // Parse death date
                if (jsonElement.TryGetProperty("deathday", out var deathdayProp) &&
                    deathdayProp.ValueKind != JsonValueKind.Null &&
                    deathdayProp.GetString() is string deathStr &&
                    TryParseIso(deathStr) is DateTime death)
                {
                    deathDate = death;
                }

                // Parse birth place
                if (jsonElement.TryGetProperty("place_of_birth", out var placeProp) &&
                    placeProp.ValueKind != JsonValueKind.Null)
                {
                    birthPlace = placeProp.GetString();
                    if (!string.IsNullOrEmpty(birthPlace))
                    {
                        // _logger.Debug($"Parsed place_of_birth: {birthPlace}");
                    }
                }

                return new TmdbPersonData
                {
                    BirthDate = birthDate,
                    DeathDate = deathDate,
                    BirthPlace = birthPlace
                };
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Browser went away; the shared TMDB call still finishes and is cached.
                throw;
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to get TMDB person data for ID {tmdbPersonId}: {ex.Message}");
                return null;
            }
        }

        private int CalculateAge(DateTime birthDate, DateTime referenceDate)
        {
            int age = referenceDate.Year - birthDate.Year;
            if (referenceDate < birthDate.AddYears(age))
            {
                age--;
            }
            return Math.Max(0, age);
        }

        [HttpGet("genre/{genreId}")]
        [Authorize]
        public IActionResult GetGenreInfo(Guid genreId)
        {
            try
            {
                var genre = _libraryManager.GetItemById(genreId);
                if (genre == null)
                {
                    return NotFound(new { message = "Genre not found" });
                }

                return Ok(new
                {
                    id = genre.Id,
                    name = genre.Name,
                    type = genre.GetType().Name
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get genre info for {genreId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get genre info" });
            }
        }

        [HttpGet("jellyseerr/person/{personId}")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrPerson(int personId)
        {
            // TMDB person id 0 / negative produces a noisy 500 from
            // Seerr. Cheap to reject up-front so admins don't see "code=UpstreamError"
            // for what is really an invalid input.
            if (personId <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_person_id",
                    message = "TMDB person id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/person/{personId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/person/{personId}/combined_credits")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrPersonCredits(int personId)
        {
            if (personId <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_person_id",
                    message = "TMDB person id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/person/{personId}/combined_credits", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&genre={genreId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&genre={genreId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/tv?page={page}&keywords={keywordId}"), HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest(AppendDiscoverFilters($"/api/v1/discover/movies?page={page}&keywords={keywordId}"), HttpMethod.Get);
        }

        [HttpGet("tmdb/search/person")]
        [Authorize]
        public Task<IActionResult> SearchTmdbPerson([FromQuery] string query)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { message = "Query cannot be empty" }));
            }
            return ProxyJellyseerrRequest($"/api/v1/search?query={Uri.EscapeDataString(query)}&page=1", HttpMethod.Get);
        }

        [HttpGet("tmdb/search/keyword")]
        [Authorize]
        public Task<IActionResult> SearchTmdbKeyword([FromQuery] string query)
        {
            if (string.IsNullOrWhiteSpace(query))
            {
                return Task.FromResult<IActionResult>(BadRequest(new { message = "Query cannot be empty" }));
            }
            return ProxyJellyseerrRequest($"/api/v1/search/keyword?query={Uri.EscapeDataString(query)}", HttpMethod.Get);
        }

        [HttpGet("tmdb/genres/movie")]
        [Authorize]
        public Task<IActionResult> GetTmdbMovieGenres()
        {
            return ProxyJellyseerrRequest("/api/v1/genres/movie", HttpMethod.Get);
        }

        [HttpGet("tmdb/genres/tv")]
        [Authorize]
        public Task<IActionResult> GetTmdbTvGenres()
        {
            return ProxyJellyseerrRequest("/api/v1/genres/tv", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/genreslider/movie")]
        [Authorize]
        public Task<IActionResult> GetMovieGenreSlider()
        {
            return ProxyJellyseerrRequest("/api/v1/discover/genreslider/movie", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/genreslider/tv")]
        [Authorize]
        public Task<IActionResult> GetTvGenreSlider()
        {
            return ProxyJellyseerrRequest("/api/v1/discover/genreslider/tv", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/overrideRule")]
        [Authorize]
        public Task<IActionResult> GetOverrideRules()
        {
            return ProxyJellyseerrRequest("/api/v1/overrideRule", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/collection/{collectionId}")]
        [Authorize]
        public Task<IActionResult> GetCollection(int collectionId)
        {
            return ProxyJellyseerrRequest($"/api/v1/collection/{collectionId}", HttpMethod.Get);
        }

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

                if (string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
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
                var blockedIds = Helpers.Jellyseerr.JellyseerrUserImportHelper.GetBlockedUserIds(config.JellyseerrImportBlockedUsers);
                var userIds = _userManager.GetAllUsers()
                    .Select(u => u.Id.ToString().Replace("-", ""))
                    .Where(id => !blockedIds.Contains(id))
                    .ToList();
                _logger.Info($"[Manual User Import] Importing {userIds.Count} Jellyfin users...");

                var importResult = await Helpers.Jellyseerr.JellyseerrUserImportHelper.BulkImportAsync(
                    userIds, urls, config.GetJellyseerrApiKey(), _httpClientFactory, _logger);

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

        private async Task<List<WatchlistItem>?> GetJellyseerrRequestsForUser(string userId)
        {
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
                {
                    return null;
                }

                var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                foreach (var url in urls)
                {
                    var trimmedUrl = url.Trim();
                    try
                    {
                        var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/request?take=500&skip=0&sort=added";
                        using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestUri, config.GetJellyseerrApiKey(), userId);
                        using var response = await httpClient.SendAsync(request);
                        var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
                        if (error != null)
                        {
                            _logger.Warning($"Failed to get requests from {trimmedUrl}: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                            continue;
                        }

                        var json = JsonDocument.Parse(content!);

                        if (!json.RootElement.TryGetProperty("results", out var results))
                        {
                            continue;
                        }

                        var items = new List<WatchlistItem>();

                        foreach (var item in results.EnumerateArray())
                        {
                            if (!BelongsToUser(item, userId))
                            {
                                continue;
                            }

                            var parsed = ParseRequestItem(item);
                            if (parsed != null)
                            {
                                items.Add(parsed);
                            }
                        }

                        return items;
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"Failed to get requests from {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error getting Seerr requests: {ex}");
            }

            return null;
        }

        private bool BelongsToUser(JsonElement requestElement, string jellyseerrUserId)
        {
            if (requestElement.TryGetProperty("requestedBy", out var requestedBy))
            {
                if (requestedBy.ValueKind == JsonValueKind.Number && requestedBy.TryGetInt32(out var idNumber))
                {
                    return string.Equals(idNumber.ToString(), jellyseerrUserId, StringComparison.OrdinalIgnoreCase);
                }

                if (requestedBy.ValueKind == JsonValueKind.String)
                {
                    var idStr = requestedBy.GetString();
                    if (!string.IsNullOrEmpty(idStr) && string.Equals(idStr, jellyseerrUserId, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                }

                if (requestedBy.ValueKind == JsonValueKind.Object && requestedBy.TryGetProperty("id", out var idProp))
                {
                    if ((idProp.ValueKind == JsonValueKind.Number && idProp.TryGetInt32(out var objId) && string.Equals(objId.ToString(), jellyseerrUserId, StringComparison.OrdinalIgnoreCase)) ||
                        (idProp.ValueKind == JsonValueKind.String && string.Equals(idProp.GetString() ?? string.Empty, jellyseerrUserId, StringComparison.OrdinalIgnoreCase)))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private WatchlistItem? ParseRequestItem(JsonElement requestElement)
        {
            int tmdbId = 0;
            string mediaType = "";

            if (requestElement.TryGetProperty("media", out var media))
            {
                if (media.TryGetProperty("tmdbId", out var tmdbProp))
                {
                    tmdbId = tmdbProp.GetInt32();
                }
                if (media.TryGetProperty("mediaType", out var mtProp) && mtProp.ValueKind == JsonValueKind.String)
                {
                    mediaType = mtProp.GetString() ?? "";
                }
            }

            if (tmdbId == 0 && requestElement.TryGetProperty("tmdbId", out var topTmdb))
            {
                tmdbId = topTmdb.GetInt32();
            }

            if (string.IsNullOrWhiteSpace(mediaType) && requestElement.TryGetProperty("mediaType", out var topMediaType) && topMediaType.ValueKind == JsonValueKind.String)
            {
                mediaType = topMediaType.GetString() ?? "";
            }

            if (tmdbId == 0 || string.IsNullOrWhiteSpace(mediaType))
            {
                return null;
            }

            return new WatchlistItem
            {
                TmdbId = tmdbId,
                MediaType = mediaType
            };
        }

        private class WatchlistItem
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = "movie";
        }

        [HttpGet("jellyseerr/settings/partial-requests")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrPartialRequestsSetting()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                // previously returned 200+false, which made the
                // frontend silently flip the request modal to whole-season
                // mode. Returns 503 with structured `code` so the frontend
                // can keep its last-known state instead of regressing.
                _logger.Warning("Seerr integration is not configured or enabled.");
                return StatusCode(503, new { error = true, code = "disabled", message = "Seerr integration not configured." });
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                try
                {
                    var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/settings/main";
                    _logger.Info($"Fetching Seerr partial requests setting from: {requestUri}");

                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.GetJellyseerrApiKey());
                    using var response = await httpClient.SendAsync(request);
                    var (responseContent, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

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
        public async Task<IActionResult> ValidateTmdb([FromQuery] string apiKey)
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

            apiKey = ResolveSubmittedSecret(apiKey, nameof(PluginConfiguration.TMDB_API_KEY));
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

        [HttpGet("script")]
        public ActionResult GetMainScript() => GetScriptResource("js/plugin.js");
        [HttpGet("js/{**path}")]
        public ActionResult GetScript(string path) => GetScriptResource($"js/{path}");
        // Config-page stylesheet lives in Configuration/ next to configPage.html.
        [HttpGet("Configuration/configPage.css")]
        public ActionResult GetConfigPageStylesheet() => GetScriptResource("Configuration/configPage.css");

        // [AllowAnonymous]: version is loaded by translations.js cache-buster pre-login.
        // Information disclosure of the plugin version is acceptable — Jellyfin core
        // exposes its own version pre-auth too. CVEs against JE are tracked publicly
        // so attackers do not need this endpoint to fingerprint a vulnerable version.
        [HttpGet("version")]
        public ActionResult GetVersion() => Content(JellyfinEnhanced.Instance?.Version.ToString() ?? "unknown");

        [HttpGet("private-config")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        public ActionResult GetPrivateConfig()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return StatusCode(503);
            }

            // Non-admin users receive an empty config object rather than a 403 so that the
            // client-side plugin initialises without error but never sees sensitive fields.
            if (!IsAdminUser())
            {
                return new JsonResult(new { });
            }

            return new JsonResult(BuildPrivateConfig(config));
        }

        /// <summary>
        /// The admin-only private config payload. Shared by /private-config and
        /// /bootstrap so the field list lives in one place; callers MUST gate on
        /// IsAdminUser() before calling this.
        /// </summary>
        private object BuildPrivateConfig(PluginConfiguration config)
        {
            // Check + log corruption so admins who never hit one of the action endpoints
            // still see a server-side error entry on private-config load.
            WarnIfArrInstancesCorrupt(config);

            return new
            {
                // For Arr Links (legacy single-instance fields, kept for backward compat)
                config.SonarrUrl,
                config.RadarrUrl,
                config.BazarrUrl,
                config.SonarrUrlMappings,
                config.RadarrUrlMappings,
                config.BazarrUrlMappings,

                // Shoko (single-instance, like Jellyseerr)
                config.ShokoUrl,
                config.ShokoUrlMappings,

                // Multi-instance Sonarr/Radarr (no API keys exposed). Enabled flag is exposed so
                // the config page can render a per-instance toggle and arr-links can filter
                // disabled instances from the dropdown without a round-trip.
                SonarrInstances = config.GetSonarrInstances().Select(i => new { i.Name, i.Url, i.UrlMappings, i.Enabled }),
                RadarrInstances = config.GetRadarrInstances().Select(i => new { i.Name, i.Url, i.UrlMappings, i.Enabled }),

                // Corruption flags so the frontend can surface a toast without waiting for an
                // action endpoint to round-trip a corruption error envelope.
                SonarrInstancesCorrupt = config.IsSonarrInstancesCorrupt(),
                RadarrInstancesCorrupt = config.IsRadarrInstancesCorrupt(),
            };
        }
        // [AllowAnonymous]: public-config is loaded by `loadLoginImageEarly` before
        // the user logs in, so we cannot gate the whole endpoint on [Authorize].
        // Instead, sensitive Seerr fields (BaseUrl, UrlMappings) are REDACTED for
        // unauthenticated callers — they only need login-screen toggles like
        // EnableLoginImage. Authenticated callers (any Jellyfin user) get the full
        // payload so client-side "Open in Seerr" deep links still work.
        [HttpGet("public-config")]
        public ActionResult GetPublicConfig()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return StatusCode(503);
            }

            return new JsonResult(BuildPublicConfig(config));
        }

        /// <summary>True in the Jellyfin 12 build, which registers the native details facade; a 10.11 build never offers it.</summary>
#if JF12
        internal const bool NativeAbsentDetailsCapable = true;
#else
        internal const bool NativeAbsentDetailsCapable = false;
#endif

        /// <summary>
        /// The public config payload. Shared by /public-config and /bootstrap so the
        /// field list lives in one place. Redaction of the Seerr URLs is keyed on the
        /// CURRENT request's authentication state, exactly as /public-config does.
        /// </summary>
        private object BuildPublicConfig(PluginConfiguration config)
        {
            // Expose whether TMDB is configured as a boolean so all users
            // (including non-admin) can use TMDB-dependent features like
            // Reviews and Elsewhere without leaking the actual API key.
            var tmdbEnabled = !string.IsNullOrWhiteSpace(config.GetTmdbApiKey());

            // Same reasoning as tmdbEnabled above -- expose only whether an
            // MDBList key is configured, never the key itself.
            var mdblistEnabled = !string.IsNullOrWhiteSpace(config.GetMdblistApiKey());

            // Only authenticated callers see internal Seerr URLs — they're used by
            // client-side deep links and would otherwise leak network topology to
            // unauthenticated visitors hitting the login page.
            bool isAuthed = User?.Identity?.IsAuthenticated == true;

            // Maintenance banner state comes from the runtime state (in-memory), not just the
            // saved toggle: a scheduled window or a timed manual window is active without the
            // admin toggle being on, and carries its own message and end time for the countdown.
            var mmState = _maintenanceModeService.GetStatus();
            var mmActive = mmState.IsActive || config.MaintenanceModeEnabled;
            var mmMessage = mmState.IsActive && !string.IsNullOrWhiteSpace(mmState.Message)
                ? mmState.Message
                : config.MaintenanceModeMessage;

            string jellyseerrBaseUrl = string.Empty;
            string jellyseerrUrlMappings = string.Empty;
            if (isAuthed)
            {
                try
                {
                    if (!string.IsNullOrWhiteSpace(config.JellyseerrUrls))
                    {
                        jellyseerrBaseUrl = config.JellyseerrUrls
                            .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                            .Select(u => u.Trim())
                            .FirstOrDefault() ?? string.Empty;
                    }
                }
                catch { /* ignore */ }
                jellyseerrUrlMappings = config.JellyseerrUrlMappings ?? string.Empty;
            }

            return new
            {
                // Jellyfin Enhanced Settings
                TmdbEnabled = tmdbEnabled,
                config.ToastDuration,
                config.HelpPanelAutocloseDelay,
                config.EnableCustomSplashScreen,
                config.SplashScreenImageUrl,

                // Jellyfin Elsewhere Settings
                config.ElsewhereEnabled,
                config.DEFAULT_REGION,
                config.DEFAULT_PROVIDERS,
                config.IGNORE_PROVIDERS,
                config.ElsewhereSeasonProviders,
                config.ElsewhereCustomBrandingText,
                config.ElsewhereCustomBrandingImageUrl,
                config.ClearLocalStorageTimestamp,
                config.ClearTranslationCacheTimestamp,

                // Default User Settings
                config.AutoPauseEnabled,
                config.AutoResumeEnabled,
                config.AutoPipEnabled,
                config.AutoSkipIntro,
                config.AutoSkipOutro,
                config.LongPress2xEnabled,
                config.RandomButtonEnabled,
                config.RandomIncludeMovies,
                config.RandomIncludeShows,
                config.RandomUnwatchedOnly,
                config.RandomScopeCurrentContainer,
                config.ShowWatchProgress,
                config.WatchProgressDefaultMode,
                config.WatchProgressTimeFormat,
                config.ShowFileSizes,
                config.RemoveContinueWatchingEnabled,
                config.ShowAudioLanguages,
                config.Shortcuts,
                config.ShowReviews,
                config.ShowUserReviews,
                config.ReviewsExpandedByDefault,
                config.HideReviewsFromHiddenUsers,
                config.HideReviewsFromDisabledUsers,
                config.ShowAwards,
                DoesTheDogDieEnabled = config.DoesTheDogDieEnabled && !string.IsNullOrWhiteSpace(config.GetDoesTheDogDieApiKey()),
                MdblistEnabled = mdblistEnabled,
                config.MdblistRatingsEnabled,
                config.MdblistRatingsShowOnItemDetails,
                config.MdblistRatingsSources,
                config.MdblistRatingsShowPercentSymbol,
                config.ShowReleaseDates,
                config.ShowUserRatingOnPosters,
                config.ShowUserRatingDash,
                config.PauseScreenEnabled,
                config.PauseScreenDelaySeconds,
                config.ShowPlaybackRatingBadge,
                config.NativePosterTagsEnabled,
                TagStyleWebActive = config.TagStylesEnabled && config.TagStyleTarget is "web" or "both" && !TagStyleSet.Parse(config.TagStyleOverrides).IsEmpty,
                config.QualityTagsEnabled,
                config.ShowResolutionTag,
                config.ShowSourceTag,
                config.ShowDynamicRangeTag,
                config.ShowSpecialFormatTag,
                config.ShowVideoCodecTag,
                config.ShowAudioInfoTag,
                config.ResolutionTagOrder,
                config.SourceTagOrder,
                config.DynamicRangeTagOrder,
                config.SpecialFormatTagOrder,
                config.VideoCodecTagOrder,
                config.AudioInfoTagOrder,
                config.GenreTagsEnabled,
                config.LanguageTagsEnabled,
                config.RatingTagsEnabled,
                config.AgeRatingTagsEnabled,
                config.PeopleTagsEnabled,
                config.DisableAllShortcuts,
                config.DefaultSubtitleStyle,
                config.DefaultSubtitleSize,
                config.DefaultSubtitleFont,
                config.DefaultSubtitleTextEffect,
                config.DisableCustomSubtitleStyles,
                // As the display-language gate stores it (a value saved before the gate existed is handed out as Auto). The
                // client gets the same policy inside the translations script it is served, so no language list is sent.
                DefaultLanguage = LanguageTags.Sanitize(config.DefaultLanguage),
                // Overlay positions
                config.QualityTagsPosition,
                config.GenreTagsPosition,
                config.LanguageTagsPosition,
                config.LanguageTagsPriority,
                config.LanguageTagsPriorityStrict,
                config.QualityTagsPreferredAudioLanguage,
                config.QualityTagsAudioLanguageFromUser,
                config.RatingTagsPosition,
                config.RatingTagsOnMovies,
                config.RatingTagsOnSeries,
                config.RatingTagsOnSeasons,
                config.RatingTagsOnEpisodes,
                config.RatingTagsOnContinueWatching,
                config.RatingTagsOnNextUp,
                config.AgeRatingTagsPosition,
                config.ShowRatingInPlayer,

                config.TagsCacheTtlDays,
                config.DisableTagsOnSearchPage,
                config.TagsHideOnHover,
                config.TagCacheServerMode,
                config.EnableTagsLocalStorageFallback,

                // Seerr Search Settings
                config.JellyseerrEnabled,
                config.JellyseerrShowSearchResults,
                config.JellyseerrSearchExcludeLibraryItems,
                config.JellyseerrShowReportButton,
                config.JellyseerrShowIssueIndicator,
                config.JellyseerrEnable4KRequests,
                config.JellyseerrEnable4KTvRequests,
                config.ShowCollectionsInSearch,
                config.JellyseerrShowAdvanced,
                config.JellyseerrSingleSeasonRequestOnly,
                config.JellyseerrShowQuotaInfo,
                config.ShowElsewhereOnJellyseerr,
                config.JellyseerrUseMoreInfoModal,
                config.JellyseerrAvailablePosterLinksToJellyfin,
                // Native details for not-in-library titles: the capability (a Jellyfin 12 build with the
                // facade registered), the admin switch and Seerr set up (the pages' metadata source);
                // anything else means the modal.
                NativeAbsentDetails = new
                {
                    Enabled = NativeAbsentDetailsCapable && config.NativeAbsentDetailsEnabled
                        && config.JellyseerrEnabled && !string.IsNullOrWhiteSpace(config.JellyseerrUrls) && !string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()),
                    ContractVersion = 1,
                },
                config.AddRequestedMediaToWatchlist,
                config.SyncJellyseerrWatchlist,
                config.JellyseerrAutoImportUsers,
                config.JellyseerrShowSimilar,
                config.JellyseerrShowRecommended,
                config.JellyseerrShowRequestMoreOnSeries,
                config.JellyseerrShowNetworkDiscovery,
                config.JellyseerrShowGenreDiscovery,
                config.JellyseerrShowTagDiscovery,
                config.JellyseerrShowPersonDiscovery,
                config.JellyseerrShowCollectionDiscovery,
                config.JellyseerrShowDetailPageLink,
                config.JellyseerrShowDetailPageLinkAsText,
                config.JellyseerrExcludeLibraryItems,
                config.JellyseerrExcludeBlocklistedItems,
                config.JellyseerrDisableCache,
                JellyseerrBaseUrl = jellyseerrBaseUrl,
                JellyseerrUrlMappings = jellyseerrUrlMappings,

                // Bookmarks Settings
                config.BookmarksEnabled,
                config.BookmarksUsePluginPages,
                config.BookmarksUseCustomTabs,
                config.BookmarksUseNativeTab,

                // Arr Links Settings
                config.ArrLinksEnabled,
                config.ShowArrLinksAsText,
                config.ArrLinksShowStatusSingle,

                // Requests & downloads, phase 1 (status on pages): one derived switch (master and
                // phase on) and the poster-badge toggle; nothing about the instances themselves.
                ArrStatusEnabled = config.ArrIntegrationEnabled && config.ArrPhase1Enabled,
                ArrStatusPosterBadges = config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrStatusPosterBadges,
                ArrRequestsHubEnabled = config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrRequestsHubEnabled,
                ArrManageDrawerEnabled = config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrManageDrawerEnabled,
                ArrSeerrModalStatus = config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrSeerrModalStatus,
                // Phase 2 notifications (bell, Notify me, Remind, "Requests & alerts" panel).
                ArrNotificationsEnabled = Services.Acquire.Notify.NotifyFlags.Enabled(config),
                // Phase 3 request controls (Request, Get it, request sheet): on with a request backend only.
                ArrRequestsEnabled = config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled && config.ArrRequestBackend is "je" or "seerr",
                // Jellyfin Enhanced handles requests (JE mode): Seerr's request buttons open JE's request sheet instead.
                ArrRequestsJeMode = config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled && config.ArrRequestBackend == "je",
                // Kids don't get the JE-mode search row (the search route refuses them too).
                config.ArrKidsHideSearch,
                // Phase 4 automation engine in effect: each person's automatic-request preferences show only then.
                ArrAutomationEngineEnabled = Services.Acquire.Automation.AutomationFlags.Engine(config),
                // Phase 4c1: effective list switches (each already includes its parents; per-person preferences are in user settings).
                ArrListsEnabled = Services.Acquire.Lists.ListFlags.Lists(config),
                ArrListAuthoringEnabled = Services.Acquire.Lists.ListFlags.Authoring(config),
                ArrListRequestsEnabled = Services.Acquire.Lists.ListFlags.Requests(config),
                ArrListRequestAllEnabled = Services.Acquire.Lists.ListFlags.RequestAll(config),
                ArrListSwapInEnabled = Services.Acquire.Lists.ListFlags.SwapIn(config),
                ArrListStatusEnabled = Services.Acquire.Lists.ListFlags.Status(config),
                // Phase 4c3a: list pages (each person may still hide them).
                ArrListPlaylistUiEnabled = Services.Acquire.Lists.ListFlags.PlaylistUi(config),
                ArrListCollectionUiEnabled = Services.Acquire.Lists.ListFlags.CollectionUi(config),
                // Phase 4e: effective acquisition badge switches (parents included; per-person preferences are in user settings).
                ArrAcquisitionBadgesEnabled = Services.Acquire.Stamps.AcquisitionStampFlags.Badges(config),
                ArrNativeStampsEnabled = Services.Acquire.Stamps.AcquisitionStampFlags.NativeStamps(config),
                // Phase 4d: effective home-row and collection-gap switches (parents included; per-person row preferences are in user settings).
                ArrHomeRowsEnabled = Services.Acquire.Home.HomeFlags.Rows(config),
                ArrHomeHssSections = Services.Acquire.Home.HomeFlags.HssSections(config) && Services.Acquire.Home.HssSectionsAdapter.Present,
                ArrHomeOpsStripEnabled = Services.Acquire.Home.HomeFlags.OpsStrip(config),
                ArrCollectionGapsPhase4 = Services.Acquire.Home.HomeFlags.CollectionGaps(config),
                // Phase 4f: the Ready playlist and native Ready messages in effect (parents included; each person opts in).
                ArrReadyPlaylistEnabled = Services.Acquire.Ready.ReadyFlags.Playlist(config),
                ArrReadyMessagesEnabled = Services.Acquire.Ready.ReadyFlags.Messages(config),
                // Phase 4c2: list import review and From URL (effective switches only; providers come from the import route)
                ArrListImportEnabled = Services.Acquire.Lists.Import.ListImportFlags.Import(config),
                ArrListSourcesEnabled = Services.Acquire.Lists.Import.ListImportFlags.Sources(config),

                // Arr Tags Sync Settings
                config.ArrTagsSyncEnabled,
                config.ArrTagsPrefix,
                config.ArrTagsShowAsLinks,
                config.ArrTagsLinksFilter,
                config.ArrTagsLinksHideFilter,

                // Audio Language Tags Sync Settings
                config.AudioLanguageTagSyncEnabled,
                config.AudioLanguageTagPrefix,
                config.AudioLanguageTagShowAsLinks,

                // Letterboxd Settings
                config.LetterboxdEnabled,
                config.ShowLetterboxdLinkAsText,
                // Metadata Icons (Druidblack)
                config.MetadataIconsEnabled,

                // Icon Settings
                config.UseIcons,
                config.IconStyle,

                // Extras Settings
                config.ColoredRatingsEnabled,
                config.ThemeSelectorEnabled,
                config.ColoredActivityIconsEnabled,
                config.PluginIconsEnabled,
                config.EnableLoginImage,
                config.ActiveStreamsEnabled,
                config.ActiveStreamsAllUsers,
                config.AnalyticsEnabled,
                config.AnalyticsShareUsageCounts,

                // Requests Page Settings
                config.DownloadsPageEnabled,
                config.DownloadsPageShowIssues,
                config.ShowDownloadsInRequests,
                config.DownloadsUsePluginPages,
                config.DownloadsUseCustomTabs,
                config.DownloadsUseNativeTab,
                config.DownloadsPagePollingEnabled,
                config.DownloadsPollIntervalSeconds,
                config.DownloadsFilterByUserRequests,
                config.DownloadsShowHistory,
                config.DownloadsHistoryAdminOnly,

                // Calendar Page Settings
                config.CalendarPageEnabled,
                config.CalendarUseCustomTabs,
                config.CalendarUsePluginPages,
                config.CalendarUseNativeTab,
                config.CalendarFirstDayOfWeek,
                config.CalendarTimeFormat,
                config.CalendarHighlightFavorites,
                config.CalendarHighlightWatchedSeries,
                config.CalendarFilterByLibraryAccess,
                config.CalendarShowOnlyRequested,
                config.CalendarForceOnlyRequested,

                // Recommendations Page Settings
                config.RecommendationsPageEnabled,
                config.RecommendationsUseCustomTabs,
                config.RecommendationsUseNativeTab,

                // Activity Feed Settings
                config.ActivityFeedEnabled,
                config.ActivityFeedUseCustomTabs,
                config.ActivityFeedUseNativeTab,
                config.ActivityFeedShowWatched,
                config.ActivityFeedShowFavorited,
                config.ActivityFeedShowReviewed,
                config.ActivityFeedShowActiveStreams,

                // Hidden Content Settings
                config.HiddenContentEnabled,
                config.HiddenContentUsePluginPages,
                config.HiddenContentUseCustomTabs,
                config.HiddenContentUseNativeTab,
                config.HiddenContentAdmin,

                // Catch Up Page Settings
                config.CatchUpEnabled,
                config.CatchUpUsePluginPages,
                config.CatchUpUseCustomTabs,
                config.CatchUpUseNativeTab,

                // Maintenance Mode
                MaintenanceModeEnabled = mmActive,
                MaintenanceModeMessage = mmMessage,
                // UTC ISO timestamp (or null when open-ended) so the banner can count down.
                MaintenanceModeEndsAt = mmState.IsActive ? mmState.EndsAt : null,
                config.MaintenanceModeAction,
                // Derived, never the raw value: the stored setting can be a
                // JSON array of real user GUIDs, and this endpoint is
                // anonymous (pre-login). No client script reads this field —
                // enforcement is server-side — so only the shape is exposed.
                MaintenanceModeAffectedUsers = PluginConfiguration.DeriveAffectedUsersShape(config.MaintenanceModeAffectedUsers),

                // Spoiler Guard — frontend uses these to decide whether the per-show toggle appears.
                config.SpoilerBlurEnabled,
                config.SpoilerBlurIntensity,
                config.SpoilerBlurStrictRefresh,
                // Strip-policy fields drive the per-user override UI — only
                // admin-enabled categories surface an opt-out toggle.
                SpoilerStripSeriesOverview = config.SpoilerStripSeriesOverview ?? config.SpoilerStripOverview,
                config.SpoilerStripOverview,
                config.SpoilerStripTags,
                config.SpoilerStripChapters,
                config.SpoilerStripTaglines,
                config.SpoilerStripRatings,
                config.SpoilerStripPremiereDate,
                config.SpoilerReplaceTitle,
                config.SpoilerStripCast,
                config.SpoilerStripReviews,
                // Gates the per-user "Seek previews" opt-out row.
                config.SpoilerBlurTrickplay,
                // Advanced category reveals: clients only need the master flag
                // (to gate the per-user opt-out row in the settings panel);
                // the six per-category strip toggles are server-only strip
                // policy and are deliberately not exposed.
                config.SpoilerAdvancedMode,
            };
        }

        /// <summary>
        /// One-request client bootstrap: everything plugin.js used to fetch in its
        /// first two stages (version, public config, admin-only private config,
        /// delivery-plugin presence, the five per-user documents) plus the ordered
        /// component-script list. Every part reuses the builder behind the
        /// corresponding standalone endpoint, so the shapes are identical and the
        /// existing endpoints stay as they are for the config page, other callers
        /// and clients that cached an older plugin.js.
        ///
        /// Security: [Authorize] (no anonymous variant — the login screen keeps
        /// using /public-config); the private config is included only when the
        /// caller passes the same IsAdminUser() gate as /private-config (null
        /// otherwise); the user documents are always those of the TOKEN's user —
        /// there is no userId parameter to point elsewhere.
        /// </summary>
        [HttpGet("bootstrap")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public ActionResult GetBootstrap()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return StatusCode(503);
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (!userId.HasValue)
            {
                return Forbid();
            }

            // UserConfigurationManager expects folder names in N format (without dashes),
            // matching AuthorizeUserConfigAccess.
            var authorizedUserId = userId.Value.ToString("N");
            // The person's revisions as the filter took them before this action read their documents (else taken now, still
            // before the reads below): the client keeps the mirrors it loads from here under them.
            var revision = Response.Headers.TryGetValue(Helpers.AccessRevision.Header, out var taken) && taken.Count > 0
                ? taken.ToString()
                : _userManager == null ? null : Helpers.AccessRevision.For(_userManager, userId.Value);

            IReadOnlyList<string>? componentScripts = null;
            try
            {
                componentScripts = Services.ClientScriptBundle.GetComponentScripts();
            }
            catch (Exception ex)
            {
                // The client falls back to fetching js/component-scripts.json itself.
                _logger.Error($"Bootstrap: could not read the component-script manifest: {ex.Message}");
            }

            var isAdmin = IsAdminUser();
            // Each document's revision, taken before it is read (the client orders later answers against it).
            var userRevisions = new Dictionary<string, string>(StringComparer.Ordinal);
            Func<object> Revisioned(string fileName, Func<object> read) => () =>
            {
                var (document, revision) = ReadWithRevision(authorizedUserId, fileName, read);
                userRevisions[fileName] = revision;
                return document;
            };

            return new JsonResult(new
            {
                Version = JellyfinEnhanced.Instance?.Version.ToString() ?? "unknown",
                // The server's JE build (the client script's cache key): a page from another build asks to be reloaded.
                Build = JellyfinEnhanced.Instance?.ScriptCacheKey,
                // Lets the client confirm the payload belongs to the user it expects
                // (a token swap during a user switch must never be applied silently).
                UserId = authorizedUserId,
                Revision = revision,
                PublicConfig = BuildPublicConfig(config),
                PrivateConfig = isAdmin ? BuildPrivateConfig(config) : null,
                // Same name checks the client used to run against GET /Plugins.
                HasCustomTabs = IsPluginInstalled("Custom Tabs"),
                HasPluginPages = IsPluginInstalled("Plugin Pages"),
                UserSettings = new
                {
                    Settings = TryLoadUserDocument("settings.json", authorizedUserId, Revisioned("settings.json", () => LoadUserSettingsDocument(authorizedUserId))),
                    Shortcuts = TryLoadUserDocument("shortcuts.json", authorizedUserId, Revisioned("shortcuts.json", () => _userConfigurationManager.GetUserConfiguration<UserShortcuts>(authorizedUserId, "shortcuts.json"))),
                    Bookmark = TryLoadUserDocument("bookmark.json", authorizedUserId, Revisioned("bookmark.json", () => _userConfigurationManager.GetUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json"))),
                    Elsewhere = TryLoadUserDocument("elsewhere.json", authorizedUserId, Revisioned("elsewhere.json", () => _userConfigurationManager.GetUserConfiguration<ElsewhereSettings>(authorizedUserId, "elsewhere.json"))),
                    HiddenContent = TryLoadUserDocument("hidden-content.json", authorizedUserId, Revisioned("hidden-content.json", () => LoadUserHiddenContentDocument(authorizedUserId))),
                },
                UserRevisions = userRevisions,
                ComponentScripts = componentScripts,
                Prefetched = BuildBootstrapPrefetched(config, userId.Value, authorizedUserId, isAdmin),
            });
        }

        /// <summary>
        /// Small answers the component modules ask for on every page load, carried
        /// in the bootstrap so they cost no request of their own. Each value is the
        /// exact body of its standalone endpoint (which stays for every other
        /// caller) under the same gate, or null when that endpoint would be needed
        /// anyway: the feature is off, the caller may not read it, or answering
        /// would mean an upstream round trip (Seerr) or a failure the endpoint
        /// reports itself (a corrupt Spoiler Guard file). The client takes each
        /// value at most once and only shortly after the response, and otherwise
        /// asks the endpoint as before.
        ///   SpoilerBlurSeries    — GET spoiler-blur/series (the caller's own state)
        ///   SeerrUserStatus      — GET jellyseerr/user-status, when no Seerr lookup is needed
        ///   SeerrStatus          — GET jellyseerr/status, from the 30-second probe cache only
        ///   ActiveStreamSessions — GET active-streams/sessions, admins or ActiveStreamsAllUsers
        /// </summary>
        private object BuildBootstrapPrefetched(PluginConfiguration config, Guid userId, string authorizedUserId, bool isAdmin)
        {
            object? spoilerBlurSeries = null;
            object? seerrUserStatus = null;
            object? seerrStatus = null;
            List<object>? activeStreamSessions = null;

            if (config.SpoilerBlurEnabled)
            {
                spoilerBlurSeries = TryReadSpoilerBlurStateForBootstrap(authorizedUserId);
            }

            if (config.JellyseerrEnabled)
            {
                // Same "D"-format id GetJellyseerrUserStatus reads from the token.
                seerrUserStatus = TryBuildSeerrUserStatusWithoutLookup(config, userId.ToString(), isAdmin);

                // Asked at startup by the issue reporter only.
                if (config.JellyseerrShowReportButton)
                {
                    var reachable = TryGetCachedSeerrReachability();
                    if (reachable.HasValue)
                    {
                        seerrStatus = SeerrStatusResponse(reachable.Value);
                    }
                }
            }

            if (CanReadActiveSessions(config, isAdmin))
            {
                try
                {
                    activeStreamSessions = BuildActiveSessionList(isAdmin);
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Bootstrap: could not list active sessions: {ex.Message}");
                }
            }

            return new
            {
                SpoilerBlurSeries = spoilerBlurSeries,
                SeerrUserStatus = seerrUserStatus,
                SeerrStatus = seerrStatus,
                ActiveStreamSessions = activeStreamSessions,
            };
        }

        /// <summary>
        /// Loads one per-user document for the bootstrap payload. A failure yields
        /// null (the client then applies the same defaults it uses when the
        /// standalone endpoint fails) instead of failing the whole bootstrap.
        /// </summary>
        private object? TryLoadUserDocument(string fileName, string authorizedUserId, Func<object> load)
        {
            try
            {
                return load();
            }
            catch (Exception ex)
            {
                _logger.Error($"Bootstrap: failed to load {fileName} for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Whether a plugin with exactly this name is loaded and running right now. A plugin
        /// that is disabled (after the restart that unloads it) or failed to load serves
        /// nothing, so the client must treat it as absent; one disabled, deleted or updated
        /// but not yet restarted is still loaded and serving, so it counts as present.
        /// </summary>
        private bool IsPluginInstalled(string name)
        {
            try
            {
                return _pluginManager.Plugins.Any(p => string.Equals(p.Name, name, StringComparison.Ordinal)
                    && p.Instance != null);
            }
            catch (Exception ex)
            {
                _logger.Warning($"Bootstrap: could not enumerate installed plugins: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// The concatenated component scripts (see Services/ClientScriptBundle).
        /// Same headers as GetScriptResource: immutable in production (the URL
        /// carries the cache key), no-store and rebuilt per request in dev mode.
        /// </summary>
        [HttpGet("bundle.js")]
        public ActionResult GetScriptBundle() => GetScriptBundleResource(map: false);

        [HttpGet("bundle.js.map")]
        public ActionResult GetScriptBundleMap() => GetScriptBundleResource(map: true);

        private ActionResult GetScriptBundleResource(bool map)
        {
            var plugin = JellyfinEnhanced.Instance;
            if (plugin == null)
            {
                return StatusCode(503);
            }

            var devMode = plugin.Configuration?.DevMode == true;
            byte[] script, sourceMap;
            try
            {
                (script, sourceMap) = Services.ClientScriptBundle.GetBundle(plugin.ScriptCacheKey, rebuild: devMode, _logger);
            }
            catch (Exception ex)
            {
                // The client falls back to loading the component scripts individually.
                _logger.Error($"Failed to build the component bundle: {ex.Message}");
                return StatusCode(500);
            }

            Response.Headers["Cache-Control"] = devMode ? "no-store" : "public, max-age=31536000, immutable";
            return map
                ? File(sourceMap, "application/json")
                : File(script, "application/javascript");
        }

        [HttpGet("tmdb/{**apiPath}")]
        [Authorize]
        public async Task<IActionResult> ProxyTmdbRequest(string apiPath)
        {
            // Parental ratings (#581): for a restricted user the raw TMDB passthrough
            // is limited to title-free lookups; single-title lookups are gated on
            // that title and anything else (search, discover, trending, lists) is
            // refused, because it would return titles unfiltered.
            // Nothing but a successful upstream response may be kept by the browser,
            // and even that is revalidated (so re-gated) on every use.
            Response.Headers["Cache-Control"] = "no-store";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.GetTmdbApiKey()))
            {
                return StatusCode(503, "TMDB API key is not configured.");
            }

            if (!Services.ProviderPresentationSchema.SupportsTmdbPath(apiPath))
                return BadRequest(new { error = "unsupported_tmdb_resource" });
            if (!Services.TmdbAppendProjection.IsSupported(apiPath, Request.Query))
                return BadRequest(new { error = "unsupported_tmdb_append" });

            var tmdbCallerId = UserHelper.GetCurrentUserId(User)?.ToString();
            var queryString = HttpContext.Request.QueryString;
            if (_parentalFilter.TryGetRestrictedPolicy(tmdbCallerId, out _))
            {
                // Kestrel decodes %3F in the path, so a query (even a double-encoded
                // append_to_response) can arrive inside apiPath. Restricted users get
                // plain path characters only.
                if (apiPath.IndexOfAny(new[] { '?', '%', '&', '#', ';', '=', '\\' }) >= 0)
                {
                    return ParentalBlockedResult();
                }

                // The route captures only the path; the query matters too. Work on the
                // DECODED keys so percent-encoding (append%5Fto%5Fresponse) can't slip
                // a title list past the classifier, and forward only a small set of
                // harmless parameters, rebuilt from the decoded values.
                var allowedKeys = new[] { "language", "page", "region", "include_adult", "query" };
                var decodedQuery = string.Join("&", HttpContext.Request.Query
                    .Where(kv => allowedKeys.Contains(kv.Key, StringComparer.OrdinalIgnoreCase))
                    .Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value.ToString())}"));
                if (HttpContext.Request.Query.Keys.Any(k => !allowedKeys.Contains(k, StringComparer.OrdinalIgnoreCase)))
                {
                    return ParentalBlockedResult();
                }
                switch (Services.SeerrParentalFilter.ClassifyTmdbPassthrough(apiPath + (decodedQuery.Length > 0 ? "?" + decodedQuery : string.Empty), out var gatedType, out var gatedId))
                {
                    case Services.SeerrParentalFilter.TmdbAccess.Deny:
                        return ParentalBlockedResult();
                    case Services.SeerrParentalFilter.TmdbAccess.GateTitle:
                        if (await _parentalFilter.IsBlockedAsync(gatedType, gatedId, tmdbCallerId))
                        {
                            return ParentalBlockedResult();
                        }
                        break;
                }
                queryString = decodedQuery.Length > 0 ? new QueryString("?" + decodedQuery) : QueryString.Empty;
            }

            try
            {
                // Gating above has already run for this caller; the server cache is
                // keyed on what goes upstream (see TmdbResponseCache for why that
                // is account-safe).
                // bundle: a cold title lookup (or one of its release dates /
                // watch providers / reviews) fetches the whole set in one
                // TMDB call, which the details page's sibling requests join.
                var response = await _tmdbResponseCache.GetAsync(apiPath, queryString.ToString(), config.GetTmdbApiKey(), HttpContext.RequestAborted, bundle: true);

                if (response.IsSuccess)
                {
                    // Browser cache: private + no-cache, so every reuse comes back
                    // here (parental gating above runs again) and costs only a 304
                    // when the body is unchanged. Varied on the auth headers so a
                    // shared browser profile never hands one account's response
                    // (restricted users get different results) to another.
                    Response.Headers["Cache-Control"] = "private, no-cache";
                    Response.Headers["Vary"] = "Authorization, X-Emby-Token, X-Jellyfin-User-Id";
                    var projected = Services.TitleFeedProjection.Hidden(response.Content,
                        Services.HiddenContentPolicy.Load(_userConfigurationManager, UserHelper.GetCurrentUserId(User)!.Value, HttpContext, _libraryManager),
                        apiPath.StartsWith("search/", StringComparison.Ordinal) ? "search" : apiPath.Contains("/recommendations", StringComparison.Ordinal) || apiPath.Contains("/similar", StringComparison.Ordinal) ? "recommendations" : "discovery",
                        apiPath.StartsWith("movie/", StringComparison.Ordinal) || apiPath == "discover/movie" ? "movie" : apiPath.StartsWith("tv/", StringComparison.Ordinal) || apiPath == "discover/tv" ? "tv" : null,
                        resource: Services.ProviderPresentationSchema.ProviderResource(apiPath));
                    var pathParts = apiPath.Split('/', StringSplitOptions.RemoveEmptyEntries);
                    var title = pathParts.Length >= 2 ? Services.HiddenContentPolicy.OwningTitle(pathParts[0], pathParts[1]) : null;
                    var seasonIndex = Array.IndexOf(pathParts, "season");
                    var episodeIndex = Array.IndexOf(pathParts, "episode");
                    var seasonNumber = seasonIndex >= 0 && seasonIndex + 1 < pathParts.Length && int.TryParse(pathParts[seasonIndex + 1], out var seasonValue) ? seasonValue : 0;
                    var episodeNumber = episodeIndex >= 0 && episodeIndex + 1 < pathParts.Length && int.TryParse(pathParts[episodeIndex + 1], out var episodeValue) ? episodeValue : 0;
                    projected = _presentation?.Load(UserHelper.GetCurrentUserId(User)!.Value, HttpContext).ProjectResource(projected, title,
                        Services.ProviderPresentationSchema.ProviderResource(apiPath), apiPath == "discover/movie" ? "movie" : apiPath == "discover/tv" ? "tv" : null,
                        scopeKind: episodeIndex >= 0 ? "episode" : seasonIndex >= 0 ? "season" : null, season: seasonNumber, episode: episodeNumber) ?? projected;
                    var etag = "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(projected))) + "\"";
                    Response.Headers["ETag"] = etag;
                    if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], etag))
                    {
                        return StatusCode(StatusCodes.Status304NotModified);
                    }
                    return Content(projected, "application/json");
                }

                return StatusCode(response.StatusCode, response.Content);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                // Browser went away (navigated off, aborted a superseded fetch) -
                // expected under normal use, not a failure worth logging.
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to proxy TMDB request for '{apiPath}{queryString}'. Error: {ex}");
                return StatusCode(500, "Failed to connect to TMDB.");
            }
        }

        /// <summary>
        /// Batched watch providers for Seerr cards: one request per screenful of
        /// cards instead of one TMDB passthrough call per card, returning only the
        /// region's flat-rate providers (what a card renders) rather than every
        /// region's full list.
        /// items: comma-separated "movie:{id}" / "tv:{id}" (distinct, max 100).
        /// region: two-letter code; defaults to the admin DEFAULT_REGION.
        /// Response: { "region": "US", "results": { "movie:603": [ { provider_id,
        /// provider_name, logo_path } ] | null } } where null means unavailable
        /// (upstream error, or refused to this caller by parental gating).
        /// </summary>
        [HttpGet("watch-providers")]
        [Authorize]
        public async Task<IActionResult> GetWatchProvidersBatch([FromQuery] string? items, [FromQuery] string? region)
        {
            Response.Headers["Cache-Control"] = "no-store";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.GetTmdbApiKey()))
            {
                return StatusCode(503, "TMDB API key is not configured.");
            }

            if (!Services.WatchProvidersBatch.TryParseItems(items, out var requested, out var itemsError))
            {
                return BadRequest(itemsError);
            }

            var regionCode = string.IsNullOrEmpty(region) ? Services.WatchProvidersBatch.DefaultRegion(config.DEFAULT_REGION) : region;
            if (!Services.WatchProvidersBatch.IsValidRegion(regionCode))
            {
                return BadRequest("Invalid region.");
            }

            var apiKey = config.GetTmdbApiKey();
            var callerId = UserHelper.GetCurrentUserId(User)?.ToString();
            var restricted = _parentalFilter.TryGetRestrictedPolicy(callerId, out _);
            var aborted = HttpContext.RequestAborted;
            var results = new ConcurrentDictionary<string, List<Services.WatchProvidersBatch.Provider>?>(StringComparer.Ordinal);
            using var slots = new SemaphoreSlim(6);
            var failures = 0;
            string? lastError = null;

            async Task LoadAsync(Services.WatchProvidersBatch.Item item)
            {
                await slots.WaitAsync(aborted).ConfigureAwait(false);
                try
                {
                    // The same per-caller parental gating the passthrough applies to
                    // {type}/{id}/watch/providers; anything refused stays null.
                    if (restricted)
                    {
                        switch (Services.SeerrParentalFilter.ClassifyTmdbPassthrough(item.ApiPath, out var gatedType, out var gatedId))
                        {
                            case Services.SeerrParentalFilter.TmdbAccess.Deny:
                                return;
                            case Services.SeerrParentalFilter.TmdbAccess.GateTitle:
                                if (await _parentalFilter.IsBlockedAsync(gatedType, gatedId, callerId, aborted).ConfigureAwait(false))
                                {
                                    return;
                                }
                                break;
                        }
                    }

                    var response = await _tmdbResponseCache.GetAsync(item.ApiPath, string.Empty, apiKey, aborted).ConfigureAwait(false);
                    if (response.IsSuccess)
                    {
                        results[item.Key] = Services.WatchProvidersBatch.ExtractFlatrate(response.Content, regionCode);
                    }
                }
                catch (OperationCanceledException) when (aborted.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or IOException or InvalidOperationException)
                {
                    // What TmdbResponseCache surfaces from HttpClient: connection
                    // failures and the body cap, the upstream timeout, a broken
                    // stream, an unusable response. One title failing upstream
                    // leaves just that entry null; logged once per batch below so
                    // an outage doesn't log 100 lines.
                    Interlocked.Increment(ref failures);
                    lastError = ex.Message;
                }
                finally
                {
                    slots.Release();
                }
            }

            try
            {
                await Task.WhenAll(requested.Select(LoadAsync)).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (aborted.IsCancellationRequested)
            {
                return StatusCode(499);
            }

            if (failures > 0)
            {
                _logger.Warning($"Watch providers batch: {failures} of {requested.Count} lookups failed ({lastError}).");
            }

            var body = Services.WatchProvidersBatch.Serialize(regionCode, requested, results);
            var etag = Services.TmdbResponseCache.ComputeETag(body);
            // Same browser-cache policy as the passthrough: every reuse revalidates
            // here (so gating runs again) and costs a 304 when nothing changed.
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["Vary"] = "Authorization, X-Emby-Token, X-Jellyfin-User-Id";
            Response.Headers["ETag"] = etag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], etag))
            {
                return StatusCode(StatusCodes.Status304NotModified);
            }
            return Content(body, "application/json");
        }

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
            if (!Services.UsageEventCounterService.IsValidKey(key))
            {
                return BadRequest("Invalid feature key.");
            }
            if (!Services.UsageEventCounterService.IsKnownKey(key))
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

        /// <summary>
        /// Browser-cache policy for the awards and MDBList ratings responses: the
        /// same body for every user (no per-user gating beyond [Authorize]), backed
        /// by server caches that keep it for days, so a revisit or reload within
        /// half an hour reuses the browser's copy instead of asking again. Private
        /// and varied on the auth headers like the TMDB passthrough, so no shared
        /// cache keeps it and one account's copy is never reused by another.
        /// Set only for an answer the upstream actually gave (Confirmed): errors
        /// and failure placeholders, which the server retries within the hour,
        /// are never kept.
        /// </summary>
        private void SetExternalDataCacheHeaders()
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            Response.Headers["Vary"] = "Authorization, X-Emby-Token, X-Jellyfin-User-Id";
        }

        /// <summary>
        /// Returns the audio-language tag names (base and regional) for the given stream language codes.
        /// </summary>
        [HttpGet("audio-language-tags")]
        [Authorize]
        public ActionResult GetAudioLanguageTags([FromQuery] string codes)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.AudioLanguageTagSyncEnabled)
            {
                return Ok(new Dictionary<string, object>());
            }

            var prefix = string.IsNullOrWhiteSpace(config.AudioLanguageTagPrefix)
                ? "JE Language: "
                : config.AudioLanguageTagPrefix;
            var localization = Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions
                .GetRequiredService<MediaBrowser.Model.Globalization.ILocalizationManager>(HttpContext.RequestServices);

            var result = new Dictionary<string, object>();
            foreach (var code in (codes ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(50))
            {
                if (code.Length > 16 || result.ContainsKey(code)) continue;
                var (baseName, variantName) = AudioLanguageTagHelper.GetTagNames(code, localization);
                result[code] = new
                {
                    baseTag = prefix + baseName,
                    variantTag = variantName == null ? null : prefix + variantName
                };
            }

            return Ok(result);
        }

        [HttpGet("awards/{mediaType}/{tmdbId}")]
        [Authorize]
        public async Task<IActionResult> GetAwards(string mediaType, string tmdbId, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ShowAwards)
            {
                return StatusCode(503, "Awards feature is not enabled.");
            }

            if (mediaType != "movie" && mediaType != "tv" && mediaType != "person")
            {
                return BadRequest("mediaType must be 'movie', 'tv', or 'person'.");
            }

            if (string.IsNullOrWhiteSpace(tmdbId) || !tmdbId.All(char.IsDigit))
            {
                return BadRequest("tmdbId must be a positive integer.");
            }

            var presentation = _presentation?.Load(UserHelper.GetCurrentUserId(User) ?? Guid.Empty, HttpContext);
            if (presentation?.HidesRatings(Services.HiddenContentPolicy.OwningTitle(mediaType, tmdbId)) == true)
            {
                Response.Headers["Cache-Control"] = "private, no-store";
                return Ok(new { confirmed = true, ratings = Array.Empty<object>(), awards = Array.Empty<object>() });
            }

            try
            {
                var result = await _wikidataAwardsService.GetAwardsAsync(mediaType, tmdbId, cancellationToken).ConfigureAwait(false);
                var final = Services.TitlePresentationGate.Read(_userConfigurationManager, _presentation, UserHelper.GetCurrentUserId(User) ?? Guid.Empty, _libraryManager);
                if (final.Spoilers?.HidesRatings(Services.HiddenContentPolicy.OwningTitle(mediaType, tmdbId)) == true)
                {
                    Response.Headers["Cache-Control"] = "private, no-store";
                    return Ok(new { confirmed = true, ratings = Array.Empty<object>(), awards = Array.Empty<object>() });
                }
                if (result.Confirmed)
                {
                    SetExternalDataCacheHeaders();
                }
                return Ok(result);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch awards for {mediaType}:{tmdbId}. Error: {ex.Message}");
                return StatusCode(500, "Failed to fetch awards.");
            }
        }

        /// <summary>
        /// MDBList ratings (TMDB score, Rotten Tomatoes critic/audience, IMDb,
        /// Trakt, Metacritic, etc.) for a title, keyed by TMDB id. Backed by
        /// MdblistService's disk cache -- the admin's MDBList API key is used
        /// server-side only and never reaches the client.
        /// </summary>
        [HttpGet("mdblist-ratings/{mediaType}/{tmdbId}")]
        [Authorize]
        public async Task<IActionResult> GetMdblistRatings(string mediaType, string tmdbId, CancellationToken cancellationToken)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.MdblistRatingsEnabled)
            {
                return StatusCode(503, "MDBList ratings feature is not enabled.");
            }

            if (mediaType != "movie" && mediaType != "tv")
            {
                return BadRequest("mediaType must be 'movie' or 'tv'.");
            }

            if (string.IsNullOrWhiteSpace(tmdbId) || !tmdbId.All(char.IsDigit))
            {
                return BadRequest("tmdbId must be a positive integer.");
            }

            var presentation = _presentation?.Load(UserHelper.GetCurrentUserId(User) ?? Guid.Empty, HttpContext);
            if (presentation?.HidesRatings(Services.HiddenContentPolicy.OwningTitle(mediaType, tmdbId)) == true)
            {
                Response.Headers["Cache-Control"] = "private, no-store";
                return Ok(new { confirmed = true, ratings = Array.Empty<object>(), awards = Array.Empty<object>() });
            }

            try
            {
                var result = await _mdblistService.GetRatingsAsync(mediaType, tmdbId, cancellationToken).ConfigureAwait(false);
                var final = Services.TitlePresentationGate.Read(_userConfigurationManager, _presentation, UserHelper.GetCurrentUserId(User) ?? Guid.Empty, _libraryManager);
                if (final.Spoilers?.HidesRatings(Services.HiddenContentPolicy.OwningTitle(mediaType, tmdbId)) == true)
                {
                    Response.Headers["Cache-Control"] = "private, no-store";
                    return Ok(new { confirmed = true, ratings = Array.Empty<object>(), awards = Array.Empty<object>() });
                }
                if (result.Confirmed)
                {
                    SetExternalDataCacheHeaders();
                }
                return Ok(result);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch MDBList ratings for {mediaType}:{tmdbId}. Error: {ex.Message}");
                return StatusCode(500, "Failed to fetch MDBList ratings.");
            }
        }

        private bool DoesTheDogDieActive(out PluginConfiguration? config)
        {
            config = JellyfinEnhanced.Instance?.Configuration;
            return config != null && config.DoesTheDogDieEnabled && !string.IsNullOrWhiteSpace(config.GetDoesTheDogDieApiKey());
        }

        // Read current state for EVERY projection, including a hit in the shared upstream cache.
        // A reveal revision is viewer/title/policy-bound and deliberately never persisted as consent.
        private (bool Guarded, string Revision, bool Readable) DoesTheDogDiePolicy(Guid viewer, string mediaType, string tmdbId)
        {
            var config = JellyfinEnhanced.Instance!.Configuration;
            // A settings file confirmed absent means nothing is guarded for this viewer. One that can't be inspected or
            // read is unknown (guarded, no reveal): the tag strip's null covers both, and File.Exists can't tell them apart.
            var presence = config.SpoilerBlurEnabled
                ? _userConfigurationManager.UserConfigurationPresence(viewer.ToString("N"), Services.SpoilerBlurImageFilter.SpoilerBlurFileName)
                : false;
            var state = presence == false ? new UserSpoilerBlur() : presence == true ? LoadSpoilerStateForTagStrip(viewer) : null;
            var guarded = config.SpoilerBlurEnabled && (state == null || state.PendingTmdb.ContainsKey($"{mediaType}:{tmdbId}"));
            if (config.SpoilerBlurEnabled && state != null && !guarded)
            {
                var ids = _itemRepository.GetItemIdsByProviders(new Dictionary<string, string> { ["Tmdb"] = tmdbId },
                    new[] { mediaType == "movie" ? BaseItemKind.Movie : BaseItemKind.Series });
                guarded = ids.Any(id => mediaType == "movie" ? _spoilerResolver.IsMovieInSpoilerScope(state, id)
                    : state.Series.ContainsKey(id.ToString("N")));
            }
            var fingerprint = viewer.ToString("N") + "|" + mediaType + "|" + tmdbId + "|" + config.SpoilerBlurEnabled
                + "|" + guarded + "|" + JsonSerializer.Serialize(state);
            return (guarded, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint))), state != null);
        }

        /// <summary>DoesTheDogDie warnings, hidden for a guarded title until this viewer explicitly reveals them.</summary>
        [HttpGet("ddd/{mediaType}/{tmdbId}")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public async Task<IActionResult> GetDoesTheDogDie(string mediaType, string tmdbId, CancellationToken cancellationToken,
            [FromQuery] bool reveal = false, [FromQuery] string? policyRevision = null)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            if (!DoesTheDogDieActive(out _)) return StatusCode(503, "DoesTheDogDie is not enabled.");
            if (mediaType != "movie" && mediaType != "tv") return BadRequest("mediaType must be 'movie' or 'tv'.");
            if (!int.TryParse(tmdbId, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var numericId) || numericId <= 0)
                return BadRequest("tmdbId must be a positive integer.");
            tmdbId = numericId.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var viewer = ArrCaller.PersonId(User);
            if (viewer == null || _userManager.GetUserById(viewer.Value) is not { } user || user.HasPermission(PermissionKind.IsDisabled)) return Forbid();

            try
            {
                bool CanShow((bool Guarded, string Revision, bool Readable) p) => p.Readable && (!p.Guarded || (reveal && policyRevision == p.Revision));
                var before = DoesTheDogDiePolicy(viewer.Value, mediaType, tmdbId);
                var result = CanShow(before)
                    ? await _doesTheDogDieService.GetWarningsAsync(mediaType, tmdbId, cancellationToken).ConfigureAwait(false)
                    : new Model.DddCacheEntry();
                // Protection may have changed while the external lookup was in flight. A request refused at the start
                // answers with that refusal (an unreadable settings file is quarantined by the read, so the second
                // look would see defaults and report a guard this request never applied).
                var policy = CanShow(before) ? DoesTheDogDiePolicy(viewer.Value, mediaType, tmdbId) : before;
                var show = CanShow(before) && CanShow(policy);
                return Ok(new {
                    policy.Guarded, PolicyRevision = policy.Revision,
                    Found = show && result.Found, Confirmed = show && result.Confirmed,
                    ItemId = show ? result.ItemId : 0, Name = show ? result.Name : string.Empty,
                    Topics = show ? result.Topics : new List<Model.DddTopicStat>(),
                    FetchedAtUnixMs = show ? result.FetchedAtUnixMs : 0
                });
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch DoesTheDogDie data for {mediaType}:{tmdbId}. Error: {ex.Message}");
                return StatusCode(500, "Failed to fetch DoesTheDogDie data.");
            }
        }

        /// <summary>All DoesTheDogDie topics, for the trigger picker.</summary>
        [HttpGet("ddd/topics")]
        [Authorize]
        public async Task<IActionResult> GetDoesTheDogDieTopics(CancellationToken cancellationToken)
        {
            if (!DoesTheDogDieActive(out _)) return StatusCode(503, "DoesTheDogDie is not enabled.");

            try
            {
                var catalog = await _doesTheDogDieService.GetCatalogAsync(cancellationToken).ConfigureAwait(false);
                if (catalog == null) return StatusCode(502, "DoesTheDogDie topics are unavailable.");
                SetExternalDataCacheHeaders();
                return Ok(catalog);
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to fetch DoesTheDogDie topics. Error: {ex.Message}");
                return StatusCode(500, "Failed to fetch DoesTheDogDie topics.");
            }
        }

        [HttpGet("user-settings/{userId}/ddd-triggers.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetUserSettingsDdd(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;

            var (triggers, revision) = ReadWithRevision(authorizedUserId, "ddd-triggers.json",
                () => _userConfigurationManager.GetUserConfiguration<DddSettings>(authorizedUserId, "ddd-triggers.json"));
            return DocumentAnswer(triggers, revision);
        }

        [HttpPost("user-settings/{userId}/ddd-triggers.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsDdd(string userId, [FromBody] DddSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;

            try
            {
                var refused = FencedReplace(authorizedUserId, "ddd-triggers.json", userConfiguration, out _);
                if (refused != null) return refused;
                return Ok(new { success = true, file = "ddd-triggers.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user DoesTheDogDie settings for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user DoesTheDogDie settings." });
            }
        }

        /// <summary>
        /// Live MDBList account/quota status (plan, daily limit, remaining
        /// requests, reset time) from MDBList's own GET /user endpoint, for
        /// the config page to display. Admin-only since it reveals account
        /// details -- same reasoning as ValidateTmdb. Always force-refreshes
        /// rather than serving the cached value, since querying /user doesn't
        /// itself count against the quota it's reporting on.
        /// </summary>
        /// <param name="apiKey">Optional: test an arbitrary (e.g. not-yet-saved)
        /// key instead of the saved config's, matching ValidateTmdb's pattern
        /// so the config page's "Check Status" button works before saving.</param>
        [HttpGet("mdblist-ratings/account-status")]
        [Authorize]
        public async Task<IActionResult> GetMdblistAccountStatus([FromQuery] string? apiKey, CancellationToken cancellationToken)
        {
            if (!IsAdminUser()) return Forbid();

            // A masked value is the saved key: test that instead of a typed override.
            apiKey = ResolveSubmittedSecret(apiKey, nameof(PluginConfiguration.MdblistApiKey));
            var effectiveKey = !string.IsNullOrWhiteSpace(apiKey)
                ? apiKey
                : JellyfinEnhanced.Instance?.Configuration?.GetMdblistApiKey();
            if (string.IsNullOrWhiteSpace(effectiveKey))
            {
                return StatusCode(503, "MDBList API key is not configured.");
            }

            var status = await _mdblistService.GetAccountStatusAsync(cancellationToken, forceRefresh: true, apiKeyOverride: string.IsNullOrWhiteSpace(apiKey) ? null : apiKey).ConfigureAwait(false);
            if (status == null)
            {
                return StatusCode(502, "Could not reach MDBList to check account status (key may be invalid).");
            }
            return Ok(status);
        }

        [HttpGet("locales")]
        [Authorize]
        [ResponseCache(Duration = 86400)]
        public ActionResult GetAvailableLocales()
        {
            var locales = LanguageTags.Bundled
                .Where(code => code != "en") // Exclude base English (en-GB and en-US are the usable variants)
                .ToArray();

            return Ok(locales);
        }

        /// <summary>
        /// Local CDN route. Serves a third-party static asset (icon, flag, theme
        /// sheet, remote locale, …) from the plugin's on-disk cache, fetching it from the
        /// fixed upstream CDN on a cache miss. This is the ONLY endpoint clients use for
        /// these assets — they never contact an external host directly.
        ///
        /// Anonymous by design: these are public assets loaded via &lt;img&gt;, CSS
        /// @import and &lt;link&gt;, none of which can carry a Jellyfin auth token, and no
        /// user data is exposed. The {source} is validated against a fixed allow-list and
        /// {path} is strictly sanitized in the service, so this cannot be used as an open
        /// proxy.
        /// </summary>
        [HttpGet("cdn/{source}/{**path}")]
        public async Task<IActionResult> GetCdnAsset(string source, string path, CancellationToken cancellationToken)
        {
            if (!_cdnAssetService.IsValidSource(source))
            {
                return NotFound();
            }

            var asset = await _cdnAssetService.GetAsync(source, path ?? string.Empty, forceRefresh: false, cancellationToken).ConfigureAwait(false);
            if (asset == null)
            {
                return NotFound();
            }

            // Long-lived immutable caching: after the first hit the browser serves these
            // from its own cache and rarely re-requests. Conditional requests get a 304.
            Response.Headers["Cache-Control"] = "public, max-age=86400";
            Response.Headers["ETag"] = asset.ETag;
            // Defence in depth for SVG served same-origin: forbid MIME sniffing and, for
            // SVG specifically, sandbox it so an embedded <script> can never execute if it
            // were opened directly.
            Response.Headers["X-Content-Type-Options"] = "nosniff";
            if (asset.ContentType.Equals("image/svg+xml", StringComparison.OrdinalIgnoreCase))
            {
                Response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
            }

            if (Request.Headers.TryGetValue("If-None-Match", out var ifNoneMatch)
                && ifNoneMatch.ToString().Contains(asset.ETag, StringComparison.Ordinal))
            {
                return StatusCode(304);
            }

            return File(asset.Content, asset.ContentType);
        }

        // Material Symbols glyph fonts, bundled with the plugin instead of proxied
        // from Google Fonts (see #830). The -subset files hold only the icons the
        // client uses (scripts/material-symbols/subset.py) under JE-private family
        // names; the full fonts back the public family names for themes and custom
        // CSS that rely on JE providing them.
        private static readonly HashSet<string> BundledFontNames = new(StringComparer.OrdinalIgnoreCase)
        {
            "materialsymbolsrounded-subset.woff2",
            "materialsymbolsoutlined-subset.woff2",
            "materialsymbolsrounded.woff2",
            "materialsymbolsoutlined.woff2"
        };

        [HttpGet("fonts/{name}")]
        public IActionResult GetBundledFont(string name)
        {
            var sanitized = Path.GetFileName(name);
            if (!BundledFontNames.Contains(sanitized))
            {
                return NotFound();
            }

            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"Jellyfin.Plugin.JellyfinEnhanced.js.fonts.{sanitized}");
            if (stream == null)
            {
                return NotFound();
            }

            Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
            return File(stream, "font/woff2");
        }

        [HttpGet("locales/{lang}.json")]
        public ActionResult GetLocale(string lang)
        {
            var sanitizedLang = Path.GetFileName(lang); // Basic sanitization
            var resourcePath = $"Jellyfin.Plugin.JellyfinEnhanced.js.locales.{sanitizedLang}.json";
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourcePath);

            if (stream == null && sanitizedLang.Contains('-'))
            {
                // Fall back from regional variant (e.g. de-DE) to the base language (de).
                // Jellyfin reports BCP-47 codes like de-DE when the user picks "Auto" or a
                // regional locale, but the plugin only ships base-language files for most
                // languages. Without this fallback the user gets English instead of German.
                var baseLang = sanitizedLang.Split('-')[0];
                var fallbackPath = $"Jellyfin.Plugin.JellyfinEnhanced.js.locales.{baseLang}.json";
                stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(fallbackPath);
                if (stream != null)
                {
                    _logger.Info($"Locale file not found for {sanitizedLang}, falling back to base language {baseLang}");
                }
            }

            if (stream == null)
            {
                _logger.Warning($"Locale file not found for language: {sanitizedLang}");
                return NotFound();
            }

            return new FileStreamResult(stream, "application/json");
        }

        private ActionResult GetScriptResource(string resourcePath)
        {
            // The translations script carries the display-language policy, written in as it is served (from the locale files
            // this build embeds): see LanguageTags.TranslationsScript.
            var stream = string.Equals(resourcePath, "js/enhanced/translations.js", StringComparison.Ordinal)
                ? new MemoryStream(Encoding.UTF8.GetBytes(LanguageTags.TranslationsScript()))
                : Assembly.GetExecutingAssembly().GetManifestResourceStream($"Jellyfin.Plugin.JellyfinEnhanced.{resourcePath.Replace('/', '.')}");
            if (stream == null) return NotFound();

            // Pick a content type that matches the requested file. Defaults to JS for the
            // legacy /js/* callers; adds CSS so /css/* doesn't get served as application/javascript
            // (which breaks <link rel="stylesheet"> in strict-MIME browsers).
            string contentType = "application/javascript";
            if (resourcePath.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
                contentType = "text/css";
            else if (resourcePath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                contentType = "application/json";
            else if (resourcePath.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
                contentType = "text/html";

            // DevMode: no-cache so the browser always re-fetches after a server restart,
            // useful when iterating on JS without bumping the version number.
            // Production: the script URL includes ?v={version}-{dllTimestamp}, so the URL
            // changes on every build and immutable caching is safe.
            var devMode = JellyfinEnhanced.Instance?.Configuration?.DevMode == true;
            Response.Headers["Cache-Control"] = devMode ? "no-store" : "public, max-age=31536000, immutable";
            return new FileStreamResult(stream, contentType);
        }

        // ---- Whole-document writes of per-user documents (the POST routes kept for older pages and API clients) ----
        // Every read route hands out the document's revision (ETag) and every whole-document write sends back the one it read
        // (If-Match): the document is replaced only while it is still that revision, under its file lock
        // (UserConfigurationManager.ReplaceUserDocument). A write without one goes ahead only where nothing can be lost;
        // otherwise nothing is written and the writer is told (409 revision_conflict, with the current revision).

        /// <summary>The revision the writer read (If-Match), or null when it sent none.</summary>
        private string? RequestedRevision()
        {
            var value = Request?.Headers.IfMatch.ToString();
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }

        /// <summary>Hands out a per-user document's revision with the answer (ETag).</summary>
        private void AnswerRevision(string revision)
        {
            if (Response != null) Response.Headers.ETag = "\"" + revision + "\"";
        }

        /// <summary>
        /// Reads a per-user document with its revision. The revision is taken before the read, so a write landing in between
        /// leaves the revision older than the document (a whole write built on it is refused, never allowed); a read that
        /// itself wrote (a first read stores the defaults) reads once more behind the newer revision.
        /// </summary>
        private (T Document, string Revision) ReadWithRevision<T>(string authorizedUserId, string fileName, Func<T> read)
        {
            var revision = _userConfigurationManager.RevisionOf(authorizedUserId, fileName);
            var document = read();
            var after = _userConfigurationManager.RevisionOf(authorizedUserId, fileName);
            return after == revision ? (document, revision) : (read(), after);
        }

        /// <summary>
        /// A per-user document as a read answers it: its revision as the ETag and, when the client asked for it
        /// (<c>?withRevision=true</c>, for clients that can't read headers), the document and its revision in the body.
        /// </summary>
        private IActionResult DocumentAnswer(object document, string revision)
        {
            AnswerRevision(revision);
            var asked = Request?.Query["withRevision"].ToString();
            return string.Equals(asked, "true", StringComparison.OrdinalIgnoreCase) ? Ok(new { document, revision }) : Ok(document);
        }

        /// <summary>
        /// A whole-document write refused because the stored document isn't the one the writer read. One sent without any
        /// revision from a signed-in page is a page of an earlier JE build (the current one never writes a document whole): its
        /// session is also told to reload, so the change it couldn't save isn't lost silently (ClientReloadNotice).
        /// </summary>
        private IActionResult RevisionConflict(string fileName, string revision)
        {
            AnswerRevision(revision);
            if (RequestedRevision() == null) Services.ClientReloadNotice.Send(_sessionManager, User, Services.ClientReloadNotice.SettingsText, _logger);
            return StatusCode(409, new
            {
                success = false,
                code = "revision_conflict",
                file = fileName,
                revision,
                message = $"{fileName} has changed since it was read, so it was not replaced. Read it again and make the change to what it holds now.",
            });
        }

        /// <summary>
        /// Replaces a per-user document whole through the revision gate. Null when it is stored (or already was); otherwise
        /// the answer (no document, or a conflict).
        /// </summary>
        private IActionResult? FencedReplace<T>(string authorizedUserId, string fileName, T? document, out UserConfigurationManager.DocumentWrite outcome, Action<T, T>? prepare = null) where T : class, new()
        {
            outcome = UserConfigurationManager.DocumentWrite.Unchanged;
            if (document == null) return BadRequest(new { success = false, message = $"A {fileName} document is required." });
            var (written, revision, _) = _userConfigurationManager.ReplaceUserDocument(authorizedUserId, fileName, document, RequestedRevision(), prepare);
            outcome = written;
            if (written == UserConfigurationManager.DocumentWrite.Conflict)
            {
                _logger.Info($"Refused a stale {fileName} for {ResolveUserDisplay(authorizedUserId)} (its revision isn't the stored one).");
                return RevisionConflict(fileName, revision);
            }

            AnswerRevision(revision);
            return null;
        }

        private IActionResult? AuthorizeUserConfigAccess(string requestedUserId, out string authorizedUserId)
        {
            authorizedUserId = string.Empty;

            if (string.IsNullOrWhiteSpace(requestedUserId))
            {
                return BadRequest(new { message = "userId is required." });
            }

            if (!Guid.TryParse(requestedUserId, out var parsedUserId) && !Guid.TryParseExact(requestedUserId, "N", out parsedUserId))
            {
                return BadRequest(new { message = "Invalid userId format." });
            }

            var effectiveUserId = UserHelper.GetUserId(User, parsedUserId);
            if (!effectiveUserId.HasValue)
            {
                return Forbid();
            }

            // UserConfigurationManager expects folder names in N format (without dashes).
            authorizedUserId = effectiveUserId.Value.ToString("N");
            return null;
        }

        private IActionResult? AuthorizeUserAccess(Guid requestedUserId, out JUser user)
        {
            user = null!;
            var effectiveUserId = UserHelper.GetUserId(User, requestedUserId);
            if (!effectiveUserId.HasValue)
            {
                return Forbid();
            }

            var resolvedUser = _userManager.GetUserById(effectiveUserId.Value);
            if (resolvedUser is null)
            {
                return NotFound();
            }

            user = resolvedUser;
            return null;
        }

        // previously a single `User.IsInRole("Administrator")`
        // magic-string check. Cross-check against the IUserManager-resolved
        // Jellyfin user's actual `IsAdministrator` permission so a future
        // Jellyfin core role-name rename can't silently downgrade JE's
        // admin gates. Falls back to the role claim if the user lookup
        // fails (which would be a programmer error since `[Authorize]`
        // gates every admin endpoint).
        /// <summary>
        /// The credential a configuration-page Test button means: a typed value as is, a masked saved
        /// value (or an unsaved Import-from-Seerr handle) resolved server-side, so saved keys never
        /// have to travel to the browser. "" when nothing usable was submitted.
        /// </summary>
        private static string ResolveSubmittedSecret(string? submitted, string? storeName, string? targetUrl = null, IEnumerable<string?>? savedUrls = null)
        {
            var store = JellyfinEnhanced.Instance?.Secrets;
            if (store != null) return store.ResolveSubmitted(submitted, storeName, targetUrl, savedUrls);
            submitted = Services.Secrets.SecretValue.FromWire(submitted);
            return string.IsNullOrWhiteSpace(submitted) || Services.Secrets.SecretValue.IsPlaceholder(submitted) ? string.Empty : submitted.Trim();
        }

        /// <summary>The configured Seerr URLs (newline or comma separated).</summary>
        private static IEnumerable<string?> SavedSeerrUrls()
            => (JellyfinEnhanced.Instance?.Configuration?.JellyseerrUrls ?? string.Empty)
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        private bool IsAdminUser()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var jfUserId = UserHelper.GetCurrentUserId(User);
                if (!jfUserId.HasValue) return false;
                var u = _userManager.GetUserById(jfUserId.Value);
                return u != null && u.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch { return false; }
        }

        private bool IsAllowedUrl(string url)
        {
            var allowed = Jellyfin.Plugin.JellyfinEnhanced.Helpers.ArrUrlGuard.IsAllowedUrl(url);
            if (!allowed && !string.IsNullOrWhiteSpace(url))
            {
                // Log at Error so admins can diagnose "instance doesn't return data"
                // issues caused by a URL that hits the block list (e.g. metadata endpoints, loopback).
                _logger.Error($"IsAllowedUrl rejected outbound URL: {url}");
            }
            return allowed;
        }

        // Async variant used by request-path fan-out helpers so the DNS resolution inside the
        // shared guard doesn't block the request thread before the first await — otherwise N
        // instances serialize their DNS lookups in the Select() prelude (Codex pass-3 P2).
        private async Task<bool> IsAllowedUrlAsync(string url, CancellationToken ct)
        {
            var allowed = await Jellyfin.Plugin.JellyfinEnhanced.Helpers.ArrUrlGuard.IsAllowedUrlAsync(url, ct).ConfigureAwait(false);
            if (!allowed && !string.IsNullOrWhiteSpace(url))
            {
                _logger.Error($"IsAllowedUrl rejected outbound URL: {url}");
            }
            return allowed;
        }

        // Once-per-value dedup so corrupted instance config logs at Error on first hit and stops
        // spamming on subsequent reads. Keyed by the raw stored JSON so a corrupt→fix→corrupt
        // cycle gets a fresh log entry.
        private static readonly HashSet<string> _loggedCorruptArrConfig = new();
        private static readonly object _loggedCorruptArrConfigLock = new();

        private void WarnIfArrInstancesCorrupt(PluginConfiguration config)
        {
            if (config.IsSonarrInstancesCorrupt())
            {
                var key = "sonarr:" + (config.SonarrInstances ?? "");
                bool firstSeen;
                lock (_loggedCorruptArrConfigLock) firstSeen = _loggedCorruptArrConfig.Add(key);
                if (firstSeen)
                    _logger.Error("SonarrInstances config is corrupt JSON — instance list is effectively empty. "
                        + "Endpoints will return no Sonarr data until the admin opens the config page and resets it. "
                        + DescribeCorruptList(config.SonarrInstances));
            }
            if (config.IsRadarrInstancesCorrupt())
            {
                var key = "radarr:" + (config.RadarrInstances ?? "");
                bool firstSeen;
                lock (_loggedCorruptArrConfigLock) firstSeen = _loggedCorruptArrConfig.Add(key);
                if (firstSeen)
                    _logger.Error("RadarrInstances config is corrupt JSON — instance list is effectively empty. "
                        + "Endpoints will return no Radarr data until the admin opens the config page and resets it. "
                        + DescribeCorruptList(config.RadarrInstances));
            }
        }

        // Never the value itself: an unreadable instance list may contain API keys.
        internal static string DescribeCorruptList(string? value)
        {
            if (string.Equals(value, Services.Secrets.SecretsMigration.CorruptListMarker, StringComparison.Ordinal))
                return "Its original text was moved to the secrets store (see the Stored credentials docs).";
            var bytes = System.Text.Encoding.UTF8.GetBytes(value ?? string.Empty);
            return $"Stored value: {bytes.Length} bytes, SHA-256 {Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes))[..12].ToLowerInvariant()}.";
        }

        private bool TryResolveBrandingFilePath(string requestedFileName, out string normalizedFileName, out string filePath)
        {
            normalizedFileName = Path.GetFileName(requestedFileName ?? string.Empty);
            filePath = string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedFileName) || !BrandingFileNames.Contains(normalizedFileName))
            {
                return false;
            }

            var brandingDir = JellyfinEnhanced.BrandingDirectory;
            if (string.IsNullOrWhiteSpace(brandingDir))
            {
                return false;
            }

            // The allowlist is case-insensitive, but the middleware and status endpoint
            // use fixed lowercase names. Normalize accepted aliases on case-sensitive hosts.
            normalizedFileName = normalizedFileName.ToLowerInvariant();
            var fullBrandingDir = Path.GetFullPath(brandingDir);
            var candidateFilePath = Path.GetFullPath(Path.Combine(fullBrandingDir, normalizedFileName));
            var candidateDirectory = Path.GetDirectoryName(candidateFilePath);

            if (!string.Equals(candidateDirectory, fullBrandingDir, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            filePath = candidateFilePath;
            return true;
        }

        [HttpGet("user-settings/{userId}/settings.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetUserSettingsSettings(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var (settings, revision) = ReadWithRevision(authorizedUserId, UserConfigurationManager.SettingsFileName, () => LoadUserSettings(authorizedUserId));
            return DocumentAnswer(SettingsDocument(settings), revision);
        }

        /// <summary>
        /// Loads (seeding defaults on first access) the user's settings.json document
        /// with the caller's IsAdmin flag applied. Shared by the settings.json
        /// endpoint and /bootstrap so both return exactly the same shape.
        /// </summary>
        private object LoadUserSettingsDocument(string authorizedUserId) => SettingsDocument(LoadUserSettings(authorizedUserId));

        /// <summary>The user's settings.json as stored (seeding defaults on first access).</summary>
        private JellyfinEnhancedUserSettings LoadUserSettings(string authorizedUserId)
        {
            // Populate defaults from plugin configuration if missing
            if (!_userConfigurationManager.UserConfigurationExists(authorizedUserId, "settings.json"))
            {
                var defaultConfig = JellyfinEnhanced.Instance?.Configuration;
                if (defaultConfig != null)
                {
                    var defaultUserSettings = UserSettingsDefaults.Create(defaultConfig);

                    // Under the person's settings lock, and only while they still have none (their own first save may
                    // have landed since the check above).
                    if (_userConfigurationManager.SeedUserSettings(authorizedUserId, defaultUserSettings))
                    {
                        _logger.Info($"Saved default settings.json for new user {ResolveUserDisplay(authorizedUserId)} from plugin configuration.");
                    }
                }
            }

            return _userConfigurationManager.GetUserConfiguration<JellyfinEnhancedUserSettings>(authorizedUserId, "settings.json");
        }

        /// <summary>A settings.json document as the settings routes hand it out (gated display language, the caller's IsAdmin).</summary>
        private object SettingsDocument(JellyfinEnhancedUserSettings userConfig)
        {
            // Handed out as the display-language gate stores it: a file written before the gate existed (or restored by an
            // older version) never gives the client a language to mirror into Jellyfin's shared key. The file isn't rewritten.
            userConfig.DisplayLanguage = LanguageTags.Sanitize(userConfig.DisplayLanguage);

            // IsAdmin reflects the CALLER's admin status (not the target user's, in the
            // rare admin-viewing-another-user's-settings case allowed by
            // AuthorizeUserConfigAccess). Computed fresh on every request from the
            // authenticated principal, never persisted to the settings file. Single
            // source of truth for every admin-gated JS module (js/enhanced/helpers.js).
            var settingsNode = System.Text.Json.JsonSerializer.SerializeToNode(userConfig) as System.Text.Json.Nodes.JsonObject;
            if (settingsNode != null)
            {
                settingsNode["IsAdmin"] = IsAdminUser();
                return settingsNode;
            }

            return userConfig;
        }

        [HttpGet("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetUserSettingsShortcuts(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var (userConfig, revision) = ReadWithRevision(authorizedUserId, "shortcuts.json",
                () => _userConfigurationManager.GetUserConfiguration<UserShortcuts>(authorizedUserId, "shortcuts.json"));
            return DocumentAnswer(userConfig, revision);
        }

        [HttpGet("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetUserSettingsElsewhere(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var (userConfig, revision) = ReadWithRevision(authorizedUserId, "elsewhere.json",
                () => _userConfigurationManager.GetUserConfiguration<ElsewhereSettings>(authorizedUserId, "elsewhere.json"));
            return DocumentAnswer(userConfig, revision);
        }

        [HttpPost("user-settings/{userId}/settings.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsSettings(string userId, [FromBody] JellyfinEnhancedUserSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                // Phase 4: the person's consents are their own and change only through the consent operation below. This
                // save replaces the whole file (the person's own or an administrator's) and keeps every consent as stored.
                // Read, kept, compared and saved under the person's settings lock.
                if (userConfiguration == null) return BadRequest(new { success = false, message = "A settings.json document is required." });
                // Replaced only as a change of the revision the writer read (If-Match), like every whole-document write.
                var (outcome, changes, revision) = _userConfigurationManager.SaveUserSettings(authorizedUserId, userConfiguration, RequestedRevision());
                if (outcome == UserConfigurationManager.DocumentWrite.Conflict)
                {
                    _logger.Info($"Refused a stale settings.json for {ResolveUserDisplay(authorizedUserId)} (its revision isn't the stored one).");
                    return RevisionConflict("settings.json", revision);
                }

                AnswerRevision(revision);
                if (outcome == UserConfigurationManager.DocumentWrite.Saved && changes.Count > 0)
                {
                    _logger.Info($"Saved user settings for {ResolveUserDisplay(authorizedUserId)}: {string.Join(", ", changes)}");
                }

                // The display language as stored (the gate's answer), which the client mirrors instead of what it sent.
                return Ok(new { success = true, file = "settings.json", consents = UserConfigurationManager.ConsentsOf(userConfiguration), displayLanguage = userConfiguration.DisplayLanguage });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user settings for user {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user settings." });
            }
        }

        /// <summary>An explicit personal consent change. A whole-document save never changes these fields.</summary>
        public sealed class PersonalConsentChange
        {
            private bool? _value;

            /// <summary>The exact consent field name (<see cref="UserConfigurationManager.PersonalConsents"/>).</summary>
            public string? Field { get; set; }

            /// <summary>
            /// The intended consent. A missing value is not a choice; null is one only for a consent that can follow the
            /// administrator (the automatic requests).
            /// </summary>
            public bool? Value
            {
                get => _value;
                set { _value = value; Chosen = true; }
            }

            /// <summary>The body named a value (null included).</summary>
            [System.Text.Json.Serialization.JsonIgnore]
            [Newtonsoft.Json.JsonIgnore]
            public bool Chosen { get; private set; }
        }

        /// <summary>Sets one consent for the authenticated person themselves, never on behalf of another user.</summary>
        [HttpPatch("user-settings/{userId}/consent")]
        [Authorize]
        [BodyLimit]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult SetUserSettingsConsent(string userId, [FromBody] PersonalConsentChange change)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            if (UserHelper.GetCurrentUserId(User)?.ToString("N") != authorizedUserId) return Forbid();
            if (change?.Field == null || !change.Chosen)
                return BadRequest(new { code = "invalid_consent", message = "A consent field and value are required." });
            try
            {
                var settings = _userConfigurationManager.SetPersonalConsent(authorizedUserId, change.Field, change.Value, out var revision);
                AnswerRevision(revision);
                return Ok(new { success = true, consents = UserConfigurationManager.ConsentsOf(settings), displayLanguage = settings.DisplayLanguage, revision });
            }
            catch (ArgumentException)
            {
                return BadRequest(new { code = "invalid_consent", message = "Unknown personal consent field, or no choice for it." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save personal consent for user {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save personal consent." });
            }
        }

        /// <summary>
        /// A change to a per-user document as the operations the client made: <c>Set</c> (field → value) for settings.json and
        /// elsewhere.json, <c>Upsert</c> (key → record) and <c>Remove</c> (keys) for bookmark.json (bookmark ids) and
        /// shortcuts.json (shortcut names), <c>Add</c> and <c>Remove</c> (topic ids) for ddd-triggers.json. The server applies
        /// them to the document it holds now, so what another tab or device changed since this client's read stays.
        /// </summary>
        public sealed class UserDocumentPatch
        {
            /// <summary>Fields to set.</summary>
            public Dictionary<string, System.Text.Json.JsonElement>? Set { get; set; }

            /// <summary>Records to add or replace, by key.</summary>
            public Dictionary<string, System.Text.Json.JsonElement>? Upsert { get; set; }

            /// <summary>Items to add (ddd-triggers.json).</summary>
            public List<System.Text.Json.JsonElement>? Add { get; set; }

            /// <summary>Keys or items to remove.</summary>
            public List<System.Text.Json.JsonElement>? Remove { get; set; }
        }

        private const int UserDocumentPatchBytes = 1024 * 1024;

        private static readonly System.Text.Json.JsonSerializerOptions UserDocumentReadOptions = new() { PropertyNameCaseInsensitive = true };

        private static string? PatchKey(System.Text.Json.JsonElement e) => e.ValueKind switch
        {
            System.Text.Json.JsonValueKind.String => e.GetString(),
            System.Text.Json.JsonValueKind.Number => e.GetRawText(),
            _ => null,
        };

        /// <summary>Applies field changes to the person's settings.json (consents excepted: see the consent operation).</summary>
        [HttpPatch("user-settings/{userId}/settings.json")]
        [Authorize]
        [BodyLimit(UserDocumentPatchBytes)]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult PatchUserSettingsSettings(string userId, [FromBody] UserDocumentPatch? patch)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            try
            {
                var (settings, changes, revision) = _userConfigurationManager.PatchUserSettingsRevision(authorizedUserId, patch?.Set,
                    () => JellyfinEnhanced.Instance?.Configuration is { } c ? UserSettingsDefaults.Create(c) : new JellyfinEnhancedUserSettings());
                if (changes.Count > 0) _logger.Info($"Saved user settings for {ResolveUserDisplay(authorizedUserId)}: {string.Join(", ", changes)}");
                AnswerRevision(revision);
                return Ok(new { success = true, file = "settings.json", consents = UserConfigurationManager.ConsentsOf(settings), displayLanguage = settings.DisplayLanguage, document = SettingsDocument(settings), revision });
            }
            catch (UserDocumentPatchException ex)
            {
                return BadRequest(new { success = false, code = "invalid_patch", message = ex.Message });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user settings for user {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user settings." });
            }
        }

        /// <summary>Adds or replaces bookmarks by id and removes others, keeping every bookmark the patch doesn't name.</summary>
        [HttpPatch("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [BodyLimit(UserDocumentPatchBytes)]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult PatchUserBookmark(string userId, [FromBody] UserDocumentPatch? patch)
        {
            return PatchUserDocument<UserBookmark>(userId, "bookmark.json", patch, (doc, p) =>
            {
                var n = 0;
                foreach (var key in (p.Remove ?? new List<System.Text.Json.JsonElement>()).Select(PatchKey))
                {
                    if (key != null && doc.Bookmarks.Remove(key)) n++;
                }

                foreach (var (id, value) in p.Upsert ?? new Dictionary<string, System.Text.Json.JsonElement>())
                {
                    if (string.IsNullOrWhiteSpace(id)) continue;
                    doc.Bookmarks[id] = value.Deserialize<BookmarkItem>(UserDocumentReadOptions) ?? throw new UserDocumentPatchException($"Bookmark {id} is empty.");
                    n++;
                }

                return n;
            });
        }

        /// <summary>Adds and removes Does the Dog Die topic ids, keeping every other pick.</summary>
        [HttpPatch("user-settings/{userId}/ddd-triggers.json")]
        [Authorize]
        [BodyLimit(UserDocumentPatchBytes)]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult PatchUserSettingsDdd(string userId, [FromBody] UserDocumentPatch? patch)
        {
            return PatchUserDocument<DddSettings>(userId, "ddd-triggers.json", patch, (doc, p) =>
            {
                static int Topic(System.Text.Json.JsonElement e) => e.ValueKind == System.Text.Json.JsonValueKind.Number && e.TryGetInt32(out var id)
                    ? id : throw new UserDocumentPatchException("A trigger is a topic id (a number).");
                var n = 0;
                var remove = (p.Remove ?? new List<System.Text.Json.JsonElement>()).Select(Topic).ToHashSet();
                n += doc.Triggers.RemoveAll(remove.Contains);
                foreach (var id in (p.Add ?? new List<System.Text.Json.JsonElement>()).Select(Topic))
                {
                    if (doc.Triggers.Contains(id)) continue;
                    doc.Triggers.Add(id);
                    n++;
                }

                return n;
            });
        }

        /// <summary>Adds or replaces shortcuts by name and removes others, keeping every shortcut the patch doesn't name.</summary>
        [HttpPatch("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        [BodyLimit(UserDocumentPatchBytes)]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult PatchUserSettingsShortcuts(string userId, [FromBody] UserDocumentPatch? patch)
        {
            return PatchUserDocument<UserShortcuts>(userId, "shortcuts.json", patch, (doc, p) =>
            {
                var n = 0;
                foreach (var name in (p.Remove ?? new List<System.Text.Json.JsonElement>()).Select(PatchKey))
                {
                    if (name != null) n += doc.Shortcuts.RemoveAll(s => string.Equals(s.Name, name, StringComparison.Ordinal));
                }

                foreach (var (name, value) in p.Upsert ?? new Dictionary<string, System.Text.Json.JsonElement>())
                {
                    var shortcut = value.Deserialize<Shortcut>(UserDocumentReadOptions) ?? throw new UserDocumentPatchException($"Shortcut {name} is empty.");
                    shortcut.Name = name;
                    var index = doc.Shortcuts.FindIndex(s => string.Equals(s.Name, name, StringComparison.Ordinal));
                    if (index >= 0) doc.Shortcuts[index] = shortcut; else doc.Shortcuts.Add(shortcut);
                    n++;
                }

                return n;
            });
        }

        /// <summary>Applies field changes to the person's elsewhere.json.</summary>
        [HttpPatch("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        [BodyLimit(UserDocumentPatchBytes)]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult PatchUserSettingsElsewhere(string userId, [FromBody] UserDocumentPatch? patch)
        {
            return PatchUserDocument<ElsewhereSettings>(userId, "elsewhere.json", patch, (doc, p) =>
            {
                var updated = UserConfigurationManager.ApplyFieldChanges(doc, p.Set);
                doc.Region = updated.Region;
                doc.Regions = updated.Regions;
                doc.Services = updated.Services;
                doc.SeasonProviders = updated.SeasonProviders;
                return 1;
            });
        }

        // Applies a patch to a per-user document under its file lock (strict read: a corrupt file is never overwritten) and
        // answers the document as stored afterwards.
        private IActionResult PatchUserDocument<T>(string userId, string fileName, UserDocumentPatch? patch, Func<T, UserDocumentPatch, int> apply) where T : class, new()
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            if (patch == null) return BadRequest(new { success = false, code = "invalid_patch", message = "A patch is required." });
            try
            {
                T? stored = null;
                var (_, revision) = _userConfigurationManager.RmwUserDocument<T>(authorizedUserId, fileName, doc =>
                {
                    stored = doc;
                    return apply(doc, patch);
                });
                AnswerRevision(revision);
                return Ok(new { success = true, file = fileName, document = stored, revision });
            }
            catch (Exception ex) when (ex is UserDocumentPatchException or System.Text.Json.JsonException)
            {
                return BadRequest(new { success = false, code = "invalid_patch", message = ex.Message });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save {fileName} for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = $"Failed to save {fileName}." });
            }
        }

        [HttpPost("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsShortcuts(string userId, [FromBody] UserShortcuts userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                var refused = FencedReplace(authorizedUserId, "shortcuts.json", userConfiguration, out _);
                if (refused != null) return refused;
                _logger.Info($"Saved user shortcuts for {ResolveUserDisplay(authorizedUserId)} to shortcuts.json");
                return Ok(new { success = true, file = "shortcuts.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user shortcuts for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user shortcuts." });
            }
        }

        [HttpGet("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetUserBookmark(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var (userConfig, revision) = ReadWithRevision(authorizedUserId, "bookmark.json",
                () => _userConfigurationManager.GetUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json"));
            return DocumentAnswer(userConfig, revision);
        }

        [HttpPost("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserBookmark(string userId, [FromBody] UserBookmark userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                var refused = FencedReplace(authorizedUserId, "bookmark.json", userConfiguration, out _);
                if (refused != null) return refused;
                _logger.Info($"Saved enhanced bookmarks for {ResolveUserDisplay(authorizedUserId)} to bookmark.json");
                return Ok(new { success = true, file = "bookmark.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save enhanced bookmarks for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save enhanced bookmarks." });
            }
        }

        public sealed class AddBookmarkPayload
        {
            public string ItemId { get; set; } = string.Empty;
            public string TmdbId { get; set; } = string.Empty;
            public string TvdbId { get; set; } = string.Empty;
            public string MediaType { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public double Timestamp { get; set; }
            public string Label { get; set; } = string.Empty;
            public string SyncedFrom { get; set; } = string.Empty;
            public int? SeasonNumber { get; set; }
            public int? EpisodeNumber { get; set; }
        }

        [HttpPost("user-settings/{userId}/bookmark.json/add")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AddUserBookmark(string userId, [FromBody] AddBookmarkPayload payload)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || string.IsNullOrWhiteSpace(payload.ItemId))
            {
                return BadRequest(new { success = false, message = "ItemId is required." });
            }

            var now = DateTime.UtcNow.ToString("o");
            var bookmarkId = $"Bm_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid().ToString("N").Substring(0, 9)}";

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json", config =>
                {
                    config.Bookmarks[bookmarkId] = new BookmarkItem
                    {
                        ItemId = payload.ItemId,
                        TmdbId = payload.TmdbId ?? string.Empty,
                        TvdbId = payload.TvdbId ?? string.Empty,
                        MediaType = payload.MediaType ?? string.Empty,
                        Name = payload.Name ?? string.Empty,
                        Timestamp = payload.Timestamp,
                        Label = payload.Label ?? string.Empty,
                        CreatedAt = now,
                        UpdatedAt = now,
                        SyncedFrom = payload.SyncedFrom ?? string.Empty,
                        SeasonNumber = payload.SeasonNumber,
                        EpisodeNumber = payload.EpisodeNumber
                    };
                    return 1;
                });
                _logger.Info($"Added bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)}");
                return Ok(new { success = true, id = bookmarkId });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to add bookmark for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to add bookmark." });
            }
        }

        [HttpDelete("user-settings/{userId}/bookmark.json/{bookmarkId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult RemoveUserBookmark(string userId, string bookmarkId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (string.IsNullOrWhiteSpace(bookmarkId))
            {
                return BadRequest(new { success = false, message = "bookmarkId is required." });
            }

            try
            {
                var removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json", config =>
                {
                    removed = config.Bookmarks.Remove(bookmarkId);
                    return removed ? 1 : 0;
                });

                if (!removed)
                {
                    return NotFound(new { success = false, removed = false, message = "No matching bookmark to remove." });
                }

                _logger.Info($"Removed bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)}");
                return Ok(new { success = true, removed = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to remove bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to remove bookmark." });
            }
        }

        [HttpPost("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsElsewhere(string userId, [FromBody] ElsewhereSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                var refused = FencedReplace(authorizedUserId, "elsewhere.json", userConfiguration, out _);
                if (refused != null) return refused;
                _logger.Info($"Saved user elsewhere settings for {ResolveUserDisplay(authorizedUserId)} to elsewhere.json");
                return Ok(new { success = true, file = "elsewhere.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user elsewhere settings for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user elsewhere settings." });
            }
        }

        [HttpGet("user-settings/{userId}/hidden-content.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetUserHiddenContent(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var (hidden, revision) = ReadWithRevision(authorizedUserId, "hidden-content.json", () => LoadUserHiddenContentDocument(authorizedUserId));
            return DocumentAnswer(hidden, revision);
        }

        /// <summary>
        /// Loads (seeding defaults on first access) the user's hidden-content.json
        /// document. Shared by the hidden-content.json endpoint and /bootstrap.
        /// </summary>
        private UserHiddenContent LoadUserHiddenContentDocument(string authorizedUserId)
        {
            // First-time init: seed Settings from admin defaults under RMW so a parallel CW hide can't clobber it.
            var defaultConfig = JellyfinEnhanced.Instance?.Configuration;
            if (defaultConfig != null
                && !_userConfigurationManager.UserConfigurationExists(authorizedUserId, "hidden-content.json"))
            {
                try
                {
                    _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                        authorizedUserId, "hidden-content.json", hc =>
                        {
                            // Re-check inside the lock: another writer may have created the file in the meantime.
                            if (hc.Items.Count > 0) return 0;
                            hc.Settings = BuildHcDefaultSettings(defaultConfig);
                            _logger.Info($"Seeded default hidden-content.json for new user {ResolveUserDisplay(authorizedUserId)} from plugin configuration.");
                            return 1;
                        });
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Failed to seed hidden-content.json for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                }
            }

            var document = _userConfigurationManager.GetUserConfiguration<UserHiddenContent>(authorizedUserId, "hidden-content.json");
            document.Revision = Services.HiddenContentPolicy.RulesRevision(document);
            return document;
        }

        private static HiddenContentSettings BuildHcDefaultSettings(PluginConfiguration src)
        {
            return new HiddenContentSettings
            {
                Enabled = src.HiddenContentDefaultEnabled,
                ShowHideButtons = src.HiddenContentDefaultShowHideButtons,
                ShowHideConfirmation = src.HiddenContentDefaultShowHideConfirmation,
                ShowButtonJellyseerr = src.HiddenContentDefaultShowButtonJellyseerr,
                ShowButtonLibrary = src.HiddenContentDefaultShowButtonLibrary,
                ShowButtonDetails = src.HiddenContentDefaultShowButtonDetails,
                ShowButtonCast = src.HiddenContentDefaultShowButtonCast,
                FilterLibrary = src.HiddenContentDefaultFilterLibrary,
                FilterDiscovery = src.HiddenContentDefaultFilterDiscovery,
                FilterSearch = src.HiddenContentDefaultFilterSearch,
                FilterCalendar = src.HiddenContentDefaultFilterCalendar,
                FilterUpcoming = src.HiddenContentDefaultFilterUpcoming,
                FilterRecommendations = src.HiddenContentDefaultFilterRecommendations,
                FilterRequests = src.HiddenContentDefaultFilterRequests,
                FilterNextUp = src.HiddenContentDefaultFilterNextUp,
                FilterContinueWatching = src.HiddenContentDefaultFilterContinueWatching,
                ExperimentalHideCollections = src.HiddenContentDefaultExperimentalHideCollections,
            };
        }

        [HttpPost("user-settings/{userId}/hidden-content.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserHiddenContent(string userId, [FromBody] UserHiddenContent userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (userConfiguration == null)
            {
                return BadRequest(new { success = false, message = "Invalid hidden content payload." });
            }

            try
            {
                try
                {
                    // Under the file lock: a strict read first (a corrupt existing file 503s + backs up instead of being
                    // overwritten), then the revision gate (an older tab's document never replaces a newer one).
                    // Play edge (D46 rules): the stored document carries its rules revision for the rule routes' answers.
                    // Both sides are stamped before they are compared (the stored copy only in memory): a document saved
                    // before the stamp existed, sent back as it is stored, is unchanged, not a write that needs If-Match.
                    var refused = FencedReplace(authorizedUserId, "hidden-content.json", userConfiguration, out var outcome, static (posted, stored) =>
                    {
                        posted.Revision = Services.HiddenContentPolicy.RulesRevision(posted);
                        stored.Revision = Services.HiddenContentPolicy.RulesRevision(stored);
                    });
                    if (refused != null) return refused;
                    if (outcome == UserConfigurationManager.DocumentWrite.Unchanged) return Ok(new { success = true, file = "hidden-content.json" });
                }
                catch (Exception strictEx) when (strictEx is InvalidDataException
                                              || strictEx is Newtonsoft.Json.JsonException)
                {
                    _logger.Warning($"hidden-content.json corrupt for {ResolveUserDisplay(authorizedUserId)} (backed up): {strictEx.Message}");
                    return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
                }
                catch (IOException ioEx)
                {
                    _logger.Warning($"hidden-content.json temporarily unreadable for {ResolveUserDisplay(authorizedUserId)}: {ioEx.Message}");
                    return StatusCode(500, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
                }

                Services.HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                _logger.Info($"Saved hidden content for {ResolveUserDisplay(authorizedUserId)} to hidden-content.json");
                return Ok(new { success = true, file = "hidden-content.json", revision = userConfiguration.Revision });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save hidden content for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save hidden content." });
            }
        }

        /// <summary>Atomically upserts one durable provider hide without replacing another tab's rules.</summary>
        [HttpPut("user-settings/{userId}/hidden-content/rule/{key}")]
        [Authorize]
        [RequestSizeLimit(16384)]
        public IActionResult PutHiddenContentRule(string userId, string key, [FromBody] HiddenContentItem item)
            => MutateHiddenContentRule(userId, key, item);

        /// <summary>Atomically removes a provider hide and its compatible legacy aliases.</summary>
        [HttpDelete("user-settings/{userId}/hidden-content/rule/{key}")]
        [Authorize]
        public IActionResult DeleteHiddenContentRule(string userId, string key)
            => MutateHiddenContentRule(userId, key, null);

        private IActionResult MutateHiddenContentRule(string userId, string key, HiddenContentItem? item)
        {
            var denied = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (denied != null) return denied;
            var canonical = Services.HiddenContentPolicy.CanonicalTitle(key);
            if (canonical == null || (item != null && (Services.HiddenContentPolicy.TitleIdentity(item.Type, item.TmdbId) != canonical
                || !string.IsNullOrEmpty(item.ItemId) || !string.IsNullOrEmpty(item.SeriesId)
                || item.HideScope != "global" || item.Name.Length > 500 || item.PosterPath.Length > 500)))
                return BadRequest(new { success = false, code = "invalid_title_rule" });
            try
            {
                // One rule applied to the document the server holds now, under its file lock (an operation: no revision of the
                // writer's to compare), through the operation helper; the answer carries the document's revision.
                IActionResult? refused = null;
                UserHiddenContent? stored = null;
                var (_, revision) = _userConfigurationManager.RmwUserDocument<UserHiddenContent>(authorizedUserId, "hidden-content.json", data =>
                {
                    var aliases = data.Items.Where(p => (Services.HiddenContentPolicy.TitleIdentity(p.Value.Type, p.Value.TmdbId)
                        ?? Services.HiddenContentPolicy.CanonicalTitle(p.Key)) == canonical && (p.Value.HideScope is "global" or ""))
                        .Select(p => p.Key).ToArray();
                    if (item != null)
                    {
                        if (data.Items.Count >= 10000 && aliases.Length == 0)
                        {
                            refused = BadRequest(new { success = false, code = "too_many_rules" });
                            return 0;
                        }

                        var oldest = aliases.Select(k => data.Items[k].HiddenAt).Where(v => !string.IsNullOrEmpty(v)).OrderBy(v => v, StringComparer.Ordinal).FirstOrDefault();
                        item.HiddenAt = oldest ?? DateTimeOffset.UtcNow.ToString("O");
                        foreach (var alias in aliases) data.Items.Remove(alias);
                        data.Items[canonical] = item;
                    }
                    else foreach (var alias in aliases) data.Items.Remove(alias);
                    stored = data;
                    return 1;
                });
                if (refused != null) return refused;
                Services.HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                Response.Headers["Cache-Control"] = "private, no-store";
                // The document's revision (it counts writes, like every document route's): the client's settings store orders
                // this answer with its own saves' answers by it (a content hash can't be ordered).
                AnswerRevision(revision);
                return Ok(new { success = true, key = canonical, hidden = item != null, item, items = stored!.Items, revision });
            }
            catch (Exception ex) when (ex is IOException or Newtonsoft.Json.JsonException)
            {
                _logger.Warning("Hidden Content rule store unavailable; no change saved.");
                return StatusCode(503, new { success = false, code = "hidden_store_unavailable" });
            }
        }

        /// <summary>
        /// Applies the person's Hidden Content changes to the hidden-content.json the server holds now, under its file lock:
        /// <c>Upsert</c> (item key → item) adds or replaces items, <c>Remove</c> (item keys) removes them (with the same item
        /// stored under another spelling of its id), <c>Set</c> (setting → value) changes settings. Every item and setting the
        /// patch doesn't name stays, so what another tab or device hid or changed meanwhile is kept. Answers the document as
        /// stored afterwards.
        /// </summary>
        [HttpPatch("user-settings/{userId}/hidden-content.json")]
        [Authorize]
        [BodyLimit(UserDocumentPatchBytes)]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult PatchUserHiddenContent(string userId, [FromBody] UserDocumentPatch? patch)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null) return authorizationResult;
            if (patch == null) return BadRequest(new { success = false, code = "invalid_patch", message = "A patch is required." });
            try
            {
                UserHiddenContent? stored = null;
                var (changed, revision) = _userConfigurationManager.RmwUserDocument<UserHiddenContent>(authorizedUserId, "hidden-content.json", doc =>
                {
                    stored = doc;
                    return ApplyHiddenContentPatch(doc, patch);
                });
                if (changed > 0) Services.HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                AnswerRevision(revision);
                return Ok(new { success = true, file = "hidden-content.json", document = stored, revision });
            }
            catch (Exception ex) when (ex is UserDocumentPatchException or System.Text.Json.JsonException)
            {
                return BadRequest(new { success = false, code = "invalid_patch", message = ex.Message });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                _logger.Warning($"hidden-content.json corrupt for {ResolveUserDisplay(authorizedUserId)} (backed up): {ex.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (IOException ioEx)
            {
                _logger.Warning($"hidden-content.json temporarily unreadable for {ResolveUserDisplay(authorizedUserId)}: {ioEx.Message}");
                return StatusCode(500, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save hidden content for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save hidden content." });
            }
        }

        // An item id as compared: the server stores ids dashed, cards carry them undashed.
        private static string CanonicalHiddenId(string? id) => (id ?? string.Empty).Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant();

        /// <summary>Applies a Hidden Content patch to the stored document; returns how many items and settings it changed.</summary>
        internal static int ApplyHiddenContentPatch(UserHiddenContent doc, UserDocumentPatch patch)
        {
            doc.Items ??= new Dictionary<string, HiddenContentItem>();
            var n = 0;
            foreach (var key in (patch.Remove ?? new List<System.Text.Json.JsonElement>()).Select(PatchKey))
            {
                if (string.IsNullOrEmpty(key)) continue;
                var wanted = CanonicalHiddenId(key);
                foreach (var stored in doc.Items.Keys.ToList())
                {
                    if (stored == key || (wanted.Length > 0 && (CanonicalHiddenId(stored) == wanted || CanonicalHiddenId(doc.Items[stored]?.ItemId) == wanted)))
                    {
                        doc.Items.Remove(stored);
                        n++;
                    }
                }
            }

            foreach (var (key, value) in patch.Upsert ?? new Dictionary<string, System.Text.Json.JsonElement>())
            {
                // Keys are dictionary lookups (never paths); the length cap is light defence against pathological payloads.
                if (string.IsNullOrWhiteSpace(key) || key.Length > 256) throw new UserDocumentPatchException("A hidden item needs a key of at most 256 characters.");
                doc.Items[key] = value.Deserialize<HiddenContentItem>(UserDocumentReadOptions) ?? throw new UserDocumentPatchException($"Hidden item {key} is empty.");
                n++;
            }

            if (patch.Set is { Count: > 0 } set)
            {
                doc.Settings = UserConfigurationManager.ApplyFieldChanges(doc.Settings ?? new HiddenContentSettings(), set);
                n++;
            }

            if (n > 0) doc.Revision = Services.HiddenContentPolicy.RulesRevision(doc); // play edge: D46 rules revision
            return n;
        }

        // Self-or-admin accessor pair for spoilerblur.json, mirroring the other
        // per-user files — otherwise it would be the only per-user JE file an
        // administrator cannot inspect or repair remotely.
        [HttpGet("user-settings/{userId}/spoilerblur.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetUserSpoilerBlur(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // Lenient read on purpose: this is an inspection surface, so a corrupt
            // file should still return the (empty) default rather than 503 — the
            // user-facing spoiler-blur endpoints already handle strict reads,
            // backups and corruption reporting.
            var (state, revision) = ReadWithRevision(authorizedUserId, Services.SpoilerBlurImageFilter.SpoilerBlurFileName,
                () => _userConfigurationManager.GetUserConfiguration<UserSpoilerBlur>(authorizedUserId, Services.SpoilerBlurImageFilter.SpoilerBlurFileName));
            return DocumentAnswer(state, revision);
        }

        // Hard cap per spoiler-list dict on the raw full-state save endpoint:
        // the image/field-strip filters iterate this file every request
        // (IsMovieInSpoilerScope does a library lookup per Collections key), so
        // an unbounded payload amplifies into millions of GetItemById calls per
        // library view. Mirrors the pending path's MaxPendingTmdbPerUser cap
        // this endpoint would otherwise bypass.
        private const int MaxSpoilerEntriesPerDict = 1000;

        [HttpPost("user-settings/{userId}/spoilerblur.json")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        // Cap the body: 4×1000 entries is a few hundred KB even with long names.
        // 2 MB leaves headroom while removing Kestrel's ~28 MB default as a DoS lever.
        [RequestSizeLimit(2 * 1024 * 1024)]
        public IActionResult SaveUserSpoilerBlur(string userId, [FromBody] UserSpoilerBlur userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (userConfiguration == null)
            {
                return BadRequest(new { success = false, message = "Invalid Spoiler Guard payload." });
            }

            // Reject oversized payloads rather than silently truncating — dropping
            // entries would confuse a legitimate large list, and over-cap is buggy or hostile.
            if (userConfiguration.Series.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.Movies.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.Collections.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.PendingTmdb.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.ProviderTitles.Count > MaxSpoilerEntriesPerDict)
            {
                _logger.Warning($"Rejecting oversized Spoiler Guard payload for {ResolveUserDisplay(authorizedUserId)} (series={userConfiguration.Series.Count}, movies={userConfiguration.Movies.Count}, collections={userConfiguration.Collections.Count}, pending={userConfiguration.PendingTmdb.Count}; cap {MaxSpoilerEntriesPerDict}).");
                return StatusCode(413, new { success = false, message = $"Spoiler Guard list exceeds the maximum of {MaxSpoilerEntriesPerDict} entries per category." });
            }

            if (userConfiguration.ProviderTitles.Keys.Any(key => Services.HiddenContentPolicy.CanonicalTitle(key) == null))
                return BadRequest(new { success = false, message = "Invalid provider title rule." });

            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            // Snapshot pre-write pending keys to diff the promoter gate after save:
            // this endpoint is a pending writer too and must keep the gate in sync.
            HashSet<string> priorPending;
            try
            {
                var prior = _userConfigurationManager.GetUserConfiguration<UserSpoilerBlur>(authorizedUserId, fileName);
                priorPending = new HashSet<string>(prior.PendingTmdb.Keys.Concat(prior.ProviderTitles.Keys.Select(key => key.ToLowerInvariant().Replace(":tmdb:", ":", StringComparison.Ordinal))), StringComparer.OrdinalIgnoreCase);
            }
            catch
            {
                priorPending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            }

            try
            {
                try
                {
                    // Under the file lock: a strict read first (a corrupt existing file 503s + backs up instead of being
                    // silently overwritten, as for hidden-content), then the revision gate (an older tab's document never
                    // replaces a newer one).
                    var refused = FencedReplace(authorizedUserId, fileName, userConfiguration, out _);
                    if (refused != null) return refused;
                }
                catch (Exception strictEx) when (strictEx is InvalidDataException
                                              || strictEx is Newtonsoft.Json.JsonException)
                {
                    _logger.Warning($"{fileName} corrupt for {ResolveUserDisplay(authorizedUserId)} (backed up): {strictEx.Message}");
                    return StatusCode(503, new { success = false, message = "Spoiler Guard store is corrupt; backed up. Please retry." });
                }
                catch (IOException ioEx)
                {
                    _logger.Warning($"{fileName} temporarily unreadable for {ResolveUserDisplay(authorizedUserId)}: {ioEx.Message}");
                    return StatusCode(500, new { success = false, message = "Spoiler Guard store is temporarily unavailable. Please retry." });
                }

                // Reconcile the promoter's fast-path gate with the new PendingTmdb
                // set: register keys the payload added, unregister keys it removed.
                // Registration is idempotent, so re-registering survivors is harmless.
                if (Guid.TryParseExact(authorizedUserId, "N", out var gateUserId))
                {
                    foreach (var key in userConfiguration.PendingTmdb.Keys.Concat(userConfiguration.ProviderTitles.Keys.Select(key => key.ToLowerInvariant().Replace(":tmdb:", ":", StringComparison.Ordinal))))
                    {
                        Services.SpoilerSeerrPendingPromoter.RegisterPending(key, gateUserId);
                    }
                    foreach (var stale in priorPending)
                    {
                        if (!userConfiguration.PendingTmdb.ContainsKey(stale) && !userConfiguration.ProviderTitles.ContainsKey(stale.Replace(":", ":tmdb:", StringComparison.Ordinal)))
                        {
                            Services.SpoilerSeerrPendingPromoter.UnregisterPending(stale, gateUserId);
                        }
                    }
                }

                _logger.Info($"Saved Spoiler Guard state for {ResolveUserDisplay(authorizedUserId)} to {fileName}");
                return Ok(new { success = true, file = fileName });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save Spoiler Guard state for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save Spoiler Guard state." });
            }
        }

        // ─── Admin cross-user hidden-content visibility ───
        // Lets an admin see what other users have hidden, surfaced as a read-only user filter on
        // the Hidden Content page/tab. Both endpoints are admin-gated server-side via IsAdminUser()
        // and never mutate another user's data — the client `isAdmin` flag is a UX convenience only,
        // never the security boundary. See js/enhanced/hiddencontent/hidden-content-page-*.js for the consuming UI.

        /// <summary>
        /// Admin-only: lists users who have hidden at least one item, together with their
        /// hidden-item count, to populate the admin user-filter dropdown on the Hidden Content page.
        /// The calling admin is excluded because their own list is shown via the default view.
        /// </summary>
        /// <remarks>
        /// Cost: O(users-with-a-config-dir) — deserialises each such user's hidden-content.json to read
        /// its item count. The client caches the result, but it re-fetches after a cache invalidation.
        /// Fine for typical user counts; revisit (cache counts / pre-filter on file size) if it grows.
        /// </remarks>
        [HttpGet("admin/hidden-content-users")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetHiddenContentUsers()
        {
            if (!IsAdminUser())
                return Forbid();

            // Honour the admin config toggle: the whole cross-user feature can be disabled.
            if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentAdmin != true)
                return Forbid();

            // The caller's own list is reachable through the default "My hidden content" option,
            // so omit them here to avoid a confusing duplicate entry.
            var currentUserIdN = UserHelper.GetCurrentUserId(User)?.ToString("N");

            // Enumerate only users that already have a config directory (GetAllUserIds), rather than
            // every Jellyfin user, so a pure read here never creates empty per-user folders as a side
            // effect. Anyone with hidden content necessarily already has a directory. This mirrors the
            // reset-all-users admin endpoint.
            var users = new List<(string UserId, string UserName, int Count)>();
            foreach (var userIdN in _userConfigurationManager.GetAllUserIds())
            {
                if (string.Equals(userIdN, currentUserIdN, StringComparison.OrdinalIgnoreCase))
                    continue;

                try
                {
                    // Skip stale directories left by deleted users — only surface current accounts.
                    if (!Guid.TryParseExact(userIdN, "N", out var userGuid))
                        continue;
                    var user = _userManager.GetUserById(userGuid);
                    if (user == null)
                        continue;

                    // GetUserConfiguration returns an empty default when the file is missing or
                    // unreadable, so a user who never hid anything simply reports a count of 0.
                    var cfg = _userConfigurationManager
                        .GetUserConfiguration<UserHiddenContent>(userIdN, "hidden-content.json");
                    var count = cfg?.Items?.Count ?? 0;
                    if (count == 0)
                        continue;

                    users.Add((userIdN, user.Username, count));
                }
                catch (Exception ex)
                {
                    // Per-user guard: one unreadable config must not break the whole list.
                    _logger.Warning($"Skipping user {ResolveUserDisplay(userIdN)} in hidden-content-users: {ex.Message}");
                }
            }

            var result = users
                .OrderBy(u => u.UserName, StringComparer.OrdinalIgnoreCase)
                .Select(u => new { userId = u.UserId, userName = u.UserName, count = u.Count })
                .ToList();

            return Ok(new { users = result });
        }

        /// <summary>
        /// Admin-only: returns a single user's hidden content (read-only) so an admin can review
        /// what that user has hidden. Validates the id format and never writes.
        /// </summary>
        [HttpGet("admin/hidden-content/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserHiddenContentForAdmin(string userId)
        {
            if (!IsAdminUser())
                return Forbid();

            // Honour the admin config toggle.
            if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentAdmin != true)
                return Forbid();

            // Match the AdminUpsertReview contract: expect a 32-char hex (N-format) id. This also
            // guards the filesystem path independently of GetUserConfigDir()'s canonicalization.
            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            // Resolve the user before touching the config store: this returns a clean 404 for an
            // unknown id and avoids creating an empty per-user directory as a read side effect.
            var user = _userManager.GetUserById(userGuid);
            if (user == null)
                return NotFound(new { success = false, message = "User not found." });

            try
            {
                // Read-only: GetUserConfiguration yields an empty default for a missing/corrupt
                // file, so this never throws for a valid-but-empty user.
                var config = _userConfigurationManager
                    .GetUserConfiguration<UserHiddenContent>(userId, "hidden-content.json");

                return Ok(new { userId, userName = user.Username, hiddenContent = config });
            }
            catch (Exception ex)
            {
                _logger.Warning($"Admin hidden-content read failed for {ResolveUserDisplay(userId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to load hidden content." });
            }
        }

        /// <summary>
        /// Admin-only: unhides one or more items from another user's hidden content
        /// (admin editing). The body is a JSON array of item keys (keys of UserHiddenContent.Items).
        /// Read-modify-write under the per-user file lock so it can't clobber a concurrent change by
        /// the user themselves. Returns how many items were actually removed.
        /// </summary>
        [HttpPost("admin/hidden-content/{userId}/unhide")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminUnhideForUser(string userId, [FromBody] List<string> keys)
        {
            if (!IsAdminUser())
                return Forbid();

            // Honour the admin config toggle: cross-user management can be disabled.
            if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentAdmin != true)
                return Forbid();

            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            var user = _userManager.GetUserById(userGuid);
            if (user == null)
                return NotFound(new { success = false, message = "User not found." });

            if (keys == null || keys.Count == 0)
                return BadRequest(new { success = false, message = "No item keys provided." });

            // Canonical N-format id for every store / log call, mirroring SaveUserHiddenContent.
            var userIdN = userGuid.ToString("N");

            try
            {
                var removed = 0;
                // RMW holds the per-user file lock, strict-reads (corruption → backup + throw), applies
                // the mutation, and persists only when it reports a change (returns > 0).
                _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(userIdN, "hidden-content.json", cfg =>
                {
                    var count = 0;
                    foreach (var key in keys)
                    {
                        // Keys are dictionary lookups (never used as filesystem paths); the length cap is
                        // light defence against pathological payloads.
                        if (!string.IsNullOrEmpty(key) && key.Length <= 256 && cfg.Items.Remove(key)) count++;
                    }
                    removed = count;
                    return count;
                });

                if (removed > 0)
                    Services.HiddenContentResponseFilter.InvalidateUser(userIdN);
                _logger.Info($"Admin unhid {removed} item(s) for {ResolveUserDisplay(userIdN)}.");
                return Ok(new { success = true, removed });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                _logger.Warning($"hidden-content.json corrupt for {ResolveUserDisplay(userIdN)} during admin unhide (backed up): {ex.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (IOException ioEx)
            {
                _logger.Warning($"hidden-content.json temporarily unreadable for {ResolveUserDisplay(userIdN)}: {ioEx.Message}");
                return StatusCode(500, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin unhide failed for {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to update hidden content." });
            }
        }

        /// <summary>
        /// Admin-only: hides one or more items on behalf of another user (admin adding).
        /// The body is a list of hidden-content items (the same shape the client stores). Each is keyed
        /// by its item id (or tmdb-{id}) and RMW-merged into the user's hidden-content.json without
        /// overwriting an item the user already hid. Returns how many were newly added.
        /// </summary>
        [HttpPost("admin/hidden-content/{userId}/hide")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminHideForUser(string userId, [FromBody] List<HiddenContentItem> items)
        {
            if (!IsAdminUser())
                return Forbid();

            // Adding is a management operation: gated by the admin config toggle.
            if (JellyfinEnhanced.Instance?.Configuration?.HiddenContentAdmin != true)
                return Forbid();

            if (string.IsNullOrWhiteSpace(userId) || !Guid.TryParseExact(userId, "N", out var userGuid) || userGuid == Guid.Empty)
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            var user = _userManager.GetUserById(userGuid);
            if (user == null)
                return NotFound(new { success = false, message = "User not found." });

            if (items == null || items.Count == 0)
                return BadRequest(new { success = false, message = "No items provided." });
            if (items.Count > 200)
                return BadRequest(new { success = false, message = "Too many items (max 200)." });

            var userIdN = userGuid.ToString("N");

            // Trim any admin-supplied string to a sane maximum before it is written to another user's store.
            static string Clamp(string? s, int max) =>
                string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s.Substring(0, max));

            try
            {
                var added = 0;
                _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(userIdN, "hidden-content.json", cfg =>
                {
                    var count = 0;
                    foreach (var it in items)
                    {
                        if (it == null) continue;
                        // Mirror the client's key scheme: item id, else tmdb-{id}.
                        var key = !string.IsNullOrEmpty(it.ItemId)
                            ? it.ItemId
                            : (!string.IsNullOrEmpty(it.TmdbId) ? $"tmdb-{it.TmdbId}" : null);
                        if (string.IsNullOrEmpty(key) || key.Length > 256) continue;
                        if (cfg.Items.ContainsKey(key)) continue; // never clobber the user's own hide
                        // Cross-user write path: bound the admin-supplied free-text fields and constrain
                        // HideScope to the known set, so a compromised admin token can't persist multi-MB
                        // strings or an unrecognised scope into another user's store.
                        it.Name = Clamp(it.Name, 512);
                        it.SeriesName = Clamp(it.SeriesName, 512);
                        it.PosterPath = Clamp(it.PosterPath, 512);
                        it.SeriesId = Clamp(it.SeriesId, 128);
                        it.Type = Clamp(it.Type, 64);
                        it.TmdbId = Clamp(it.TmdbId, 32);
                        it.HiddenAt = string.IsNullOrEmpty(it.HiddenAt) ? DateTime.UtcNow.ToString("o") : Clamp(it.HiddenAt, 64);
                        it.HideScope = it.HideScope is "global" or "continuewatching" or "nextup" or "homesections" ? it.HideScope : "global";
                        cfg.Items[key] = it;
                        count++;
                    }
                    added = count;
                    return count;
                });

                if (added > 0)
                    Services.HiddenContentResponseFilter.InvalidateUser(userIdN);
                _logger.Info($"Admin hid {added} item(s) for {ResolveUserDisplay(userIdN)}.");
                return Ok(new { success = true, added });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                _logger.Warning($"hidden-content.json corrupt for {ResolveUserDisplay(userIdN)} during admin hide (backed up): {ex.Message}");
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (IOException ioEx)
            {
                _logger.Warning($"hidden-content.json temporarily unreadable for {ResolveUserDisplay(userIdN)}: {ioEx.Message}");
                return StatusCode(500, new { success = false, message = "Hidden-content store is temporarily unavailable. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin hide failed for {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to update hidden content." });
            }
        }
        // ─── Spoiler Guard ─── Per-user list of series IDs the user has opted
        // into Spoiler Guard for. The image filter (Services/SpoilerBlurImageFilter.cs)
        // reads spoilerblur.json on every image request and blurs every UNWATCHED
        // episode of any series in that list. Watched episodes pass through unblurred.

        // Returns a snapshot of any spoilerblur.json corruption events
        // that have been logged this process-lifetime. Diagnostic endpoint:
        // there is no UI consumer yet — it exists so an admin (or a user,
        // for their own events) can check whether Spoiler Guard preferences
        // were reset after a corrupt-file backup, without shell access.
        // Per-user — each user only sees their OWN corruption events.
        // Admins see all users (so they can advise affected users).
        [HttpGet("spoiler-blur/health")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurHealth()
        {
            // Role-first admin check so Administrator API keys (role claim,
            // no user id) work — same pattern as IsAdminUser() everywhere else.
            var isAdmin = IsAdminUser();
            var userId = UserHelper.GetCurrentUserId(User);
            if (!isAdmin && (userId == null || userId == Guid.Empty)) return Forbid();
            var userKey = userId.HasValue && userId.Value != Guid.Empty
                ? userId.Value.ToString("N")
                : null; // admin API key: no user identity, sees all events

            var log = Services.SpoilerUserResolver.GetCorruptionLog();
            var events = new List<object>();
            foreach (var kvp in log)
            {
                if (!isAdmin && kvp.Key != userKey) continue; // non-admin: only own
                events.Add(new
                {
                    userId = kvp.Key,
                    userDisplay = kvp.Value.UserDisplay,
                    at = kvp.Value.At.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    reason = kvp.Value.Reason,
                });
            }
            return Ok(new
            {
                healthy = events.Count == 0,
                corruptionEvents = events,
            });
        }

        // Admin acks any corruption event (clears the banner); users ack their own.
        [HttpDelete("spoiler-blur/health/{targetUserId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AckSpoilerBlurCorruption(string targetUserId)
        {
            // Role-first admin check: Administrator API keys can ack any user's
            // events; non-admins need a user identity and ack only their own.
            var isAdmin = IsAdminUser();
            var userId = UserHelper.GetCurrentUserId(User);
            if (!isAdmin && (userId == null || userId == Guid.Empty)) return Forbid();
            var userKey = userId.HasValue && userId.Value != Guid.Empty
                ? userId.Value.ToString("N")
                : null;

            if (!Guid.TryParse(targetUserId, out var tGuid)
                && !Guid.TryParseExact(targetUserId, "N", out tGuid))
            {
                return BadRequest(new { success = false, message = "Invalid userId." });
            }
            var tKey = tGuid.ToString("N");
            if (!isAdmin && tKey != userKey) return Forbid();
            Services.SpoilerUserResolver.ClearCorruption(tKey);
            return Ok(new { success = true });
        }

        // ─── Spoiler Guard: apply auto-enable scope to existing titles ───
        // Admin-only. Library-add auto-enable never re-arms on rescans (so a
        // user's opt-out sticks); these routes back the config page's explicit
        // "Apply to existing titles now" action instead. Preview is a dry run
        // with the SAVED scope; start hands the options to the scheduled task
        // (so progress/cancel also show in Dashboard > Scheduled Tasks).

        private MediaBrowser.Model.Tasks.IScheduledTaskWorker? GetSpoilerApplyExistingWorker()
        {
            return _taskManager.ScheduledTasks.FirstOrDefault(w => w.ScheduledTask is ScheduledTasks.SpoilerApplyExistingTitlesTask);
        }

        [HttpGet("spoiler-blur/apply-existing/preview")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult PreviewSpoilerApplyExisting([FromQuery] bool skipStarted = false)
        {
            if (!IsAdminUser()) return Forbid();
            if (JellyfinEnhanced.Instance?.Configuration?.SpoilerBlurEnabled != true)
            {
                return Conflict(new { success = false, message = "Spoiler Guard is disabled." });
            }
            var worker = GetSpoilerApplyExistingWorker();
            if (worker != null && worker.State != MediaBrowser.Model.Tasks.TaskState.Idle)
            {
                return Conflict(new { success = false, message = "A run is already in progress." });
            }
            try
            {
                var summary = _spoilerExistingApplier.Preview(new Services.SpoilerExistingTitlesApplier.Options { SkipStarted = skipStarted }, HttpContext.RequestAborted);
                if (summary.Error != null) return StatusCode(500, new { success = false, message = summary.Error });
                return Ok(summary);
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                return StatusCode(499); // browser went away
            }
        }

        [HttpPost("spoiler-blur/apply-existing")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult StartSpoilerApplyExisting([FromQuery] bool skipStarted = false)
        {
            if (!IsAdminUser()) return Forbid();
            if (JellyfinEnhanced.Instance?.Configuration?.SpoilerBlurEnabled != true)
            {
                return Conflict(new { success = false, message = "Spoiler Guard is disabled." });
            }
            var worker = GetSpoilerApplyExistingWorker();
            if (worker == null) return StatusCode(503, new { success = false, message = "The scheduled task is not registered." });
            if (worker.State != MediaBrowser.Model.Tasks.TaskState.Idle)
            {
                return Conflict(new { success = false, message = "A run is already in progress." });
            }
            var completedRuns = _spoilerExistingApplier.CompletedRuns;
            var options = new Services.SpoilerExistingTitlesApplier.Options { SkipStarted = skipStarted };
            _spoilerExistingApplier.SetPendingOptions(options);
            // If a dashboard start wins the race between the state check and
            // here, the worker rejects this start inside its own Task: drop
            // these options then so a later dashboard run keeps the defaults
            // (they also expire after a minute as a backstop).
            var start = _taskManager.Execute(worker, new MediaBrowser.Model.Tasks.TaskOptions());
            start.ContinueWith(
                _ => _spoilerExistingApplier.ClearPendingOptions(options),
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);
            _logger.Info($"SpoilerApplyExisting: run started from the config page by {ResolveUserDisplay(UserHelper.GetCurrentUserId(User)?.ToString("N") ?? string.Empty)} (skip started: {skipStarted})");
            return Accepted(new { success = true, taskId = worker.Id, completedRuns });
        }

        [HttpGet("spoiler-blur/apply-existing/status")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerApplyExistingStatus()
        {
            if (!IsAdminUser()) return Forbid();
            var worker = GetSpoilerApplyExistingWorker();
            return Ok(new
            {
                taskId = worker?.Id,
                state = worker?.State.ToString() ?? "Unavailable",
                progress = worker?.CurrentProgress,
                completedRuns = _spoilerExistingApplier.CompletedRuns,
                lastRun = _spoilerExistingApplier.LastRun,
            });
        }

        /// <summary>
        /// The caller's Spoiler Guard state exactly as GET spoiler-blur/series returns
        /// it on success, for the bootstrap payload. Null when the file cannot be read
        /// cleanly: the client then asks that endpoint, which quarantines and reports
        /// a corrupt file as before (this read never quarantines anything).
        /// </summary>
        private UserSpoilerBlur? TryReadSpoilerBlurStateForBootstrap(string userKey)
        {
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            try
            {
                if (!_userConfigurationManager.UserConfigurationExists(userKey, fileName))
                {
                    return new UserSpoilerBlur();
                }

                return _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey, fileName, quarantineCorrupt: false);
            }
            catch (Exception)
            {
                // The strict reader logs read/parse failures; the endpoint reports them.
                return null;
            }
        }

        [HttpGet("spoiler-blur/series")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurSeries()
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            var userKey = userId.Value.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;

            // Distinguish "file missing" (empty + 200, normal first-time state)
            // from "corrupt/unreadable" (503 + backup-made hint). A lenient read
            // silently returns empty on parse error — the user would think their
            // spoiler list was wiped.
            if (!_userConfigurationManager.UserConfigurationExists(userKey, fileName))
            {
                return Ok(new UserSpoilerBlur());
            }
            try
            {
                var state = _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey, fileName);
                return Ok(state);
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
        }

        // Per-user override toggles for the admin's strip categories. Nullable
        // bools where null means "inherit admin policy"; SkipDisableConfirm is a
        // permanent flag replacing the per-session "Don't ask for 15 minutes" snooze.
        [HttpGet("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurUserPrefs()
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            var userKey = userId.Value.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;

            // The preferences' revision is their file's (spoilerblur.json): any write of it moves it on.
            var revision = _userConfigurationManager.RevisionOf(userKey, fileName);
            if (!_userConfigurationManager.UserConfigurationExists(userKey, fileName))
            {
                AnswerRevision(revision);
                return Ok(new SpoilerBlurUserPrefs());
            }
            try
            {
                var state = _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                    userKey, fileName);
                AnswerRevision(revision);
                return Ok(state.Prefs ?? new SpoilerBlurUserPrefs());
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
        }

        /// <summary>
        /// Changes the person's Spoiler Guard overrides named in <c>Set</c> (preference → value) in the spoilerblur.json the
        /// server holds now, under its file lock; every other preference stays (another tab or device may have changed it).
        /// Answers the preferences as stored afterwards.
        /// </summary>
        [HttpPatch("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(8 * 1024)]
        public IActionResult PatchSpoilerBlurUserPrefs([FromBody] UserDocumentPatch? patch)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            if (patch?.Set == null) return BadRequest(new { success = false, code = "invalid_patch", message = "A patch is required." });

            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");
            try
            {
                SpoilerBlurUserPrefs? prefs = null;
                var (_, revision) = _userConfigurationManager.RmwUserDocument<UserSpoilerBlur>(userKey, fileName, state =>
                {
                    state.Prefs = UserConfigurationManager.ApplyFieldChanges(state.Prefs ?? new SpoilerBlurUserPrefs(), patch.Set);
                    prefs = state.Prefs;
                    return 1;
                });
                AnswerRevision(revision);
                return Ok(new { success = true, prefs, revision });
            }
            catch (Exception ex) when (ex is UserDocumentPatchException or System.Text.Json.JsonException)
            {
                return BadRequest(new { success = false, code = "invalid_patch", message = ex.Message });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {ex.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), ex.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save Spoiler Guard preferences for {ResolveUserDisplay(userKey)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save Spoiler Guard preferences." });
            }
        }

        [HttpPost("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(8 * 1024)]
        public IActionResult SetSpoilerBlurUserPrefs([FromBody] SpoilerBlurUserPrefs? body)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            if (body == null) return BadRequest(new { success = false, message = "Missing body." });

            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                // The preferences are replaced whole only as a change of the revision the writer read (If-Match), under the
                // file lock; without one only where nothing can be lost (no file yet, or the same preferences).
                var expected = RequestedRevision();
                var outcome = UserConfigurationManager.DocumentWrite.Unchanged;
                var (_, revision) = _userConfigurationManager.RmwUserDocument<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    var current = _userConfigurationManager.RevisionOf(userKey, fileName);
                    var next = new SpoilerBlurUserPrefs
                    {
                        HideSeriesDescriptions = body.HideSeriesDescriptions,
                        HideEpisodeDescriptions = body.HideEpisodeDescriptions,
                        HideTags = body.HideTags,
                        HideChapterNames = body.HideChapterNames,
                        HideTaglines = body.HideTaglines,
                        HideRatings = body.HideRatings,
                        HideAirDate = body.HideAirDate,
                        ReplaceEpisodeTitles = body.ReplaceEpisodeTitles,
                        HideCast = body.HideCast,
                        HideReviews = body.HideReviews,
                        HideTrickplay = body.HideTrickplay,
                        UseAdvancedCategories = body.UseAdvancedCategories,
                        SkipDisableConfirm = body.SkipDisableConfirm,
                    };
                    if (UserConfigurationManager.SameContent(next, state.Prefs ?? new SpoilerBlurUserPrefs())) return 0;
                    if (expected == null ? _userConfigurationManager.UserConfigurationExists(userKey, fileName) : !UserConfigurationManager.IfMatchAllows(expected, current))
                    {
                        outcome = UserConfigurationManager.DocumentWrite.Conflict;
                        return 0;
                    }

                    state.Prefs = next;
                    outcome = UserConfigurationManager.DocumentWrite.Saved;
                    return 1;
                });
                if (outcome == UserConfigurationManager.DocumentWrite.Conflict)
                {
                    _logger.Info($"Refused stale Spoiler Guard preferences for {ResolveUserDisplay(userKey)} (their revision isn't the stored one).");
                    return RevisionConflict("spoiler-blur/user-prefs", revision);
                }

                AnswerRevision(revision);
                return Ok(new { success = true, prefs = body });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save Spoiler Guard user prefs for {ResolveUserDisplay(userKey)}: {ex.GetType().Name}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user prefs." });
            }
        }

        [HttpPost("spoiler-blur/series/{seriesId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForSeries(string seriesId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(seriesId, out var seriesGuid)
                && !Guid.TryParseExact(seriesId, "N", out seriesGuid))
            {
                return BadRequest(new { success = false, message = "Invalid seriesId." });
            }

            // Confirm the item exists and is a series the user can access.
            // GetItemById returns null when filtered out by library access — 404
            // so we don't leak existence. Also treat any lookup throw as 404:
            // arbitrary GUIDs hitting a partially-stored row make Jellyfin's
            // deserializer throw ("Cannot deserialize unknown type").
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            MediaBrowser.Controller.Entities.BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(seriesGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.Warning($"GetItemById<BaseItem> threw for {seriesGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not MediaBrowser.Controller.Entities.TV.Series series)
            {
                return NotFound(new { success = false, message = "Series not found or not accessible." });
            }

            var key = seriesGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                // RmwUserConfiguration reads strict: it refuses corrupt JSON (backs up
                // to *.corrupt-<ts>) instead of returning empty + clobbering other opt-ins.
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    // Preserve original EnabledAt on re-toggle; refresh SeriesName
                    // opportunistically (covers renames). Return 0 (no-write) when
                    // truly unchanged so we don't burn a disk write on each re-toggle.
                    if (state.Series.TryGetValue(key, out var existing))
                    {
                        var newName = series.Name ?? existing.SeriesName;
                        if (string.Equals(existing.SeriesName, newName, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.SeriesName = newName;
                        return 1;
                    }
                    state.Series[key] = new SpoilerBlurSeriesEntry
                    {
                        SeriesId = key,
                        SeriesName = series.Name ?? string.Empty,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
                _logger.Info($"Spoiler Guard enabled for series '{series.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, seriesId = key, name = series.Name });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to enable spoiler blur for series {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/series/{seriesId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForSeries(string seriesId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(seriesId, out var seriesGuid)
                && !Guid.TryParseExact(seriesId, "N", out seriesGuid))
            {
                return BadRequest(new { success = false, message = "Invalid seriesId." });
            }

            var key = seriesGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    removed = state.Series.Remove(key);
                    removed |= RemoveDurableSpoilerForLibraryItem(state, seriesGuid);
                    return removed ? 1 : 0;
                });
                if (!removed)
                {
                    // Log so a client/server desync (two tabs, stale cache) is
                    // observable instead of silently returning success.
                    _logger.Info($"Spoiler Guard disable was a no-op for series {key} by {ResolveUserDisplay(userKey)} — series was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, seriesId = key, removed = false });
                }
                _logger.Info($"Spoiler Guard disabled for series {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, seriesId = key, removed = true });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to disable spoiler blur for series {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        public class SpoilerBlurMovieRequest
        {
            public string? MovieName { get; set; }
        }

        // Per-movie Spoiler Guard opt-in — stored in the same spoilerblur.json
        // (UserSpoilerBlur.Movies dict). Blurs the movie's poster/backdrop and
        // field-strips its metadata until the user marks it Played.
        [HttpPost("spoiler-blur/movies/{movieId}")]
        [Authorize]
        [RequestSizeLimit(8 * 1024)]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForMovie(string movieId, [FromBody] SpoilerBlurMovieRequest? body = null)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid)
                && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            // Same protection as the Series endpoint: bogus GUID can throw
            // InvalidOperationException from Jellyfin's deserializer.
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            MediaBrowser.Controller.Entities.BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(movieGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.Warning($"GetItemById<BaseItem> threw for {movieGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not MediaBrowser.Controller.Entities.Movies.Movie movie)
            {
                return NotFound(new { success = false, message = "Movie not found or not accessible." });
            }

            var key = movieGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            // Sanitize provided MovieName: strip HTML tags + angle brackets, cap
            // length. Do NOT strip apostrophes/quotes/backticks — titles legitimately
            // contain them (e.g. "Don't Look Up") and stripping mangles the display
            // value. Consumers render via textContent, so the <>/HTML strip is enough
            // defense-in-depth at the storage layer.
            string movieNameSanitized = (movie.Name ?? string.Empty);
            if (body?.MovieName is string clientName && !string.IsNullOrEmpty(clientName))
            {
                var cleaned = System.Text.RegularExpressions.Regex.Replace(clientName, "<[^>]+>", string.Empty);
                cleaned = cleaned.Replace("<", string.Empty).Replace(">", string.Empty);
                if (cleaned.Length > 200) cleaned = cleaned.Substring(0, 200);
                if (!string.IsNullOrWhiteSpace(cleaned)) movieNameSanitized = cleaned;
            }

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    if (state.Movies.TryGetValue(key, out var existing))
                    {
                        if (string.Equals(existing.MovieName, movieNameSanitized, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.MovieName = movieNameSanitized;
                        return 1;
                    }
                    state.Movies[key] = new SpoilerBlurMovieEntry
                    {
                        MovieId = key,
                        MovieName = movieNameSanitized,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
                _logger.Info($"Spoiler Guard enabled for movie '{movie.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, movieId = key, name = movie.Name });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to enable spoiler blur for movie {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/movies/{movieId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForMovie(string movieId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid)
                && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            var key = movieGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    removed = state.Movies.Remove(key);
                    removed |= RemoveDurableSpoilerForLibraryItem(state, movieGuid);
                    return removed ? 1 : 0;
                });
                if (!removed)
                {
                    _logger.Info($"Spoiler Guard disable was a no-op for movie {key} by {ResolveUserDisplay(userKey)} — movie was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, movieId = key, removed = false });
                }
                _logger.Info($"Spoiler Guard disabled for movie {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, movieId = key, removed = true });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to disable spoiler blur for movie {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        public class SpoilerBlurCollectionRequest
        {
            public string? CollectionName { get; set; }
        }

        // Per-collection Spoiler Guard opt-in. A collection (BoxSet) is a SHORTCUT:
        // toggling here protects every movie inside (each until watched), while the
        // collection's OWN art/DTO pass through clear — it's the entry point clicked.
        [HttpPost("spoiler-blur/collections/{collectionId}")]
        [Authorize]
        [RequestSizeLimit(8 * 1024)]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForCollection(string collectionId, [FromBody] SpoilerBlurCollectionRequest? body = null)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(collectionId, out var collGuid)
                && !Guid.TryParseExact(collectionId, "N", out collGuid))
            {
                return BadRequest(new { success = false, message = "Invalid collectionId." });
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            MediaBrowser.Controller.Entities.BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(collGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.Warning($"GetItemById<BaseItem> threw for {collGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not MediaBrowser.Controller.Entities.Movies.BoxSet boxSet)
            {
                return NotFound(new { success = false, message = "Collection not found or not accessible." });
            }

            var key = collGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            string collNameSanitized = (boxSet.Name ?? string.Empty);
            if (body?.CollectionName is string clientName && !string.IsNullOrEmpty(clientName))
            {
                var cleaned = System.Text.RegularExpressions.Regex.Replace(clientName, "<[^>]+>", string.Empty);
                cleaned = cleaned.Replace("<", string.Empty).Replace(">", string.Empty);
                if (cleaned.Length > 200) cleaned = cleaned.Substring(0, 200);
                if (!string.IsNullOrWhiteSpace(cleaned)) collNameSanitized = cleaned;
            }

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    if (state.Collections.TryGetValue(key, out var existing))
                    {
                        if (string.Equals(existing.CollectionName, collNameSanitized, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.CollectionName = collNameSanitized;
                        return 1;
                    }
                    state.Collections[key] = new SpoilerBlurCollectionEntry
                    {
                        CollectionId = key,
                        CollectionName = collNameSanitized,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
                _logger.Info($"Spoiler Guard enabled for collection '{boxSet.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, collectionId = key, name = boxSet.Name });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to enable spoiler blur for collection {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/collections/{collectionId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForCollection(string collectionId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(collectionId, out var collGuid)
                && !Guid.TryParseExact(collectionId, "N", out collGuid))
            {
                return BadRequest(new { success = false, message = "Invalid collectionId." });
            }

            var key = collGuid.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var userKey = userId.Value.ToString("N");

            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                {
                    removed = state.Collections.Remove(key);
                    return removed ? 1 : 0;
                });
                if (!removed)
                {
                    _logger.Info($"Spoiler Guard disable was a no-op for collection {key} by {ResolveUserDisplay(userKey)} — collection was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, collectionId = key, removed = false });
                }
                _logger.Info($"Spoiler Guard disabled for collection {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, collectionId = key, removed = true });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to disable spoiler blur for collection {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        // ─── Pre-acquisition pending Spoiler Guard (Seerr / not-yet-downloaded) ───
        // Registers Spoiler Guard intent for a TMDB id that may not yet be in the
        // library. Two sources: (a) the Seerr modal's manual "Enable spoiler" button
        // (allowed whenever SpoilerBlurEnabled, even when the Request button is
        // disabled), (b) auto on Seerr request (SpoilerAutoEnableOnSeerrRequest).
        // If the id resolves to an accessible library item we promote straight into
        // Series/Movies; otherwise we record into PendingTmdb and
        // SpoilerSeerrPendingPromoter promotes it on ItemAdded.
        [HttpPost("spoiler-blur/pending/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurPending(string mediaType, string tmdbId, [FromQuery] string? displayName = null)
        {
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            if (cfg?.SpoilerBlurEnabled != true)
            {
                return StatusCode(503, new { success = false, message = "Spoiler Guard is disabled by the administrator." });
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            var normalizedType = (mediaType ?? string.Empty).ToLowerInvariant();
            if (normalizedType != "tv" && normalizedType != "movie")
            {
                return BadRequest(new { success = false, message = "mediaType must be 'tv' or 'movie'." });
            }
            // TMDB ids are positive integers; reject anything else so we don't
            // store junk keys that the promoter would never match.
            if (string.IsNullOrWhiteSpace(tmdbId)
                || !int.TryParse(tmdbId, System.Globalization.NumberStyles.Integer,
                                 System.Globalization.CultureInfo.InvariantCulture, out var tmdbInt)
                || tmdbInt <= 0)
            {
                return BadRequest(new { success = false, message = "Invalid tmdbId." });
            }
            var canonicalTmdb = tmdbInt.ToString(System.Globalization.CultureInfo.InvariantCulture);

            // Library lookup: if the TMDB id already resolves to a Series /
            // Movie the user can access, promote straight into the real
            // Series / Movies dict and skip pending. This handles the
            // "already in library" case (Seerr returns "already available"
            // or the user opens the modal for an existing title) cleanly.
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();

            try
            {
                var summary = AddSpoilerBlurPendingInternal(userId.Value, jUser, normalizedType, canonicalTmdb, displayName);
                if (summary.Promoted == "cap-exceeded")
                {
                    return StatusCode(429, new
                    {
                        success = false,
                        code = "pending_cap_exceeded",
                        message = $"You already have the maximum of {MaxPendingTmdbPerUser} pending spoiler-blur entries. Remove some via the management UI before adding more."
                    });
                }
                return Ok(new { success = true, promoted = summary.Promoted, jellyfinId = summary.JellyfinId, name = summary.Name });
            }
            catch (InvalidDataException strictEx)
            {
                var ukey = userId.Value.ToString("N");
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(ukey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(ukey, ResolveUserDisplay(ukey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                var ukey = userId.Value.ToString("N");
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(ukey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(ukey, ResolveUserDisplay(ukey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to record spoiler-blur pending {normalizedType}:{canonicalTmdb}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler-blur pending state." });
            }
        }

        // Shared core for the manual modal-button POST and the auto-on-Seerr-request
        // hook: library lookup + RMW, returning a structured result both the HTTP
        // layer and the fire-and-forget log layer can reason about.
        private SpoilerBlurPendingResult AddSpoilerBlurPendingInternal(
            Guid userId,
            Jellyfin.Database.Implementations.Entities.User jUser,
            string mediaType,
            string canonicalTmdb,
            string? displayName)
        {
            var pendingKey = $"{mediaType}:{canonicalTmdb}";
            var userKey = userId.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            var existingItem = FindLibraryItemByTmdb(jUser, mediaType, canonicalTmdb);

            if (existingItem is MediaBrowser.Controller.Entities.TV.Series existingSeries)
            {
                var seriesKey = existingSeries.Id.ToString("N");
                var changed = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        var typed = pendingKey.Replace(":", ":tmdb:", StringComparison.Ordinal);
                        if (!state.ProviderTitles.ContainsKey(typed))
                        {
                            state.ProviderTitles[typed] = new SpoilerBlurPendingEntry { MediaType = pendingKey.Split(':')[0], TmdbId = pendingKey.Split(':')[1], RequestedAt = DateTime.UtcNow.ToString("O") };
                            pendingRemoved = true;
                        }
                        if (state.Series.ContainsKey(seriesKey)) return pendingRemoved ? 1 : 0;
                        state.Series[seriesKey] = new SpoilerBlurSeriesEntry
                        {
                            SeriesId = seriesKey,
                            SeriesName = existingSeries.Name ?? string.Empty,
                            EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                // The pending row (if any) was just consumed — keep the
                // promoter's gate consistent so it stops sweeping this user.
                Services.SpoilerSeerrPendingPromoter.RegisterPending(pendingKey, userId);
                _logger.Info($"Spoiler Guard pending resolved to existing series '{existingSeries.Name}' ({seriesKey}) for {ResolveUserDisplay(userKey)}");
                return new SpoilerBlurPendingResult("series", seriesKey, existingSeries.Name, changed > 0);
            }
            if (existingItem is MediaBrowser.Controller.Entities.Movies.Movie existingMovie)
            {
                var movieKey = existingMovie.Id.ToString("N");
                var changed = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        var typed = pendingKey.Replace(":", ":tmdb:", StringComparison.Ordinal);
                        if (!state.ProviderTitles.ContainsKey(typed))
                        {
                            state.ProviderTitles[typed] = new SpoilerBlurPendingEntry { MediaType = pendingKey.Split(':')[0], TmdbId = pendingKey.Split(':')[1], RequestedAt = DateTime.UtcNow.ToString("O") };
                            pendingRemoved = true;
                        }
                        if (state.Movies.ContainsKey(movieKey)) return pendingRemoved ? 1 : 0;
                        state.Movies[movieKey] = new SpoilerBlurMovieEntry
                        {
                            MovieId = movieKey,
                            MovieName = existingMovie.Name ?? string.Empty,
                            EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                Services.SpoilerSeerrPendingPromoter.RegisterPending(pendingKey, userId);
                _logger.Info($"Spoiler Guard pending resolved to existing movie '{existingMovie.Name}' ({movieKey}) for {ResolveUserDisplay(userKey)}");
                return new SpoilerBlurPendingResult("movie", movieKey, existingMovie.Name, changed > 0);
            }

            var sanitized = SanitizePendingDisplayName(displayName);
            var capExceeded = new[] { false };
            var pendingChanged = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    if (state.PendingTmdb.TryGetValue(pendingKey, out var existing))
                    {
                        if (string.Equals(existing.DisplayName, sanitized, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.DisplayName = sanitized;
                        return 1;
                    }
                    if (state.PendingTmdb.Count >= MaxPendingTmdbPerUser)
                    {
                        capExceeded[0] = true;
                        return 0;
                    }
                    state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry
                    {
                        MediaType = mediaType,
                        TmdbId = canonicalTmdb,
                        DisplayName = sanitized,
                        RequestedAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            if (capExceeded[0])
            {
                _logger.Warning($"Spoiler Guard pending: cap of {MaxPendingTmdbPerUser} reached for {ResolveUserDisplay(userKey)} — rejecting new {pendingKey}");
                return new SpoilerBlurPendingResult("cap-exceeded", null, null, false);
            }
            // Prime the promoter's fast-path gate so the next ItemAdded
            // matching this TMDB id sweeps THIS user instead of bailing.
            Services.SpoilerSeerrPendingPromoter.RegisterPending(pendingKey, userId);
            _logger.Info($"Spoiler Guard pending recorded {pendingKey} for {ResolveUserDisplay(userKey)} (not yet in library)");

            // TOCTOU recovery: the scanner may have added the item between the
            // top-of-method lookup and this write — ItemAdded fired before our
            // pending row existed, so the promoter skipped this user. Re-check
            // once and promote inline if so.
            try
            {
                var raceItem = FindLibraryItemByTmdb(jUser, mediaType, canonicalTmdb);
                if (raceItem is MediaBrowser.Controller.Entities.TV.Series rs)
                {
                    return PromotePendingToSeries(userKey, fileName, rs, pendingKey);
                }
                if (raceItem is MediaBrowser.Controller.Entities.Movies.Movie rm)
                {
                    return PromotePendingToMovie(userKey, fileName, rm, pendingKey);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Spoiler Guard pending TOCTOU recheck threw {ex.GetType().Name}: {ex.Message}");
            }
            return new SpoilerBlurPendingResult("pending", null, null, pendingChanged > 0);
        }

        // TOCTOU recovery helper: a pending row was just written but a
        // matching library item is already present. Promote into Series.
        private SpoilerBlurPendingResult PromotePendingToSeries(
            string userKey, string fileName,
            MediaBrowser.Controller.Entities.TV.Series series, string pendingKey)
        {
            var seriesKey = series.Id.ToString("N");
            _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        var typed = pendingKey.Replace(":", ":tmdb:", StringComparison.Ordinal);
                        if (!state.ProviderTitles.ContainsKey(typed))
                        {
                            state.ProviderTitles[typed] = new SpoilerBlurPendingEntry { MediaType = pendingKey.Split(':')[0], TmdbId = pendingKey.Split(':')[1], RequestedAt = DateTime.UtcNow.ToString("O") };
                            pendingRemoved = true;
                        }
                    if (state.Series.ContainsKey(seriesKey)) return pendingRemoved ? 1 : 0;
                    state.Series[seriesKey] = new SpoilerBlurSeriesEntry
                    {
                        SeriesId = seriesKey,
                        SeriesName = series.Name ?? string.Empty,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            // Pending row consumed inline — release the promoter's gate for
            // this user (harmless no-op if it was never registered).
            if (Guid.TryParseExact(userKey, "N", out var promotedSeriesUserId))
            {
                Services.SpoilerSeerrPendingPromoter.RegisterPending(pendingKey, promotedSeriesUserId);
            }
            _logger.Info($"Spoiler Guard pending TOCTOU-promoted to series '{series.Name}' ({seriesKey}) for {ResolveUserDisplay(userKey)}");
            return new SpoilerBlurPendingResult("series", seriesKey, series.Name, true);
        }

        private SpoilerBlurPendingResult PromotePendingToMovie(
            string userKey, string fileName,
            MediaBrowser.Controller.Entities.Movies.Movie movie, string pendingKey)
        {
            var movieKey = movie.Id.ToString("N");
            _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        var typed = pendingKey.Replace(":", ":tmdb:", StringComparison.Ordinal);
                        if (!state.ProviderTitles.ContainsKey(typed))
                        {
                            state.ProviderTitles[typed] = new SpoilerBlurPendingEntry { MediaType = pendingKey.Split(':')[0], TmdbId = pendingKey.Split(':')[1], RequestedAt = DateTime.UtcNow.ToString("O") };
                            pendingRemoved = true;
                        }
                    if (state.Movies.ContainsKey(movieKey)) return pendingRemoved ? 1 : 0;
                    state.Movies[movieKey] = new SpoilerBlurMovieEntry
                    {
                        MovieId = movieKey,
                        MovieName = movie.Name ?? string.Empty,
                        EnabledAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            if (Guid.TryParseExact(userKey, "N", out var promotedMovieUserId))
            {
                Services.SpoilerSeerrPendingPromoter.RegisterPending(pendingKey, promotedMovieUserId);
            }
            _logger.Info($"Spoiler Guard pending TOCTOU-promoted to movie '{movie.Name}' ({movieKey}) for {ResolveUserDisplay(userKey)}");
            return new SpoilerBlurPendingResult("movie", movieKey, movie.Name, true);
        }

        private sealed record SpoilerBlurPendingResult(string Promoted, string? JellyfinId, string? Name, bool WroteSomething);

        [HttpDelete("spoiler-blur/pending/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurPending(string mediaType, string tmdbId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            var normalizedType = (mediaType ?? string.Empty).ToLowerInvariant();
            if (normalizedType != "tv" && normalizedType != "movie")
            {
                return BadRequest(new { success = false, message = "mediaType must be 'tv' or 'movie'." });
            }
            if (string.IsNullOrWhiteSpace(tmdbId)
                || !int.TryParse(tmdbId, System.Globalization.NumberStyles.Integer,
                                 System.Globalization.CultureInfo.InvariantCulture, out var tmdbInt)
                || tmdbInt <= 0)
            {
                return BadRequest(new { success = false, message = "Invalid tmdbId." });
            }
            var canonicalTmdb = tmdbInt.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var pendingKey = $"{normalizedType}:{canonicalTmdb}";
            var userKey = userId.Value.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;

            // Mirror the POST abstraction: the modal's "Disable spoiler" click needn't
            // know whether the entry is pending or in Series/Movies. Resolve TMDB ->
            // Jellyfin id and remove from whichever side holds it. Pre-compute the id
            // outside the RMW so we don't capture mutated locals into the lambda.
            var jUser = _userManager.GetUserById(userId.Value);
            try
            {
                var existingItem = jUser != null
                    ? FindLibraryItemByTmdb(jUser, normalizedType, canonicalTmdb)
                    : null;
                var seriesKeyToRemove = (existingItem as MediaBrowser.Controller.Entities.TV.Series)?.Id.ToString("N");
                var movieKeyToRemove = (existingItem as MediaBrowser.Controller.Entities.Movies.Movie)?.Id.ToString("N");
                var copyIds = jUser == null ? Array.Empty<string>() : _libraryManager.GetItemList(new InternalItemsQuery(jUser) {
                    IncludeItemTypes = new[] { normalizedType == "movie" ? BaseItemKind.Movie : BaseItemKind.Series },
                    HasAnyProviderId = new Dictionary<string, string> { ["Tmdb"] = canonicalTmdb }, Recursive = true,
                }).Select(copy => copy.Id.ToString("N")).ToArray();
                var resultBox = new[] { (Removed: false, From: "none", JellyfinId: (string?)null) };
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        bool pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        pendingRemoved |= state.ProviderTitles.Remove(normalizedType + ":tmdb:" + canonicalTmdb);
                        foreach (var copy in copyIds) pendingRemoved |= normalizedType == "movie" ? state.Movies.Remove(copy) : state.Series.Remove(copy);
                        bool seriesRemoved = seriesKeyToRemove != null && state.Series.Remove(seriesKeyToRemove);
                        bool movieRemoved = movieKeyToRemove != null && state.Movies.Remove(movieKeyToRemove);
                        if (seriesRemoved) resultBox[0] = (true, "series", seriesKeyToRemove);
                        else if (movieRemoved) resultBox[0] = (true, "movie", movieKeyToRemove);
                        else if (pendingRemoved) resultBox[0] = (true, "pending", null);
                        return resultBox[0].Removed ? 1 : 0;
                    });
                // Either way the key is no longer pending for this user — keep the
                // promoter's gate consistent so it stops sweeping this user.
                Services.SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId.Value);
                var (removedAnything, removedFrom, removedJellyfinId) = resultBox[0];
                if (!removedAnything)
                {
                    return Ok(new { success = true, removed = false, removedFrom = "none" });
                }
                _logger.Info($"Spoiler Guard pending DELETE removed {pendingKey} ({removedFrom}) for {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, removed = true, removedFrom, jellyfinId = removedJellyfinId });
            }
            catch (InvalidDataException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Newtonsoft.Json.JsonException strictEx)
            {
                _logger.Warning($"spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
                return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to remove spoiler-blur pending {pendingKey}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler-blur pending state." });
            }
        }

        // A provider toggle applies to the title across copies. Library controls must remove that
        // same intent as the provider control, otherwise arrival/reimport would silently re-enable it.
        private bool RemoveDurableSpoilerForLibraryItem(UserSpoilerBlur state, Guid itemId)
        {
            var item = _libraryManager?.GetItemById(itemId);
            var type = item is MediaBrowser.Controller.Entities.Movies.Movie ? "movie" : item is MediaBrowser.Controller.Entities.TV.Series ? "tv" : null;
            var provider = item?.GetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tmdb);
            var typed = Services.HiddenContentPolicy.TitleIdentity(type, provider);
            if (typed == null || !state.ProviderTitles.Remove(typed)) return false;
            state.PendingTmdb.Remove(type + ":" + provider);
            foreach (var copy in _libraryManager!.GetItemList(new InternalItemsQuery {
                IncludeItemTypes = new[] { type == "movie" ? BaseItemKind.Movie : BaseItemKind.Series },
                HasAnyProviderId = new Dictionary<string, string> { ["Tmdb"] = provider! }, Recursive = true }))
            {
                if (type == "movie") state.Movies.Remove(copy.Id.ToString("N"));
                else state.Series.Remove(copy.Id.ToString("N"));
            }
            return true;
        }

        // Returns the library item matching the TMDB id + media type, filtered by
        // the user's access (null when not found/accessible). Uses HasAnyProviderId
        // so the DB does the matching (indexed) rather than scanning client-side.
        private MediaBrowser.Controller.Entities.BaseItem? FindLibraryItemByTmdb(
            Jellyfin.Database.Implementations.Entities.User user,
            string mediaType,
            string tmdbId)
        {
            var kind = mediaType == "movie"
                ? Jellyfin.Data.Enums.BaseItemKind.Movie
                : Jellyfin.Data.Enums.BaseItemKind.Series;
            try
            {
                var query = new MediaBrowser.Controller.Entities.InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { kind },
                    HasAnyProviderId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                    {
                        { "Tmdb", tmdbId },
                    },
                    Recursive = true,
                    Limit = 1,
                };
                var items = _libraryManager.GetItemList(query);
                if (items != null && items.Count > 0)
                {
                    return items[0];
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"FindLibraryItemByTmdb({mediaType}, {tmdbId}) threw {ex.GetType().Name}: {ex.Message}");
            }
            return null;
        }

        // Clamp + strip control / format chars so a poisoned modal
        // payload can't grow spoilerblur.json without bound or sneak null
        // bytes / bidi-override (U+202E) tricks through the JSON
        // serializer + management UI. Strips Unicode Cf (Format) and Cc
        // (Control) categories explicitly so RTL spoofing
        // (e.g. `‮gnP.exe`) is neutralized. Truncates surrogate-pair-
        // safe so we don't emit lone surrogates that round-trip as U+FFFD
        // through Newtonsoft.
        private static string SanitizePendingDisplayName(string? raw)
        {
            if (string.IsNullOrEmpty(raw)) return string.Empty;
            const int max = 200;
            int end = raw.Length > max ? max : raw.Length;
            if (end > 0 && end < raw.Length && char.IsHighSurrogate(raw[end - 1]))
            {
                end -= 1;
            }
            var s = raw.Substring(0, end);
            var buf = new System.Text.StringBuilder(s.Length);
            foreach (var c in s)
            {
                if (c == '\r' || c == '\n' || c == '\t') { buf.Append(' '); continue; }
                var cat = System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c);
                if (cat == System.Globalization.UnicodeCategory.Control
                    || cat == System.Globalization.UnicodeCategory.Format)
                {
                    continue;
                }
                buf.Append(c);
            }
            return buf.ToString().Normalize(System.Text.NormalizationForm.FormC);
        }

        // Hard cap on PendingTmdb — defensive against an auth'd user spamming the
        // modal/Seerr hook to grow spoilerblur.json without bound. 500 is well above
        // any real watchlist. Reaching it rejects NEW inserts only; existing entries
        // still promote and DELETE still works, so users can prune to recover.
        private const int MaxPendingTmdbPerUser = 500;

        // ─── Remove from Continue Watching ─── HideScope=continuewatching in hidden-content.json; surfaced via HC's management page.

        // Picks the WIDER of two HC scopes; disjoint rank-2 scopes (continuewatching ⊕ nextup) compose to homesections.
        private static string? WiderScope(string? a, string? b)
        {
            if (string.IsNullOrEmpty(a)) return b;
            if (string.IsNullOrEmpty(b)) return a;
            var ra = ScopeRank(a);
            var rb = ScopeRank(b);
            if (ra == 2 && rb == 2 && !string.Equals(a, b, StringComparison.OrdinalIgnoreCase)) return "homesections";
            return ra >= rb ? a : b;
        }

        private static int ScopeRank(string scope)
        {
            if (string.Equals(scope, "global", StringComparison.OrdinalIgnoreCase)) return 4;
            if (string.Equals(scope, "homesections", StringComparison.OrdinalIgnoreCase)) return 3;
            if (string.Equals(scope, "nextup", StringComparison.OrdinalIgnoreCase)
                || string.Equals(scope, "continuewatching", StringComparison.OrdinalIgnoreCase)) return 2;
            return 1; // unknown / future
        }

        private static string? EarliestHiddenAt(string? a, string? b)
        {
            DateTime? da = TryParseIso(a);
            DateTime? db = TryParseIso(b);
            if (da == null) return b ?? a;
            if (db == null) return a;
            return da <= db ? a : b;
        }

        private static DateTime? TryParseIso(string? s)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            return DateTime.TryParse(s, System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind, out var dt) ? (DateTime?)dt : null;
        }

        // Widens an existing HC scope to also cover a new targetScope (continuewatching|nextup)
        // hide without ever narrowing the user's earlier intent. Mirrors the client-side
        // mergeCwScope in js/enhanced/hiddencontent/hidden-content-data.js: global/homesections stay; same scope stays; the
        // other home surface (or any unknown value) composes up to homesections.
        private static string MergeHomeScope(string existing, string targetScope)
        {
            if (string.IsNullOrEmpty(existing)) return targetScope;
            if (string.Equals(existing, "global", StringComparison.OrdinalIgnoreCase)) return "global";
            if (string.Equals(existing, "homesections", StringComparison.OrdinalIgnoreCase)) return "homesections";
            if (string.Equals(existing, targetScope, StringComparison.OrdinalIgnoreCase)) return targetScope;
            return "homesections";
        }

        [HttpPost("continue-watching/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult HideFromContinueWatching(string itemId) => HideFromHomeSurface(itemId, "continuewatching");

        [HttpPost("next-up/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult HideFromNextUp(string itemId) => HideFromHomeSurface(itemId, "nextup");

        // Shared implementation for "Remove from Continue Watching" / "Remove from Next Up".
        // Records a scoped HC entry (HideScope=continuewatching|nextup) under a server-side
        // read-modify-write so a concurrent hide can't clobber it. An existing entry's scope
        // is widened — never narrowed — via MergeHomeScope (e.g. continuewatching ⊕ nextup → homesections).
        private IActionResult HideFromHomeSurface(string itemId, string targetScope)
        {
            var userId = UserHelper.GetCurrentUserId(User) ?? Guid.Empty;
            if (userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(itemId, out var itemGuid) && !Guid.TryParseExact(itemId, "N", out itemGuid))
            {
                return BadRequest(new { success = false, message = "Invalid itemId." });
            }

            var user = _userManager.GetUserById(userId);
            if (user == null) return Forbid();

            var jfItem = _libraryManager.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(itemGuid, user);
            if (jfItem == null)
            {
                return NotFound(new { success = false, message = "Item not found or not accessible." });
            }

            string? seriesId = null;
            string? seriesName = null;
            int? seasonNumber = null;
            int? episodeNumber = null;
            string typeName = jfItem.GetType().Name;

            if (jfItem is MediaBrowser.Controller.Entities.TV.Episode ep)
            {
                seriesId = ep.SeriesId == Guid.Empty ? null : ep.SeriesId.ToString();
                seriesName = ep.SeriesName;
                seasonNumber = ep.ParentIndexNumber;
                episodeNumber = ep.IndexNumber;
            }

            var entry = new HiddenContentItem
            {
                ItemId = itemGuid.ToString(),
                Name = jfItem.Name ?? string.Empty,
                Type = typeName,
                TmdbId = string.Empty,
                HiddenAt = DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture),
                PosterPath = string.Empty,
                SeriesId = seriesId ?? string.Empty,
                SeriesName = seriesName ?? string.Empty,
                SeasonNumber = seasonNumber,
                EpisodeNumber = episodeNumber,
                HideScope = targetScope
            };

            var key = entry.ItemId;
            var authorizedUserId = userId.ToString("N");

            try
            {
                var keyN = itemGuid.ToString("N");
                // Seed Settings from admin defaults if this RMW creates the file (Remove-from-CW before any HC UI was opened).
                var preExistedHc = _userConfigurationManager.UserConfigurationExists(authorizedUserId, "hidden-content.json");
                var hcDefaults = JellyfinEnhanced.Instance?.Configuration;

                var (_, revision) = _userConfigurationManager.RmwUserDocument<UserHiddenContent>(
                    authorizedUserId, "hidden-content.json", h =>
                    {
                        if (!preExistedHc && hcDefaults != null && h.Items.Count == 0)
                        {
                            h.Settings = BuildHcDefaultSettings(hcDefaults);
                            // The user just performed a hide via the Remove feature, so filtering
                            // must be active for it to take effect — even if the admin's HC default
                            // is disabled. (Existing files keep whatever the user chose.)
                            h.Settings.Enabled = true;
                        }

                        // Merge with existing entries (under either hyphenated or N-format key) — pick the wider scope.
                        h.Items.TryGetValue(key, out var hyphenEntry);
                        h.Items.TryGetValue(keyN, out var nEntry);

                        var existingScope = WiderScope(
                            hyphenEntry?.HideScope,
                            nEntry?.HideScope);

                        if (!string.IsNullOrEmpty(existingScope))
                        {
                            entry.HideScope = MergeHomeScope(existingScope, targetScope);
                        }

                        // Preserve the earliest HiddenAt across both entries so re-affirming doesn't reset history.
                        var existingHiddenAt = EarliestHiddenAt(
                            hyphenEntry?.HiddenAt,
                            nEntry?.HiddenAt);
                        if (!string.IsNullOrEmpty(existingHiddenAt))
                        {
                            entry.HiddenAt = existingHiddenAt;
                        }

                        h.Items.Remove(keyN);
                        h.Items[key] = entry;
                        return 1;
                    });
                Services.HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                // The revision of hidden-content.json this hide left: a page orders it with its own saves' answers.
                return Ok(new { success = true, key, entry, revision });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to add {targetScope} hide for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to hide item." });
            }
        }

        [HttpDelete("continue-watching/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UnhideFromContinueWatching(string itemId) => UnhideFromHomeSurface(itemId, "continuewatching");

        [HttpDelete("next-up/hide/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UnhideFromNextUp(string itemId) => UnhideFromHomeSurface(itemId, "nextup");

        // Drops the scoped HC entry for {itemId} whose HideScope exactly matches targetScope
        // (mirror of the scoped POST). Wider composite scopes (e.g. homesections) are left
        // intact — narrowing them is handled by the Hidden Content management page.
        private IActionResult UnhideFromHomeSurface(string itemId, string targetScope)
        {
            var userId = UserHelper.GetCurrentUserId(User) ?? Guid.Empty;
            if (userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(itemId, out var itemGuid) && !Guid.TryParseExact(itemId, "N", out itemGuid))
            {
                return BadRequest(new { success = false, message = "Invalid itemId." });
            }

            var authorizedUserId = userId.ToString("N");
            var canonical = itemGuid.ToString();
            var canonicalN = itemGuid.ToString("N");

            try
            {
                var dropped = _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                    authorizedUserId, "hidden-content.json", h =>
                {
                    if (h?.Items == null || h.Items.Count == 0) return 0;
                    var dropKeys = new List<string>();
                    foreach (var kvp in h.Items)
                    {
                        var entry = kvp.Value;
                        if (entry == null) continue;
                        if (!string.Equals(entry.HideScope, targetScope, StringComparison.OrdinalIgnoreCase))
                            continue;
                        var entryId = entry.ItemId ?? string.Empty;
                        if (string.Equals(entryId, canonical, StringComparison.OrdinalIgnoreCase)
                            || string.Equals(entryId, canonicalN, StringComparison.OrdinalIgnoreCase))
                        {
                            dropKeys.Add(kvp.Key);
                        }
                    }
                    foreach (var k in dropKeys) h.Items.Remove(k);
                    return dropKeys.Count;
                });

                if (dropped == 0) return NotFound(new { success = false, message = "No matching hidden-content entry." });
                Services.HiddenContentResponseFilter.InvalidateUser(authorizedUserId);
                return Ok(new { success = true });
            }
            catch (Exception ex) when (ex is InvalidDataException || ex is Newtonsoft.Json.JsonException)
            {
                return StatusCode(503, new { success = false, message = "Hidden-content store is corrupt; backed up. Please retry." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to remove {targetScope} hide for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to unhide." });
            }
        }

        // ─── User Reviews (shared reviews.json at plugin config root) ────────────

        public sealed class ReviewPayload
        {
            public string Content { get; set; } = string.Empty;
            public double? Rating { get; set; }
        }

        /// <summary>Rating must be 1–5 in 0.5 increments (2, 3.5, 5, etc.).</summary>
        private static bool IsValidRating(double? rating) =>
            !rating.HasValue || (rating.Value >= 1 && rating.Value <= 5 && Math.Abs(rating.Value * 2 - Math.Round(rating.Value * 2)) < 0.0001);

        private static readonly System.Text.RegularExpressions.Regex _tmdbIdRegex =
            new System.Text.RegularExpressions.Regex(@"^\d+$", System.Text.RegularExpressions.RegexOptions.Compiled);

        // Review keys ({tmdbId}, {tmdbId}:s{n}, {tmdbId}:s{n}:e{n}) are valid only when they resolve to an owning title.
        private static bool IsValidTmdbKey(string mediaType, string tmdbId) =>
            Services.HiddenContentPolicy.OwningTitle(mediaType, tmdbId) != null;

        /// <summary>
        /// Per-request state for deciding which reviews a viewer may see.
        /// Shared by <see cref="GetItemReviews"/> and <see cref="GetReviewRatings"/>
        /// so the list and the poster rating chips can never disagree. Authors
        /// are resolved at most once per request.
        /// </summary>
        private sealed class ReviewVisibilityContext
        {
            public bool ViewerIsAdmin { get; init; }
            public string? ViewerUserIdN { get; init; }
            public bool HideHiddenAuthors { get; init; }
            public bool HideDisabledAuthors { get; init; }
            public Dictionary<Guid, Jellyfin.Database.Implementations.Entities.User?> Authors { get; } = new();
        }

        private ReviewVisibilityContext CreateReviewVisibilityContext(string endpoint, string target)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            // Resolve the current viewer's "N"-format user id so we can
            // always show their OWN review back to them, even when the
            // viewer themselves is hidden/disabled in Jellyfin and the
            // hide filters would otherwise drop their author record.
            // Without this, a hidden non-admin user posting a review would
            // immediately lose visibility of their own content (issue 546).
            var viewerUserIdN = UserHelper.GetCurrentUserId(User)?.ToString("N");
            if (string.IsNullOrEmpty(viewerUserIdN))
            {
                // Anomalous: [Authorize] passed but the Jellyfin-UserId
                // claim is missing or unparseable. The self-review bypass
                // below will silently no-op, so warn here to give a
                // diagnostic trail if a hidden user reports the symptom
                // again with no obvious cause.
                _logger.Warning($"{endpoint}: could not resolve viewer user id from claims on {target}; self-review bypass disabled.");
            }

            return new ReviewVisibilityContext
            {
                ViewerIsAdmin = IsAdminUser(),
                ViewerUserIdN = viewerUserIdN,
                HideHiddenAuthors = config?.HideReviewsFromHiddenUsers ?? true,
                HideDisabledAuthors = config?.HideReviewsFromDisabledUsers ?? true,
            };
        }

        /// <summary>
        /// Decides whether <paramref name="review"/> is visible to the viewer
        /// described by <paramref name="ctx"/> and resolves its author
        /// (null when the id is unparseable or the user no longer exists).
        /// May throw on a corrupt record or a failing user lookup — callers
        /// isolate each review so one bad record cannot fail the request.
        /// </summary>
        /// <summary>
        /// The Jellyfin user behind a review author id (null when the user no
        /// longer exists), through <see cref="Services.ReviewAuthorCache"/>, which the
        /// user update/delete events invalidate.
        /// </summary>
        private Jellyfin.Database.Implementations.Entities.User? ResolveReviewAuthor(Guid userGuid)
            => Services.ReviewAuthorCache.Resolve(userGuid, _userManager.GetUserById);

        private bool IsReviewVisibleToViewer(
            UserReview review,
            ReviewVisibilityContext ctx,
            string itemLabel,
            out Jellyfin.Database.Implementations.Entities.User? jellyfinUser)
        {
            // Rules live in ReviewVisibility (shared with native poster tags'
            // review chip); authors are resolved at most once per request.
            var visible = ReviewVisibility.IsVisible(
                review,
                ctx.ViewerIsAdmin,
                ctx.ViewerUserIdN,
                ctx.HideHiddenAuthors,
                ctx.HideDisabledAuthors,
                userGuid =>
                {
                    if (!ctx.Authors.TryGetValue(userGuid, out var author))
                    {
                        author = ResolveReviewAuthor(userGuid);
                        ctx.Authors[userGuid] = author;
                    }
                    return author;
                },
                out jellyfinUser,
                out var hiddenAsOrphan);
            if (hiddenAsOrphan)
            {
                _logger.Warning($"Hiding orphaned review for unknown userId={review.UserId} on {itemLabel} from non-admin viewer.");
            }
            return visible;
        }

        [HttpGet("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetItemReviews(string mediaType, string tmdbId)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(mediaType, tmdbId))
                return BadRequest(new { message = "Invalid TmdbId." });

            var spoilerPresentation = _presentation?.Load(UserHelper.GetCurrentUserId(User) ?? Guid.Empty, HttpContext);
            if (spoilerPresentation?.HidesReviews(Services.HiddenContentPolicy.OwningTitle(mediaType, tmdbId)) == true)
            {
                Response.Headers["Cache-Control"] = "private, no-store";
                return Ok(new { reviews = Array.Empty<object>(), averageRating = (double?)null, totalReviews = 0 });
            }
            var itemLabel = $"{mediaType}:{tmdbId}";
            var ctx = CreateReviewVisibilityContext(nameof(GetItemReviews), itemLabel);

            var suffix = $":{mediaType}:{tmdbId}";
            var store = _userConfigurationManager.GetAllReviews();
            var results = new List<object>();

            foreach (var kvp in store.Reviews)
            {
                if (!kvp.Key.EndsWith(suffix, StringComparison.Ordinal)) continue;

                // Per-review try/catch: if anything blows up while looking up
                // the author or evaluating their permissions, we skip just
                // this review with a warning. Without this, a single corrupt
                // or orphaned record would 500 the entire GetItemReviews call
                // and hide every other review on the item.
                try
                {
                    var review = kvp.Value;
                    if (!IsReviewVisibleToViewer(review, ctx, itemLabel, out var jellyfinUser)) continue;

                    results.Add(new
                    {
                        userId = review.UserId,
                        userName = jellyfinUser != null ? jellyfinUser.Username : review.UserId,
                        tmdbId = review.TmdbId,
                        mediaType = review.MediaType,
                        content = review.Content,
                        rating = review.Rating,
                        createdAt = review.CreatedAt,
                        updatedAt = review.UpdatedAt
                    });
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Skipping review key={kvp.Key} due to filter error: {ex.Message}");
                }
            }

            return Ok(new { reviews = results });
        }

        /// <summary>Most distinct keys one <see cref="GetReviewRatings"/> call may ask for.</summary>
        private const int MaxReviewRatingKeys = 200;

        /// <summary>
        /// Average user rating for many items in one pass over the review
        /// store (the poster rating chips ask for a whole page at once instead
        /// of one <see cref="GetItemReviews"/> call per card).
        /// </summary>
        /// <param name="keys">Comma-separated "mediaType:tmdbKey" entries, e.g.
        /// "movie:603,tv:1399:s1". Malformed entries are ignored; at most
        /// <see cref="MaxReviewRatingKeys"/> distinct valid keys.</param>
        /// <returns>
        /// <c>{ "ratings": { "movie:603": { "average": 4.5, "count": 2 }, "tv:1399:s1": null } }</c>
        /// — one entry per valid requested key; null when no review visible to
        /// this viewer carries a rating. Computed from exactly the reviews
        /// <see cref="GetItemReviews"/> would return to the same viewer.
        /// </returns>
        [HttpGet("reviews/ratings")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetReviewRatings([FromQuery] string? keys)
        {
            // Insertion-ordered so the response lists keys in request order.
            var requested = new Dictionary<string, (double Sum, int Count)>(StringComparer.Ordinal);
            var order = new List<string>();
            foreach (var raw in (keys ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var sep = raw.IndexOf(':');
                if (sep <= 0) continue;
                var mediaType = raw.Substring(0, sep);
                if (mediaType != "movie" && mediaType != "tv") continue;
                if (!IsValidTmdbKey(mediaType, raw.Substring(sep + 1))) continue;
                if (requested.ContainsKey(raw)) continue;
                if (requested.Count >= MaxReviewRatingKeys)
                    return BadRequest(new { message = $"At most {MaxReviewRatingKeys} keys per request." });
                requested[raw] = (0, 0);
                order.Add(raw);
            }

            if (requested.Count == 0)
                return BadRequest(new { message = "No valid keys. Expected comma-separated 'movie:<tmdbId>' or 'tv:<tmdbId>[:s<n>[:e<n>]]' entries." });

            var ctx = CreateReviewVisibilityContext(nameof(GetReviewRatings), $"{requested.Count} keys");
            foreach (var (key, sum, count) in AggregateVisibleReviewRatings(ctx, requested.ContainsKey))
            {
                requested[key] = (sum, count);
            }

            var ratings = new Dictionary<string, object?>(StringComparer.Ordinal);
            var guard = _presentation?.Load(UserHelper.GetCurrentUserId(User) ?? Guid.Empty, HttpContext);
            foreach (var key in order)
            {
                var (sum, count) = requested[key];
                var sep = key.IndexOf(':');
                ratings[key] = count == 0 || guard?.HidesRatings(Services.HiddenContentPolicy.OwningTitle(key[..sep], key[(sep + 1)..])) == true ? null : new { average = sum / count, count };
            }

            return Ok(new { ratings });
        }

        /// <summary>
        /// One pass over the review store: the rating sum and count per
        /// "mediaType:tmdbKey" over the reviews visible to the viewer described
        /// by <paramref name="ctx"/>, for the keys <paramref name="wanted"/>
        /// accepts. Only keys with at least one counted rating are yielded.
        /// Shared by <see cref="GetReviewRatings"/> and the tag-cache payload so
        /// a poster chip shows the same average whichever way it was resolved.
        /// </summary>
        private IEnumerable<(string Key, double Sum, int Count)> AggregateVisibleReviewRatings(ReviewVisibilityContext ctx, Func<string, bool> wanted)
        {
            var store = _userConfigurationManager.GetAllReviews();
            var totals = new Dictionary<string, (double Sum, int Count)>(StringComparer.Ordinal);

            foreach (var kvp in store.Reviews)
            {
                // Store keys are "{userIdN}:{mediaType}:{tmdbKey}". A requested
                // key K matches exactly when the store key ends with ":" + K —
                // the same suffix test GetItemReviews applies — so probe the
                // tail after every ':' (a key holds at most a handful).
                var storeKey = kvp.Key;
                for (var i = storeKey.IndexOf(':'); i >= 0; i = storeKey.IndexOf(':', i + 1))
                {
                    var itemKey = storeKey.Substring(i + 1);
                    // A store key's item part always starts with its media type, so
                    // only a "movie:"/"tv:" tail can be an item key; the shorter tails
                    // ("1399:s1", "s1") are never one.
                    if (!itemKey.StartsWith("movie:", StringComparison.Ordinal) && !itemKey.StartsWith("tv:", StringComparison.Ordinal)) continue;
                    if (!wanted(itemKey)) continue;

                    // Same per-review isolation as GetItemReviews: a corrupt
                    // record or failing author lookup skips only this review.
                    var review = kvp.Value;
                    if (review == null)
                    {
                        _logger.Warning($"Skipping review key={storeKey}: empty record.");
                        continue;
                    }

                    try
                    {
                        if (!IsReviewVisibleToViewer(review, ctx, itemKey, out _)) continue;

                        // Mirror the client's historical `filter(r => r.rating)`: only
                        // a non-zero rating counts (NaN is excluded too).
                        var rating = review.Rating ?? 0;
                        if (double.IsNaN(rating) || Math.Abs(rating) <= 0) continue;

                        var acc = totals.TryGetValue(itemKey, out var existing) ? existing : (0d, 0);
                        totals[itemKey] = (acc.Item1 + rating, acc.Item2 + 1);
                    }
                    catch (Exception ex) when (ex is not OutOfMemoryException)
                    {
                        // Same per-review isolation as GetItemReviews: one unusable record
                        // (e.g. an author id the user manager rejects) skips only itself
                        // instead of failing every chip in the batch.
                        _logger.Warning($"Skipping review key={storeKey} due to filter error: {ex.Message}");
                    }
                }
            }

            foreach (var kvp in totals)
            {
                yield return (kvp.Key, kvp.Value.Sum, kvp.Value.Count);
            }
        }

        [HttpPost("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UpsertReview(string mediaType, string tmdbId, [FromBody] ReviewPayload payload)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(mediaType, tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (payload == null)
                return BadRequest(new { success = false, message = "Invalid review payload." });

            var normalizedContent = payload.Content?.Trim() ?? string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedContent) && !payload.Rating.HasValue)
                return BadRequest(new { success = false, message = "A rating or review text is required." });

            if (normalizedContent.Length > 2000)
                return BadRequest(new { success = false, message = "Review content must not exceed 2000 characters." });

            if (!IsValidRating(payload.Rating))
                return BadRequest(new { success = false, message = "Rating must be between 1 and 5, in 0.5 increments." });

            var currentUserId = UserHelper.GetCurrentUserId(User);
            if (!currentUserId.HasValue || currentUserId.Value == Guid.Empty) return Forbid();
            var userIdN = currentUserId.Value.ToString("N");

            try
            {
                var now = DateTime.UtcNow.ToString("o");
                var previousRating = _userConfigurationManager.UpsertReview(
                    userIdN, mediaType, tmdbId, normalizedContent, payload.Rating, now);
                _logger.Info($"Saved review for {mediaType}:{tmdbId} by user {ResolveUserDisplay(userIdN)}.");
                MirrorReviewRatingToUserData(userIdN, mediaType, tmdbId, previousRating, payload.Rating);
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save review for user {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save review." });
            }
        }

        [HttpPost("reviews/admin/{userIdN}/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminUpsertReview(string userIdN, string mediaType, string tmdbId, [FromBody] ReviewPayload payload)
        {
            if (!IsAdminUser())
                return Forbid();

            if (string.IsNullOrWhiteSpace(userIdN) || !Guid.TryParseExact(userIdN, "N", out _))
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(mediaType, tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (payload == null)
                return BadRequest(new { success = false, message = "Invalid review payload." });

            var normalizedContent = payload.Content?.Trim() ?? string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedContent) && !payload.Rating.HasValue)
                return BadRequest(new { success = false, message = "A rating or review text is required." });

            if (normalizedContent.Length > 2000)
                return BadRequest(new { success = false, message = "Review content must not exceed 2000 characters." });

            if (!IsValidRating(payload.Rating))
                return BadRequest(new { success = false, message = "Rating must be between 1 and 5, in 0.5 increments." });

            try
            {
                var now = DateTime.UtcNow.ToString("o");
                var previousRating = _userConfigurationManager.UpsertReview(
                    userIdN, mediaType, tmdbId, normalizedContent, payload.Rating, now);
                _logger.Info($"Admin saved review for {mediaType}:{tmdbId} on behalf of {ResolveUserDisplay(userIdN)}.");
                MirrorReviewRatingToUserData(userIdN, mediaType, tmdbId, previousRating, payload.Rating);
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin failed to save review for user {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save review." });
            }
        }

        [HttpDelete("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DeleteReview(string mediaType, string tmdbId)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(mediaType, tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            var currentUserId = UserHelper.GetCurrentUserId(User);
            if (!currentUserId.HasValue || currentUserId.Value == Guid.Empty) return Forbid();
            var userIdN = currentUserId.Value.ToString("N");

            try
            {
                if (_userConfigurationManager.DeleteReview(userIdN, mediaType, tmdbId, out var removedRating))
                {
                    _logger.Info($"Deleted review for {mediaType}:{tmdbId} by user {ResolveUserDisplay(userIdN)}.");
                    MirrorReviewRatingToUserData(userIdN, mediaType, tmdbId, removedRating, null);
                }
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to delete review for user {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to delete review." });
            }
        }

        /// <summary>
        /// Optionally keeps Jellyfin's own per-user rating for the matching
        /// library item in step with a review's star rating, so tools that only
        /// read Jellyfin user data (scrobblers, Letterboxd/Trakt syncs, other
        /// clients) can see ratings given through the reviews UI. Gated by the
        /// MirrorReviewRatingsToJellyfin setting (off by default).
        ///
        /// previousRating is the review's rating before this change (null if it
        /// had none or is new) and newRating the rating after it (null when the
        /// review was deleted or saved without a rating).
        ///
        /// - newRating set: write it to Jellyfin (overwrites).
        /// - newRating null and previousRating set: clear the Jellyfin rating,
        ///   but only if it still equals what the review would have mirrored.
        ///   Jellyfin ratings carry no provenance, so a value that differs was
        ///   changed somewhere else (another client, a sync tool) and is left
        ///   alone.
        ///
        /// Only whole movies and series are touched (a season/episode key has
        /// no reliably TMDB-keyed library item). Scale: 1-5 stars in half steps
        /// become Jellyfin's 0-10 (x2), which is what Jellyfin's own clients
        /// and the ratings-based sync tools already expect.
        ///
        /// Never throws: the review change is already saved by the time this
        /// runs, and a mirror failure must not turn that into a 500.
        /// </summary>
        private void MirrorReviewRatingToUserData(string userIdN, string mediaType, string tmdbId, double? previousRating, double? newRating)
        {
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || !config.MirrorReviewRatingsToJellyfin) return;
                if (!newRating.HasValue && !previousRating.HasValue) return;

                // Season/episode reviews carry a ":s{n}[:e{n}]" suffix; there is no
                // TMDB-keyed library item to attach those to, so leave them alone.
                if (tmdbId.Contains(':')) return;

                if (!Guid.TryParseExact(userIdN, "N", out var userGuid)) return;
                var user = _userManager.GetUserById(userGuid);
                if (user == null) return;

                var item = FindLibraryItemByTmdb(user, mediaType, tmdbId);
                if (item == null)
                {
                    _logger.Debug($"[ReviewRatingMirror] No library item for {mediaType}:{tmdbId}; nothing to mirror for {ResolveUserDisplay(userIdN)}.");
                    return;
                }

                var userData = _userDataManager.GetUserData(user, item);
                if (userData == null) return;

                if (newRating.HasValue)
                {
                    var jellyfinRating = Math.Round(newRating.Value * 2, 1);
                    if (userData.Rating.HasValue && Math.Abs(userData.Rating.Value - jellyfinRating) < 0.01) return;

                    userData.Rating = jellyfinRating;
                    _userDataManager.SaveUserData(user, item, userData, UserDataSaveReason.UpdateUserRating, default);
                    _logger.Info($"[ReviewRatingMirror] Set Jellyfin rating {jellyfinRating} on '{item.Name}' for {ResolveUserDisplay(userIdN)} from their review.");
                    return;
                }

                var mirroredRating = Math.Round(previousRating!.Value * 2, 1);
                if (!userData.Rating.HasValue) return;
                if (Math.Abs(userData.Rating.Value - mirroredRating) >= 0.01)
                {
                    _logger.Debug($"[ReviewRatingMirror] Jellyfin rating {userData.Rating.Value} on '{item.Name}' no longer matches the review's {mirroredRating}; leaving it for {ResolveUserDisplay(userIdN)}.");
                    return;
                }

                userData.Rating = null;
                _userDataManager.SaveUserData(user, item, userData, UserDataSaveReason.UpdateUserRating, default);
                _logger.Info($"[ReviewRatingMirror] Cleared Jellyfin rating {mirroredRating} on '{item.Name}' for {ResolveUserDisplay(userIdN)} after their review rating was removed.");
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ReviewRatingMirror] Could not mirror rating for {mediaType}:{tmdbId}: {ex.Message}");
            }
        }

        /// <summary>
        /// Lists every review on the server for an Administrator caller, so a
        /// headless integration (a sync job, a scrobbler, a backup script) can
        /// consume reviews without knowing the store's on-disk layout or
        /// polling the per-item endpoint once per TMDB id. Ordered by
        /// updatedAt ascending so a client can page forward and keep the last
        /// updatedAt it saw as its next "since".
        /// </summary>
        /// <param name="since">Optional ISO 8601 timestamp; only reviews whose updatedAt is at or after it are returned. A review whose stored timestamp cannot be parsed is always returned rather than silently dropped.</param>
        /// <param name="userId">Optional author filter, 32-char hex (N) form.</param>
        /// <param name="limit">Page size, 1-1000, default 500.</param>
        /// <param name="offset">Number of matching reviews to skip, default 0.</param>
        [HttpGet("reviews/admin/all")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminListReviews(
            [FromQuery] string? since = null,
            [FromQuery] string? userId = null,
            [FromQuery] int limit = 500,
            [FromQuery] int offset = 0)
        {
            if (!IsAdminUser())
                return Forbid();

            DateTimeOffset? sinceUtc = null;
            if (!string.IsNullOrWhiteSpace(since))
            {
                if (!DateTimeOffset.TryParse(since, System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                        out var parsedSince))
                    return BadRequest(new { success = false, message = "Invalid 'since' (expected ISO 8601)." });
                sinceUtc = parsedSince;
            }

            if (!string.IsNullOrWhiteSpace(userId) && !Guid.TryParseExact(userId, "N", out _))
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            if (limit < 1 || limit > 1000)
                return BadRequest(new { success = false, message = "limit must be between 1 and 1000." });

            if (offset < 0)
                return BadRequest(new { success = false, message = "offset must be 0 or greater." });

            try
            {
                var store = _userConfigurationManager.GetAllReviews();

                var matching = new List<(DateTimeOffset? UpdatedAt, string Key, UserReview Review)>();
                foreach (var kvp in store.Reviews)
                {
                    var review = kvp.Value;
                    if (review == null) continue;

                    if (!string.IsNullOrWhiteSpace(userId)
                        && !string.Equals(review.UserId, userId, StringComparison.OrdinalIgnoreCase))
                        continue;

                    DateTimeOffset? updatedAt = null;
                    if (DateTimeOffset.TryParse(review.UpdatedAt, System.Globalization.CultureInfo.InvariantCulture,
                            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                            out var parsedUpdated))
                        updatedAt = parsedUpdated;

                    // Unparseable timestamps are kept so a corrupt field never hides a review.
                    if (sinceUtc.HasValue && updatedAt.HasValue && updatedAt.Value < sinceUtc.Value)
                        continue;

                    matching.Add((updatedAt, kvp.Key, review));
                }

                // Stable order: by updatedAt, then by key so ties never reshuffle between pages.
                matching.Sort((a, b) =>
                {
                    var byDate = Nullable.Compare(a.UpdatedAt, b.UpdatedAt);
                    return byDate != 0 ? byDate : string.CompareOrdinal(a.Key, b.Key);
                });

                var page = matching.Skip(offset).Take(limit).Select(m =>
                {
                    var review = m.Review;
                    string displayName = review.UserId;
                    if (Guid.TryParseExact(review.UserId, "N", out var authorGuid))
                    {
                        var author = _userManager.GetUserById(authorGuid);
                        if (author != null) displayName = author.Username;
                    }

                    return new
                    {
                        userId = review.UserId,
                        userName = displayName,
                        tmdbId = review.TmdbId,
                        mediaType = review.MediaType,
                        content = review.Content,
                        rating = review.Rating,
                        createdAt = review.CreatedAt,
                        updatedAt = review.UpdatedAt
                    };
                }).ToList();

                return Ok(new
                {
                    reviews = page,
                    total = matching.Count,
                    offset,
                    limit
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin failed to list reviews: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to list reviews." });
            }
        }

        [HttpDelete("reviews/admin/{userIdN}/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminDeleteReview(string userIdN, string mediaType, string tmdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(mediaType, tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (string.IsNullOrWhiteSpace(userIdN) || !Guid.TryParseExact(userIdN, "N", out _))
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            try
            {
                var removed = _userConfigurationManager.DeleteReview(userIdN, mediaType, tmdbId, out var removedRating);
                if (removed)
                {
                    _logger.Info($"Admin deleted review for {mediaType}:{tmdbId} by user {ResolveUserDisplay(userIdN)}.");
                    MirrorReviewRatingToUserData(userIdN, mediaType, tmdbId, removedRating, null);
                    return Ok(new { success = true, removed = true });
                }
                // Fail explicitly: nothing to delete means the review was
                // already gone (race with a concurrent delete, wrong
                // userIdN, or a stale admin click). Returning 200 here
                // lets the frontend think it succeeded and refresh to a
                // list that looks the same as before.
                return NotFound(new { success = false, removed = false, message = "No matching review to delete." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin failed to delete review for {mediaType}:{tmdbId} user {ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to delete review." });
            }
        }

        [HttpPost("reset-all-users-settings")]
        [Authorize]
        public IActionResult ResetAllUsersSettings()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            var defaultConfig = JellyfinEnhanced.Instance?.Configuration;

            if (defaultConfig == null)
            {
                return StatusCode(500, new { success = false, message = "Default plugin configuration not found." });
            }

            var defaultUserSettings = UserSettingsDefaults.Create(defaultConfig);

            var userCount = 0;
            var skippedSettings = new System.Collections.Generic.List<string>();
            var skippedHc = new System.Collections.Generic.List<string>();
            // Get all user IDs from the UserConfigurationManager's known users
            var userIds = _userConfigurationManager.GetAllUserIds();
            foreach (var userId in userIds)
            {
                try
                {
                    // Phase 4: a reset never sets or clears a person's own consents (under their settings lock).
                    _userConfigurationManager.ResetUserSettings(userId, defaultUserSettings);
                    userCount++;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Skipping settings.json reset for {ResolveUserDisplay(userId)}: {ex.Message}");
                    skippedSettings.Add(userId);
                }

                // Push HC Settings only — user's Items dict is data, not a default. Per-user errors are skipped, not fatal.
                try
                {
                    _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                        userId, "hidden-content.json", hc =>
                        {
                            hc.Settings = BuildHcDefaultSettings(defaultConfig);
                            return 1;
                        });
                    Services.HiddenContentResponseFilter.InvalidateUser(userId);
                }
                catch (Exception ex) when (ex is InvalidDataException
                                        || ex is Newtonsoft.Json.JsonException
                                        || ex is IOException
                                        || ex is UnauthorizedAccessException)
                {
                    _logger.Warning($"Skipping HC settings reset for {ResolveUserDisplay(userId)}: {ex.Message}");
                    skippedHc.Add(userId);
                }

                // Spoiler Guard: reset only the settings-like override Prefs to
                // "inherit admin policy". The Series/Movies/Collections/PendingTmdb lists
                // are user DATA (like HC Items) and are deliberately preserved. Only touch
                // existing files — creating spoilerblur.json here would seed empty state everywhere.
                try
                {
                    if (_userConfigurationManager.UserConfigurationExists(
                            userId, Services.SpoilerBlurImageFilter.SpoilerBlurFileName))
                    {
                        _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                            userId, Services.SpoilerBlurImageFilter.SpoilerBlurFileName, sb =>
                            {
                                sb.Prefs = new SpoilerBlurUserPrefs();
                                return 1;
                            });
                    }
                }
                catch (Exception ex) when (ex is InvalidDataException
                                        || ex is Newtonsoft.Json.JsonException
                                        || ex is IOException
                                        || ex is UnauthorizedAccessException)
                {
                    _logger.Warning($"Skipping Spoiler Guard prefs reset for {ResolveUserDisplay(userId)}: {ex.Message}");
                }
            }

            _logger.Info($"Reset settings for {userCount}/{userIds.Count()} users to plugin defaults. Skipped settings: {skippedSettings.Count}, skipped HC: {skippedHc.Count}.");
            return Ok(new
            {
                success = true,
                userCount,
                totalUsers = userIds.Count(),
                skippedSettingsUserIds = skippedSettings,
                skippedHcUserIds = skippedHc,
            });
        }

        /// <summary>
        /// Admin-triggered full tag cache rebuild (config page button). Unlike the
        /// "Refresh Tag Cache" scheduled task, which only rebuilds items Jellyfin
        /// has re-saved since the last run, this always recomputes every item —
        /// the only way to pick up a tag-computation change (e.g. a plugin update)
        /// for items nobody has actually edited. Runs in the background; the
        /// existing cache keeps serving requests until the new one is ready and
        /// the on-disk file is atomically replaced.
        /// </summary>
        [HttpPost("tag-cache/rebuild")]
        [Authorize]
        public IActionResult RebuildTagCache()
        {
            if (!IsAdminUser()) return Forbid();

            if (JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode != true)
            {
                return BadRequest(new { success = false, message = "Server-Side Tag Cache is disabled." });
            }

            if (!_tagCacheService.TryStartManualFullRebuild())
            {
                return Conflict(new { success = false, message = "A tag cache rebuild is already in progress." });
            }

            return Ok(new { success = true, message = "Tag cache rebuild started in the background." });
        }

        [HttpGet("tag-cache/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagCache(Guid userId, [FromQuery] long? since = null)
        {
            if (JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode != true)
            {
                return NotFound();
            }

            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // The body is serialized here, once, into the bytes that are sent AND
            // hashed for the ETag (see RespondTagCache) — with the options MVC's
            // formatter would have applied to Ok(payload), so it is the same body.
            var jsonOptions = TagCacheJsonOptions();

            // The one delivery gate: the whole body (items, review ratings) is
            // built under one read-set (every verdict input the build reads —
            // the user's Hidden Content and Spoiler Guard documents, the privacy
            // settings, the watched state and library facts of every entry it
            // judged — with its revision) and is accepted only when the gate,
            // after the build's last wait, lookup and lock, finds that set
            // unchanged. A changed one builds again (bounded); one that keeps
            // changing gets 503, never stale bytes. The body leaves later (its
            // result writes it): that writer checks the set again before it
            // starts (building again when it changed) and before every segment.
            Func<(Services.TagCacheResponseBody, Services.PrivacyReadSet?)?> rebuild = () =>
                Services.PrivacyDelivery.Deliver(user.Id, () => BuildTagCacheBody(user, since, jsonOptions), HttpContext, out var rebuilt) is { } fresh ? (fresh, rebuilt) : null;
            var body = Services.PrivacyDelivery.Deliver(user.Id, () => BuildTagCacheBody(user, since, jsonOptions), HttpContext, out var reads);
            if (body == null)
            {
                _logger.Warning($"Tag cache withheld (503): its verdict inputs kept changing ({Services.PrivacyReadSet.LastWithheld}).");
                Response.Headers["Cache-Control"] = "private, no-store";
                return StatusCode(503);
            }

            return RespondTagCache(body, reads, rebuild);
        }

        /// <summary>
        /// One composed tag-cache answer, before the review ratings, ETag and conditional check; <see cref="Keys"/> are the
        /// entries it holds (null: no policy judged any), <see cref="Owners"/> the owners of its extras (their verdicts).
        /// </summary>
        private sealed record TagCacheAnswer(long Version, long Timestamp, long ServedAt, string Access, string StripFingerprint, byte[] Items, int Count,
            IReadOnlyDictionary<string, Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry>? Keys = null, IReadOnlySet<Guid>? Owners = null);

        /// <summary>
        /// The user's tag-cache policies, read fresh (never a request's memo): the effective Spoiler Guard tag strip (null
        /// when nothing is stripped) and Hidden Content. Returns their joint revision.
        /// </summary>
        private string TagCachePolicies(JUser user, out Services.SpoilerTagStripPolicy? spoiler, out Services.HiddenContentPolicy hidden)
        {
            // Strict-read so corruption is observable (rate-limited warn) rather
            // than silently passing through. Loaded for the resolved user, not the
            // route value: an empty route id resolves to the caller, whose own
            // guard must still apply.
            var cfg = JellyfinEnhanced.Instance?.Configuration;
            spoiler = Services.SpoilerTagDataStripper.IsConfigured(cfg)
                ? Services.SpoilerTagDataStripper.CreatePolicy(cfg, LoadSpoilerStateForTagStrip(user.Id))
                : null;
            hidden = Services.HiddenContentPolicy.Load(_userConfigurationManager, user.Id, null, _libraryManager);
            return hidden.Revision + "|" + Services.SpoilerTagStripPolicy.RevisionOf(spoiler);
        }

        private (TagCacheAnswer Answer, string Revision) ComposeTagCache(JUser user, long? since, JsonSerializerOptions jsonOptions)
        {
            // Spoiler Guard tag-strip: when SpoilerBlur is on with any tag-relevant
            // strip toggle, walk the cache and zero out matching fields for unwatched
            // episodes whose parent series is in the spoiler list. Needed because the
            // JE tag-pipeline reads serverCache BEFORE GetTagData, so card overlays
            // would still leak despite the toggle. Mirrors the per-batch strip in GetTagData;
            // the logic lives in SpoilerTagDataStripper (shared with native poster tags).
            // Resolved BEFORE the cache read so a delta request can include the guarded
            // entries (below).
            // Hidden Content: a hidden item's entry is not answered (the same verdict as every list it would sit in), so
            // a viewer with hiding rules never shares another viewer's serialized cache.
            var revision = TagCachePolicies(user, out var spPolicy, out var hiddenPolicy);

            // A delta (?since=) only carries entries the library changed, but a
            // guarded entry is also rewritten by this user's PLAYED state: an
            // episode watched since their last load is no longer stripped, one
            // just added to their guard list now is. Clients keep the cache
            // across page loads (tag-cache-store.js), so every entry that may be
            // in the guarded set rides along with each delta (a guarded title's
            // entries, and the entries that may be extras, whose owners only the
            // batched lookup below knows); riders outside the set leave again in
            // the strip. Full loads and deltas derive the set with the one
            // function (SpoilerTagDataStripper.GuardedSet), so their filter
            // revisions agree for an unchanged state.
            Func<string, Jellyfin.Plugin.JellyfinEnhanced.Model.TagCacheEntry, bool>? guardedRider =
                since.HasValue && spPolicy != null
                    ? (key, e) => _spoilerTagDataStripper.MayBeGuarded(spPolicy.State, key, e)
                    : null;
            // Fingerprint of how this user's entries are filtered and stripped:
            // which cache entries their access excludes (from the same access
            // set that filtered `items`, see GetCacheForUser) and, under Spoiler
            // Guard, the effective strip flags and the guarded set. A full load
            // and a delta compute the same value, and it changes exactly when a
            // delta could not correct a stored copy: an entry no longer visible
            // to the user, an item leaving the guard set, or the strip policy
            // changing, so the client replaces its copy instead
            // (tags/tag-pipeline.js).
            var stripFingerprint = "none";

            // Server clock at capture (taken before reading the cache, so it never
            // post-dates the data): clients order stored snapshots by it. Unlike
            // the cache version, it keeps moving forward across a restart that
            // restores an older on-disk cache.
            var servedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            // Version/timestamp come from the same generation capture as the
            // cache contents (see GetCacheForUser): a cursor newer than the
            // returned items would let clients skip updates permanently, and a
            // mixed pre-publish stamp (timestamp 0) would disable their delta
            // refresh entirely.
            // A full load for a user without a Spoiler Guard strip is exactly the
            // generation's entries their access set admits, so its serialized
            // `items` is shared across requests and users with the same access
            // (every unrestricted user, typically): after a rebuild every client
            // downloads the whole cache, and re-serializing tens of MB per client
            // used to take seconds of CPU and hundreds of MB each. Those clients
            // arrive together, so the serialization runs one at a time and the
            // waiters find the first one's copy. While the cache is being
            // mutated nothing is shared (TryGetSerializedItems reports it not
            // shareable) and the request is serialized on its own below, like
            // the delta and strip paths.
            if (!since.HasValue && spPolicy == null && hiddenPolicy.IsEmpty)
            {
                if (_tagCacheService.TryGetSerializedItems(user, out var sharedVersion, out var sharedTimestamp, out var sharedAccessRevision, out var sharedItemsJson, out var sharedCount, out var shareable))
                {
                    return (new TagCacheAnswer(sharedVersion, sharedTimestamp, servedAt, sharedAccessRevision, stripFingerprint, sharedItemsJson, sharedCount), revision);
                }

                if (shareable)
                {
                    _tagCacheSerializationGate.Wait();
                    try
                    {
                        if (!_tagCacheService.TryGetSerializedItems(user, out sharedVersion, out sharedTimestamp, out sharedAccessRevision, out sharedItemsJson, out sharedCount, out _))
                        {
                            var sharedItems = _tagCacheService.GetShareableCacheForUser(user, out sharedVersion, out sharedTimestamp, out sharedAccessRevision, out var shareKey);
                            sharedItemsJson = JsonSerializer.SerializeToUtf8Bytes(sharedItems, jsonOptions);
                            sharedCount = sharedItems.Count;
                            if (shareKey != null)
                            {
                                _tagCacheService.StoreSerializedItems(shareKey, sharedItemsJson, sharedCount);
                            }
                        }
                    }
                    finally
                    {
                        _tagCacheSerializationGate.Release();
                    }

                    return (new TagCacheAnswer(sharedVersion, sharedTimestamp, servedAt, sharedAccessRevision, stripFingerprint, sharedItemsJson, sharedCount), revision);
                }
            }

            var items = _tagCacheService.GetCacheForUser(user, out var cacheVersion, out var cacheTimestamp, out var accessRevision, since, guardedRider);

            // Entries whose kind is not a title of its own (theme videos, trailers, featurettes) follow their owner: one
            // batched identity lookup gives both Hidden Content and Spoiler Guard the verdict tag data uses.
            var owned = !hiddenPolicy.IsEmpty || spPolicy != null ? _spoilerTagDataStripper.OwnedIdentities(items, user) : null;
            // Every episode and season entry by the series the library holds it under now (its cached entry names the series
            // and key it was built under): one batched lookup, shared by Hidden Content and Spoiler Guard.
            var entrySeries = !hiddenPolicy.IsEmpty || spPolicy != null ? _spoilerTagDataStripper.EntrySeries(items, hiddenPolicy.IsEmpty ? spPolicy!.State : null) : null;

            if (!hiddenPolicy.IsEmpty)
            {
                foreach (var identity in owned!.Values) hiddenPolicy.Bind(identity);
                foreach (var (key, entry) in items.ToList())
                {
                    if (owned.TryGetValue(key, out var ownedIdentity))
                    {
                        if (hiddenPolicy.IsHidden(ownedIdentity, "library")) items.Remove(key);
                        continue;
                    }
                    var kindName = entry?.Type;
                    // An episode or season is judged by the series it belongs to now (the library may have moved it since the entry was built).
                    var (series, seriesKey) = entry != null && kindName is "Episode" or "Season" && entrySeries!.TryGetValue(key, out var current)
                        ? current : (Guid.Empty, null);
                    var titleKey = kindName is "Episode" or "Season" ? seriesKey
                        : kindName == "Movie" && entrySeries!.TryGetValue(key, out var movieNow) ? movieNow.Key
                        : Services.HiddenContentPolicy.TitleIdentity(kindName == "Movie" ? "movie" : "tv", entry?.TmdbId);
                    if (hiddenPolicy.IsHidden(titleKey, key, series != Guid.Empty ? series.ToString("N") : entry?.SeriesId, "library")) items.Remove(key);
                }
                // The client replaces its stored copy (rather than applying a delta) when the hiding rules change.
                stripFingerprint = "h" + hiddenPolicy.Revision;
            }

            if (spPolicy != null)
            {
                stripFingerprint = (stripFingerprint == "none" ? "" : stripFingerprint + "|") + _spoilerTagDataStripper.StripTagCache(spPolicy, user, items, owned, since, entrySeries);
            }

            // `items` is final (post Spoiler Guard strip above); serialized once.
            var itemsJson = JsonSerializer.SerializeToUtf8Bytes(items, jsonOptions);
            return (new TagCacheAnswer(cacheVersion, cacheTimestamp, servedAt, accessRevision, stripFingerprint, itemsJson, items.Count, items,
                owned?.Values.Select(o => o.OwnerId).ToHashSet()), revision);
        }

        /// <summary>
        /// One attempt at the whole tag-cache body for the delivery gate: the composed items, then the review ratings and
        /// the body around them. The entries the answer holds are the items it judged (their watched state and ownership
        /// are its inputs); the shared, unfiltered copy judged none.
        /// </summary>
        private Services.TagCacheResponseBody BuildTagCacheBody(JUser user, long? since, JsonSerializerOptions jsonOptions)
        {
            var (answer, _) = ComposeTagCache(user, since, jsonOptions);
            // The library facts the answer's verdicts depend on were recorded by the reads that took them (the entries'
            // current series and keys, extras' owners, guarded seasons, collection members), with the facts they were judged
            // by; an entry whose verdict no library fact decides (judged by its own id) records none. The owners of its
            // extras are inputs too.
            if (answer.Owners != null && Services.PrivacyReadSet.Current is { } reads) reads.Library(answer.Owners);
            return ComposeTagCacheBody(answer, jsonOptions);
        }

        // The rest of the body — review ratings, filterRevision — for either
        // source of the items, built inside the delivery gate's attempt.
        private Services.TagCacheResponseBody ComposeTagCacheBody(TagCacheAnswer answer, JsonSerializerOptions jsonOptions)
        {
            // The poster review chips resolve from this map instead of asking
            // /reviews/ratings for every page of cards: it holds the average for
            // every item that has a rated review visible to THIS viewer (same
            // reviews, same visibility rule and same rating filter as that
            // endpoint), keyed "mediaType:tmdbKey". A key that is absent has no
            // visible rated review. Sent with full loads and deltas alike, since
            // reviews change independently of the tag cache; null (omitted) when
            // the chips are switched off, which tells the client to skip them.
            Dictionary<string, object>? reviewRatings = null;
            if (JellyfinEnhanced.Instance?.Configuration is { ShowUserReviews: true, ShowUserRatingOnPosters: true })
            {
                reviewRatings = new Dictionary<string, object>(StringComparer.Ordinal);
                var ctx = CreateReviewVisibilityContext(nameof(GetTagCache), "review ratings");
                foreach (var (key, sum, count) in AggregateVisibleReviewRatings(ctx, _ => true))
                {
                    reviewRatings[key] = new { average = sum / count, count };
                }
            }

            var filterRevision = Convert.ToHexString(
                SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(answer.Access + "#" + answer.StripFingerprint)), 0, 12);

            // Body { version, timestamp, servedAt, filterRevision, count, items,
            // reviewRatings }, assembled around the serialized items without
            // another serialization. The ETag is a hash of the FINAL response
            // body minus servedAt (see TagCacheResponseBody.ETag), not of
            // cacheVersion: two users at the same version can legitimately
            // receive different stripped bodies, and an ETag keyed on version
            // alone would let one user's stripped body satisfy another user's
            // conditional request.
            return Services.TagCacheResponseBody.Compose(
                jsonOptions,
                answer.Version,
                answer.Timestamp,
                answer.ServedAt,
                filterRevision,
                answer.Count,
                answer.Items,
                reviewRatings == null ? null : JsonSerializer.SerializeToUtf8Bytes(reviewRatings, jsonOptions));
        }

        // ETag/304 for a body the delivery gate let through, decided where the bytes
        // leave: the result re-checks the body's read-set before it answers (a
        // changed one builds the body again, ETag included) and before every
        // segment it writes.
        private IActionResult RespondTagCache(Services.TagCacheResponseBody body, Services.PrivacyReadSet? reads,
            Func<(Services.TagCacheResponseBody Body, Services.PrivacyReadSet? Reads)?> rebuild)
        {
            var ifNoneMatch = Request.Headers.TryGetValue("If-None-Match", out var header) ? header.ToString() : null;
            return body.ToActionResult(reads, rebuild, ifNoneMatch);
        }

        // The JsonSerializerOptions of the formatter MVC runs for an
        // application/json ObjectResult on this host. GetTagCache serializes its
        // own body (once, into the bytes it sends and hashes), so it has to use
        // exactly what Ok(payload) would have: resolved the way MVC's selector
        // does — the first registered JSON formatter that writes
        // application/json (Jellyfin registers its own PascalCase profile
        // formatter ahead of the default one) — and cached, since the formatter
        // list is fixed for the process.
        private static JsonSerializerOptions? _tagCacheJsonOptions;

        // One shareable full-load serialization at a time (see GetTagCache):
        // waiters re-check the shared copy once they get in, so a burst of
        // clients after a rebuild costs one serialization, not one each.
        private static readonly SemaphoreSlim _tagCacheSerializationGate = new(1, 1);

        private JsonSerializerOptions TagCacheJsonOptions()
        {
            var options = _tagCacheJsonOptions;
            if (options != null) return options;

            var formatters = HttpContext.RequestServices.GetRequiredService<IOptions<MvcOptions>>().Value.OutputFormatters;
            foreach (var formatter in formatters)
            {
                if (formatter is Microsoft.AspNetCore.Mvc.Formatters.SystemTextJsonOutputFormatter json
                    && json.SupportedMediaTypes.Any(type =>
                        Microsoft.Net.Http.Headers.MediaTypeHeaderValue.TryParse(type, out var parsed)
                        && parsed.MediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase)))
                {
                    options = json.SerializerOptions;
                    break;
                }
            }

            options ??= HttpContext.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Mvc.JsonOptions>>().Value.JsonSerializerOptions;
            _tagCacheJsonOptions = options;
            return options;
        }

        // ─── Activity Feed (recently watched / favorited / reviewed) ─────────────

        [HttpGet("activity")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetActivityFeed([FromQuery] int limit = 50, CancellationToken cancellationToken = default)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config?.ActivityFeedEnabled != true) return NotFound();

            var viewerUserId = UserHelper.GetCurrentUserId(User);
            if (!viewerUserId.HasValue || viewerUserId.Value == Guid.Empty) return Forbid();
            var viewer = _userManager.GetUserById(viewerUserId.Value);
            if (viewer == null) return Forbid();

            cancellationToken.ThrowIfCancellationRequested();
            var activity = config.ActivityFeedShowWatched || config.ActivityFeedShowFavorited
                ? _userConfigurationManager.GetAllActivity().Entries.Values.AsEnumerable()
                : Enumerable.Empty<ActivityEntry>();
            cancellationToken.ThrowIfCancellationRequested();
            var reviews = config.ActivityFeedShowReviewed
                ? _userConfigurationManager.GetAllReviews().Reviews.Values.AsEnumerable()
                : Enumerable.Empty<UserReview>();

            var builder = new Services.ActivityFeedBuilder(_libraryManager, _userManager, _itemRepository, _logger, Services.HiddenContentPolicy.Load(_userConfigurationManager, viewer.Id, HttpContext, _libraryManager));
            var items = builder.Build(activity, reviews, viewer, IsAdminUser(), config, limit, cancellationToken);
            return Ok(new { items });
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
                return Ok(new { pluginVersion = (string?)null, newSettings = new Dictionary<string, string>() });
            }

            return Ok(new { pluginVersion = state.PluginVersion, newSettings = state.NewSettings });
        }

        [HttpPost("whats-new/dismiss")]
        [Authorize]
        public IActionResult DismissWhatsNew()
        {
            if (!IsAdminUser()) return Forbid();

            _whatsNewService.Dismiss();
            return Ok();
        }

        [HttpPost("tag-data/{userId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetTagData(
            Guid userId,
            [FromBody] string[] ids,
            [FromQuery] string? mediaSourceId = null)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (ids == null || ids.Length == 0)
            {
                return BadRequest(new { error = "ids array required" });
            }

            if (ids.Length > 200)
            {
                return BadRequest(new { error = "Maximum 200 items per request" });
            }

            // A selected version goes through the same projection as the normal
            // tag-data path (PrivacyValues.TagData), so details-page callers keep
            // MediaStreamLanguageResolver's Matroska BCP-47 regions (en-US -> eng)
            // and no caller needs a second language-resolution implementation.
            //
            // The one delivery gate: the batch is projected under one verdict
            // identity (the user's Spoiler Guard tag strip and Hidden Content
            // revisions, the watched state and ownership of the batch's items)
            // and leaves only when the gate, after the projection's lookups,
            // finds it unchanged (else it is projected again, bounded; an
            // identity that keeps changing gets 503).
            var results = Services.PrivacyDelivery.Deliver(user.Id, () =>
            {
                var (projected, _, judged) = ProjectTagData(user, ids, mediaSourceId);
                Services.PrivacyReadSet.Current?.Library(judged);
                return projected;
            }, HttpContext);
            if (results == null)
            {
                _logger.Warning($"Tag data withheld (503): its verdict inputs kept changing ({Services.PrivacyReadSet.LastWithheld}).");
                Response.Headers["Cache-Control"] = "private, no-store";
                return StatusCode(503);
            }

            return Ok(new { Items = results });
        }

        /// <summary>One projection of a tag-data batch; with the items it judged (the batch's and their owners: an extra's verdict is its owner's).</summary>
        private (List<object> Results, string Revision, HashSet<Guid> Judged) ProjectTagData(JUser user, string[] ids, string? mediaSourceId)
        {
            // Spoiler Guard short-circuit: when the master switch + any tag-relevant
            // strip toggle are on and the user has entries in their spoiler list, a
            // protected item gets its stub (title replacement / overview strip
            // also enter the stub path, else the regular projection would carry
            // the raw path, display titles and source names). Per-category
            // overrides apply on top of admin policy (same "opt-out wins" contract
            // as ShouldStrip); see SpoilerTagDataStripper.CreatePolicy. Hidden
            // Content: a hidden item's card data is not answered, by the same
            // verdict as every list it would sit in (the item, its owning title,
            // that title's provider key). Loaded once per batch (not per item),
            // for the resolved user: an empty route id is the caller.
            var revision = TagCachePolicies(user, out var spoilerPolicy, out var hiddenPolicy);
            var hiddenIds = new HashSet<Guid>();
            if (!hiddenPolicy.IsEmpty)
            {
                var guids = ids.Select(i => Guid.TryParse(i?.Trim(), out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).Distinct().ToArray();
                var identities = Services.PrivacyIdentities.Resolve(_libraryManager, guids);
                foreach (var identity in identities.Values) hiddenPolicy.Bind(identity);
                foreach (var g in guids)
                    if (identities.TryGetValue(g, out var identity) ? hiddenPolicy.IsHidden(identity, "library") : hiddenPolicy.IsHidden(null, g.ToString("N"), null, "library")) hiddenIds.Add(g);
            }

            // Every value the answer carries is read by the construction table (PrivacyValues.TagData): a protected
            // item's stub from validated values and constructed names, any other item's own projection.
            var values = _spoilerTagDataStripper.Host();
            var request = new Services.PrivacyTagDataRequest(spoilerPolicy, mediaSourceId, JellyfinEnhanced.Instance?.Configuration?.SpoilerOverviewPlaceholder,
                container => TagEpisodeSelector.GetFirstEpisode(_libraryManager, container, user),
                episode => _spoilerTagDataStripper.GetTagDataStub(spoilerPolicy!, user, episode) != Services.SpoilerTagDataStub.None,
                episode => _spoilerTagDataStripper.CategoryReveal(spoilerPolicy!, user, episode));
            var results = new List<object>(ids.Length);
            var judged = new HashSet<Guid>();

            // Process items sequentially (Jellyfin library manager is not fully thread-safe for GetMediaSources)
            foreach (var idStr in ids)
            {
                if (!Guid.TryParse(idStr.Trim(), out var itemId))
                    continue;

                judged.Add(itemId);
                if (hiddenIds.Contains(itemId))
                    continue;

                var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
                if (item == null)
                    continue;

                judged.Add(item.OwnerId);
                var spoilerStub = spoilerPolicy != null
                    ? _spoilerTagDataStripper.GetTagDataStub(spoilerPolicy, user, item)
                    : Services.SpoilerTagDataStub.None;
                results.Add(Services.PrivacyValues.TagData(item, spoilerStub, request, values));
            }

            return (results, revision, judged);
        }


        /// <summary>
        /// Size and watch progress of an item and everything playable under it,
        /// in one response (see <see cref="Services.ItemStatsService"/>). The
        /// details page reads both chips from this; the two single-value
        /// routes below stay for older clients and other callers.
        /// </summary>
        [HttpGet("item-stats/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetItemStatsByItemId(Guid userId, Guid itemId, [FromQuery] string? mediaSourceId = null)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var stats = _itemStats.Compute(user, item, mediaSourceId);
            return Ok(new { success = true, size = stats.Size, progress = stats.Progress, totalPlaybackTicks = stats.TotalPlaybackTicks, totalRuntimeTicks = stats.TotalRuntimeTicks });
        }

        /// <summary>
        /// Admin-only support/testing view of Native Poster Tags: the tags <paramref name="userId"/> (default: the
        /// caller) would get on an item's poster in a native client, drawn with that user's settings and Spoiler
        /// Guard–stripped tag data. The artwork underneath is the unblurred original: Spoiler Guard's image
        /// blur / stock-card substitution is NOT applied here (native clients of a guarded item get it), which
        /// the X-JE-Poster-Tags-Artwork: original header states. Renders even when the user or the master switch
        /// has the feature off; the X-JE-Poster-Tags-* headers report that state. Never cached.
        /// </summary>
        /// <param name="itemId">Item whose Primary image to draw on.</param>
        /// <param name="userId">User whose settings, library access and Spoiler Guard state apply.</param>
        /// <param name="width">Maximum image width in pixels (default 360, 32–2048).</param>
        /// <param name="height">Optional maximum image height in pixels (32–2048).</param>
        /// <param name="topRightOffset">Force the played/unplayed indicator offset; default as native clients get it (played, or unplayed items left).</param>
        [HttpGet("native-poster-tags/preview/{itemId}")]
        [Authorize]
        public async Task<IActionResult> PreviewNativePosterTags(
            Guid itemId,
            [FromQuery] Guid? userId,
            [FromQuery] int? width,
            [FromQuery] int? height,
            [FromQuery] bool? topRightOffset,
            [FromServices] Services.PosterTags.PosterTagComposer composer,
            [FromServices] Services.PosterTags.PosterTagSettingsProvider posterTagSettings,
            [FromServices] MediaBrowser.Controller.Drawing.IImageProcessor imageProcessor)
        {
            if (!IsAdminUser()) return Forbid();

            var targetUserId = userId is { } requested && requested != Guid.Empty
                ? requested
                : UserHelper.GetCurrentUserId(User) ?? Guid.Empty;
            var user = targetUserId == Guid.Empty ? null : _userManager.GetUserById(targetUserId);
            if (user == null) return NotFound(new { message = "User not found." });

            // The target user's library access and parental rating apply.
            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item == null) return NotFound(new { message = "Item not found or not visible to this user." });
            if (!Services.TagCacheService.TaggableTypes.Contains(item.GetBaseItemKind()))
                return BadRequest(new { message = "Native poster tags only apply to movies, series, seasons, episodes, collections and videos." });

            var imageInfo = item.GetImageInfo(ImageType.Primary, 0);
            if (imageInfo == null) return NotFound(new { message = "Item has no Primary image." });
            if (!imageInfo.IsLocalFile) return BadRequest(new { message = "Item's Primary image is not stored locally yet." });

            try
            {
                var (path, _, _) = await imageProcessor.ProcessImage(new MediaBrowser.Controller.Drawing.ImageProcessingOptions
                {
                    Item = item,
                    ItemId = item.Id,
                    Image = imageInfo,
                    ImageIndex = 0,
                    MaxWidth = Math.Clamp(width ?? 360, 32, 2048),
                    MaxHeight = height.HasValue ? Math.Clamp(height.Value, 32, 2048) : null,
                    Quality = 90,
                    SupportedOutputFormats = new[] { MediaBrowser.Model.Drawing.ImageFormat.Jpg },
                }).ConfigureAwait(false);

                var settings = posterTagSettings.Get(user.Id);
                // Same rule the stamper applies to the card's own indicator
                // (NativePosterTagStamper.StampItem): played check or unplayed count.
                var offset = topRightOffset ?? (_userDataManager.GetUserDataDto(item, user) is { } userData
                    && (userData.Played || userData.UnplayedItemCount > 0));
                var original = await System.IO.File.ReadAllBytesAsync(path, HttpContext.RequestAborted).ConfigureAwait(false);
                var result = await composer.ComposeAsync(
                    HttpContext,
                    item,
                    user,
                    settings,
                    offset,
                    new Services.PosterTags.PosterTagBaseImage("image/jpeg", "preview", () => Task.FromResult(original)),
                    90,
                    useCache: false,
                    HttpContext.RequestAborted).ConfigureAwait(false);

                Response.Headers["Cache-Control"] = "no-store";
                Response.Headers["X-JE-Poster-Tags-Status"] = result.Status.ToString().ToLowerInvariant();
                Response.Headers["X-JE-Poster-Tags-Artwork"] = "original";
                Response.Headers["X-JE-Poster-Tags-Master-Enabled"] = (JellyfinEnhanced.Instance?.Configuration?.NativePosterTagsEnabled == true) ? "true" : "false";
                Response.Headers["X-JE-Poster-Tags-User-Enabled"] = settings.NativeEnabled ? "true" : "false";
                Response.Headers["X-JE-Poster-Tags-Any-Group"] = settings.AnyGroupEnabled ? "true" : "false";
                Response.Headers["X-JE-Poster-Tags-Settings-Digest"] = settings.Digest;
                Response.Headers["X-JE-Poster-Tags-Spoiler-Stripped"] = result.SpoilerStripped ? "true" : "false";
                return File(result.Bytes ?? original, "image/jpeg");
            }
            catch (Exception ex) when (!HttpContext.RequestAborted.IsCancellationRequested)
            {
                _logger.Warning($"Native poster tags preview failed for {itemId}: {ex.Message}");
                return StatusCode(500, new { message = "Preview failed: " + ex.Message });
            }
        }

        [HttpGet("file-size/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetFileSizeByItemId(Guid userId, Guid itemId, [FromQuery] string? mediaSourceId = null)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var stats = _itemStats.Compute(user, item, mediaSourceId);
            return Ok(new { success = true, size = stats.Size });
        }

        [HttpGet("watch-progress/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetWatchProgressByItemId(Guid userId, Guid itemId)
        {
            var authorizationResult = AuthorizeUserAccess(userId, out var user);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var stats = _itemStats.Compute(user, item, null);
            return Ok(new { success = true, progress = stats.Progress, totalPlaybackTicks = stats.TotalPlaybackTicks, totalRuntimeTicks = stats.TotalRuntimeTicks });
        }

        [HttpGet("jellyseerr/issue")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrIssues(
            [FromQuery] int? mediaId,
            [FromQuery] int take = 20,
            [FromQuery] int skip = 0,
            [FromQuery] string? filter = "all",
            [FromQuery] string? sort = "added")
        {
            take = Math.Clamp(take, 1, 200);
            skip = Math.Max(0, skip);

            var queryParts = new List<string>
            {
                $"take={take}",
                $"skip={skip}"
            };

            if (mediaId.HasValue && mediaId.Value > 0)
            {
                queryParts.Add($"mediaId={mediaId.Value}");
            }

            if (!string.IsNullOrWhiteSpace(filter))
            {
                queryParts.Add($"filter={Uri.EscapeDataString(filter)}");
            }

            if (!string.IsNullOrWhiteSpace(sort))
            {
                queryParts.Add($"sort={Uri.EscapeDataString(sort)}");
            }

            var queryString = string.Join("&", queryParts);
            var apiPath = string.IsNullOrWhiteSpace(queryString) ? "/api/v1/issue" : $"/api/v1/issue?{queryString}";

            return ProxyJellyseerrRequest(apiPath, HttpMethod.Get);
        }

        [HttpGet("jellyseerr/issue/{id}")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrIssueById(int id)
        {
            // V8-style guard. Seerr returns 500 for /issue/0 or /issue/-1.
            if (id <= 0)
            {
                return Task.FromResult<IActionResult>(BadRequest(new
                {
                    error = true,
                    code = "invalid_issue_id",
                    message = "Issue id must be positive."
                }));
            }
            return ProxyJellyseerrRequest($"/api/v1/issue/{id}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/issue")]
        [Authorize]
        public async Task<IActionResult> ReportJellyseerrIssue([FromBody] JsonElement issueBody)
        {
            return await ProxyJellyseerrRequest("/api/v1/issue", HttpMethod.Post, issueBody.ToString());
        }

        [HttpPost("UploadBrandingImage")]
        [Authorize]
        public async Task<IActionResult> UploadBrandingImage()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                if (Request.Form.Files.Count == 0)
                    return BadRequest("No file uploaded");

                var uploadedFile = Request.Form.Files[0];

                // Get fileName from form data
                string? fileName = Request.Form["fileName"].FirstOrDefault();
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    return BadRequest("fileName parameter is required in form data");
                }

                if (!TryResolveBrandingFilePath(fileName, out var normalizedFileName, out var filePath))
                {
                    return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
                }

                // Validate file type - accept only image files
                if (!uploadedFile.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                    return BadRequest("Only image files are allowed");

                const long maxFileSize = 10 * 1024 * 1024; // 10MB
                if (uploadedFile.Length > maxFileSize)
                    return BadRequest($"File too large (max 10MB)");

                // Get branding directory from central location
                var brandingDir = JellyfinEnhanced.BrandingDirectory;
                if (string.IsNullOrWhiteSpace(brandingDir))
                    return StatusCode(500, "Could not determine branding directory");

                Directory.CreateDirectory(brandingDir);

                // Save file
                using (var stream = new FileStream(filePath, FileMode.Create, FileAccess.Write))
                {
                    await uploadedFile.CopyToAsync(stream);
                }

                _logger.Info($"Successfully uploaded branding image: {normalizedFileName} ({uploadedFile.Length} bytes) to {brandingDir}");
                return Ok("File uploaded successfully");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.Error($"Permission denied when uploading branding image: {ex.Message}");
                return StatusCode(403, "Permission denied when uploading branding image.");
            }
            catch (Exception ex)
            {
                _logger.Error($"Error uploading branding image: {ex.Message}");
                return StatusCode(500, "An error occurred while uploading the branding image.");
            }
        }

        /// <summary>
        /// Which of the fixed branding slots have a custom image uploaded, in one request.
        /// </summary>
        [HttpGet("BrandingStatus")]
        [Authorize]
        public IActionResult GetBrandingStatus()
        {
            var brandingDir = JellyfinEnhanced.BrandingDirectory;
            var status = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in BrandingFileNames)
            {
                status[name] = !string.IsNullOrWhiteSpace(brandingDir)
                    && System.IO.File.Exists(Path.Combine(brandingDir, name));
            }

            return Ok(status);
        }

        [HttpGet("BrandingImage")]
        [Authorize]
        public IActionResult GetBrandingImage([FromQuery] string? fileName)
        {
            if (string.IsNullOrWhiteSpace(fileName))
            {
                return BadRequest("fileName query parameter is required");
            }

            if (!TryResolveBrandingFilePath(fileName, out _, out var filePath))
            {
                return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
            }

            if (!System.IO.File.Exists(filePath))
                return NotFound();

            var provider = new FileExtensionContentTypeProvider();
            if (!provider.TryGetContentType(filePath, out var contentType))
            {
                contentType = "application/octet-stream";
            }

            return PhysicalFile(filePath, contentType);
        }

        [HttpPost("DeleteBrandingImage")]
        [Authorize]
        public IActionResult DeleteBrandingImage()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                string? fileName = Request.Form["fileName"].FirstOrDefault();
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    return BadRequest("fileName parameter is required in form data");
                }

                if (!TryResolveBrandingFilePath(fileName, out var normalizedFileName, out var filePath))
                {
                    return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
                }

                var brandingDir = JellyfinEnhanced.BrandingDirectory;
                if (string.IsNullOrWhiteSpace(brandingDir))
                    return StatusCode(500, "Could not determine branding directory");

                if (!System.IO.File.Exists(filePath))
                    return NotFound("File not found");

                System.IO.File.Delete(filePath);
                _logger.Info($"Deleted branding image: {normalizedFileName} from {brandingDir}");
                return Ok("File deleted successfully");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.Error($"Permission denied when deleting branding image: {ex.Message}");
                return StatusCode(403, "Permission denied when deleting branding image.");
            }
            catch (Exception ex)
            {
                _logger.Error($"Error deleting branding image: {ex.Message}");
                return StatusCode(500, "An error occurred while deleting the branding image.");
            }
        }

        // ==================== Arr Links ====================

        [HttpGet("arr/validate/sonarr")]
        [Authorize]
        public async Task<IActionResult> ValidateSonarr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey, [FromQuery] string? instanceId = null)
        {
            return await ValidateArrService("Sonarr", url, apiKey, instanceId);
        }

        [HttpGet("arr/validate/radarr")]
        [Authorize]
        public async Task<IActionResult> ValidateRadarr([FromQuery] string url, [FromHeader(Name = "X-Arr-ApiKey")] string apiKey, [FromQuery] string? instanceId = null)
        {
            return await ValidateArrService("Radarr", url, apiKey, instanceId);
        }

        private async Task<IActionResult> ValidateArrService(string serviceName, string url, string apiKey, string? instanceId)
        {
            if (!IsAdminUser())
                return Forbid();

            // Saved instance keys reach the page masked; with the instance id the server tests the saved key.
            // Only against the saved URL of that instance, so a masked key can't be pointed elsewhere.
            var savedInstance = Services.Arr.ArrRegistryMigration.IsValidId(instanceId) ? new Services.Arr.ArrInstanceRegistry().Get(Guid.Parse(instanceId!).ToString("D")) : null;
            var submittedKey = apiKey;
            apiKey = ResolveSubmittedSecret(apiKey,
                savedInstance != null ? Services.Secrets.SecretsStore.ArrKeyName(savedInstance.Id) : null,
                url, savedInstance != null ? new[] { savedInstance.Url } : Array.Empty<string?>());
            if (string.IsNullOrWhiteSpace(apiKey) && Services.Secrets.SecretValue.IsPlaceholder(Services.Secrets.SecretValue.FromWire(submittedKey)) && JellyfinEnhanced.Instance?.Secrets?.IsAvailable == false)
                return StatusCode(503, new { ok = false, code = "SecretsUnavailable", message = "Saved keys can't be read right now (secrets.json is unreadable; see the server log). Type the key to test." });
            if (string.IsNullOrWhiteSpace(apiKey) && Services.Secrets.SecretValue.IsPlaceholder(Services.Secrets.SecretValue.FromWire(submittedKey)))
                return BadRequest(new { ok = false, code = "KeyNotForThisUrl", message = $"The saved API key is only used with this instance's saved URL. Type the key again to test a different {serviceName} address." });

            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = $"Missing {serviceName} URL or API key" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { ok = false, message = "Invalid URL" });

            // Same transport as every other arr call (no redirects, address pinned at connect) and the
            // reply must really be this app: a Radarr URL in a Sonarr slot used to pass on any 200.
            var kind = serviceName == "Sonarr" ? Services.Arr.ArrKind.Sonarr : Services.Arr.ArrKind.Radarr;
            var factory = _arrClientFactory ?? new Services.Arr.ArrClientFactory(_httpClientFactory, new Services.Arr.ArrInstanceRegistry());
            var client = factory.ForUnsaved(kind, url.Trim(), apiKey);
            Services.Arr.ArrResult<(Services.Arr.ArrSystemStatus Status, Services.Arr.ArrCapabilities Capabilities)> result;
            try
            {
                result = await client.GetSystemStatusAsync(refresh: true, HttpContext.RequestAborted);
            }
            catch (OperationCanceledException)
            {
                return StatusCode(499);
            }

            if (result.Ok)
            {
                var (status, capabilities) = result.Value;
                return Ok(new { ok = true, appName = status.AppName, version = status.Version, supported = capabilities.Supported, warnings = capabilities.Warnings });
            }

            var error = result.Error!;
            _logger.Warning($"{serviceName} validate failed for {url}: {error.Kind} {error.HttpStatus}");
            return error.Kind switch
            {
                Services.Arr.ArrErrorKind.Unauthorized => StatusCode(401, new { ok = false, code = error.Kind.ToString(), message = $"API key is invalid or unauthorized for {serviceName}" }),
                Services.Arr.ArrErrorKind.Timeout => StatusCode(504, new { ok = false, code = error.Kind.ToString(), message = $"Connection to {serviceName} timed out. Check the URL is correct." }),
                Services.Arr.ArrErrorKind.Unreachable or Services.Arr.ArrErrorKind.ConnectionLost
                    => StatusCode(502, new { ok = false, code = error.Kind.ToString(), message = $"Could not reach {serviceName}. Check the URL is correct and the server is running." }),
                Services.Arr.ArrErrorKind.WrongApp or Services.Arr.ArrErrorKind.InvalidResponse or Services.Arr.ArrErrorKind.Redirect or Services.Arr.ArrErrorKind.BlockedUrl
                    => StatusCode(502, new { ok = false, code = error.Kind.ToString(), message = error.Message }),
                _ => StatusCode(error.HttpStatus >= 400 ? error.HttpStatus : 502, new { ok = false, code = error.Kind.ToString(), message = $"{serviceName} returned an error: {error.Message}" }),
            };
        }

        [HttpGet("arr/identify-url")]
        [Authorize]
        public async Task<IActionResult> IdentifyUrl([FromQuery] string url)
        {
            if (!IsAdminUser())
                return Forbid();

            if (string.IsNullOrWhiteSpace(url))
                return BadRequest(new { reachable = false, service = "unknown" });

            if (!IsAllowedUrl(url))
                return BadRequest(new { reachable = false, service = "unknown" });

            var http = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            http.Timeout = TimeSpan.FromSeconds(5);
            var cleanUrl = url.TrimEnd('/');

            // Try Sonarr/Radarr (/api/v3/system/status)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/api/v3/system/status");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                    {
                        var json = await resp.Content.ReadAsStringAsync();
                        if (json.Contains("appName", StringComparison.Ordinal))
                        {
                            if (json.Contains("Sonarr", StringComparison.OrdinalIgnoreCase))
                                return Ok(new { reachable = true, service = "Sonarr" });
                            if (json.Contains("Radarr", StringComparison.OrdinalIgnoreCase))
                                return Ok(new { reachable = true, service = "Radarr" });
                        }
                    }
                }
                else if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized ||
                         resp.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    var contentType = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (contentType.Contains("json"))
                        return Ok(new { reachable = true, service = "arr" });
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try Jellyfin (/System/Info/Public — public endpoint, returns JSON)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/System/Info/Public");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                    {
                        var body = await resp.Content.ReadAsStringAsync();
                        if (body.Contains("ServerName", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Jellyfin" });
                    }
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try Jellyseerr (/api/v1/status — returns JSON)
            try
            {
                using var resp = await http.GetAsync($"{cleanUrl}/api/v1/status");
                if (resp.IsSuccessStatusCode)
                {
                    var ct = resp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("json"))
                        return Ok(new { reachable = true, service = "Seerr" });
                }
            }
            catch (HttpRequestException) { /* continue to next service probe */ }
            catch (TaskCanceledException) { /* continue to next service probe */ }

            // Try generic reachability — also check HTML title for service name
            try
            {
                using var resp = await http.GetAsync(cleanUrl, HttpCompletionOption.ResponseHeadersRead);
                if (resp.IsSuccessStatusCode)
                {
                    // Only read first 64KB — title tag is near the top of the HTML
                    var buffer = new byte[65536];
                    using var stream = await resp.Content.ReadAsStreamAsync();
                    var bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length);
                    var body = System.Text.Encoding.UTF8.GetString(buffer, 0, bytesRead);
                    // Check <title> tag for known service names (SPA root pages)
                    var titleMatch = System.Text.RegularExpressions.Regex.Match(
                        body, @"<title[^>]*>([^<]*)</title>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                    if (titleMatch.Success)
                    {
                        var title = titleMatch.Groups[1].Value;
                        if (title.Contains("Sonarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Sonarr" });
                        if (title.Contains("Radarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Radarr" });
                        if (title.Contains("Bazarr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Bazarr" });
                        if (title.Contains("Jellyseerr", StringComparison.OrdinalIgnoreCase)
                            || title.Contains("Overseerr", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Seerr" });
                        if (title.Contains("Jellyfin", StringComparison.OrdinalIgnoreCase))
                            return Ok(new { reachable = true, service = "Jellyfin" });
                    }
                }
                return Ok(new { reachable = true, service = "unknown" });
            }
            catch (HttpRequestException)
            {
                return Ok(new { reachable = false, service = "unknown" });
            }
            catch (TaskCanceledException)
            {
                return Ok(new { reachable = false, service = "unknown" });
            }
        }

        // ==================== Arr links (served from ArrStateStore's library index) ====================
        //
        // Every lookup below is an in-memory index hit: the library index of each instance is one
        // /movie or /series read, refreshed in the background (ArrStateStore), instead of one upstream
        // call per id and instance. All of these routes are admin-only and need Arr Links enabled.

        /// <summary>
        /// The 403 every arr page route returns when its feature is switched off on the server, so
        /// a disabled page can't be read through its route.
        /// </summary>
        private ObjectResult ArrFeatureDisabled(string feature)
            => StatusCode(403, new { error = true, code = "feature_disabled", message = feature + " is turned off in the Jellyfin Enhanced settings." });

        [HttpGet("arr/series-slug")]
        [Authorize]
        public async Task<IActionResult> GetSeriesSlug([FromQuery] int tvdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tvdbId <= 0)
                return BadRequest(new { error = "tvdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || _arrState == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });
            if (!config.ArrLinksEnabled)
                return ArrFeatureDisabled("Arr Links");

            WarnIfArrInstancesCorrupt(config);
            var instances = _arrState.Instances(Services.Arr.ArrKind.Sonarr);
            if (instances.Count == 0)
            {
                if (config.IsSonarrInstancesCorrupt())
                    return StatusCode(500, new { error = "Sonarr instance configuration is corrupt — see server logs" });
                return NotFound(new { error = "Sonarr is not configured" });
            }

            using var scope = _arrState.BeginRequest("arr/series-slug");
            var read = await _arrState.GetLibraryAsync(instances[0], HttpContext.RequestAborted).ConfigureAwait(false);
            if (read.Value == null)
                return StatusCode(502, new { error = $"Sonarr fetch failed: {Services.Arr.ArrLegacyViews.ShortReason(read.Error!)}" });

            // Legacy endpoint: 404 rather than 200+null when the series (or its slug) is missing.
            var titleSlug = read.Value.SeriesByTvdb(tvdbId)?.TitleSlug;
            if (string.IsNullOrEmpty(titleSlug))
                return NotFound(new { error = "Series not found in Sonarr" });
            return Ok(new { titleSlug });
        }

        [HttpGet("arr/series-slugs")]
        [Authorize]
        public async Task<IActionResult> GetSeriesSlugs([FromQuery] int tvdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tvdbId <= 0)
                return BadRequest(new { error = "tvdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || _arrState == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });
            if (!config.ArrLinksEnabled)
                return ArrFeatureDisabled("Arr Links");

            WarnIfArrInstancesCorrupt(config);
            var instances = _arrState.Instances(Services.Arr.ArrKind.Sonarr);
            if (instances.Count == 0)
                return Ok(BuildNoArrInstancesResult("Sonarr", config.IsSonarrInstancesCorrupt(), config.GetSonarrInstances().Count > 0));

            using var scope = _arrState.BeginRequest("arr/series-slugs");
            var libraries = await ReadLibrariesAsync(instances, HttpContext.RequestAborted).ConfigureAwait(false);
            return Ok(BuildArrLookupResult(instances, libraries, lib => lib.SeriesByTvdb(tvdbId), (i, s) => Services.Arr.ArrLegacyViews.SeriesMatch(i, (Services.Arr.ArrSeriesEntry?)s)));
        }

        /// <summary>
        /// Response for <c>arr/series-slugs</c> / <c>arr/movie-instances</c> (and each entry of
        /// <c>arr/links</c>) when no instance of that kind is enabled. Distinguishes "config corrupt"
        /// and "admin disabled everything" from "never configured" so the frontend can toast the
        /// right message instead of silently showing no links.
        /// </summary>
        private static object BuildNoArrInstancesResult(string serviceName, bool corrupt, bool anyConfigured)
        {
            var errList = new List<object>();
            if (corrupt)
                errList.Add(new { instanceName = serviceName, reason = "config corrupt — see server logs" });
            else if (anyConfigured)
                errList.Add(new { instanceName = serviceName, reason = $"all {serviceName} instances are disabled" });
            return new { matches = Array.Empty<object>(), errors = errList };
        }

        /// <summary>The library index of every instance (same order), read in parallel from the store.</summary>
        private async Task<Services.Arr.ArrSnapshotRead<Services.Arr.ArrLibrarySnapshot>[]> ReadLibrariesAsync(IReadOnlyList<Services.Arr.ArrConnection> instances, CancellationToken ct)
            => await Task.WhenAll(instances.Select(i => _arrState!.GetLibraryAsync(i, ct))).ConfigureAwait(false);

        /// <summary>
        /// Folds per-instance index lookups (same order as <paramref name="instances"/>) into the
        /// <c>{ matches, errors }</c> shape shared by the single and batch arr link endpoints. An
        /// instance whose latest read failed reports the error, even while the index read before
        /// still answers the lookup (so a revoked key or a down instance is not hidden behind cached
        /// links); an index that is there but older than its freshness target is still used (a
        /// refresh is already running).
        /// </summary>
        private object BuildArrLookupResult(
            IReadOnlyList<Services.Arr.ArrConnection> instances,
            IReadOnlyList<Services.Arr.ArrSnapshotRead<Services.Arr.ArrLibrarySnapshot>> libraries,
            Func<Services.Arr.ArrLibrarySnapshot, object?> find,
            Func<Services.Arr.ArrConnection, object?, object?> shape)
        {
            var isAdmin = IsAdminUser();
            var matches = new List<object>();
            var errors = new List<object>();
            for (int i = 0; i < instances.Count; i++)
            {
                var read = libraries[i];
                if (read.Error != null)
                {
                    errors.Add(Services.Arr.ArrLegacyViews.InstanceError(instances[i], read.Error, isAdmin, withSource: false));
                }
                if (read.Value == null) continue;
                if (shape(instances[i], find(read.Value)) is { } match) matches.Add(match);
            }

            return new { matches, errors };
        }

        // Batch arr link lookup limits. The Requests page shows 20 cards, so 100 leaves room for
        // other callers. (Lookups are in-memory now; the cap keeps the query string bounded.)
        private const int ArrLinksBatchMaxIds = 100;

        /// <summary>
        /// Batch form of <c>arr/movie-instances</c> + <c>arr/series-slugs</c> for pages that
        /// show many items at once (the Requests page). Each value is exactly what the matching
        /// single endpoint returns for that id. Served from the library index: no upstream call
        /// per id (the old route made one per id and instance).
        /// </summary>
        /// <param name="tmdbIds">Comma-separated positive TMDB movie ids (Radarr).</param>
        /// <param name="tvdbIds">Comma-separated positive TVDB series ids (Sonarr).</param>
        [HttpGet("arr/links")]
        [Authorize]
        public async Task<IActionResult> GetArrLinks([FromQuery] string? tmdbIds, [FromQuery] string? tvdbIds)
        {
            if (!IsAdminUser())
                return Forbid();

            var movieIds = ParsePositiveIdList(tmdbIds);
            var seriesIds = ParsePositiveIdList(tvdbIds);
            if (movieIds.Count + seriesIds.Count == 0)
                return BadRequest(new { error = "tmdbIds or tvdbIds must contain at least one positive integer" });
            if (movieIds.Count + seriesIds.Count > ArrLinksBatchMaxIds)
                return BadRequest(new { error = $"At most {ArrLinksBatchMaxIds} ids per request" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || _arrState == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });
            if (!config.ArrLinksEnabled)
                return ArrFeatureDisabled("Arr Links");

            WarnIfArrInstancesCorrupt(config);
            var ct = HttpContext.RequestAborted;
            using var scope = _arrState.BeginRequest("arr/links");
            try
            {
                var movies = await LookupArrLinksBatchAsync(
                    movieIds,
                    movieIds.Count > 0 ? _arrState.Instances(Services.Arr.ArrKind.Radarr) : Array.Empty<Services.Arr.ArrConnection>(),
                    () => BuildNoArrInstancesResult("Radarr", config.IsRadarrInstancesCorrupt(), config.GetRadarrInstances().Count > 0),
                    (lib, id) => lib.MovieByTmdb(id),
                    (i, m) => Services.Arr.ArrLegacyViews.MovieMatch(i, (Services.Arr.ArrMovieEntry?)m),
                    ct).ConfigureAwait(false);
                var series = await LookupArrLinksBatchAsync(
                    seriesIds,
                    seriesIds.Count > 0 ? _arrState.Instances(Services.Arr.ArrKind.Sonarr) : Array.Empty<Services.Arr.ArrConnection>(),
                    () => BuildNoArrInstancesResult("Sonarr", config.IsSonarrInstancesCorrupt(), config.GetSonarrInstances().Count > 0),
                    (lib, id) => lib.SeriesByTvdb(id),
                    (i, s) => Services.Arr.ArrLegacyViews.SeriesMatch(i, (Services.Arr.ArrSeriesEntry?)s),
                    ct).ConfigureAwait(false);
                return Ok(new { movies, series });
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // Browser went away (navigated off, aborted a superseded lookup) -
                // expected under normal use, not a failure worth logging.
                return StatusCode(499);
            }
        }

        /// <summary>
        /// Parses a comma-separated id list: positive ints only, malformed entries ignored,
        /// duplicates removed (first-seen order kept).
        /// </summary>
        private static List<int> ParsePositiveIdList(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return new List<int>();
            var seen = new HashSet<int>();
            return raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(part => int.TryParse(part, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var id) ? id : 0)
                .Where(id => id > 0 && seen.Add(id))
                .ToList();
        }

        /// <summary>id → <c>{ matches, errors }</c> for every id, from one index read per instance.</summary>
        private async Task<Dictionary<string, object>> LookupArrLinksBatchAsync(
            IReadOnlyList<int> ids,
            IReadOnlyList<Services.Arr.ArrConnection> instances,
            Func<object> noInstancesResult,
            Func<Services.Arr.ArrLibrarySnapshot, int, object?> find,
            Func<Services.Arr.ArrConnection, object?, object?> shape,
            CancellationToken ct)
        {
            var result = new Dictionary<string, object>(ids.Count);
            if (ids.Count == 0) return result;

            if (instances.Count == 0)
            {
                var empty = noInstancesResult();
                foreach (var id in ids)
                    result[id.ToString(System.Globalization.CultureInfo.InvariantCulture)] = empty;
                return result;
            }

            var libraries = await ReadLibrariesAsync(instances, ct).ConfigureAwait(false);
            foreach (var id in ids)
                result[id.ToString(System.Globalization.CultureInfo.InvariantCulture)] = BuildArrLookupResult(instances, libraries, lib => find(lib, id), shape);
            return result;
        }

        /// <summary>
        /// Fetches and maps one Shoko endpoint (the calendar's anime source). Sonarr and Radarr are
        /// read through <see cref="Services.Arr.ArrStateStore"/> instead.
        /// </summary>
        private async Task<(T Result, string? Error)> FetchAndMapAsync<T>(
            ArrInstance instance,
            string endpointPath,
            Func<dynamic?, T> mapper,
            T emptyResult,
            TimeSpan timeout,
            string contextLabel,
            CancellationToken ct,
            string authHeaderName = "X-Api-Key")
        {
            if (!await IsAllowedUrlAsync(instance.Url, ct).ConfigureAwait(false))
                return (emptyResult, "URL rejected by SSRF guard");

            try
            {
                var url = instance.Url.TrimEnd('/');
                // DefaultRequestHeaders mutations remain thread-unsafe for pooled instances,
                // so the API key is set per-request via HttpRequestMessage below.
                var client = _httpClientFactory.CreateClient();
                client.Timeout = timeout;

                var request = new HttpRequestMessage(HttpMethod.Get, $"{url}{endpointPath}");
                request.Headers.TryAddWithoutValidation(authHeaderName, instance.ApiKey);
                var response = await client.SendAsync(request, ct);

                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized
                    || response.StatusCode == System.Net.HttpStatusCode.Forbidden)
                {
                    _logger.Error($"Authentication failed for {contextLabel} from {instance.Name}: HTTP {(int)response.StatusCode}");
                    return (emptyResult, $"authentication failed ({(int)response.StatusCode})");
                }

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Error($"Upstream error fetching {contextLabel} from {instance.Name}: HTTP {(int)response.StatusCode}");
                    return (emptyResult, $"HTTP {(int)response.StatusCode}");
                }

                var json = await response.Content.ReadAsStringAsync(ct);
                var data = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic>(json);
                return (mapper(data), null);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (HttpRequestException ex)
            {
                _logger.Error($"Network error fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "network error");
            }
            catch (TaskCanceledException ex)
            {
                _logger.Error($"Timeout fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "timeout");
            }
            catch (Newtonsoft.Json.JsonException ex)
            {
                _logger.Error($"Invalid JSON from {contextLabel} {instance.Name}: {ex.Message}");
                return (emptyResult, "invalid response");
            }
            catch (Exception ex)
            {
                _logger.Error($"Unexpected error fetching {contextLabel} from {instance.Name}: {ex.Message}");
                return (emptyResult, "internal error");
            }
        }

        [HttpGet("arr/movie-instances")]
        [Authorize]
        public async Task<IActionResult> GetMovieInstances([FromQuery] int tmdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (tmdbId <= 0)
                return BadRequest(new { error = "tmdbId must be a positive integer" });

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || _arrState == null)
                return StatusCode(500, new { error = "Plugin configuration not available" });
            if (!config.ArrLinksEnabled)
                return ArrFeatureDisabled("Arr Links");

            WarnIfArrInstancesCorrupt(config);
            var instances = _arrState.Instances(Services.Arr.ArrKind.Radarr);
            if (instances.Count == 0)
                return Ok(BuildNoArrInstancesResult("Radarr", config.IsRadarrInstancesCorrupt(), config.GetRadarrInstances().Count > 0));

            using var scope = _arrState.BeginRequest("arr/movie-instances");
            var libraries = await ReadLibrariesAsync(instances, HttpContext.RequestAborted).ConfigureAwait(false);
            return Ok(BuildArrLookupResult(instances, libraries, lib => lib.MovieByTmdb(tmdbId), (i, m) => Services.Arr.ArrLegacyViews.MovieMatch(i, (Services.Arr.ArrMovieEntry?)m)));
        }
        // ==================== Active Streams ====================

        [HttpGet("active-streams/sessions")]
        [Authorize]
        public IActionResult GetActiveSessions()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            // Non-admins only allowed if ActiveStreamsAllUsers is on
            if (!IsAdminUser() && !config.ActiveStreamsAllUsers)
                return Forbid();

            try
            {
                return Ok(BuildActiveSessionList(IsAdminUser()));
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get active sessions: {ex.Message}");
                return StatusCode(500, "Failed to retrieve sessions.");
            }
        }

        /// <summary>
        /// Whether the caller may read the active-streams session list: the feature
        /// is on and the caller is an admin or ActiveStreamsAllUsers is set. The same
        /// gate GetActiveSessions applies, for the bootstrap payload.
        /// </summary>
        private static bool CanReadActiveSessions(Configuration.PluginConfiguration config, bool isAdmin)
            => config.ActiveStreamsEnabled && (isAdmin || config.ActiveStreamsAllUsers);

        /// <summary>
        /// The now-playing sessions as GET active-streams/sessions returns them
        /// (client IPs only for admins). Callers apply the access gate first.
        /// </summary>
        private List<object> BuildActiveSessionList(bool isAdmin)
        {
            var sessions = _sessionManager.Sessions
                .Where(s => s.NowPlayingItem != null)
                .Select(s => new
                {
                    UserId = s.UserId,
                    UserName = s.UserName,
                    UserHasPrimaryImage = s.UserPrimaryImageTag != null,
                    Client = s.Client,
                    DeviceName = s.DeviceName,
                    // IP only for admins
                    RemoteEndPoint = isAdmin ? s.RemoteEndPoint : null,
                    LastActivityDate = s.LastActivityDate,
                    NowPlayingItem = s.NowPlayingItem == null ? null : new
                    {
                        Id = s.NowPlayingItem.Id.ToString("N"),
                        Type = s.NowPlayingItem.Type.ToString(),
                        s.NowPlayingItem.Name,
                        s.NowPlayingItem.SeriesName,
                        s.NowPlayingItem.RunTimeTicks,
                        s.NowPlayingItem.ProductionYear,
                        ParentIndexNumber = s.NowPlayingItem.ParentIndexNumber,
                        IndexNumber = s.NowPlayingItem.IndexNumber,
                        ImageTags = s.NowPlayingItem.ImageTags != null
                            ? s.NowPlayingItem.ImageTags.ToDictionary(kv => kv.Key.ToString(), kv => kv.Value)
                            : null,
                        SeriesId = s.NowPlayingItem.SeriesId?.ToString("N"),
                        SeriesPrimaryImageTag = s.NowPlayingItem.SeriesPrimaryImageTag,
                        // Materialized here (not during serialization) so a failure
                    // surfaces to the caller's try/catch.
                    MediaStreams = s.NowPlayingItem.MediaStreams?.Select(ms => new
                        {
                            ms.Type,
                            ms.Codec,
                            ms.BitRate
                        }).ToList()
                    },
                    PlayState = s.PlayState == null ? null : new
                    {
                        s.PlayState.IsPaused,
                        s.PlayState.PositionTicks,
                        s.PlayState.PlayMethod
                    },
                    TranscodingInfo = s.TranscodingInfo == null ? null : new
                    {
                        s.TranscodingInfo.IsVideoDirect,
                        s.TranscodingInfo.VideoCodec,
                        s.TranscodingInfo.AudioCodec,
                        s.TranscodingInfo.Bitrate,
                        s.TranscodingInfo.TranscodeReasons,
                        s.TranscodingInfo.CompletionPercentage,
                        s.TranscodingInfo.Width,
                        s.TranscodingInfo.Height,
                        s.TranscodingInfo.Framerate
                    }
                });

            return sessions.ToList<object>();
        }

        [HttpPost("active-streams/broadcast")]
        [Authorize]
        public async Task<IActionResult> BroadcastMessage([FromBody] BroadcastMessageRequest request)
        {
            if (!IsAdminUser())
                return Forbid();

            if (request == null || string.IsNullOrWhiteSpace(request.Text))
                return BadRequest("Message text is required.");

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            var sent = 0;
            var skipped = 0;
            var errors = new List<string>();

            // Use the current session as the controlling session (admin's own session)
            var controllingSessionId = string.Empty;
            try
            {
                var adminSession = _sessionManager.Sessions
                    .FirstOrDefault(s => s.UserId == GetCurrentUserId());
                controllingSessionId = adminSession?.Id ?? string.Empty;
            }
            catch { /* non-fatal — empty string is accepted */ }

            var command = new MediaBrowser.Model.Session.MessageCommand
            {
                Header = request.Header,
                Text = request.Text,
                TimeoutMs = request.TimeoutMs
            };

            foreach (var session in _sessionManager.Sessions)
            {
                // Skip sessions with no real user
                if (string.IsNullOrWhiteSpace(session.UserName) ||
                    string.Equals(session.UserName, "Unknown", StringComparison.OrdinalIgnoreCase))
                {
                    skipped++;
                    continue;
                }

                try
                {
                    await _sessionManager.SendMessageCommand(
                        controllingSessionId,
                        session.Id,
                        command,
                        CancellationToken.None).ConfigureAwait(false);
                    sent++;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Broadcast: failed to send to session {session.Id} ({session.UserName}): {ex.Message}");
                    errors.Add($"{session.UserName}: {ex.Message}");
                    skipped++;
                }
            }

            return Ok(new { sent, skipped, errors });
        }

        private Guid GetCurrentUserId()
        {
            var claim = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)
                     ?? User.FindFirst("sub")
                     ?? User.FindFirst("Sid");
            if (claim != null && Guid.TryParse(claim.Value, out var id))
                return id;
            return Guid.Empty;
        }

        private string ResolveUserDisplay(string userId)
        {
            try
            {
                // Accept both dashed and dashless GUIDs
                if (Guid.TryParse(userId, out var guid) ||
                    Guid.TryParseExact(userId, "N", out guid))
                {
                    var user = _userManager.GetUserById(guid);
                    if (user != null)
                        return $"{user.Username} ({userId})";
                }
            }
            catch { /* non-fatal */ }
            return userId;
        }

        // Dedup tracker for high-frequency polling log lines.
        // Key = (userId, apiPath), Value = (last logged message, count since last log, last log time)
        private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, (string LastMsg, int Count, DateTime LastLogged)>
            _pollLogDedup = new();
        private static readonly TimeSpan _pollLogInterval = TimeSpan.FromMinutes(5);

        // Tag-cache + tag-data both load the user's spoiler state. Strict-read so
        // corruption is detected (rate-limited warn), then fall back to null so the
        // strip silently no-ops rather than 503-ing the unrelated tag-cache request —
        // the user's own /spoiler-blur/series endpoint will 503 next call. See
        // IsMovieInSpoilerScope for scope semantics (direct or via opted-in BoxSet).

        private UserSpoilerBlur? LoadSpoilerStateForTagStrip(Guid userId)
        {
            var userKey = userId.ToString("N");
            var fileName = Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
            if (!_userConfigurationManager.UserConfigurationExists(userKey, fileName))
            {
                return null;
            }
            try
            {
                return _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(userKey, fileName);
            }
            catch (InvalidDataException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-corrupt:" + userKey,
                    $"Spoiler Guard tag-strip: spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {ex.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), ex.Message);
                return null;
            }
            catch (Newtonsoft.Json.JsonException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-corrupt:" + userKey,
                    $"Spoiler Guard tag-strip: spoilerblur.json corrupt for {ResolveUserDisplay(userKey)} (backed up): {ex.Message}");
                Services.SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), ex.Message);
                return null;
            }
            catch (IOException ex)
            {
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-io:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-strip: IO error reading state for {ResolveUserDisplay(userKey)}: {ex.Message}");
                return null;
            }
            catch (Exception ex)
            {
                // The specific catches above handle InvalidData/Json/IOException.
                // Others (UnauthorizedAccess from a chmod-mangled config dir, Security,
                // PathTooLong, DirectoryNotFound) would otherwise escape and 500 the whole
                // tag-cache/tag-data request, breaking every client's tag rail on every poll.
                // Catch-all returns null (skip strip) with rate-limited warn so a real
                // failure mode stays observable without taking down the unrelated surface.
                _spoilerResolver.WarnRateLimited(
                    "tagstrip-unexpected:" + ex.GetType().FullName,
                    $"Spoiler Guard tag-strip: unexpected {ex.GetType().Name} reading state for {ResolveUserDisplay(userKey)}: {ex.Message}");
                return null;
            }
        }

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

        /// <summary>
        /// With "Only show downloads users asked for" on, non-admin users see downloads/history only
        /// for items they requested via Seerr (on top of the library-access rule every non-admin
        /// row passes, see <see cref="ArrAudienceFilter"/>). Returns Blocked=true when the caller
        /// should be shown an empty result (no Seerr link, no linked account, or no requests to
        /// filter by) rather than the unfiltered arr queue/history.
        /// </summary>
        private async Task<(bool Blocked, HashSet<(int TmdbId, string MediaType)>? Allowed)> GetAllowedRequestsForCurrentUserAsync(PluginConfiguration config)
        {
            if (IsAdminUser() || !config.DownloadsFilterByUserRequests)
                return (false, null);

            if (!config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()))
                return (true, null);

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return (true, null);

            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(jellyseerrUserId))
                return (true, null);

            var userRequests = await GetJellyseerrRequestsForUser(jellyseerrUserId);
            if (userRequests == null || userRequests.Count == 0)
                return (true, null);

            return (false, new HashSet<(int, string)>(userRequests.Select(r => (r.TmdbId, r.MediaType))));
        }

        private static List<T> FilterByAllowedRequests<T>(IEnumerable<T> items, HashSet<(int TmdbId, string MediaType)>? allowedRequests, Func<T, string> source, Func<T, int?> tmdbId)
        {
            if (allowedRequests == null) return items.ToList();
            return items.Where(item =>
            {
                var mediaType = source(item) == nameof(ArrType.Sonarr) ? "tv" : "movie";
                return tmdbId(item) is int id && allowedRequests.Contains((id, mediaType));
            }).ToList();
        }

        /// <summary>
        /// The caller, when their own Seerr requests could show them more of the queue or history
        /// than the audience alone does: the request filter is off (its list is the proof when it is
        /// on), the request read model isn't running (the integration or phase 1 off; the audience
        /// asks it otherwise), Seerr is set up, and the caller is a member who could lose titles
        /// Jellyfin doesn't have yet (content limits, or not every library). Null otherwise. Nothing
        /// is read here: the requests are read only when some row actually waits on them
        /// (<see cref="GetAskedProofAsync"/>).
        /// </summary>
        private Jellyfin.Database.Implementations.Entities.User? AskedProofCandidate(PluginConfiguration config, HashSet<(int TmdbId, string MediaType)>? allowedRequests)
        {
            if (allowedRequests != null || IsAdminUser() || Services.Acquire.SeerrRequestReadModel.IsActive(config)) return null;
            if (!config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()))
                return null;
            return ArrCaller.Human(User, _userManager) is { } user && Services.Arr.Live.ArrFeedAudience.NeedsAskedProof(user) ? user : null;
        }

        /// <summary>
        /// The titles <paramref name="user"/> asked for in Seerr, read the legacy way, through
        /// <see cref="SeerrAskedProofCache"/>: shared by the queue and history routes, reused for
        /// about a poll interval, and never waited on for more than a moment (no answer in time =
        /// null, and the rows that needed it stay hidden this time).
        /// </summary>
        private Task<IReadOnlySet<(int TmdbId, string MediaType)>?> GetAskedProofAsync(PluginConfiguration config, Jellyfin.Database.Implementations.Entities.User user)
        {
            var jellyfinUserId = user.Id.ToString();
            return SeerrAskedProofCache.Shared.GetAsync(jellyfinUserId + "|" + config.JellyseerrUrls.Trim(), async () =>
            {
                var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId).ConfigureAwait(false);
                if (string.IsNullOrEmpty(jellyseerrUserId)) return null;
                var userRequests = await GetJellyseerrRequestsForUser(jellyseerrUserId).ConfigureAwait(false);
                return userRequests == null ? null : new HashSet<(int, string)>(userRequests.Select(r => (r.TmdbId, r.MediaType)));
            });
        }

        /// <summary>
        /// The queue or history records of one instance a non-administrator may see: each record's
        /// title (the movie, or the episode / season / series a Sonarr row is about) must pass the
        /// change feed's audience rule for that instance, the same rule live updates use (Jellyfin's
        /// own check for titles it has, so hidden libraries, parental limits and hidden episodes of
        /// a visible series stay hidden; titles not in Jellyfin yet by the instance's linked
        /// libraries, or for the user who asked for them: the request read model, or
        /// <paramref name="askedProof"/>). A record without a TMDB (movie) or TVDB (series) id is
        /// never shown; neither is anything to a caller who isn't a Jellyfin user. Served from
        /// memory and Jellyfin's library (no arr call); answers are cached per user. Keys left out
        /// only for want of that proof go into <paramref name="absent"/> when given.
        /// </summary>
        private IReadOnlyList<T> ArrAudienceFilter<T>(Services.Arr.ArrConnection instance, IReadOnlyList<T> records, Func<T, (int? Tmdb, int? Tvdb, int? Season, int? Episode)> ids, IReadOnlySet<(int TmdbId, string MediaType)>? askedProof, ICollection<string>? absent = null)
        {
            var mask = ArrAudienceMask(instance, records, ids, askedProof, absent);
            var kept = new List<T>(records.Count);
            for (var i = 0; i < records.Count; i++)
            {
                if (mask[i]) kept.Add(records[i]);
            }
            return kept;
        }

        // Per record: may the caller see it (see ArrAudienceFilter). Each title key is asked once.
        private bool[] ArrAudienceMask<T>(Services.Arr.ArrConnection instance, IReadOnlyList<T> records, Func<T, (int? Tmdb, int? Tvdb, int? Season, int? Episode)> ids, IReadOnlySet<(int TmdbId, string MediaType)>? askedProof, ICollection<string>? absent = null)
        {
            var mask = new bool[records.Count];
            if (records.Count == 0) return mask;
            if (_feedAudience == null || ArrCaller.PersonId(User) is not Guid userId) return mask;
            var radarr = instance.Kind == Services.Arr.ArrKind.Radarr;
            var keys = new string?[records.Count];
            var asked = new HashSet<string>(StringComparer.Ordinal);
            HashSet<string>? askedFor = null;
            for (var i = 0; i < records.Count; i++)
            {
                var (tmdb, tvdb, season, episode) = ids(records[i]);
                keys[i] = radarr
                    ? (tmdb is > 0 ? Services.Arr.Live.ArrTitleKey.Movie(tmdb.Value) : null)
                    : tvdb is not > 0 ? null
                    : season is not int s ? Services.Arr.Live.ArrTitleKey.Series(tvdb.Value)
                    : episode is int e ? Services.Arr.Live.ArrTitleKey.Episode(tvdb.Value, s, e)
                    : Services.Arr.Live.ArrTitleKey.Season(tvdb.Value, s);
                if (keys[i] is not { } key) continue;
                asked.Add(key);
                // Seerr knows a request by its TMDB id (a series' too); the audience by the title key.
                if (askedProof != null && tmdb is int t && askedProof.Contains((t, radarr ? "movie" : "tv")))
                    (askedFor ??= new HashSet<string>(StringComparer.Ordinal)).Add(radarr ? key : Services.Arr.Live.ArrTitleKey.Series(tvdb!.Value));
            }
            if (asked.Count == 0) return mask;
            var visible = new HashSet<string>(
                _feedAudience.Visible(userId, false, asked.Select(k => new Services.Arr.Live.ArrFeedChange(k, 0, instance.Id)).ToList(), askedFor, absent),
                StringComparer.Ordinal);
            for (var i = 0; i < records.Count; i++) mask[i] = keys[i] is { } key && visible.Contains(key);
            return mask;
        }

        // How many history records are put to the audience at a time while the newest visible
        // ones are looked for.
        private const int HistoryAudienceBatch = 100;

        /// <summary>
        /// The history records of one instance a non-administrator may see, as far as the history
        /// window can use them: only the records the page shows (imported, failed), newest first, put
        /// to the audience in batches until <see cref="HistoryWindowSize"/> visible items (a Sonarr
        /// season pack is one) are found, plus the older records of those items (a pack's count).
        /// Older items can't make the window, so their records are never decided. Returned in the
        /// ring's order. Keys left out only for want of proof of asking go into <paramref name="absent"/> when given.
        /// </summary>
        private IReadOnlyList<Services.Arr.ArrHistoryEntry> ArrHistoryForAudience(Services.Arr.ArrConnection instance, IReadOnlyList<Services.Arr.ArrHistoryEntry> records, HashSet<(int TmdbId, string MediaType)>? allowedRequests, IReadOnlySet<(int TmdbId, string MediaType)>? askedProof, ICollection<string>? absent = null)
        {
            records = FilterByAllowedRequests(records, allowedRequests, _ => instance.Kind == Services.Arr.ArrKind.Sonarr ? nameof(ArrType.Sonarr) : nameof(ArrType.Radarr), r => r.TmdbId);
            static (int? Tmdb, int? Tvdb, int? Season, int? Episode) Ids(Services.Arr.ArrHistoryEntry r) => (r.TmdbId, r.TvdbId, r.SeasonNumber, r.EpisodeNumber);
            var sonarr = instance.Kind == Services.Arr.ArrKind.Sonarr;
            // The item a record belongs to, as ArrLegacyViews.HistoryItems groups them.
            string Item(int i) => sonarr && !string.IsNullOrEmpty(records[i].DownloadId) ? "d:" + records[i].DownloadId : "r:" + i.ToString(System.Globalization.CultureInfo.InvariantCulture);
            var shown = Enumerable.Range(0, records.Count)
                .Where(i => Services.Arr.ArrLegacyViews.MapHistoryEventType(records[i].EventType) != null)
                .OrderByDescending(i => records[i].Date ?? DateTime.MinValue)
                .ThenBy(i => i)
                .ToList();
            var kept = new List<int>();
            var items = new HashSet<string>(StringComparer.Ordinal);
            DateTime? edge = null;      // the date of the last item the window can still take
            var pos = 0;
            while (pos < shown.Count && !(edge is { } e && (records[shown[pos]].Date ?? DateTime.MinValue) < e))
            {
                var batch = shown.GetRange(pos, Math.Min(HistoryAudienceBatch, shown.Count - pos));
                pos += batch.Count;
                var mask = ArrAudienceMask(instance, batch.Select(i => records[i]).ToList(), Ids, askedProof, absent);
                for (var b = 0; b < batch.Count; b++)
                {
                    if (!mask[b]) continue;
                    kept.Add(batch[b]);
                    if (items.Add(Item(batch[b])) && items.Count == HistoryWindowSize) edge = records[batch[b]].Date ?? DateTime.MinValue;
                }
            }
            // The older records of packs already found still count towards them.
            var rest = shown.Skip(pos).Where(i => items.Contains(Item(i))).ToList();
            if (rest.Count > 0)
            {
                var mask = ArrAudienceMask(instance, rest.Select(i => records[i]).ToList(), Ids, askedProof, absent);
                for (var b = 0; b < rest.Count; b++)
                {
                    if (mask[b]) kept.Add(rest[b]);
                }
            }
            kept.Sort();
            return kept.Select(i => records[i]).ToList();
        }

        /// <summary>
        /// Config-level problems shown next to the per-instance errors: a corrupt instance list, or
        /// every instance of a kind switched off.
        /// </summary>
        private static List<object> ArrConfigErrors(PluginConfiguration config, int sonarrUsable, int radarrUsable)
        {
            var errors = new List<object>();
            if (config.IsSonarrInstancesCorrupt())
                errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "config corrupt — see server logs" });
            else if (sonarrUsable == 0 && config.GetSonarrInstances().Count > 0)
                errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "all Sonarr instances are disabled" });
            if (config.IsRadarrInstancesCorrupt())
                errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "config corrupt — see server logs" });
            else if (radarrUsable == 0 && config.GetRadarrInstances().Count > 0)
                errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "all Radarr instances are disabled" });
            return errors;
        }

        /// <summary>
        /// The download queue of every enabled instance (all rows; served from ArrStateStore, which
        /// polls the arrs while the page is open). Per-user visibility is applied fresh per request.
        /// </summary>
        [HttpGet("arr/queue")]
        [Authorize]
        public async Task<IActionResult> GetDownloadQueue()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || _arrState == null)
                return StatusCode(500, "Plugin configuration not available");
            if (!config.DownloadsPageEnabled)
                return ArrFeatureDisabled("The Requests page");
            // The page hides its downloads section when this is off; don't serve it either.
            if (!config.ShowDownloadsInRequests)
                return Ok(new { items = new List<object>(), errors = new List<object>() });

            var (blocked, allowedRequests) = await GetAllowedRequestsForCurrentUserAsync(config);
            if (blocked)
                return Ok(new { items = new List<object>(), errors = new List<object>() });

            WarnIfArrInstancesCorrupt(config);
            using var scope = _arrState.BeginRequest("arr/queue");
            var ct = HttpContext.RequestAborted;
            var instances = _arrState.Instances(Services.Arr.ArrKind.Sonarr).Concat(_arrState.Instances(Services.Arr.ArrKind.Radarr)).ToList();
            var reads = await Task.WhenAll(instances.Select(i => _arrState.GetQueueAsync(i, ct))).ConfigureAwait(false);

            var isAdmin = IsAdminUser();
            var errors = ArrConfigErrors(config, instances.Count(i => i.Kind == Services.Arr.ArrKind.Sonarr), instances.Count(i => i.Kind == Services.Arr.ArrKind.Radarr));
            for (int i = 0; i < instances.Count; i++)
            {
                if (reads[i].Value is { Truncated: true } queue)
                    _logger.Warning($"Download queue of {instances[i].Name} has {queue.TotalRecords} rows; only the first {queue.Records.Count} are shown.");
                if (reads[i].Error is { } error)
                    errors.Add(Services.Arr.ArrLegacyViews.InstanceError(instances[i], error, isAdmin));
            }
            List<Services.Arr.ArrLegacyQueueItem> QueueRows(IReadOnlySet<(int TmdbId, string MediaType)>? proof, ICollection<string>? absent)
            {
                var rows = new List<Services.Arr.ArrLegacyQueueItem>();
                for (int i = 0; i < instances.Count; i++)
                {
                    if (reads[i].Expired || reads[i].Value is not { } queue) continue;
                    var records = isAdmin ? queue.Records : ArrAudienceFilter(instances[i], queue.Records, r => (r.TmdbId, r.TvdbId, r.SeasonNumber, r.EpisodeNumber), proof, absent);
                    rows.AddRange(Services.Arr.ArrLegacyViews.QueueItems(instances[i], new Services.Arr.ArrQueueSnapshot { Records = records, TotalRecords = queue.TotalRecords, Truncated = queue.Truncated }));
                }
                return rows;
            }
            // The caller's Seerr requests are read only when a row waits on them (cached, bounded wait).
            var proofCandidate = isAdmin ? null : AskedProofCandidate(config, allowedRequests);
            var waiting = proofCandidate != null ? new HashSet<string>(StringComparer.Ordinal) : null;
            var rawItems = QueueRows(allowedRequests, waiting);
            if (waiting is { Count: > 0 } && await GetAskedProofAsync(config, proofCandidate!) is { } askedProof)
                rawItems = QueueRows(askedProof, null);

            var items = FilterByAllowedRequests(rawItems, allowedRequests, x => x.Source, x => x.TmdbId);
            return Ok(new { items, errors });
        }

        // History is intentionally a bounded window, not a full archive browser — pagination
        // is over this fixed-size merged/sorted pool, not the arr instances' entire history.
        private const int HistoryWindowSize = 200;

        /// <summary>
        /// The history the Requests page pages through: the user's own titles (when filtered), newest
        /// first, then the newest <see cref="HistoryWindowSize"/>. Filtered first, so other people's
        /// events never push the user's own out of the window.
        /// </summary>
        internal static List<Services.Arr.ArrLegacyHistoryItem> HistoryWindow(IEnumerable<Services.Arr.ArrLegacyHistoryItem> merged, HashSet<(int TmdbId, string MediaType)>? allowedRequests)
            => FilterByAllowedRequests(merged.OrderByDescending(i => i.Date ?? DateTime.MinValue), allowedRequests, x => x.Source, x => x.TmdbId)
                .Take(HistoryWindowSize)
                .ToList();

        /// <summary>
        /// Recently imported/failed downloads of every enabled instance (served from ArrStateStore's
        /// history ring). Instances whose history can't be read are reported in <c>errors</c>
        /// instead of looking like "no history".
        /// </summary>
        [HttpGet("arr/history")]
        [Authorize]
        public async Task<IActionResult> GetDownloadHistory([FromQuery] int take = 20, [FromQuery] int skip = 0)
        {
            take = Math.Clamp(take, 1, 50);
            skip = Math.Max(0, skip);

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || _arrState == null)
                return StatusCode(500, "Plugin configuration not available");
            if (!config.DownloadsPageEnabled)
                return ArrFeatureDisabled("The Requests page");

            if (!config.DownloadsShowHistory || !config.ShowDownloadsInRequests)
                return Ok(new { items = new List<object>(), totalPages = 0, visible = false, errors = new List<object>() });

            if (config.DownloadsHistoryAdminOnly && !IsAdminUser())
                return Ok(new { items = new List<object>(), totalPages = 0, visible = false, errors = new List<object>() });

            var (blocked, allowedRequests) = await GetAllowedRequestsForCurrentUserAsync(config);
            if (blocked)
                return Ok(new { items = new List<object>(), totalPages = 0, visible = true, errors = new List<object>() });

            WarnIfArrInstancesCorrupt(config);
            using var scope = _arrState.BeginRequest("arr/history");
            var ct = HttpContext.RequestAborted;
            var instances = _arrState.Instances(Services.Arr.ArrKind.Sonarr).Concat(_arrState.Instances(Services.Arr.ArrKind.Radarr)).ToList();
            var reads = await Task.WhenAll(instances.Select(i => _arrState.GetHistoryAsync(i, ct))).ConfigureAwait(false);

            var isAdmin = IsAdminUser();
            var errors = ArrConfigErrors(config, instances.Count(i => i.Kind == Services.Arr.ArrKind.Sonarr), instances.Count(i => i.Kind == Services.Arr.ArrKind.Radarr));
            for (int i = 0; i < instances.Count; i++)
            {
                if (reads[i].Error is { } error)
                    errors.Add(Services.Arr.ArrLegacyViews.InstanceError(instances[i], error, isAdmin));
            }
            List<Services.Arr.ArrLegacyHistoryItem> HistoryRows(IReadOnlySet<(int TmdbId, string MediaType)>? proof, ICollection<string>? absent)
            {
                var rows = new List<Services.Arr.ArrLegacyHistoryItem>();
                for (int i = 0; i < instances.Count; i++)
                {
                    if (reads[i].Value is not { } history) continue;
                    // Per record, before a season pack's episodes are grouped: an episode the
                    // caller can't see leaves the pack's count too. Only as much of the ring as
                    // the window can show is decided.
                    var records = isAdmin ? history.Records : ArrHistoryForAudience(instances[i], history.Records, allowedRequests, proof, absent);
                    rows.AddRange(Services.Arr.ArrLegacyViews.HistoryItems(instances[i], new Services.Arr.ArrHistorySnapshot { Records = records, Watermark = history.Watermark, FullReadAt = history.FullReadAt, FullReadDue = history.FullReadDue }));
                }
                return rows;
            }
            // The caller's Seerr requests are read only when a row waits on them (cached, bounded wait).
            var proofCandidate = isAdmin ? null : AskedProofCandidate(config, allowedRequests);
            var waiting = proofCandidate != null ? new HashSet<string>(StringComparer.Ordinal) : null;
            var merged = HistoryRows(allowedRequests, waiting);
            if (waiting is { Count: > 0 } && await GetAskedProofAsync(config, proofCandidate!) is { } askedProof)
                merged = HistoryRows(askedProof, null);

            var filtered = HistoryWindow(merged, allowedRequests);
            var totalPages = filtered.Count == 0 ? 0 : (int)Math.Ceiling(filtered.Count / (double)take);
            var page = filtered.Skip(skip).Take(take).ToList();

            return Ok(new { items = page, totalPages, visible = true, errors });
        }

        [HttpGet("arr/requests")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        public async Task<IActionResult> GetRequests([FromQuery] int take = 20, [FromQuery] int skip = 0, [FromQuery] string? filter = null, [FromQuery] bool userOnly = false)
        {
            take = Math.Clamp(take, 1, 200);
            skip = Math.Max(0, skip);

            // Taken before the configuration is read: the TMDB enrichment kept below is fenced by it and lives from here.
            var enrichmentGeneration = Interlocked.Read(ref _seerrResponseGeneration);
            var requestStart = DateTime.UtcNow;
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");
            // Only the Requests page and the Calendar (its "requested" filter) read this list.
            if (!config.DownloadsPageEnabled && !config.CalendarPageEnabled)
                return ArrFeatureDisabled("The Requests page");

            if (!config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()))
            {
                return Ok(new { requests = new List<object>(), totalPages = 0, totalResults = 0 });
            }

            try
            {
                // iterate every configured Seerr URL, not
                // just the first one. Previously a downed primary URL produced
                // an immediate 502 even when a second URL would have answered.
                var allUrls = config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(u => u.Trim().TrimEnd('/'))
                    .Where(u => !string.IsNullOrWhiteSpace(u))
                    .ToList();
                if (allUrls.Count == 0)
                {
                    return StatusCode(503, new { error = true, code = "disabled", message = "Seerr URL not configured." });
                }
                var client = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(15);
                bool hasRequestViewPermission = false;

                var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();

                if (string.IsNullOrEmpty(jellyfinUserId))
                {
                    _logger.Warning("Could not find Jellyfin User ID in claims.");
                    return BadRequest(new { message = "Jellyfin User ID was not provided in claims." });
                }

                var jellyseerrUser = await GetJellyseerrUser(jellyfinUserId);

                if (jellyseerrUser == null)
                {
                    _logger.Warning($"Could not find a Seerr user for Jellyfin user {ResolveUserDisplay(jellyfinUserId)}. Aborting request.");
                    return NotFound(new { message = "Current Jellyfin user is not linked to a Seerr user." });
                }

                // Check if user has permission to view all requests
                // Jellyfin admins can always view all requests regardless of Seerr permissions
                // When the admin enabled DownloadsFilterByUserRequests, non-admins only ever see their own requests
                hasRequestViewPermission = IsAdminUser() || (!config.DownloadsFilterByUserRequests && JellyseerrPermissionHelper.HasAnyPermission(
                    jellyseerrUser.Permissions,
                    JellyseerrPermission.ADMIN | JellyseerrPermission.MANAGE_REQUESTS | JellyseerrPermission.REQUEST_VIEW
                ));

                // Build filter parameter
                // "comingsoon" is a custom filter - fetch processing items and filter server-side
                var isComingSoonFilter = string.Equals(filter, "comingsoon", StringComparison.OrdinalIgnoreCase);
                // Processing and Coming Soon split one Seerr list: fetch it whole and page it here.
                var splitsProcessing = isComingSoonFilter || string.Equals(filter, "processing", StringComparison.OrdinalIgnoreCase);
                var seerrTake = splitsProcessing ? 500 : take;
                var seerrSkip = splitsProcessing ? 0 : skip;
                var filterParam = filter?.ToLower() switch
                {
                    "pending" => "&filter=pending",
                    "approved" => "&filter=approved",
                    "available" => "&filter=available",
                    "processing" => "&filter=processing",
                    "comingsoon" => "&filter=processing", // Fetch processing, then filter for future dates
                    _ => ""
                };

                // If user lacks permission or user-only is requested, filter to only their requests
                if (!hasRequestViewPermission || userOnly)
                {
                    filterParam += $"&requestedBy={jellyseerrUser.Id}";
                }

                // iterate URLs; only return 502 if ALL fail.
                // Per-URL try/catch so a DNS failure or timeout on URL #1 doesn't
                // escape and prevent URL #2 from being tried.
                string? json = null;
                string? jellyseerrUrl = null;     // url that responded (for downstream enrichment)
                Helpers.Jellyseerr.SeerrError? lastError = null;
                foreach (var candidateUrl in allUrls)
                {
                    var requestsUri = $"{candidateUrl}/api/v1/request?take={seerrTake}&skip={seerrSkip}{filterParam}";
                    try
                    {
                        using var requestsRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestsUri, config.GetJellyseerrApiKey());
                        using var response = await client.SendAsync(requestsRequest);
                        var (urlJson, urlError) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestsUri);
                        if (urlError == null && urlJson != null)
                        {
                            json = urlJson;
                            jellyseerrUrl = candidateUrl;
                            break;
                        }
                        lastError = urlError;
                        _logger.Warning($"Seerr requests fetch failed at {candidateUrl}: code={urlError!.Code} status={urlError.HttpStatus} cf-ray={urlError.CfRay} — {urlError.Message}");
                    }
                    catch (Exception innerEx)
                    {
                        lastError = new Helpers.Jellyseerr.SeerrError
                        {
                            Code = Helpers.Jellyseerr.SeerrErrorCode.Unreachable,
                            HttpStatus = 0,
                            Url = candidateUrl,
                            Message = $"Failed to reach {candidateUrl}: {innerEx.Message}",
                            UserMessage = "Can't reach Seerr right now. Please try again in a moment."
                        };
                        _logger.Warning($"Seerr requests fetch threw at {candidateUrl}: {innerEx.Message}");
                    }
                }
                if (json != null)
                {
                    // Parental ratings (#581): drop rows above the caller's limit before
                    // enrichment attaches titles and posters to them.
                    var parental = await _parentalFilter.ApplyAsync(json, "/api/v1/request", jellyfinUserId, HttpContext.RequestAborted);
                    if (parental.Block)
                    {
                        // The filter could not run to completion: never hand a
                        // restricted user the unfiltered list.
                        return ParentalBlockedResult();
                    }
                    json = parental.Body;
                }

                if (json == null)
                {
                    var error = lastError!;
                    int httpCode = error.Code switch
                    {
                        Helpers.Jellyseerr.SeerrErrorCode.HtmlResponse => 502,
                        Helpers.Jellyseerr.SeerrErrorCode.UpstreamRedirect => 502,
                        Helpers.Jellyseerr.SeerrErrorCode.Cloudflare5xx => 502,
                        _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                    };
                    return StatusCode(httpCode, new
                    {
                        error = true,
                        code = error.Code.ToString(),
                        cfRay = error.CfRay,
                        message = IsAdminUser() ? error.Message : Helpers.Jellyseerr.SeerrError.SanitizeMessage(error.Message),
                        requests = new List<object>(),
                        totalPages = 0,
                        totalResults = 0
                    });
                }

                var data = JObject.Parse(json!);

                var requests = new List<object>();
                int? splitTotal = null;
                var results = data["results"] as JArray;
                if (results != null)
                {
                    var requestAborted = HttpContext.RequestAborted;
                    // A request's Jellyfin item is named only when the caller can open it (Seerr names it
                    // whichever library holds it, and REQUEST_VIEW lists other people's requests).
                    var requestViewer = Guid.TryParse(jellyfinUserId, out var requestViewerId) ? _userManager.GetUserById(requestViewerId) : null;
                    // Enrich all requests in parallel for better performance
                    var enrichmentTasks = results.Select(async req =>
                    {
                        var media = req["media"] as JObject;
                        var requestedBy = req["requestedBy"] as JObject;

                        int? reqStatus = req["status"]?.Value<int>();
                        int? mediaStatusVal = media?["status"]?.Value<int>();
                        bool hasActiveDownload = (media?["downloadStatus"] as JArray)?.Count > 0
                            || (media?["downloadStatus4k"] as JArray)?.Count > 0;
                        string mediaStatus = GetMediaStatus(reqStatus, mediaStatusVal, hasActiveDownload);

                        string? type = req["type"]?.Value<string>();
                        int? tmdbId = media?["tmdbId"]?.Value<int>();

                        // Enrich with TMDB data to get title and poster
                        string? title = null;
                        int? year = null;
                        string? posterUrl = null;
                        string? digitalReleaseDate = null;
                        string? theatricalReleaseDate = null;
                        string? initialAirDate = null;
                        string? nextAirDate = null;

                        if (tmdbId.HasValue && !string.IsNullOrEmpty(type))
                        {
                            var enrichedData = await EnrichWithTmdbData(client, tmdbId.Value, type, jellyseerrUrl!, config.GetJellyseerrApiKey(), enrichmentGeneration, requestStart);
                            title = enrichedData.Title;
                            year = enrichedData.Year;
                            posterUrl = enrichedData.PosterUrl;

                            if (type == "tv")
                            {
                                initialAirDate = enrichedData.InitialAirDate;
                                nextAirDate = enrichedData.NextAirDate;
                            }
                            else
                            {
                                digitalReleaseDate = enrichedData.DigitalReleaseDate;
                                theatricalReleaseDate = enrichedData.TheatricalReleaseDate;
                            }
                        }

                        // Fallback to media object if enrichment didn't work
                        if (string.IsNullOrEmpty(title))
                        {
                            title = media?["title"]?.Value<string>();
                            if (string.IsNullOrEmpty(title))
                                title = media?["name"]?.Value<string>();
                            if (string.IsNullOrEmpty(title))
                                title = media?["originalTitle"]?.Value<string>();
                            if (string.IsNullOrEmpty(title))
                                title = media?["originalName"]?.Value<string>();
                            if (string.IsNullOrEmpty(title))
                                title = "Unknown";
                        }

                        // Fallback year from media object
                        if (!year.HasValue)
                        {
                            string? releaseDate = media?["releaseDate"]?.Value<string>();
                            string? firstAirDate = media?["firstAirDate"]?.Value<string>();
                            if (!string.IsNullOrEmpty(releaseDate) && releaseDate.Length >= 4)
                                year = int.TryParse(releaseDate.Substring(0, 4), out var y) ? y : null;
                            else if (!string.IsNullOrEmpty(firstAirDate) && firstAirDate.Length >= 4)
                                year = int.TryParse(firstAirDate.Substring(0, 4), out var y2) ? y2 : null;
                        }

                        // Fallback poster from media object
                        if (string.IsNullOrEmpty(posterUrl))
                        {
                            string? posterPath = media?["posterPath"]?.Value<string>();
                            if (!string.IsNullOrEmpty(posterPath))
                                posterUrl = $"https://image.tmdb.org/t/p/w300{posterPath}";
                        }

                        // Get requester info
                        string? displayName = requestedBy?["displayName"]?.Value<string>();
                        string? username = requestedBy?["username"]?.Value<string>();
                        string? avatar = requestedBy?["avatar"]?.Value<string>();

                        // Proxy avatar through our backend to avoid CORS/mixed content issues
                        string? avatarUrl = null;
                        if (!string.IsNullOrEmpty(avatar))
                        {
                            avatarUrl = $"/JellyfinEnhanced/proxy/avatar?path={Uri.EscapeDataString(avatar)}";
                        }

                        // Handle createdAt - could be string or DateTime
                        string? createdAtStr = null;
                        var createdAtToken = req["createdAt"];
                        if (createdAtToken != null)
                        {
                            createdAtStr = createdAtToken.Type == Newtonsoft.Json.Linq.JTokenType.Date
                                ? createdAtToken.Value<DateTime>().ToString("o")
                                : createdAtToken.ToString();
                        }

                        var tvdbId = media?["tvdbId"]?.Value<int?>();
                        var isOrphaned = IsOrphanedRequest(mediaStatus, createdAtStr)
                            && await IsMissingFromArrAsync(type, tmdbId, tvdbId, createdAtStr, requestAborted);

                        return new
                        {
                            id = req["id"]?.Value<int>(),
                            type = type,
                            title = title,
                            year = year,
                            posterUrl = posterUrl,
                            tmdbId = tmdbId,
                            // TV only — Sonarr identifies series by TVDB id, not TMDB id, so
                            // this is what the Requests page needs to build an "Open in Sonarr"
                            // link via /arr/series-slugs.
                            tvdbId = tvdbId,
                            mediaStatus = mediaStatus,
                            // Raw Seerr request status (1=Pending, 2=Approved, 3=Declined,
                            // 4=Failed, 5=Completed). Exposed separately from mediaStatus
                            // because mediaStatus collapses to the media's availability
                            // (e.g. "Partially Available" for a show that already has some
                            // seasons), which masks a still-pending request and prevents the
                            // approve/decline buttons from rendering.
                            requestStatus = reqStatus,
                            requestedBy = displayName ?? username ?? "Unknown",
                            requestedByAvatar = avatarUrl,
                            createdAt = createdAtStr,
                            jellyfinMediaId = VisibleJellyfinId(media?["jellyfinMediaId"]?.Value<string>(), requestViewer),
                            digitalReleaseDate = digitalReleaseDate,
                            theatricalReleaseDate = theatricalReleaseDate,
                            initialAirDate = initialAirDate,
                            nextAirDate = nextAirDate,
                            isComingSoon = IsComingSoonRequest(mediaStatus, type, nextAirDate, digitalReleaseDate, theatricalReleaseDate),
                            isOrphaned = isOrphaned
                        };
                    }).ToList();

                    var enrichedRequests = await Task.WhenAll(enrichmentTasks);
                    // The caller's own rules, by the id the request carries (a caller Jellyfin doesn't resolve has no
                    // document: nothing hidden, never a failed list).
                    var hiddenRequests = Services.HiddenContentPolicy.Load(_userConfigurationManager, requestViewerId, HttpContext, _libraryManager);
                    enrichedRequests = enrichedRequests.Where(r => !hiddenRequests.IsHidden(
                        Services.HiddenContentPolicy.TitleIdentity(r.type, r.tmdbId.ToString()), r.jellyfinMediaId, null, "requests")).ToArray();

                    // Apply server-side filtering for "comingsoon"
                    if (isComingSoonFilter)
                    {
                        enrichedRequests = enrichedRequests
                            .Where(r => r.isComingSoon && !r.isOrphaned)
                            .OrderBy(r =>
                            {
                                // Sort by the earliest future date
                                DateTime? bestDate = null;
                                var today = DateTime.UtcNow.Date;

                                // For TV shows, use nextAirDate
                                if (r.type == "tv" && !string.IsNullOrEmpty(r.nextAirDate) && TryParseIso(r.nextAirDate) is DateTime airDate && airDate.Date > today)
                                {
                                    bestDate = airDate;
                                }
                                else
                                {
                                    // For movies, use digital or theatrical date
                                    if (!string.IsNullOrEmpty(r.digitalReleaseDate) && TryParseIso(r.digitalReleaseDate) is DateTime dd && dd.Date > today)
                                        bestDate = dd;
                                    if (!string.IsNullOrEmpty(r.theatricalReleaseDate) && TryParseIso(r.theatricalReleaseDate) is DateTime td && td.Date > today)
                                    {
                                        if (bestDate == null || td < bestDate)
                                            bestDate = td;
                                    }
                                }

                                return bestDate ?? DateTime.MaxValue;
                            })
                            .ToArray();
                    }
                    else if (splitsProcessing)
                    {
                        enrichedRequests = enrichedRequests.Where(r => !r.isComingSoon && !r.isOrphaned).ToArray();
                    }

                    if (splitsProcessing)
                    {
                        splitTotal = enrichedRequests.Length;
                        enrichedRequests = enrichedRequests.Skip(skip).Take(take).ToArray();
                    }

                    requests.AddRange(enrichedRequests);
                }

                var pageInfo = data["pageInfo"] as JObject;
                var totalResults = splitsProcessing ? (splitTotal ?? 0) : (pageInfo?["results"]?.Value<int>() ?? 0);
                var totalPages = (int)Math.Ceiling((double)totalResults / take);

                var canApproveRequests = IsAdminUser() || JellyseerrPermissionHelper.HasAnyPermission(
                    jellyseerrUser.Permissions,
                    JellyseerrPermission.ADMIN | JellyseerrPermission.MANAGE_REQUESTS
                );

                var requestBody = new { requests, totalPages, totalResults, canApproveRequests };
                var spoiler = _presentation?.Load(Guid.Parse(jellyfinUserId), HttpContext);
                return spoiler == null ? Ok(requestBody) : Content(spoiler.ProjectResource(JsonSerializer.Serialize(requestBody), null, "arr-requests"), "application/json");
            }
            catch (Exception ex)
            {
                // previously every error returned 200+empty,
                // making the requests page indistinguishable from "no requests".
                // Now we surface a structured 502 so the frontend can render a
                // banner (and the user knows to fix their config rather than
                // assume they have no requests).
                _logger.Warning($"Failed to fetch Seerr requests: {ex.Message}");
                return StatusCode(502, new
                {
                    error = true,
                    code = "requests_fetch_failed",
                    message = $"Failed to fetch requests from Jellyseerr: {ex.Message}",
                    requests = new List<object>(),
                    totalPages = 0,
                    totalResults = 0,
                });
            }
        }

        // True only when every enabled Radarr/Sonarr instance's library index is loaded and current,
        // was read after the request's 10-minute grace period ended, and none has the title (served
        // from ArrStateStore: no upstream call per row). An index read before the grace period ended
        // can't tell (the title may have been added since): a refresh is asked for and the answer is no.
        internal async Task<bool> IsMissingFromArrAsync(string? type, int? tmdbId, int? tvdbId, string? createdAt, CancellationToken ct)
        {
            var isTv = type == "tv";
            var id = isTv ? tvdbId : tmdbId;
            if (!id.HasValue || id <= 0 || _arrState == null) return false;
            if (!DateTimeOffset.TryParse(createdAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var created)) return false;

            var instances = _arrState.Instances(isTv ? Services.Arr.ArrKind.Sonarr : Services.Arr.ArrKind.Radarr);
            if (instances.Count == 0) return false;

            var reads = await ReadLibrariesAsync(instances, ct).ConfigureAwait(false);
            foreach (var read in reads)
            {
                if (read.Value == null || read.Error != null) return false;
                var found = isTv ? (object?)read.Value.SeriesByTvdb(id.Value) : read.Value.MovieByTmdb(id.Value);
                if (found != null) return false;
            }
            var graceEnd = created.AddMinutes(10);
            var trusted = true;
            for (int i = 0; i < instances.Count; i++)
            {
                if (reads[i].LoadedAt is { } loadedAt && loadedAt >= graceEnd) continue;
                _arrState.RequestRefresh(instances[i].Id, Services.Arr.ArrSnapshotKind.Library);
                trusted = false;
            }
            return trusted;
        }

        // Approved, not yet available, and older than the grace period (10 min) for Radarr to pick it up.
        private static bool IsOrphanedRequest(string? mediaStatus, string? createdAt)
        {
            if (mediaStatus != "Approved" && mediaStatus != "Processing") return false;
            return DateTimeOffset.TryParse(createdAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var created)
                && created < DateTimeOffset.UtcNow.AddMinutes(-10);
        }

        // Coming soon: approved or processing with a future release date. Processing lists the rest.
        private static bool IsComingSoonRequest(string? status, string? type, string? nextAirDate, string? digitalReleaseDate, string? theatricalReleaseDate)
        {
            var today = DateTime.UtcNow.Date;
            static bool IsFuture(string? value, DateTime day) => TryParseIso(value) is DateTime date && date.Date > day;

            var normalized = (status ?? "").ToLower();
            if (type == "tv")
            {
                return IsFuture(nextAirDate, today)
                    && (normalized == "processing" || normalized == "approved" || normalized == "partially available");
            }

            if (normalized != "processing" && normalized != "approved") return false;
            return IsFuture(digitalReleaseDate, today) || IsFuture(theatricalReleaseDate, today);
        }

        [HttpPost("arr/requests/{requestId}/approve")]
        [HttpPost("arr/requests/{requestId}/decline")]
        [Authorize]
        public async Task<IActionResult> ActOnRequest([FromRoute] int requestId)
        {
            var action = HttpContext.Request.Path.Value?.Contains("/approve", StringComparison.OrdinalIgnoreCase) == true ? "approve" : "decline";

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config is { DownloadsPageEnabled: false })
                return ArrFeatureDisabled("The Requests page");
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()))
                return StatusCode(503, new { error = true, message = "Seerr not configured." });
            // Held until the POST below is done (a move waits for it); refused during a move and in JE mode.
            using var write = EnterSeerrRequestWrite(out var refusal);
            if (refusal != null)
                return refusal;

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return BadRequest(new { message = "Jellyfin User ID not found." });

            var jellyseerrUser = config.ArrIntegrationEnabled && config.ArrPhase1Enabled && config.ArrPhase3Enabled
                ? await GetJellyseerrUser(jellyfinUserId, bypassCache: true, allowAutoImport: false)
                : await GetJellyseerrUser(jellyfinUserId);
            if (jellyseerrUser == null)
                return NotFound(new { message = "Current user is not linked to a Seerr account." });

            bool canApprove = IsAdminUser() || JellyseerrPermissionHelper.HasAnyPermission(
                jellyseerrUser.Permissions,
                JellyseerrPermission.ADMIN | JellyseerrPermission.MANAGE_REQUESTS
            );
            if (!canApprove)
                return StatusCode(403, new { error = true, message = "You do not have permission to approve or decline requests." });

            var jellyseerrUrl = config.JellyseerrUrls
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/'))
                .FirstOrDefault(u => !string.IsNullOrWhiteSpace(u));

            if (string.IsNullOrEmpty(jellyseerrUrl))
                return StatusCode(503, new { error = true, message = "No valid Seerr URL configured." });

            var requestUri = $"{jellyseerrUrl}/api/v1/request/{requestId}/{action}";
            var client = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            using var httpRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                HttpMethod.Post, requestUri, config.GetJellyseerrApiKey(), jellyseerrUser.Id.ToString());
            using var response = await client.SendAsync(httpRequest);
            var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

            if (error != null)
            {
                _logger.Warning($"Seerr {action} request {requestId} failed: {error.Code} {error.HttpStatus}");
                return StatusCode(error.HttpStatus > 0 ? error.HttpStatus : 502,
                    IsAdminUser() ? error.ToAdminResponseShape() : error.ToResponseShape());
            }

            SeerrRequestsChanged();
            return Ok(new { success = true });
        }

        [HttpGet("arr/calendar")]
        [Authorize]
        public async Task<IActionResult> GetCalendarEvents()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || _arrState == null)
                return StatusCode(500, "Plugin configuration not available");
            if (!config.CalendarPageEnabled)
                return ArrFeatureDisabled("The Calendar page");

            var events = new List<ArrItem>();

            var todayUtc = DateTime.UtcNow.Date;
            DateTime startDate = todayUtc;
            DateTime endDate = todayUtc.AddDays(90);

            if (Request.Query.TryGetValue("start", out var startValues))
            {
                // Invariant: under a culture with another calendar (th-TH is Buddhist) "2026-10-05"
                // would be read as a different year and the range would miss every event.
                if (DateTime.TryParse(startValues.ToString(), System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var parsedStart))
                {
                    startDate = parsedStart.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(parsedStart, DateTimeKind.Utc) : parsedStart.ToUniversalTime();
                }
            }

            if (Request.Query.TryGetValue("end", out var endValues))
            {
                if (DateTime.TryParse(endValues.ToString(), System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var parsedEnd))
                {
                    endDate = parsedEnd.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(parsedEnd, DateTimeKind.Utc) : parsedEnd.ToUniversalTime();
                }
            }

            if (endDate < startDate)
            {
                (startDate, endDate) = (endDate, startDate);
            }

            // The viewer's own first and last day (their time zone): date-only releases are kept by day.
            static string? Day(Microsoft.Extensions.Primitives.StringValues value)
                => System.Text.RegularExpressions.Regex.IsMatch(value.ToString(), "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", System.Text.RegularExpressions.RegexOptions.None, TimeSpan.FromMilliseconds(50)) ? value.ToString() : null;
            var startDay = Request.Query.TryGetValue("startDay", out var startDayValue) ? Day(startDayValue) : null;
            var endDay = Request.Query.TryGetValue("endDay", out var endDayValue) ? Day(endDayValue) : null;
            if (startDay != null && endDay != null && string.CompareOrdinal(startDay, endDay) > 0) (startDay, endDay) = (endDay, startDay);

            // cap the requested range to prevent an authed
            // user from passing start=1900..end=2099 and triggering 200 years
            // worth of arr-side calendar fetches + dedup loops.
            const int maxCalendarRangeDays = 365;
            var requestedRange = (endDate - startDate).TotalDays;
            if (requestedRange > maxCalendarRangeDays)
            {
                _logger.Info($"Calendar range capped from {(int)requestedRange} days to {maxCalendarRangeDays} days.");
                endDate = startDate.AddDays(maxCalendarRangeDays);
            }

            DateTime? ParseDate(object? value)
            {
                if (value == null)
                {
                    return null;
                }

                if (value is DateTime dateTimeValue)
                {
                    return dateTimeValue.Kind == DateTimeKind.Unspecified
                        ? DateTime.SpecifyKind(dateTimeValue, DateTimeKind.Utc)
                        : dateTimeValue;
                }

                var asString = Convert.ToString(value);
                if (string.IsNullOrWhiteSpace(asString))
                {
                    return null;
                }

                // Try parsing with invariant culture and assume UTC to avoid local timezone interpretation
                if (DateTime.TryParse(asString, System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                    out var parsed))
                {
                    return parsed;
                }

                // Fallback to regular parsing if above fails
                if (DateTime.TryParse(asString, out parsed))
                {
                    if (parsed.Kind == DateTimeKind.Unspecified)
                    {
                        parsed = DateTime.SpecifyKind(parsed, DateTimeKind.Utc);
                    }
                    return parsed;
                }

                return null;
            }

            // Sonarr/Radarr events come from ArrStateStore's calendar window (no upstream call for
            // ranges inside it); Shoko is still read live.
            WarnIfArrInstancesCorrupt(config);
            using var arrScope = _arrState.BeginRequest("arr/calendar");
            var ct = HttpContext.RequestAborted;
            var arrInstances = _arrState.Instances(Services.Arr.ArrKind.Sonarr).Concat(_arrState.Instances(Services.Arr.ArrKind.Radarr)).ToList();
            var calendarTasks = arrInstances.Select(i => _arrState.GetCalendarAsync(i, startDate, endDate, ct)).ToList();
            var isAdmin = IsAdminUser();

            // Shoko is single-instance (flat ShokoUrl/ShokoApiKey fields, no JSON instance list),
            // so it fans out alongside sonarrTasks/radarrTasks as at most one extra task rather
            // than a per-instance collection. Partial config (only one of URL/key set) surfaces
            // an error without attempting a fetch; both empty means Shoko isn't in use at all —
            // same as zero Sonarr/Radarr instances — and produces no error.
            var shokoUrlSet = !string.IsNullOrWhiteSpace(config.ShokoUrl);
            var shokoKeySet = !string.IsNullOrWhiteSpace(config.GetShokoApiKey());
            string? shokoConfigError = (shokoUrlSet != shokoKeySet)
                ? "Shoko URL and API key must both be set"
                : null;
            // Admin-configurable set of AniDB episode types shown on the calendar (Shoko settings).
            var shokoIncludedTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (config.ShokoShowEpisodes) shokoIncludedTypes.Add("Episode");
            if (config.ShokoShowSpecials) shokoIncludedTypes.Add("Special");
            if (config.ShokoShowCredits) shokoIncludedTypes.Add("Credits");
            if (config.ShokoShowTrailers) shokoIncludedTypes.Add("Trailer");
            if (config.ShokoShowParodies) shokoIncludedTypes.Add("Parody");
            if (config.ShokoShowOther) shokoIncludedTypes.Add("Other");

            Task<(List<ArrItem> Items, string? Error)>? shokoTask = config.IsShokoConfigured()
                ? FetchShokoCalendar(
                    new ArrInstance { Name = "Shoko", Url = config.ShokoUrl, ApiKey = config.GetShokoApiKey(), UrlMappings = config.ShokoUrlMappings ?? "" },
                    startDate, endDate, shokoIncludedTypes, ParseDate, ct)
                : null;

            var calendarReads = await Task.WhenAll(calendarTasks).ConfigureAwait(false);
            var shokoCalResult = shokoTask != null ? await shokoTask : (Items: new List<ArrItem>(), Error: null);

            var errors = ArrConfigErrors(config, arrInstances.Count(i => i.Kind == Services.Arr.ArrKind.Sonarr), arrInstances.Count(i => i.Kind == Services.Arr.ArrKind.Radarr));
            for (int i = 0; i < arrInstances.Count; i++)
            {
                if (calendarReads[i].Value is { } calendar)
                    events.AddRange(Services.Arr.ArrLegacyViews.CalendarItems(arrInstances[i], calendar, startDate, endDate, startDay, endDay));
                if (calendarReads[i].Error is { } error)
                    errors.Add(Services.Arr.ArrLegacyViews.InstanceError(arrInstances[i], error, isAdmin));
            }
            if (shokoConfigError != null)
                errors.Add(new { instanceName = "Shoko", source = "Shoko", reason = shokoConfigError });
            events.AddRange(shokoCalResult.Items);
            if (shokoCalResult.Error != null)
                errors.Add(new { instanceName = "Shoko", source = "Shoko", reason = shokoCalResult.Error });

            // Resolve ItemIds against Jellyfin's library BEFORE dedup so the dedup tie-breaker can
            // prefer candidates that the current user can actually access (H4). Without this, dedup
            // might pick an instance-B candidate with HasFile=true in a root folder the user can't
            // read, and then the subsequent access filter would hide the event entirely — even
            // though instance-A had the same episode in an accessible root folder.
            var providerKeys = events
                .SelectMany(evt => ProviderHelper.GetAllProviders(evt, _titleAliases))
                .Distinct()
                .ToList();

            // Every Jellyfin copy per key (a title can be in two libraries); one pick for everyone
            // first, then, for a caller the access filter applies to, the copy that caller may open.
            var itemCandidates = await _dbContextFactory.GetItemIdCandidatesByProvidersBatchAsync(providerKeys, _libraryManager);
            var itemMap = itemCandidates.ToDictionary(kv => kv.Key, kv => kv.Value[0]);

            foreach (var evt in events)
            {
                evt.ItemId = ProviderHelper.GetBestItemId(ProviderHelper.GetProviders(evt, _titleAliases), itemMap);
                evt.ItemEpisodeId = ProviderHelper.GetBestItemId(ProviderHelper.GetEpisodeProviders(evt), itemMap);
            }

            // Who may see each event (Calendar "filter by library access" on; administrators see
            // everything). An event Jellyfin has (itemId, and itemEpisodeId for an episode it has)
            // is Jellyfin's own check for the caller: library access and parental limits, down to
            // the single episode. An event not in Jellyfin yet is decided by the
            // library its instance lands it in (ArrInstanceLibraries: the instance's linked
            // libraries, else its folder through the path mappings): shown when the caller may open
            // that library, hidden when they may not or when it can't be told (no library holds the
            // folder, or two instances share an unmapped root). No signed-in user, no events.
            // Users with parental limits keep seeing titles not in Jellyfin yet in libraries they
            // can open: there is no rating to check before Jellyfin has the title.
            // The arr's own path (no linked libraries, no mapping for the title) needs every
            // instance's root folders, from the system snapshots in memory: the answer never waits
            // for them. When one was needed and isn't there (or is over an hour old), one background
            // read is started for the next request, which counts as nobody watching (it doesn't keep
            // the arrs' system facts refreshed on users' behalf).
            var rootsConsulted = false;
            var calendarPerson = ArrCaller.Human(User, _userManager);
            var parentalCalendar = Services.Acquire.ArrInstanceLibraries.AbsentParentalEnabled && calendarPerson != null && Services.SeerrParentalFilter.PolicyFor(calendarPerson).IsRestricted;
            var filterByAccess = (config.CalendarFilterByLibraryAccess && !isAdmin) || Services.Acquire.ArrInstanceLibraries.AbsentParentalEnabled;
            Jellyfin.Database.Implementations.Entities.User? calendarUser = filterByAccess ? calendarPerson : null;
            if (filterByAccess && calendarUser == null)
                return Ok(new { events = new List<ArrItem>(), errors });

            var instancesById = arrInstances.ToDictionary(i => i.Id, StringComparer.OrdinalIgnoreCase);
            // For a title Jellyfin has: is there a copy (series or movie, and for an episode Jellyfin
            // has, that episode in the same copy) the caller may open? Every copy counts, not one
            // picked for everyone: the same show can be in "TV" and in a library the caller can't
            // open, and Jellyfin can hide one episode (its own rating or tags) of a series the caller
            // may open. Episodes are found by their ids or their season and episode number.
            // A visible event then points at the caller's own copy (links, watched state).
            Dictionary<ArrItem, bool>? jellyfinVerdicts = null;
            if (calendarUser != null)
            {
                var seenItems = new Dictionary<Guid, BaseItem?>();
                BaseItem? Seen(Guid id)
                {
                    if (!seenItems.TryGetValue(id, out var item))
                        seenItems[id] = item = _libraryManager.GetItemById<BaseItem>(id, calendarUser);
                    return item;
                }
                Guid? SeriesOf(Guid id) => (_libraryManager.GetItemById<BaseItem>(id) as MediaBrowser.Controller.Entities.TV.Episode)?.SeriesId;

                // A season's episodes in one series copy, whoever may see them (one query per copy and
                // season); null when they can't be read.
                var seasonsInCopies = new Dictionary<(Guid Series, int Season), List<MediaBrowser.Controller.Entities.TV.Episode>?>();
                Guid? EpisodeInCopy(Guid seriesId, int season, int number)
                {
                    var key = (seriesId, season);
                    if (!seasonsInCopies.TryGetValue(key, out var episodes))
                    {
                        try
                        {
                            episodes = _libraryManager.GetItemList(new InternalItemsQuery
                            {
                                AncestorIds = new[] { seriesId },
                                Recursive = true,
                                IncludeItemTypes = new[] { BaseItemKind.Episode },
                                ParentIndexNumber = season,
                            }).OfType<MediaBrowser.Controller.Entities.TV.Episode>().ToList();
                        }
                        catch (Exception)
                        {
                            episodes = null;
                        }
                        seasonsInCopies[key] = episodes;
                    }
                    // Can't tell whether the episode is hidden: this copy doesn't make it visible.
                    if (episodes == null) return Guid.Empty;
                    // A multi-episode file covers every episode in its range.
                    return episodes.FirstOrDefault(e => e.IndexNumber is int first
                        && new Services.Acquire.EpisodeRange(first, e.IndexNumberEnd).Contains(number))?.Id;
                }

                jellyfinVerdicts = new Dictionary<ArrItem, bool>(ReferenceEqualityComparer.Instance);
                foreach (var evt in events)
                {
                    var copy = ProviderHelper.PickCallerCopy(evt, itemCandidates, Seen, SeriesOf,
                        title => EpisodeInCopy(title, evt.SeasonNumber!.Value, evt.EpisodeNumber!.Value), _titleAliases);
                    if (!copy.InJellyfin) continue;
                    jellyfinVerdicts[evt] = copy.Visible;
                    if (copy.Visible)
                    {
                        evt.ItemId = copy.ItemId;
                        evt.ItemEpisodeId = copy.EpisodeId;
                    }
                }
            }

            int ParentalTmdbId(ArrItem evt)
            {
                if (evt.TmdbId > 0) return evt.TmdbId.Value;
                if (evt.TvdbId is not > 0) return 0;
                var indexed = evt.InstanceId == null ? null : _arrState.PeekLibrary(evt.InstanceId)?.SeriesByTvdb(evt.TvdbId.Value)?.TmdbId;
                if (indexed > 0) return indexed.Value;
                var key = Services.Acquire.TitleKey.ForSeries(evt.TvdbId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), null, null)!;
                return _titleAliases?.Of(key).FirstOrDefault(k => k.Provider == "tmdb")?.NumericId ?? 0;
            }

            if (parentalCalendar && calendarUser != null)
            {
                var absent = events.Where(e => jellyfinVerdicts?.ContainsKey(e) != true)
                    .Select(e => (Type: e.Source == nameof(ArrType.Radarr) ? "movie" : "tv", Id: ParentalTmdbId(e))).Where(e => e.Id > 0).Distinct().Take(100);
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
                budget.CancelAfter(TimeSpan.FromSeconds(8));
                using var lookups = new SemaphoreSlim(16);
                await Task.WhenAll(absent.Select(async e =>
                {
                    try
                    {
                        await lookups.WaitAsync(budget.Token).ConfigureAwait(false);
                        try { await (_parentalFilter?.MaySeeAbsentAsync(e.Type, e.Id, calendarUser.Id.ToString("N"), budget.Token) ?? Task.FromResult(false)).ConfigureAwait(false); }
                        finally { lookups.Release(); }
                    }
                    catch (OperationCanceledException) { /* Unverified rows remain hidden. */ }
                })).ConfigureAwait(false);
            }

            // True when the filter is off (or the caller is an administrator), or the caller may see the event.
            bool IsAccessible(ArrItem evt)
            {
                if (calendarUser == null || jellyfinVerdicts == null) return true;
                if (jellyfinVerdicts.TryGetValue(evt, out var visible)) return visible;
                if (parentalCalendar && _parentalFilter?.MaySeeAbsent(evt.Source == nameof(ArrType.Radarr) ? "movie" : "tv", ParentalTmdbId(evt), calendarUser.Id.ToString("N"), out _) != true) return false;
                // Shoko (no instance) keeps its own rule: only titles already in the user's Shoko
                // collection, matched to Jellyfin when Jellyfin has them.
                if (evt.Source == nameof(ArrType.Shoko)) return true;
                if (_instanceLibraries == null || evt.InstanceId == null || !instancesById.TryGetValue(evt.InstanceId, out var instance)) return false;
                var key = Services.Acquire.TitleAliases.FromProviderIds(instance.Kind == Services.Arr.ArrKind.Radarr, evt.TmdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture), evt.TvdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture), null).FirstOrDefault();
                if (key != null && _titleAliases?.AskedBy(key, calendarUser.Id) == true) return true;
                var target = _instanceLibraries.Resolve(instance, evt.ArrPath);
                rootsConsulted |= target.Via == "same_path" || target.Problem is Services.Acquire.ArrLibraryProblem.RootsUnknown or Services.Acquire.ArrLibraryProblem.SharedRoot or Services.Acquire.ArrLibraryProblem.NotInLibrary;
                return Services.Acquire.ArrInstanceLibraries.CanOpen(calendarUser, target, _instanceLibraries.Libraries());
            }

            // Deduplicate events across instances (CalendarDedup): an event the caller may see wins, then
            // one with the file; "also in" lists only instances whose event the caller may see.
            events = Services.Arr.CalendarDedup.Deduplicate(events, IsAccessible);

            // A lone candidate the caller may not see is hidden too (dedup only prefers visible ones).
            if (calendarUser != null)
                events = events.Where(IsAccessible).ToList();
            if (rootsConsulted)
            {
                foreach (var instance in arrInstances) _ = _arrState.WarmSystem(instance);
            }

            if (calendarUser != null)
            {
                var hiddenCalendar = Services.HiddenContentPolicy.Load(_userConfigurationManager, calendarUser.Id, HttpContext, _libraryManager);
                events = events.Where(e => !hiddenCalendar.IsHidden(Services.HiddenContentPolicy.TitleIdentity(
                    e.Source == nameof(ArrType.Radarr) ? "movie" : "tv", e.TmdbId?.ToString()), null, null, "calendar")).ToList();
            }
            // "Available" (the filter, the Play button, the time pill) is the one availability rule's answer for the caller (D53,
            // edition round 21): the shared viewer-aware boundary across every copy of the event's title the caller may open
            // (current library membership and location included), and Play opens the qualifying movie or episode item it found.
            // The arr's (or Shoko's) own file only chose between instances above; nothing here judges an item "plays" by itself.
            var calendarViewer = calendarPerson != null ? _arrView?.Viewer(calendarPerson.Id) : null;
            var editions = _arrView == null ? null : Services.Acquire.EditionAvailability.Over(_arrView, () => config, _titleAliases);
            // One look per movie, and per season of a series, however many events name it.
            var movies = new Dictionary<Services.Acquire.TitleKey, IReadOnlyList<Services.Acquire.EditionHit>>();
            var seasons = new Dictionary<(Services.Acquire.TitleKey, int), Services.Acquire.EpisodeEditions>();
            bool CalendarPlays(ArrItem evt)
            {
                if (calendarViewer == null || editions == null) return false;
                var movie = evt.Type == "Movie";
                var title = Services.Acquire.TitleAliases.FromProviderIds(movie, evt.TmdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    evt.TvdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture), evt.ImdbId).FirstOrDefault();
                IReadOnlyList<Services.Acquire.EditionHit> hits;
                if (title != null && movie)
                {
                    if (!movies.TryGetValue(title, out var found))
                        movies[title] = found = editions.Movie(calendarViewer, _arrView!.Copies(title, calendarViewer, _titleAliases?.Of(title)).Display, Services.Acquire.Edition.Any);
                    hits = found;
                }
                else if (title != null && evt.SeasonNumber is int season && evt.EpisodeNumber is int number)
                {
                    // An episode by its number in any copy (a multi-episode file covers its range).
                    if (!seasons.TryGetValue((title, season), out var played))
                        seasons[(title, season)] = played = editions.Episodes(calendarViewer, _arrView!.Copies(title, calendarViewer, _titleAliases?.Of(title)).Display, Services.Acquire.Edition.Any, season);
                    hits = played.For(season, number);
                }
                else if ((movie ? evt.ItemId : evt.ItemEpisodeId) is Guid item && item != Guid.Empty)
                    hits = editions.Item(calendarViewer, item, Services.Acquire.Edition.Any);
                else return false;
                if (hits.Count == 0) return false;
                // Play opens the qualifying item (the movie, or the episode in its series).
                var hit = hits[0];
                if (movie) evt.ItemId = hit.Source.ItemId;
                else
                {
                    evt.ItemEpisodeId = hit.Source.ItemId;
                    if (hit.SeriesId is Guid series) evt.ItemId = series;
                }
                return true;
            }
            foreach (var evt in events) evt.HasFile = CalendarPlays(evt);

            var calendarPresentation = _presentation?.Load(UserHelper.GetCurrentUserId(User) ?? Guid.Empty, HttpContext);
            if (calendarPresentation != null)
            {
                var json = JsonSerializer.Serialize(new { events, errors }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                return Content(calendarPresentation.ProjectResource(json, null, "calendar"), "application/json");
            }
            return Ok(new { events, errors });
        }

        private Task<(List<ArrItem> Items, string? Error)> FetchShokoCalendar(
            ArrInstance instance, DateTime startDate, DateTime endDate,
            HashSet<string> includedTypes, Func<object?, DateTime?> parseDate, CancellationToken ct)
        {
            var startParam = startDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            var endParam = endDate.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            return FetchAndMapAsync<List<ArrItem>>(
                instance,
                $"/api/v3/Dashboard/CalendarEpisodes?startDate={startParam}&endDate={endParam}&includeMissing=false&includeRestricted=false",
                data =>
                {
                    var items = new List<ArrItem>();
                    if (data == null) return items;
                    foreach (var episode in data)
                    {
                        // Which AniDB episode types to show is admin-configurable (Shoko settings).
                        var episodeType = (string?)episode.Type;
                        if (episodeType == null || !includedTypes.Contains(episodeType)) continue;

                        var airDate = parseDate((string?)episode.AirDate);
                        if (!airDate.HasValue) continue;

                        int? shokoSeriesId = episode.IDs?.ShokoSeries;
                        int? shokoEpisodeId = episode.IDs?.ShokoEpisode;
                        int? shokoFileId = episode.IDs?.ShokoFile;
                        var seriesTitle = (string?)episode.SeriesTitle ?? "Unknown Series";
                        var episodeTitle = (string?)episode.Title ?? "Unknown Episode";
                        var episodeNumber = (int?)episode.Number ?? 0;

                        items.Add(new ArrItem
                        {
                            Id = Services.Arr.ArrLegacyViews.RowId(ArrType.Shoko, null, shokoEpisodeId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? $"shoko-{shokoSeriesId}-{episodeType}-{episodeNumber}"),
                            Source = nameof(ArrType.Shoko),
                            InstanceName = "Shoko",
                            Type = "Series",
                            Title = seriesTitle,
                            EpisodeTitle = episodeTitle,
                            Subtitle = $"{episodeType} {episodeNumber} - {episodeTitle}",
                            ReleaseDate = airDate.Value.ToUniversalTime().ToString("o"),
                            ReleaseType = "Anime",
                            HasFile = shokoFileId.HasValue,
                            Monitored = true,
                            SeasonNumber = null,
                            EpisodeNumber = episodeNumber,
                            ShokoSeriesId = shokoSeriesId,
                            ShokoEpisodeId = shokoEpisodeId,
                        });
                    }
                    return items;
                },
                emptyResult: new List<ArrItem>(),
                timeout: TimeSpan.FromSeconds(15),
                contextLabel: "Shoko calendar",
                authHeaderName: "apikey",
                ct: ct);
        }

        /// <summary>
        /// Most distinct item ids one calendar user-data request may name (a big library's month
        /// of events names a few hundred). More is refused before any lookup.
        /// </summary>
        internal const int MaxCalendarUserDataIds = 2000;

        [HttpPost("arr/calendar/user-data")]
        [Authorize]
        // A year of events with their ids (the page sends a few hundred bytes per event).
        [BodyLimit(1024 * 1024)]
        public IActionResult GetCalendarUserDataForEvents([FromBody] CalendarUserDataRequest request)
        {
            if (JellyfinEnhanced.Instance?.Configuration is { CalendarPageEnabled: false })
                return ArrFeatureDisabled("The Calendar page");

            // The caller's own favourites and watched state: a person only (an API key has none).
            var user = ArrCaller.Human(User, _userManager);
            if (user == null)
                return StatusCode(403, new { error = true, code = "user_required", message = "Sign in as a Jellyfin user." });

            var results = new List<object>();

            try
            {
                if (request?.Events == null || request.Events.Count == 0)
                    return Ok(new { results });

                var ids = request.Events
                    .SelectMany(e => new Guid?[] { e.ItemId, e.ItemEpisodeId })
                    .Where(id => id.HasValue)
                    .Select(id => id!.Value)
                    .Distinct()
                    .ToList();
                // Bounded work per request, refused whole (never silently cut short).
                if (ids.Count > MaxCalendarUserDataIds)
                    return BadRequest(new { error = true, code = "too_many_ids", message = $"At most {MaxCalendarUserDataIds} item ids per request.", limit = MaxCalendarUserDataIds });

                // Which ids Jellyfin has at all: one query (no user, so nothing is decided by it).
                // Only those go through Jellyfin's own per-user check (library access and parental
                // limits), one by one: a query by ItemIds with a user skips the library restriction,
                // and on Jellyfin 12 setting User in the initialiser skips the parental filter too.
                // An unknown id costs nothing more (a per-id lookup of one is a database read each).
                // Ids the caller can't open get no flags (their user data is never read).
                var known = ids.Count == 0
                    ? new HashSet<Guid>()
                    : _libraryManager.GetItemList(new InternalItemsQuery { ItemIds = ids.ToArray() }).Select(i => i.Id).ToHashSet();
                var itemsById = new Dictionary<Guid, BaseItem>();
                foreach (var id in ids)
                {
                    if (known.Contains(id) && _libraryManager.GetItemById<BaseItem>(id, user) is { } item)
                        itemsById[id] = item;
                }

                // Process each event using pre-fetched items
                foreach (var evt in request.Events)
                {
                    bool isFavorite = false;
                    bool isWatched = false;

                    BaseItem? item = null;
                    BaseItem? episodeItem = null;

                    if (evt.ItemId.HasValue)
                        itemsById.TryGetValue(evt.ItemId.Value, out item);
                    if (evt.ItemEpisodeId.HasValue)
                        itemsById.TryGetValue(evt.ItemEpisodeId.Value, out episodeItem);

                    if (item != null)
                    {
                        var itemData = _userDataManager.GetUserData(user, item);
                        isFavorite = itemData?.Likes == true;

                        if (evt.Type == "Movie")
                        {
                            isWatched = itemData?.Played == true || (itemData?.PlaybackPositionTicks ?? 0) > 0;
                        }
                    }

                    if (evt.Type == "Series" && episodeItem != null)
                    {
                        var epData = _userDataManager.GetUserData(user, episodeItem);
                        isWatched = epData?.Played == true || (epData?.PlaybackPositionTicks ?? 0) > 0;
                    }

                    results.Add(new
                    {
                        id = evt.Id,
                        isFavorite,
                        isWatched
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to get calendar user data: {ex.Message}");
            }

            return Ok(new { results });
        }

        public class CalendarUserDataRequest
        {
            public List<CalendarEventInfo> Events { get; set; } = new();
        }

        public class CalendarEventInfo
        {
            public string? Id { get; set; }
            public string? Type { get; set; }
            public string? Title { get; set; }
            public Guid? ItemId { get; set; }
            public Guid? ItemEpisodeId { get; set; }
            public int? TvdbId { get; set; }
            public string? ImdbId { get; set; }
            public int? TmdbId { get; set; }
            public int? SeasonNumber { get; set; }
            public int? EpisodeNumber { get; set; }
        }

        private async Task<(string? Title, int? Year, string? PosterUrl, string? DigitalReleaseDate, string? TheatricalReleaseDate, string? InitialAirDate, string? NextAirDate)> EnrichWithTmdbData(HttpClient client, int tmdbId, string type, string jellyseerrUrl, string apiKey, long enrichmentGeneration, DateTime requestStart)
        {
            // enrichmentGeneration and requestStart: taken by the request before it read the configuration that named
            // jellyseerrUrl and apiKey (a drop since then means they may be the old Seerr's).
            var cacheKey = $"{(type == "movie" ? "movie" : "tv")}:{tmdbId}";
            var cacheTtl = GetTmdbEnrichmentCacheTtl();
            var cacheEnabled = !(JellyfinEnhanced.Instance?.Configuration?.JellyseerrDisableCache ?? false);

            if (cacheEnabled)
            {
                lock (_tmdbEnrichmentCacheLock)
                {
                    if (_tmdbEnrichmentCache.TryGetValue(cacheKey, out var cached) &&
                        DateTime.UtcNow - cached.CachedAt < cacheTtl)
                    {
                        var hit = cached.Data;
                        return (hit.Title, hit.Year, hit.PosterUrl, hit.DigitalReleaseDate, hit.TheatricalReleaseDate, hit.InitialAirDate, hit.NextAirDate);
                    }
                }
            }

            async Task<TmdbEnrichmentResult> FetchEnrichmentAsync()
            {
                try
                {
                    var endpoint = type == "movie" ? "movie" : "tv";
                    var enrichUri = $"{jellyseerrUrl}/api/v1/{endpoint}/{tmdbId}";
                    using var enrichRequest = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, enrichUri, apiKey);
                    using var response = await client.SendAsync(enrichRequest);
                    var (content, enrichError) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, enrichUri);

                    if (enrichError != null || content == null)
                    {
                        return new TmdbEnrichmentResult();
                    }

                    var data = System.Text.Json.JsonSerializer.Deserialize<System.Text.Json.JsonElement>(content);

                    string? title = null;
                    int? year = null;
                    string? posterUrl = null;
                    string? digitalReleaseDate = null;
                    string? theatricalReleaseDate = null;
                    string? initialAirDate = null;
                    string? nextAirDate = null;

                    if (type == "movie")
                    {
                        if (data.TryGetProperty("title", out var titleProp))
                            title = titleProp.GetString();
                        if (data.TryGetProperty("releaseDate", out var rd) && !string.IsNullOrEmpty(rd.GetString()) && rd.GetString()!.Length >= 4)
                        {
                            year = int.TryParse(rd.GetString()!.Substring(0, 4), out var y) ? y : null;
                            theatricalReleaseDate = rd.GetString();
                        }

                        if (data.TryGetProperty("releases", out var releases) && releases.TryGetProperty("results", out var results))
                        {
                            foreach (var regionRelease in results.EnumerateArray())
                            {
                                if (regionRelease.TryGetProperty("release_dates", out var releaseDates))
                                {
                                    foreach (var release in releaseDates.EnumerateArray())
                                    {
                                        if (release.TryGetProperty("type", out var typeProp))
                                        {
                                            var releaseType = typeProp.GetInt32();
                                            if (releaseType == 4 && release.TryGetProperty("release_date", out var digitalDateProp))
                                            {
                                                var dateStr = digitalDateProp.GetString();
                                                if (!string.IsNullOrEmpty(dateStr))
                                                {
                                                    if (digitalReleaseDate == null || string.Compare(dateStr, digitalReleaseDate, StringComparison.Ordinal) < 0)
                                                    {
                                                        digitalReleaseDate = dateStr.Length >= 10 ? dateStr.Substring(0, 10) : dateStr;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    else
                    {
                        if (data.TryGetProperty("name", out var nameProp))
                            title = nameProp.GetString();

                        if (data.TryGetProperty("firstAirDate", out var fad) && !string.IsNullOrEmpty(fad.GetString()))
                        {
                            initialAirDate = fad.GetString();
                            if (initialAirDate != null && initialAirDate.Length >= 4)
                                year = int.TryParse(initialAirDate.Substring(0, 4), out var y) ? y : null;
                        }

                        if (data.TryGetProperty("nextEpisodeToAir", out var nextEp) && nextEp.ValueKind != System.Text.Json.JsonValueKind.Null)
                        {
                            if (nextEp.TryGetProperty("airDate", out var airDateProp))
                            {
                                nextAirDate = airDateProp.GetString();
                            }
                        }
                    }

                    if (data.TryGetProperty("posterPath", out var poster) && poster.ValueKind != System.Text.Json.JsonValueKind.Null)
                    {
                        posterUrl = $"https://image.tmdb.org/t/p/w300{poster.GetString()}";
                    }

                    return new TmdbEnrichmentResult
                    {
                        Title = title,
                        Year = year,
                        PosterUrl = posterUrl,
                        DigitalReleaseDate = digitalReleaseDate,
                        TheatricalReleaseDate = theatricalReleaseDate,
                        InitialAirDate = initialAirDate,
                        NextAirDate = nextAirDate
                    };
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Failed to enrich request with TMDB data: {ex.Message}");
                    return new TmdbEnrichmentResult();
                }
            }

            TmdbEnrichmentResult result;
            if (cacheEnabled)
            {
                // Shared only with reads of the same generation (one that began before a drop never answers a later one).
                var flightKey = cacheKey + "@" + enrichmentGeneration.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var fetchTask = _tmdbEnrichmentInFlight.GetOrAdd(flightKey, _ => FetchEnrichmentAsync());
                try
                {
                    result = await fetchTask;
                }
                finally
                {
                    _tmdbEnrichmentInFlight.TryRemove(new KeyValuePair<string, Task<TmdbEnrichmentResult>>(flightKey, fetchTask));
                }

                // don't cache empty enrichment
                // results from upstream failures. Otherwise a Cloudflare-blip
                // pollutes the cache with null titles/posters for the full TTL
                // (default 10 min) — even after Seerr recovers and the user
                // refreshes the requests page, posters stay missing.
                bool isEmpty = result == null
                    || (string.IsNullOrEmpty(result.Title)
                        && result.Year == null
                        && string.IsNullOrEmpty(result.PosterUrl));
                if (!isEmpty)
                {
                    lock (_tmdbEnrichmentCacheLock)
                    {
                        if (enrichmentGeneration == Interlocked.Read(ref _seerrResponseGeneration)) _tmdbEnrichmentCache[cacheKey] = (result!, requestStart);

                        if (_tmdbEnrichmentCache.Count > 500 || _tmdbEnrichmentCache.Count % 100 == 0)
                        {
                            var staleKeys = _tmdbEnrichmentCache
                                .Where(kv => DateTime.UtcNow - kv.Value.CachedAt > cacheTtl)
                                .Select(kv => kv.Key)
                                .ToList();
                            foreach (var staleKey in staleKeys)
                            {
                                _tmdbEnrichmentCache.Remove(staleKey);
                            }
                        }
                    }
                }
            }
            else
            {
                result = await FetchEnrichmentAsync();
            }

            result ??= new TmdbEnrichmentResult();
            return (result.Title, result.Year, result.PosterUrl, result.DigitalReleaseDate, result.TheatricalReleaseDate, result.InitialAirDate, result.NextAirDate);
        }

        private static string GetMediaStatus(int? requestStatus, int? mediaStatus, bool hasActiveDownload = false)
        {
            // MediaStatus: 1 = Unknown, 2 = Pending, 3 = Processing, 4 = Partially Available, 5 = Available, 6 = Blocklisted, 7 = Deleted
            // MediaRequestStatus: 1 = Pending, 2 = Approved, 3 = Declined, 4 = Failed, 5 = Completed

            // Check media status first (higher priority)
            if (mediaStatus == 7) return "Deleted";
            if (mediaStatus == 6) return "Blocklisted";
            if (mediaStatus == 5) return "Available";
            if (mediaStatus == 4) return "Partially Available";
            // MediaStatus.PROCESSING (3): only show "Processing" when Radarr/Sonarr is actively downloading.
            // Without active download data the request is approved-but-queued — Seerr labels that "Requested".
            if (mediaStatus == 3) return hasActiveDownload ? "Processing" : "Approved";
            if (mediaStatus == 2) return "Pending";

            // Fall back to request status
            if (requestStatus == 5) return "Completed";
            if (requestStatus == 4) return "Failed";
            if (requestStatus == 3) return "Declined";
            if (requestStatus == 2) return "Approved";
            if (requestStatus == 1) return "Pending";

            // Default fallback
            return "Unknown";
        }

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

                var client = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(10);
                // The avatar lives from when its read began.
                var readAt = DateTime.UtcNow;

                using var avatarRequest = new System.Net.Http.HttpRequestMessage(System.Net.Http.HttpMethod.Get, $"{jellyseerrUrl}{avatarPath}");
                // explicit User-Agent + Accept so Cloudflare's bot
                // mode doesn't return an HTML challenge page that we'd try to
                // serve as an image.
                avatarRequest.Headers.UserAgent.ParseAdd(Helpers.Jellyseerr.SeerrHttpHelper.UserAgent);
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
                _avatarCache[cacheKey] = (content, contentType, etag, readAt);
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
        [HttpGet("items/by-providers")]
        public ActionResult<Guid?> GetItemIdByProviders(
            [FromQuery] Dictionary<string, string>? providers,
            [FromQuery] string? types = null)
        {
            List<BaseItemKind>? includeItemTypes = null;
            if (!string.IsNullOrWhiteSpace(types))
            {
                includeItemTypes = types
                    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(t => Enum.TryParse<BaseItemKind>(t, true, out var kind) ? kind : (BaseItemKind?)null)
                    .Where(k => k.HasValue)
                    .Select(k => k!.Value)
                    .ToList();
            }

            var itemIds = _itemRepository.GetItemIdsByProviders(providers, includeItemTypes);

            // Only an item the caller can open: the repository lookup sees every library, so a
            // match outside the caller's libraries or parental limits is left out (an unknown or
            // API-key caller gets the first match, as before, since it has no library view).
            var callerId = ArrCaller.PersonId(User);
            var caller = callerId is Guid uid ? _userManager.GetUserById(uid) : null;
            if (caller != null)
            {
                itemIds = itemIds.Where(id => _libraryManager.GetItemById(id) is { } candidate && candidate.IsVisibleStandalone(caller)).ToList();
            }

            if (itemIds.Count == 0)
            {
                // Nothing supplied is a bad request; nothing found (a title not in the library, the
                // calendar's everyday case) is an empty answer, not an error.
                return providers == null || providers.Count == 0
                    ? BadRequest("No provider ids supplied")
                    : NoContent();
            }

            return Ok(itemIds.FirstOrDefault());
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

            Stream? stream = JellyfinEnhanced.Instance.GetType().Assembly.GetManifestResourceStream(view.EmbeddedResourcePath);

            if (stream == null)
            {
                _logger.Warning($"Failed to get resource {view.EmbeddedResourcePath}");
                return NotFound();
            }

            return File(stream, MimeTypes.GetMimeType(view.EmbeddedResourcePath));
        }
    }
    public class TmdbPersonData
    {
        public DateTime? BirthDate { get; set; }
        public DateTime? DeathDate { get; set; }
        public string? BirthPlace { get; set; }
    }

    public class BroadcastMessageRequest
    {
        public string? Header { get; set; }

        public string Text { get; set; } = string.Empty;

        public long? TimeoutMs { get; set; }
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
