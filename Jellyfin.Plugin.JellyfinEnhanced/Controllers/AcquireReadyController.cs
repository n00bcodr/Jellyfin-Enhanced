using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Ready;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of PUT acquire/ready (only the fields sent change).</summary>
    public sealed class ReadySettingsRequest
    {
        /// <summary>The private Ready playlist (on again after a deletion, removal or restore renews it).</summary>
        public bool? ReadyPlaylist { get; set; }

        /// <summary>Native Ready messages on TVs and apps signed in as the caller.</summary>
        public bool? NativeReadyMessages { get; set; }
    }

    /// <summary>
    /// The caller's own Ready settings (Requests &amp; downloads, phase 4f): their private Ready playlist (on, off, remove) and
    /// native Ready messages. A person only; API keys and unknown users are refused (D19). Only ever the caller's own
    /// settings and playlist: no route takes a user or a playlist id. Administrators see the same state read-only on
    /// Dashboard → Users and never consent for a person.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class AcquireReadyController : ControllerBase
    {
        private readonly ReadyPlaylistService _service;
        private readonly ReadyPlaylistStore _store;
        private readonly NotifyStore _notify;
        private readonly IArrJellyfinView _view;

        /// <summary>Creates the controller.</summary>
        public AcquireReadyController(ReadyPlaylistService service, ReadyPlaylistStore store, NotifyStore notify, IArrJellyfinView view)
        {
            _service = service;
            _store = store;
            _notify = notify;
            _view = view;
        }

        /// <summary>The configuration (tests replace it).</summary>
        internal Func<PluginConfiguration?> Config { get; set; } = () => JellyfinEnhanced.Instance?.Configuration;

        /// <summary>The clock (tests replace it).</summary>
        internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

        /// <summary>
        /// The caller's Ready settings and status: <c>{"playlist":{enabled,optedIn,state,reason,playlistId,entries,retentionDays,
        /// canRemove},"messages":{enabled,optedIn,recent:{accepted,suppressed,unknown}}}</c>. Opening it asks for a fresh look at
        /// the playlist. 403 <c>feature_disabled</c> while neither switch is on.
        /// </summary>
        [HttpGet("acquire/ready")]
        [Authorize]
        public IActionResult Get()
        {
            if (Gate(out var user) is { } denied) return denied;
            if (ReadyFlags.Playlist(Config())) _service.MarkDirty(user);
            return Ok(Body(user));
        }

        /// <summary>
        /// Changes the caller's own Ready settings (only the fields sent). A field whose switch is off is refused
        /// (403 <c>feature_disabled</c>, nothing stored).
        /// </summary>
        [HttpPut("acquire/ready")]
        [Authorize]
        [BodyLimit(1024)]
        public async Task<IActionResult> Put([FromBody] ReadySettingsRequest? request, CancellationToken cancellationToken)
        {
            if (Gate(out var user) is { } denied) return denied;
            if (request == null || (request.ReadyPlaylist == null && request.NativeReadyMessages == null)) return BadRequest(new { code = "invalid_request" });
            var config = Config();
            if ((request.ReadyPlaylist != null && !ReadyFlags.Playlist(config)) || (request.NativeReadyMessages != null && !ReadyFlags.Messages(config)))
                return StatusCode(403, new { code = "feature_disabled" });
            if (request.NativeReadyMessages is bool messages) _notify.UpdatePrefs(user, p => p.NativeReadyMessages = messages, Now());
            if (request.ReadyPlaylist is bool playlist) await _service.SetPlaylistAsync(user, playlist, cancellationToken).ConfigureAwait(false);
            return Ok(Body(user));
        }

        /// <summary>
        /// Removes the caller's managed Ready playlist (only that playlist, only while it is verifiably theirs). It isn't made
        /// again until they turn it on again. <c>{"outcome":"removed"|"not_ours"|"nothing", ...status}</c>.
        /// </summary>
        [HttpPost("acquire/ready/remove")]
        [Authorize]
        [BodyLimit(1024)]
        public async Task<IActionResult> Remove(CancellationToken cancellationToken)
        {
            if (Gate(out var user) is { } denied) return denied;
            var outcome = await _service.RemoveAsync(user, cancellationToken).ConfigureAwait(false);
            if (outcome == "error") return StatusCode(502, new { code = "remove_failed" });
            return Ok(new { outcome, status = Body(user) });
        }

        private object Body(Guid user)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            var config = Config();
            var status = _service.Status(user);
            var prefs = _notify.Prefs(user);
            var recent = _store.Outcomes(user, Now().AddDays(-7));
            return new
            {
                playlist = new
                {
                    enabled = status.Enabled,
                    optedIn = status.OptedIn,
                    state = status.State,
                    reason = status.Reason,
                    playlistId = status.PlaylistId?.ToString("N", CultureInfo.InvariantCulture),
                    entries = status.Entries,
                    retentionDays = status.RetentionDays,
                    canRemove = status.CanRemove,
                },
                messages = new
                {
                    enabled = ReadyFlags.Messages(config),
                    optedIn = prefs.NativeReadyMessages,
                    recent = new { accepted = recent.Accepted, suppressed = recent.Suppressed, unknown = recent.Unknown },
                },
            };
        }

        private IActionResult? Gate(out Guid user)
        {
            user = Guid.Empty;
            if (ArrCaller.Human(User, _view) is not { } viewer) return StatusCode(403, new { code = "user_required" });
            var config = Config();
            if (!ReadyFlags.Playlist(config) && !ReadyFlags.Messages(config)) return StatusCode(403, new { code = "feature_disabled" });
            if (!_store.Available) return StatusCode(503, new { code = "database_unavailable" });
            user = viewer.UserId;
            return null;
        }
    }
}
