using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using MediaBrowser.Controller.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags
{
    // Administrators' Maintainerr actions behind the item menu (upstream 481a10ee's MaintainerrController, here as
    // a partial of the feature's one controller): the item's state (cache-only), mark for removal, keep, postpone or
    // reset. Every route is administrator-only; the Maintainerr address and key stay on the server, and a refusal
    // carries only its reason. Answers 404 while the actions are off (the switch or no Maintainerr URL), 400 with
    // {error} for a refusal (no fitting collection, not marked, already marked, a wrong item kind or day count) and
    // 502 with {error} when Maintainerr (or its address) failed.
    public partial class JeMediaTagsController
    {
        /// <summary>The item's state as of the last read: marked, its collection and delete time. Admin only.</summary>
        /// <param name="itemId">The item.</param>
        /// <param name="actions">The Maintainerr actions.</param>
        /// <returns>The state.</returns>
        [HttpGet("maintainerr/item/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetMaintainerrItemState([FromRoute] Guid itemId, [FromServices] MaintainerrActions actions)
        {
            if (!IsAdminUser()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!MaintainerrActions.Enabled(config)) return NotFound();
            var item = FindMaintainerrItem(itemId);
            if (item == null) return NotFound();
            return Ok(actions.State(item, config!));
        }

        /// <summary>Mark the item for removal: add it to the Maintainerr manual collection that fits it. Admin only.</summary>
        /// <param name="request">The item.</param>
        /// <param name="actions">The Maintainerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state after the change.</returns>
        [HttpPost("maintainerr/mark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> MarkForMaintainerrRemoval([FromBody] MaintainerrActionRequest request, [FromServices] MaintainerrActions actions, CancellationToken token)
            => RunMaintainerrAction(request, (item, config) => actions.MarkAsync(item, config, token));

        /// <summary>Keep the item: remove it from its Maintainerr collection. Admin only.</summary>
        /// <param name="request">The item.</param>
        /// <param name="actions">The Maintainerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state after the change.</returns>
        [HttpPost("maintainerr/unmark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> KeepFromMaintainerrRemoval([FromBody] MaintainerrActionRequest request, [FromServices] MaintainerrActions actions, CancellationToken token)
            => RunMaintainerrAction(request, (item, config) => actions.UnmarkAsync(item, config, token));

        /// <summary>Postpone the item's removal by <c>days</c> (1–3650), or reset its timer when <c>days</c> is absent. Admin only.</summary>
        /// <param name="request">The item and the days.</param>
        /// <param name="actions">The Maintainerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state after the change.</returns>
        [HttpPost("maintainerr/postpone")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> PostponeMaintainerrRemoval([FromBody] MaintainerrActionRequest request, [FromServices] MaintainerrActions actions, CancellationToken token)
            => RunMaintainerrAction(request, (item, config) => actions.PostponeAsync(item, request.Days, config, token));

        private BaseItem? FindMaintainerrItem(Guid itemId) => itemId == Guid.Empty ? null : _libraryManager.GetItemById(itemId);

        private async Task<IActionResult> RunMaintainerrAction(MaintainerrActionRequest? request, Func<BaseItem, PluginConfiguration, Task<MaintainerrItemState>> action)
        {
            if (!IsAdminUser()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!MaintainerrActions.Enabled(config)) return NotFound();
            var item = request?.ItemId is { } id ? FindMaintainerrItem(id) : null;
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
