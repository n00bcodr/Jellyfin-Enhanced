using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// The list import review (track 4c2a; preview only, nothing here changes a list): resolving parsed lines to titles,
    /// reading a list URL into entries, and which sources work. Every route needs a signed-in person (no API key, no
    /// disabled user: 403 <c>user_required</c>), answers 404 <c>{code:"disabled"}</c> while import is off
    /// (<see cref="ListImportFlags.Import"/>; URL reads also need <see cref="ListImportFlags.Sources"/> and the provider's own
    /// switch), and is private and never stored (<c>private, no-store</c>). A target list (for "in library" as its owner
    /// sees it) needs edit rights on it, the same answer as a list that doesn't exist otherwise. Bodies are capped before
    /// binding (resolve: 128 KiB for 25 entries with episodes and alternatives; source: 16 KiB).
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class AcquireListImportController : ControllerBase
    {
        /// <summary>Body cap of resolve (25 entries, each up to 100 episodes and 4 alternatives).</summary>
        public const int ResolveBody = 128 * 1024;

        private readonly IUserManager _userManager;
        private readonly ListAccessService _access;
        private readonly ListImportResolver _resolver;
        private readonly ListSourcePreview _sources;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        /// <param name="userManager">User manager.</param>
        /// <param name="access">Access service.</param>
        /// <param name="resolver">Import resolver.</param>
        /// <param name="sources">URL review.</param>
        /// <param name="logger">JE logger.</param>
        public AcquireListImportController(IUserManager userManager, ListAccessService access, ListImportResolver resolver, ListSourcePreview sources, Logger logger)
        {
            _userManager = userManager;
            _access = access;
            _resolver = resolver;
            _sources = sources;
            _logger = logger;
        }

        private static Configuration.PluginConfiguration? Config => JellyfinEnhanced.Instance?.Configuration;

        /// <summary>Resolves up to 25 parsed import entries to titles (send chunks one after another).</summary>
        /// <param name="request">Entries and an optional target list.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ResolveResponse"/>; 504 <c>parental_pending</c> with Retry-After when the caller's checks didn't finish.</returns>
        [HttpPost("acquire/lists/import/resolve")]
        [Authorize]
        [BodyLimit(ResolveBody)]
        public Task<IActionResult> Resolve([FromBody] ResolveRequest request, CancellationToken cancellationToken) =>
            Guarded(sources: false, async user =>
            {
                if (request?.Entries == null || request.Entries.Count == 0 || request.Entries.Count > ListImportResolver.MaxEntriesPerCall)
                {
                    return Refused(400, "invalid_body", $"Send 1-{ListImportResolver.MaxEntriesPerCall} entries per call.");
                }

                if (!_resolver.IsAvailable)
                {
                    return Refused(503, "metadata_unavailable", "Titles can't be looked up: Jellyfin Enhanced needs a TMDB key or Seerr for that.");
                }

                var (listError, libraryUsers) = LibraryUsers(user, request.ListId);
                if (listError != null)
                {
                    return listError;
                }

                // E4: one person's calls can't pile up queued lookups (the client sends chunks one at a time).
                using var admission = _resolver.TryEnterCall(user.Id.ToString("N", CultureInfo.InvariantCulture));
                if (admission == null)
                {
                    Response.Headers["Retry-After"] = "2";
                    return Refused(429, "busy", "Your previous lookups are still running; try again in a moment.");
                }

                var outcome = await _resolver.ResolveAsync(
                    request.Entries,
                    new ImportResolveOptions
                    {
                        Caller = user,
                        LibraryUsers = libraryUsers!,
                        Context = new ImportCallContext(user.Id.ToString("N", CultureInfo.InvariantCulture), background: false),
                    },
                    cancellationToken).ConfigureAwait(false);
                if (outcome.ParentalPending)
                {
                    Response.Headers["Retry-After"] = "2";
                    return Refused(504, "parental_pending", "Checking titles against your parental controls; try again in a moment.");
                }

                return Ok(outcome.Response);
            });

        /// <summary>Reads a list URL (MDBList, TMDB, Trakt, Chronolists, IMDb when opted in) into import entries with ids.</summary>
        /// <param name="request">The URL, an optional target list and the administrators' deliberate MDBList API read.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="SourceFetchResponse"/> or an error with a typed code.</returns>
        [HttpPost("acquire/lists/import/source")]
        [Authorize]
        [BodyLimit]
        public Task<IActionResult> FetchSource([FromBody] SourceFetchRequest request, CancellationToken cancellationToken) =>
            Guarded(sources: true, async user =>
            {
                if (string.IsNullOrWhiteSpace(request?.Url) || request.Url.Length > 500)
                {
                    return Refused(400, "invalid_body", "A list URL is required.");
                }

                if (request.UseMdblistApi && !ListAccessService.IsAdmin(user))
                {
                    return Refused(403, "admin_required", "Only administrators can read MDBList lists through the server's MDBList key.");
                }

                var (listError, libraryUsers) = LibraryUsers(user, request.ListId);
                if (listError != null)
                {
                    return listError;
                }

                return ToResult(await _sources.FetchAsync(user, request, cancellationToken, libraryUsers).ConfigureAwait(false));
            });

        /// <summary>Which list sources work on this server (no secrets).</summary>
        /// <returns><see cref="SourceProvidersDto"/>.</returns>
        [HttpGet("acquire/lists/import/providers")]
        [Authorize]
        public Task<IActionResult> GetProviders() =>
            Guarded(sources: false, user => Task.FromResult<IActionResult>(Ok(_sources.Providers(user))));

        // ── Helpers ──────────────────────────────────────────────────────────

        private async Task<IActionResult> Guarded(bool sources, Func<User, Task<IActionResult>> action)
        {
            // Every answer here is one person's transient review data: private and never stored (also errors and 304-free
            // successes; the acquire routes set the header themselves, the attribute is the admin routes').
            Response.Headers["Cache-Control"] = PrivateResponseAttribute.CacheControl;

            // A person first (API keys, unknown and disabled users), then the switches.
            var user = ArrCaller.Human(User, _userManager);
            if (user == null)
            {
                return Refused(403, "user_required", "Sign in as a person to import lists.");
            }

            if (!ListImportFlags.Import(Config) || (sources && !ListImportFlags.Sources(Config)))
            {
                return Refused(404, "disabled", "Importing lists is off.");
            }

            try
            {
                return await action(user).ConfigureAwait(false);
            }
            catch (InvalidDataException ex)
            {
                _logger.Error($"[Lists] {ex.Message}");
                return Refused(503, "store_unavailable", "The list's data can't be read; ask your administrator to check the server log.");
            }
            catch (OperationCanceledException) when (HttpContext?.RequestAborted.IsCancellationRequested == true)
            {
                return StatusCode(499);
            }
        }

        // The people an "in library" match must be visible to: the caller, and for a playlist another person owns, the
        // owner too. A target list the caller can't edit answers like one that doesn't exist (never confirms it).
        private (IActionResult? Error, IReadOnlyList<User>? Users) LibraryUsers(User user, string? listId)
        {
            var users = new List<User> { user };
            if (string.IsNullOrEmpty(listId))
            {
                return (null, users);
            }

            if (!Guid.TryParse(listId, out var id) || id == Guid.Empty)
            {
                return (Refused(400, "invalid_list_id", "Invalid list id."), null);
            }

            var access = _access.Resolve(id, user);
            if (access == null || !access.Permissions.CanView)
            {
                return (Refused(404, "not_found", "List not found."), null);
            }

            if (!access.Permissions.CanEdit)
            {
                return (Refused(403, "forbidden", "You can't edit this list."), null);
            }

            if (access.List.Kind == ListKinds.Playlist && access.Owner != null && access.Owner.Id != user.Id)
            {
                users.Add(access.Owner);
            }

            return (null, users);
        }

        private IActionResult Refused(int status, string code, string message)
        {
            Response.Headers["Cache-Control"] = PrivateResponseAttribute.CacheControl;
            return new ObjectResult(new ListErrorDto { Code = code, Message = message }) { StatusCode = status };
        }

        private IActionResult ToResult(ListOutcome outcome)
        {
            Response.Headers["Cache-Control"] = PrivateResponseAttribute.CacheControl;
            if (outcome.RetryAfterSeconds.HasValue)
            {
                Response.Headers["Retry-After"] = outcome.RetryAfterSeconds.Value.ToString(CultureInfo.InvariantCulture);
            }

            return new ObjectResult(outcome.Value) { StatusCode = outcome.StatusCode };
        }
    }
}
