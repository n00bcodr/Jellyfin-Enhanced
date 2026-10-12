using System;
using System.Globalization;
using System.IO;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Backup;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST /JellyfinEnhanced/admin/backup/export.</summary>
    public class JeBackupExportRequest
    {
        /// <summary>"exclude" (default) or "encrypt".</summary>
        [JsonPropertyName("secrets")] public string? Secrets { get; set; }

        /// <summary>Passphrase for "encrypt" (at least 12 characters).</summary>
        [JsonPropertyName("passphrase")] public string? Passphrase { get; set; }
    }

    /// <summary>
    /// Admin-only export, check and restore of Jellyfin Enhanced's data (Jellyfin's own backups don't
    /// include plugin data). Backups never carry a credential in readable form.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class JeBackupController : ControllerBase
    {
        /// <summary>The confirmation the restore form must carry.</summary>
        public const string RestoreConfirmation = "restore";

        private const long MaxUploadBytes = 512L * 1024 * 1024;

        private readonly JeBackupService _backup;
        private readonly IUserManager _userManager;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        public JeBackupController(JeBackupService backup, IUserManager userManager, Logger logger)
        {
            _backup = backup;
            _userManager = userManager;
            _logger = logger;
        }

        /// <summary>Downloads a backup zip of the current configuration, user settings and JE stores.</summary>
        [HttpPost("admin/backup/export")]
        [Authorize]
        [BodyLimit]
        public IActionResult Export([FromBody] JeBackupExportRequest? body)
        {
            if (!IsAdmin()) return Forbid();
            if (!TryParseMode(body?.Secrets, out var mode))
                return BadRequest(new { error = true, code = "invalid_mode", message = "secrets must be \"exclude\" or \"encrypt\"." });

            var stream = new MemoryStream();
            try
            {
                _backup.Export(stream, mode, body?.Passphrase);
            }
            catch (JeBackupException ex)
            {
                stream.Dispose();
                return BadRequest(new { error = true, code = ex.Code, message = ex.Message });
            }
            stream.Position = 0;
            Response.Headers.CacheControl = "no-store";
            _logger.Info($"JE backup: exported by an admin (credentials {(mode == JeBackupSecrets.Encrypt ? "included, encrypted" : "left out")}).");
            var name = JeBackupService.ScheduledPrefix + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".zip";
            return File(stream, "application/zip", name);
        }

        /// <summary>Checks an uploaded backup (form field <c>file</c>, optional <c>passphrase</c>) and describes it. Changes nothing.</summary>
        [HttpPost("admin/backup/inspect")]
        [Authorize]
        [RequestSizeLimit(MaxUploadBytes)]
        [RequestFormLimits(MultipartBodyLengthLimit = MaxUploadBytes)]
        public async Task<IActionResult> Inspect()
        {
            if (!IsAdmin()) return Forbid();
            var (upload, passphrase, _, error) = await ReadUploadAsync().ConfigureAwait(false);
            if (error != null) return error;
            using (upload)
            {
                try
                {
                    return Ok(_backup.Inspect(upload!, passphrase));
                }
                catch (JeBackupException ex)
                {
                    return BadRequest(new { error = true, code = ex.Code, message = ex.Message });
                }
            }
        }

        /// <summary>
        /// Restores an uploaded backup (form fields <c>file</c>, <c>passphrase</c> when it holds
        /// credentials, and <c>confirm</c> = "restore"). A safety copy of the current state is saved first.
        /// </summary>
        [HttpPost("admin/backup/restore")]
        [Authorize]
        [RequestSizeLimit(MaxUploadBytes)]
        [RequestFormLimits(MultipartBodyLengthLimit = MaxUploadBytes)]
        public async Task<IActionResult> Restore()
        {
            if (!IsAdmin()) return Forbid();
            var (upload, passphrase, confirm, error) = await ReadUploadAsync().ConfigureAwait(false);
            if (error != null) return error;
            using (upload)
            {
                if (!string.Equals(confirm, RestoreConfirmation, StringComparison.Ordinal))
                    return BadRequest(new { error = true, code = "confirmation_required", message = "Send confirm=restore to replace the current Jellyfin Enhanced data." });
                try
                {
                    var result = _backup.Restore(upload!, passphrase);
                    return Ok(result);
                }
                catch (JeBackupException ex)
                {
                    _logger.Warning($"JE backup: restore refused ({ex.Code}).");
                    return BadRequest(new { error = true, code = ex.Code, message = ex.Message });
                }
            }
        }

        private async Task<(MemoryStream? Upload, string? Passphrase, string? Confirm, IActionResult? Error)> ReadUploadAsync()
        {
            if (!Request.HasFormContentType)
                return (null, null, null, BadRequest(new { error = true, code = "file_required", message = "Upload the backup as multipart form data (field \"file\")." }));
            var form = await Request.ReadFormAsync().ConfigureAwait(false);
            var file = form.Files.GetFile("file");
            if (file == null || file.Length == 0)
                return (null, null, null, BadRequest(new { error = true, code = "file_required", message = "Choose a backup file." }));
            if (file.Length > MaxUploadBytes)
                return (null, null, null, BadRequest(new { error = true, code = "too_large", message = "The file is too large to be a Jellyfin Enhanced backup." }));
            var ms = new MemoryStream();
            await file.CopyToAsync(ms).ConfigureAwait(false);
            ms.Position = 0;
            return (ms, form["passphrase"].ToString(), form["confirm"].ToString(), null);
        }

        private static bool TryParseMode(string? value, out JeBackupSecrets mode)
        {
            mode = JeBackupSecrets.Exclude;
            if (string.IsNullOrWhiteSpace(value) || value.Equals("exclude", StringComparison.OrdinalIgnoreCase)) return true;
            if (value.Equals("encrypt", StringComparison.OrdinalIgnoreCase))
            {
                mode = JeBackupSecrets.Encrypt;
                return true;
            }
            return false;
        }

        // A person with Jellyfin's administrator permission (never an API key or an unknown user).
        private bool IsAdmin() => ArrCaller.IsAdmin(User, _userManager);
    }
}
