using System;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using MediaBrowser.Controller.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags
{
    // Reclaimerr's item-menu actions and its service account (upstream da0ea773's ReclaimerrController, here as a
    // partial of the feature's one controller). item answers the administrator or, for anyone who can see the item,
    // whether they may request a removal; mark, unmark, postpone, the request reviews, the service account and the
    // accounts for Jellyfin users (create-users) are administrator-only; request is any signed-in user who can see the item. Answers 404 while Reclaimerr is not the
    // tool in use, 400 with {error} for a refusal and 502 with {error} when Reclaimerr failed. The Reclaimerr address,
    // token and service account stay on the server. Maintainerr keeps its own routes (JeMediaTagsController.Maintainerr.cs).
    public partial class JeMediaTagsController
    {
        /// <summary>The item's state as of the last read. Administrators; anyone else who can see the item only learns whether they may request.</summary>
        /// <param name="itemId">The item.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <returns>The state, with <c>provider</c>, <c>admin</c> and <c>canRequest</c>.</returns>
        [HttpGet("reclaimerr/item/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetReclaimerrItemState([FromRoute] Guid itemId, [FromServices] ReclaimerrActions reclaimerr)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!ReclaimerrActions.Enabled(config)) return NotFound();
            var item = FindMaintainerrItem(itemId);
            if (item == null) return NotFound();
            var admin = IsAdminUser();
            var canRequest = ReclaimerrActions.RequestsEnabled(config);
            if (!admin && !(canRequest && CallerCanSee(item))) return NotFound();
            var state = reclaimerr.State(item, config!);
            return Ok(new { state.ItemId, state.Marked, state.CollectionId, state.CollectionName, state.DeleteAt, state.Supported, provider = "reclaimerr", admin, canRequest });
        }

        /// <summary>Schedule the item's removal for <c>date</c> (30 days ahead when absent); one version of a movie when several exist. Admin only.</summary>
        /// <param name="request">The item, the day and the version picked on its page.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state after the change.</returns>
        [HttpPost("reclaimerr/mark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> MarkForReclaimerrRemoval([FromBody] ReclaimerrItemRequest request, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
            => RunReclaimerrAction(request, (item, config) => reclaimerr.MarkAsync(item, config, request.Date, request.MediaSourceId, CallerName(), token));

        /// <summary>Keep the item: protect its cleanup candidate, or cancel its scheduled deletion. Admin only.</summary>
        /// <param name="request">The item.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state after the change.</returns>
        [HttpPost("reclaimerr/unmark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> KeepFromReclaimerrRemoval([FromBody] ReclaimerrItemRequest request, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
            => RunReclaimerrAction(request, (item, config) => reclaimerr.UnmarkAsync(item, config, CallerName(), token));

        /// <summary>Move the removal to <c>date</c>, or <c>days</c> later, or restart a candidate's timer when neither is given. Admin only.</summary>
        /// <param name="request">The item, and the day or the days.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state after the change.</returns>
        [HttpPost("reclaimerr/postpone")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> PostponeReclaimerrRemoval([FromBody] ReclaimerrItemRequest request, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
            => RunReclaimerrAction(request, (item, config) => reclaimerr.PostponeAsync(item, request.Days, request.Date, config, CallerName(), token));

        /// <summary>Ask the administrators to remove the item (any signed-in user who can see it): filed as a Reclaimerr deletion request.</summary>
        /// <param name="request">The item and an optional note.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state, with <c>AlreadyRequested</c> (<c>mine</c> or <c>other</c>) when a request was already waiting.</returns>
        [HttpPost("reclaimerr/request")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> RequestReclaimerrRemoval([FromBody] ReclaimerrItemRequest request, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!ReclaimerrActions.RequestsEnabled(config)) return NotFound();
            var item = request?.ItemId is { } id ? FindMaintainerrItem(id) : null;
            if (item == null || !CallerCanSee(item)) return BadRequest(new { error = "Unknown item." });
            var name = CallerName() ?? "a user";
            try
            {
                var (state, existing) = await reclaimerr.RequestRemovalAsync(item, name, request!.Reason, config!, token).ConfigureAwait(false);
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

        /// <summary>Approve a pending Reclaimerr deletion request (Reclaimerr deletes the title then). Administrators only.</summary>
        /// <param name="requestId">Reclaimerr's request id.</param>
        /// <param name="body">An optional note.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns><c>{id, approved}</c>.</returns>
        [HttpPost("reclaimerr/requests/{requestId:int}/approve")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> ApproveReclaimerrRequest([FromRoute] int requestId, [FromBody] ReclaimerrReviewRequest? body, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
            => ReviewReclaimerrRequest(requestId, true, body, reclaimerr, token);

        /// <summary>Deny a pending Reclaimerr deletion request. Administrators only.</summary>
        /// <param name="requestId">Reclaimerr's request id.</param>
        /// <param name="body">An optional note.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns><c>{id, approved}</c>.</returns>
        [HttpPost("reclaimerr/requests/{requestId:int}/deny")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> DenyReclaimerrRequest([FromRoute] int requestId, [FromBody] ReclaimerrReviewRequest? body, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
            => ReviewReclaimerrRequest(requestId, false, body, reclaimerr, token);

        /// <summary>
        /// Create the plugin's Reclaimerr service account (<c>jellyfin-enhanced</c>, admin, random password) by signing in
        /// once as a Reclaimerr administrator, and save its login in the configuration. Administrators only; the
        /// administrator's password is used for this call only. Answers <c>{username, password}</c> (the page's Save writes
        /// the password field back, so it must hold the new one).
        /// </summary>
        /// <param name="request">The Reclaimerr administrator.</param>
        /// <param name="http">The client factory.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The new account.</returns>
        [HttpPost("reclaimerr/service-account")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> CreateReclaimerrServiceAccount([FromBody] ReclaimerrServiceAccountRequest request, [FromServices] IHttpClientFactory http, CancellationToken token)
        {
            if (!IsAdminUser()) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            var config = plugin?.Configuration;
            if (plugin == null || config == null || !LeavingSoonSources.IsMaintainerrUrl(config.ReclaimerrUrl)) return BadRequest(new { error = "Save the Reclaimerr URL first." });
            if (string.IsNullOrWhiteSpace(request?.AdminUsername)) return BadRequest(new { error = "Enter a Reclaimerr administrator's username." });
            try
            {
                var (username, password) = await ReclaimerrSession.CreateServiceAccountAsync(http, config, request.AdminUsername!, request.AdminPassword ?? string.Empty, TimeSpan.FromSeconds(30), token).ConfigureAwait(false);
                plugin.UpdateConfiguration(c => { c.ReclaimerrUsername = username; c.ReclaimerrPassword = password; return c; }, fullSave: false);
                ReclaimerrSession.Forget(plugin.Configuration);
                return Ok(new { username, password });
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

        /// <summary>
        /// Create a Reclaimerr account for every Jellyfin user that has none, with the permissions and pages picked, through the
        /// service account, and map each new account to its Jellyfin user. Administrators only. Answers
        /// <c>{created, existing, skipped, userMap}</c>; the page puts <c>userMap</c> in its field, since its Save writes the
        /// field back.
        /// </summary>
        /// <param name="request">The permissions and pages the new accounts get.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The Jellyfin users given an account, how many already had one, the ones skipped and the new user map.</returns>
        [HttpPost("reclaimerr/create-users")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> CreateReclaimerrUsers([FromBody] ReclaimerrCreateUsersRequest? request, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
        {
            if (!IsAdminUser()) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            var config = plugin?.Configuration;
            if (plugin == null || config == null || !ReclaimerrActions.Enabled(config)) return NotFound();
            try
            {
                var names = _userManager.GetAllUsers().Select(u => u.Username).ToList();
                var result = await reclaimerr.CreateAccountsAsync(config, names, request?.Permissions ?? Array.Empty<string>(), request?.Pages ?? Array.Empty<string>(), token).ConfigureAwait(false);
                if (result.Created.Count > 0)
                {
                    // The plugin acts as a user only through a mapping or link (it never guesses by name), so record each new account.
                    var lines = string.Concat(result.Created.Select(c => $"\n{c.Jellyfin} = {c.Reclaimerr}"));
                    plugin.UpdateConfiguration(c => { c.ReclaimerrUserMap = ((c.ReclaimerrUserMap ?? string.Empty).TrimEnd() + lines).Trim(); return c; }, fullSave: false);
                }

                return Ok(new { created = result.Created.Select(c => c.Jellyfin).ToList(), existing = result.Existing, skipped = result.Skipped, userMap = plugin.Configuration.ReclaimerrUserMap });
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

        private async Task<IActionResult> ReviewReclaimerrRequest(int requestId, bool approve, ReclaimerrReviewRequest? body, ReclaimerrActions reclaimerr, CancellationToken token)
        {
            if (!IsAdminUser()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.LeavingSoonPageEnabled || !ReclaimerrActions.Enabled(config)) return NotFound();
            try
            {
                // When an approval is deleted (upstream 1de354c0): Reclaimerr's grace period unless the body asks for now or a day.
                var timing = body?.When?.ToLowerInvariant() switch
                {
                    "now" => ReclaimerrActions.ApprovalTiming.Now,
                    "date" => ReclaimerrActions.ApprovalTiming.OnDate,
                    _ => ReclaimerrActions.ApprovalTiming.GracePeriod,
                };
                await reclaimerr.ReviewRequestAsync(requestId, approve, body?.Note, CallerName(), config, token, timing, body?.Date).ConfigureAwait(false);
                return Ok(new { id = requestId, approved = approve });
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

        private async Task<IActionResult> RunReclaimerrAction(ReclaimerrItemRequest? request, Func<BaseItem, PluginConfiguration, Task<MaintainerrItemState>> action)
        {
            if (!IsAdminUser()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!ReclaimerrActions.Enabled(config)) return NotFound();
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
                return StatusCode(502, new { error = "Reclaimerr: " + MaintainerrHttp.Describe(ex) });
            }
        }

        /// <summary>The signed-in Jellyfin user (null for an API key or an unknown id).</summary>
        private JUser? CallerUser()
        {
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                return id.HasValue && id.Value != Guid.Empty ? _userManager.GetUserById(id.Value) : null;
            }
            catch { return null; }
        }

        /// <summary>The signed-in Jellyfin user's name (null for an API key), the identity Reclaimerr actions are attributed to.</summary>
        private string? CallerName() => CallerUser()?.Username;

        /// <summary>Whether the signed-in user can see the item.</summary>
        private bool CallerCanSee(BaseItem item)
        {
            try
            {
                var user = CallerUser();
                return user != null && item.IsVisible(user);
            }
            catch { return false; }
        }
    }
}
