using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class AutoSeasonRequestService
    {
        /// <summary>The recipe name in the request ledger and the automation log.</summary>
        public const string Recipe = "auto_season";

        private readonly AutoRequestRecorder? _recorder;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;

        // In-memory cache of recently requested seasons to avoid duplicates (keyed by tmdbId_seasonNumber, global across all users)
        private readonly Dictionary<string, DateTime> _requestedSeasons = new();
        private readonly object _requestCacheLock = new();
        private readonly Dictionary<string, (string JellyseerrUserId, DateTime CachedAt)> _jellyseerrUserIdCache = new();
        private readonly object _userIdCacheLock = new();
        private readonly Dictionary<string, (string Content, DateTime CachedAt)> _seriesDetailsCache = new();
        private readonly object _seriesDetailsCacheLock = new();
        private readonly ConcurrentDictionary<string, Task<string?>> _seriesDetailsInFlight = new();

        public AutoSeasonRequestService(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager)
            : this(httpClientFactory, logger, userManager, userDataManager, libraryManager, null)
        {
        }

        /// <summary>Creates the service; with phase 3 on, decisions become wants through <paramref name="recorder"/>.</summary>
        public AutoSeasonRequestService(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            AutoRequestRecorder? recorder)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _recorder = recorder;
        }

        /// <summary>True when the decision goes to the request ledger (phase 3 on and a recorder available).</summary>
        internal bool LedgerMode(PluginConfiguration? config) => _recorder != null && AutoRequestRecorder.Active(config);

        private static bool SeerrConfigured(PluginConfiguration? config)
            => config != null && config.JellyseerrEnabled && !string.IsNullOrEmpty(config.JellyseerrUrls) && !string.IsNullOrEmpty(config.GetJellyseerrApiKey());

        // Series details come from Seerr (TMDB data); in JE mode without Seerr, from TMDB itself.
        private bool TmdbDetails(PluginConfiguration? config)
            => config != null && !SeerrConfigured(config) && LedgerMode(config) && !string.IsNullOrEmpty(config.GetTmdbApiKey());

        private static string[] GetConfiguredUrls(string? urls)
        {
            return (urls ?? string.Empty)
                .Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(url => url.Trim().TrimEnd('/'))
                .Where(url => !string.IsNullOrWhiteSpace(url))
                .ToArray();
        }

        private static string NormalizeUserId(string userId)
        {
            return userId.Replace("-", string.Empty).ToLowerInvariant();
        }

        private static TimeSpan GetJellyseerrUserIdCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrUserIdCacheTtlMinutes ?? 30;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        private static TimeSpan GetSeriesDetailsCacheTtl()
        {
            var minutes = JellyfinEnhanced.Instance?.Configuration?.JellyseerrResponseCacheTtlMinutes ?? 10;
            return TimeSpan.FromMinutes(Math.Max(1, minutes));
        }

        private async Task<string?> GetSeriesDetailsJsonAsync(string tmdbId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || (!SeerrConfigured(config) && !TmdbDetails(config)))
            {
                return null;
            }

            var cacheKey = tmdbId;
            var cacheTtl = GetSeriesDetailsCacheTtl();
            var cacheEnabled = !config.JellyseerrDisableCache;

            if (cacheEnabled)
            {
                lock (_seriesDetailsCacheLock)
                {
                    if (_seriesDetailsCache.TryGetValue(cacheKey, out var cached) &&
                        DateTime.UtcNow - cached.CachedAt < cacheTtl)
                    {
                        return cached.Content;
                    }
                }
            }

            async Task<string?> FetchAsync()
            {
                if (TmdbDetails(config)) return await FetchTmdbDetailsAsync(tmdbId, config.GetTmdbApiKey());
                var urls = GetConfiguredUrls(config.JellyseerrUrls);
                var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                foreach (var url in urls)
                {
                    try
                    {
                        var requestUrl = $"{url}/api/v1/tv/{tmdbId}";
                        using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestUrl, config.GetJellyseerrApiKey());
                        using var response = await httpClient.SendAsync(request);
                        var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUrl);
                        if (error != null)
                        {
                            _logger.Debug($"[Auto-Season-Request] Series details fetch for TMDB {tmdbId} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                            continue;
                        }

                        return content;
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Auto-Season-Request] Error checking Jellyseerr at {url}: {ex.Message}");
                    }
                }

                return null;
            }

            string? content;
            if (cacheEnabled)
            {
                var task = _seriesDetailsInFlight.GetOrAdd(cacheKey, _ => FetchAsync());
                try
                {
                    content = await task;
                }
                finally
                {
                    _seriesDetailsInFlight.TryRemove(cacheKey, out _);
                }

                if (!string.IsNullOrEmpty(content))
                {
                    lock (_seriesDetailsCacheLock)
                    {
                        _seriesDetailsCache[cacheKey] = (content, DateTime.UtcNow);
                    }
                }
            }
            else
            {
                content = await FetchAsync();
            }

            return content;
        }

        // TMDB's series details in the shape the season checks read from Seerr (seasonNumber, episodeCount).
        private async Task<string?> FetchTmdbDetailsAsync(string tmdbId, string apiKey)
        {
            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                using var response = await httpClient.GetAsync($"https://api.themoviedb.org/3/tv/{tmdbId}?api_key={apiKey}");
                if (!response.IsSuccessStatusCode)
                {
                    _logger.Debug($"[Auto-Season-Request] TMDB returned {response.StatusCode} for series {tmdbId}");
                    return null;
                }
                using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                var root = doc.RootElement;
                var seasons = new List<object>();
                if (root.TryGetProperty("seasons", out var list) && list.ValueKind == JsonValueKind.Array)
                {
                    foreach (var season in list.EnumerateArray())
                    {
                        if (season.TryGetProperty("season_number", out var n) && n.TryGetInt32(out var number) &&
                            season.TryGetProperty("episode_count", out var c) && c.TryGetInt32(out var count))
                            seasons.Add(new { seasonNumber = number, episodeCount = count });
                    }
                }
                var total = root.TryGetProperty("number_of_seasons", out var t) && t.TryGetInt32(out var totalSeasons) ? totalSeasons : seasons.Count;
                return JsonSerializer.Serialize(new { numberOfSeasons = total, seasons });
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Auto-Season-Request] Error reading TMDB series {tmdbId}: {ex.Message}");
                return null;
            }
        }

        // Checks a completed episode to determine if next season should be requested.
        // Event-driven entry point called when a user finishes or starts watching an episode.
        // The outcome is typed: a failed details lookup is a PreparationFailed, never "nothing to do".
        public async Task<AutoRequestOutcome> CheckEpisodeCompletionAsync(BaseItem episodeItem, Guid userId, CancellationToken ct = default)
        {
            // Phase 3 turned on while a direct Seerr send was being prepared: the check starts again and goes through the
            // ledger under the rules in effect now (modes, kills, consent, budgets) instead of POSTing. A switch flipped
            // back and forth leaves it to the next trigger.
            for (var attempt = 0; attempt < 3; attempt++)
            {
                if (await CheckOnceAsync(episodeItem, userId, ct) is { } outcome) return outcome;
            }
            return AutoRequestOutcome.Failed(AutomationHolds.EngineChanged);
        }

        // Why a direct Seerr POST (phase 3 off) may not go now, read from the live configuration (an administrator's save
        // replaces it) right before the request and again right before each POST: the rollout Shadow override; phase 3 on
        // since the check began (the decision now belongs to the ledger, see EngineChanged); the recipe or Seerr turned
        // off. Null: it may go.
        private string? DirectStop()
        {
            var live = JellyfinEnhanced.Instance?.Configuration;
            // The recipe switched off comes first: nothing is sent or recorded, not even a Shadow decision.
            if (live is not { AutoSeasonRequestEnabled: true }) return "disabled";
            if (AutomationFlags.ShadowOverride(live)) return AutomationHolds.ShadowOverride;
            if (LedgerMode(live)) return AutomationHolds.EngineChanged;
            return live.JellyseerrEnabled ? null : "disabled";
        }

        // One check; null when the direct path stopped for phase 3 and the check has to start again.
        private async Task<AutoRequestOutcome?> CheckOnceAsync(BaseItem episodeItem, Guid userId, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var ledger = LedgerMode(config);
            if (config == null || !config.AutoSeasonRequestEnabled || (!ledger && !config.JellyseerrEnabled))
            {
                return AutoRequestOutcome.Noop("disabled");
            }

            if (ledger && config.ArrRequestBackend == "status_only")
            {
                return AutoRequestOutcome.Noop("requests_off");
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return AutoRequestOutcome.Noop("user_required");
            }

            // Get the series this episode belongs to
            var episode = episodeItem as Episode;
            if (episode == null || episode.Series == null || !episode.ParentIndexNumber.HasValue || !episode.IndexNumber.HasValue)
            {
                return AutoRequestOutcome.Noop("not_an_episode");
            }

            var series = episode.Series;
            var seasonNumber = episode.ParentIndexNumber.Value;
            var episodeNumber = episode.IndexNumber.Value;

            _logger.Info($"[Auto-Season-Request] Checking '{series.Name}' S{seasonNumber}E{episodeNumber}");

            // Check this specific season for auto-season-request, passing the current episode number
            return await CheckSeasonForAutoRequest(series, seasonNumber, episodeNumber, user, ledger, ct);
        }

        // Checks if a specific season needs its next season requested
        private async Task<AutoRequestOutcome?> CheckSeasonForAutoRequest(Series series, int currentSeasonNumber, int currentEpisodeNumber, JUser user, bool ledger, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return AutoRequestOutcome.Noop("disabled");
            }

            // Get TMDB ID first - we'll need it for Jellyseerr checks
            var tmdbId = GetTmdbId(series);
            if (string.IsNullOrEmpty(tmdbId))
            {
                _logger.Warning($"[Auto-Season-Request] Could not find TMDB ID for series '{series.Name}'");
                return AutoRequestOutcome.Noop("no_tmdb_id");
            }

            if (ledger && !SeerrConfigured(config) && !TmdbDetails(config))
            {
                return AutoRequestOutcome.Noop("not_configured");
            }

            // Get the total episode count for this season from TMDB/Jellyseerr
            var (totalEpisodesInSeason, detailsFailed) = await GetTotalEpisodesInSeasonFromTmdb(tmdbId, currentSeasonNumber);
            if (detailsFailed)
            {
                _logger.Warning($"[Auto-Season-Request] Could not read the series details for '{series.Name}'; will try again shortly");
                return AutoRequestOutcome.Failed("details_unavailable");
            }
            if (totalEpisodesInSeason == null || totalEpisodesInSeason <= 0)
            {
                _logger.Warning($"[Auto-Season-Request] Could not determine total episodes for '{series.Name}' S{currentSeasonNumber} from TMDB");
                return AutoRequestOutcome.Noop("season_unknown");
            }

            // Calculate remaining episodes based on current episode position and TMDB total
            // If watching E8 out of 15 total episodes, remaining = 15 - 8 = 7 episodes left
            var remainingAfterCurrent = totalEpisodesInSeason.Value - currentEpisodeNumber;
            if (remainingAfterCurrent < 0) remainingAfterCurrent = 0;

            // Query episodes in Jellyfin for "require all watched" check if needed
            var availableEpisodesInJellyfin = 0;
            List<Episode> allEpisodes = new List<Episode>();

            if (config.AutoSeasonRequestRequireAllWatched)
            {
                var episodesQuery = new InternalItemsQuery(user)
                {
                    AncestorIds = new[] { series.Id },
                    IncludeItemTypes = new[] { BaseItemKind.Episode },
                    Recursive = true,
                    OrderBy = new[] { (ItemSortBy.ParentIndexNumber, JSortOrder.Ascending), (ItemSortBy.IndexNumber, JSortOrder.Ascending) }
                };

                allEpisodes = _libraryManager.GetItemsResult(episodesQuery).Items
                    .OfType<Episode>()
                    .Where(e => e.ParentIndexNumber == currentSeasonNumber)
                    .OrderBy(e => e.IndexNumber)
                    .ToList();

                availableEpisodesInJellyfin = allEpisodes.Count;
            }

            // Jellyfin's episodes are only counted for the "require all watched" check.
            var inJellyfin = config.AutoSeasonRequestRequireAllWatched ? $", {availableEpisodesInJellyfin} in Jellyfin" : string.Empty;
            _logger.Info($"[Auto-Season-Request] Season {currentSeasonNumber}: E{currentEpisodeNumber}/{totalEpisodesInSeason} (TMDB total){inJellyfin}, {remainingAfterCurrent} episodes remaining after current (threshold: {config.AutoSeasonRequestThresholdValue})");

            // Check if threshold is met
            bool thresholdMet = remainingAfterCurrent <= config.AutoSeasonRequestThresholdValue;

            if (!thresholdMet)
            {
                _logger.Debug($"[Auto-Season-Request] Threshold not met for '{series.Name}' S{currentSeasonNumber}");
                return AutoRequestOutcome.Noop("threshold_not_met");
            }

            // If "Require All Episodes Watched" is enabled, verify all episodes before the threshold are watched
            bool shouldRequest = true;
            if (config.AutoSeasonRequestRequireAllWatched)
            {
                // Check that all episodes before the current one are marked as watched
                var episodesBeforeCurrent = allEpisodes.Where(e => e.IndexNumber.HasValue && e.IndexNumber.Value < currentEpisodeNumber).ToList();
                var unwatchedBeforeCurrent = episodesBeforeCurrent.Where(e =>
                {
                    var userData = _userDataManager.GetUserData(user, e);
                    return userData == null || !userData.Played;
                }).ToList();

                if (unwatchedBeforeCurrent.Any())
                {
                    shouldRequest = false;
                    var unwatchedEpisodeNumbers = string.Join(", ", unwatchedBeforeCurrent.Select(e => $"E{e.IndexNumber}"));
                    _logger.Debug($"[Auto-Season-Request] Threshold met but not all prior episodes watched for '{series.Name}' S{currentSeasonNumber}. Unwatched: {unwatchedEpisodeNumbers}");
                }
                else
                {
                    _logger.Info($"[Auto-Season-Request] Threshold met and all prior episodes watched for '{series.Name}' S{currentSeasonNumber} - requesting next season");
                }
            }

            if (!shouldRequest)
            {
                return AutoRequestOutcome.Noop("earlier_episodes_unwatched");
            }

            // Threshold met - prepare to request next season
            var nextSeasonNumber = currentSeasonNumber + 1;
            var seriesKey = TitleKey.ForSeries(series.ProviderIds.GetValueOrDefault("Tvdb"), tmdbId, series.ProviderIds.GetValueOrDefault("Imdb"));
            if (ledger)
            {
                return await RecordNextSeasonAsync(series, tmdbId, seriesKey, nextSeasonNumber, user, ct);
            }

            // Check in-memory cache first (fast path to avoid redundant API calls)
            // Uses a sentinel pattern: write the entry before async work so concurrent
            // callers see it immediately, then remove on failure to allow retries.
            var cacheKey = $"{tmdbId}_S{nextSeasonNumber}";
            lock (_requestCacheLock)
            {
                // Clean up expired entries
                var expiredKeys = _requestedSeasons.Where(kvp => (DateTime.Now - kvp.Value).TotalHours > 1)
                    .Select(kvp => kvp.Key).ToList();
                foreach (var key in expiredKeys) _requestedSeasons.Remove(key);

                if (_requestedSeasons.ContainsKey(cacheKey))
                {
                    _logger.Debug($"[Auto-Season-Request] Already requested S{nextSeasonNumber} for TMDB {tmdbId} (cached)");
                    return AutoRequestOutcome.Noop("already_requested", seriesKey?.ToString());
                }

                // Reserve the slot so concurrent callers see it immediately
                _requestedSeasons[cacheKey] = DateTime.Now;
            }

            // Get episode count for next season to verify it has started
            var (nextSeasonEpisodeCount, nextFailed) = await GetTotalEpisodesInSeasonFromTmdb(tmdbId, nextSeasonNumber);

            if (nextFailed || nextSeasonEpisodeCount == null || nextSeasonEpisodeCount <= 0)
            {
                if (!nextFailed) _logger.Info($"[Auto-Season-Request] Season {nextSeasonNumber} has not started yet (0 episodes) - not requesting");
                // drop the sentinel so the next check actually
                // re-evaluates instead of being stuck for an hour even after
                // TMDB updates with the new season's data.
                lock (_requestCacheLock)
                {
                    _requestedSeasons.Remove(cacheKey);
                }
                return nextFailed ? AutoRequestOutcome.Failed("details_unavailable") : AutoRequestOutcome.Noop("next_season_not_started", seriesKey?.ToString());
            }

            // Check Jellyseerr for season availability/status - always query to get latest status
            var (jellyseerrStatus, statusFailed) = await GetSeasonStatusFromJellyseerr(tmdbId, nextSeasonNumber);

            if (jellyseerrStatus == null)
            {
                if (!statusFailed) _logger.Debug($"[Auto-Season-Request] Season {nextSeasonNumber} does not exist for '{series.Name}' (not available on TMDB)");
                lock (_requestCacheLock)
                {
                    _requestedSeasons.Remove(cacheKey);
                }
                return statusFailed ? AutoRequestOutcome.Failed("seerr_unavailable") : AutoRequestOutcome.Noop("next_season_unknown", seriesKey?.ToString());
            }

            if (jellyseerrStatus.IsAvailable)
            {
                _logger.Debug($"[Auto-Season-Request] Season {nextSeasonNumber} already available on Jellyfin for '{series.Name}'");
                return AutoRequestOutcome.Noop("already_available", seriesKey?.ToString());
            }

            if (jellyseerrStatus.IsRequested)
            {
                _logger.Debug($"[Auto-Season-Request] Season {nextSeasonNumber} already requested in Jellyseerr for '{series.Name}'");
                return AutoRequestOutcome.Noop("already_requested", seriesKey?.ToString());
            }

            // Stopped before a POST (see DirectStop), here or right before every POST: with the rollout Shadow override,
            // what would have been asked is recorded and nothing is sent; with phase 3 now on, the check starts again.
            AutoRequestOutcome? Stopped(string stop)
            {
                lock (_requestCacheLock)
                {
                    _requestedSeasons.Remove(cacheKey);
                }
                if (stop == AutomationHolds.EngineChanged)
                {
                    _logger.Info($"[Auto-Season-Request] Phase 3 was turned on before '{series.Name}' S{nextSeasonNumber} was sent to Seerr; checking again under the current rules");
                    return null;
                }
                if (stop != AutomationHolds.ShadowOverride)
                {
                    _logger.Info($"[Auto-Season-Request] '{series.Name}' S{nextSeasonNumber} not sent to Seerr: the recipe or Seerr was turned off since the check began");
                    return AutoRequestOutcome.Noop(stop, seriesKey?.ToString());
                }
                _recorder?.ShadowOverride(Recipe, user.Id, seriesKey?.ToString(), nextSeasonNumber);
                _logger.Info($"[Auto-Season-Request] Shadow override: would have requested '{series.Name}' S{nextSeasonNumber} for {user.Username}; nothing sent");
                return AutoRequestOutcome.Noop(AutomationHolds.ShadowOverride, seriesKey?.ToString());
            }

            if (DirectStop() is { } early)
            {
                return Stopped(early);
            }

            // Season exists, not available, not requested - proceed with request
            var (sent, stop) = await RequestNextSeason(tmdbId, nextSeasonNumber, user.Id.ToString());
            if (stop != null)
            {
                return Stopped(stop);
            }

            if (sent)
            {
                _logger.Info($"[Auto-Season-Request] ✓ Requested '{series.Name}' S{nextSeasonNumber} (TMDB: {tmdbId}) for {user.Username}");
                return AutoRequestOutcome.Recorded("seerr_request", seriesKey?.ToString());
            }

            // Remove sentinel so a future attempt can retry
            lock (_requestCacheLock)
            {
                _requestedSeasons.Remove(cacheKey);
            }
            _logger.Warning($"[Auto-Season-Request] ✗ Failed to request '{series.Name}' S{nextSeasonNumber} for {user.Username}");
            return AutoRequestOutcome.Failed("seerr_request_failed", seriesKey?.ToString());
        }

        // Phase 3: the next season becomes a want in the request ledger, after the same checks (it has
        // started; not already there or asked for) answered from Seerr, or from TMDB and Jellyfin's library.
        private async Task<AutoRequestOutcome> RecordNextSeasonAsync(Series series, string tmdbId, TitleKey? seriesKey, int nextSeasonNumber, JUser user, CancellationToken ct)
        {
            if (seriesKey == null) return AutoRequestOutcome.Noop("no_tmdb_id");
            var (nextCount, nextFailed) = await GetTotalEpisodesInSeasonFromTmdb(tmdbId, nextSeasonNumber);
            if (nextFailed) return AutoRequestOutcome.Failed("details_unavailable", seriesKey.ToString());
            if (nextCount == null || nextCount <= 0)
            {
                _logger.Info($"[Auto-Season-Request] Season {nextSeasonNumber} has not started yet (0 episodes) - not requesting");
                return AutoRequestOutcome.Noop("next_season_not_started", seriesKey.ToString());
            }
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (SeerrConfigured(config))
            {
                var (status, statusFailed) = await GetSeasonStatusFromJellyseerr(tmdbId, nextSeasonNumber);
                if (statusFailed) return AutoRequestOutcome.Failed("seerr_unavailable", seriesKey.ToString());
                if (status == null) return AutoRequestOutcome.Noop("next_season_unknown", seriesKey.ToString());
                if (status.IsAvailable) return AutoRequestOutcome.Noop("already_available", seriesKey.ToString());
            }
            if (_recorder!.EpisodesInLibrary(seriesKey, nextSeasonNumber, user.Id) >= nextCount)
            {
                return AutoRequestOutcome.Noop("already_available", seriesKey.ToString());
            }
            var input = new MutationInput { Key = seriesKey.ToString(), Scope = "seasons", Seasons = new[] { nextSeasonNumber } };
            var recorded = await _recorder.RecordAsync(Recipe, user.Id, input, ct);
            _logger.Info($"[Auto-Season-Request] '{series.Name}' S{nextSeasonNumber} for {user.Username}: {recorded.Code} ({recorded.Reason})");
            return recorded;
        }

        // Gets the total number of episodes in a season from TMDB (through Seerr, or TMDB itself in JE mode
        // without Seerr). Failed when the details couldn't be read; a null count means the season isn't listed.
        private async Task<(int? Count, bool Failed)> GetTotalEpisodesInSeasonFromTmdb(string tmdbId, int seasonNumber)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || (!SeerrConfigured(config) && !TmdbDetails(config)))
            {
                return (null, true);
            }

            try
            {
                var content = await GetSeriesDetailsJsonAsync(tmdbId);
                if (string.IsNullOrEmpty(content))
                {
                    return (null, true);
                }

                using (JsonDocument doc = JsonDocument.Parse(content))
                {
                    var root = doc.RootElement;

                    if (root.TryGetProperty("numberOfSeasons", out var totalSeasonsProp))
                    {
                        var totalSeasons = totalSeasonsProp.GetInt32();
                        _logger.Info($"[Auto-Season-Request] TMDB reports {totalSeasons} total seasons for TMDB ID {tmdbId}");
                    }

                    if (root.TryGetProperty("seasons", out var seasonsArray))
                    {
                        foreach (var season in seasonsArray.EnumerateArray())
                        {
                            if (season.TryGetProperty("seasonNumber", out var seasonNumProp) &&
                                seasonNumProp.GetInt32() == seasonNumber &&
                                season.TryGetProperty("episodeCount", out var episodeCountProp))
                            {
                                var episodeCount = episodeCountProp.GetInt32();
                                _logger.Info($"[Auto-Season-Request] TMDB reports {episodeCount} episodes in season {seasonNumber}");
                                return (episodeCount, false);
                            }
                        }
                    }
                }

                _logger.Info($"[Auto-Season-Request] Season {seasonNumber} not found in TMDB data (season does not exist on TMDB)");
                return (null, false);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Season-Request] Error querying TMDB episode count: {ex.Message}");
            }

            return (null, true);
        }

        // Jellyseerr season status
        private class SeasonStatus
        {
            public bool IsAvailable { get; set; }
            public bool IsRequested { get; set; }
        }

        // Gets season status from Jellyseerr - always fetches fresh to ensure accurate request/availability state
        private async Task<(SeasonStatus? Status, bool Failed)> GetSeasonStatusFromJellyseerr(string tmdbId, int seasonNumber)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                return (null, true);
            }

            try
            {
                var urls = GetConfiguredUrls(config.JellyseerrUrls);
                var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                string? content = null;
                foreach (var url in urls)
                {
                    try
                    {
                        var requestUrl = $"{url}/api/v1/tv/{tmdbId}";
                        using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestUrl, config.GetJellyseerrApiKey());
                        using var response = await httpClient.SendAsync(request);
                        var (body, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUrl);
                        if (error != null)
                        {
                            _logger.Debug($"[Auto-Season-Request] Status check for TMDB {tmdbId} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                            continue;
                        }

                        content = body;
                        break;
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Auto-Season-Request] Error fetching season status from {url}: {ex.Message}");
                    }
                }

                if (string.IsNullOrEmpty(content))
                {
                    return (null, true);
                }

                using (JsonDocument doc = JsonDocument.Parse(content))
                {
                    var root = doc.RootElement;

                    if (root.TryGetProperty("numberOfSeasons", out var totalSeasonsProp))
                    {
                        var totalSeasons = totalSeasonsProp.GetInt32();
                        _logger.Info($"[Auto-Season-Request] Jellyseerr reports {totalSeasons} total seasons for TMDB ID {tmdbId}");
                        if (seasonNumber > totalSeasons)
                        {
                            _logger.Info($"[Auto-Season-Request] Season {seasonNumber} does not exist on TMDB - show only has {totalSeasons} season(s)");
                            return (null, false);
                        }
                    }

                    bool hasRequest = false;
                    if (root.TryGetProperty("mediaInfo", out var mediaInfoElement) &&
                        mediaInfoElement.TryGetProperty("requests", out var requestsArray))
                    {
                        _logger.Info($"[Auto-Season-Request] Jellyseerr reports {requestsArray.GetArrayLength()} request(s) for TMDB ID {tmdbId}");
                        foreach (var request in requestsArray.EnumerateArray())
                        {
                            if (request.TryGetProperty("seasons", out var requestSeasons))
                            {
                                foreach (var requestSeason in requestSeasons.EnumerateArray())
                                {
                                    if (requestSeason.TryGetProperty("seasonNumber", out var requestSeasonNum) &&
                                        requestSeasonNum.GetInt32() == seasonNumber)
                                    {
                                        hasRequest = true;
                                        _logger.Info($"[Auto-Season-Request] Found existing request for season {seasonNumber}");
                                        break;
                                    }
                                }
                                if (hasRequest) break;
                            }
                        }
                    }
                    else
                    {
                        _logger.Info($"[Auto-Season-Request] No mediaInfo or no requests found for TMDB ID {tmdbId}");
                    }

                    if (root.TryGetProperty("seasons", out var seasonsArray))
                    {
                        foreach (var season in seasonsArray.EnumerateArray())
                        {
                            if (season.TryGetProperty("seasonNumber", out var seasonNumProp) &&
                                seasonNumProp.GetInt32() == seasonNumber)
                            {
                                var status = new SeasonStatus();
                                if (season.TryGetProperty("status", out var statusProp))
                                {
                                    var statusValue = statusProp.GetInt32();
                                    status.IsAvailable = statusValue == 5;
                                    _logger.Info($"[Auto-Season-Request] Jellyseerr Season {seasonNumber} raw status code: {statusValue} (5 = available)");
                                }

                                status.IsRequested = hasRequest;

                                _logger.Info($"[Auto-Season-Request] Season {seasonNumber} final status from Jellyseerr: Available={status.IsAvailable}, Requested={status.IsRequested}");
                                return (status, false);
                            }
                        }
                    }
                }

                _logger.Info($"[Auto-Season-Request] Season {seasonNumber} not found in Jellyseerr response");
                return (null, false);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Season-Request] Error querying Jellyseerr: {ex.Message}");
            }

            return (null, true);
        }

        // Calculates remaining unwatched episodes
        private int CalculateRemainingEpisodes(
            List<BaseItem> episodes,
            JUser user)
        {
            int remainingEpisodes = 0;

            foreach (var episode in episodes)
            {
                var userData = _userDataManager.GetUserData(user, episode);

                // If episode hasn't been watched (completed)
                if (userData == null || !userData.Played)
                {
                    remainingEpisodes++;
                }
            }

            return remainingEpisodes;
        }

        // Gets TMDB ID from series metadata
        private string? GetTmdbId(Series series)
        {
            if (series.ProviderIds.TryGetValue("Tmdb", out var tmdbId))
            {
                return tmdbId;
            }
            return null;
        }

        // Requests the next season from Jellyseerr: Sent, or why it stopped right before a POST (see DirectStop; nothing
        // more is sent). Neither: it failed.
        private async Task<(bool Sent, string? Stopped)> RequestNextSeason(string tmdbId, int seasonNumber, string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                _logger.Warning("[Auto-Season-Request] Jellyseerr configuration is missing");
                return (false, null);
            }

            // Get Jellyseerr user ID
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.Warning($"[Auto-Season-Request] Could not find Jellyseerr user for Jellyfin user {jellyfinUserId}");
                return (false, null);
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/request";

                    var requestBody = new
                    {
                        mediaType = "tv",
                        mediaId = int.Parse(tmdbId),
                        seasons = new[] { seasonNumber }
                    };

                    var jsonContent = JsonSerializer.Serialize(requestBody);

                    // Read live right before each POST (the next Seerr URL included).
                    if (DirectStop() is { } stop)
                    {
                        return (false, stop);
                    }

                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Post, requestUri, config.GetJellyseerrApiKey(), jellyseerrUserId, jsonContent);
                    using var response = await httpClient.SendAsync(request);
                    var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error == null)
                    {
                        return (true, null);
                    }
                    _logger.Warning($"[Auto-Season-Request] Jellyseerr request failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Season-Request] Exception requesting season from Jellyseerr at {url}: {ex.Message}");
                }
            }

            return (false, null);
        }

        // Gets the Jellyseerr user ID for a Jellyfin user
        private async Task<string?> GetJellyseerrUserId(string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                return null;
            }

            var normalizedJellyfinUserId = NormalizeUserId(jellyfinUserId);

            lock (_userIdCacheLock)
            {
                if (_jellyseerrUserIdCache.TryGetValue(normalizedJellyfinUserId, out var cached) &&
                    DateTime.UtcNow - cached.CachedAt < GetJellyseerrUserIdCacheTtl())
                {
                    return cached.JellyseerrUserId;
                }
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/user?take=1000";
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUri, config.GetJellyseerrApiKey());
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error == null && content != null)
                    {
                        var usersResponse = JsonSerializer.Deserialize<JsonElement>(content);

                        if (usersResponse.TryGetProperty("results", out var usersArray))
                        {
                            foreach (var userElement in usersArray.EnumerateArray())
                            {
                                if (userElement.TryGetProperty("jellyfinUserId", out var jfUserId) &&
                                    userElement.TryGetProperty("id", out var id))
                                {
                                    var jellyseerrJfUserId = jfUserId.GetString();
                                    if (!string.IsNullOrEmpty(jellyseerrJfUserId))
                                    {
                                        // Normalize both IDs for comparison (remove dashes)
                                        var normalizedJellyseerrId = jellyseerrJfUserId.Replace("-", "").ToLowerInvariant();

                                        if (normalizedJellyseerrId == normalizedJellyfinUserId)
                                        {
                                            var jellyseerrUserId = id.GetInt32().ToString();
                                            lock (_userIdCacheLock)
                                            {
                                                _jellyseerrUserIdCache[normalizedJellyfinUserId] = (jellyseerrUserId, DateTime.UtcNow);
                                            }
                                            return jellyseerrUserId;
                                        }
                                    }
                                }
                            }
                            _logger.Warning($"[Auto-Season-Request] No Jellyseerr user found for Jellyfin user {jellyfinUserId}");
                        }
                    }
                    else if (error != null)
                    {
                        _logger.Warning($"[Auto-Season-Request] Failed to fetch users from Jellyseerr: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Season-Request] Exception while trying to get Jellyseerr user ID from {url}: {ex.Message}");
                }
            }

            return null;
        }
    }
}
