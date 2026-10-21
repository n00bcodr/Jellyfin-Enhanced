using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// The configuration page's save: only what the administrator changed on the page, applied by the server to the
    /// configuration it holds now (see <see cref="ConfigurationPatch"/>). Jellyfin's own whole-configuration route stays for
    /// other clients.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class ConfigurationPatchController : ControllerBase
    {
        // Large text settings (house rules, custom links, tag styles) travel only when changed; whole lists of instances
        // only when added.
        private const int MaxPatchBytes = 4 * 1024 * 1024;

        private readonly IUserManager _userManager;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        public ConfigurationPatchController(IUserManager userManager, Logger logger)
        {
            _userManager = userManager;
            _logger = logger;
        }

        /// <summary>
        /// Applies the administrator's changes to the stored configuration. Answers what was applied, ignored (fields a patch
        /// can't set) and skipped (instance operations on an instance another writer removed or added meanwhile), and the
        /// configuration as stored afterwards (credentials as placeholders, like Jellyfin's configuration route).
        /// </summary>
        [HttpPatch("configuration")]
        [Authorize]
        [BodyLimit(MaxPatchBytes)]
        [ProducesResponseType(StatusCodes.Status200OK)]
        [ProducesResponseType(StatusCodes.Status400BadRequest)]
        public IActionResult Patch([FromBody] ConfigurationPatch? patch)
        {
            if (!ArrCaller.IsAdmin(User, _userManager)) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            if (plugin == null) return StatusCode(StatusCodes.Status503ServiceUnavailable);
            if (patch == null) return BadRequest(new { success = false, code = "invalid_patch", message = "A patch is required." });
            try
            {
                var result = plugin.PatchConfiguration(patch);
                if (result.Skipped.Count > 0)
                {
                    _logger.Info("Jellyfin Enhanced: configuration save skipped instance changes another writer made obsolete: " + string.Join(", ", result.Skipped) + ".");
                }

                return Ok(new { success = true, applied = result.Applied, ignored = result.Ignored, skipped = result.Skipped, configuration = plugin.Configuration });
            }
            catch (ConfigurationPatchException ex)
            {
                return BadRequest(new { success = false, code = "invalid_patch", field = ex.Field, message = ex.Message });
            }
        }
    }
}
