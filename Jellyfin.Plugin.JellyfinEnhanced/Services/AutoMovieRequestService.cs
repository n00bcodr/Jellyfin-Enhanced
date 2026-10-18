using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.AutoRequest;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Querying;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    public class AutoMovieRequestService
    {
        /// <summary>The recipe name in the request ledger and the automation log.</summary>
        public const string Recipe = "auto_movie";

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;
        private readonly AutoRequestRecorder? _recorder;

        // Track which movies have already been requested to avoid duplicates (with timestamps for expiry)
        private readonly Dictionary<string, Dictionary<string, DateTime>> _requestedMovies = new();
        private readonly object _movieCacheLock = new();
        private readonly Dictionary<string, (string JellyseerrUserId, DateTime CachedAt)> _jellyseerrUserIdCache = new();
        private readonly object _userIdCacheLock = new();

        public AutoMovieRequestService(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            ILibraryManager libraryManager)
            : this(httpClientFactory, logger, userManager, libraryManager, null)
        {
        }

        /// <summary>Creates the service; with phase 3 on, decisions become wants through <paramref name="recorder"/>.</summary>
        public AutoMovieRequestService(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            ILibraryManager libraryManager,
            AutoRequestRecorder? recorder)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _libraryManager = libraryManager;
            _recorder = recorder;
        }

        /// <summary>True when the decision goes to the request ledger (phase 3 on and a recorder available).</summary>
        internal bool LedgerMode(PluginConfiguration? config) => _recorder != null && AutoRequestRecorder.Active(config);

        private static bool SeerrConfigured(PluginConfiguration config)
            => config.JellyseerrEnabled && !string.IsNullOrEmpty(config.JellyseerrUrls) && !string.IsNullOrEmpty(config.GetJellyseerrApiKey());

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

        // Checks a movie to determine if the next movie in collection should be requested.
        // Event-driven entry point called (from the recipe worker) when a user starts watching a movie.
        // The outcome is typed: a failed TMDB or Seerr lookup is a PreparationFailed, never "not in a collection".
        public async Task<AutoRequestOutcome> CheckMovieForCollectionRequestAsync(BaseItem movieItem, Guid userId, CancellationToken ct = default)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var ledger = LedgerMode(config);
            if (config == null || !config.AutoMovieRequestEnabled || (!ledger && !config.JellyseerrEnabled))
            {
                return AutoRequestOutcome.Noop("disabled");
            }

            if (ledger && config.ArrRequestBackend == "status_only")
            {
                return AutoRequestOutcome.Noop("requests_off");
            }

            if (string.IsNullOrEmpty(config.GetTmdbApiKey()))
            {
                _logger.Warning("[Auto-Movie-Request] TMDB API key is not configured. Auto movie requests require TMDB API access.");
                return AutoRequestOutcome.Noop("not_configured");
            }

            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return AutoRequestOutcome.Noop("user_required");
            }

            // Ensure this is a movie
            var movie = movieItem as Movie;
            if (movie == null)
            {
                return AutoRequestOutcome.Noop("not_a_movie");
            }

            // Get TMDB ID
            var tmdbId = GetTmdbId(movie);
            if (string.IsNullOrEmpty(tmdbId))
            {
                _logger.Debug($"[Auto-Movie-Request] '{movie.Name}' has no TMDB ID");
                return AutoRequestOutcome.Noop("no_tmdb_id");
            }

            // Get collection info from TMDB
            var (collectionInfo, collectionFailed) = await GetTmdbCollectionIdAsync(tmdbId);
            if (collectionFailed)
            {
                return AutoRequestOutcome.Failed("tmdb_unavailable");
            }
            if (collectionInfo == null)
            {
                // _logger.Debug($"[Auto-Movie-Request] '{movie.Name}' is not part of a TMDB collection");
                return AutoRequestOutcome.Noop("not_in_collection");
            }

            _logger.Info($"[Auto-Movie-Request] '{movie.Name}' is part of {collectionInfo.Name} (TMDB collection {collectionInfo.Id})");

            // Get collection details from Jellyseerr (or, with no Seerr in JE mode, from TMDB)
            NextMovie next;
            if (SeerrConfigured(config))
            {
                next = await GetNextMovieInCollectionAsync(collectionInfo.Id, tmdbId, ledger);
            }
            else if (ledger)
            {
                next = await GetNextMovieFromTmdbAsync(collectionInfo.Id, tmdbId, ct);
            }
            else
            {
                return AutoRequestOutcome.Noop("not_configured");
            }
            if (next.Failed)
            {
                return AutoRequestOutcome.Failed(next.Reason ?? "collection_unavailable");
            }
            var nextMovieInfo = next.Movie;
            if (nextMovieInfo == null)
            {
                // _logger.Debug($"[Auto-Movie-Request] No next movie found or next movie is already available/requested");
                return AutoRequestOutcome.Noop(next.Reason ?? "last_in_collection");
            }

            var key = TitleKey.ForMovie(nextMovieInfo.TmdbId.ToString(System.Globalization.CultureInfo.InvariantCulture), null)!;
            if (ledger)
            {
                var inLibrary = _recorder!.InLibrary(key, user.Id);
                if (inLibrary == null)
                {
                    return AutoRequestOutcome.Noop("library_lookup_incomplete", key.ToString());
                }
                if (inLibrary == true)
                {
                    return AutoRequestOutcome.Noop("already_available", key.ToString());
                }
                var recorded = await _recorder.RecordAsync(Recipe, user.Id, new MutationInput { Key = key.ToString() }, ct);
                _logger.Info($"[Auto-Movie-Request] '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}: {recorded.Code} ({recorded.Reason})");
                return recorded;
            }

            // Check if we've already requested this movie (in-memory cache with 1-hour expiry)
            // Uses a sentinel pattern: write the entry before async work so concurrent
            // callers see it immediately, then remove on failure to allow retries.
            var requestKey = $"{user.Id}_{nextMovieInfo.TmdbId}";
            lock (_movieCacheLock)
            {
                // Clean up expired entries across all users
                foreach (var cachedUserId in _requestedMovies.Keys.ToList())
                {
                    var expired = _requestedMovies[cachedUserId]
                        .Where(kvp => (DateTime.Now - kvp.Value).TotalHours >= 1)
                        .Select(kvp => kvp.Key).ToList();
                    foreach (var k in expired) _requestedMovies[cachedUserId].Remove(k);
                    if (_requestedMovies[cachedUserId].Count == 0) _requestedMovies.Remove(cachedUserId);
                }

                if (!_requestedMovies.ContainsKey(user.Id.ToString()))
                {
                    _requestedMovies[user.Id.ToString()] = new Dictionary<string, DateTime>();
                }

                if (_requestedMovies[user.Id.ToString()].ContainsKey(requestKey))
                {
                    _logger.Debug($"[Auto-Movie-Request] Already requested '{nextMovieInfo.Title}' (cached)");
                    return AutoRequestOutcome.Noop("already_requested", key.ToString());
                }

                // Reserve the slot so concurrent callers see it immediately
                _requestedMovies[user.Id.ToString()][requestKey] = DateTime.Now;
            }

            // Resolve quality profile settings based on configuration mode
            var qualitySettings = await ResolveQualityProfileAsync(tmdbId);

            // Request the movie
            var success = await RequestMovie(nextMovieInfo.TmdbId.ToString(), user.Id.ToString(), qualitySettings);

            if (success)
            {
                _logger.Info($"[Auto-Movie-Request] ✓ Requested '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}");
                return AutoRequestOutcome.Recorded("seerr_request", key.ToString());
            }

            // Remove sentinel so a future attempt can retry
            lock (_movieCacheLock)
            {
                if (_requestedMovies.ContainsKey(user.Id.ToString()))
                {
                    _requestedMovies[user.Id.ToString()].Remove(requestKey);
                }
            }
            _logger.Warning($"[Auto-Movie-Request] ✗ Failed to request '{nextMovieInfo.Title}' (TMDB {nextMovieInfo.TmdbId}) for {user.Username}");
            return AutoRequestOutcome.Failed("seerr_request_failed", key.ToString());
        }

        // The next movie of a collection, or why there is none: a definitive reason, or a failed lookup.
        private readonly record struct NextMovie(MovieInfo? Movie, string? Reason, bool Failed);

        // Jellyseerr movie status
        private class MovieStatus
        {
            public bool IsAvailable { get; set; }
            public bool IsRequested { get; set; }
        }

        // Collection info from TMDB
        private class CollectionInfo
        {
            public int Id { get; set; }
            public string Name { get; set; } = string.Empty;
        }

        // Movie info with title
        private class MovieInfo
        {
            public int TmdbId { get; set; }
            public string Title { get; set; } = string.Empty;
        }

        // Quality profile settings for Jellyseerr requests
        private class QualityProfileSettings
        {
            public int? ServerId { get; set; }
            public int? ProfileId { get; set; }
            public string? RootFolder { get; set; }
            public bool Is4k { get; set; }
        }

        // Gets TMDB collection ID and name for a movie; Failed when TMDB couldn't be asked or answered with an error
        private async Task<(CollectionInfo? Collection, bool Failed)> GetTmdbCollectionIdAsync(string tmdbId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.GetTmdbApiKey()))
            {
                return (null, true);
            }

            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                var requestUrl = $"https://api.themoviedb.org/3/movie/{tmdbId}?api_key={config.GetTmdbApiKey()}";

                var response = await httpClient.GetAsync(requestUrl);
                if (!response.IsSuccessStatusCode)
                {
                    _logger.Debug($"[Auto-Movie-Request] TMDB returned {response.StatusCode} for movie {tmdbId}");
                    // A movie TMDB doesn't know is definitively not in a collection; anything else is a failed lookup.
                    return (null, response.StatusCode != System.Net.HttpStatusCode.NotFound);
                }

                var content = await response.Content.ReadAsStringAsync();
                using (JsonDocument doc = JsonDocument.Parse(content))
                {
                    var root = doc.RootElement;
                    if (root.TryGetProperty("belongs_to_collection", out var collectionProp))
                    {
                        if (collectionProp.ValueKind != JsonValueKind.Null &&
                            collectionProp.TryGetProperty("id", out var idProp) &&
                            collectionProp.TryGetProperty("name", out var nameProp))
                        {
                            return (new CollectionInfo
                            {
                                Id = idProp.GetInt32(),
                                Name = nameProp.GetString() ?? "Unknown Collection"
                            }, false);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Movie-Request] Error querying TMDB: {ex.Message}");
                return (null, true);
            }

            return (null, false);
        }

        // Gets next movie in collection from Jellyseerr collection endpoint. On the ledger path Seerr only names
        // the next part: its pending/processing status says nothing about JE's own requests once JE handles them
        // (moved requests stay pending in Seerr), so the ledger decides whether to record, merge or refuse.
        private async Task<NextMovie> GetNextMovieInCollectionAsync(int collectionId, string currentTmdbId, bool ledger = false)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                return new NextMovie(null, "not_configured", false);
            }

            try
            {
                var urls = GetConfiguredUrls(config.JellyseerrUrls);
                var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

                foreach (var url in urls)
                {
                    var trimmedUrl = url.Trim().TrimEnd('/');
                    var requestUrl = $"{trimmedUrl}/api/v1/collection/{collectionId}";

                    try
                    {
                        using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                            HttpMethod.Get, requestUrl, config.GetJellyseerrApiKey());
                        using var response = await httpClient.SendAsync(request);
                        var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUrl);
                        if (error != null)
                        {
                            _logger.Debug($"[Auto-Movie-Request] Jellyseerr collection fetch failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                            continue;
                        }

                        using (JsonDocument doc = JsonDocument.Parse(content!))
                        {
                            var root = doc.RootElement;

                            if (root.TryGetProperty("parts", out var partsArray))
                            {
                                int? currentIndex = null;
                                int? nextIndex = null;

                                // Find current movie and next movie
                                var parts = partsArray.EnumerateArray().ToList();
                                for (int i = 0; i < parts.Count; i++)
                                {
                                    var part = parts[i];
                                    if (part.TryGetProperty("id", out var idProp) && idProp.GetInt32().ToString() == currentTmdbId)
                                    {
                                        currentIndex = i;
                                        break;
                                    }
                                }

                                if (currentIndex.HasValue && currentIndex.Value < parts.Count - 1)
                                {
                                    nextIndex = currentIndex.Value + 1;
                                    var nextPart = parts[nextIndex.Value];

                                    // Check if next movie is available or already requested
                                    if (nextPart.TryGetProperty("mediaInfo", out var mediaInfo))
                                    {
                                        if (mediaInfo.TryGetProperty("status", out var statusProp))
                                        {
                                            var statusValue = statusProp.GetInt32();
                                            // 5 = available, 2 = pending, 3 = processing (requested only counts off the ledger)
                                            if (statusValue == 5 || (!ledger && (statusValue == 2 || statusValue == 3)))
                                            {
                                                _logger.Debug($"[Auto-Movie-Request] Next movie already available or requested (status: {statusValue})");
                                                return new NextMovie(null, statusValue == 5 ? "already_available" : "already_requested", false);
                                            }
                                        }
                                    }

                                    // Check release date if configured
                                    if (config.AutoMovieRequestCheckReleaseDate && nextPart.TryGetProperty("releaseDate", out var releaseDateProp))
                                    {
                                        var releaseDateStr = releaseDateProp.GetString();
                                        // Seerr sends ISO dates ("2001-01-01"); a culture-sensitive parse reads the year
                                        // in the server's calendar (Persian, Thai Buddhist) and misjudges the release.
                                        // A date-only value parses as the server's local midnight, so a title counts as
                                        // released from the start of its release day in the server's time zone.
                                        if (!string.IsNullOrEmpty(releaseDateStr) && DateTime.TryParse(releaseDateStr, System.Globalization.CultureInfo.InvariantCulture,
                                            System.Globalization.DateTimeStyles.None, out var releaseDate))
                                        {
                                            if (releaseDate > DateTime.Now)
                                            {
                                                _logger.Debug($"[Auto-Movie-Request] Next movie is not yet released (release date: {releaseDateStr}), skipping");
                                                return new NextMovie(null, "not_released", false);
                                            }
                                        }
                                    }

                                    // Return next movie's TMDB ID and title
                                    if (nextPart.TryGetProperty("id", out var nextIdProp) &&
                                        nextPart.TryGetProperty("title", out var titleProp))
                                    {
                                        return new NextMovie(new MovieInfo
                                        {
                                            TmdbId = nextIdProp.GetInt32(),
                                            Title = titleProp.GetString() ?? "Unknown Title"
                                        }, null, false);
                                    }
                                }
                                else
                                {
                                    // _logger.Debug($"[Auto-Movie-Request] Current movie is the last in collection or not found");
                                    return new NextMovie(null, "last_in_collection", false);
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[Auto-Movie-Request] Error checking Jellyseerr at {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Movie-Request] Error querying Jellyseerr collection: {ex.Message}");
            }

            // No configured Seerr address answered with a usable collection.
            return new NextMovie(null, "seerr_unavailable", true);
        }

        // Gets the next movie of a TMDB collection straight from TMDB (JE mode without Seerr): parts in
        // release order; library availability is checked against Jellyfin by the caller.
        private async Task<NextMovie> GetNextMovieFromTmdbAsync(int collectionId, string currentTmdbId, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.GetTmdbApiKey()))
            {
                return new NextMovie(null, "not_configured", false);
            }
            try
            {
                var httpClient = _httpClientFactory.CreateClient();
                using var response = await httpClient.GetAsync($"https://api.themoviedb.org/3/collection/{collectionId}?api_key={config.GetTmdbApiKey()}", ct);
                if (!response.IsSuccessStatusCode)
                {
                    return new NextMovie(null, "tmdb_unavailable", true);
                }
                using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
                if (!doc.RootElement.TryGetProperty("parts", out var partsElement) || partsElement.ValueKind != JsonValueKind.Array)
                {
                    return new NextMovie(null, "tmdb_unavailable", true);
                }
                var parts = partsElement.EnumerateArray()
                    .Where(p => p.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.Number)
                    .Select(p => (Id: p.GetProperty("id").GetInt32(),
                        Title: p.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "Unknown Title" : "Unknown Title",
                        Release: p.TryGetProperty("release_date", out var r) && r.ValueKind == JsonValueKind.String && DateTime.TryParse(r.GetString(), System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var date) ? date : (DateTime?)null))
                    .OrderBy(p => p.Release ?? DateTime.MaxValue).ThenBy(p => p.Id)
                    .ToList();
                var index = parts.FindIndex(p => p.Id.ToString(System.Globalization.CultureInfo.InvariantCulture) == currentTmdbId);
                if (index < 0 || index >= parts.Count - 1)
                {
                    return new NextMovie(null, "last_in_collection", false);
                }
                var nextPart = parts[index + 1];
                if (config.AutoMovieRequestCheckReleaseDate && (nextPart.Release == null || nextPart.Release > DateTime.Now))
                {
                    return new NextMovie(null, "not_released", false);
                }
                return new NextMovie(new MovieInfo { TmdbId = nextPart.Id, Title = nextPart.Title }, null, false);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Auto-Movie-Request] Error querying TMDB collection: {ex.Message}");
                return new NextMovie(null, "tmdb_unavailable", true);
            }
        }

        // Gets the quality profile of a movie from its existing Jellyseerr request
        private async Task<QualityProfileSettings?> GetOriginalMovieQualityProfileAsync(string tmdbId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                return null;
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                try
                {
                    var requestUrl = $"{url}/api/v1/movie/{tmdbId}";
                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get, requestUrl, config.GetJellyseerrApiKey());
                    using var response = await httpClient.SendAsync(request);
                    var (content, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUrl);
                    if (error != null)
                    {
                        _logger.Debug($"[Auto-Movie-Request] Quality profile lookup for movie {tmdbId} failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay}");
                        continue;
                    }

                    using (JsonDocument doc = JsonDocument.Parse(content!))
                    {
                        var root = doc.RootElement;
                        if (root.TryGetProperty("mediaInfo", out var mediaInfo) &&
                            mediaInfo.TryGetProperty("requests", out var requests) &&
                            requests.GetArrayLength() > 0)
                        {
                            var firstRequest = requests[0];
                            var settings = new QualityProfileSettings();

                            if (firstRequest.TryGetProperty("profileId", out var profileId) &&
                                profileId.ValueKind == JsonValueKind.Number)
                            {
                                settings.ProfileId = profileId.GetInt32();
                            }
                            if (firstRequest.TryGetProperty("serverId", out var serverId) &&
                                serverId.ValueKind == JsonValueKind.Number)
                            {
                                settings.ServerId = serverId.GetInt32();
                            }
                            if (firstRequest.TryGetProperty("rootFolder", out var rootFolder) &&
                                rootFolder.ValueKind == JsonValueKind.String)
                            {
                                settings.RootFolder = rootFolder.GetString();
                            }
                            if (firstRequest.TryGetProperty("is4k", out var is4k) &&
                                is4k.ValueKind == JsonValueKind.True)
                            {
                                settings.Is4k = true;
                            }

                            if (settings.ProfileId.HasValue || settings.ServerId.HasValue)
                            {
                                _logger.Debug($"[Auto-Movie-Request] Found quality profile for TMDB {tmdbId}: profileId={settings.ProfileId}, serverId={settings.ServerId}, rootFolder={settings.RootFolder}, is4k={settings.Is4k}");
                                return settings;
                            }
                        }
                    }

                    _logger.Debug($"[Auto-Movie-Request] No request records found for TMDB {tmdbId} in Jellyseerr");
                    return null;
                }
                catch (HttpRequestException ex)
                {
                    _logger.Debug($"[Auto-Movie-Request] Failed to connect to {url}: {ex.Message}");
                    continue;
                }
                catch (JsonException ex)
                {
                    _logger.Warning($"[Auto-Movie-Request] Invalid response from {url}: {ex.Message}");
                    continue;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"[Auto-Movie-Request] Unexpected error fetching quality profile from {url}: {ex.Message}");
                    continue;
                }
            }

            return null;
        }

        // Resolves quality profile settings based on configuration mode
        private async Task<QualityProfileSettings?> ResolveQualityProfileAsync(string watchedTmdbId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return null;
            }

            var mode = config.AutoMovieRequestQualityMode ?? "default";

            if (mode == "original")
            {
                var settings = await GetOriginalMovieQualityProfileAsync(watchedTmdbId);
                if (settings == null)
                {
                    _logger.Warning($"[Auto-Movie-Request] Could not determine quality profile for watched movie TMDB {watchedTmdbId}, falling back to default");
                    return null;
                }

                if (settings.Is4k && config.AutoMovieRequestFallbackOn4k)
                {
                    _logger.Info($"[Auto-Movie-Request] Original movie used a 4K quality profile, falling back to default (AutoMovieRequestFallbackOn4k is enabled)");
                    return null;
                }

                return settings;
            }

            if (mode == "custom")
            {
                var settings = new QualityProfileSettings();
                if (config.AutoMovieRequestCustomServerId >= 0)
                {
                    settings.ServerId = config.AutoMovieRequestCustomServerId;
                }
                if (config.AutoMovieRequestCustomProfileId > 0)
                {
                    settings.ProfileId = config.AutoMovieRequestCustomProfileId;
                }
                if (!string.IsNullOrEmpty(config.AutoMovieRequestCustomRootFolder))
                {
                    settings.RootFolder = config.AutoMovieRequestCustomRootFolder;
                }

                // Only return if at least one value is set
                if (settings.ServerId.HasValue || settings.ProfileId.HasValue || !string.IsNullOrEmpty(settings.RootFolder))
                {
                    return settings;
                }

                _logger.Warning("[Auto-Movie-Request] Custom quality profile mode selected but no values configured, falling back to default");
                return null;
            }

            // "default" mode or unrecognized - no quality profile settings
            if (mode != "default")
            {
                _logger.Warning($"[Auto-Movie-Request] Unrecognized quality mode '{mode}', treating as default");
            }
            return null;
        }

        // Gets TMDB ID from movie metadata
        private string? GetTmdbId(Movie movie)
        {
            if (movie.ProviderIds.TryGetValue("Tmdb", out var tmdbId))
            {
                return tmdbId;
            }
            return null;
        }

        // Requests a movie from Jellyseerr
        private async Task<bool> RequestMovie(string tmdbId, string jellyfinUserId, QualityProfileSettings? qualitySettings = null)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.GetJellyseerrApiKey()))
            {
                _logger.Warning("[Auto-Movie-Request] Jellyseerr configuration is missing");
                return false;
            }

            // Get Jellyseerr user ID
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            if (string.IsNullOrEmpty(jellyseerrUserId))
            {
                _logger.Warning($"[Auto-Movie-Request] Could not find Jellyseerr user for Jellyfin user {jellyfinUserId}");
                return false;
            }

            var urls = GetConfiguredUrls(config.JellyseerrUrls);
            var httpClient = Helpers.Jellyseerr.SeerrHttpHelper.CreateClient(_httpClientFactory);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/request";

                    var requestBody = new Dictionary<string, object>
                    {
                        { "mediaType", "movie" },
                        { "mediaId", int.Parse(tmdbId) }
                    };

                    if (qualitySettings != null)
                    {
                        if (qualitySettings.ServerId.HasValue && qualitySettings.ServerId.Value >= 0)
                            requestBody["serverId"] = qualitySettings.ServerId.Value;
                        if (qualitySettings.ProfileId.HasValue && qualitySettings.ProfileId.Value > 0)
                            requestBody["profileId"] = qualitySettings.ProfileId.Value;
                        if (!string.IsNullOrEmpty(qualitySettings.RootFolder))
                            requestBody["rootFolder"] = qualitySettings.RootFolder;
                        if (qualitySettings.Is4k)
                            requestBody["is4k"] = true;
                    }

                    var jsonContent = JsonSerializer.Serialize(requestBody);

                    using var request = Helpers.Jellyseerr.SeerrHttpHelper.BuildRequest(
                        HttpMethod.Post, requestUri, config.GetJellyseerrApiKey(), jellyseerrUserId, jsonContent);
                    using var response = await httpClient.SendAsync(request);
                    var (_, error) = await Helpers.Jellyseerr.SeerrHttpHelper.ReadResponseAsync(response, requestUri);

                    if (error == null)
                    {
                        return true;
                    }
                    _logger.Warning($"[Auto-Movie-Request] Jellyseerr request failed: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Movie-Request] Exception requesting movie from Jellyseerr at {url}: {ex.Message}");
                }
            }

            return false;
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
                            _logger.Warning($"[Auto-Movie-Request] No Jellyseerr user found for Jellyfin user {jellyfinUserId}");
                        }
                    }
                    else if (error != null)
                    {
                        _logger.Warning($"[Auto-Movie-Request] Failed to fetch users from Jellyseerr: code={error.Code} status={error.HttpStatus} cf-ray={error.CfRay} — {error.Message}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"[Auto-Movie-Request] Exception while trying to get Jellyseerr user ID from {url}: {ex.Message}");
                }
            }

            return null;
        }

        // Clears the request cache (useful for testing or resetting)
        public void ClearRequestCache()
        {
            lock (_movieCacheLock)
            {
                _requestedMovies.Clear();
            }
            _logger.Info("[Auto-Movie-Request] Cleared auto movie request cache");
        }
    }
}
