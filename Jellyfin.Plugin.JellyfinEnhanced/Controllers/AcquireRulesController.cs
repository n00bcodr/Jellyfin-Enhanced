using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>One ask in a batch preview.</summary>
    public sealed record RequestPreviewItem
    {
        /// <summary>The id the ask would be made with (optional; one is made up for the preview).</summary>
        [JsonPropertyName("clientRequestId")] public string? ClientRequestId { get; init; }

        /// <summary>The scope.</summary>
        [JsonPropertyName("input")] public MutationInput? Input { get; init; }
    }

    /// <summary>Body of POST acquire/requests/preview.</summary>
    public sealed record RequestPreviewBody
    {
        /// <summary>The asks, in order (at most 20).</summary>
        [JsonPropertyName("items")] public List<RequestPreviewItem?>? Items { get; init; }
    }

    /// <summary>
    /// Phase 4b household rules: the administrators' rules editor (fixed conditions per role, streaming country and
    /// services, group pools; Seerr's own rules read-only in Seerr mode) and the batch preview a "request all missing"
    /// shows before anything is asked (cost, what goes now and what waits for an OK). Every route resolves a real person;
    /// answers are private and never cached.
    /// </summary>
    [ApiController]
    [RequestOutcomeFilter]
    [Route("JellyfinEnhanced")]
    public sealed class AcquireRulesController : ControllerBase
    {
        /// <summary>Maximum rules save payload size.</summary>
        public const int MaxBodyBytes = 64 * 1024;

        /// <summary>Maximum batch preview payload size.</summary>
        public const int MaxPreviewBytes = 64 * 1024;

        private readonly HouseholdRulesService _rules;

        /// <summary>Creates the controller.</summary>
        public AcquireRulesController(HouseholdRulesService rules) { _rules = rules; }

        private RequestService Service => _rules.Requests;

        private StatusViewer? Person() => ArrCaller.Human(User, Service.View);

        private IActionResult Reply(RequestOutcome outcome)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            return StatusCode(outcome.HttpStatus, outcome);
        }

        /// <summary>Refuses callers that aren't a known person, a disabled feature, or (admin) a non-administrator.</summary>
        private RequestOutcome? Gate(StatusViewer? viewer, bool admin)
        {
            if (viewer == null) return RequestOutcome.Refused("user_required");
            if (!Service.Enabled || !HouseholdFlags.Rules(Service.Policy.Configuration)) return RequestOutcome.Refused("feature_disabled");
            if (Service.Identity(viewer.UserId).Refusal == "user_required") return RequestOutcome.Refused("user_required");
            if (admin && !viewer.IsAdmin) return RequestOutcome.Refused("admin_required");
            return null;
        }

        /// <summary>The household rules as administrators edit them (and Seerr's own rules, read-only, in Seerr mode). Administrators only.</summary>
        [Authorize]
        [HttpGet("acquire/household/rules")]
        public async Task<IActionResult> Rules(CancellationToken ct = default)
        {
            if (Gate(Person(), true) is { } refusal) return Reply(refusal);
            Response.Headers["Cache-Control"] = "private, no-store";
            return File(await _rules.ReadAsync(ct).ConfigureAwait(false), "application/json; charset=utf-8");
        }

        /// <summary>Saves the conditions, streaming settings and pools. Administrators only; Jellyfin Enhanced handling only.</summary>
        [Authorize]
        [HttpPost("acquire/household/rules")]
        [BodyLimit(MaxBodyBytes)]
        public IActionResult SaveRules([FromBody] HouseholdRulesSave? body)
        {
            var viewer = Person();
            if (Gate(viewer, true) is { } refusal) return Reply(refusal);
            return Reply(_rules.Save(viewer!, body));
        }

        /// <summary>The streaming services TMDB lists for a country, to pick the household's from. Administrators only.</summary>
        [Authorize]
        [HttpGet("acquire/household/streaming-services")]
        public async Task<IActionResult> StreamingServices([FromQuery] string? country = null, CancellationToken ct = default)
        {
            if (Gate(Person(), true) is { } refusal) return Reply(refusal);
            var code = (country ?? string.Empty).Trim().ToUpperInvariant();
            if (!HouseholdRules.ValidCountry(code)) return Reply(RequestOutcome.Refused("invalid_country", 400));
            var list = await _rules.ServicesAsync(code, ct).ConfigureAwait(false);
            Response.Headers["Cache-Control"] = "private, no-store";
            if (list == null) return StatusCode(503, RequestOutcome.Refused("tmdb_unavailable", 503, "unavailable") with { Message = "TMDB's list of streaming services couldn't be read." });
            return Ok(new { outcome = "accepted", reason = "streaming_services", certainty = "Succeeded", message = "Streaming services", country = code, services = list.Select(p => new { id = p.Id, name = p.Name }) });
        }

        /// <summary>
        /// What a batch of asks made one after another would do now, nothing written (at most 20): per ask the outcome,
        /// status, reason, cost and size estimate (and the household-rule conditions behind a refusal or a wait), plus a
        /// summary: how many would go ahead, wait for an OK or be refused, the allowance they'd use, and the caller's
        /// allowance and group pool now. Anyone who may ask; phase 4 with phase 3.
        /// </summary>
        [Authorize]
        [HttpPost("acquire/requests/preview")]
        [BodyLimit(MaxPreviewBytes)]
        public async Task<IActionResult> Preview([FromBody] RequestPreviewBody? body, CancellationToken ct = default)
        {
            var viewer = Person();
            if (viewer == null) return Reply(RequestOutcome.Refused("user_required"));
            if (!Service.Enabled || !AutomationFlags.Phase4WithRequests(Service.Policy.Configuration)) return Reply(RequestOutcome.Refused("feature_disabled"));
            var facts = Service.Identity(viewer.UserId);
            if (facts.Refusal == "user_required") return Reply(RequestOutcome.Refused("user_required"));
            if (facts.Role == "Watcher") return Reply(RequestOutcome.Refused("requests_create_required"));
            if (body?.Items == null || body.Items.Count == 0) return Reply(RequestOutcome.Refused("invalid_input", 400));
            if (body.Items.Count > RequestLedger.MaxBatch) return Reply(RequestOutcome.Refused("batch_too_large", 400) with { Message = "At most 20 titles at once." });
            var asks = body.Items.Select((item, i) => item?.Input == null ? null
                : new CreateRequest(string.IsNullOrWhiteSpace(item.ClientRequestId) ? "preview-" + i.ToString(System.Globalization.CultureInfo.InvariantCulture) : item.ClientRequestId!, item.Input)).ToList();
            var previews = await Service.PreviewBatchAsync(viewer.UserId, asks, ct).ConfigureAwait(false);
            var items = previews.Select((p, i) => new
            {
                key = asks[i]?.Input.Key,
                outcome = p.Outcome.Outcome,
                reason = p.Outcome.HttpStatus >= 400 ? p.Outcome.Reason : p.Reason ?? p.Outcome.Reason,
                status = p.Outcome.HttpStatus >= 400 ? null : p.Status,
                cost = p.Cost,
                estimateGb = Math.Round(p.EstimatedGb, 1),
                follows = p.Follower,
                already = p.Outcome.HttpStatus < 400 && !p.New,
                rules = p.Outcome.Rules,
            }).ToArray();
            var quota = Service.Quota(viewer.UserId);
            var pool = Service.Pool(viewer.UserId);
            Response.Headers["Cache-Control"] = "private, no-store";
            return Ok(new
            {
                outcome = "accepted",
                reason = "preview",
                certainty = "Succeeded",
                message = "Preview",
                items,
                summary = new
                {
                    now = items.Count(x => x.status is "queued" or "sent"),
                    needOk = items.Count(x => x.status == "pending"),
                    refused = items.Count(x => x.status == null),
                    cost = items.Where(x => x.status != null).Sum(x => x.cost),
                    quota = new { used = quota.Used, limit = quota.Limit, remaining = quota.Remaining, nextSlotAt = quota.NextSlotAt },
                    pool = pool is { } p ? new { name = p.Pool.Name, used = p.Use.Used, limit = p.Pool.Limit, remaining = p.Use.Remaining, nextSlotAt = p.Use.NextSlotAt } : null,
                },
            });
        }
    }
}
