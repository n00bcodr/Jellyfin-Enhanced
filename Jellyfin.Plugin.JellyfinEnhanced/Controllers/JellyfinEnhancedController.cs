using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Collections.Generic;
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
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JellyfinEnhancedController : ControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly Logger _logger;
        private readonly IUserManager _userManager;
        private readonly IUserDataManager _userDataManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IDtoService _dtoService;
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly IItemRepository _itemRepository;
        private static readonly HashSet<string> BrandingFileNames = new(new[]
        {
            "icon-transparent.png",
            "banner-light.png",
            "banner-dark.png",
            "favicon.ico",
            "apple-touch-icon.png"
        }, StringComparer.OrdinalIgnoreCase);

        public JellyfinEnhancedController(
            IHttpClientFactory httpClientFactory,
            Logger logger,
            IUserManager userManager,
            IUserDataManager userDataManager,
            ILibraryManager libraryManager,
            IDtoService dtoService,
            UserConfigurationManager userConfigurationManager,
            IItemRepository itemRepository)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _dtoService = dtoService;
            _userConfigurationManager = userConfigurationManager;
            _itemRepository = itemRepository;
        }

        private async Task<JellyseerrUser?> GetJellyseerrUser(string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("Jellyseerr configuration is missing. Cannot look up user ID.");
                return null;
            }

            // _logger.Info($"Attempting to find Jellyseerr user for Jellyfin User ID: {jellyfinUserId}");
            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/user?take=1000"; // Fetch all users to find a match
                    // _logger.Info($"Requesting users from Jellyseerr URL: {requestUri}");
                    var response = await httpClient.GetAsync(requestUri);

                    if (response.IsSuccessStatusCode)
                    {
                        var content = await response.Content.ReadAsStringAsync();
                        var usersResponse = System.Text.Json.JsonSerializer.Deserialize<JsonElement>(content);
                        if (usersResponse.TryGetProperty("results", out var usersArray))
                        {
                            var users = System.Text.Json.JsonSerializer.Deserialize<List<JellyseerrUser>>(usersArray.ToString());
                            // _logger.Info($"Found {users?.Count ?? 0} users at {url.Trim()}");
                            var normalizedJellyfinUserId = jellyfinUserId.Replace("-", "");
                            var user = users?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, normalizedJellyfinUserId, StringComparison.OrdinalIgnoreCase));
                            if (user != null)
                            {
                                // _logger.Info($"Found Jellyseerr user ID {user.Id} for Jellyfin user ID {jellyfinUserId} at {url.Trim()}");
                                return user;
                            }
                            else
                            {
                                _logger.Info($"No matching Jellyfin User ID found in the {users?.Count ?? 0} users from {url.Trim()}");
                            }
                        }
                    }
                    else
                    {
                        var errorContent = await response.Content.ReadAsStringAsync();
                        _logger.Warning($"Failed to fetch users from Jellyseerr at {url}. Status: {response.StatusCode}. Response: {errorContent}");
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"Exception while trying to get Jellyseerr user ID from {url}: {ex.Message}");
                }
            }

            _logger.Warning($"Could not find a matching Jellyseerr user for Jellyfin User ID {jellyfinUserId} after checking all URLs.");
            return null;
        }

        private async Task<string?> GetJellyseerrUserId(string jellyfinUserId)
            => (await GetJellyseerrUser(jellyfinUserId))?.Id.ToString();

        [Authorize]
        private async Task<IActionResult> ProxyJellyseerrRequest(string apiPath, HttpMethod method, string? content = null)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("Jellyseerr integration is not configured or enabled.");
                return StatusCode(503, "Jellyseerr integration is not configured or enabled.");
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            string? jellyfinUserId = null;
            if (Request.Headers.TryGetValue("X-Jellyfin-User-Id", out var jellyfinUserIdValues))
            {
                jellyfinUserId = jellyfinUserIdValues.FirstOrDefault();
                if (string.IsNullOrEmpty(jellyfinUserId))
                {
                    _logger.Warning("Could not find Jellyfin User ID in request headers.");
                    return BadRequest(new { message = "Jellyfin User ID was not provided in the request." });
                }
                var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);

                if (string.IsNullOrEmpty(jellyseerrUserId))
                {
                    _logger.Warning($"Could not find a Jellyseerr user for Jellyfin user {jellyfinUserId}. Aborting request.");
                    return NotFound(new { message = "Current Jellyfin user is not linked to a Jellyseerr user." });
                }

                httpClient.DefaultRequestHeaders.Add("X-Api-User", jellyseerrUserId);
            }
            else
            {
                _logger.Warning("X-Jellyfin-User-Id header was not present in the request. Aborting.");
                return BadRequest(new { message = "Jellyfin User ID was not provided in the request." });
            }

            int lastStatusCode = 500;
            string lastErrorContent = "Could not connect to any configured Jellyseerr instance.";

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                try
                {
                    var requestUri = $"{trimmedUrl.TrimEnd('/')}{apiPath}";
                    // Skip logging for similar/recommendations endpoints
                    bool isSimilarOrRecommendations = apiPath.Contains("/similar") || apiPath.Contains("/recommendations");
                    if (!isSimilarOrRecommendations)
                    {
                        _logger.Info($"Proxying Jellyseerr request for user {jellyfinUserId} to: {requestUri}");
                    }

                    var request = new HttpRequestMessage(method, requestUri);
                    if (content != null)
                    {
                        _logger.Info($"Request body: {content}");
                        request.Content = new StringContent(content, Encoding.UTF8, "application/json");
                    }

                    var response = await httpClient.SendAsync(request);
                    var responseContent = await response.Content.ReadAsStringAsync();

                    if (response.IsSuccessStatusCode)
                    {
                        if (!isSimilarOrRecommendations)
                        {
                            _logger.Info($"Successfully received response from Jellyseerr for user {jellyfinUserId}. Status: {response.StatusCode}");
                        }
                        return Content(responseContent, "application/json");
                    }

                    _logger.Warning($"Request to Jellyseerr for user {jellyfinUserId} failed. URL: {trimmedUrl}, Status: {response.StatusCode}, Response: {responseContent}");
                    // Store the last error so we can return it if all URLs fail
                    lastStatusCode = (int)response.StatusCode;
                    try
                    {
                        JsonDocument.Parse(responseContent);
                        lastErrorContent = responseContent;
                    }
                    catch (JsonException)
                    {
                        lastErrorContent = System.Text.Json.JsonSerializer.Serialize(new { message = $"Upstream error from Jellyseerr: {response.ReasonPhrase}" });
                    }
                    // Continue to try next URL instead of returning immediately
                }
                catch (Exception ex)
                {
                    _logger.Error($"Failed to connect to Jellyseerr URL for user {jellyfinUserId}: {trimmedUrl}. Error: {ex.Message}");
                }
            }

            return StatusCode(lastStatusCode, lastErrorContent);
        }

        [HttpGet("jellyseerr/status")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrStatus()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrApiKey) || string.IsNullOrEmpty(config.JellyseerrUrls))
            {
                return Ok(new { active = false });
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            foreach (var url in urls)
            {
                try
                {
                    var response = await httpClient.GetAsync($"{url.Trim().TrimEnd('/')}/api/v1/status");
                    if (response.IsSuccessStatusCode)
                    {
                        // _logger.Info($"Successfully connected to Jellyseerr at {url}. Status is active.");
                        return Ok(new { active = true });
                    }
                }
                catch
                {
                    // Ignore and try next URL
                }
            }

            _logger.Warning("Could not establish a connection with any configured Jellyseerr URL. Status is inactive.");
            return Ok(new { active = false });
        }

        [HttpGet("jellyseerr/validate")]
        [Authorize]
        public async Task<IActionResult> ValidateJellyseerr([FromQuery] string url, [FromQuery] string apiKey)
        {
            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            var http = _httpClientFactory.CreateClient();
            http.DefaultRequestHeaders.Clear();
            http.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

            try
            {
                var resp = await http.GetAsync($"{url.TrimEnd('/')}/api/v1/user");
                if (resp.IsSuccessStatusCode)
                    return Ok(new { ok = true });

                return StatusCode((int)resp.StatusCode, new { ok = false, message = "Status check failed" });
            }
            catch (Exception ex)
            {
                _logger.Warning($"Jellyseerr validate failed for {url}: {ex.Message}");
                return StatusCode(502, new { ok = false, message = "Unable to reach Jellyseerr" });
            }
        }

        [HttpGet("jellyseerr/user-status")]
        [Authorize]
        public async Task<IActionResult> GetJellyseerrUserStatus()
        {
            // First check active status
            var activeResult = await GetJellyseerrStatus() as OkObjectResult;
            bool active = false;
            if (activeResult?.Value is not null)
            {
                var json = System.Text.Json.JsonSerializer.Serialize(activeResult.Value);
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("active", out var a))
                    active = a.GetBoolean();
            }
            if (!active) return Ok(new { active = false, userFound = false });

            // Get Jellyfin user id from header
            if (!Request.Headers.TryGetValue("X-Jellyfin-User-Id", out var jellyfinUserIdValues))
                return Ok(new { active = true, userFound = false });

            var jellyfinUserId = jellyfinUserIdValues.FirstOrDefault();
            if (string.IsNullOrEmpty(jellyfinUserId))
            {
                return Ok(new { active = true, userFound = false });
            }
            var jellyseerrUserId = await GetJellyseerrUserId(jellyfinUserId);
            return Ok(new { active = true, userFound = !string.IsNullOrEmpty(jellyseerrUserId) });
        }


        [HttpGet("jellyseerr/search")]
        [Authorize]
        public Task<IActionResult> JellyseerrSearch([FromQuery] string query)
        {
            return ProxyJellyseerrRequest($"/api/v1/search?query={Uri.EscapeDataString(query)}", HttpMethod.Get);
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

        [HttpGet("jellyseerr/{type}/{serverId}")]
        [Authorize]
        public Task<IActionResult> GetServiceDetails(string type, int serverId)
        {
            return ProxyJellyseerrRequest($"/api/v1/service/{type}/{serverId}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request")]
        [Authorize]
        public async Task<IActionResult> JellyseerrRequest([FromBody] JsonElement requestBody)
        {
            return await ProxyJellyseerrRequest("/api/v1/request", HttpMethod.Post, requestBody.ToString());
        }
        [HttpGet("jellyseerr/tv/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetTvShow(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/movie/{tmdbId}")]
        [Authorize]
        public Task<IActionResult> GetMovie(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}", HttpMethod.Get);
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
            return ProxyJellyseerrRequest($"/api/v1/movie/{tmdbId}/ratingscombined", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/seasons")]
        [Authorize]
        public Task<IActionResult> GetTvSeasons(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/seasons", HttpMethod.Get);
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

        [HttpGet("jellyseerr/tv/{tmdbId}/ratings")]
        [Authorize]
        public Task<IActionResult> GetTvRatingsCombined(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/ratings", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/network/{networkId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByNetwork(int networkId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/discover/tv/network/{networkId}?page={page}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/studio/{studioId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByStudio(int studioId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/discover/movies/studio/{studioId}?page={page}", HttpMethod.Get);
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
                    try
                    {
                        _logger.Info($"Fetching TMDB data for person {personId} (TMDB ID: {tmdbPersonId})");
                        var tmdbPersonData = await GetTmdbPersonData(tmdbPersonId);
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
                            _logger.Warning($"No TMDB data returned for person {personId} (TMDB ID: {tmdbPersonId})");
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"Failed to enrich person {personId} with TMDB data: {ex.Message}");
                        // Continue with Jellyfin data only
                    }
                }
                else
                {
                    // _logger.Debug($"No TMDB ID available for person {personId}");
                }



                int? currentAge = null;
                int? ageAtItemRelease = null;
                int? ageAtDeath = null;
                bool isDeceased = endDate.HasValue && endDate.Value < DateTime.Now;

                // Calculate current age or age at death
                if (birthDate.HasValue)
                {
                    if (isDeceased && endDate.HasValue)
                    {
                        // If deceased, calculate age at death
                        ageAtDeath = CalculateAge(birthDate.Value, endDate.Value);
                    }
                    else
                    {
                        // If alive, calculate current age
                        currentAge = CalculateAge(birthDate.Value, DateTime.Now);
                    }

                    // Calculate age at item release if itemId provided
                    if (itemId.HasValue)
                    {
                        var item = _libraryManager.GetItemById(itemId.Value);
                        if (item?.PremiereDate.HasValue ?? false)
                        {
                            ageAtItemRelease = CalculateAge(birthDate.Value, item.PremiereDate.Value);
                        }
                    }
                }

                return Ok(new
                {
                    id = person.Id,
                    name = person.Name,
                    tmdbId = tmdbId,
                    type = person.GetType().Name,
                    birthDate = birthDate?.ToString("yyyy-MM-dd"),
                    deathDate = endDate?.ToString("yyyy-MM-dd"),
                    birthPlace = birthPlace,
                    isDeceased = isDeceased,
                    currentAge = currentAge,
                    ageAtDeath = ageAtDeath,
                    ageAtItemRelease = ageAtItemRelease
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get person info for {personId}: {ex.Message}");
                return StatusCode(500, new { message = "Failed to get person info" });
            }
        }

        /// <summary>
        /// Fetch person data directly from TMDB API
        /// </summary>
        private async Task<TmdbPersonData?> GetTmdbPersonData(int tmdbPersonId)
        {
            try
            {
                // Get TMDB API key from configuration
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
                {
                    _logger.Warning("TMDB API key not configured in plugin settings");
                    return null;
                }

                var httpClient = _httpClientFactory.CreateClient();
                var tmdbUrl = $"https://api.themoviedb.org/3/person/{tmdbPersonId}?api_key={config.TMDB_API_KEY}";

                // _logger.Debug($"Fetching TMDB person data from: https://api.themoviedb.org/3/person/{tmdbPersonId}");
                var response = await httpClient.GetAsync(tmdbUrl);

                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"TMDB API request failed with status {response.StatusCode}");
                    return null;
                }

                var content = await response.Content.ReadAsStringAsync();
                var jsonElement = JsonSerializer.Deserialize<JsonElement>(content);

                DateTime? birthDate = null;
                DateTime? deathDate = null;
                string? birthPlace = null;

                // Parse birth date
                if (jsonElement.TryGetProperty("birthday", out var birthdayProp) &&
                    birthdayProp.ValueKind != JsonValueKind.Null &&
                    DateTime.TryParse(birthdayProp.GetString(), out var birth))
                {
                    birthDate = birth;
                }

                // Parse death date
                if (jsonElement.TryGetProperty("deathday", out var deathdayProp) &&
                    deathdayProp.ValueKind != JsonValueKind.Null &&
                    deathdayProp.GetString() is string deathStr &&
                    DateTime.TryParse(deathStr, out var death))
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
                        _logger.Debug($"Parsed place_of_birth: {birthPlace}");
                    }
                }

                return new TmdbPersonData
                {
                    BirthDate = birthDate,
                    DeathDate = deathDate,
                    BirthPlace = birthPlace
                };
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to get TMDB person data for ID {tmdbPersonId}: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Helper method to calculate age in years
        /// </summary>
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
            return ProxyJellyseerrRequest($"/api/v1/person/{personId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/person/{personId}/combined_credits")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrPersonCredits(int personId)
        {
            return ProxyJellyseerrRequest($"/api/v1/person/{personId}/combined_credits", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/discover/tv?page={page}&genre={genreId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/genre/{genreId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByGenre(int genreId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/discover/movies?page={page}&genre={genreId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/tv/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverTvByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/discover/tv?page={page}&keywords={keywordId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/discover/movies/keyword/{keywordId}")]
        [Authorize]
        public Task<IActionResult> DiscoverMoviesByKeyword(int keywordId, [FromQuery] int page = 1)
        {
            return ProxyJellyseerrRequest($"/api/v1/discover/movies?page={page}&keywords={keywordId}", HttpMethod.Get);
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
            return ProxyJellyseerrRequest($"/api/v1/user?take={take}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request/tv/{tmdbId}/seasons")]
        [Authorize]
        public async Task<IActionResult> RequestTvSeasons(int tmdbId, [FromBody] JsonElement requestBody)
        {
            return await ProxyJellyseerrRequest($"/api/v1/request", HttpMethod.Post, requestBody.ToString());
        }

        [HttpGet("jellyseerr/watchlist")]
        [Authorize]
        public Task<IActionResult> GetJellyseerrWatchlist()
        {
            return ProxyJellyseerrRequest("/api/v1/user/watchlist", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/sync-watchlist")]
        [Authorize]
        public async Task<IActionResult> SyncJellyseerrWatchlist()
        {
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || !config.JellyseerrEnabled || !config.SyncJellyseerrWatchlist)
                {
                    return BadRequest(new { error = "Jellyseerr watchlist sync is not enabled" });
                }

                _logger.Info("[Manual Watchlist Sync] Starting manual Jellyseerr watchlist sync...");

                int itemsProcessed = 0;
                int itemsAdded = 0;
                var errors = new List<string>();

                foreach (var user in _userManager.Users)
                {
                    try
                    {
                        _logger.Info($"[Manual Watchlist Sync] Processing user: {user.Username} ({user.Id})");

                        // Get Jellyseerr user ID for this Jellyfin user
                        var jellyseerrUserId = await GetJellyseerrUserId(user.Id.ToString());
                        if (string.IsNullOrEmpty(jellyseerrUserId))
                        {
                            _logger.Warning($"[Manual Watchlist Sync] Could not find Jellyseerr user for {user.Username}");
                            continue;
                        }

                        // Get watchlist from Jellyseerr
                        var watchlistItems = await GetJellyseerrWatchlistForUser(jellyseerrUserId);
                        if (watchlistItems == null || watchlistItems.Count == 0)
                        {
                            _logger.Info($"[Manual Watchlist Sync] No watchlist items found for {user.Username}");
                            watchlistItems = new List<WatchlistItem>();
                        }

                        _logger.Info($"[Manual Watchlist Sync] Found {watchlistItems.Count} watchlist items for {user.Username}");

                        var requestItems = await GetJellyseerrRequestsForUser(jellyseerrUserId);
                        if (requestItems != null && requestItems.Count > 0)
                        {
                            _logger.Info($"[Manual Watchlist Sync] Found {requestItems.Count} request items for {user.Username}");
                            watchlistItems.AddRange(requestItems);
                        }

                        var processedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                        // Process each watchlist item
                        foreach (var item in watchlistItems)
                        {
                            itemsProcessed++;

                            var key = $"{item.MediaType}:{item.TmdbId}";
                            if (!processedKeys.Add(key))
                            {
                                continue;
                            }

                            // Find the item in Jellyfin library by TMDB ID
                            var libraryItem = FindItemByTmdbId(item.TmdbId, item.MediaType);
                            if (libraryItem != null)
                            {
                                var userData = _userDataManager.GetUserData(user, libraryItem);
                                if (userData == null)
                                {
                                    _logger.Warning($"[Manual Watchlist Sync] User data was null for '{libraryItem.Name}' and user {user.Username}; skipping.");
                                }
                                else if (userData.Likes != true)
                                {
                                    userData.Likes = true;
                                    _userDataManager.SaveUserData(user, libraryItem, userData, UserDataSaveReason.UpdateUserRating, default);
                                    itemsAdded++;
                                    _logger.Info($"[Manual Watchlist Sync] Added '{libraryItem.Name}' to watchlist for {user.Username}");
                                }
                            }
                            else
                            {
                                // Item not in library yet - WatchlistMonitor will automatically add it when it arrives
                                _logger.Debug($"[Manual Watchlist Sync] Item TMDB {item.TmdbId} ({item.MediaType}) not in library yet for {user.Username} - will be auto-added by WatchlistMonitor when available");
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        var errorMsg = $"Error processing user {user.Username}: {ex.Message}";
                        _logger.Error($"[Manual Watchlist Sync] {errorMsg}");
                        errors.Add(errorMsg);
                    }
                }

                _logger.Info($"[Manual Watchlist Sync] Sync complete. Processed: {itemsProcessed}, Added: {itemsAdded}");

                return Ok(new
                {
                    success = true,
                    itemsProcessed,
                    itemsAdded,
                    errors = errors.Count > 0 ? errors : null
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"[Manual Watchlist Sync] Fatal error: {ex}");
                return StatusCode(500, new { error = ex.Message });
            }
        }

        private async Task<List<WatchlistItem>?> GetJellyseerrWatchlistForUser(string userId)
        {
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
                {
                    return null;
                }

                var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

                foreach (var url in urls)
                {
                    var trimmedUrl = url.Trim();
                    try
                    {
                        var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/user/{userId}/watchlist";
                        var response = await httpClient.GetAsync(requestUri);

                        if (response.IsSuccessStatusCode)
                        {
                            var content = await response.Content.ReadAsStringAsync();
                            var json = JsonDocument.Parse(content);

                            if (json.RootElement.TryGetProperty("results", out var results))
                            {
                                var items = new List<WatchlistItem>();
                                foreach (var item in results.EnumerateArray())
                                {
                                    if (item.TryGetProperty("tmdbId", out var tmdbId) &&
                                        item.TryGetProperty("mediaType", out var mediaType))
                                    {
                                        items.Add(new WatchlistItem
                                        {
                                            TmdbId = tmdbId.GetInt32(),
                                            MediaType = mediaType.GetString() ?? "movie"
                                        });
                                    }
                                }
                                return items;
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.Warning($"Failed to get watchlist from {trimmedUrl}: {ex.Message}");
                        continue;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Error($"Error getting Jellyseerr watchlist: {ex}");
            }

            return null;
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
                var httpClient = _httpClientFactory.CreateClient();
                httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

                foreach (var url in urls)
                {
                    var trimmedUrl = url.Trim();
                    try
                    {
                        var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/request?take=500&skip=0&sort=added";
                        httpClient.DefaultRequestHeaders.Remove("X-Api-User");
                        httpClient.DefaultRequestHeaders.Add("X-Api-User", userId);

                        var response = await httpClient.GetAsync(requestUri);
                        if (!response.IsSuccessStatusCode)
                        {
                            continue;
                        }

                        var content = await response.Content.ReadAsStringAsync();
                        var json = JsonDocument.Parse(content);

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
                _logger.Error($"Error getting Jellyseerr requests: {ex}");
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

        private BaseItem? FindItemByTmdbId(int tmdbId, string mediaType)
        {
            var query = new InternalItemsQuery
            {
                HasTmdbId = true,
                IncludeItemTypes = mediaType == "tv" ? new[] { Jellyfin.Data.Enums.BaseItemKind.Series } : new[] { Jellyfin.Data.Enums.BaseItemKind.Movie }
            };

            var items = _libraryManager.GetItemList(query);
            return items.FirstOrDefault(i =>
            {
                if (i.ProviderIds != null && i.ProviderIds.TryGetValue("Tmdb", out var tmdbIdStr))
                {
                    return tmdbIdStr == tmdbId.ToString();
                }
                return false;
            });
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
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("Jellyseerr integration is not configured or enabled.");
                return Ok(new { partialRequestsEnabled = false });
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                try
                {
                    var requestUri = $"{trimmedUrl.TrimEnd('/')}/api/v1/settings/main";
                    _logger.Info($"Fetching Jellyseerr partial requests setting from: {requestUri}");

                    var response = await httpClient.GetAsync(requestUri);
                    var responseContent = await response.Content.ReadAsStringAsync();

                    if (response.IsSuccessStatusCode)
                    {
                        // Parse the full settings response but only extract the partialRequestsEnabled field
                        var settings = JsonDocument.Parse(responseContent);
                        var partialRequestsEnabled = false;
                        if (settings.RootElement.TryGetProperty("partialRequestsEnabled", out var prop))
                        {
                            partialRequestsEnabled = prop.GetBoolean();
                        }

                        _logger.Info($"Jellyseerr partial requests setting: {partialRequestsEnabled}");
                        return Ok(new { partialRequestsEnabled });
                    }

                    _logger.Warning($"Failed to fetch Jellyseerr settings. URL: {trimmedUrl}, Status: {response.StatusCode}");
                }
                catch (Exception ex)
                {
                    _logger.Error($"Failed to connect to Jellyseerr URL: {trimmedUrl}. Error: {ex.Message}");
                }
            }

            _logger.Warning("Could not fetch Jellyseerr settings from any URL, defaulting partialRequestsEnabled to false");
            return Ok(new { partialRequestsEnabled = false });
        }

        [HttpGet("tmdb/validate")]
        [Authorize]
        public async Task<IActionResult> ValidateTmdb([FromQuery] string apiKey)
        {
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                return BadRequest(new { ok = false, message = "API key is missing" });
            }

            var httpClient = _httpClientFactory.CreateClient();
            try
            {
                var requestUri = $"https://api.themoviedb.org/3/configuration?api_key={apiKey}";
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
        [HttpGet("version")]
        public ActionResult GetVersion() => Content(JellyfinEnhanced.Instance?.Version.ToString() ?? "unknown");

        [HttpGet("private-config")]
        [Authorize]
        public ActionResult GetPrivateConfig()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return StatusCode(503);
            }

            // Determine the first configured Jellyseerr URL (if any) for client-side deep links
            string jellyseerrBaseUrl = string.Empty;
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

            // Do not expose TMDB API key to clients; expose a boolean instead
            var tmdbEnabled = !string.IsNullOrWhiteSpace(config.TMDB_API_KEY);

            return new JsonResult(new
            {
                // For Jellyfin Elsewhere & Reviews (only whether configured)
                TmdbEnabled = tmdbEnabled,

                // For Arr Links
                config.SonarrUrl,
                config.RadarrUrl,
                config.BazarrUrl,
                JellyseerrBaseUrl = jellyseerrBaseUrl,
                config.JellyseerrUrlMappings
            });
        }
        [HttpGet("public-config")]
        public ActionResult GetPublicConfig()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return StatusCode(503);
            }

            return new JsonResult(new
            {
                // Jellyfin Enhanced Settings
                config.ToastDuration,
                config.HelpPanelAutocloseDelay,
                config.EnableCustomSplashScreen,
                config.SplashScreenImageUrl,

                // Jellyfin Elsewhere Settings
                config.ElsewhereEnabled,
                config.DEFAULT_REGION,
                config.DEFAULT_PROVIDERS,
                config.IGNORE_PROVIDERS,
                config.ElsewhereCustomBrandingText,
                config.ElsewhereCustomBrandingImageUrl,
                config.ClearLocalStorageTimestamp,

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
                config.ShowWatchProgress,
                config.ShowFileSizes,
                config.RemoveContinueWatchingEnabled,
                config.ShowAudioLanguages,
                config.Shortcuts,
                config.ShowReviews,
                config.ReviewsExpandedByDefault,
                config.PauseScreenEnabled,
                config.QualityTagsEnabled,
                config.GenreTagsEnabled,
                config.LanguageTagsEnabled,
                config.RatingTagsEnabled,
                config.PeopleTagsEnabled,
                config.DisableAllShortcuts,
                config.DefaultSubtitleStyle,
                config.DefaultSubtitleSize,
                config.DefaultSubtitleFont,
                config.DisableCustomSubtitleStyles,
                // Overlay positions
                config.QualityTagsPosition,
                config.GenreTagsPosition,
                config.LanguageTagsPosition,
                config.RatingTagsPosition,
                config.ShowRatingInPlayer,

                config.TagsCacheTtlDays,
                config.DisableTagsOnSearchPage,

                // Jellyseerr Search Settings
                config.JellyseerrEnabled,
                config.JellyseerrShowReportButton,
                config.JellyseerrEnable4KRequests,
                config.ShowCollectionsInSearch,
                config.JellyseerrShowAdvanced,
                config.ShowElsewhereOnJellyseerr,
                config.JellyseerrUseMoreInfoModal,
                config.AddRequestedMediaToWatchlist,
                config.SyncJellyseerrWatchlist,
                config.JellyseerrShowSimilar,
                config.JellyseerrShowRecommended,
                config.JellyseerrShowNetworkDiscovery,
                config.JellyseerrShowGenreDiscovery,
                config.JellyseerrShowTagDiscovery,
                config.JellyseerrShowPersonDiscovery,
                config.JellyseerrExcludeLibraryItems,
                config.JellyseerrExcludeRejectedItems,

                // Bookmarks Settings
                config.BookmarksEnabled,

                // Arr Links Settings
                config.ArrLinksEnabled,
                config.ShowArrLinksAsText,

                // Arr Tags Sync Settings
                config.ArrTagsSyncEnabled,
                config.ArrTagsPrefix,
                config.ArrTagsShowAsLinks,
                config.ArrTagsLinksFilter,
                config.ArrTagsLinksHideFilter,

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

                // Requests Page Settings
                config.DownloadsPageEnabled,
                config.DownloadsUsePluginPages,
                config.DownloadsPollIntervalSeconds,

                // Calendar Page Settings
                config.CalendarPageEnabled,
                config.CalendarUsePluginPages,
                config.CalendarFirstDayOfWeek,
                config.CalendarTimeFormat,
                config.CalendarHighlightFavorites,
                config.CalendarHighlightWatchedSeries,

            });
        }

        [HttpGet("tmdb/{**apiPath}")]
        [Authorize]
        public async Task<IActionResult> ProxyTmdbRequest(string apiPath)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                return StatusCode(503, "TMDB API key is not configured.");
            }

            var httpClient = _httpClientFactory.CreateClient();
            var queryString = HttpContext.Request.QueryString;
            var separator = queryString.HasValue ? "&" : "?";
            var requestUri = $"https://api.themoviedb.org/3/{apiPath}{queryString}{separator}api_key={config.TMDB_API_KEY}";

            try
            {
                var response = await httpClient.GetAsync(requestUri);
                var content = await response.Content.ReadAsStringAsync();

                if (response.IsSuccessStatusCode)
                {
                    return Content(content, "application/json");
                }

                return StatusCode((int)response.StatusCode, content);
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to proxy TMDB request. Error: {ex.Message}");
                return StatusCode(500, "Failed to connect to TMDB.");
            }
        }

        [HttpGet("locales/{lang}.json")]
        public ActionResult GetLocale(string lang)
        {
            var sanitizedLang = Path.GetFileName(lang); // Basic sanitization
            var resourcePath = $"Jellyfin.Plugin.JellyfinEnhanced.js.locales.{sanitizedLang}.json";
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourcePath);

            if (stream == null)
            {
                _logger.Warning($"Locale file not found for language: {sanitizedLang}");
                return NotFound();
            }

            return new FileStreamResult(stream, "application/json");
        }

        private ActionResult GetScriptResource(string resourcePath)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"Jellyfin.Plugin.JellyfinEnhanced.{resourcePath.Replace('/', '.')}");
            return stream == null ? NotFound() : new FileStreamResult(stream, "application/javascript");
        }

        [HttpGet("user-settings/{userId}/settings.json")]
        [Authorize]
        public IActionResult GetUserSettingsSettings(string userId)
        {
            // Populate defaults from plugin configuration if missing
            if (!_userConfigurationManager.UserConfigurationExists(userId, "settings.json"))
            {
                var defaultConfig = JellyfinEnhanced.Instance?.Configuration;
                if (defaultConfig != null)
                {
                    var defaultUserSettings = new UserSettings
                    {
                        AutoPauseEnabled = defaultConfig.AutoPauseEnabled,
                        AutoResumeEnabled = defaultConfig.AutoResumeEnabled,
                        AutoPipEnabled = defaultConfig.AutoPipEnabled,
                        LongPress2xEnabled = defaultConfig.LongPress2xEnabled,
                        PauseScreenEnabled = defaultConfig.PauseScreenEnabled,
                        AutoSkipIntro = defaultConfig.AutoSkipIntro,
                        AutoSkipOutro = defaultConfig.AutoSkipOutro,
                        DisableCustomSubtitleStyles = defaultConfig.DisableCustomSubtitleStyles,
                        SelectedStylePresetIndex = defaultConfig.DefaultSubtitleStyle,
                        SelectedFontSizePresetIndex = defaultConfig.DefaultSubtitleSize,
                        SelectedFontFamilyPresetIndex = defaultConfig.DefaultSubtitleFont,
                        RandomButtonEnabled = defaultConfig.RandomButtonEnabled,
                        RandomUnwatchedOnly = defaultConfig.RandomUnwatchedOnly,
                        RandomIncludeMovies = defaultConfig.RandomIncludeMovies,
                        RandomIncludeShows = defaultConfig.RandomIncludeShows,
                        ShowWatchProgress = defaultConfig.ShowWatchProgress,
                        WatchProgressMode = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressDefaultMode) ? "percentage" : defaultConfig.WatchProgressDefaultMode,
                        WatchProgressTimeFormat = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressTimeFormat) ? "hours" : defaultConfig.WatchProgressTimeFormat,
                        ShowFileSizes = defaultConfig.ShowFileSizes,
                        ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                        QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                        GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                        LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                        RatingTagsEnabled = defaultConfig.RatingTagsEnabled,
                        PeopleTagsEnabled = defaultConfig.PeopleTagsEnabled,
                        QualityTagsPosition = defaultConfig.QualityTagsPosition,
                        GenreTagsPosition = defaultConfig.GenreTagsPosition,
                        LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                        RatingTagsPosition = defaultConfig.RatingTagsPosition,
                        ShowRatingInPlayer = defaultConfig.ShowRatingInPlayer,
                        RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                        ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
                        CalendarDefaultViewMode = "auto",
                        LastOpenedTab = "shortcuts"
                    };

                    _userConfigurationManager.SaveUserConfiguration(userId, "settings.json", defaultUserSettings);
                    _logger.Info($"Saved default settings.json for new user {userId} from plugin configuration.");
                }
            }

            var userConfig = _userConfigurationManager.GetUserConfiguration<UserSettings>(userId, "settings.json");
            return Ok(userConfig);
        }

        [HttpGet("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        public IActionResult GetUserSettingsShortcuts(string userId)
        {
            var userConfig = _userConfigurationManager.GetUserConfiguration<UserShortcuts>(userId, "shortcuts.json");
            return Ok(userConfig);
        }

        [HttpGet("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        public IActionResult GetUserSettingsElsewhere(string userId)
        {
            var userConfig = _userConfigurationManager.GetUserConfiguration<ElsewhereSettings>(userId, "elsewhere.json");
            return Ok(userConfig);
        }

        [HttpPost("user-settings/{userId}/settings.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsSettings(string userId, [FromBody] UserSettings userConfiguration)
        {
            try
            {
                _userConfigurationManager.SaveUserConfiguration(userId, "settings.json", userConfiguration);
                _logger.Info($"Saved user settings for user {userId} to settings.json");
                return Ok(new { success = true, file = "settings.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user settings for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user settings." });
            }
        }

        [HttpPost("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsShortcuts(string userId, [FromBody] UserShortcuts userConfiguration)
        {
            try
            {
                _userConfigurationManager.SaveUserConfiguration(userId, "shortcuts.json", userConfiguration);
                _logger.Info($"Saved user shortcuts for user {userId} to shortcuts.json");
                return Ok(new { success = true, file = "shortcuts.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user shortcuts for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user shortcuts." });
            }
        }

        [HttpGet("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserBookmark(string userId)
        {
            var userConfig = _userConfigurationManager.GetUserConfiguration<UserBookmark>(userId, "bookmark.json");
            return Ok(userConfig);
        }

        [HttpPost("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserBookmark(string userId, [FromBody] UserBookmark userConfiguration)
        {
            try
            {
                _userConfigurationManager.SaveUserConfiguration(userId, "bookmark.json", userConfiguration);
                _logger.Info($"Saved enhanced bookmarks for user {userId} to bookmark.json");
                return Ok(new { success = true, file = "bookmark.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save enhanced bookmarks for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save enhanced bookmarks." });
            }
        }

        [HttpPost("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsElsewhere(string userId, [FromBody] ElsewhereSettings userConfiguration)
        {
            try
            {
                _userConfigurationManager.SaveUserConfiguration(userId, "elsewhere.json", userConfiguration);
                _logger.Info($"Saved user elsewhere settings for user {userId} to elsewhere.json");
                return Ok(new { success = true, file = "elsewhere.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user elsewhere settings for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user elsewhere settings." });
            }
        }

        [HttpPost("reset-all-users-settings")]
        [Authorize]
        public IActionResult ResetAllUsersSettings()
        {
            var defaultConfig = JellyfinEnhanced.Instance?.Configuration;

            if (defaultConfig == null)
            {
                return StatusCode(500, new { success = false, message = "Default plugin configuration not found." });
            }

            var defaultUserSettings = new UserSettings
            {
                AutoPauseEnabled = defaultConfig.AutoPauseEnabled,
                AutoResumeEnabled = defaultConfig.AutoResumeEnabled,
                AutoPipEnabled = defaultConfig.AutoPipEnabled,
                LongPress2xEnabled = defaultConfig.LongPress2xEnabled,
                PauseScreenEnabled = defaultConfig.PauseScreenEnabled,
                AutoSkipIntro = defaultConfig.AutoSkipIntro,
                AutoSkipOutro = defaultConfig.AutoSkipOutro,
                DisableCustomSubtitleStyles = defaultConfig.DisableCustomSubtitleStyles,
                SelectedStylePresetIndex = defaultConfig.DefaultSubtitleStyle,
                SelectedFontSizePresetIndex = defaultConfig.DefaultSubtitleSize,
                SelectedFontFamilyPresetIndex = defaultConfig.DefaultSubtitleFont,
                RandomButtonEnabled = defaultConfig.RandomButtonEnabled,
                RandomUnwatchedOnly = defaultConfig.RandomUnwatchedOnly,
                RandomIncludeMovies = defaultConfig.RandomIncludeMovies,
                RandomIncludeShows = defaultConfig.RandomIncludeShows,
                ShowWatchProgress = defaultConfig.ShowWatchProgress,
                ShowFileSizes = defaultConfig.ShowFileSizes,
                ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                RatingTagsEnabled = defaultConfig.RatingTagsEnabled,
                PeopleTagsEnabled = defaultConfig.PeopleTagsEnabled,
                QualityTagsPosition = defaultConfig.QualityTagsPosition,
                GenreTagsPosition = defaultConfig.GenreTagsPosition,
                LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                RatingTagsPosition = defaultConfig.RatingTagsPosition,
                ShowRatingInPlayer = defaultConfig.ShowRatingInPlayer,
                RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
                CalendarDefaultViewMode = "auto",
                LastOpenedTab = "shortcuts"
            };

            var userCount = 0;
            // Get all user IDs from the UserConfigurationManager's known users
            var userIds = _userConfigurationManager.GetAllUserIds();
            foreach (var userId in userIds)
            {
                _userConfigurationManager.SaveUserConfiguration(userId, "settings.json", defaultUserSettings);
                userCount++;
            }

            _logger.Info($"Reset settings for all {userCount} users to plugin defaults.");
            return Ok(new { success = true, userCount = userCount });
        }

        [HttpGet("file-size/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetFileSizeByItemId(Guid userId, Guid itemId)
        {
            var user = _userManager.GetUserById(userId);
            if (user is null)
            {
                return NotFound();
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var allAffectedItems = GetLeafPlayableItems(user, item);

            long totalSize = allAffectedItems
                .Sum(affectedItem => affectedItem.GetMediaSources(false).Sum(source => source.Size ?? 0));

            return Ok(new { success = true, size = totalSize });
        }

        [HttpGet("watch-progress/{userId}/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetWatchProgressByItemId(Guid userId, Guid itemId)
        {
            var user = _userManager.GetUserById(userId);
            if (user is null)
            {
                return NotFound();
            }

            var item = _libraryManager.GetItemById<BaseItem>(itemId, user);
            if (item is null)
            {
                return NotFound();
            }

            var allAffectedItems = GetLeafPlayableItems(user, item);

            long totalRuntimeTicks = allAffectedItems.Sum(affectedItem =>
                // Only one of the MediaSources should count into the watch progress
                affectedItem.GetMediaSources(false)
                    .FirstOrDefault()?.RunTimeTicks ?? 0);
            long totalPlaybackTicks = allAffectedItems.Sum(affectedItem =>
            {
                var userData = _userDataManager.GetUserData(user, affectedItem);
                if (userData is null)
                    return 0;
                if (userData.Played)
                    // PlaybackPositionTicks will be 0 after the episode is marked as watched
                    return affectedItem.RunTimeTicks ?? 0;
                return userData.PlaybackPositionTicks;
            });

            double progress = totalRuntimeTicks == 0 ? 0 : (double)totalPlaybackTicks / totalRuntimeTicks * 100;
            // Floating point numbers are not needed in the frontend ui
            int formattedProgress = (int)Math.Clamp(progress, 0, 100);

            return Ok(new { success = true, progress = formattedProgress, totalPlaybackTicks, totalRuntimeTicks });
        }

        private List<BaseItem> GetLeafPlayableItems(JUser user, BaseItem root)
        {
            var result = new List<BaseItem>();
            var visited = new HashSet<Guid>();

            void Traverse(BaseItem current)
            {
                if (!visited.Add(current.Id))
                {
                    return;
                }

                var kind = current.GetBaseItemKind();

                if (current is Folder folder)
                {
                    var children = folder.GetChildren(user, true).ToList();
                    foreach (var child in children)
                    {
                        Traverse(child);
                    }
                    return;
                }

                var mediaSources = current.GetMediaSources(false);
                if (mediaSources != null && mediaSources.Any())
                {
                    result.Add(current);
                }
            }

            Traverse(root);
            return result;
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
            var queryParts = new List<string>
            {
                $"take={take}",
                $"skip={skip}"
            };

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
                var filePath = Path.Combine(brandingDir, fileName);

                // Save file
                using (var stream = new FileStream(filePath, FileMode.Create, FileAccess.Write))
                {
                    await uploadedFile.CopyToAsync(stream);
                }

                _logger.Info($"Successfully uploaded branding image: {fileName} ({uploadedFile.Length} bytes) to {brandingDir}");
                return Ok("File uploaded successfully");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.Error($"Permission denied when uploading branding image: {ex.Message}");
                return StatusCode(403, $"Permission denied: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.Error($"Error uploading branding image: {ex.Message}");
                return StatusCode(500, $"Error: {ex.Message}");
            }
        }

        [HttpGet("BrandingImage")]
        [Authorize]
        public IActionResult GetBrandingImage([FromQuery] string? fileName)
        {
            if (string.IsNullOrWhiteSpace(fileName))
            {
                return BadRequest("fileName query parameter is required");
            }


            var brandingDir = JellyfinEnhanced.BrandingDirectory;
            if (string.IsNullOrWhiteSpace(brandingDir))
                return StatusCode(500, "Could not determine branding directory");

            var filePath = Path.Combine(brandingDir, fileName);
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
            try
            {
                string? fileName = Request.Form["fileName"].FirstOrDefault();
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    return BadRequest("fileName parameter is required in form data");
                }


                var brandingDir = JellyfinEnhanced.BrandingDirectory;
                if (string.IsNullOrWhiteSpace(brandingDir))
                    return StatusCode(500, "Could not determine branding directory");

                var filePath = Path.Combine(brandingDir, fileName);
                if (!System.IO.File.Exists(filePath))
                    return NotFound("File not found");

                System.IO.File.Delete(filePath);
                _logger.Info($"Deleted branding image: {fileName} from {brandingDir}");
                return Ok("File deleted successfully");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.Error($"Permission denied when deleting branding image: {ex.Message}");
                return StatusCode(403, $"Permission denied: {ex.Message}");
            }
            catch (Exception ex)
            {
                _logger.Error($"Error deleting branding image: {ex.Message}");
                return StatusCode(500, $"Error: {ex.Message}");
            }
        }

        // ==================== Requests Page (Sonarr/Radarr Queue) ====================

        /// <summary>
        /// Get combined download queue from Sonarr and Radarr.
        /// </summary>
        [HttpGet("arr/queue")]
        [Authorize]
        public async Task<IActionResult> GetDownloadQueue()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            var items = new List<object>();

            // Fetch Sonarr queue
            if (!string.IsNullOrWhiteSpace(config.SonarrUrl) && !string.IsNullOrWhiteSpace(config.SonarrApiKey))
            {
                try
                {
                    var sonarrUrl = config.SonarrUrl.TrimEnd('/');
                    var client = _httpClientFactory.CreateClient();
                    client.DefaultRequestHeaders.Add("X-Api-Key", config.SonarrApiKey);
                    client.Timeout = TimeSpan.FromSeconds(10);

                    var response = await client.GetAsync(
                        $"{sonarrUrl}/api/v3/queue?" +
                        $"includeEpisode=true&" +
                        $"includeSeries=true&" +
                        $"sortKey=timeleft&" +
                        $"sortDirection=ascending&" +
                        $"pageSize=1000"
                    );

                    if (response.IsSuccessStatusCode)
                    {
                        var json = await response.Content.ReadAsStringAsync();
                        var data = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic>(json);

                        if (data?.records != null)
                        {
                            foreach (var record in data.records)
                            {
                                string? posterUrl = null;
                                if (record.series?.images != null)
                                {
                                    foreach (var img in record.series.images)
                                    {
                                        if ((string?)img.coverType == "poster")
                                        {
                                            posterUrl = (string?)img.remoteUrl ?? (string?)img.url;
                                            break;
                                        }
                                    }
                                }

                                items.Add(new
                                {
                                    id = (string?)record.id?.ToString(),
                                    source = nameof(ArrType.Sonarr),
                                    title = (string?)record.series?.title ?? "Unknown",
                                    subtitle = $"S{record.episode?.seasonNumber:D2}E{record.episode?.episodeNumber:D2} - {record.episode?.title}",
                                    seasonNumber = (int?)record.episode?.seasonNumber,
                                    episodeNumber = (int?)record.episode?.episodeNumber,
                                    status = (string?)record.status ?? "Unknown",
                                    progress = CalculateProgress((double?)record.size, (double?)record.sizeleft),
                                    totalSize = (long?)record.size,
                                    sizeRemaining = (long?)record.sizeleft,
                                    timeRemaining = (string?)record.timeleft,
                                    posterUrl = posterUrl
                                });
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Failed to fetch Sonarr queue: {ex.Message}");
                }
            }

            // Fetch Radarr queue
            if (!string.IsNullOrWhiteSpace(config.RadarrUrl) && !string.IsNullOrWhiteSpace(config.RadarrApiKey))
            {
                try
                {
                    var radarrUrl = config.RadarrUrl.TrimEnd('/');
                    var client = _httpClientFactory.CreateClient();
                    client.DefaultRequestHeaders.Add("X-Api-Key", config.RadarrApiKey);
                    client.Timeout = TimeSpan.FromSeconds(10);

                    var response = await client.GetAsync($"{radarrUrl}/api/v3/queue?includeMovie=true");
                    if (response.IsSuccessStatusCode)
                    {
                        var json = await response.Content.ReadAsStringAsync();
                        var data = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic>(json);

                        if (data?.records != null)
                        {
                            foreach (var record in data.records)
                            {
                                string? posterUrl = null;
                                if (record.movie?.images != null)
                                {
                                    foreach (var img in record.movie.images)
                                    {
                                        if ((string?)img.coverType == "poster")
                                        {
                                            posterUrl = (string?)img.remoteUrl ?? (string?)img.url;
                                            break;
                                        }
                                    }
                                }

                                items.Add(new
                                {
                                    id = (string?)record.id?.ToString(),
                                    source = nameof(ArrType.Radarr),
                                    title = (string?)record.movie?.title ?? "Unknown",
                                    subtitle = (string?)record.movie?.year?.ToString(),
                                    seasonNumber = (int?)null,
                                    episodeNumber = (int?)null,
                                    status = (string?)record.status ?? "Unknown",
                                    progress = CalculateProgress((double?)record.size, (double?)record.sizeleft),
                                    totalSize = (long?)record.size,
                                    sizeRemaining = (long?)record.sizeleft,
                                    timeRemaining = (string?)record.timeleft,
                                    posterUrl = posterUrl
                                });
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Failed to fetch Radarr queue: {ex.Message}");
                }
            }

            return Ok(new { items = items });
        }

        private static double CalculateProgress(double? size, double? sizeleft)
        {
            if (size == null || size == 0) return 0;
            if (sizeleft == null) return 100;
            return Math.Round((1 - (sizeleft.Value / size.Value)) * 100, 1);
        }

        /// <summary>
        /// Get requests from Jellyseerr with pagination and filtering.
        /// </summary>
        [HttpGet("arr/requests")]
        [Authorize]
        public async Task<IActionResult> GetRequests([FromQuery] int take = 20, [FromQuery] int skip = 0, [FromQuery] string? filter = null)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            if (string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
            {
                return Ok(new { requests = new List<object>(), totalPages = 0, totalResults = 0 });
            }

            try
            {
                var jellyseerrUrl = config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)[0].Trim().TrimEnd('/');
                var client = _httpClientFactory.CreateClient();
                client.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);
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
                    _logger.Warning($"Could not find a Jellyseerr user for Jellyfin user {jellyfinUserId}. Aborting request.");
                    return NotFound(new { message = "Current Jellyfin user is not linked to a Jellyseerr user." });
                }

                // Check if user has permission to view all requests
                hasRequestViewPermission = JellyseerrPermissionHelper.HasAnyPermission(
                    jellyseerrUser.Permissions,
                    JellyseerrPermission.ADMIN | JellyseerrPermission.MANAGE_REQUESTS | JellyseerrPermission.REQUEST_VIEW
                );

                // Build filter parameter
                // "comingsoon" is a custom filter - fetch processing items and filter server-side
                var isComingSoonFilter = string.Equals(filter, "comingsoon", StringComparison.OrdinalIgnoreCase);
                var filterParam = filter?.ToLower() switch
                {
                    "pending" => "&filter=pending",
                    "approved" => "&filter=approved",
                    "available" => "&filter=available",
                    "processing" => "&filter=processing",
                    "comingsoon" => "&filter=processing", // Fetch processing, then filter for future dates
                    _ => ""
                };

                // If user lacks permission, filter to only their requests
                if (!hasRequestViewPermission)
                {
                    filterParam += $"&requestedBy={jellyseerrUser.Id}";
                }

                var response = await client.GetAsync($"{jellyseerrUrl}/api/v1/request?take={take}&skip={skip}{filterParam}");
                if (!response.IsSuccessStatusCode)
                {
                    _logger.Warning($"Jellyseerr request failed with status {response.StatusCode}");
                    return Ok(new { requests = new List<object>(), totalPages = 0, totalResults = 0 });
                }

                var json = await response.Content.ReadAsStringAsync();
                var data = JObject.Parse(json);

                var requests = new List<object>();
                var results = data["results"] as JArray;
                if (results != null)
                {
                    // Enrich all requests in parallel for better performance
                    var enrichmentTasks = results.Select(async req =>
                    {
                        var media = req["media"] as JObject;
                        var requestedBy = req["requestedBy"] as JObject;

                        int? reqStatus = req["status"]?.Value<int>();
                        int? mediaStatusVal = media?["status"]?.Value<int>();
                        string mediaStatus = GetMediaStatus(reqStatus, mediaStatusVal);

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
                            var enrichedData = await EnrichWithTmdbData(client, tmdbId.Value, type, jellyseerrUrl);
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

                        return new
                        {
                            id = req["id"]?.Value<int>(),
                            type = type,
                            title = title,
                            year = year,
                            posterUrl = posterUrl,
                            mediaStatus = mediaStatus,
                            requestedBy = displayName ?? username ?? "Unknown",
                            requestedByAvatar = avatarUrl,
                            createdAt = createdAtStr,
                            jellyfinMediaId = media?["jellyfinMediaId"]?.Value<string>(),
                            digitalReleaseDate = digitalReleaseDate,
                            theatricalReleaseDate = theatricalReleaseDate,
                            initialAirDate = initialAirDate,
                            nextAirDate = nextAirDate
                        };
                    }).ToList();

                    var enrichedRequests = await Task.WhenAll(enrichmentTasks);

                    // Apply server-side filtering for "comingsoon"
                    if (isComingSoonFilter)
                    {
                        var today = DateTime.UtcNow.Date;
                        enrichedRequests = enrichedRequests
                            .Where(r =>
                            {
                                var status = (r.mediaStatus ?? "").ToLower();
                                var itemType = r.type;

                                // For TV shows: include if has future nextAirDate
                                // (can be processing, approved, or even partially available with upcoming episodes)
                                if (itemType == "tv")
                                {
                                    var airDate = r.nextAirDate;
                                    if (!string.IsNullOrEmpty(airDate) && DateTime.TryParse(airDate, out var ad) && ad.Date > today)
                                    {
                                        // Include processing, approved, or partially available TV shows with upcoming episodes
                                        return status == "processing" || status == "approved" || status == "partially available";
                                    }
                                    return false;
                                }

                                // For movies: check digital or theatrical release dates
                                // Only include processing or approved movies
                                if (status != "processing" && status != "approved")
                                    return false;

                                var digitalDate = r.digitalReleaseDate;
                                var theatricalDate = r.theatricalReleaseDate;

                                // Check if has a future release date
                                if (!string.IsNullOrEmpty(digitalDate) && DateTime.TryParse(digitalDate, out var dd) && dd.Date > today)
                                    return true;
                                if (!string.IsNullOrEmpty(theatricalDate) && DateTime.TryParse(theatricalDate, out var td) && td.Date > today)
                                    return true;

                                return false;
                            })
                            .OrderBy(r =>
                            {
                                // Sort by the earliest future date
                                DateTime? bestDate = null;
                                var today = DateTime.UtcNow.Date;

                                // For TV shows, use nextAirDate
                                if (r.type == "tv" && !string.IsNullOrEmpty(r.nextAirDate) && DateTime.TryParse(r.nextAirDate, out var airDate) && airDate.Date > today)
                                {
                                    bestDate = airDate;
                                }
                                else
                                {
                                    // For movies, use digital or theatrical date
                                    if (!string.IsNullOrEmpty(r.digitalReleaseDate) && DateTime.TryParse(r.digitalReleaseDate, out var dd) && dd.Date > today)
                                        bestDate = dd;
                                    if (!string.IsNullOrEmpty(r.theatricalReleaseDate) && DateTime.TryParse(r.theatricalReleaseDate, out var td) && td.Date > today)
                                    {
                                        if (bestDate == null || td < bestDate)
                                            bestDate = td;
                                    }
                                }

                                return bestDate ?? DateTime.MaxValue;
                            })
                            .ToArray();
                    }

                    requests.AddRange(enrichedRequests);
                }

                var pageInfo = data["pageInfo"] as JObject;
                var totalResults = isComingSoonFilter ? requests.Count : (pageInfo?["results"]?.Value<int>() ?? 0);
                var totalPages = (int)Math.Ceiling((double)totalResults / take);

                return Ok(new
                {
                    requests = requests,
                    totalPages = totalPages,
                    totalResults = totalResults
                });
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to fetch Jellyseerr requests: {ex.Message}");
                return Ok(new { requests = new List<object>(), totalPages = 0, totalResults = 0 });
            }
        }

        /// <summary>
        /// Get calendar events from Sonarr and Radarr for upcoming releases
        /// </summary>
        [HttpGet("arr/calendar")]
        [Authorize]
        public async Task<IActionResult> GetCalendarEvents()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
                return StatusCode(500, "Plugin configuration not available");

            var events = new List<ArrItem>();

            var todayUtc = DateTime.UtcNow.Date;
            DateTime startDate = todayUtc;
            DateTime endDate = todayUtc.AddDays(90);

            if (Request.Query.TryGetValue("start", out var startValues))
            {
                if (DateTime.TryParse(startValues.ToString(), out var parsedStart))
                {
                    startDate = parsedStart.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(parsedStart, DateTimeKind.Utc) : parsedStart.ToUniversalTime();
                }
            }

            if (Request.Query.TryGetValue("end", out var endValues))
            {
                if (DateTime.TryParse(endValues.ToString(), out var parsedEnd))
                {
                    endDate = parsedEnd.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(parsedEnd, DateTimeKind.Utc) : parsedEnd.ToUniversalTime();
                }
            }

            if (endDate < startDate)
            {
                (startDate, endDate) = (endDate, startDate);
            }

            var startIso = startDate.ToUniversalTime().ToString("o");
            var endIso = endDate.ToUniversalTime().ToString("o");

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

            void AddRelease(Dictionary<string, DateTime> releases, string type, object? value)
            {
                var parsed = ParseDate(value);
                if (!parsed.HasValue)
                {
                    return;
                }

                if (!releases.TryGetValue(type, out var existing) || parsed.Value < existing)
                {
                    releases[type] = parsed.Value;
                }
            }

            // Fetch Sonarr calendar events
            if (!string.IsNullOrWhiteSpace(config.SonarrUrl) && !string.IsNullOrWhiteSpace(config.SonarrApiKey))
            {
                try
                {
                    var sonarrUrl = config.SonarrUrl.TrimEnd('/');
                    var client = _httpClientFactory.CreateClient();
                    client.DefaultRequestHeaders.Add("X-Api-Key", config.SonarrApiKey);
                    client.Timeout = TimeSpan.FromSeconds(30);

                    var response = await client.GetAsync($"{sonarrUrl}/api/v3/calendar?includeSeries=true&start={startIso}&end={endIso}");
                    if (response.IsSuccessStatusCode)
                    {
                        var json = await response.Content.ReadAsStringAsync();
                        var data = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic>(json);

                        if (data != null)
                        {
                            foreach (var episode in data)
                            {
                                var airDate = ParseDate((string?)episode.airDateUtc ?? (string?)episode.airDate);
                                if (!airDate.HasValue)
                                {
                                    continue;
                                }

                                var seriesId = (int?)episode.seriesId;
                                var seriesTitle = "Unknown Series";
                                int? seriesTvdbId = null;
                                string? seriesImdbId = null;

                                seriesTitle = episode.series.title;
                                seriesTvdbId = episode.series.tvdbId;
                                seriesImdbId = episode.series.imdbId;

                                var seasonNumber = (int?)episode.seasonNumber ?? 0;
                                var episodeNumber = (int?)episode.episodeNumber ?? 0;
                                var episodeTitle = (string?)episode.title ?? "Unknown Episode";

                                events.Add(new ArrItem
                                {
                                    Id = (string?)episode.id?.ToString(),
                                    Source = nameof(ArrType.Sonarr),
                                    Type = "Series",
                                    Title = seriesTitle,
                                    Subtitle = $"S{seasonNumber:D2}E{episodeNumber:D2} - {episodeTitle}",
                                    ReleaseDate = airDate.Value.ToUniversalTime().ToString("o"),
                                    ReleaseType = "Episode",
                                    HasFile = (bool?)episode.hasFile ?? false,
                                    Monitored = (bool?)episode.monitored ?? false,
                                    SeriesId = seriesId,
                                    SeasonNumber = seasonNumber,
                                    EpisodeNumber = episodeNumber,
                                    EpisodeTitle = episodeTitle,
                                    Overview = (string?)episode.overview,
                                    TvdbId = seriesTvdbId,
                                    ImdbId = seriesImdbId,
                                    EpisodeTvdbId = (int?)episode.tvdbId,
                                    EpisodeImdbId = (string?)episode.imdbId
                                });
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Failed to fetch Sonarr calendar: {ex.Message}");
                }
            }

            // Fetch Radarr calendar events
            if (!string.IsNullOrWhiteSpace(config.RadarrUrl) && !string.IsNullOrWhiteSpace(config.RadarrApiKey))
            {
                try
                {
                    var radarrUrl = config.RadarrUrl.TrimEnd('/');
                    var client = _httpClientFactory.CreateClient();
                    client.DefaultRequestHeaders.Add("X-Api-Key", config.RadarrApiKey);
                    client.Timeout = TimeSpan.FromSeconds(10);

                    var response = await client.GetAsync($"{radarrUrl}/api/v3/calendar?start={startIso}&end={endIso}");
                    if (response.IsSuccessStatusCode)
                    {
                        var json = await response.Content.ReadAsStringAsync();
                        var data = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic>(json);

                        if (data != null)
                        {
                            foreach (var movie in data)
                            {
                                var releaseDates = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

                                string? posterUrl = null;
                                if (movie.images != null)
                                {
                                    foreach (var img in movie.images)
                                    {
                                        if ((string?)img.coverType == "poster")
                                        {
                                            posterUrl = (string?)img.remoteUrl ?? (string?)img.url;
                                            break;
                                        }
                                    }
                                }

                                AddRelease(releaseDates, "CinemaRelease", (string?)movie.inCinemas);
                                AddRelease(releaseDates, "PhysicalRelease", (string?)movie.physicalRelease);
                                AddRelease(releaseDates, "DigitalRelease", (string?)movie.digitalRelease);

                                if (movie.releases != null)
                                {
                                    foreach (var release in movie.releases)
                                    {
                                        var releaseDate = (object?)release.releaseDate ?? release.date;
                                        var type = Convert.ToString(release.type)?.ToLowerInvariant();
                                        var isPhysical = (bool?)release.isPhysical ?? false;

                                        if (isPhysical)
                                        {
                                            AddRelease(releaseDates, "PhysicalRelease", releaseDate);
                                        }
                                        else if (type == "digital")
                                        {
                                            AddRelease(releaseDates, "DigitalRelease", releaseDate);
                                        }
                                        else if (type == "theatrical" || type == "cinema" || type == "theater")
                                        {
                                            AddRelease(releaseDates, "CinemaRelease", releaseDate);
                                        }
                                    }
                                }

                                if (releaseDates.Count == 0)
                                {
                                    continue;
                                }

                                var movieTitle = (string?)movie.title ?? (string?)movie.originalTitle ?? "Unknown";
                                string? movieYear = null;
                                var yearValue = (object?)movie.year;
                                if (yearValue != null)
                                {
                                    movieYear = Convert.ToString(yearValue);
                                }

                                foreach (var kvp in releaseDates)
                                {
                                    // Only include releases within the requested date range
                                    var releaseUtc = kvp.Value.ToUniversalTime();
                                    if (releaseUtc < startDate || releaseUtc > endDate)
                                    {
                                        continue;
                                    }

                                    events.Add(new ArrItem
                                    {
                                        Id = $"{movie.id}-{kvp.Key}",
                                        Source = nameof(ArrType.Radarr),
                                        Type = "Movie",
                                        Title = movieTitle,
                                        Subtitle = movieYear,
                                        ReleaseDate = releaseUtc.ToString("o"),
                                        ReleaseType = kvp.Key,
                                        HasFile = (bool?)movie.hasFile ?? false,
                                        Monitored = (bool?)movie.monitored ?? false,
                                        PosterUrl = posterUrl,
                                        TmdbId = (int?)movie.tmdbId,
                                        ImdbId = (string?)movie.imdbId
                                    });
                                }
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Failed to fetch Radarr calendar: {ex.Message}");
                }
            }

            return Ok(new { events = events });
        }

        /// <summary>
        /// Check watched/favorite status for specific calendar events (optimized - only checks provided events)
        /// </summary>
        [HttpPost("arr/calendar/user-data")]
        [Authorize]
        public IActionResult GetCalendarUserDataForEvents([FromBody] CalendarUserDataRequest request)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null)
                return Unauthorized("User not found");

            var user = _userManager.GetUserById(userId.Value);
            if (user == null)
                return Unauthorized("User not found");

            var results = new List<object>();

            try
            {
                if (request?.Events == null || request.Events.Count == 0)
                    return Ok(new { results = results });

                // Build lookup by searching for each unique title (much faster than getting all items)
                var seriesLookup = new Dictionary<string, MediaBrowser.Controller.Entities.TV.Series>();
                var movieLookup = new Dictionary<string, MediaBrowser.Controller.Entities.BaseItem>();

                // Get unique series titles and their provider IDs
                var seriesEvents = request.Events.Where(e => e.Type == "Series" && !string.IsNullOrEmpty(e.Title)).ToList();
                var uniqueSeriesTitles = seriesEvents.Select(e => e.Title!).Distinct().ToList();

                foreach (var title in uniqueSeriesTitles)
                {
                    var searchResults = _libraryManager.GetItemList(new MediaBrowser.Controller.Entities.InternalItemsQuery
                    {
                        User = user,
                        IncludeItemTypes = new[] { Jellyfin.Data.Enums.BaseItemKind.Series },
                        SearchTerm = title,
                        Recursive = true,
                        Limit = 5
                    });

                    foreach (var item in searchResults)
                    {
                        if (item is MediaBrowser.Controller.Entities.TV.Series series)
                        {
                            var providerIds = series.ProviderIds ?? new Dictionary<string, string>();
                            providerIds.TryGetValue("Tvdb", out var tvdbId);
                            providerIds.TryGetValue("Imdb", out var imdbId);

                            if (tvdbId != null) seriesLookup[$"tvdb:{tvdbId}"] = series;
                            if (imdbId != null) seriesLookup[$"imdb:{imdbId}"] = series;
                        }
                    }
                }

                // Get unique movie titles
                var movieEvents = request.Events.Where(e => e.Type == "Movie" && !string.IsNullOrEmpty(e.Title)).ToList();
                var uniqueMovieTitles = movieEvents.Select(e => e.Title!).Distinct().ToList();

                foreach (var title in uniqueMovieTitles)
                {
                    var searchResults = _libraryManager.GetItemList(new MediaBrowser.Controller.Entities.InternalItemsQuery
                    {
                        User = user,
                        IncludeItemTypes = new[] { Jellyfin.Data.Enums.BaseItemKind.Movie },
                        SearchTerm = title,
                        Recursive = true,
                        Limit = 5
                    });

                    foreach (var item in searchResults)
                    {
                        var providerIds = item.ProviderIds ?? new Dictionary<string, string>();
                        providerIds.TryGetValue("Tmdb", out var tmdbId);
                        providerIds.TryGetValue("Imdb", out var imdbId);

                        if (tmdbId != null) movieLookup[$"tmdb:{tmdbId}"] = item;
                        if (imdbId != null) movieLookup[$"imdb:{imdbId}"] = item;
                    }
                }

                // Pre-fetch episodes for all series at once (one query per series, cached)
                var seriesEpisodesCache = new Dictionary<Guid, List<MediaBrowser.Controller.Entities.BaseItem>>();
                foreach (var series in seriesLookup.Values.Distinct())
                {
                    var episodes = _libraryManager.GetItemList(new MediaBrowser.Controller.Entities.InternalItemsQuery
                    {
                        User = user,
                        AncestorIds = new[] { series.Id },
                        IncludeItemTypes = new[] { Jellyfin.Data.Enums.BaseItemKind.Episode },
                        Recursive = true
                    });
                    seriesEpisodesCache[series.Id] = episodes.ToList();
                }

                // Process each event using cached data
                foreach (var evt in request.Events)
                {
                    bool isFavorite = false;
                    bool isWatched = false;

                    if (evt.Type == "Series")
                    {
                        // Find matching series
                        MediaBrowser.Controller.Entities.TV.Series? series = null;
                        if (evt.TvdbId.HasValue && seriesLookup.TryGetValue($"tvdb:{evt.TvdbId}", out var s1)) series = s1;
                        else if (!string.IsNullOrEmpty(evt.ImdbId) && seriesLookup.TryGetValue($"imdb:{evt.ImdbId}", out var s2)) series = s2;

                        if (series != null)
                        {
                            var seriesData = _userDataManager.GetUserData(user, series);
                            isFavorite = seriesData?.Likes == true;

                            // Find specific episode from cache
                            if (evt.SeasonNumber.HasValue && evt.EpisodeNumber.HasValue && seriesEpisodesCache.TryGetValue(series.Id, out var episodes))
                            {
                                var episode = episodes.FirstOrDefault(ep =>
                                    ep is MediaBrowser.Controller.Entities.TV.Episode e &&
                                    e.ParentIndexNumber == evt.SeasonNumber.Value &&
                                    e.IndexNumber == evt.EpisodeNumber.Value);

                                if (episode != null)
                                {
                                    var epData = _userDataManager.GetUserData(user, episode);
                                    isWatched = epData?.Played == true || (epData?.PlaybackPositionTicks ?? 0) > 0;
                                }
                            }
                        }
                    }
                    else if (evt.Type == "Movie")
                    {
                        MediaBrowser.Controller.Entities.BaseItem? movie = null;
                        if (evt.TmdbId.HasValue && movieLookup.TryGetValue($"tmdb:{evt.TmdbId}", out var m1)) movie = m1;
                        else if (!string.IsNullOrEmpty(evt.ImdbId) && movieLookup.TryGetValue($"imdb:{evt.ImdbId}", out var m2)) movie = m2;

                        if (movie != null)
                        {
                            var movieData = _userDataManager.GetUserData(user, movie);
                            isFavorite = movieData?.Likes == true;
                            isWatched = movieData?.Played == true || (movieData?.PlaybackPositionTicks ?? 0) > 0;
                        }
                    }

                    results.Add(new
                    {
                        id = evt.Id,
                        isFavorite = isFavorite,
                        isWatched = isWatched
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to get calendar user data: {ex.Message}");
            }

            return Ok(new { results = results });
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
            public int? TvdbId { get; set; }
            public string? ImdbId { get; set; }
            public int? TmdbId { get; set; }
            public int? SeasonNumber { get; set; }
            public int? EpisodeNumber { get; set; }
        }

        /// <summary>
        /// Fetch metadata from Jellyseerr's TMDB integration.
        /// For movies: title, year, poster, digitalReleaseDate, theatricalReleaseDate
        /// For TV shows: title, year, poster, initialAirDate (first air date), nextAirDate (next episode air date)
        /// </summary>
        private async Task<(string? Title, int? Year, string? PosterUrl, string? DigitalReleaseDate, string? TheatricalReleaseDate, string? InitialAirDate, string? NextAirDate)> EnrichWithTmdbData(HttpClient client, int tmdbId, string type, string jellyseerrUrl)
        {
            try
            {
                var endpoint = type == "movie" ? "movie" : "tv";
                var response = await client.GetAsync($"{jellyseerrUrl}/api/v1/{endpoint}/{tmdbId}");

                if (response.IsSuccessStatusCode)
                {
                    var content = await response.Content.ReadAsStringAsync();
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

                        // Try to get release dates from releaseDates object (which contains releases.results array)
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
                                            // Type 4 = Digital, Type 5 = Physical, Type 3 = Theatrical
                                            if (releaseType == 4 && release.TryGetProperty("release_date", out var digitalDateProp))
                                            {
                                                var dateStr = digitalDateProp.GetString();
                                                if (!string.IsNullOrEmpty(dateStr))
                                                {
                                                    // Keep the earliest digital release date we find
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

                    return (title, year, posterUrl, digitalReleaseDate, theatricalReleaseDate, initialAirDate, nextAirDate);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Failed to enrich request with TMDB data: {ex.Message}");
            }

            return (null, null, null, null, null, null, null);
        }

        private static string GetMediaStatus(int? requestStatus, int? mediaStatus)
        {
            // Jellyseerr media status values
            // 1 = Unknown, 2 = Pending, 3 = Processing, 4 = Partially Available, 5 = Available
            if (mediaStatus == 5) return "Available";
            if (mediaStatus == 4) return "Partially Available";
            if (mediaStatus == 3) return "Processing";
            if (requestStatus == 2) return "Approved";
            if (requestStatus == 3) return "Declined";
            if (requestStatus == 1) return "Pending";
            return "Processing";
        }

        /// <summary>
        /// Proxy avatar images from Jellyseerr to avoid CORS/mixed content issues.
        /// </summary>
        [HttpGet("proxy/avatar")]
        [AllowAnonymous]
        public async Task<IActionResult> ProxyAvatar([FromQuery] string path)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(path))
            {
                return NotFound();
            }

            try
            {
                var jellyseerrUrl = config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)[0].Trim().TrimEnd('/');
                var client = _httpClientFactory.CreateClient();
                var url = $"{jellyseerrUrl}{path}";

                var response = await client.GetAsync(url);
                if (!response.IsSuccessStatusCode)
                {
                    return NotFound();
                }

                var content = await response.Content.ReadAsByteArrayAsync();
                var contentType = response.Content.Headers.ContentType?.MediaType ?? "image/jpeg";

                return File(content, contentType);
            }
            catch
            {
                return NotFound();
            }
        }

        /// <summary>
        /// Retrieves the first matching item ID for the specified provider IDs.
        /// If multiple items match, the item with the most matching providers is returned.
        /// </summary>
        /// <param name="providers">A dictionary of provider names and their corresponding IDs (e.g., "Imdb" => "tt123456"). Keys are case-insensitive.</param>
        /// <returns>The first matching item GUID, or null if no item matches the provided providers.</returns>
        [Authorize]
        [HttpGet("items/by-providers")]
        public ActionResult<Guid?> GetItemIdByProviders([FromQuery] Dictionary<string, string>? providers)
        {
            var itemIds = _itemRepository.GetItemIdsByProviders(providers);

            if (itemIds.Count == 0)
                return BadRequest("No provider ids supplied or no items found");

            return Ok(itemIds.FirstOrDefault());
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
    /// <summary>
    /// Helper class for TMDB person data enrichment
    /// </summary>
    public class TmdbPersonData
    {
        public DateTime? BirthDate { get; set; }
        public DateTime? DeathDate { get; set; }
        public string? BirthPlace { get; set; }
    }
}
