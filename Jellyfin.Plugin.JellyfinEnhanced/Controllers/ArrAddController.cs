using System.Text.Json;
using System.Text.Json.Serialization;
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
    /// The Manage drawer's direct "Add to {instance}" and the instance add defaults (Jellyfin
    /// administrators only; members, API keys and unknown users get 403). <c>GET arr/admin/manage/add-options</c>
    /// lists the instance's quality profiles, root folders and tags from a current system snapshot (and,
    /// with a key, the title as the instance's lookup has it); <c>POST arr/admin/manage/add</c> records the
    /// add as a request routed to that instance, which the outbox sends with read-back and audit.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public sealed class ArrAddController : ControllerBase
    {
        private static readonly JsonSerializerOptions CamelCase = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        private readonly ArrAddService _add;

        /// <summary>Creates the controller.</summary>
        public ArrAddController(ArrAddService add)
        {
            _add = add;
        }

        private StatusViewer? Admin() => ArrCaller.Admin(User, _add.Requests.View);

        /// <summary>The add sheet's choices for one instance (and the title, with <paramref name="key"/>).</summary>
        [HttpGet("arr/admin/manage/add-options")]
        [Authorize]
        [PrivateResponse]
        public async Task<IActionResult> Options([FromQuery] string? instanceId, [FromQuery] string? key, CancellationToken cancellationToken)
        {
            if (Admin() == null) return Forbid();
            if (!_add.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (string.IsNullOrWhiteSpace(instanceId) || instanceId.Length > 80) return BadRequest(new { code = "invalid_instance" });
            TitleKey? parsed = null;
            if (!string.IsNullOrEmpty(key))
            {
                parsed = TitleKey.Parse(key);
                if (parsed == null) return BadRequest(new { code = "invalid_key" });
            }
            var options = await _add.OptionsAsync(instanceId, parsed, cancellationToken).ConfigureAwait(false);
            if (options == null) return NotFound(new { code = "not_found" });
            return File(JsonSerializer.SerializeToUtf8Bytes(options, CamelCase), "application/json; charset=utf-8");
        }

        /// <summary>Adds the title to the instance through the request outbox (one idempotency key per sheet).</summary>
        [HttpPost("arr/admin/manage/add")]
        [Authorize]
        [PrivateResponse]
        [BodyLimit]
        public async Task<IActionResult> Add([FromBody] ManageAddRequest? body, CancellationToken cancellationToken)
        {
            if (Admin() is not { } admin) return Forbid();
            if (!_add.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            var outcome = await _add.AddAsync(admin.UserId, body, cancellationToken).ConfigureAwait(false);
            Response.Headers["Cache-Control"] = "private, no-store";
            return StatusCode(outcome.HttpStatus, outcome);
        }
    }
}
