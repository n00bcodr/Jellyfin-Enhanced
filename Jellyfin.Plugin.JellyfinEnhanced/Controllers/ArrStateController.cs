using System;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Admin diagnostics of the arr state store that serves the Downloads, Calendar and link routes:
    /// what each instance's snapshots hold, how old they are, the last refresh error, and per-route
    /// counters of the upstream calls requests made themselves (zero once the snapshots are warm).
    /// Available whenever an admin asks (not only with "Requests &amp; downloads (new)" on), because
    /// the existing pages use the store too. Carries no credential; paths and URLs are admin data.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class ArrStateController : ControllerBase
    {
        private readonly ArrStateStore _store;
        private readonly IUserManager _userManager;

        /// <summary>Creates the controller.</summary>
        public ArrStateController(ArrStateStore store, IUserManager userManager)
        {
            _store = store;
            _userManager = userManager;
        }

        /// <summary>Snapshot ages, sizes, errors and request counters.</summary>
        [HttpGet("arr/admin/state")]
        [Authorize]
        public IActionResult GetState()
        {
            if (!IsAdmin()) return Forbid();
            return Ok(_store.Describe());
        }

        /// <summary>
        /// Asks for a refresh of one snapshot of one instance (debounced by two seconds; the
        /// reconciler runs it). <paramref name="kind"/> is library, queue, history, calendar or system.
        /// </summary>
        [HttpPost("arr/admin/state/refresh")]
        [Authorize]
        public IActionResult RequestRefresh([FromQuery] string? instanceId, [FromQuery] string? kind)
        {
            if (!IsAdmin()) return Forbid();
            if (string.IsNullOrWhiteSpace(instanceId) || !Enum.TryParse<ArrSnapshotKind>(kind, ignoreCase: true, out var parsed) || !Enum.IsDefined(parsed))
                return BadRequest(new { error = "instanceId and kind (library, queue, history, calendar, system) are required" });
            if (!_store.RequestRefresh(instanceId, parsed))
                return NotFound(new { error = "No usable instance with this id." });
            return Accepted(new { requested = true });
        }

        private bool IsAdmin()
        {
            if (User.IsInRole("Administrator")) return true;
            var id = UserHelper.GetCurrentUserId(User);
            var user = id.HasValue ? _userManager.GetUserById(id.Value) : null;
            return user != null && user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
        }
    }
}
