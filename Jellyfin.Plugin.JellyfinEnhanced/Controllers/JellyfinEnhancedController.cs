using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using System;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
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

        private async Task<IActionResult> ProxyJellyseerrRequest(string apiPath, HttpMethod method, string? content = null)
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
                    _logger.LogInformation("[JELLYSEERR PROXY] Attempting request to: {RequestUri}", requestUri);

                    var request = new HttpRequestMessage(method, requestUri);

                    if (content != null)
                    {
                        request.Content = new StringContent(content, Encoding.UTF8, "application/json");
                    }

                    var response = await httpClient.SendAsync(request);

                    var responseContent = await response.Content.ReadAsStringAsync();

                    if (response.IsSuccessStatusCode)
                    {
                        _logger.LogInformation("[JELLYSEERR PROXY] Successful response from {Url}", trimmedUrl);
                        return Content(responseContent, "application/json");
                    }

                    _logger.LogWarning("Request to Jellyseerr URL {Url} failed with status {StatusCode}. Response: {Response}", trimmedUrl, response.StatusCode, responseContent);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to connect to Jellyseerr URL: {Url}", trimmedUrl);
                    continue;
                }
            }

            _logger.LogError("Could not connect to any configured Jellyseerr instance.");
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
            var jsonBody = requestBody.ToString();
            return await ProxyJellyseerrRequest("/api/v1/request", HttpMethod.Post, jsonBody);
        }
    }
}