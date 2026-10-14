using System;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST /JellyfinEnhanced/arr/admin/manage/search.</summary>
    public class ManageSearchRequest
    {
        /// <summary>The instance to search on.</summary>
        [JsonPropertyName("instanceId")] public string? InstanceId { get; set; }

        /// <summary>Title key in scope (movie, series, season or episode).</summary>
        [JsonPropertyName("key")] public string? Key { get; set; }

        /// <summary>One key per click (a repeated click gets the first outcome).</summary>
        [JsonPropertyName("idempotencyKey")] public string? IdempotencyKey { get; set; }
    }

    /// <summary>
    /// Phase 1 of "Requests &amp; downloads": the Requests page (<c>GET acquire/hub</c>, any signed-in
    /// user, their own requests only) and the administrator's Manage drawer
    /// (<c>GET arr/admin/manage</c>, <c>POST arr/admin/manage/search</c>). The Requests page is served
    /// from memory (no Sonarr, Radarr or Seerr call on the request) with a private ETag; the Manage
    /// drawer is for Jellyfin administrators only (403 for anyone else) and Search now is audited.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class RequestsHubController : ControllerBase
    {
        private static readonly JsonSerializerOptions CamelCase = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        private readonly RequestsHubService _hub;
        private readonly ArrManageService _manage;
        private readonly IUserManager? _userManager;

        /// <summary>Creates the controller.</summary>
        public RequestsHubController(RequestsHubService hub, ArrManageService manage, IUserManager userManager)
        {
            _hub = hub;
            _manage = manage;
            _userManager = userManager;
        }

        /// <summary>Creates the controller without a user manager (tests; Search now's audit line then has no user name).</summary>
        internal RequestsHubController(RequestsHubService hub, ArrManageService manage)
        {
            _hub = hub;
            _manage = manage;
        }

        /// <summary>
        /// The Requests page: the caller's own requests (My requests, Coming soon, Ready), each with
        /// its status. Administrators also get the Downloads/Calendar tab switches and the request
        /// list's state; nobody else's requests are ever included.
        /// </summary>
        [HttpGet("acquire/hub")]
        [Authorize]
        public async Task<IActionResult> GetHub(CancellationToken cancellationToken)
        {
            if (!_hub.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (Viewer(_hub.Status) is not { } viewer) return StatusCode(403, new { code = "user_required" });
            using var scope = _hub.Status.Store.BeginRequest("acquire/hub");
            var body = await _hub.ForViewerAsync(viewer, cancellationToken).ConfigureAwait(false);
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = body.ETag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], body.ETag)) return StatusCode(304);
            return File(body.Json, "application/json; charset=utf-8");
        }

        /// <summary>
        /// The Manage drawer's Overview for a Jellyfin item (<paramref name="itemId"/>) or a title key
        /// (<paramref name="key"/>, for titles not in Jellyfin): explanation, timeline per instance,
        /// versions across instances and Seerr's requests. Administrators only.
        /// </summary>
        [HttpGet("arr/admin/manage")]
        [Authorize]
        [PrivateResponse]
        public async Task<IActionResult> GetManage([FromQuery] string? itemId, [FromQuery] string? key, CancellationToken cancellationToken)
        {
            if (Viewer(_manage.Status) is not { IsAdmin: true } viewer) return Forbid();
            if (!_manage.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            Guid? id = null;
            if (!string.IsNullOrEmpty(itemId))
            {
                if (!Guid.TryParse(itemId, out var parsed)) return BadRequest(new { code = "invalid_id" });
                id = parsed;
            }
            else if (TitleKey.Parse(key) == null)
            {
                return BadRequest(new { code = "invalid_key" });
            }
            if (_manage.Resolve(viewer, id, key) is not { } target) return NotFound(new { code = "not_found" });
            using var scope = _manage.Status.Store.BeginRequest("arr/admin/manage");
            var overview = await _manage.OverviewAsync(viewer, target.Key, target.Item, cancellationToken).ConfigureAwait(false);
            return File(JsonSerializer.SerializeToUtf8Bytes(overview, CamelCase), "application/json; charset=utf-8");
        }

        /// <summary>
        /// Search now for the title in scope on one instance (administrators only; audited, one idempotency
        /// key per click). <c>found</c> says whether the search grabbed a copy (null: not known).
        /// </summary>
        [HttpPost("arr/admin/manage/search")]
        [Authorize]
        [PrivateResponse]
        [BodyLimit]
        public async Task<IActionResult> Search([FromBody] ManageSearchRequest? request, CancellationToken cancellationToken)
        {
            if (Viewer(_manage.Status) is not { IsAdmin: true } viewer) return Forbid();
            if (!_manage.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (request == null || string.IsNullOrWhiteSpace(request.InstanceId) || TitleKey.Parse(request.Key) is not { } key)
                return BadRequest(new { code = "invalid_request" });
            if (string.IsNullOrWhiteSpace(request.IdempotencyKey) || request.IdempotencyKey.Length > 64)
                return BadRequest(new { code = "idempotency_key_required" });
            string? userName = null;
            try
            {
                userName = _userManager?.GetUserById(viewer.UserId)?.Username;
            }
            catch (Exception)
            {
                // The audit line keeps the user id either way.
            }
            var result = await _manage.SearchCheckedAsync(viewer, userName, request.InstanceId, key, request.IdempotencyKey, cancellationToken).ConfigureAwait(false);
            var outcome = result.Outcome;
            return Ok(new
            {
                found = result.Found,
                status = outcome.Status,
                message = outcome.Message,
                readBack = outcome.ReadBack?.Summary,
                confirmed = outcome.ReadBack?.Confirmed,
                auditId = outcome.AuditId,
                replayed = outcome.Replayed,
                error = outcome.Error == null ? null : new { kind = outcome.Error.Kind, message = outcome.Error.Message },
            });
        }

        // A person only (never an API key or an unknown user).
        private StatusViewer? Viewer(ArrStatusService status) => ArrCaller.Human(User, status.View);
    }
}
