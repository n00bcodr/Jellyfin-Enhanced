using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Durable request API. Every route resolves a real person and checks explicit request capabilities.</summary>
    [ApiController]
    [RequestOutcomeFilter]
    [Route("JellyfinEnhanced")]
    public sealed class AcquireRequestsController : ControllerBase
    {
        private readonly RequestService _service;
        private readonly SeasonRowsService? _rows;
        private readonly RequestSearchService? _search;
        private readonly ArrStatusService? _status;
        /// <summary>Maximum request payload size.</summary>
        public const int MaxBodyBytes = 64 * 1024;
        /// <summary>Creates the controller; <paramref name="status"/> works a season page's press out again (D53, edition round 19).</summary>
        public AcquireRequestsController(RequestService service, SeasonRowsService? rows = null, RequestSearchService? search = null, ArrStatusService? status = null) { _service = service; _rows = rows; _search = search; _status = status; }
        private StatusViewer? Person() => ArrCaller.Human(User, _service.View);
        private IActionResult Reply(RequestOutcome outcome) { Response.Headers["Cache-Control"] = "private, no-store"; return StatusCode(outcome.HttpStatus, outcome); }
        private RequestOutcome? Gate(StatusViewer? viewer, bool approve = false, bool readOnly = false)
        {
            if (viewer == null) return RequestOutcome.Refused("user_required");
            if (!_service.Enabled) return RequestOutcome.Refused("feature_disabled");
            var facts = _service.Identity(viewer.UserId);
            if (facts.Refusal == "user_required") return RequestOutcome.Refused("user_required");
            if (approve ? facts.Role is not ("Manager" or "Admin") : !readOnly && facts.Role == "Watcher") return RequestOutcome.Refused(approve ? "requests_approve_required" : "requests_create_required");
            if (!_service.Ledger.Database.Available) return RequestOutcome.Refused("database_unavailable", 503, "unavailable");
            return null;
        }
        private static bool ValidId(string? id) => Guid.TryParseExact(id, "N", out var value) && value != Guid.Empty;
        /// <summary>Create movie, season, episode, future-season or next-season intent.</summary>
        [Authorize]
        [HttpPost("acquire/requests")]
        [BodyLimit(MaxBodyBytes)]
        public async Task<IActionResult> Create([FromBody] CreateRequest? body, CancellationToken ct)
        {
            var viewer = Person();
            if (Gate(viewer) is { } refusal) return Reply(refusal);
            // A season page's press is worked out again by the server right before the ask is recorded (nothing on a difference).
            // A synthetic absent season page (Jellyfin 12's native details) is checked as that page, under its viewer rules.
            var pages = HttpContext?.RequestServices?.GetService(typeof(IAbsentTitlePages)) as IAbsentTitlePages;
            Func<MutationInput, CancellationToken, Task<PressProof>>? press = body?.Expect is { } expect
                ? (input, token) => _status == null ? Task.FromResult(new PressProof(PressChecks.Unverified)) : _status.PressAsync(viewer!, expect, PressChecks.Ask, input, null, token, pages)
                : null;
            return Reply(await _service.CreateAsync(viewer!.UserId, body, ct, press: press).ConfigureAwait(false));
        }
        /// <summary>
        /// Search again for a movie, one episode, or a series' or season's episodes that requests already sent
        /// and that have been missing for a long while (anyone who may ask; no new request, no charge, no OK
        /// needed). <c>found</c> says whether the search grabbed a copy (null: not known). Outcome <c>skipped</c> (<c>not_requested</c>,
        /// <c>not_searchable</c>): nothing was searched; ask for it instead.
        /// </summary>
        [Authorize]
        [HttpPost("acquire/requests/search")]
        [BodyLimit(MaxBodyBytes)]
        public async Task<IActionResult> Search([FromBody] RequestSearchBody? body, CancellationToken ct)
        {
            var viewer = Person();
            if (Gate(viewer) is { } refusal) return Reply(refusal);
            if (_search == null) return Reply(RequestOutcome.Refused("feature_disabled"));
            var pages = HttpContext?.RequestServices?.GetService(typeof(IAbsentTitlePages)) as IAbsentTitlePages;
            var (outcome, found) = await _search.SearchAsync(viewer!, body?.Key, body?.IdempotencyKey, ct, body?.Expect, pages).ConfigureAwait(false);
            if (outcome.HttpStatus >= 400) return Reply(outcome);
            Response.Headers["Cache-Control"] = "private, no-store";
            return Ok(new { outcome = outcome.Outcome, reason = outcome.Reason, certainty = outcome.Certainty.ToString(), message = outcome.Message, found });
        }
        /// <summary>Cancel an unsent own request (administrators may cancel visible requests).</summary>
        [Authorize]
        [HttpPost("acquire/requests/{id}/cancel")]
        [BodyLimit(MaxBodyBytes)]
        public IActionResult Cancel([FromRoute] string id)
        {
            var viewer = Person();
            if (Gate(viewer, readOnly: true) is { } refusal) return Reply(refusal);
            if (!ValidId(id)) return Reply(RequestOutcome.Refused("invalid_id", 400));
            return Reply(_service.Close(id, viewer!.UserId, null));
        }
        /// <summary>Approve a pending want, optionally editing scope and edition; routing edits require Admin.</summary>
        [Authorize]
        [HttpPost("acquire/requests/{id}/approve")]
        [BodyLimit(MaxBodyBytes)]
        public async Task<IActionResult> Approve([FromRoute] string id, [FromBody] ApproveRequest? body, CancellationToken ct)
        {
            var viewer = Person();
            if (Gate(viewer, true) is { } refusal) return Reply(refusal);
            if (!ValidId(id)) return Reply(RequestOutcome.Refused("invalid_id", 400));
            return Reply(await _service.ApproveAsync(id, viewer!.UserId, body, ct).ConfigureAwait(false));
        }
        /// <summary>Decline with a safe plain-text explanation.</summary>
        [Authorize]
        [HttpPost("acquire/requests/{id}/decline")]
        [BodyLimit(MaxBodyBytes)]
        public async Task<IActionResult> Decline([FromRoute] string id, [FromBody] DeclineRequest? body, CancellationToken ct = default)
        {
            var viewer = Person();
            if (Gate(viewer, true) is { } refusal) return Reply(refusal);
            if (!ValidId(id) || string.IsNullOrWhiteSpace(body?.Reason)) return Reply(RequestOutcome.Refused("invalid_input", 400));
            return Reply(await _service.DeclineAsync(id, viewer!.UserId, body.Reason, ct).ConfigureAwait(false));
        }
        /// <summary>Approve at most twenty rows with independent checks and per-item outcomes.</summary>
        [Authorize]
        [HttpPost("acquire/requests/bulk-approve")]
        [BodyLimit(MaxBodyBytes)]
        public async Task<IActionResult> BulkApprove([FromBody] BulkApproveRequest? body, CancellationToken ct)
        {
            var viewer = Person();
            if (Gate(viewer, true) is { } refusal) return Reply(refusal);
            if (body?.Ids is not { Length: > 0 and <= 20 } || body.Ids.Any(id => !ValidId(id))) return Reply(RequestOutcome.Refused("invalid_input", 400));
            var outcomes = new List<RequestOutcome>();
            foreach (var id in body.Ids) outcomes.Add(await _service.ApproveAsync(id, viewer!.UserId, null, ct).ConfigureAwait(false));
            Response.Headers["Cache-Control"] = "private, no-store";
            return StatusCode(outcomes.All(o => o.HttpStatus < 400) ? 200 : 207, new { outcome = "accepted", reason = "bulk_checked", certainty = "Succeeded", message = "Each request was checked.", items = outcomes });
        }
        /// <summary>Own requests, or pending requests visible to an approver.</summary>
        [Authorize]
        [HttpGet("acquire/requests")]
        public async Task<IActionResult> List([FromQuery] string view = "mine", CancellationToken ct = default)
        {
            var viewer = Person();
            if (Gate(viewer, view == "pending", true) is { } refusal) return Reply(refusal);
            if (view is not ("mine" or "pending")) return Reply(RequestOutcome.Refused("invalid_view", 400));
            await _service.Policy.PrepareIdentityAsync(viewer!.UserId, true, ct).ConfigureAwait(false);
            if (Gate(Person(), view == "pending", true) is { } changed) return Reply(changed);
            var body = _service.List(viewer.UserId, view == "pending");
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = body.ETag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], body.ETag)) return StatusCode(304);
            return File(body.Json, "application/json; charset=utf-8");
        }
        /// <summary>Quota usage and the next expiry that makes a slot usable.</summary>
        [Authorize]
        [HttpGet("acquire/requests/quota")]
        public async Task<IActionResult> Quota(CancellationToken ct = default, [FromQuery] string mediaType = "movie")
        {
            var viewer = Person();
            if (Gate(viewer, readOnly: true) is { } refusal) return Reply(refusal);
            Response.Headers["Cache-Control"] = "private, no-store";
            if (mediaType is not ("movie" or "tv")) return Reply(RequestOutcome.Refused("invalid_input", 400));
            await _service.Policy.PrepareIdentityAsync(viewer!.UserId, mediaType == "movie", ct).ConfigureAwait(false);
            if (Gate(Person(), readOnly: true) is { } changed) return Reply(changed);
            var quota = _service.Quota(viewer.UserId, mediaType == "movie");
            // Group quotas (phase 4b): the shared pool the caller's requests draw on, as an aggregate (only when there is one).
            if (_service.Pool(viewer.UserId) is { } pool)
                return Ok(new { outcome = "accepted", reason = "quota", certainty = "Succeeded", message = "Request allowance", quota, pool = new { name = pool.Pool.Name, used = pool.Use.Used, limit = pool.Pool.Limit, remaining = pool.Use.Remaining, nextSlotAt = pool.Use.NextSlotAt } });
            return Ok(new { outcome = "accepted", reason = "quota", certainty = "Succeeded", message = "Request allowance", quota });
        }
        /// <summary>The caller's own request capabilities (role, may ask, may approve, 4K, contact word).</summary>
        [Authorize]
        [HttpGet("acquire/requests/me")]
        public async Task<IActionResult> Me(CancellationToken ct = default)
        {
            var viewer = Person();
            if (Gate(viewer, readOnly: true) is { } refusal) return Reply(refusal);
            await _service.Policy.PrepareIdentityAsync(viewer!.UserId, true, ct).ConfigureAwait(false);
            await _service.PreparePausesAsync(ct).ConfigureAwait(false);
            if (Gate(Person(), readOnly: true) is { } changed) return Reply(changed);
            Response.Headers["Cache-Control"] = "private, no-store";
            return Ok(new { outcome = "accepted", reason = "me", certainty = "Succeeded", message = "Your requests", me = _service.Me(viewer.UserId) });
        }
        /// <summary>
        /// Whether the caller may ask for one title now (<paramref name="variant"/> standard or 4k), and if not, why
        /// (for example <c>low_disk</c>: "Paused: storage full"; instance, folder and free space for administrators
        /// only). For the controls of the title page and the request sheet; no network I/O.
        /// </summary>
        [Authorize]
        [HttpGet("acquire/requests/check")]
        public async Task<IActionResult> Check([FromQuery] string? key = null, [FromQuery] string? variant = null, CancellationToken ct = default)
        {
            var viewer = Person();
            if (Gate(viewer, readOnly: true) is { } refusal) return Reply(refusal);
            if (key == null || key.Length > 200 || variant is not (null or "standard" or "4k")) return Reply(RequestOutcome.Refused("invalid_input", 400));
            if (await _service.CheckAsync(viewer!.UserId, key, variant, ct).ConfigureAwait(false) is not { } check) return Reply(RequestOutcome.Refused("invalid_input", 400));
            Response.Headers["Cache-Control"] = "private, no-store";
            return Ok(new { outcome = "accepted", reason = "check", certainty = "Succeeded", message = "Request check", check });
        }
        /// <summary>
        /// One season's request rows: the caller's request state per episode and the metadata of the
        /// episodes Jellyfin has no file for (title, air date, runtime, overview, TMDB still path), for
        /// the "Get it" controls and the rows JE draws for missing episodes. Items the caller can't see
        /// get 404 like any other id.
        /// </summary>
        [Authorize]
        [HttpGet("acquire/requests/season/{itemId}")]
        public async Task<IActionResult> Season([FromRoute] string itemId, [FromQuery] string? language = null, CancellationToken ct = default)
        {
            var viewer = Person();
            if (Gate(viewer, readOnly: true) is { } refusal) return Reply(refusal);
            if (!Guid.TryParse(itemId, out var seasonId) || seasonId == Guid.Empty) return Reply(RequestOutcome.Refused("invalid_id", 400));
            if (_rows == null) return Reply(RequestOutcome.Refused("feature_disabled"));
            SeasonRows? rows;
            // A season page of a title that isn't in the library (native details, Jellyfin 12): under the
            // page's own viewer rules; a page the viewer may not open is not found, like any other id.
            var absent = HttpContext?.RequestServices?.GetService(typeof(IAbsentTitlePages)) is IAbsentTitlePages pages
                ? await pages.ResolveAsync(viewer!.UserId, seasonId, ct).ConfigureAwait(false)
                : AbsentPageResult.NotAbsent;
            if (absent.Outcome == AbsentLookup.NotAbsent) rows = await _rows.ForSeasonAsync(viewer!, seasonId, language, ct).ConfigureAwait(false);
            else rows = absent.Outcome == AbsentLookup.Found && absent.Title != null ? await _rows.ForAbsentSeasonAsync(viewer!, absent.Title, language, ct).ConfigureAwait(false) : null;
            if (rows == null) return Reply(RequestOutcome.Refused("not_found", 404));
            var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { outcome = "accepted", reason = "season", certainty = "Succeeded", message = "Season", rows });
            var etag = "\"" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(viewer!.UserId.ToString("N") + "|")
                .Concat(bytes).ToArray()), 0, 16) + "\"";
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = etag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], etag)) return StatusCode(304);
            return File(bytes, "application/json; charset=utf-8");
        }
        /// <summary>Lab-only crash checkpoint: persist a sending row without contacting any transport.</summary>
        [Authorize]
        [HttpPost("acquire/requests/lab/{id}/hold")]
        [BodyLimit(MaxBodyBytes)]
        public IActionResult LabHold([FromRoute] string id)
        {
            var viewer = Person();
            if (viewer?.IsAdmin != true) return Reply(RequestOutcome.Refused(viewer == null ? "user_required" : "admin_required"));
            if (!_service.Policy.Configuration.ArrRequestLabEnabled) return Reply(RequestOutcome.Refused("feature_disabled"));
            if (!ValidId(id)) return Reply(RequestOutcome.Refused("invalid_id", 400));
            return Reply(_service.Ledger.LabHold(id, DateTimeOffset.UtcNow) ? RequestOutcome.Accepted(id, "lab_hold", 200) : RequestOutcome.Refused("request_changed", 409));
        }

        /// <summary>Lab-only deletion of rows carrying the CLI prefix. Default off; never calls a backend.</summary>
        [Authorize]
        [HttpDelete("acquire/requests/lab/{id}")]
        public IActionResult LabDelete([FromRoute] string id)
        {
            var viewer = Person();
            if (viewer?.IsAdmin != true) return Reply(RequestOutcome.Refused(viewer == null ? "user_required" : "admin_required"));
            if (!_service.Policy.Configuration.ArrRequestLabEnabled) return Reply(RequestOutcome.Refused("feature_disabled"));
            if (!ValidId(id)) return Reply(RequestOutcome.Refused("invalid_id", 400));
            return Reply(_service.Ledger.LabDelete(id) ? RequestOutcome.Accepted(id, "removed", 200) : RequestOutcome.Refused("not_found", 404));
        }
    }
}
