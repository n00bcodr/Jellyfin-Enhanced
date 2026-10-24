using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Monitors library additions to automatically add requested media to user watchlists.
    // Queries Jellyseerr API directly to check if added items were requested by users; with "Ask for it"
    // (phase 3) on, reads who asked from the shared request facts instead (the request ledger in JE mode,
    // Seerr's read model in Seerr mode) and defers an item while that read is incomplete.
    public class WatchlistMonitor : IDisposable
    {
        private const int MaxDeferred = 500;
        private const int MaxDeferAttempts = 10;
        private static readonly TimeSpan DeferInterval = TimeSpan.FromMinutes(2);
        private readonly SharedRequestFacts? _facts;
        private ConcurrentDictionary<Guid, int> _deferred = new();
        private Timer? _deferTimer;
        private int _recheckRunning;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly Logger _logger;
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Cache<(List<RequestItemWithUser> Items, DateTime CachedAt)> _requestsCache = new();
        private readonly object _subscriptionLock = new();
        private bool _subscribed;
        // A read in flight and when it began (what it answers lives from then, also for the requests that joined it).
        private readonly Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Cache<(Task<List<RequestItemWithUser>?> Task, DateTime StartedAt)> _requestsInFlight = new();

        public WatchlistMonitor(
            ILibraryManager libraryManager,
            IUserManager userManager,
            IUserDataManager userDataManager,
            IHttpClientFactory httpClientFactory,
            UserConfigurationManager userConfigurationManager,
            Logger logger,
            SharedRequestFacts? facts = null)
        {
            _facts = facts;
            _libraryManager = libraryManager;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _httpClientFactory = httpClientFactory;
            _userConfigurationManager = userConfigurationManager;
            _logger = logger;
        }

        private static string NormalizeUserId(string? userId)
        {
            return string.IsNullOrEmpty(userId) ? string.Empty : userId.Replace("-", string.Empty);
        }

        private static TimeSpan GetRequestsCacheTtl()
        {
            return TimeSpan.FromSeconds(30);
        }

        // Initialize and start monitoring library events.
        public void Initialize()
        {
            // Always subscribed: each library event checks the settings first (ScheduleWatchlistCheck), so turning the
            // feature on applies right away, without a restart.
            lock (_subscriptionLock)
            {
                if (_subscribed) return;
                _libraryManager.ItemAdded += OnItemAdded;
                _libraryManager.ItemUpdated += OnItemUpdated;
                _subscribed = true;
            }
            _logger.Info("[Watchlist] Subscribed to library ItemAdded and ItemUpdated events (" + (CanRun(JellyfinEnhanced.Instance?.Configuration) ? "on" : "off until enabled") + ")");
        }

        // True when the feature can act: on, with Seerr or the shared request facts to read requests from.
        private bool CanRun(PluginConfiguration? config)
            => config is { AddRequestedMediaToWatchlist: true } && ((EffectiveRequestsBackend.AllowsSeerr(config) && config.JellyseerrEnabled) || (_facts != null && SharedRequestFacts.Active(config)));

        // Handle library item added events to check if they match pending watchlist items.
        private void OnItemAdded(object? sender, ItemChangeEventArgs e) => ScheduleWatchlistCheck(e, "ItemAdded");

        // Handle library item updated events (fires after metadata refresh) to check if they match pending watchlist items.
        private void OnItemUpdated(object? sender, ItemChangeEventArgs e) => ScheduleWatchlistCheck(e, "ItemUpdated");

        // ItemAdded/ItemUpdated fire synchronously on Jellyfin's library-scan thread. Do only
        // the cheap Movie/Series reject here, then run the Seerr request lookup + per-user watchlist
        // writes off-thread. (Awaiting ProcessItemForWatchlist is NOT enough: GetAllJellyseerrRequests
        // returns synchronously on a cache hit, so the continuation would run on the scan thread.)
        private void ScheduleWatchlistCheck(ItemChangeEventArgs e, string eventType)
        {
            var kind = e.Item?.GetBaseItemKind();
            if (kind != BaseItemKind.Movie && kind != BaseItemKind.Series) return;
            if (!CanRun(JellyfinEnhanced.Instance?.Configuration)) return;
            _ = Task.Run(() => ProcessItemForWatchlist(e, eventType));
        }


        // Process an item from library events to check if it matches any Jellyseerr requests.
        private Task ProcessItemForWatchlist(ItemChangeEventArgs e, string eventType)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => ProcessItemForWatchlistFactsCore(e, eventType), CancellationToken.None);

        private async Task ProcessItemForWatchlistFactsCore(ItemChangeEventArgs e, string eventType)
        {
            try
            {
                // Only process movies and TV series - check this first to avoid spam
                var itemKind = e.Item?.GetBaseItemKind();
                if (itemKind != BaseItemKind.Movie && itemKind != BaseItemKind.Series)
                {
                    return;
                }

                // _logger.Info($"[Watchlist] {eventType} event triggered for: {e.Item?.Name ?? "Unknown"} (Type: {itemKind})");

                // Check if watchlist feature is enabled
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null)
                {
                    _logger.Warning("[Watchlist] Configuration is null");
                    return;
                }

                if (!config.AddRequestedMediaToWatchlist)
                {
                    _logger.Debug("[Watchlist] AddRequestedMediaToWatchlist is disabled");
                    return;
                }

                var shared = _facts != null && SharedRequestFacts.Active(config);
                if (!shared && (!EffectiveRequestsBackend.AllowsSeerr(config) || !config.JellyseerrEnabled))
                {
                    _logger.Debug("[Watchlist] JellyseerrEnabled is disabled");
                    return;
                }

                // Check if item has TMDB ID
                if (e.Item?.ProviderIds == null)
                {
                    _logger.Debug($"[Watchlist] [{eventType}] Item has no ProviderIds yet: {e.Item?.Name}");
                    return;
                }

                if (!e.Item.ProviderIds.TryGetValue("Tmdb", out var tmdbIdString))
                {
                    _logger.Debug($"[Watchlist] [{eventType}] Item has no TMDB ID yet: {e.Item.Name}");
                    return;
                }

                if (!int.TryParse(tmdbIdString, out var tmdbId))
                {
                    _logger.Warning($"[Watchlist] Invalid TMDB ID format: {tmdbIdString}");
                    return;
                }

                var mediaType = itemKind == BaseItemKind.Movie ? "movie" : "tv";
                // _logger.Info($"[Watchlist] New {mediaType} added to library: '{e.Item.Name}' (TMDB: {tmdbId})");

                if (shared)
                {
                    await ProcessFromSharedFactsAsync(e.Item, tmdbId, mediaType, config, 0);
                    return;
                }

                using var operation = EffectiveRequestsBackend.Shared.AdmitSeerr(SeerrUse.Watchlist, CancellationToken.None);
                // Query Jellyseerr for ALL requests in a single API call
                var jellyseerrUrl = config.JellyseerrUrls?.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim().TrimEnd('/');
                if (string.IsNullOrEmpty(jellyseerrUrl) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
                {
                    _logger.Warning("[Watchlist] Jellyseerr URL or API key not configured");
                    return;
                }

                var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                // Fetch all requests at once (no X-Api-User header = all requests)
                var allRequests = await GetAllJellyseerrRequests(httpClient, jellyseerrUrl, config.GetJellyseerrApiKey());
                if (allRequests == null || allRequests.Count == 0)
                {
                    return;
                }

                // Find requests matching this TMDB ID and media type
                var matchingRequests = allRequests.Where(r => r.TmdbId == tmdbId && r.MediaType == mediaType && !string.IsNullOrEmpty(r.RequestedByJellyfinUserId)).ToList();

                if (matchingRequests.Count == 0)
                {
                    return;
                }

                AddForRequesters(e.Item, tmdbId, mediaType, matchingRequests.Select(request => request.RequestedByJellyfinUserId), config, operation);
            }
            catch (Exception ex)
            {
                _logger.Error($"[Watchlist] Error in ProcessItemForWatchlist: {ex.Message}\nStack trace: {ex.StackTrace}");
            }
        }

        // Adds the item to the watchlist of each requester who may still get it (blocked users and items
        // already processed are skipped).
        private void AddForRequesters(BaseItem item, int tmdbId, string mediaType, IEnumerable<string?> requesters, PluginConfiguration config, EffectiveRequestsBackend.Admission? operation = null)
        {
            var usersByNormalizedId = _userManager.GetAllUsers()
                .GroupBy(user => NormalizeUserId(user.Id.ToString()), StringComparer.OrdinalIgnoreCase)
                .ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);

            // filter out users in the import
            // blocklist so a blocked user's existing requests don't keep
            // syncing to their Jellyfin watchlist (defeats admin intent).
            var blockedIds = Helpers.Jellyseerr.JellyseerrUserImportHelper
                .GetBlockedUserIds(config.JellyseerrImportBlockedUsers);

            var requesterIds = requesters
                .Select(NormalizeUserId)
                .Where(id => !string.IsNullOrEmpty(id))
                .Where(id => !blockedIds.Contains(id))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            // Add to watchlist for each user who requested it (only log if actually added)
            var addedCount = 0;
            var addedUsers = new List<string>();

            foreach (var jellyfinUserId in requesterIds)
            {
                if (!usersByNormalizedId.TryGetValue(jellyfinUserId, out var user))
                {
                    continue;
                }

                // Check if prevention is enabled and item was already processed
                if (config.PreventWatchlistReAddition)
                {
                    var processedItems = _userConfigurationManager.GetProcessedWatchlistItems(user.Id);
                    if (processedItems.Items.Any(p => p.TmdbId == tmdbId && p.MediaType == mediaType))
                    {
                        continue; // Skip this user, item was already processed
                    }
                }

                void Publish(Action effect) { if (operation == null) effect(); else operation.Publish(effect); }
                var userData = _userDataManager.GetUserData(user, item);
                if (userData != null && userData.Likes != true)
                {
                    Publish(() =>
                    {
                        userData.Likes = true;
                        _userDataManager.SaveUserData(user, item, userData, UserDataSaveReason.UpdateUserRating, operation?.Token ?? default);
                    });
                    addedCount++;
                    addedUsers.Add(user.Username);

                    // Mark as processed if prevention is enabled
                    if (config.PreventWatchlistReAddition)
                    {
                        Publish(() => _userConfigurationManager.MarkWatchlistItemProcessed(user.Id, tmdbId, mediaType, "monitor"));
                    }
                }
                else if (userData != null && userData.Likes == true && config.PreventWatchlistReAddition)
                {
                    // Item is already in watchlist, mark as processed if not already marked
                    Publish(() => _userConfigurationManager.MarkWatchlistItemProcessed(user.Id, tmdbId, mediaType, "existing"));
                }
            }

            // Only log if we actually added the item to at least one watchlist
            if (addedCount > 0)
            {
                _logger.Info($"[Watchlist] ✓ Added '{item.Name}' to watchlist for {string.Join(", ", addedUsers)}");
            }
        }

        // Phase 3: who asked comes from the shared request facts. While that read is incomplete (Seerr's
        // read model still loading, only partly read, or failing) the item is deferred and checked again
        // later, never treated as "nobody asked". When Seerr simply holds more requests than its read model
        // keeps, waiting can't help: the title's own request list from Seerr answers instead. Returns false
        // when deferred.
        internal Task<bool> ProcessFromSharedFactsAsync(BaseItem item, int tmdbId, string mediaType, PluginConfiguration config, int attempt)
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => ProcessFromSharedFactsAsyncFactsCore(item, tmdbId, mediaType, config, attempt), CancellationToken.None);

        private async Task<bool> ProcessFromSharedFactsAsyncFactsCore(BaseItem item, int tmdbId, string mediaType, PluginConfiguration config, int attempt)
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var key = SharedRequestFacts.KeyOf(mediaType == "movie", tmdbId, item.ProviderIds.GetValueOrDefault("Tvdb"), item.ProviderIds.GetValueOrDefault("Imdb"));
            if (key == null || _facts == null) return true;
            using var operation = SharedRequestFacts.LedgerAuthority(config) ? null : EffectiveRequestsBackend.Shared.AdmitSeerr(SeerrUse.Watchlist, CancellationToken.None);
            var requesters = _facts.For(config, key);
            IEnumerable<string?> users = requesters.Users.Select(u => (string?)u.ToString());
            if (!requesters.Complete)
            {
                var fromSeerr = requesters.Truncated ? await SeerrTitleRequestersAsync(config, tmdbId, mediaType).ConfigureAwait(false) : null;
                if (fromSeerr == null)
                {
                    Defer(item.Id, attempt);
                    return false;
                }
                users = users.Concat(fromSeerr);
            }
            operation?.DemandCurrent();
            _deferredFacts.TryRemove(item.Id, out _);
            var list = users.ToList();
            if (list.Count > 0)
            {
                AddForRequesters(item, tmdbId, mediaType, list, config, operation);
            }
            return true;
        }

        // Every request Seerr holds for one title (its details' mediaInfo.requests, complete for that title),
        // as Jellyfin user ids of the people who asked (declined requests left out). Null when Seerr couldn't
        // be read; empty when Seerr doesn't know the title.
        private async Task<List<string?>?> SeerrTitleRequestersAsync(PluginConfiguration config, int tmdbId, string mediaType)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(config)) return null;
            var apiKey = config.GetJellyseerrApiKey();
            var urls = (config.JellyseerrUrls ?? string.Empty).Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/')).Where(u => u.Length > 0).ToList();
            if (!(EffectiveRequestsBackend.AllowsSeerr(config) && config.JellyseerrEnabled) || urls.Count == 0 || string.IsNullOrEmpty(apiKey)) return null;
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            foreach (var url in urls)
            {
                var requestUri = $"{url}/api/v1/{(mediaType == "movie" ? "movie" : "tv")}/{tmdbId}";
                try
                {
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, apiKey);
                    using var response = await httpClient.SendAsync(request).ConfigureAwait(false);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri).ConfigureAwait(false);
                    if (error != null)
                    {
                        if (error.HttpStatus == 404) return new List<string?>();
                        continue;
                    }
                    using var doc = JsonDocument.Parse(content!);
                    var users = new List<string?>();
                    if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("mediaInfo", out var media) && media.ValueKind == JsonValueKind.Object &&
                        media.TryGetProperty("requests", out var requests) && requests.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var entry in requests.EnumerateArray())
                        {
                            if (entry.ValueKind != JsonValueKind.Object) continue;
                            if (entry.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.Number && status.GetInt32() == Acquire.SeerrRequestStatus.Declined) continue;
                            if (entry.TryGetProperty("requestedBy", out var by) && by.ValueKind == JsonValueKind.Object &&
                                by.TryGetProperty("jellyfinUserId", out var id) && id.ValueKind == JsonValueKind.String)
                                users.Add(id.GetString());
                        }
                    }
                    return users;
                }
                catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException or InvalidOperationException)
                {
                    _logger.Debug($"[Watchlist] Title request lookup failed at {url}: {ex.Message}");
                }
            }
            return null;
        }

        // Remembers an item to check again (bounded; gives up after MaxDeferAttempts tries, about 20 minutes).
        private void Defer(Guid itemId, int attempt)
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (attempt + 1 >= MaxDeferAttempts)
            {
                _deferredFacts.TryRemove(itemId, out _);
                _logger.Info($"[Watchlist] Request facts stayed incomplete; gave up on item {itemId:N} after {MaxDeferAttempts} tries");
                return;
            }
            if (!_deferredFacts.ContainsKey(itemId) && _deferredFacts.Count >= MaxDeferred)
            {
                _logger.Warning($"[Watchlist] {MaxDeferred} items are already waiting for complete request facts; item {itemId:N} skipped");
                return;
            }
            _deferredFacts[itemId] = attempt + 1;
            lock (_subscriptionLock)
            {
                _deferTimer ??= new Timer(_ => { _ = Task.Run(RecheckDeferredAsync); }, null, DeferInterval, DeferInterval);
            }
        }

        /// <summary>Items waiting for complete request facts (tests).</summary>
        internal int Deferred
        {
            get
            {
                using var __factsOperation2 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
                return _deferredFacts.Count;
            }
        }
        // Checks every deferred item again (timer, or tests directly); one pass at a time.
        internal Task RecheckDeferredAsync()
            => Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.BackgroundAsync(token => RecheckDeferredAsyncFactsCore(), CancellationToken.None);

        private async Task RecheckDeferredAsyncFactsCore()
        {
            using var __factsOperation3 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (Interlocked.Exchange(ref _recheckRunning, 1) == 1) return;
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || _facts == null || !config.AddRequestedMediaToWatchlist || !SharedRequestFacts.Active(config))
                {
                    _deferredFacts.Clear();
                    return;
                }
                foreach (var (itemId, attempt) in _deferredFacts.ToArray())
                {
                    var item = _libraryManager.GetItemById(itemId);
                    if (item?.ProviderIds == null || !item.ProviderIds.TryGetValue("Tmdb", out var raw) || !int.TryParse(raw, out var tmdbId))
                    {
                        _deferredFacts.TryRemove(itemId, out _);
                        continue;
                    }
                    await ProcessFromSharedFactsAsync(item, tmdbId, item.GetBaseItemKind() == BaseItemKind.Movie ? "movie" : "tv", config, attempt).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Watchlist] Deferred check failed: {ex.Message}");
            }
            finally
            {
                Interlocked.Exchange(ref _recheckRunning, 0);
            }
        }

        // Get ALL requests from Jellyseerr in a single API call
        private async Task<List<RequestItemWithUser>?> GetAllJellyseerrRequests(HttpClient httpClient, string jellyseerrUrl, string apiKey)
        {
            if (!EffectiveRequestsBackend.Shared.CheckSeerr(SeerrUse.Watchlist).Allowed) return null;
            var cacheKey = jellyseerrUrl.TrimEnd('/');
            var cacheTtl = GetRequestsCacheTtl();

            using (Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.CacheMutation())
            {
                if (_requestsCache.TryGetValue(cacheKey, out var cached) &&
                    DateTime.UtcNow - cached.CachedAt < cacheTtl)
                {
                    return cached.Items;
                }
            }

            async Task<List<RequestItemWithUser>?> FetchAsync()
            {
                try
                {
                    var requestUri = $"{cacheKey}/api/v1/request?take=1000&skip=0&sort=added&filter=all";

                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, apiKey);
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
                    if (error != null)
                    {
                        _logger.Warning($"[Watchlist] Failed to fetch requests from Jellyseerr: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                        return null;
                    }

                    var json = JsonSerializer.Deserialize<JsonElement>(content!);

                    if (!json.TryGetProperty("results", out var resultsArray))
                    {
                        _logger.Warning("[Watchlist] Requests response missing results array");
                        return null;
                    }

                    var items = new List<RequestItemWithUser>();
                    foreach (var item in resultsArray.EnumerateArray())
                    {
                        var parsed = ParseRequestItemWithUser(item);
                        if (parsed != null)
                        {
                            items.Add(parsed);
                        }
                    }

                    return items;
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Watchlist] Error fetching all requests: {ex.Message}");
                    return null;
                }
            }

            var flight = _requestsInFlight.GetOrAdd(cacheKey, _ =>
            {
                var startedAt = DateTime.UtcNow;
                return (FetchAsync(), startedAt);
            });
            try
            {
                var items = await flight.Task;
                if (items != null)
                {
                    using (Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.CacheMutation())
                    {
                        _requestsCache[cacheKey] = (items, flight.StartedAt);
                    }
                }
                return items;
            }
            finally
            {
                _requestsInFlight.TryRemove(new KeyValuePair<string, (Task<List<RequestItemWithUser>?>, DateTime)>(cacheKey, flight));
            }
        }

        // Parse a request item including the requesting user's Jellyfin ID
        private RequestItemWithUser? ParseRequestItemWithUser(JsonElement item)
        {
            try
            {
                int? tmdbId = null;
                string? mediaType = null;
                string? requestedByJellyfinUserId = null;

                // Get media type from root
                if (item.TryGetProperty("type", out var typeElement))
                {
                    mediaType = typeElement.GetString() switch
                    {
                        "movie" => "movie",
                        "tv" => "tv",
                        _ => null
                    };
                }

                // Get TMDB ID from media.tmdbId
                if (item.TryGetProperty("media", out var mediaElement))
                {
                    if (mediaElement.TryGetProperty("tmdbId", out var tmdbElement) && tmdbElement.ValueKind == JsonValueKind.Number)
                    {
                        tmdbId = tmdbElement.GetInt32();
                    }
                }

                // Get requesting user's Jellyfin ID from requestedBy.jellyfinUserId
                if (item.TryGetProperty("requestedBy", out var requestedByElement))
                {
                    if (requestedByElement.TryGetProperty("jellyfinUserId", out var jellyfinUserIdElement))
                    {
                        requestedByJellyfinUserId = jellyfinUserIdElement.GetString();
                    }
                }

                if (tmdbId.HasValue && mediaType != null && !string.IsNullOrEmpty(requestedByJellyfinUserId))
                {
                    return new RequestItemWithUser
                    {
                        TmdbId = tmdbId.Value,
                        MediaType = mediaType,
                        RequestedByJellyfinUserId = requestedByJellyfinUserId
                    };
                }
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Watchlist] Error parsing request item: {ex.Message}");
            }

            return null;
        }


        // Cleanup when the plugin is disposed.
        public void Dispose()
        {
            _logger.Info("[Watchlist] Unsubscribing from library events");
            lock (_subscriptionLock)
            {
                _libraryManager.ItemAdded -= OnItemAdded;
                _libraryManager.ItemUpdated -= OnItemUpdated;
                _subscribed = false;
                _deferTimer?.Dispose();
                _deferTimer = null;
            }
            GC.SuppressFinalize(this);
        }

        // Model for Jellyseerr request items
        private class RequestItem
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = string.Empty;
        }

        // Model for Jellyseerr request items with requesting user
        private class RequestItemWithUser
        {
            public int TmdbId { get; set; }
            public string MediaType { get; set; } = string.Empty;
            public string? RequestedByJellyfinUserId { get; set; }
        }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<Guid, int>> _deferredFactsOwner = new();
        private ConcurrentDictionary<Guid, int> _deferredFacts { get => _deferredFactsOwner.Read(ref _deferred, () => new()); set => _deferredFactsOwner.Store(ref _deferred, value); }
    }
}
