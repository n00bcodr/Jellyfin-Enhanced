using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Acquisition badges for poster cards on the web (Requests &amp; downloads, phase 4e): the viewer's stamp for each
    /// card's item, decided by the same resolver native poster stamps use. In-memory only (no arr, Seerr or database
    /// call on the request). Items the caller can't open are left out, like items without a stamp.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class AcquisitionStampsController : ControllerBase
    {
        /// <summary>Most item ids per request.</summary>
        public const int MaxIds = 100;

        private readonly AcquisitionStampResolver _resolver;
        private readonly IStampLibrary _library;
        private readonly IArrJellyfinView _view;
        private readonly IAcquisitionBadgePreferences _preferences;

        /// <summary>Creates the controller.</summary>
        /// <param name="resolver">Stamp resolver.</param>
        /// <param name="library">Library facts (visibility).</param>
        /// <param name="view">The status view (who is calling).</param>
        /// <param name="preferences">Per-person badge preferences.</param>
        public AcquisitionStampsController(AcquisitionStampResolver resolver, IStampLibrary library, IArrJellyfinView view, IAcquisitionBadgePreferences preferences)
        {
            _resolver = resolver;
            _library = library;
            _view = view;
            _preferences = preferences;
        }

        /// <summary>The configuration (tests replace it).</summary>
        internal Func<PluginConfiguration?> Config { get; init; } = () => JellyfinEnhanced.Instance?.Configuration;

        /// <summary>
        /// The caller's acquisition stamps for up to 100 Jellyfin item ids: <c>{"items":[{"itemId","stamp"}]}</c> with stamp
        /// <c>upgraded</c>, <c>new</c> or <c>fourK</c>; items without one, or that the caller can't open, are absent.
        /// <c>subscriptions</c> names accessible items and their title keys, including items without a stamp, for live
        /// invalidation independent of status pills. A person who turned badges off gets both lists empty.
        /// 403 <c>feature_disabled</c> while the switch is off.
        /// </summary>
        /// <param name="ids">Comma-separated item ids.</param>
        /// <returns>The stamps.</returns>
        [HttpGet("acquire/stamps")]
        [Authorize]
        public IActionResult GetStamps([FromQuery] string? ids)
        {
            // A person first (API keys and unknown users are no one), then the switch.
            if (ArrCaller.Human(User, _view) is not { } viewer) return StatusCode(403, new { code = "user_required" });
            if (!AcquisitionStampFlags.Badges(Config())) return StatusCode(403, new { code = "feature_disabled" });

            var list = new List<Guid>();
            foreach (var part in (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!Guid.TryParse(part, out var id) || id == Guid.Empty) return BadRequest(new { code = "invalid_id" });
                if (!list.Contains(id)) list.Add(id);
            }

            if (list.Count > MaxIds) return BadRequest(new { code = "too_many", maxIds = MaxIds });

            var items = new List<StampAnswer>();
            var subscriptions = new List<StampSubscription>();
            if (AcquisitionStampFlags.Display(true, _preferences.WebBadges(viewer.UserId)))
            {
                foreach (var id in list)
                {
                    if (!_library.CanOpen(viewer.UserId, id)) continue;
                    // Follow every accessible title, even while it has no stamp. Status pills need not be on.
                    if (_library.Item(id) is { } item)
                    {
                        var keys = item.Keys.Select(key => key.Title.ToString()).Distinct(StringComparer.Ordinal).ToArray();
                        if (keys.Length > 0) subscriptions.Add(new StampSubscription(id.ToString("N", CultureInfo.InvariantCulture), keys));
                    }

                    if (AcquisitionStampFlags.WireName(_resolver.Resolve(id, viewer.UserId)) is not { } stamp) continue;
                    items.Add(new StampAnswer(id.ToString("N", CultureInfo.InvariantCulture), stamp));
                }
            }

            var json = JsonSerializer.SerializeToUtf8Bytes(new { items, subscriptions });
            var etag = "\"" + Convert.ToHexString(SHA256.HashData(json), 0, 12).ToLowerInvariant() + "\"";
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = etag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], etag)) return StatusCode(304);
            return File(json, "application/json; charset=utf-8");
        }

        private sealed record StampSubscription(
            [property: System.Text.Json.Serialization.JsonPropertyName("itemId")] string ItemId,
            [property: System.Text.Json.Serialization.JsonPropertyName("keys")] IReadOnlyList<string> Keys);

        private sealed record StampAnswer(
            [property: System.Text.Json.Serialization.JsonPropertyName("itemId")] string ItemId,
            [property: System.Text.Json.Serialization.JsonPropertyName("stamp")] string Stamp);
    }
}
