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
using Microsoft.AspNetCore.Http;

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

        public JellyfinEnhancedController(IHttpClientFactory httpClientFactory, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
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
                        var usersResponse = JsonSerializer.Deserialize<JsonElement>(content);
                        if (usersResponse.TryGetProperty("results", out var usersArray))
                        {
                            var users = JsonSerializer.Deserialize<List<JellyseerrUser>>(usersArray.ToString());
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
        public async Task<IActionResult> ValidateJellyseerr([FromQuery] string url, [FromQuery] string apiKey)
        {
            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(apiKey))
                return BadRequest(new { ok = false, message = "Missing url or apiKey" });

            var http = _httpClientFactory.CreateClient();
            http.DefaultRequestHeaders.Clear();
            http.DefaultRequestHeaders.Add("X-Api-Key", apiKey);

            try
            {
                var resp = await http.GetAsync($"{url.TrimEnd('/')}/api/v1/status");
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
        public async Task<IActionResult> GetJellyseerrUserStatus()
        {
            // First check active status
            var activeResult = await GetJellyseerrStatus() as OkObjectResult;
            bool active = false;
            if (activeResult?.Value is not null)
            {
                var json = JsonSerializer.Serialize(activeResult.Value);
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
        public Task<IActionResult> JellyseerrSearch([FromQuery] string query)
        {
            return ProxyJellyseerrRequest($"/api/v1/search?query={Uri.EscapeDataString(query)}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request")]
        public async Task<IActionResult> JellyseerrRequest([FromBody] JsonElement requestBody)
        {
            return await ProxyJellyseerrRequest("/api/v1/request", HttpMethod.Post, requestBody.ToString());
        }
        [HttpGet("jellyseerr/tv/{tmdbId}")]
        public Task<IActionResult> GetTvShow(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}", HttpMethod.Get);
        }

        [HttpGet("jellyseerr/tv/{tmdbId}/seasons")]
        public Task<IActionResult> GetTvSeasons(int tmdbId)
        {
            return ProxyJellyseerrRequest($"/api/v1/tv/{tmdbId}/seasons", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request/tv/{tmdbId}/seasons")]
        public async Task<IActionResult> RequestTvSeasons(int tmdbId, [FromBody] JsonElement requestBody)
        {
            return await ProxyJellyseerrRequest($"/api/v1/request", HttpMethod.Post, requestBody.ToString());
        }
        [HttpGet("script")]
        public ActionResult GetMainScript() => GetScriptResource("js/plugin.js");
        [HttpGet("js/{**path}")]
        public ActionResult GetScript(string path) => GetScriptResource($"js/{path}");
        [HttpGet("version")]
        public ActionResult GetVersion() => Content(JellyfinEnhanced.Instance?.Version.ToString() ?? "unknown");

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
                config.AutoskipInterval,

                // Jellyfin Elsewhere Settings
                config.TMDB_API_KEY,
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
                config.RandomButtonEnabled,
                config.RandomIncludeMovies,
                config.RandomIncludeShows,
                config.RandomUnwatchedOnly,
                config.ShowFileSizes,
                config.RemoveContinueWatchingEnabled,
                config.ShowAudioLanguages,
                config.Shortcuts,
                config.PauseScreenEnabled,
                config.QualityTagsEnabled,

                // Jellyseerr Search Settings
                config.JellyseerrEnabled,

                // Arr Links Settings
                config.ArrLinksEnabled,
                config.SonarrUrl,
                config.RadarrUrl,
                config.BazarrUrl,
                config.ShowArrLinksAsText
            });
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
    }
}