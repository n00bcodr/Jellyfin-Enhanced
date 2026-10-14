using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// The hub's household views of the request ledger: approval cards and the home chip bar's counts
    /// (Managers and Admins), the caller's own requests with display data (everyone), and the
    /// Household tab (Managers read, Jellyfin administrators also save roles, presets and quotas).
    /// Every route resolves a real person; answers are private to the caller.
    /// </summary>
    [ApiController]
    [RequestOutcomeFilter]
    [Route("JellyfinEnhanced")]
    public sealed class AcquireHouseholdController : ControllerBase
    {
        /// <summary>Maximum household save payload size.</summary>
        public const int MaxBodyBytes = 64 * 1024;
        private readonly RequestHubProjection _hub;
        private readonly HouseholdService _household;

        /// <summary>Creates the controller.</summary>
        public AcquireHouseholdController(RequestHubProjection hub, HouseholdService household)
        {
            _hub = hub;
            _household = household;
        }

        private RequestService Service => _hub.Service;

        private StatusViewer? Person() => ArrCaller.Human(User, Service.View);

        private IActionResult Reply(RequestOutcome outcome)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            return StatusCode(outcome.HttpStatus, outcome);
        }

        /// <summary>Refuses callers that aren't a known person, a disabled feature, missing roles or storage.</summary>
        private RequestOutcome? Gate(StatusViewer? viewer, bool approver)
        {
            if (viewer == null) return RequestOutcome.Refused("user_required");
            if (!Service.Enabled) return RequestOutcome.Refused("feature_disabled");
            var facts = Service.Identity(viewer.UserId);
            if (facts.Refusal == "user_required") return RequestOutcome.Refused("user_required");
            if (approver && facts.Role is not ("Manager" or "Admin")) return RequestOutcome.Refused("requests_approve_required");
            if (!Service.Ledger.Database.Available) return RequestOutcome.Refused("database_unavailable", 503, "unavailable");
            return null;
        }

        private IActionResult Private(StatusBody body)
        {
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = body.ETag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], body.ETag)) return StatusCode(304);
            return File(body.Json, "application/json; charset=utf-8");
        }

        /// <summary>
        /// Approval cards: pending requests on titles the caller can see, with the title, who asked,
        /// their role and request use, a limited requester's rating line, who else wants it and the
        /// size estimate. Managers and Admins only.
        /// </summary>
        [Authorize]
        [HttpGet("acquire/requests/approvals")]
        public async Task<IActionResult> Approvals(CancellationToken ct = default)
        {
            var viewer = Person();
            if (Gate(viewer, true) is { } refusal) return Reply(refusal);
            await Service.Policy.PrepareIdentityAsync(viewer!.UserId, true, ct).ConfigureAwait(false);
            if (Gate(Person(), true) is { } changed) return Reply(changed);
            return Private(await _hub.ApprovalsAsync(viewer, ct).ConfigureAwait(false));
        }

        /// <summary>The caller's own requests in the ledger with display data and whether each can still be cancelled.</summary>
        [Authorize]
        [HttpGet("acquire/requests/mine")]
        public async Task<IActionResult> Mine(CancellationToken ct = default)
        {
            var viewer = Person();
            if (Gate(viewer, false) is { } refusal) return Reply(refusal);
            return Private(await _hub.MineAsync(viewer!, ct).ConfigureAwait(false));
        }

        /// <summary>
        /// The home chip bar's counts (requests waiting for the caller's OK, and stuck ones). Managers
        /// and Admins only; no network.
        /// </summary>
        [Authorize]
        [HttpGet("acquire/requests/attention")]
        public IActionResult Attention()
        {
            var viewer = Person();
            if (Gate(viewer, true) is { } refusal) return Reply(refusal);
            return Private(_hub.Attention(viewer!));
        }

        /// <summary>The household as the caller may see it (Managers: people sharing a library; Admins: everyone and the settings).</summary>
        [Authorize]
        [HttpGet("acquire/household")]
        public async Task<IActionResult> Household(CancellationToken ct = default)
        {
            var viewer = Person();
            if (Gate(viewer, true) is { } refusal) return Reply(refusal);
            return Private(await _household.ReadAsync(viewer!, ct).ConfigureAwait(false));
        }

        /// <summary>Saves roles, per-person quotas, role defaults, the preset and the default role. Jellyfin administrators only.</summary>
        [Authorize]
        [HttpPost("acquire/household")]
        [BodyLimit(MaxBodyBytes)]
        public IActionResult SaveHousehold([FromBody] HouseholdSave? body)
        {
            var viewer = Person();
            if (Gate(viewer, true) is { } refusal) return Reply(refusal);
            if (!viewer!.IsAdmin) return Reply(RequestOutcome.Refused("admin_required"));
            return Reply(_household.Save(viewer, body));
        }
    }
}
