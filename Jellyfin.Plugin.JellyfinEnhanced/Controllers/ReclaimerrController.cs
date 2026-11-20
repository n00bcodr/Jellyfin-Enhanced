using System;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Extensions;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of the import-users route: what every new account gets.</summary>
    public class ReclaimerrImportUsersRequest
    {
        [JsonPropertyName("permissions")] public string[]? Permissions { get; set; }
        [JsonPropertyName("pages")] public string[]? Pages { get; set; }
    }

    /// <summary>Body of the request review routes.</summary>
    public class ReclaimerrReviewRequest
    {
        [JsonPropertyName("note")] public string? Note { get; set; }
        /// <summary>Approve only: <c>default</c> (Reclaimerr's grace period, none unless set), <c>now</c>, or <c>date</c> (needs <c>date</c>).</summary>
        [JsonPropertyName("when")] public string? When { get; set; }
        [JsonPropertyName("date")] public DateTimeOffset? Date { get; set; }
        /// <summary>The <c>source</c> of the list the request was shown in (<c>leaving-soon/list</c>); refused when Reclaimerr changed since.</summary>
        [JsonPropertyName("source")] public string? Source { get; set; }
        /// <summary>Approve with the grace period: the days the administrator was shown; refused when Reclaimerr's setting differs now.</summary>
        [JsonPropertyName("graceDays")] public int? GraceDays { get; set; }
    }

    /// <summary>Body of the Reclaimerr item actions.</summary>
    public class ReclaimerrItemRequest
    {
        [JsonPropertyName("itemId")] public Guid? ItemId { get; set; }
        /// <summary>Postpone: move the removal this many days later (1-3650).</summary>
        [JsonPropertyName("days")] public int? Days { get; set; }
        /// <summary>Mark or postpone: the exact day (ISO 8601). A cleanup candidate only moves later; a scheduled deletion either way.</summary>
        [JsonPropertyName("date")] public DateTimeOffset? Date { get; set; }
        /// <summary>Request: an optional note for the administrator.</summary>
        [JsonPropertyName("reason")] public string? Reason { get; set; }
        /// <summary>The version picked on the item page; tells apart the 4K and 1080p copies of one movie.</summary>
        [JsonPropertyName("mediaSourceId")] public string? MediaSourceId { get; set; }
    }

    /// <summary>
    /// Reclaimerr's item-menu actions, request reviews and user import. <c>item</c> answers the administrator or, for anyone who
    /// can see the item, whether they may request a removal; <c>mark</c>, <c>unmark</c>, <c>postpone</c>, the reviews and
    /// <c>import-users</c> are administrator-only; <c>request</c> is any signed-in user. Answers <c>404</c> while Reclaimerr is not the tool in use, <c>400</c> with
    /// <c>{error}</c> for a refusal and <c>502</c> with <c>{error}</c> when Reclaimerr failed. Maintainerr has its own routes
    /// under <c>JellyfinEnhanced/maintainerr</c>.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced/reclaimerr")]
    public class ReclaimerrController : RemovalControllerBase
    {
        private readonly ReclaimerrActions _reclaimerr;

        public ReclaimerrController(ReclaimerrActions reclaimerr, IUserManager userManager, ILibraryManager libraryManager)
            : base(userManager, libraryManager)
        {
            _reclaimerr = reclaimerr;
        }

        /// <summary>The item's state as of the last read. Administrators; anyone else who can see the item only learns whether they may request.</summary>
        [HttpGet("item/{itemId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetState([FromRoute] Guid itemId)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!ReclaimerrActions.Enabled(config)) return NotFound();
            var item = Find(itemId);
            if (item == null) return NotFound();
            var admin = IsAdmin();
            var canRequest = ReclaimerrActions.RequestsEnabled(config);
            if (!admin && !(canRequest && CanSee(item))) return NotFound();
            var state = _reclaimerr.State(item, config!);
            return Ok(new { state.ItemId, state.Marked, state.CollectionId, state.CollectionName, state.DeleteAt, state.Supported, provider = "reclaimerr", admin, canRequest });
        }

        /// <summary>Schedule the item's removal for <c>date</c> (30 days ahead when absent); one version of a movie when several exist. Admin only.</summary>
        [HttpPost("mark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Mark([FromBody] ReclaimerrItemRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => _reclaimerr.MarkAsync(item, config, request.Date, request.MediaSourceId, CurrentUserName(), token));

        /// <summary>Keep the item: protect its cleanup candidate, or cancel its scheduled deletion. Admin only.</summary>
        [HttpPost("unmark")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Unmark([FromBody] ReclaimerrItemRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => _reclaimerr.UnmarkAsync(item, config, CurrentUserName(), token));

        /// <summary>Move the removal to <c>date</c>, or <c>days</c> later, or restart a candidate's timer when neither is given. Admin only.</summary>
        [HttpPost("postpone")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Postpone([FromBody] ReclaimerrItemRequest request, CancellationToken token)
            => RunAsync(request, (item, config) => _reclaimerr.PostponeAsync(item, request.Days, request.Date, config, CurrentUserName(), token));

        /// <summary>Ask the administrators to remove the item (any signed-in user who can see it): filed as a Reclaimerr deletion request.</summary>
        [HttpPost("request")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> RequestRemoval([FromBody] ReclaimerrItemRequest request, CancellationToken token)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!ReclaimerrActions.RequestsEnabled(config)) return NotFound();
            var item = request?.ItemId is { } id ? Find(id) : null;
            if (item == null || !CanSee(item)) return BadRequest(new { error = "Unknown item." });
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId is not { } who || who == Guid.Empty) return Forbid();
            try
            {
                var (state, existing) = await _reclaimerr.RequestRemovalAsync(item, who, CurrentUserName() ?? "a user", request!.Reason, config!, token).ConfigureAwait(false);
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

        /// <summary>Approve a pending Reclaimerr deletion request. Administrators only.</summary>
        [HttpPost("requests/{requestId:int}/approve")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Approve([FromRoute] int requestId, [FromBody] ReclaimerrReviewRequest? body, CancellationToken token) => ReviewAsync(requestId, true, body, token);

        /// <summary>Deny a pending Reclaimerr deletion request. Administrators only.</summary>
        [HttpPost("requests/{requestId:int}/deny")]
        [Authorize]
        [Produces("application/json")]
        public Task<IActionResult> Deny([FromRoute] int requestId, [FromBody] ReclaimerrReviewRequest? body, CancellationToken token) => ReviewAsync(requestId, false, body, token);

        private async Task<IActionResult> ReviewAsync(int requestId, bool approve, ReclaimerrReviewRequest? body, CancellationToken token)
        {
            if (!IsAdmin()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.LeavingSoonPageEnabled || !ReclaimerrActions.Enabled(config)) return NotFound();
            if (!string.IsNullOrEmpty(body?.Source) && !string.Equals(body.Source, ReclaimerrApi.SourceId(config), StringComparison.Ordinal))
                return Conflict(new { error = "The Reclaimerr address changed since this list was read. Reload it." });
            try
            {
                var timing = body?.When?.ToLowerInvariant() switch
                {
                    "now" => ReclaimerrActions.ApprovalTiming.Now,
                    "date" => ReclaimerrActions.ApprovalTiming.OnDate,
                    _ => ReclaimerrActions.ApprovalTiming.GracePeriod,
                };
                await _reclaimerr.ReviewRequestAsync(requestId, approve, body?.Note, CurrentUserName(), config, token, timing, body?.Date, body?.GraceDays).ConfigureAwait(false);
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

        private async Task<IActionResult> RunAsync(ReclaimerrItemRequest? request, Func<BaseItem, Configuration.PluginConfiguration, Task<MaintainerrItemState>> action)
        {
            if (!IsAdmin()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!ReclaimerrActions.Enabled(config)) return NotFound();
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
                return StatusCode(502, new { error = "Reclaimerr: " + MaintainerrHttp.Describe(ex) });
            }
        }

        /// <summary>What the import and the audit say while Reclaimerr is not set up (they do not need the item-menu actions).</summary>
        private const string SetUpFirst = "Turn on Use Reclaimerr and save its URL and API token first.";

        /// <summary>
        /// Audit every Jellyfin user against Reclaimerr, read-only: the linked account, and with removal requests on whether Reclaimerr's
        /// trusted-proxy sign-in accepts it and whether it may request; plus the token scopes the integration uses that the token lacks.
        /// Administrators only. Answers <c>{version, requestsEnabled, issues[], users[]}</c>, or <c>400</c> while Reclaimerr is not set up.
        /// </summary>
        [HttpGet("user-audit")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> UserAudit(CancellationToken token)
        {
            if (!IsAdmin()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !LeavingSoonService.UsesReclaimerr(config) || !LeavingSoonService.ApiConfigured(config)) return BadRequest(new { error = SetUpFirst });
            try
            {
                var users = UserManager.GetAllUsers().Select(u => (u.Id, u.Username, u.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator))).ToList();
                return Ok(await _reclaimerr.AuditUsersAsync(config, users, token).ConfigureAwait(false));
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
        /// Import this server's users into Reclaimerr through its token API: every Jellyfin user without a Reclaimerr account gets one,
        /// with the permissions and pages picked, linked to them. Administrators only. Answers <c>{created, alreadyLinked, needsReview, skipped}</c>
        /// (Jellyfin user names; <c>needsReview</c> are matched to an existing Reclaimerr account, which an administrator confirms in Reclaimerr).
        /// </summary>
        [HttpPost("import-users")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> ImportUsers([FromBody] ReclaimerrImportUsersRequest? request, CancellationToken token)
        {
            if (!IsAdmin()) return Forbid();
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !LeavingSoonService.UsesReclaimerr(config) || !LeavingSoonService.ApiConfigured(config)) return BadRequest(new { error = SetUpFirst });
            try
            {
                var users = UserManager.GetAllUsers().ToDictionary(u => u.Id, u => u.Username);
                var result = await _reclaimerr.ImportUsersAsync(config, users, request?.Permissions ?? Array.Empty<string>(), request?.Pages ?? Array.Empty<string>(), token).ConfigureAwait(false);
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
    }
}
