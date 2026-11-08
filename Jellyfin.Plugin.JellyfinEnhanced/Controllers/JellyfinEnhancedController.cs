using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class JellyfinEnhancedController : ControllerBase
    {
        private readonly ILogger<JellyfinEnhancedController> _logger;

        public JellyfinEnhancedController(ILogger<JellyfinEnhancedController> logger)
        {
            _logger = logger;
        }

        [HttpGet("config")]
        public IActionResult GetConfig()
        {
            return Ok(new { status = "SpoilerGuard-only build" });
        }
    }
}
