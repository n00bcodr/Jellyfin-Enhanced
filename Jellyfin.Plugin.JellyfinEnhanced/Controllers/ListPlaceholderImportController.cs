using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Bulk import and linked lists for "Not in your library" placeholders (same route prefix as
    /// <see cref="ListPlaceholdersController"/>): resolving parsed lines through Seerr, fetching list URLs, and linking a
    /// list to a source that is re-synced. Every route needs a signed-in user and answers 404 <c>{message:"disabled"}</c>
    /// while <c>ListPlaceholdersEnabled</c> is off. Resolve needs Seerr and a Seerr-linked account (or admin); linking and
    /// syncing need edit rights on the list.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced/list-placeholders")]
    public class ListPlaceholderImportController : ControllerBase
    {
        private readonly IUserManager _userManager;
        private readonly ListAccessService _access;
        private readonly ListImportResolver _resolver;
        private readonly SeerrUserLink _seerrLink;
        private readonly ListSourceService _sources;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        /// <param name="userManager">User manager.</param>
        /// <param name="access">Access service.</param>
        /// <param name="resolver">Import resolver.</param>
        /// <param name="seerrLink">Seerr account check.</param>
        /// <param name="sources">Linked-source service.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholderImportController(IUserManager userManager, ListAccessService access, ListImportResolver resolver, SeerrUserLink seerrLink, ListSourceService sources, Logger logger)
        {
            _userManager = userManager;
            _access = access;
            _resolver = resolver;
            _seerrLink = seerrLink;
            _sources = sources;
            _logger = logger;
        }

        /// <summary>Resolves up to 25 parsed import entries to TMDB titles (send chunks sequentially).</summary>
        /// <param name="request">Entries and optional target list.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ResolveResponse"/>; 504 parental_pending with Retry-After when the caller's checks didn't finish.</returns>
        [HttpPost("resolve")]
        [Authorize]
        public Task<IActionResult> Resolve([FromBody] ResolveRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var user = CurrentUser(out var error);
                if (error != null)
                {
                    return error;
                }

                if (request?.Entries == null || request.Entries.Count == 0 || request.Entries.Count > ListImportResolver.MaxEntriesPerCall)
                {
                    return Bad("invalid_body", $"Send 1-{ListImportResolver.MaxEntriesPerCall} entries per call.");
                }

                if (!_resolver.IsAvailable)
                {
                    return StatusCode(503, new ListErrorDto { Code = "seerr_unavailable", Message = "Seerr isn't set up, so titles can't be looked up." });
                }

                if (!await _seerrLink.IsAllowedAsync(user!, cancellationToken).ConfigureAwait(false))
                {
                    return StatusCode(403, new ListErrorDto { Code = "seerr_unlinked", Message = "Your Seerr account isn't linked yet. Sign in to Seerr once to import lists." });
                }

                var libraryUsers = new List<User> { user! };
                if (!string.IsNullOrEmpty(request.ListId))
                {
                    var (listError, access) = ResolveList(user!, request.ListId, edit: true);
                    if (listError != null)
                    {
                        return listError;
                    }

                    if (access!.List.Kind == ListKinds.Playlist && access.Owner != null && access.Owner.Id != user!.Id)
                    {
                        libraryUsers.Add(access.Owner);
                    }
                }

                // E4: one user's calls can't pile up queued Seerr work (the client sends chunks one at a time).
                using var admission = _resolver.TryEnterCall(user!.Id.ToString("N", CultureInfo.InvariantCulture));
                if (admission == null)
                {
                    Response.Headers["Retry-After"] = "2";
                    return StatusCode(429, new ListErrorDto { Code = "busy", Message = "Your previous lookups are still running; try again in a moment." });
                }

                var outcome = await _resolver.ResolveAsync(
                    request.Entries,
                    new ImportResolveOptions
                    {
                        Caller = user!,
                        LibraryUsers = libraryUsers,
                        Context = new ImportCallContext(user!.Id.ToString("N", CultureInfo.InvariantCulture), background: false),
                    },
                    cancellationToken).ConfigureAwait(false);
                if (outcome.ParentalPending)
                {
                    Response.Headers["Retry-After"] = "2";
                    return StatusCode(504, new ListErrorDto { Code = "parental_pending", Message = "Checking titles against your parental controls; try again in a moment." });
                }

                return Ok(outcome.Response);
            });

        /// <summary>Fetches a list URL (MDBList, TMDB, Trakt, IMDb when enabled) into import entries with ids.</summary>
        /// <param name="request">The URL.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="SourceFetchResponse"/> or an error with a code (letterboxd_unsupported, unsupported_url, not_found, trakt_not_configured, tmdb_key_required, imdb_disabled, rate_limited…).</returns>
        [HttpPost("source/fetch")]
        [Authorize]
        public Task<IActionResult> FetchSource([FromBody] SourceFetchRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var user = CurrentUser(out var error);
                if (error != null)
                {
                    return error;
                }

                if (string.IsNullOrWhiteSpace(request?.Url) || request.Url.Length > 500)
                {
                    return Bad("invalid_body", "A list URL is required.");
                }

                return ToResult(await _sources.FetchAsync(user!, request.Url, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Which URL sources work on this server (no secrets).</summary>
        /// <returns><see cref="SourceProvidersDto"/>.</returns>
        [HttpGet("source/providers")]
        [Authorize]
        public Task<IActionResult> GetSourceProviders() =>
            Guarded(() =>
            {
                CurrentUser(out var error);
                return Task.FromResult(error ?? Ok(_sources.Providers()));
            });

        /// <summary>Links a list to a source URL (keep in sync / remove entries that leave the list).</summary>
        /// <param name="listId">List id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns>The fresh <see cref="ListViewDto"/>.</returns>
        [HttpPut("{listId}/source")]
        [Authorize]
        public Task<IActionResult> LinkSource([FromRoute] string listId, [FromBody] LinkSourceRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var user = CurrentUser(out var error);
                if (error != null)
                {
                    return error;
                }

                var (listError, access) = ResolveList(user!, listId, edit: true);
                if (listError != null)
                {
                    return listError;
                }

                if (request == null || string.IsNullOrWhiteSpace(request.Url) || request.Url.Length > 500 || !ValidRequestId(request.RequestId))
                {
                    return Bad("invalid_body", "A list URL and a valid requestId are required.");
                }

                return ToResult(await _sources.LinkAsync(access!, request, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Unlinks a list from its source (entries stay).</summary>
        /// <param name="listId">List id.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns>The fresh <see cref="ListViewDto"/>.</returns>
        [HttpDelete("{listId}/source")]
        [Authorize]
        public Task<IActionResult> UnlinkSource([FromRoute] string listId, [FromQuery] string? requestId, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var user = CurrentUser(out var error);
                if (error != null)
                {
                    return error;
                }

                var (listError, access) = ResolveList(user!, listId, edit: true);
                if (listError != null)
                {
                    return listError;
                }

                if (!ValidRequestId(requestId))
                {
                    return Bad("invalid_body", "Invalid requestId.");
                }

                return ToResult(await _sources.UnlinkAsync(access!, requestId, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Runs the linked list's sync now (202 while it is still running).</summary>
        /// <param name="listId">List id.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="SourceSyncResultDto"/>.</returns>
        [HttpPost("{listId}/source/sync")]
        [Authorize]
        public Task<IActionResult> SyncSource([FromRoute] string listId, [FromQuery] string? requestId, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var user = CurrentUser(out var error);
                if (error != null)
                {
                    return error;
                }

                var (listError, access) = ResolveList(user!, listId, edit: true);
                if (listError != null)
                {
                    return listError;
                }

                if (!ValidRequestId(requestId))
                {
                    return Bad("invalid_body", "Invalid requestId.");
                }

                return ToResult(await _sources.SyncNowAsync(access!, requestId, cancellationToken).ConfigureAwait(false));
            });

        // ── Helpers ──────────────────────────────────────────────────────────

        private async Task<IActionResult> Guarded(Func<Task<IActionResult>> action)
        {
            if (JellyfinEnhanced.Instance?.Configuration?.ListPlaceholdersEnabled != true)
            {
                return NotFound(new { message = "disabled" });
            }

            try
            {
                return await action().ConfigureAwait(false);
            }
            catch (InvalidDataException ex)
            {
                _logger.Error($"[ListPlaceholders] {ex.Message}");
                return StatusCode(503, new ListErrorDto { Code = "store_unavailable", Message = "The list's placeholder data can't be read; ask your administrator to check the server log." });
            }
            catch (OperationCanceledException) when (HttpContext?.RequestAborted.IsCancellationRequested == true)
            {
                return StatusCode(499);
            }
        }

        private User? CurrentUser(out IActionResult? error)
        {
            error = null;
            var userId = UserHelper.GetCurrentUserId(User);
            var user = userId.HasValue ? _userManager.GetUserById(userId.Value) : null;
            if (user == null)
            {
                error = Forbid();
            }

            return user;
        }

        private (IActionResult? Error, ListAccess? Access) ResolveList(User user, string listId, bool edit)
        {
            if (!Guid.TryParse(listId, out var id) || id == Guid.Empty)
            {
                return (Bad("invalid_list_id", "Invalid list id."), null);
            }

            var access = _access.Resolve(id, user);
            if (access == null || !access.Permissions.CanView)
            {
                return (NotFound(new ListErrorDto { Code = "not_found", Message = "List not found." }), null);
            }

            if (edit && !access.Permissions.CanEdit)
            {
                return (StatusCode(403, new ListErrorDto { Code = "forbidden", Message = "You can't edit this list." }), null);
            }

            return (null, access);
        }

        private static bool ValidRequestId(string? requestId) => requestId == null || ListPlaceholderStore.IsValidRequestId(requestId);

        private BadRequestObjectResult Bad(string code, string message) => BadRequest(new ListErrorDto { Code = code, Message = message });

        private IActionResult ToResult(ListOutcome outcome)
        {
            if (outcome.RetryAfterSeconds.HasValue)
            {
                Response.Headers["Retry-After"] = outcome.RetryAfterSeconds.Value.ToString(CultureInfo.InvariantCulture);
            }

            if (outcome.RawJson != null)
            {
                return new ContentResult { StatusCode = outcome.StatusCode, Content = outcome.RawJson, ContentType = "application/json" };
            }

            return new ObjectResult(outcome.Value) { StatusCode = outcome.StatusCode };
        }
    }
}
