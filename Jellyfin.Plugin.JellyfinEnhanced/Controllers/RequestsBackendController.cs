using System;
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
        public async Task<IActionResult> RequestedTitles([FromQuery] DateTimeOffset? from = null, [FromQuery] DateTimeOffset? to = null)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            var person = ArrCaller.Human(User, _view);
            if (person == null) return StatusCode(403, new { code = "user_required" });
            if (from.HasValue != to.HasValue || from.HasValue && (to <= from || to - from > TimeSpan.FromDays(366)))
                return BadRequest(new { code = "invalid_window", message = "Supply both from and to, with a positive window of at most 366 days." });
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (from.HasValue && config?.CalendarPageEnabled != true)
            {
                Response.Headers["Retry-After"] = "2";
                return StatusCode(503, new RequestedTitlesEnvelope(false, false,
                    EffectiveRequestsBackend.EvaluateConfiguration(config).Backend, "calendar_disabled", from?.ToUniversalTime(), to?.ToUniversalTime(),
                    Array.Empty<RequestedTitleGroup>(), "calendar_disabled"));
            }
            var source = await _titles.ForUserAsync(JellyfinEnhanced.Instance?.Configuration, person.UserId, HttpContext.RequestAborted).ConfigureAwait(false);
            var result = RequestedTitlesEnvelope.FromResult(source, from, to);
            if (!result.Available || !result.Complete) Response.Headers["Retry-After"] = "2";
            return result.Available ? Ok(result) : StatusCode(503, result);
        }
    }
}
