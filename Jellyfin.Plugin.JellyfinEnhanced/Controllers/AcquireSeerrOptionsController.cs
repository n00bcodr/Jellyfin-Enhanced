using System;
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
    /// <summary>
    /// Administrator Seerr request options (phase 4): Seerr's Radarr or Sonarr servers with their quality profiles, root
    /// folders and options stamps, for choosing where a Seerr request goes. Jellyfin administrators only (everyone else
    /// gets 403 before anything is read); 403 while the switch is off. Never returns an address, key or host name of
    /// Seerr or its arrs. Answers are private and never cached.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    [PrivateResponse]
    public sealed class AcquireSeerrOptionsController : ControllerBase
    {
        private readonly SeerrBackend _seerr;
        private readonly IRequestPolicy _policy;
        private readonly IArrJellyfinView _view;

        /// <summary>Creates the controller.</summary>
        public AcquireSeerrOptionsController(SeerrBackend seerr, IRequestPolicy policy, IArrJellyfinView view)
        {
            _seerr = seerr;
            _policy = policy;
            _view = view;
        }

        /// <summary>
        /// Seerr's servers for movies (<paramref name="kind"/> <c>movie</c>, Radarr) or series (<c>tv</c>, Sonarr):
        /// <c>enabled</c> (Seerr handles requests), <c>canUse</c> (the caller's Seerr account holds Seerr's advanced-request
        /// permission), <c>reason</c> when not, and each server's id, name, edition, defaults, profiles, root folders and
        /// <c>options</c> stamp (sent back with a request's choice).
        /// </summary>
        /// <param name="kind">movie or tv.</param>
        /// <param name="ct">Cancellation.</param>
        [HttpGet("arr/admin/seerr/request-options")]
        [Authorize]
        public async Task<IActionResult> RequestOptions([FromQuery] string? kind = null, CancellationToken ct = default)
        {
            Response.Headers["Cache-Control"] = PrivateResponseAttribute.CacheControl;
            if (ArrCaller.Admin(User, _view) is not { } admin) return StatusCode(403, new { code = "admin_required" });
            var config = _policy.Configuration;
            if (!HouseholdFlags.SeerrOptions(config)) return StatusCode(403, new { code = "seerr_options_disabled" });
            if (kind is not ("movie" or "tv")) return BadRequest(new { code = "invalid_input" });
            var movie = kind == "movie";
            if (config.ArrRequestBackend != "seerr")
                return Ok(new { enabled = false, canUse = false, reason = "not_seerr_backend", servers = Array.Empty<object>() });
            // The caller's current Seerr account and permissions (read again now, as a request would).
            await _policy.PrepareIdentityAsync(admin.UserId, movie, ct).ConfigureAwait(false);
            var facts = _policy.Evaluate(admin.UserId, movie ? new MutationInput { Key = "movie:tmdb:1" } : new MutationInput { Key = "tv:tvdb:1", Scope = "seasons", Seasons = new[] { 1 } });
            var reason = facts.SeerrUser == null ? facts.SeerrUnlinked ? "seerr_advanced_required" : "backend_unavailable"
                : !RequestPolicy.SeerrAdvanced(facts.SeerrPermissions) ? "seerr_advanced_required" : null;
            if (reason != null) return Ok(new { enabled = true, canUse = false, reason, servers = Array.Empty<object>() });
            if (await _seerr.RequestOptionsAsync(movie, ct).ConfigureAwait(false) is not { } servers)
                return StatusCode(503, new { code = "backend_unavailable" });
            return Ok(new
            {
                enabled = true,
                canUse = true,
                reason = (string?)null,
                servers = servers.Select(s => new
                {
                    id = s.Id,
                    name = s.Name,
                    is4k = s.Is4k,
                    isDefault = s.IsDefault,
                    defaultProfileId = s.DefaultProfileId,
                    defaultRootFolder = s.DefaultRootFolder,
                    profiles = s.Profiles.Select(p => new { id = p.Id, name = p.Name }).ToArray(),
                    rootFolders = s.RootFolders.Select(path => new { path }).ToArray(),
                    options = s.Options,
                }).ToArray(),
            });
        }
    }
}
