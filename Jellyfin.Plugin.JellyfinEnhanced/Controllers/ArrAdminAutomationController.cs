using System;
using System.Linq;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST /JellyfinEnhanced/arr/admin/automation/breakers/reset.</summary>
    public sealed class AutomationBreakerResetRequest
    {
        /// <summary>The target: a Sonarr/Radarr instance id, or <c>seerr</c>.</summary>
        [JsonPropertyName("target")] public string? Target { get; set; }
    }

    /// <summary>
    /// Phase 4 automation engine, administrators only: its status (switches, the rollout Shadow override, kill switches,
    /// recipe modes, budget usage with reset times, breakers, the backend's admission contract, held automatic requests,
    /// the one-time migration and its notice), recent decisions, dismissing the notice and closing a breaker. Anyone who
    /// isn't a Jellyfin administrator gets 403 before anything is read; answers are private, never cached.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    [PrivateResponse]
    public sealed class ArrAdminAutomationController : ControllerBase
    {
        private readonly AutomationStatusService _status;
        private readonly IArrJellyfinView _view;

        /// <summary>Creates the controller.</summary>
        public ArrAdminAutomationController(AutomationStatusService status, IArrJellyfinView view)
        {
            _status = status;
            _view = view;
        }

        // The status reads acquire.db and memory only; it is there as soon as the integration and phase 1 are on (the
        // rollout Shadow override may be on before phase 4 is).
        private IActionResult? Gate()
        {
            if (ArrCaller.Admin(User, _view) is null) return StatusCode(403, new { code = "admin_required" });
            var config = _status.Configuration;
            if (!config.ArrIntegrationEnabled || !config.ArrPhase1Enabled) return StatusCode(403, new { code = "feature_disabled" });
            return null;
        }

        /// <summary>The engine's status.</summary>
        [HttpGet("arr/admin/automation/status")]
        [Authorize]
        public IActionResult Status()
        {
            if (Gate() is { } refused) return refused;
            return Ok(_status.Build());
        }

        /// <summary>Recent decisions, newest first (one row per trigger; a repeat counts on the same row).</summary>
        /// <param name="recipe">Only this recipe.</param>
        /// <param name="limit">At most this many (1..500, default 100).</param>
        [HttpGet("arr/admin/automation/decisions")]
        [Authorize]
        public IActionResult Decisions([FromQuery] string? recipe, [FromQuery] int? limit)
        {
            if (Gate() is { } refused) return refused;
            if (recipe != null && !AutomationRecipes.Known(recipe)) return BadRequest(new { code = "invalid_request" });
            var rows = _status.Store.Decisions(Math.Clamp(limit ?? 100, 1, 500), null, recipe);
            return Ok(new { items = rows.Select(r => new { key = r.Key, recipe = r.Recipe, userId = r.UserId, titleKey = r.TitleKey, mode = r.Mode, outcome = r.Outcome, reason = r.Reason, backend = r.Backend, detail = r.Detail, repeats = r.Repeats, createdAt = r.CreatedAt, updatedAt = r.UpdatedAt }) });
        }

        /// <summary>Dismisses the one-time migration notice.</summary>
        [HttpPost("arr/admin/automation/notice/dismiss")]
        [Authorize]
        [BodyLimit]
        public IActionResult DismissNotice()
        {
            if (Gate() is { } refused) return refused;
            if (!_status.Store.Database.Available) return StatusCode(503, new { code = "database_unavailable" });
            return Ok(new { dismissed = _status.DismissNotice() });
        }

        /// <summary>Closes a target's circuit breaker (the next automatic send to it is tried at once).</summary>
        /// <param name="request">The target.</param>
        [HttpPost("arr/admin/automation/breakers/reset")]
        [Authorize]
        [BodyLimit]
        public IActionResult ResetBreaker([FromBody] AutomationBreakerResetRequest? request)
        {
            if (Gate() is { } refused) return refused;
            var target = request?.Target?.Trim();
            if (string.IsNullOrEmpty(target) || target.Length > 80 || target.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '-' or '_'))) return BadRequest(new { code = "invalid_request" });
            if (!_status.Store.Database.Available) return StatusCode(503, new { code = "database_unavailable" });
            return Ok(new { reset = _status.Store.Reset(target, DateTimeOffset.UtcNow) });
        }
    }
}
