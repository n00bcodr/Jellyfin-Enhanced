using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.SpoilerGuard.Controllers
{
    [ApiController]
    [Route("SpoilerGuard")]
    public class SpoilerGuardController : ControllerBase
    {
        private readonly ILogger<SpoilerGuardController> _logger;

        public SpoilerGuardController(ILogger<SpoilerGuardController> logger)
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
