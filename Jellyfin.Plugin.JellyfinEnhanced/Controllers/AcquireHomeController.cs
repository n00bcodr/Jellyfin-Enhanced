using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Requests &amp; downloads, phase 4 home rows: the caller's own rows (<c>GET acquire/home</c>, any person, their own
    /// requests and follows only, served from memory with a private ETag) and the administrator's strip of what needs
    /// doing (<c>GET arr/admin/home/ops</c>, administrators only, never cached). Both are off unless home rows are on.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public sealed class AcquireHomeController : ControllerBase
    {
        private readonly HomeProjection _home;
        private readonly ArrAdminHubService? _admin;

        /// <summary>Creates the controller.</summary>
        /// <param name="home">The home rows.</param>
        /// <param name="admin">The arr admin hub (the strip's facts).</param>
        public AcquireHomeController(HomeProjection home, ArrAdminHubService admin)
        {
            _home = home;
            _admin = admin;
        }

        /// <summary>
        /// The caller's home rows: Your requests, Coming soon for you, Just arrived for you (a row switched off for them
        /// is null), whether they are Home Screen Sections sections here, and whether the administrator's strip is on
        /// for them.
        /// </summary>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The rows.</returns>
        [HttpGet("acquire/home")]
        [Authorize]
        public async Task<IActionResult> GetHome(CancellationToken cancellationToken)
        {
            if (ArrCaller.Human(User, _home.Status.View) is not { } viewer) return StatusCode(403, new { code = "user_required" });
            if (!HomeFlags.Rows(JellyfinEnhanced.Instance?.Configuration)) return NotFound(new { outcome = "refused", reason = "disabled" });
            using var scope = _home.Status.Store.BeginRequest("acquire/home");
            var hss = HomeFlags.HssSections(JellyfinEnhanced.Instance?.Configuration) && HssSectionsAdapter.Present;
            // The one delivery gate: the rows carry titles judged by the viewer's privacy policies, so they leave only when
            // the read-set of the attempt that built them still holds (else built again, bounded; then 503).
            var answer = await Services.PrivacyDelivery.DeliverAsync<IActionResult>(viewer.UserId, async () =>
            {
                var body = await _home.ForViewerAsync(viewer, hss, cancellationToken).ConfigureAwait(false);
                if (body == null) return NotFound(new { outcome = "refused", reason = "disabled" });
                Response.Headers["Cache-Control"] = "private, no-cache";
                Response.Headers["ETag"] = body.ETag;
                if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], body.ETag)) return StatusCode(304);
                return File(body.Json, "application/json; charset=utf-8");
            }, HttpContext).ConfigureAwait(false);
            return answer ?? StatusCode(503);
        }

        /// <summary>
        /// The administrator's strip: downloads under way, blocked imports, other things needing attention and nearly
        /// full disks. <c>actionable</c> is false when nothing needs doing (the strip then stays hidden).
        /// </summary>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The counts.</returns>
        [HttpGet("arr/admin/home/ops")]
        [Authorize]
        [PrivateResponse]
        public async Task<IActionResult> GetOps(CancellationToken cancellationToken)
        {
            if (ArrCaller.Human(User, _home.Status.View) is not { IsAdmin: true } viewer) return Forbid();
            if (!HomeFlags.OpsStrip(JellyfinEnhanced.Instance?.Configuration) || !_home.Choice(viewer.UserId).Ops || _admin == null || !_admin.Enabled)
                return NotFound(new { outcome = "refused", reason = "disabled" });
            using var scope = _home.Status.Store.BeginRequest("arr/admin/home/ops");
            var overview = await _admin.OverviewAsync(cancellationToken).ConfigureAwait(false);
            var gate = new AcquireResponseGate(_home.Status.View, viewer.UserId,
                current => HomeFlags.OpsStrip(JellyfinEnhanced.Instance?.Configuration) + "|" + _home.Choice(current.UserId));
            if (gate.Read() is not { } policy) return Forbid();
            try
            {
                return gate.Publish<IActionResult>(policy, current =>
                {
                    if (!current.IsAdmin) return Forbid();
                    if (!HomeFlags.OpsStrip(JellyfinEnhanced.Instance?.Configuration) || !_home.Choice(current.UserId).Ops || !_admin.Enabled)
                        return NotFound(new { outcome = "refused", reason = "disabled" });
                    return File(JsonSerializer.SerializeToUtf8Bytes(Ops(overview)), "application/json; charset=utf-8");
                });
            }
            catch (AcquireResponseGate.Changed) { return Forbid(); }
        }

        /// <summary>The strip's counts from the admin overview.</summary>
        /// <param name="overview">The overview.</param>
        /// <returns>The counts.</returns>
        internal static object Ops(AdminOverview overview)
        {
            var disks = overview.Instances.SelectMany(i => i.Disks).Where(d => d.Low && d.Accessible)
                .GroupBy(d => d.Path, StringComparer.Ordinal).Select(g => g.OrderByDescending(d => d.UsedPercent ?? 0).First())
                .OrderByDescending(d => d.UsedPercent ?? 0).Take(3)
                .Select(d => new { name = d.Path, usedPercent = d.UsedPercent }).ToList();
            var attention = overview.NeedsAttention.Count;
            var importBlocked = overview.NeedsAttention.Count(a => a.Code == AttentionCode.ImportBlocked);
            return new
            {
                actionable = attention > 0 || disks.Count > 0,
                downloading = overview.Downloading,
                importBlocked,
                attention,
                disks,
            };
        }
    }
}
