using System;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of the Maintainerr actions: the item, and for postpone the days (null resets the timer).</summary>
    public class MaintainerrActionRequest
    {
        [JsonPropertyName("itemId")] public Guid? ItemId { get; set; }
        [JsonPropertyName("days")] public int? Days { get; set; }
    }

    /// <summary>
    /// Administrators' Maintainerr actions behind the item menu: the item's state (cache-only), mark for
    /// removal, keep, postpone or reset. Every route is administrator-only; the Maintainerr address and key
    /// stay on the server, and a refusal carries only its reason. Answers <c>404</c> while the actions are
    /// off (the switch or no Maintainerr URL), <c>400</c> with <c>{error}</c> for a refusal (no fitting
    /// collection, not marked, already marked, a wrong item kind or day count) and <c>502</c> with
    /// <c>{error}</c> when Maintainerr (or its address) failed.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced/maintainerr")]
    public class MaintainerrController : ControllerBase
    {
        private readonly MaintainerrActions _actions;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;

        public MaintainerrController(MaintainerrActions actions, IUserManager userManager, ILibraryManager libraryManager)
        {
            _actions = actions;
            _userManager = userManager;
            _libraryManager = libraryManager;
        }

        private bool IsAdmin()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                var user = id.HasValue ? _userManager.GetUserById(id.Value) : null;
                return user != null && user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch { return false; }
        }

        /// <summary>The item's state as of the last read: marked, its collection and delete time. Admin only.</summary>
        [HttpGet("item/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetState([FromRoute] Guid itemId)
        {
            if (!IsAdmin()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!MaintainerrActions.Enabled(config)) return NotFound();
            var item = Find(itemId);
            if (item == null) return NotFound();
            return Ok(_actions.State(item, config!));
        }

        /// <summary>Mark the item for removal: add it to the Maintainerr manual collection that fits it. Admin only.</summary>
        [HttpPost("mark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Mark([FromBody] MaintainerrActionRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => _actions.MarkAsync(item, config, token));

        /// <summary>Keep the item: remove it from its Maintainerr collection. Admin only.</summary>
        [HttpPost("unmark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Unmark([FromBody] MaintainerrActionRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => _actions.UnmarkAsync(item, config, token));

        /// <summary>Postpone the item's removal by <c>days</c> (1–3650), or reset its timer when <c>days</c> is absent. Admin only.</summary>
        [HttpPost("postpone")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Postpone([FromBody] MaintainerrActionRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => _actions.PostponeAsync(item, request.Days, config, token));

        private BaseItem? Find(Guid itemId) => itemId == Guid.Empty ? null : _libraryManager.GetItemById(itemId);

        private async Task<IActionResult> RunAsync(MaintainerrActionRequest? request, Func<BaseItem, Configuration.PluginConfiguration, Task<MaintainerrItemState>> action)
        {
            if (!IsAdmin()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!MaintainerrActions.Enabled(config)) return NotFound();
            var item = request?.ItemId is { } id ? Find(id) : null;
            if (item == null) return BadRequest(new { error = "Unknown item." });
            try
            {
                return Ok(await action(item, config!).ConfigureAwait(false));
            }
            catch (MaintainerrActions.ActionException ex)
            {
                return BadRequest(new { error = ex.Message });
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                return StatusCode(502, new { error = "Maintainerr: " + MaintainerrHttp.Describe(ex) });
            }
        }
    }
}
