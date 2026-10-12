using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// "Where has it got to?" for any signed-in user (phase 1 of "Requests &amp; downloads"): status
    /// pills on details pages, poster badges and episode chips. Served from the arr snapshots in
    /// memory (no arr call on the request) and Jellyfin; non-admins get the family shape (no instance,
    /// URL, path, client, release or raw arr text), admins also get the per-instance detail. Bodies
    /// are cached per user and sent with a private ETag.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class ArrStatusController : ControllerBase
    {
        private readonly ArrStatusService _service;

        /// <summary>Creates the controller.</summary>
        public ArrStatusController(ArrStatusService service)
        {
            _service = service;
        }

        /// <summary>
        /// Statuses for many items at once (poster cards on a page): <paramref name="ids"/> are
        /// Jellyfin item ids (up to 100; items the caller can't see are left out),
        /// <paramref name="keys"/> title keys such as <c>movie:tmdb:603</c> or <c>tv:tvdb:78874</c> (up to 50).
        /// With <paramref name="detail"/> (exactly one key, no ids) a movie also gets its journey: a
        /// page about a title that may not be in Jellyfin yet (the Seerr more-info modal).
        /// </summary>
        [HttpGet("acquire/status")]
        [Authorize]
        public async Task<IActionResult> GetStatuses([FromQuery] string? ids, [FromQuery] string? keys, CancellationToken cancellationToken, [FromQuery] bool detail = false)
        {
            if (!_service.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (Viewer() is not { } viewer) return StatusCode(403, new { code = "user_required" });

            var idList = new List<Guid>();
            foreach (var part in Split(ids))
            {
                if (!Guid.TryParse(part, out var id)) return BadRequest(new { code = "invalid_id" });
                idList.Add(id);
            }
            var keyList = new List<TitleKey>();
            foreach (var part in Split(keys))
            {
                var key = TitleKey.Parse(part);
                if (key == null || key.Season.HasValue) return BadRequest(new { code = "invalid_key" });
                keyList.Add(key);
            }
            if (idList.Count > ArrStatusService.MaxIds || keyList.Count > ArrStatusService.MaxKeys)
                return BadRequest(new { code = "too_many", maxIds = ArrStatusService.MaxIds, maxKeys = ArrStatusService.MaxKeys });

            if (detail && (keyList.Count != 1 || idList.Count > 0)) return BadRequest(new { code = "detail_needs_one_key" });

            using var scope = _service.Store.BeginRequest("acquire/status");
            var body = detail
                ? await _service.ForKeyDetailAsync(viewer, keyList[0], cancellationToken).ConfigureAwait(false)
                : await _service.ForBatchAsync(viewer, idList, keyList, cancellationToken).ConfigureAwait(false);
            return Send(body);
        }

        /// <summary>The full status of one Jellyfin item for its details page (journey; seasons on a series; episodes on a season); an empty list for items without one.</summary>
        [HttpGet("acquire/status/item/{itemId}")]
        [Authorize]
        public async Task<IActionResult> GetItemStatus([FromRoute] string itemId, CancellationToken cancellationToken)
        {
            if (!_service.Enabled) return StatusCode(403, new { code = "feature_disabled" });
            if (Viewer() is not { } viewer) return StatusCode(403, new { code = "user_required" });
            if (!Guid.TryParse(itemId, out var id)) return BadRequest(new { code = "invalid_id" });

            using var scope = _service.Store.BeginRequest("acquire/status/item");
            // Items the caller can't see (or that have no status: other types, no provider id) get an
            // empty list, never a 404 that would tell them apart.
            var body = await _service.ForItemAsync(viewer, id, cancellationToken).ConfigureAwait(false);
            return Send(body);
        }

        // A person only (never an API key or an unknown user).
        private StatusViewer? Viewer() => ArrCaller.Human(User, _service.View);

        private IActionResult Send(StatusBody body)
        {
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = body.ETag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], body.ETag)) return StatusCode(304);
            return File(body.Json, "application/json; charset=utf-8");
        }

        private static IEnumerable<string> Split(string? list)
        {
            if (string.IsNullOrWhiteSpace(list)) yield break;
            foreach (var part in list.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                yield return part;
            }
        }
    }
}
