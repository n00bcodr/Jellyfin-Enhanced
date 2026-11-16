using System;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of the service-account route.</summary>
    public class ReclaimerrActionRequest
    {
        /// <summary>Create service account: a Reclaimerr administrator, used for this one call and never stored.</summary>
        [JsonPropertyName("adminUsername")] public string? AdminUsername { get; set; }
        [JsonPropertyName("adminPassword")] public string? AdminPassword { get; set; }
    }

    /// <summary>
    /// What only Reclaimerr has: the plugin's service account. Everything both removal tools share (state, mark, keep,
    /// postpone, request) is under <c>JellyfinEnhanced/leaving-soon</c> (<see cref="LeavingSoonActionsController"/>).
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced/reclaimerr")]
    public class ReclaimerrController : ControllerBase
    {
        private readonly ReclaimerrActions _reclaimerr;
        private readonly IUserManager _userManager;

        public ReclaimerrController(ReclaimerrActions reclaimerr, IUserManager userManager)
        {
            _reclaimerr = reclaimerr;
            _userManager = userManager;
        }

        private bool IsAdmin()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var id = UserHelper.GetCurrentUserId(User);
                var user = id.HasValue && id.Value != Guid.Empty ? _userManager.GetUserById(id.Value) : null;
                return user != null && user.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch { return false; }
        }

        /// <summary>
        /// Create the plugin's Reclaimerr service account (<c>jellyfin-enhanced</c>, admin, random password) by signing
        /// in once as a Reclaimerr administrator, and save its login in the configuration. Administrators only; the
        /// administrator's password is used for this call only. Answers <c>{username}</c>.
        /// </summary>
        [HttpPost("service-account")]
        [Authorize]
        [Produces("application/json")]
        public async Task<IActionResult> CreateServiceAccount([FromBody] ReclaimerrActionRequest request, CancellationToken token)
        {
            if (!IsAdmin()) return Forbid();
            var plugin = JellyfinEnhanced.Instance;
            var config = plugin?.Configuration;
            if (plugin == null || config == null || !LeavingSoonService.IsMaintainerrUrl(config.ReclaimerrUrl)) return BadRequest(new { error = "Save the Reclaimerr URL first." });
            if (string.IsNullOrWhiteSpace(request?.AdminUsername)) return BadRequest(new { error = "Enter a Reclaimerr administrator's username." });
            try
            {
                var (username, password) = await ReclaimerrSession.CreateServiceAccountAsync(HttpContext.RequestServices.GetRequiredService<System.Net.Http.IHttpClientFactory>(), config, request.AdminUsername!, request.AdminPassword ?? string.Empty, TimeSpan.FromSeconds(30), token).ConfigureAwait(false);
                plugin.UpdateConfiguration(c => { c.ReclaimerrUsername = username; c.ReclaimerrPassword = password; return c; }, fullSave: false);
                ReclaimerrSession.Forget(plugin.Configuration);
                return Ok(new { username, password });
            }
            catch (OperationCanceledException) when (HttpContext.RequestAborted.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                return StatusCode(502, new { error = "Reclaimerr: " + MaintainerrHttp.Describe(ex) });
            }
        }
    }
}
