using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST /JellyfinEnhanced/catchup/event.</summary>
    public class CatchUpEventRequest
    {
        [JsonPropertyName("type")] public string? Type { get; set; }
        [JsonPropertyName("action")] public string? Action { get; set; }
        [JsonPropertyName("undoOf")] public string? UndoOf { get; set; }
        [JsonPropertyName("itemId")] public Guid? ItemId { get; set; }
        [JsonPropertyName("ok")] public bool? Ok { get; set; }
        [JsonPropertyName("seasons")] public List<string>? Seasons { get; set; }
    }

    public class CatchUpEventsResponse
    {
        [JsonPropertyName("events")] public List<CatchUpEvent> Events { get; set; } = new();
        [JsonPropertyName("users")] public List<string> Users { get; set; } = new();
        [JsonPropertyName("total")] public int Total { get; set; }
    }

    /// <summary>
    /// Backend for the Catch Up page. Any signed-in user can log their own swipes, but only admins can
    /// read the log. The user comes from the session and item names are looked up by id, so the client
    /// can't fake either.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced/catchup")]
    public class CatchUpController : ControllerBase
    {
        private readonly CatchUpLogService _log;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;

        public CatchUpController(CatchUpLogService log, IUserManager userManager, ILibraryManager libraryManager)
        {
            _log = log;
            _userManager = userManager;
            _libraryManager = libraryManager;
        }

        private bool IsAdmin()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                var user = id.HasValue ? _userManager.GetUserById(id.Value) : null;
                return user != null && user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch { return false; }
        }

        private static string? Clip(string? s, int max) => s == null ? null : (s.Length <= max ? s : s[..max]);

        [HttpPost("event")]
        [Authorize]
        public IActionResult PostEvent([FromBody] CatchUpEventRequest req)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config?.CatchUpEnabled != true || config.CatchUpLogEnabled != true) return NoContent();

            var userId = UserHelper.GetCurrentUserId(User);
            var user = userId.HasValue ? _userManager.GetUserById(userId.Value) : null;
            if (user == null) return Unauthorized();

            var type = req.Type?.ToLowerInvariant();
            if (type != "swipe") return BadRequest();
            var action = req.Action?.ToLowerInvariant();
            if (!CatchUpLogService.IsKnownAction(action)) return BadRequest();
            var undoOf = req.UndoOf?.ToLowerInvariant();
            if (undoOf != null && !CatchUpLogService.IsKnownAction(undoOf)) return BadRequest();

            string? itemName = null, kind = null;
            if (req.ItemId.HasValue && req.ItemId.Value != Guid.Empty)
            {
                var item = _libraryManager.GetItemById(req.ItemId.Value);
                itemName = item?.Name;
                kind = item?.GetType().Name;
            }

            _log.Append(new CatchUpEvent
            {
                Ts = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                UserId = user.Id.ToString("N"),
                User = user.Username,
                Type = type,
                Action = action,
                UndoOf = undoOf,
                ItemId = req.ItemId?.ToString("N"),
                ItemName = itemName,
                Kind = kind,
                Ok = req.Ok,
                Seasons = req.Seasons?.Take(100).Select(s => Clip(s, 8) ?? string.Empty).ToList(),
            });
            return NoContent();
        }

        /// <summary>Newest-first feed with optional filters. Admin only.</summary>
        [HttpGet("events")]
        [Authorize]
        public ActionResult<CatchUpEventsResponse> GetEvents(
            [FromQuery] string? user, [FromQuery] string? action, [FromQuery] string? q,
            [FromQuery] string? since, [FromQuery] int limit = 200)
        {
            if (!IsAdmin()) return Forbid();
            var all = _log.ReadAll();
            var actions = (action ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet();
            limit = Math.Clamp(limit, 1, 1000);

            var query = Enumerable.Reverse(all).Where(e =>
                (string.IsNullOrEmpty(user) || string.Equals(e.User, user, StringComparison.OrdinalIgnoreCase)) &&
                (actions.Count == 0 || actions.Contains(e.Action ?? e.Type)) &&
                (string.IsNullOrEmpty(since) || string.CompareOrdinal(e.Ts, since) >= 0) &&
                (string.IsNullOrEmpty(q) || (e.ItemName ?? string.Empty).Contains(q, StringComparison.OrdinalIgnoreCase)));

            return new CatchUpEventsResponse
            {
                Events = query.Take(limit).ToList(),
                Users = all.Select(e => e.User).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(u => u, StringComparer.OrdinalIgnoreCase).ToList(),
                Total = all.Count,
            };
        }

        /// <summary>Per-user counts and the most watched / dismissed / watchlisted titles. Admin only.</summary>
        [HttpGet("summary")]
        [Authorize]
        public ActionResult<CatchUpSummary> GetSummary()
        {
            if (!IsAdmin()) return Forbid();
            return CatchUpLogService.Summarize(_log.ReadAll());
        }
    }
}
