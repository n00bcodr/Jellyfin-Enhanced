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
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of the service-account route.</summary>
    public class ReclaimerrActionRequest
    {
        /// <summary>Create service account: a Reclaimerr administrator, used for this one call and never stored.</summary>
        [JsonPropertyName("adminUsername")] public string? AdminUsername { get; set; }
        [JsonPropertyName("adminPassword")] public string? AdminPassword { get; set; }
    }

    /// <summary>Body of the create-users route: what every new account gets.</summary>
    public class ReclaimerrCreateUsersRequest
    {
        [JsonPropertyName("permissions")] public string[]? Permissions { get; set; }
        [JsonPropertyName("pages")] public string[]? Pages { get; set; }
    }

    /// <summary>Body of the request review routes.</summary>
    public class ReclaimerrReviewRequest
    {
        [JsonPropertyName("note")] public string? Note { get; set; }
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
    /// Reclaimerr's item-menu actions and its service account. <c>item</c> answers the administrator or, for anyone who can
    /// see the item, whether they may request a removal; <c>mark</c>, <c>unmark</c> and <c>postpone</c> are administrator-only;
    /// <c>request</c> is any signed-in user. Answers <c>404</c> while Reclaimerr is not the tool in use, <c>400</c> with
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
            var name = CurrentUserName() ?? "a user";
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
            try
            {
                await _reclaimerr.ReviewRequestAsync(requestId, approve, body?.Note, CurrentUserName(), config, token).ConfigureAwait(false);
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

        /// <summary>
        /// Create a Reclaimerr account for every Jellyfin user that has none, with the permissions and pages picked, through the
        /// service account, and map each new account to its Jellyfin user. Administrators only. Answers <c>{created, existing, skipped}</c>.
        /// </summary>
        [HttpPost("create-users")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> CreateUsers([FromBody] ReclaimerrCreateUsersRequest? request, CancellationToken token)
        {
            if (!IsAdmin()) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            var config = plugin?.Configuration;
            if (plugin == null || config == null || !ReclaimerrActions.Enabled(config)) return NotFound();
            try
            {
                var names = UserManager.GetAllUsers().Select(u => u.Username).ToList();
                var result = await _reclaimerr.CreateAccountsAsync(config, names, request?.Permissions ?? Array.Empty<string>(), request?.Pages ?? Array.Empty<string>(), token).ConfigureAwait(false);
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

        /// <summary>
        /// Create the plugin's Reclaimerr service account (<c>jellyfin-enhanced</c>, admin, random password) by signing
        /// in once as a Reclaimerr administrator, and save its login in the configuration. Administrators only; the
        /// administrator's password is used for this call only. Answers <c>{username}</c>.
        /// </summary>
        [HttpPost("service-account")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> CreateServiceAccount([FromBody] ReclaimerrActionRequest request, CancellationToken token)
        {
            if (!IsAdmin()) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            var config = plugin?.Configuration;
            if (plugin == null || config == null || !LeavingSoonService.IsMaintainerrUrl(config.ReclaimerrUrl)) return BadRequest(new { error = "Save the Reclaimerr URL first." });
            if (string.IsNullOrWhiteSpace(request?.AdminUsername)) return BadRequest(new { error = "Enter a Reclaimerr administrator's username." });
            try
            {
                var (username, password) = await ReclaimerrSession.CreateServiceAccountAsync(HttpContext.RequestServices.GetRequiredService<System.Net.Http.IHttpClientFactory>(), config, request.AdminUsername!, request.AdminPassword ?? string.Empty, TimeSpan.FromSeconds(30), token).ConfigureAwait(false);
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
    }
}
