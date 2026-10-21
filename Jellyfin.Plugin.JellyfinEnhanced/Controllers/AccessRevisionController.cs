using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// The signed-in person's revisions (<see cref="AccessRevision"/>): what a browser tab asks on each navigation and when
    /// it comes back into view, so its kept answers follow a change to the person's access or to a document another tab or
    /// device saved even when nothing else on the page asks the server. Every JE answer carries the same value in its
    /// header; this is the one that is always asked. Never cached.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public sealed class AccessRevisionController : ControllerBase
    {
        private readonly IUserManager _users;

        /// <summary>Creates the controller.</summary>
        /// <param name="users">Jellyfin's users.</param>
        public AccessRevisionController(IUserManager users)
        {
            _users = users;
        }

        /// <summary>The caller's revisions: <c>{revision: "a=…;hc=…;sg=…"}</c> (the one the response header carries).</summary>
        /// <returns>The revisions.</returns>
        [HttpGet("revision")]
        [Authorize]
        public IActionResult GetRevision()
        {
            if (UserHelper.GetCurrentUserId(User) is not { } user) return StatusCode(403, new { code = "user_required" });
            // The header the filter took before this action ran (else read now: the filter isn't registered in some hosts).
            var revision = Response.Headers.TryGetValue(AccessRevision.Header, out var taken) && taken.Count > 0 ? taken.ToString() : AccessRevision.For(_users, user);
            if (revision == null) return StatusCode(403, new { code = "user_required" });
            Response.Headers[AccessRevision.Header] = revision;
            Response.Headers["Cache-Control"] = "no-store";
            return Ok(new { revision });
        }
    }
}
