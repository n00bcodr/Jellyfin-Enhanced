using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.StaticFiles;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Sessions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Chrome
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JeChromeController : JeControllerBase
    {
        private readonly ISessionManager _sessionManager;
        private readonly ActiveSessionsService _activeSessionsService;

        private static readonly HashSet<string> BrandingFileNames = new(new[]
        {
            "icon-transparent.png",
            "banner-light.png",
            "banner-dark.png",
            "favicon.ico",
            "apple-touch-icon.png"
        }, StringComparer.OrdinalIgnoreCase);

        public JeChromeController(
            Logger logger,
            IUserManager userManager,
            UserConfigurationManager userConfigurationManager,
            ISessionManager sessionManager)
            : base(userManager, logger, userConfigurationManager)
        {
            _sessionManager = sessionManager;
            _activeSessionsService = new ActiveSessionsService(sessionManager);
        }

        private bool TryResolveBrandingFilePath(string requestedFileName, out string normalizedFileName, out string filePath)
        {
            normalizedFileName = Path.GetFileName(requestedFileName ?? string.Empty);
            filePath = string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedFileName) || !BrandingFileNames.Contains(normalizedFileName))
            {
                return false;
            }

            var brandingDir = JellyfinEnhanced.BrandingDirectory;
            if (string.IsNullOrWhiteSpace(brandingDir))
            {
                return false;
            }

            // The allowlist is case-insensitive, but the middleware and status endpoint
            // use fixed lowercase names. Normalize accepted aliases on case-sensitive hosts.
            normalizedFileName = normalizedFileName.ToLowerInvariant();
            var fullBrandingDir = Path.GetFullPath(brandingDir);
            var candidateFilePath = Path.GetFullPath(Path.Combine(fullBrandingDir, normalizedFileName));
            var candidateDirectory = Path.GetDirectoryName(candidateFilePath);

            if (!string.Equals(candidateDirectory, fullBrandingDir, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            filePath = candidateFilePath;
            return true;
        }

        [HttpPost("UploadBrandingImage")]
        [Authorize]
        public async Task<IActionResult> UploadBrandingImage()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                if (Request.Form.Files.Count == 0)
                    return BadRequest("No file uploaded");

                var uploadedFile = Request.Form.Files[0];

                // Get fileName from form data
                string? fileName = Request.Form["fileName"].FirstOrDefault();
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    return BadRequest("fileName parameter is required in form data");
                }

                if (!TryResolveBrandingFilePath(fileName, out var normalizedFileName, out var filePath))
                {
                    return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
                }

                // Validate file type - accept only image files
                if (!uploadedFile.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                    return BadRequest("Only image files are allowed");

                const long maxFileSize = 10 * 1024 * 1024; // 10MB
                if (uploadedFile.Length > maxFileSize)
                    return BadRequest($"File too large (max 10MB)");

                // Get branding directory from central location
                var brandingDir = JellyfinEnhanced.BrandingDirectory;
                if (string.IsNullOrWhiteSpace(brandingDir))
                    return StatusCode(500, "Could not determine branding directory");

                Directory.CreateDirectory(brandingDir);

                // Save file
                using (var stream = new FileStream(filePath, FileMode.Create, FileAccess.Write))
                {
                    await uploadedFile.CopyToAsync(stream);
                }

                _logger.Info($"Successfully uploaded branding image: {normalizedFileName} ({uploadedFile.Length} bytes) to {brandingDir}");
                return Ok("File uploaded successfully");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.Error($"Permission denied when uploading branding image: {ex.Message}");
                return StatusCode(403, "Permission denied when uploading branding image.");
            }
            catch (Exception ex)
            {
                _logger.Error($"Error uploading branding image: {ex.Message}");
                return StatusCode(500, "An error occurred while uploading the branding image.");
            }
        }

        /// <summary>
        /// Which of the fixed branding slots have a custom image uploaded, in one request.
        /// </summary>
        [HttpGet("BrandingStatus")]
        [Authorize]
        public IActionResult GetBrandingStatus()
        {
            var brandingDir = JellyfinEnhanced.BrandingDirectory;
            var status = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            foreach (var name in BrandingFileNames)
            {
                status[name] = !string.IsNullOrWhiteSpace(brandingDir)
                    && System.IO.File.Exists(Path.Combine(brandingDir, name));
            }

            return Ok(status);
        }

        [HttpGet("BrandingImage")]
        [Authorize]
        public IActionResult GetBrandingImage([FromQuery] string? fileName)
        {
            if (string.IsNullOrWhiteSpace(fileName))
            {
                return BadRequest("fileName query parameter is required");
            }

            if (!TryResolveBrandingFilePath(fileName, out _, out var filePath))
            {
                return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
            }

            if (!System.IO.File.Exists(filePath))
                return NotFound();

            var provider = new FileExtensionContentTypeProvider();
            if (!provider.TryGetContentType(filePath, out var contentType))
            {
                contentType = "application/octet-stream";
            }

            return PhysicalFile(filePath, contentType);
        }

        [HttpPost("DeleteBrandingImage")]
        [Authorize]
        public IActionResult DeleteBrandingImage()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                string? fileName = Request.Form["fileName"].FirstOrDefault();
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    return BadRequest("fileName parameter is required in form data");
                }

                if (!TryResolveBrandingFilePath(fileName, out var normalizedFileName, out var filePath))
                {
                    return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
                }

                var brandingDir = JellyfinEnhanced.BrandingDirectory;
                if (string.IsNullOrWhiteSpace(brandingDir))
                    return StatusCode(500, "Could not determine branding directory");

                if (!System.IO.File.Exists(filePath))
                    return NotFound("File not found");

                System.IO.File.Delete(filePath);
                _logger.Info($"Deleted branding image: {normalizedFileName} from {brandingDir}");
                return Ok("File deleted successfully");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.Error($"Permission denied when deleting branding image: {ex.Message}");
                return StatusCode(403, "Permission denied when deleting branding image.");
            }
            catch (Exception ex)
            {
                _logger.Error($"Error deleting branding image: {ex.Message}");
                return StatusCode(500, "An error occurred while deleting the branding image.");
            }
        }

        // ==================== Active Streams ====================

        [HttpGet("active-streams/sessions")]
        [Authorize]
        public IActionResult GetActiveSessions()
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            // Non-admins only allowed if ActiveStreamsAllUsers is on
            if (!IsAdminUser() && !config.ActiveStreamsAllUsers)
                return Forbid();

            try
            {
                return Ok(_activeSessionsService.BuildActiveSessionList(IsAdminUser()));
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to get active sessions: {ex.Message}");
                return StatusCode(500, "Failed to retrieve sessions.");
            }
        }

        [HttpPost("active-streams/broadcast")]
        [Authorize]
        public async Task<IActionResult> BroadcastMessage([FromBody] BroadcastMessageRequest request)
        {
            if (!IsAdminUser())
                return Forbid();

            if (request == null || string.IsNullOrWhiteSpace(request.Text))
                return BadRequest("Message text is required.");

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.ActiveStreamsEnabled)
                return StatusCode(503, "Active Streams is not enabled.");

            var sent = 0;
            var skipped = 0;
            var errors = new List<string>();

            // Use the current session as the controlling session (admin's own session)
            var controllingSessionId = string.Empty;
            try
            {
                var adminSession = _sessionManager.Sessions
                    .FirstOrDefault(s => s.UserId == GetCurrentUserId());
                controllingSessionId = adminSession?.Id ?? string.Empty;
            }
            catch { /* non-fatal — empty string is accepted */ }

            var command = new MediaBrowser.Model.Session.MessageCommand
            {
                Header = request.Header,
                Text = request.Text,
                TimeoutMs = request.TimeoutMs
            };

            foreach (var session in _sessionManager.Sessions)
            {
                // Skip sessions with no real user
                if (string.IsNullOrWhiteSpace(session.UserName) ||
                    string.Equals(session.UserName, "Unknown", StringComparison.OrdinalIgnoreCase))
                {
                    skipped++;
                    continue;
                }

                try
                {
                    await _sessionManager.SendMessageCommand(
                        controllingSessionId,
                        session.Id,
                        command,
                        CancellationToken.None).ConfigureAwait(false);
                    sent++;
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Broadcast: failed to send to session {session.Id} ({session.UserName}): {ex.Message}");
                    errors.Add($"{session.UserName}: {ex.Message}");
                    skipped++;
                }
            }

            return Ok(new { sent, skipped, errors });
        }
    }

    public class BroadcastMessageRequest
    {
        public string? Header { get; set; }

        public string Text { get; set; } = string.Empty;

        public long? TimeoutMs { get; set; }
    }
}
