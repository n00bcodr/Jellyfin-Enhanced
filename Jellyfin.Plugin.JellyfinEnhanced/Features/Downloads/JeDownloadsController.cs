using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using static Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Downloads
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public partial class JeDownloadsController : JeControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Shared.Parental.SeerrParentalFilter _parentalFilter;
        private readonly Shared.SpoilerGuard.SpoilerSeerrRedactor _spoilerSeerrRedactor;
        private readonly UserDisplayResolver _userDisplayResolver;
        private readonly ArrInstanceClient _arrInstanceClient;
        private readonly SeerrUserLookup _seerrUserLookup;

        public JeDownloadsController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            UserConfigurationManager userConfigurationManager,
            Shared.Parental.SeerrParentalFilter parentalFilter,
            Shared.SpoilerGuard.SpoilerSeerrRedactor spoilerSeerrRedactor)
            : base(userManager, logger, userConfigurationManager)
        {
            _httpClientFactory = httpClientFactory;
            _parentalFilter = parentalFilter;
            _spoilerSeerrRedactor = spoilerSeerrRedactor;
            _userDisplayResolver = new UserDisplayResolver(userManager);
            _arrInstanceClient = new ArrInstanceClient(httpClientFactory, logger);
            _seerrUserLookup = new SeerrUserLookup(httpClientFactory, logger, _userDisplayResolver);
        }

        private async Task<List<WatchlistItem>?> GetJellyseerrRequestsForUser(string userId)
        {
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
                {
                    return null;
                }

                var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var httpClient = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                foreach (var url in urls)
                {
                    var trimmedUrl = url.Trim();
                    try
                    {
                        var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/request?take=500&skip=0&sort=added";
                        using var request = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestUri, config.JellyseerrApiKey, userId);
                        using var response = await httpClient.SendAsync(request);
                        var (content, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);
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

        /// <summary>
        /// Non-admin users can only see downloads/history for items they requested via Seerr,
        /// unless the admin has disabled per-user filtering. Returns Blocked=true when the
        /// caller should be shown an empty result (no Seerr link, no linked account, or no
        /// requests to filter by) rather than the unfiltered arr queue/history, and Failed=true
        /// when the caller's requests could not be read, which is not the same as having none.
        /// </summary>
        private async Task<(bool Blocked, HashSet<(int TmdbId, string MediaType)>? Allowed, bool Failed)> GetAllowedRequestsForCurrentUserAsync(PluginConfiguration config)
        {
            if (IsAdminUser() || !config.DownloadsFilterByUserRequests)
                return (false, null, false);

            if (!config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
                return (true, null, false);

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return (true, null, false);

            var jellyseerrUserId = await _seerrUserLookup.GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(jellyseerrUserId))
                return (true, null, false);

            var allowed = await GetAllowedRequestSetAsync(jellyseerrUserId, config);
            if (allowed == null || allowed.Count == 0)
                return (true, null, allowed == null);

            return (false, allowed, false);
        }

        /// <summary>
        /// The Seerr user's requested titles, read once per poll interval and shared by arr/queue and
        /// arr/history (the page polls both together) like the arr caches. A failed read is not kept.
        /// </summary>
        private async Task<HashSet<(int TmdbId, string MediaType)>?> GetAllowedRequestSetAsync(string jellyseerrUserId, PluginConfiguration config)
        {
            async Task<HashSet<(int TmdbId, string MediaType)>?> Read() =>
                (await GetJellyseerrRequestsForUser(jellyseerrUserId))?.Select(r => (r.TmdbId, r.MediaType)).ToHashSet();

            if (config.JellyseerrDisableCache)
                return await Read();

            Task<HashSet<(int TmdbId, string MediaType)>?> read;
            lock (_downloadsAllowedRequestsCacheLock)
            {
                if (!_downloadsAllowedRequestsCache.TryGetValue(jellyseerrUserId, out var cached) || DateTime.UtcNow - cached.CachedAt >= GetArrPollCacheTtl(config))
                {
                    cached = (Read(), DateTime.UtcNow);
                    _downloadsAllowedRequestsCache[jellyseerrUserId] = cached;
                }

                read = cached.Allowed;
            }

            var allowed = await read;
            if (allowed == null)
            {
                lock (_downloadsAllowedRequestsCacheLock)
                {
                    if (_downloadsAllowedRequestsCache.TryGetValue(jellyseerrUserId, out var cached) && cached.Allowed == read)
                        _downloadsAllowedRequestsCache.Remove(jellyseerrUserId);
                }
            }

            return allowed;
        }

        private ObjectResult SeerrRequestsUnavailable() => StatusCode(502, new
        {
            error = true,
            code = "seerr_requests_failed",
            message = "Could not read your Seerr requests to filter the downloads.",
        });

        private static TimeSpan GetArrPollCacheTtl(PluginConfiguration config)
        {
            return TimeSpan.FromSeconds(Math.Clamp(config.DownloadsPollIntervalSeconds, 5, 300));
        }

        private static List<object> FilterQueueItemsByAllowedRequests(List<object> items, HashSet<(int TmdbId, string MediaType)>? allowedRequests)
        {
            if (allowedRequests == null) return items;
            var filtered = new List<object>();
            foreach (dynamic item in items)
            {
                string mediaType = item.source == nameof(ArrType.Sonarr) ? "tv" : "movie";
                int? tmdbId = item.tmdbId;
                if (tmdbId.HasValue && allowedRequests.Contains((tmdbId.Value, mediaType)))
                    filtered.Add(item);
            }
            return filtered;
        }

        private static List<dynamic> FilterHistoryItemsByAllowedRequests(List<dynamic> items, HashSet<(int TmdbId, string MediaType)>? allowedRequests)
        {
            if (allowedRequests == null) return items;
            var filtered = new List<dynamic>();
            foreach (var item in items)
            {
                string mediaType = item.source == nameof(ArrType.Sonarr) ? "tv" : "movie";
                int? tmdbId = item.tmdbId;
                if (tmdbId.HasValue && allowedRequests.Contains((tmdbId.Value, mediaType)))
                    filtered.Add(item);
            }
            return filtered;
        }

        [HttpGet("arr/queue")]
        [Authorize]
        public async Task<IActionResult> GetDownloadQueue()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            var (blocked, allowedRequests, failed) = await GetAllowedRequestsForCurrentUserAsync(config);
            if (failed)
                return SeerrRequestsUnavailable();
            if (blocked)
                return Ok(new { items = new List<object>(), errors = new List<object>() });

            _arrInstanceClient.WarnIfArrInstancesCorrupt(config);
            var sonarrInstances = config.GetEnabledSonarrInstances();
            var radarrInstances = config.GetEnabledRadarrInstances();

            var ttl = GetArrPollCacheTtl(config);
            List<object>? rawItems = null;
            List<object>? errors = null;
            lock (_arrQueueCacheLock)
            {
                if (_arrQueueCache.HasValue && DateTime.UtcNow - _arrQueueCache.Value.CachedAt < ttl)
                {
                    rawItems = _arrQueueCache.Value.Items;
                    errors = _arrQueueCache.Value.Errors;
                }
            }

            if (rawItems == null || errors == null)
            {
                var ct = HttpContext.RequestAborted;
                var sonarrTasks = sonarrInstances.Select(i => FetchSonarrQueue(i, ct)).ToList();
                var radarrTasks = radarrInstances.Select(i => FetchRadarrQueue(i, ct)).ToList();

                var sonarrResults = await Task.WhenAll(sonarrTasks);
                var radarrResults = await Task.WhenAll(radarrTasks);

                rawItems = new List<object>();
                errors = new List<object>();
                if (config.IsSonarrInstancesCorrupt())
                    errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "config corrupt — see server logs" });
                else if (sonarrInstances.Count == 0 && config.GetSonarrInstances().Count > 0)
                    errors.Add(new { instanceName = "Sonarr", source = "Sonarr", reason = "all Sonarr instances are disabled" });
                if (config.IsRadarrInstancesCorrupt())
                    errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "config corrupt — see server logs" });
                else if (radarrInstances.Count == 0 && config.GetRadarrInstances().Count > 0)
                    errors.Add(new { instanceName = "Radarr", source = "Radarr", reason = "all Radarr instances are disabled" });
                for (int i = 0; i < sonarrResults.Length; i++)
                {
                    rawItems.AddRange(sonarrResults[i].Items);
                    if (sonarrResults[i].Error != null)
                        errors.Add(new { instanceName = sonarrInstances[i].Name, source = "Sonarr", reason = sonarrResults[i].Error });
                }
                for (int i = 0; i < radarrResults.Length; i++)
                {
                    rawItems.AddRange(radarrResults[i].Items);
                    if (radarrResults[i].Error != null)
                        errors.Add(new { instanceName = radarrInstances[i].Name, source = "Radarr", reason = radarrResults[i].Error });
                }

                lock (_arrQueueCacheLock)
                {
                    _arrQueueCache = (rawItems, errors, DateTime.UtcNow);
                }
            }

            var items = RedactDownloadRows(FilterQueueItemsByAllowedRequests(rawItems, allowedRequests));
            return Ok(new { items, errors });
        }

        /// <summary>
        /// Applies the caller's Spoiler Guard to Downloads rows. These come from caches
        /// shared between users, so a changed row is a copy and the cached ones stay whole.
        /// </summary>
        /// <param name="rows">The rows for this response.</param>
        /// <returns>The rows to send.</returns>
        private List<object> RedactDownloadRows(IEnumerable<object> rows)
        {
            var result = new List<object>();
            var guards = _spoilerSeerrRedactor.LoadRows(UserHelper.GetCurrentUserId(User)?.ToString(), HttpContext);
            foreach (var row in rows)
            {
                result.Add(guards == null ? row : RedactDownloadRow(row, guards));
            }

            return result;
        }

        private static object RedactDownloadRow(object row, Shared.SpoilerGuard.SpoilerSeerrRedactor.GuardedRows guards)
        {
            if (System.Text.Json.JsonSerializer.SerializeToNode(row, row.GetType()) is not System.Text.Json.Nodes.JsonObject copy)
            {
                return row;
            }

            var tmdbId = copy["tmdbId"]?.ToString();
            var changed = false;
            if (copy["source"]?.ToString() == nameof(ArrType.Radarr))
            {
                if (guards.ForTitle(false, tmdbId, null, null)?.HidePoster == true && copy["posterUrl"] != null)
                {
                    copy["posterUrl"] = null;
                    changed = true;
                }
            }
            else
            {
                // A season pack's row names no episode, so it has no " - title" to find.
                var subtitle = copy["subtitle"]?.ToString();
                var separator = subtitle?.IndexOf(" - ", StringComparison.Ordinal) ?? -1;
                if (separator > 0 && guards.HidesEpisodeTitle(tmdbId, copy["tvdbId"]?.ToString(), null, null, copy["episodeTvdbId"]?.ToString()))
                {
                    copy["subtitle"] = subtitle!.Substring(0, separator);
                    changed = true;
                }
            }

            return changed ? copy : row;
        }

        private static string? PosterFromImages(dynamic images)
        {
            if (images == null) return null;
            foreach (var img in images)
            {
                if ((string?)img.coverType == "poster")
                    return (string?)img.remoteUrl ?? (string?)img.url;
            }
            return null;
        }

        private Task<(List<object> Items, string? Error)> FetchSonarrQueue(ArrInstance instance, CancellationToken ct)
        {
            return _arrInstanceClient.FetchAndMapAsync<List<object>>(
                instance,
                "/api/v3/queue?includeEpisode=true&includeSeries=true&sortKey=timeleft&sortDirection=ascending&pageSize=1000",
                data =>
                {
                    var items = new List<object>();
                    if (data?.records == null) return items;
                    foreach (var record in data.records)
                    {
                        int? tmdbId = record.series?.tmdbId;

                        items.Add(new
                        {
                            id = (string?)record.id?.ToString(),
                            source = nameof(ArrType.Sonarr),
                            instanceName = instance.Name,
                            title = (string?)record.series?.title ?? "Unknown",
                            subtitle = $"S{record.episode?.seasonNumber:D2}E{record.episode?.episodeNumber:D2} - {record.episode?.title}",
                            tvdbId = (int?)record.series?.tvdbId,
                            episodeTvdbId = (int?)record.episode?.tvdbId,
                            seasonNumber = (int?)record.episode?.seasonNumber,
                            episodeNumber = (int?)record.episode?.episodeNumber,
                            status = ResolveQueueStatus((string?)record.status, (string?)record.trackedDownloadState, (string?)record.trackedDownloadStatus),
                            progress = CalculateProgress((double?)record.size, (double?)record.sizeleft),
                            totalSize = (long?)record.size,
                            sizeRemaining = (long?)record.sizeleft,
                            timeRemaining = (string?)record.timeleft,
                            posterUrl = PosterFromImages(record.series?.images),
                            tmdbId = tmdbId
                        });
                    }
                    return items;
                },
                emptyResult: new List<object>(),
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: "Sonarr queue",
                ct: ct);
        }

        private Task<(List<object> Items, string? Error)> FetchRadarrQueue(ArrInstance instance, CancellationToken ct)
        {
            return _arrInstanceClient.FetchAndMapAsync<List<object>>(
                instance,
                "/api/v3/queue?includeMovie=true&pageSize=1000",
                data =>
                {
                    var items = new List<object>();
                    if (data?.records == null) return items;
                    foreach (var record in data.records)
                    {
                        int? tmdbId = record.movie?.tmdbId;

                        items.Add(new
                        {
                            id = (string?)record.id?.ToString(),
                            source = nameof(ArrType.Radarr),
                            instanceName = instance.Name,
                            title = (string?)record.movie?.title ?? "Unknown",
                            subtitle = (string?)record.movie?.year?.ToString(),
                            seasonNumber = (int?)null,
                            episodeNumber = (int?)null,
                            status = ResolveQueueStatus((string?)record.status, (string?)record.trackedDownloadState, (string?)record.trackedDownloadStatus),
                            progress = CalculateProgress((double?)record.size, (double?)record.sizeleft),
                            totalSize = (long?)record.size,
                            sizeRemaining = (long?)record.sizeleft,
                            timeRemaining = (string?)record.timeleft,
                            posterUrl = PosterFromImages(record.movie?.images),
                            tmdbId = tmdbId
                        });
                    }
                    return items;
                },
                emptyResult: new List<object>(),
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: "Radarr queue",
                ct: ct);
        }

        private static double CalculateProgress(double? size, double? sizeleft)
        {
            if (size == null || size == 0) return 0;
            if (sizeleft == null) return 100;
            return Math.Round((1 - (sizeleft.Value / size.Value)) * 100, 1);
        }

        /// <summary>
        /// The Sonarr/Radarr queue "status" field (queued/downloading/paused/completed/...)
        /// only describes the transfer, not the import. Once the transfer finishes it sticks
        /// at "completed" even while Sonarr/Radarr is still importing (or stuck waiting for
        /// manual intervention). trackedDownloadState/trackedDownloadStatus carry that finer
        /// signal — this folds them in so the client sees "importing"/"warning"/"failed"
        /// instead of a frozen "completed".
        /// </summary>
        private static string ResolveQueueStatus(string? status, string? trackedDownloadState, string? trackedDownloadStatus)
        {
            if (string.Equals(trackedDownloadStatus, "warning", StringComparison.OrdinalIgnoreCase))
                return "warning";

            switch (trackedDownloadState?.ToLowerInvariant())
            {
                case "importpending":
                case "importing":
                    return "importing";
                case "failedpending":
                case "failed":
                    return "failed";
            }

            return status ?? "Unknown";
        }

        // History is intentionally a bounded window, not a full archive browser — pagination
        // is over this fixed-size merged/sorted pool, not the arr instances' entire history.
        private const int HistoryWindowSize = 200;

        [HttpGet("arr/history")]
        [Authorize]
        public async Task<IActionResult> GetDownloadHistory([FromQuery] int take = 20, [FromQuery] int skip = 0)
        {
            take = Math.Clamp(take, 1, 50);
            skip = Math.Max(0, skip);

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            if (!config.DownloadsShowHistory)
                return Ok(new { items = new List<object>(), totalPages = 0, visible = false });

            if (config.DownloadsHistoryAdminOnly && !IsAdminUser())
                return Ok(new { items = new List<object>(), totalPages = 0, visible = false });

            var (blocked, allowedRequests, failed) = await GetAllowedRequestsForCurrentUserAsync(config);
            if (failed)
                return SeerrRequestsUnavailable();
            if (blocked)
                return Ok(new { items = new List<object>(), totalPages = 0, visible = true });

            var sonarrInstances = config.GetEnabledSonarrInstances();
            var radarrInstances = config.GetEnabledRadarrInstances();

            var ttl = GetArrPollCacheTtl(config);
            List<dynamic>? rawItems = null;
            List<object>? errors = null;
            lock (_arrHistoryCacheLock)
            {
                if (_arrHistoryCache.HasValue && DateTime.UtcNow - _arrHistoryCache.Value.CachedAt < ttl)
                {
                    rawItems = _arrHistoryCache.Value.Items;
                    errors = _arrHistoryCache.Value.Errors;
                }
            }

            if (rawItems == null || errors == null)
            {
                var ct = HttpContext.RequestAborted;
                var sonarrTasks = sonarrInstances.Select(i => FetchSonarrHistory(i, ct)).ToList();
                var radarrTasks = radarrInstances.Select(i => FetchRadarrHistory(i, ct)).ToList();

                var sonarrResults = await Task.WhenAll(sonarrTasks);
                var radarrResults = await Task.WhenAll(radarrTasks);

                var merged = new List<dynamic>();
                errors = new List<object>();
                for (int i = 0; i < sonarrResults.Length; i++)
                {
                    merged.AddRange(sonarrResults[i].Items);
                    if (sonarrResults[i].Error != null)
                        errors.Add(new { instanceName = sonarrInstances[i].Name, source = "Sonarr", reason = sonarrResults[i].Error });
                }
                for (int i = 0; i < radarrResults.Length; i++)
                {
                    merged.AddRange(radarrResults[i].Items);
                    if (radarrResults[i].Error != null)
                        errors.Add(new { instanceName = radarrInstances[i].Name, source = "Radarr", reason = radarrResults[i].Error });
                }

                rawItems = merged
                    .OrderByDescending(i => (DateTime?)i.date ?? DateTime.MinValue)
                    .Take(HistoryWindowSize)
                    .ToList();

                lock (_arrHistoryCacheLock)
                {
                    _arrHistoryCache = (rawItems, errors, DateTime.UtcNow);
                }
            }

            var filtered = FilterHistoryItemsByAllowedRequests(rawItems, allowedRequests);
            var totalPages = filtered.Count == 0 ? 0 : (int)Math.Ceiling(filtered.Count / (double)take);
            var page = RedactDownloadRows(filtered.Skip(skip).Take(take));

            return Ok(new { items = page, totalPages, visible = true, errors });
        }

        private Task<(List<dynamic> Items, string? Error)> FetchSonarrHistory(ArrInstance instance, CancellationToken ct)
        {
            return _arrInstanceClient.FetchAndMapAsync<List<dynamic>>(
                instance,
                $"/api/v3/history?pageSize={HistoryWindowSize}&sortKey=date&sortDirection=descending&includeSeries=true&includeEpisode=true",
                data =>
                {
                    var entries = new List<(string Title, int? Season, int? Episode, int? TvdbId, string? EpisodeTitle, int? EpisodeTvdbId, string EventType, DateTime? Date, string? DownloadId, string? Poster, int? TmdbId)>();
                    if (data?.records == null) return new List<dynamic>();
                    foreach (var record in data.records)
                    {
                        string? eventType = MapHistoryEventType((string?)record.eventType);
                        if (eventType == null) continue;

                        entries.Add((
                            (string?)record.series?.title ?? "Unknown",
                            (int?)record.episode?.seasonNumber,
                            (int?)record.episode?.episodeNumber,
                            (int?)record.series?.tvdbId,
                            (string?)record.episode?.title,
                            (int?)record.episode?.tvdbId,
                            eventType,
                            (DateTime?)record.date,
                            (string?)record.downloadId,
                            PosterFromImages(record.series?.images),
                            (int?)record.series?.tmdbId
                        ));
                    }

                    // Sonarr emits one history record per episode, even for a single season-pack
                    // grab — group them back into one card by the shared downloadId so a partial
                    // import (some episodes imported, some failed) reads as one event, not N.
                    var items = new List<dynamic>();
                    var groups = entries
                        .Select((e, idx) => new { Entry = e, Key = string.IsNullOrEmpty(e.DownloadId) ? $"__single_{idx}" : e.DownloadId! })
                        .GroupBy(x => x.Key, x => x.Entry);

                    foreach (var group in groups)
                    {
                        var groupEntries = group.ToList();
                        var first = groupEntries[0];

                        if (groupEntries.Count == 1)
                        {
                            items.Add(new
                            {
                                source = nameof(ArrType.Sonarr),
                                instanceName = instance.Name,
                                title = first.Title,
                                subtitle = $"S{first.Season:D2}E{first.Episode:D2} - {first.EpisodeTitle}",
                                tvdbId = first.TvdbId,
                                episodeTvdbId = first.EpisodeTvdbId,
                                seasonNumber = first.Season,
                                episodeNumber = first.Episode,
                                eventType = first.EventType,
                                date = first.Date,
                                posterUrl = first.Poster,
                                tmdbId = first.TmdbId
                            });
                            continue;
                        }

                        var importedCount = groupEntries.Count(e => e.EventType == "imported");
                        var failedCount = groupEntries.Count(e => e.EventType == "failed");
                        var episodeNumbers = groupEntries.Where(e => e.Episode.HasValue).Select(e => e.Episode!.Value).OrderBy(n => n).ToList();
                        var groupDate = groupEntries.Where(e => e.Date.HasValue).Select(e => e.Date!.Value).DefaultIfEmpty(DateTime.MinValue).Max();

                        items.Add(new
                        {
                            source = nameof(ArrType.Sonarr),
                            instanceName = instance.Name,
                            title = first.Title,
                            subtitle = episodeNumbers.Count > 0
                                ? $"S{first.Season:D2} · E{episodeNumbers[0]:D2}-E{episodeNumbers[^1]:D2}"
                                : $"S{first.Season:D2}",
                            eventType = importedCount > 0 && failedCount > 0 ? "partial" : (failedCount > 0 ? "failed" : "imported"),
                            date = (DateTime?)groupDate,
                            posterUrl = first.Poster,
                            tmdbId = first.TmdbId,
                            episodeCount = groupEntries.Count,
                            importedCount = importedCount,
                            failedCount = failedCount
                        });
                    }
                    return items;
                },
                emptyResult: new List<dynamic>(),
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: "Sonarr history",
                ct: ct);
        }

        private Task<(List<dynamic> Items, string? Error)> FetchRadarrHistory(ArrInstance instance, CancellationToken ct)
        {
            return _arrInstanceClient.FetchAndMapAsync<List<dynamic>>(
                instance,
                $"/api/v3/history?pageSize={HistoryWindowSize}&sortKey=date&sortDirection=descending&includeMovie=true",
                data =>
                {
                    var items = new List<dynamic>();
                    if (data?.records == null) return items;
                    foreach (var record in data.records)
                    {
                        string? eventType = MapHistoryEventType((string?)record.eventType);
                        if (eventType == null) continue;

                        items.Add(new
                        {
                            source = nameof(ArrType.Radarr),
                            instanceName = instance.Name,
                            title = (string?)record.movie?.title ?? "Unknown",
                            subtitle = (string?)record.movie?.year?.ToString(),
                            eventType = eventType,
                            date = (DateTime?)record.date,
                            posterUrl = PosterFromImages(record.movie?.images),
                            tmdbId = (int?)record.movie?.tmdbId
                        });
                    }
                    return items;
                },
                emptyResult: new List<dynamic>(),
                timeout: TimeSpan.FromSeconds(10),
                contextLabel: "Radarr history",
                ct: ct);
        }

        /// <summary>
        /// Only the two terminal, user-relevant history events are surfaced — everything else
        /// (grabbed, renamed, deleted, ignored, ...) is noise for a "recently downloaded" list.
        /// </summary>
        private static string? MapHistoryEventType(string? eventType)
        {
            return eventType?.ToLowerInvariant() switch
            {
                "downloadfolderimported" => "imported",
                "downloadfailed" => "failed",
                _ => null,
            };
        }
    }
}
