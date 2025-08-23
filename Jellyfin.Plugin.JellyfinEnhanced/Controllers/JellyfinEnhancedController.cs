using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using System;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    public class JellyseerrUser
    {
        [JsonPropertyName("id")]
        public int Id { get; set; }

        [JsonPropertyName("jellyfinUserId")]
        public string JellyfinUserId { get; set; }

        [JsonPropertyName("username")]
        public string Username { get; set; }
    }

    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JellyfinEnhancedController : ControllerBase
    {
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly ILogger<JellyfinEnhancedController> _logger;

        public JellyfinEnhancedController(IHttpClientFactory httpClientFactory, ILogger<JellyfinEnhancedController> logger)
        {
            _httpClientFactory = httpClientFactory;
            _logger = logger;
        }

        [HttpGet("script")]
        [Produces("application/javascript")]
        public ActionResult GetScript()
        {
            var stream = Assembly.GetExecutingAssembly()
                .GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.plugin.js");

            if (stream == null)
            {
                return NotFound();
            }

            return new FileStreamResult(stream, "application/javascript");
        }

        [HttpGet("version")]
        [Produces("text/plain")]
        public ActionResult GetVersion()
        {
            var version = JellyfinEnhanced.Instance?.Version.ToString() ?? "unknown";
            return Content(version);
        }

        [HttpGet("public-config")]
        [Produces("application/json")]
        public ActionResult GetPublicConfig()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null)
            {
                return StatusCode(503, "Configuration not available.");
            }

            var publicConfig = new
            {
                JellyseerrEnabled = config.JellyseerrEnabled
            };

            return new JsonResult(publicConfig);
        }
        private async Task<IActionResult> ProxyJellyseerrRequest(string apiPath, HttpMethod method, string? content = null, bool isUserRequest = false)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                return StatusCode(503, "Jellyseerr integration is not configured or enabled.");
            }

            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Add("X-Api-Key", config.JellyseerrApiKey);

            foreach (var url in urls)
            {
                var trimmedUrl = url.Trim();
                try
                {
                    var requestUri = $"{trimmedUrl}{apiPath}";
                     if (!isUserRequest)
                    {
                        _logger.LogInformation("[JELLYSEERR PROXY] Attempting request to: {RequestUri}", requestUri);
                    }

                    var request = new HttpRequestMessage(method, requestUri);

                    if (content != null)
                    {
                        request.Content = new StringContent(content, Encoding.UTF8, "application/json");
                    }

                    var response = await httpClient.SendAsync(request);
                    var responseContent = await response.Content.ReadAsStringAsync();

                    if (response.IsSuccessStatusCode)
                    {
                        if (!isUserRequest)
                        {
                            _logger.LogInformation("[JELLYSEERR PROXY] Successful response from {Url}", trimmedUrl);
                        }
                        return Content(responseContent, "application/json");
                    }

                    if (!isUserRequest)
                    {
                        _logger.LogWarning("Request to Jellyseerr URL {Url} failed with status {StatusCode}. Response: {Response}", trimmedUrl, response.StatusCode, responseContent);
                    }
                }
                catch (Exception ex)
                {
                     if (!isUserRequest)
                    {
                        _logger.LogError(ex, "Failed to connect to Jellyseerr URL: {Url}", trimmedUrl);
                    }
                    continue;
                }
            }
             if (!isUserRequest)
            {
                _logger.LogError("Could not connect to any configured Jellyseerr instance.");
            }
            return StatusCode(500, "Could not connect to any configured Jellyseerr instance.");
        }

        [HttpGet("jellyseerr/search")]
        public Task<IActionResult> JellyseerrSearch([FromQuery] string query)
        {
            return ProxyJellyseerrRequest($"/api/v1/search?query={Uri.EscapeDataString(query)}", HttpMethod.Get);
        }

        [HttpPost("jellyseerr/request")]
        public async Task<IActionResult> JellyseerrRequest([FromBody] JsonElement requestBody)
        {
            if (!requestBody.TryGetProperty("jellyfinUserId", out var jellyfinUserIdElement) || string.IsNullOrEmpty(jellyfinUserIdElement.GetString()))
            {
                _logger.LogWarning("[JELLYSEERR PROXY] Request received without a jellyfinUserId.");
                return BadRequest("jellyfinUserId is required.");
            }
            var jellyfinUserId = jellyfinUserIdElement.GetString();
            _logger.LogInformation($"[JELLYSEERR PROXY] Received request for Jellyfin user ID: {jellyfinUserId}");

            try
            {
                var jellyseerrUsersResponse = await ProxyJellyseerrRequest("/api/v1/user?take=1000", HttpMethod.Get, null, true);

                if (jellyseerrUsersResponse is ContentResult contentResult && !string.IsNullOrEmpty(contentResult.Content))
                {
                    var users = JsonSerializer.Deserialize<JsonElement>(contentResult.Content);
                    if (users.TryGetProperty("results", out var userResults))
                    {
                        var userList = JsonSerializer.Deserialize<List<JellyseerrUser>>(userResults.ToString(), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                        var jellyseerrUser = userList?.FirstOrDefault(u => u.JellyfinUserId == jellyfinUserId);

                        if (jellyseerrUser != null)
                        {
                            _logger.LogInformation($"[JELLYSEERR PROXY] Found matching Jellyseerr user ID: {jellyseerrUser.Id} for Jellyfin user ID: {jellyfinUserId}");

                            var originalRequest = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(requestBody.ToString());
                            var newRequest = new Dictionary<string, object>();
                            foreach(var prop in originalRequest)
                            {
                                if (prop.Key != "jellyfinUserId")
                                {
                                    newRequest[prop.Key] = prop.Value;
                                }
                            }
                            newRequest["userId"] = jellyseerrUser.Id;
                            if (!newRequest.ContainsKey("is4k"))
                            {
                                newRequest["is4k"] = false;
                            }

                            var jsonBody = JsonSerializer.Serialize(newRequest);
                             _logger.LogInformation($"[JELLYSEERR PROXY] Forwarding request to Jellyseerr: {jsonBody}");
                            return await ProxyJellyseerrRequest("/api/v1/request", HttpMethod.Post, jsonBody);
                        }
                        else
                        {
                            _logger.LogWarning($"[JELLYSEERR PROXY] No matching Jellyseerr user found for Jellyfin user ID: {jellyfinUserId}. User may not be imported in Jellyseerr.");
                            return StatusCode(404, "Jellyfin user not found in Jellyseerr. Please ensure the user is imported in Jellyseerr.");
                        }
                    }
                }

                _logger.LogError("[JELLYSEERR PROXY] Failed to retrieve a valid user list from Jellyseerr.");
                return StatusCode(500, "Failed to retrieve users from Jellyseerr.");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[JELLYSEERR PROXY] An unexpected error occurred while processing the request.");
                return StatusCode(500, "An internal error occurred.");
            }
        }
    }
}