using System;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
    /// Collection gaps for the request controls on collection pages ("You have 4 of 6. Get the 2
    /// missing"). Resolves a real person like every request route; answers in the request outcome shape.
    /// </summary>
    [ApiController]
    [RequestOutcomeFilter]
    [Route("JellyfinEnhanced")]
    public sealed class AcquireCollectionsController : ControllerBase
    {
        private readonly RequestService _service;
        private readonly CollectionGapsService? _collections;

        /// <summary>Creates the controller.</summary>
        public AcquireCollectionsController(RequestService service, CollectionGapsService? collections = null)
        {
            _service = service;
            _collections = collections;
        }

        private IActionResult Reply(RequestOutcome outcome)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            return StatusCode(outcome.HttpStatus, outcome);
        }

        /// <summary>
        /// What the caller has of a collection item and which movies are missing (key, title, year,
        /// poster, released, the caller's own request state). The collection must be visible to the
        /// caller; movies Jellyfin hides from them are left out, and for callers with parental limits
        /// missing movies only appear when their verified rating allows. 404 for a collection the caller
        /// can't open or one TMDB can't describe.
        /// </summary>
        [Authorize]
        [HttpGet("acquire/requests/collection/{itemId}")]
        public async Task<IActionResult> Collection([FromRoute] string itemId, [FromQuery] string? language = null, CancellationToken ct = default)
        {
            var viewer = ArrCaller.Human(User, _service.View);
            if (viewer == null) return Reply(RequestOutcome.Refused("user_required"));
            if (!_service.Enabled) return Reply(RequestOutcome.Refused("feature_disabled"));
            if (_service.Identity(viewer.UserId).Refusal == "user_required") return Reply(RequestOutcome.Refused("user_required"));
            if (!_service.Ledger.Database.Available) return Reply(RequestOutcome.Refused("database_unavailable", 503, "unavailable"));
            if (!Guid.TryParse(itemId, out var id) || id == Guid.Empty) return Reply(RequestOutcome.Refused("invalid_id", 400));
            if (_collections == null) return Reply(RequestOutcome.Refused("feature_disabled"));
            var (bytes, refusal) = await _collections.ProjectAsync(viewer, id, language, gaps => JsonSerializer.SerializeToUtf8Bytes(new { outcome = "accepted", reason = "collection", certainty = "Succeeded", message = "Collection", collection = gaps }), ct).ConfigureAwait(false);
            if (bytes == null)
            {
                if (refusal == "metadata_unavailable")
                {
                    Response.Headers["Retry-After"] = "1";
                    return Reply(RequestOutcome.Refused(refusal, 503, "unavailable"));
                }
                return Reply(RequestOutcome.Refused(refusal ?? "not_found", 404));
            }
            var etag = "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(viewer.UserId.ToString("N") + "|").Concat(bytes).ToArray()), 0, 16) + "\"";
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = etag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], etag)) return StatusCode(304);
            return File(bytes, "application/json; charset=utf-8");
        }
    }
}
