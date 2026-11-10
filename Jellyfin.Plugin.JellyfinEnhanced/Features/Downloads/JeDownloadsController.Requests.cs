using System.Collections.Concurrent;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Newtonsoft.Json.Linq;
using static Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr.SeerrCaches;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Downloads
{
    public partial class JeDownloadsController
    {
        [HttpGet("arr/requests")]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Authorize]
        public async Task<IActionResult> GetRequests([FromQuery] int take = 20, [FromQuery] int skip = 0, [FromQuery] string? filter = null, [FromQuery] bool userOnly = false)
        {
            take = Math.Clamp(take, 1, 200);
            skip = Math.Max(0, skip);

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            if (string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
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
                var client = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
                client.Timeout = TimeSpan.FromSeconds(15);
                bool hasRequestViewPermission = false;

                var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();

                if (string.IsNullOrEmpty(jellyfinUserId))
                {
                    _logger.Warning("Could not find Jellyfin User ID in claims.");
                    return BadRequest(new { message = "Jellyfin User ID was not provided in claims." });
                }

                var jellyseerrUser = await _seerrUserLookup.GetJellyseerrUser(jellyfinUserId);

                if (jellyseerrUser == null)
                {
                    _logger.Warning($"Could not find a Seerr user for Jellyfin user {_userDisplayResolver.ResolveUserDisplay(jellyfinUserId)}. Aborting request.");
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
                Shared.Seerr.SeerrError? lastError = null;
                foreach (var candidateUrl in allUrls)
                {
                    var requestsUri = $"{candidateUrl}/api/v1/request?take={seerrTake}&skip={seerrSkip}{filterParam}";
                    try
                    {
                        using var requestsRequest = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestsUri, config.JellyseerrApiKey);
                        using var response = await client.SendAsync(requestsRequest);
                        var (urlJson, urlError) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestsUri);
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
                        lastError = new Shared.Seerr.SeerrError
                        {
                            Code = Shared.Seerr.SeerrErrorCode.Unreachable,
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
                        Shared.Seerr.SeerrErrorCode.HtmlResponse => 502,
                        Shared.Seerr.SeerrErrorCode.UpstreamRedirect => 502,
                        Shared.Seerr.SeerrErrorCode.Cloudflare5xx => 502,
                        _ => error.HttpStatus > 0 ? error.HttpStatus : 502,
                    };
                    return StatusCode(httpCode, new
                    {
                        error = true,
                        code = error.Code.ToString(),
                        cfRay = error.CfRay,
                        message = IsAdminUser() ? error.Message : Shared.Seerr.SeerrError.SanitizeMessage(error.Message),
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
                    // Enrich all requests in parallel for better performance
                    // Resolved here because the rows below are built in parallel.
                    var spoilerRows = _spoilerSeerrRedactor.LoadRows(UserHelper.GetCurrentUserId(User)?.ToString(), HttpContext);
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
                            var enrichedData = await EnrichWithTmdbData(client, tmdbId.Value, type, jellyseerrUrl!, config.JellyseerrApiKey);
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
                            && await IsMissingFromArrAsync(type, tmdbId, tvdbId, requestAborted);

                        // Worked out before the dates go, as the Coming Soon filter reads it.
                        var isComingSoon = IsComingSoonRequest(mediaStatus, type, nextAirDate, digitalReleaseDate, theatricalReleaseDate);
                        var spoilerPolicy = spoilerRows?.ForTitle(
                            type == "tv",
                            tmdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                            tvdbId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                            media?["jellyfinMediaId"]?.Value<string>(),
                            media?["jellyfinMediaId4k"]?.Value<string>());
                        if (spoilerPolicy?.HideDates == true)
                        {
                            digitalReleaseDate = null;
                            theatricalReleaseDate = null;
                            initialAirDate = null;
                            nextAirDate = null;
                        }

                        if (spoilerPolicy?.HidePoster == true) posterUrl = null;

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
                            jellyfinMediaId = media?["jellyfinMediaId"]?.Value<string>(),
                            digitalReleaseDate = digitalReleaseDate,
                            theatricalReleaseDate = theatricalReleaseDate,
                            initialAirDate = initialAirDate,
                            nextAirDate = nextAirDate,
                            isComingSoon = isComingSoon,
                            isOrphaned = isOrphaned
                        };
                    }).ToList();

                    var enrichedRequests = await Task.WhenAll(enrichmentTasks);

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
                                if (r.type == "tv" && !string.IsNullOrEmpty(r.nextAirDate) && IsoDates.TryParseIso(r.nextAirDate) is DateTime airDate && airDate.Date > today)
                                {
                                    bestDate = airDate;
                                }
                                else
                                {
                                    // For movies, use digital or theatrical date
                                    if (!string.IsNullOrEmpty(r.digitalReleaseDate) && IsoDates.TryParseIso(r.digitalReleaseDate) is DateTime dd && dd.Date > today)
                                        bestDate = dd;
                                    if (!string.IsNullOrEmpty(r.theatricalReleaseDate) && IsoDates.TryParseIso(r.theatricalReleaseDate) is DateTime td && td.Date > today)
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

                return Ok(new
                {
                    requests = requests,
                    totalPages = totalPages,
                    totalResults = totalResults,
                    canApproveRequests = canApproveRequests
                });
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

        private static readonly ConcurrentDictionary<string, (bool Missing, DateTime Expires)> OrphanCheckCache = new();

        // True only when every enabled Radarr/Sonarr instance answered and none has the title.
        private async Task<bool> IsMissingFromArrAsync(string? type, int? tmdbId, int? tvdbId, CancellationToken ct)
        {
            var isTv = type == "tv";
            var id = isTv ? tvdbId : tmdbId;
            if (!id.HasValue || id <= 0) return false;

            var key = $"{(isTv ? "tv" : "movie")}:{id}";
            if (OrphanCheckCache.TryGetValue(key, out var cached) && cached.Expires > DateTime.UtcNow) return cached.Missing;

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null) return false;
            var instances = isTv ? config.GetEnabledSonarrInstances() : config.GetEnabledRadarrInstances();
            if (instances.Count == 0) return false;

            var outcomes = await Task.WhenAll(instances.Select(i => isTv
                ? _arrInstanceClient.FetchSeriesInfoFromInstance(i, id.Value, ct)
                : _arrInstanceClient.FetchMovieInfoFromInstance(i, id.Value, ct)));
            var missing = outcomes.All(o => o.Error == null && o.Match == null);
            OrphanCheckCache[key] = (missing, DateTime.UtcNow.AddMinutes(5));
            return missing;
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
            static bool IsFuture(string? value, DateTime day) => IsoDates.TryParseIso(value) is DateTime date && date.Date > day;

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
            if (config == null || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
                return StatusCode(503, new { error = true, message = "Seerr not configured." });

            var jellyfinUserId = UserHelper.GetCurrentUserId(User)?.ToString();
            if (string.IsNullOrEmpty(jellyfinUserId))
                return BadRequest(new { message = "Jellyfin User ID not found." });

            var jellyseerrUser = await _seerrUserLookup.GetJellyseerrUser(jellyfinUserId);
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
            var client = Shared.Seerr.SeerrHttpHelper.CreateClient(_httpClientFactory);
            using var httpRequest = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                HttpMethod.Post, requestUri, config.JellyseerrApiKey, jellyseerrUser.Id.ToString());
            using var response = await client.SendAsync(httpRequest);
            var (_, error) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

            if (error != null)
            {
                _logger.Warning($"Seerr {action} request {requestId} failed: {error.Code} {error.HttpStatus}");
                return StatusCode(error.HttpStatus > 0 ? error.HttpStatus : 502,
                    IsAdminUser() ? error.ToAdminResponseShape() : error.ToResponseShape());
            }

            return Ok(new { success = true });
        }

        private async Task<(string? Title, int? Year, string? PosterUrl, string? DigitalReleaseDate, string? TheatricalReleaseDate, string? InitialAirDate, string? NextAirDate)> EnrichWithTmdbData(HttpClient client, int tmdbId, string type, string jellyseerrUrl, string apiKey)
        {
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
                    using var enrichRequest = Shared.Seerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, enrichUri, apiKey);
                    using var response = await client.SendAsync(enrichRequest);
                    var (content, enrichError) = await Shared.Seerr.SeerrHttpHelper.ReadResponseAsync(response, enrichUri);

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
                var fetchTask = _tmdbEnrichmentInFlight.GetOrAdd(cacheKey, _ => FetchEnrichmentAsync());
                try
                {
                    result = await fetchTask;
                }
                finally
                {
                    _tmdbEnrichmentInFlight.TryRemove(cacheKey, out _);
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
                        _tmdbEnrichmentCache[cacheKey] = (result!, DateTime.UtcNow);

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
    }
}
