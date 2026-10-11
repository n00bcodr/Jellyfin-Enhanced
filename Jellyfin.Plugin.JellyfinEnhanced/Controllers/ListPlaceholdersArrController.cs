using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Admin-only "Add to Radarr/Sonarr" for list placeholders. Every route needs a signed-in user, answers 404
    /// <c>{message:"disabled"}</c> unless both <c>ListPlaceholdersEnabled</c> and <c>ListPlaceholdersArrEnabled</c> are on,
    /// 403 for non-admins, and 404 <c>not_configured</c> when no enabled instance of the needed service exists.
    /// Only JE's configured instances are ever called (<see cref="ListPlaceholderArrService"/>).
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced/list-placeholders/arr")]
    public class ListPlaceholdersArrController : ControllerBase
    {
        private readonly IUserManager _userManager;
        private readonly ListPlaceholderArrService _arr;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        /// <param name="userManager">User manager.</param>
        /// <param name="arr">Arr service.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholdersArrController(IUserManager userManager, ListPlaceholderArrService arr, Logger logger)
        {
            _userManager = userManager;
            _arr = arr;
            _logger = logger;
        }

        /// <summary>Quality profiles and root folders of every enabled Radarr/Sonarr instance.</summary>
        /// <param name="type">"movie", "tv", or omitted for both.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ArrOptionsDto"/>.</returns>
        [HttpGet("options")]
        [Authorize]
        public Task<IActionResult> GetOptions([FromQuery] string? type, CancellationToken cancellationToken) =>
            AdminOnly(_ => _arr.GetOptionsAsync(type, cancellationToken));

        /// <summary>Looks a title up in Radarr (movie) or Sonarr (tv): <c>tmdb:N</c>, <c>tvdb:N</c>, <c>imdb:ttN</c> or text.</summary>
        /// <param name="type">"movie" or "tv".</param>
        /// <param name="term">Lookup term.</param>
        /// <param name="instance">Instance id from options (default 0).</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ArrLookupResultDto"/>.</returns>
        [HttpGet("lookup")]
        [Authorize]
        public Task<IActionResult> Lookup([FromQuery] string? type, [FromQuery] string? term, [FromQuery] int? instance, CancellationToken cancellationToken) =>
            AdminOnly(_ => _arr.LookupAsync(type, term, instance, cancellationToken));

        /// <summary>Adds a movie to Radarr, or a series / season / episodes to Sonarr (monitoring them on a series Sonarr already has).</summary>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ArrAddResultDto"/>.</returns>
        [HttpPost("add")]
        [Authorize]
        public Task<IActionResult> Add([FromBody] ArrAddRequest request, CancellationToken cancellationToken) =>
            AdminOnly(user => _arr.AddAsync(request, user.Id.ToString("N", CultureInfo.InvariantCulture), user.Username, cancellationToken, () => _userManager.GetUserById(user.Id) is { } current && ListAccessService.IsAdmin(current)));

        private async Task<IActionResult> AdminOnly(Func<Jellyfin.Database.Implementations.Entities.User, Task<ListOutcome>> action)
        {
            if (!ListPlaceholderArrService.IsEnabled(JellyfinEnhanced.Instance?.Configuration))
            {
                return NotFound(new { message = "disabled" });
            }

            var userId = UserHelper.GetCurrentUserId(User);
            var user = userId.HasValue ? _userManager.GetUserById(userId.Value) : null;
            if (user == null || !ListAccessService.IsAdmin(user))
            {
                return StatusCode(403, new ListErrorDto { Code = "forbidden", Message = "Only administrators can add to Radarr or Sonarr." });
            }

            try
            {
                var outcome = await action(user).ConfigureAwait(false);
                if (outcome.RawJson != null)
                {
                    return new ContentResult { StatusCode = outcome.StatusCode, Content = outcome.RawJson, ContentType = "application/json" };
                }

                return new ObjectResult(outcome.Value) { StatusCode = outcome.StatusCode };
            }
            catch (OperationCanceledException) when (HttpContext?.RequestAborted.IsCancellationRequested == true)
            {
                return StatusCode(499);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.Error($"[ListPlaceholders] Arr route failed: {ex.GetType().Name}: {ex.Message}");
                return StatusCode(500, new ListErrorDto { Code = "arr_failed", Message = "Something went wrong; see the server log." });
            }
        }
    }
}
