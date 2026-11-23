using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
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
    // Reclaimerr's item-menu actions, request reviews, user import and user audit (upstream da0ea773's and da3d9ee9's
    // ReclaimerrController, here as a partial of the feature's one controller). item answers the administrator or, for
    // anyone who can see the item, whether they may request a removal; mark, unmark, postpone, the request reviews,
    // import-users and user-audit are administrator-only; request is any signed-in user who can open the item. Answers 404
    // while Reclaimerr is not the tool in use (import-users and user-audit: 400 while it is not set up), 400 with {error}
    // for a refusal and 502 with {error} when Reclaimerr failed. The Reclaimerr address and token stay on the server.
    // Maintainerr keeps its own routes (JeMediaTagsController.Maintainerr.cs).
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
            => RunReclaimerrAction(request, (item, config) => reclaimerr.MarkAsync(item, config, request.Date, request.MediaSourceId, CallerName(), token, CallerUser()?.Id));

        /// <summary>Keep the item: protect its cleanup candidate, or cancel its scheduled deletion. Admin only.</summary>
        /// <param name="request">The item.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state after the change.</returns>
        [HttpPost("reclaimerr/unmark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> KeepFromReclaimerrRemoval([FromBody] ReclaimerrItemRequest request, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
            => RunReclaimerrAction(request, (item, config) => reclaimerr.UnmarkAsync(item, config, CallerName(), token, CallerUser()?.Id));

        /// <summary>Move the removal to <c>date</c>, or <c>days</c> later, or restart a candidate's timer when neither is given. Admin only.</summary>
        /// <param name="request">The item, and the day or the days.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The item's state after the change.</returns>
        [HttpPost("reclaimerr/postpone")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> PostponeReclaimerrRemoval([FromBody] ReclaimerrItemRequest request, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
            => RunReclaimerrAction(request, (item, config) => reclaimerr.PostponeAsync(item, request.Days, request.Date, config, CallerName(), token, CallerUser()?.Id));

        /// <summary>
        /// Ask the administrators to remove the item (any signed-in user who can open it): filed as a Reclaimerr deletion request, as the
        /// Reclaimerr account linked to the caller's Jellyfin user.
        /// </summary>
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
            var caller = CallerUser();
            if (caller == null || caller.Id == Guid.Empty) return Forbid();
            try
            {
                var (state, existing) = await reclaimerr.RequestRemovalAsync(item, caller.Id, caller.Username ?? "a user", request!.Reason, config!, token).ConfigureAwait(false);
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

        /// <summary>What the import and the audit say while Reclaimerr is not set up (they do not need the item-menu actions).</summary>
        private const string ReclaimerrSetUpFirst = "Turn on Use Reclaimerr and save its URL and API token first.";

        /// <summary>
        /// Import this server's users into Reclaimerr through its token API (upstream da3d9ee9): every Jellyfin user without a
        /// Reclaimerr account gets one, with the permissions and pages picked, linked to them. Administrators only. Answers
        /// <c>{created, alreadyLinked, needsReview, skipped}</c> (Jellyfin user names; <c>needsReview</c> are matched to an existing
        /// Reclaimerr account, which an administrator confirms in Reclaimerr), or 400 while Reclaimerr is not set up.
        /// </summary>
        /// <param name="request">The permissions and pages the new accounts get.</param>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The Jellyfin users given an account, how many were already linked, the ones to confirm in Reclaimerr and the ones skipped.</returns>
        [HttpPost("reclaimerr/import-users")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> ImportReclaimerrUsers([FromBody] ReclaimerrImportUsersRequest? request, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
        {
            if (!IsAdminUser()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !LeavingSoonSources.UsesReclaimerr(config) || !LeavingSoonSources.ApiConfigured(config)) return BadRequest(new { error = ReclaimerrSetUpFirst });
            try
            {
                var users = _userManager.GetAllUsers().ToDictionary(u => u.Id, u => u.Username);
                var result = await reclaimerr.ImportUsersAsync(config, users, request?.Permissions ?? Array.Empty<string>(), request?.Pages ?? Array.Empty<string>(), token).ConfigureAwait(false);
                return Ok(new { created = result.Created, alreadyLinked = result.AlreadyLinked, needsReview = result.NeedsReview, skipped = result.Skipped });
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

        /// <summary>
        /// Audit every Jellyfin user against Reclaimerr, read-only (upstream da3d9ee9): the linked account, and with removal requests
        /// on whether Reclaimerr's trusted-proxy sign-in accepts it and whether it may request; plus the token scopes the integration
        /// uses that the token lacks. Administrators only. Answers <c>{version, requestsEnabled, issues[], users[]}</c>, or 400 while
        /// Reclaimerr is not set up.
        /// </summary>
        /// <param name="reclaimerr">The Reclaimerr actions.</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The audit.</returns>
        [HttpGet("reclaimerr/user-audit")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> GetReclaimerrUserAudit([FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
        {
            if (!IsAdminUser()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !LeavingSoonSources.UsesReclaimerr(config) || !LeavingSoonSources.ApiConfigured(config)) return BadRequest(new { error = ReclaimerrSetUpFirst });
            try
            {
                var users = _userManager.GetAllUsers().Select(u => (u.Id, u.Username, u.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator))).ToList();
                return Ok(await reclaimerr.AuditUsersAsync(config, users, token).ConfigureAwait(false));
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
            // A card read from one Reclaimerr is never reviewed at another (upstream da3d9ee9).
            if (!string.IsNullOrEmpty(body?.Source) && !string.Equals(body.Source, ReclaimerrApi.SourceId(config), StringComparison.Ordinal))
                return Conflict(new { error = "The Reclaimerr address changed since this list was read. Reload it." });
            try
            {
                // When an approval is deleted (upstream 1de354c0): Reclaimerr's grace period unless the body asks for now or a day.
                var timing = body?.When?.ToLowerInvariant() switch
                {
                    "now" => ReclaimerrActions.ApprovalTiming.Now,
                    "date" => ReclaimerrActions.ApprovalTiming.OnDate,
                    _ => ReclaimerrActions.ApprovalTiming.GracePeriod,
                };
                await reclaimerr.ReviewRequestAsync(requestId, approve, body?.Note, CallerName(), config, token, timing, body?.Date, body?.GraceDays, CallerUser()?.Id).ConfigureAwait(false);
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

        /// <summary>Whether the signed-in user may open the item: its rating and tags, and the library it is in (standalone visibility; upstream da3d9ee9).</summary>
        private bool CallerCanSee(BaseItem item)
        {
            try
            {
                var user = CallerUser();
                return user != null && item.IsVisibleStandalone(user);
            }
            catch { return false; }
        }
    }
}
