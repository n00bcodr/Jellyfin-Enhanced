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
using Newtonsoft.Json.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    public class JellyseerrUser
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("jellyfinUserId")]
        public string? JellyfinUserId { get; set; }
    }

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

        public JellyfinEnhancedController(IHttpClientFactory httpClientFactory, Logger logger, IUserManager userManager, IUserDataManager userDataManager, ILibraryManager libraryManager, IDtoService dtoService, UserConfigurationManager userConfigurationManager)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
            _userManager = userManager;
            _userDataManager = userDataManager;
            _libraryManager = libraryManager;
            _dtoService = dtoService;
            _userConfigurationManager = userConfigurationManager;
        }

        private async Task<string?> GetJellyseerrUserId(string jellyfinUserId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || string.IsNullOrEmpty(config.JellyseerrUrls) || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                _logger.Warning("Jellyseerr configuration is missing. Cannot look up user ID.");
                return null;
            }

            _logger.Info($"Attempting to find Jellyseerr user for Jellyfin User ID: {jellyfinUserId}");
            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            foreach (var url in urls)
            {
                try
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/user?take=1000"; // Fetch all users to find a match
                    _logger.Info($"Requesting users from Jellyseerr URL: {requestUri}");
                    var response = await httpClient.GetAsync(requestUri);

                    if (response.IsSuccessStatusCode)
                    {
                        var content = await response.Content.ReadAsStringAsync();
                        var usersResponse = System.Text.Json.JsonSerializer.Deserialize<JsonElement>(content);
                        if (usersResponse.TryGetProperty("results", out var usersArray))
                        {
                            var users = System.Text.Json.JsonSerializer.Deserialize<List<JellyseerrUser>>(usersArray.ToString());
                            _logger.Info($"Found {users?.Count ?? 0} users at {url.Trim()}");
                            var user = users?.FirstOrDefault(u => string.Equals(u.JellyfinUserId, jellyfinUserId, StringComparison.OrdinalIgnoreCase));
                            if (user != null)
                            {
                                _logger.Info($"Found Jellyseerr user ID {user.Id} for Jellyfin user ID {jellyfinUserId} at {url.Trim()}");
                                return user.Id.ToString();
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

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                try
                {
                    var requestUri = $"{trimmedUrl.TrimEnd('/')}{apiPath}";
                    _logger.Info($"Proxying Jellyseerr request for user {jellyfinUserId} to: {requestUri}");

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
                        _logger.Info($"Successfully received response from Jellyseerr for user {jellyfinUserId}. Status: {response.StatusCode}");
                        return Content(responseContent, "application/json");
                    }

                    _logger.Warning($"Request to Jellyseerr for user {jellyfinUserId} failed. URL: {trimmedUrl}, Status: {response.StatusCode}, Response: {responseContent}");
                    // Try to parse the error as JSON, if it fails, create a new JSON error object.
                    try
                    {
                        JsonDocument.Parse(responseContent);
                        return StatusCode((int)response.StatusCode, responseContent);
                    }
                    catch (JsonException)
                    {
                        // The response was not valid JSON (e.g., HTML error page), so we create a standard error object.
                        var errorResponse = new { message = $"Upstream error from Jellyseerr: {response.ReasonPhrase}" };
                        return StatusCode((int)response.StatusCode, errorResponse);
                    }
                }
                catch (Exception ex)
                {
                    _logger.Error($"Failed to connect to Jellyseerr URL for user {jellyfinUserId}: {trimmedUrl}. Error: {ex.Message}");
                }
            }

            return StatusCode(500, "Could not connect to any configured Jellyseerr instance.");
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
                        _logger.Info($"Successfully connected to Jellyseerr at {url}. Status is active.");
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

        [HttpGet("jellyseerr/tv/{tmdbId}/seasons")]
        [Authorize]
        public Task<IActionResult> GetTvSeasons(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/seasons", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/overrideRule")]
        [Authorize]
        public Task<IActionResult> GetOverrideRules()
        {
            return ProxyJellyseerrRequest("/api/v1/overrideRule", HttpMethod.Get);
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
                JellyseerrBaseUrl = jellyseerrBaseUrl
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
                config.DisableAllShortcuts,
                config.DefaultSubtitleStyle,
                config.DefaultSubtitleSize,
                config.DefaultSubtitleFont,
                config.DisableCustomSubtitleStyles,
                // Overlay positions
                config.QualityTagsPosition,
                config.GenreTagsPosition,
                config.LanguageTagsPosition,

                // Jellyseerr Search Settings
                config.JellyseerrEnabled,
                config.JellyseerrEnable4KRequests,
                config.JellyseerrShowAdvanced,
                config.ShowElsewhereOnJellyseerr,
                config.JellyseerrUseJellyseerrLinks,

                // Arr Links Settings
                config.ArrLinksEnabled,
                config.ShowArrLinksAsText,

                config.WatchlistEnabled,
                config.KefinTweaksVersion
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

        [HttpPost("watchlist")]
        public async Task<QueryResult<BaseItemDto>?> GetWatchlist()
        {
            using var reader = new StreamReader(Request.Body);
            var rawJson = await reader.ReadToEndAsync();

            JObject data = JObject.Parse(rawJson);
            var userId = Guid.Parse(data["UserId"]?.ToString() ?? string.Empty);
            if (userId == Guid.Empty)
            {
                return null;
            }
            var user = _userManager.GetUserById(userId);
            if (user == null)
            {
                return new QueryResult<BaseItemDto>
                {
                    TotalRecordCount = 0,
                    Items = []
                };
            }

            var likedItems = _libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series, BaseItemKind.Season, BaseItemKind.Episode]
            }).Where(i =>
            {
                var userData = _userDataManager.GetUserData(user, i);
                return userData?.Likes == true;
            });
            var dtoOptions = new DtoOptions
            {
                Fields = new List<ItemFields>
                {
                    ItemFields.PrimaryImageAspectRatio
                },
                ImageTypeLimit = 1,
                ImageTypes = new List<ImageType>
                {
                    ImageType.Thumb,
                    ImageType.Backdrop,
                    ImageType.Primary,
                }
            };
            var items = _dtoService.GetBaseItemDtos(likedItems.ToList(), dtoOptions, user);
            return new QueryResult<BaseItemDto>
            {
                TotalRecordCount = items.Count,
                Items = items
            };
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
                        ShowFileSizes = defaultConfig.ShowFileSizes,
                        ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                        QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                        GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                        LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                        QualityTagsPosition = defaultConfig.QualityTagsPosition,
                        GenreTagsPosition = defaultConfig.GenreTagsPosition,
                        LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                        RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                        ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
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

        [HttpGet("user-settings/{userId}/bookmarks.json")]
        [Authorize]
        public IActionResult GetUserSettingsBookmarks(string userId)
        {
            var userConfig = _userConfigurationManager.GetUserConfiguration<UserBookmarks>(userId, "bookmarks.json");
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

        [HttpPost("user-settings/{userId}/bookmarks.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsBookmarks(string userId, [FromBody] UserBookmarks userConfiguration)
        {
            try
            {
                _userConfigurationManager.SaveUserConfiguration(userId, "bookmarks.json", userConfiguration);
                _logger.Info($"Saved user bookmarks for user {userId} to bookmarks.json");
                return Ok(new { success = true, file = "bookmarks.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save user bookmarks for user {userId}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user bookmarks." });
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
            var users = _userManager.Users;
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
                ShowFileSizes = defaultConfig.ShowFileSizes,
                ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                QualityTagsPosition = defaultConfig.QualityTagsPosition,
                GenreTagsPosition = defaultConfig.GenreTagsPosition,
                LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
                LastOpenedTab = "shortcuts"
            };

            foreach (var user in users)
            {
                _userConfigurationManager.SaveUserConfiguration(user.Id.ToString("N"), "settings.json", defaultUserSettings);
            }

            _logger.Info($"Reset settings for all {users.Count()} users to plugin defaults.");
            return Ok(new { success = true, userCount = users.Count() });
        }
    }
}