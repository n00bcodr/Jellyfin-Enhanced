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
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of the removal actions: the item, and for postpone the days (null resets the timer).</summary>
    public class LeavingSoonActionRequest
    {
        [JsonPropertyName("itemId")] public Guid? ItemId { get; set; }
        [JsonPropertyName("days")] public int? Days { get; set; }
        /// <summary>For a removal request: an optional note for the administrator.</summary>
        [JsonPropertyName("reason")] public string? Reason { get; set; }
        /// <summary>The version picked on the item page; tells apart the 4K and 1080p copies of one movie.</summary>
        [JsonPropertyName("mediaSourceId")] public string? MediaSourceId { get; set; }
        /// <summary>Reclaimerr only: the exact day (ISO 8601) to schedule a removal for, or to postpone it to.</summary>
        [JsonPropertyName("date")] public DateTimeOffset? Date { get; set; }
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
    [Route("JellyfinEnhanced/leaving-soon")]
    public class LeavingSoonActionsController : ControllerBase
    {
        private readonly MaintainerrActions _actions;
        private readonly ReclaimerrActions _reclaimerr;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;

        public LeavingSoonActionsController(MaintainerrActions actions, ReclaimerrActions reclaimerr, IUserManager userManager, ILibraryManager libraryManager)
        {
            _actions = actions;
            _reclaimerr = reclaimerr;
            _userManager = userManager;
            _libraryManager = libraryManager;
        }

        private bool IsAdmin()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                var user = id.HasValue && id.Value != Guid.Empty ? _userManager.GetUserById(id.Value) : null;
                return user != null && user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch { return false; }
        }

        /// <summary>The item's state as of the last read: marked, its collection and delete time. Admin only.</summary>
        [HttpGet("item/{itemId}")]
        // The path this action had in its first release (12.16), kept so existing callers keep working.
        [HttpGet("~/JellyfinEnhanced/maintainerr/item/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetState([FromRoute] Guid itemId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            var item = Find(itemId);
            if (item == null) return NotFound();
            if (ReclaimerrActions.Enabled(config))
            {
                // Administrators get every action; anyone else who can see the item learns only whether they may request a removal.
                var admin = IsAdmin();
                var canRequest = ReclaimerrActions.RequestsEnabled(config);
                if (!admin && !(canRequest && CanSee(item))) return NotFound();
                var state = _reclaimerr.State(item, config!);
                return Ok(new { state.ItemId, state.Marked, state.CollectionId, state.CollectionName, state.DeleteAt, state.Supported, provider = "reclaimerr", admin, canRequest });
            }

            if (!IsAdmin()) return Forbid();
            if (!MaintainerrActions.Enabled(config)) return NotFound();
            return Ok(_actions.State(item, config!));
        }

        /// <summary>Mark the item for removal: add it to the Maintainerr manual collection that fits it. Admin only.</summary>
        [HttpPost("mark")]
        // The path this action had in its first release (12.16), kept so existing callers keep working.
        [HttpPost("~/JellyfinEnhanced/maintainerr/mark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Mark([FromBody] LeavingSoonActionRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => LeavingSoonService.UsesReclaimerr(config) ? _reclaimerr.MarkAsync(item, config, request.Date, request.MediaSourceId, CurrentUserName(), token) : _actions.MarkAsync(item, config, token, request.MediaSourceId));

        /// <summary>Keep the item: remove it from its Maintainerr collection. Admin only.</summary>
        [HttpPost("unmark")]
        // The path this action had in its first release (12.16), kept so existing callers keep working.
        [HttpPost("~/JellyfinEnhanced/maintainerr/unmark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Unmark([FromBody] LeavingSoonActionRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => LeavingSoonService.UsesReclaimerr(config) ? _reclaimerr.UnmarkAsync(item, config, CurrentUserName(), token) : _actions.UnmarkAsync(item, config, token));

        /// <summary>Postpone the item's removal by <c>days</c> (1–3650), or reset its timer when <c>days</c> is absent. Admin only.</summary>
        [HttpPost("postpone")]
        // The path this action had in its first release (12.16), kept so existing callers keep working.
        [HttpPost("~/JellyfinEnhanced/maintainerr/postpone")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Postpone([FromBody] LeavingSoonActionRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => LeavingSoonService.UsesReclaimerr(config) ? _reclaimerr.PostponeAsync(item, request.Days, request.Date, config, CurrentUserName(), token) : _actions.PostponeAsync(item, request.Days, config, token));

        /// <summary>
        /// Ask the administrators to remove the item (any signed-in user who can see it): filed as a Reclaimerr deletion request.
        /// Answers <c>404</c> unless the removal tool that is on supports requests (Reclaimerr with a service account).
        /// </summary>
        [HttpPost("~/JellyfinEnhanced/leaving-soon/request")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> RequestRemoval([FromBody] LeavingSoonActionRequest request, CancellationToken token)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!ReclaimerrActions.RequestsEnabled(config)) return NotFound();
            var item = request?.ItemId is { } id ? Find(id) : null;
            if (item == null || !CanSee(item)) return BadRequest(new { error = "Unknown item." });
            var userId = UserHelper.GetCurrentUserId(User);
            var name = (userId.HasValue && userId.Value != Guid.Empty ? _userManager.GetUserById(userId.Value)?.Username : null) ?? "a user";
            try
            {
                var (state, existing) = await _reclaimerr.RequestRemovalAsync(item, name, request!.Reason, config!, token).ConfigureAwait(false);
                // An earlier request still waiting is an answer, not an error: AlreadyRequested says whose it is ("mine" or "other").
                return Ok(new { state.ItemId, state.Marked, state.CollectionId, state.CollectionName, state.DeleteAt, state.Supported, AlreadyRequested = existing });
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
                return StatusCode(502, new { error = "Reclaimerr: " + MaintainerrHttp.Describe(ex) });
            }
        }

        /// <summary>The signed-in Jellyfin user's name (null for an API key), the identity Reclaimerr actions are attributed to.</summary>
        private string? CurrentUserName()
        {
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                return id.HasValue && id.Value != Guid.Empty ? _userManager.GetUserById(id.Value)?.Username : null;
            }
            catch { return null; }
        }

        private bool CanSee(BaseItem item)
        {
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                var user = id.HasValue && id.Value != Guid.Empty ? _userManager.GetUserById(id.Value) : null;
                return user != null && item.IsVisible(user);
            }
            catch { return false; }
        }

        private BaseItem? Find(Guid itemId) => itemId == Guid.Empty ? null : _libraryManager.GetItemById(itemId);

        private async Task<IActionResult> RunAsync(LeavingSoonActionRequest? request, Func<BaseItem, Configuration.PluginConfiguration, Task<MaintainerrItemState>> action)
        {
            if (!IsAdmin()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!MaintainerrActions.Enabled(config) && !ReclaimerrActions.Enabled(config)) return NotFound();
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
                return StatusCode(502, new { error = (LeavingSoonService.UsesReclaimerr(config) ? "Reclaimerr: " : "Maintainerr: ") + MaintainerrHttp.Describe(ex) });
            }
        }
    }
}
