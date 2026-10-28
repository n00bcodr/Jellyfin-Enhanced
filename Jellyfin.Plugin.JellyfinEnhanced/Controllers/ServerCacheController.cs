using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST /JellyfinEnhanced/admin/server-cache/check-folder.</summary>
    public class ServerCacheFolderRequest
    {
        /// <summary>The folder to check (empty: the default).</summary>
        [JsonPropertyName("folder")] public string? Folder { get; set; }
    }

    /// <summary>Admin-only usage, folder check and Clear of the server-side cache (see <see cref="ServerBlobCache"/>).</summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class ServerCacheController : ControllerBase
    {
        private readonly ServerBlobCache _cache;
        private readonly IUserManager _userManager;

        /// <summary>Creates the controller.</summary>
        public ServerCacheController(ServerBlobCache cache, IUserManager userManager)
        {
            _cache = cache;
            _userManager = userManager;
        }

        /// <summary>What the cache folder holds (entries and bytes, per namespace) and whether the folder can be used.</summary>
        [HttpGet("admin/server-cache")]
        [Authorize]
        public IActionResult Usage()
        {
            if (!IsAdmin()) return Forbid();
            Response.Headers.CacheControl = "no-store";
            return Ok(_cache.Usage());
        }

        /// <summary>Deletes every cache entry (nothing else in the folder is touched).</summary>
        [HttpPost("admin/server-cache/clear")]
        [Authorize]
        public async Task<IActionResult> Clear(CancellationToken cancellationToken)
        {
            if (!IsAdmin()) return Forbid();
            var removed = await _cache.ClearAsync(null, cancellationToken).ConfigureAwait(false);
            Response.Headers.CacheControl = "no-store";
            return Ok(new { removed, usage = _cache.Usage() });
        }

        /// <summary>Checks a folder for the setting: allowed, and creatable and writable. Saves nothing.</summary>
        [HttpPost("admin/server-cache/check-folder")]
        [Authorize]
        [BodyLimit]
        public IActionResult CheckFolder([FromBody] ServerCacheFolderRequest? body)
        {
            if (!IsAdmin()) return Forbid();
            var error = _cache.Location.Resolve(body?.Folder, out var full) ?? _cache.Location.Prepare(full);
            Response.Headers.CacheControl = "no-store";
            return Ok(new { ok = error == null, folder = error == null ? full : string.Empty, message = error });
        }

        private bool IsAdmin() => ArrCaller.IsAdmin(User, _userManager);
    }
}
