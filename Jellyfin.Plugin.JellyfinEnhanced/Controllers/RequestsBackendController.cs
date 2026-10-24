using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Backend-neutral, current-user read surfaces owned by the backend gate.</summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public sealed class RequestsBackendController : ControllerBase
    {
        private readonly RequestedTitlesProjection _titles;
        private readonly IArrJellyfinView _view;
        public RequestsBackendController(RequestedTitlesProjection titles, IArrJellyfinView view) { _titles = titles; _view = view; }
        /// <summary>Own requested identities for Calendar; never an authorization grant for a calendar/download row.</summary>
        [Authorize]
        [HttpGet("arr/requested-titles")]
        public async Task<IActionResult> RequestedTitles()
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            var person = ArrCaller.Human(User, _view);
            if (person == null) return StatusCode(403, new { code = "user_required" });
            var result = await _titles.ForUserAsync(JellyfinEnhanced.Instance?.Configuration, person.UserId, HttpContext.RequestAborted).ConfigureAwait(false);
            if (!result.Available || !result.Complete) Response.Headers["Retry-After"] = "2";
            return result.Available && result.Complete ? Ok(result) : StatusCode(503, result);
        }
    }
}
