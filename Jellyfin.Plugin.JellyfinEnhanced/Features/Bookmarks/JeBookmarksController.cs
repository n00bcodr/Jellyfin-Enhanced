using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Library;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Bookmarks
{
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class JeBookmarksController : JeControllerBase
    {
        private readonly UserDisplayResolver _userDisplayResolver;

        public JeBookmarksController(
            Logger logger,
            IUserManager userManager,
            UserConfigurationManager userConfigurationManager)
            : base(userManager, logger, userConfigurationManager)
        {
            _userDisplayResolver = new UserDisplayResolver(userManager);
        }

        [HttpGet("user-settings/{userId}/bookmark-document")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        public IActionResult GetBookmarkDocument(string userId)
        {
            var denied = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (denied != null) return denied;
            try { return TransportJson.Create(new Features.Bookmarks.Services.BookmarkDocumentService(_userConfigurationManager).Read(authorizedUserId)); }
            catch (Exception ex) when (ex is System.IO.IOException || ex is System.IO.InvalidDataException || ex is Newtonsoft.Json.JsonException)
            { return StatusCode(500, new { message = "Bookmarks could not be read. The stored document has been preserved." }); }
        }

        [HttpPost("user-settings/{userId}/bookmark-document")]
        [Authorize]
        public IActionResult MutateBookmarkDocument(string userId, [FromBody] BookmarkMutationRequest request)
        {
            var denied = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (denied != null) return denied;
            if (request == null || string.IsNullOrWhiteSpace(request.Revision)) return BadRequest(new { message = "The loaded bookmark revision is required." });
            try
            {
                if (!new Features.Bookmarks.Services.BookmarkDocumentService(_userConfigurationManager).TryMutate(authorizedUserId, request, out var receipt))
                    return Conflict(new { message = "Bookmarks changed in another tab or on the server. Reload before saving again." });
                return TransportJson.Create(receipt);
            }
            catch (ArgumentException ex) { return BadRequest(new { message = ex.Message }); }
            catch (Exception ex) when (ex is System.IO.IOException || ex is System.IO.InvalidDataException || ex is Newtonsoft.Json.JsonException)
            { return StatusCode(500, new { message = "Bookmarks could not be saved. The stored document has been preserved." }); }
        }

        [HttpGet("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public IActionResult GetUserBookmark(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var userConfig = _userConfigurationManager.GetUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json");
            return Ok(userConfig);
        }

        [HttpPost("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserBookmark(string userId, [FromBody] UserBookmark userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "bookmark.json", userConfiguration);
                _logger.Info($"Saved enhanced bookmarks for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)} to bookmark.json");
                return Ok(new { success = true, file = "bookmark.json" });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save enhanced bookmarks for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save enhanced bookmarks." });
            }
        }

        public sealed class AddBookmarkPayload
        {
            public string ItemId { get; set; } = string.Empty;
            public string TmdbId { get; set; } = string.Empty;
            public string TvdbId { get; set; } = string.Empty;
            public string MediaType { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public double Timestamp { get; set; }
            public string Label { get; set; } = string.Empty;
            public string SyncedFrom { get; set; } = string.Empty;
            public int? SeasonNumber { get; set; }
            public int? EpisodeNumber { get; set; }
        }

        [HttpPost("user-settings/{userId}/bookmark.json/add")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AddUserBookmark(string userId, [FromBody] AddBookmarkPayload payload)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || string.IsNullOrWhiteSpace(payload.ItemId))
            {
                return BadRequest(new { success = false, message = "ItemId is required." });
            }

            var now = DateTime.UtcNow.ToString("o");
            var bookmarkId = $"Bm_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid().ToString("N").Substring(0, 9)}";

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json", config =>
                {
                    config.Bookmarks[bookmarkId] = new BookmarkItem
                    {
                        ItemId = payload.ItemId,
                        TmdbId = payload.TmdbId ?? string.Empty,
                        TvdbId = payload.TvdbId ?? string.Empty,
                        MediaType = payload.MediaType ?? string.Empty,
                        Name = payload.Name ?? string.Empty,
                        Timestamp = payload.Timestamp,
                        Label = payload.Label ?? string.Empty,
                        CreatedAt = now,
                        UpdatedAt = now,
                        SyncedFrom = payload.SyncedFrom ?? string.Empty,
                        SeasonNumber = payload.SeasonNumber,
                        EpisodeNumber = payload.EpisodeNumber
                    };
                    return 1;
                });
                _logger.Info($"Added bookmark {bookmarkId} for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}");
                return Ok(new { success = true, id = bookmarkId });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to add bookmark for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to add bookmark." });
            }
        }

        [HttpDelete("user-settings/{userId}/bookmark.json/{bookmarkId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult RemoveUserBookmark(string userId, string bookmarkId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (string.IsNullOrWhiteSpace(bookmarkId))
            {
                return BadRequest(new { success = false, message = "bookmarkId is required." });
            }

            try
            {
                var removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json", config =>
                {
                    removed = config.Bookmarks.Remove(bookmarkId);
                    return removed ? 1 : 0;
                });

                if (!removed)
                {
                    return NotFound(new { success = false, removed = false, message = "No matching bookmark to remove." });
                }

                _logger.Info($"Removed bookmark {bookmarkId} for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}");
                return Ok(new { success = true, removed = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to remove bookmark {bookmarkId} for {_userDisplayResolver.ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to remove bookmark." });
            }
        }
    }
}
