using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// "Not in your library" placeholders on playlists and collections. Every route needs a signed-in user and
    /// answers 404 <c>{message:"disabled"}</c> while <c>ListPlaceholdersEnabled</c> is off. Viewing needs list
    /// visibility; editing needs playlist ownership / a CanEdit share / admin, or for collections admin /
    /// collection management (<see cref="ListAccessRules"/>). Everything the client sends is re-validated.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced/list-placeholders")]
    public class ListPlaceholdersController : ControllerBase
    {
        private const int MaxEntries = ListPlaceholderStore.MaxPlaceholders;
        private const int MaxOrderTokens = 20000;

        private readonly IUserManager _userManager;
        private readonly ListAccessService _access;
        private readonly ListPlaceholderService _service;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        /// <param name="userManager">User manager.</param>
        /// <param name="access">Access service.</param>
        /// <param name="service">Placeholder service.</param>
        /// <param name="logger">JE logger.</param>
        public ListPlaceholdersController(IUserManager userManager, ListAccessService access, ListPlaceholderService service, Logger logger)
        {
            _userManager = userManager;
            _access = access;
            _service = service;
            _logger = logger;
        }

        /// <summary>The caller's view of a list (placeholders, projected order, Seerr status).</summary>
        /// <param name="listId">Playlist or collection id.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>.</returns>
        [HttpGet("{listId}")]
        [Authorize]
        public Task<IActionResult> GetList([FromRoute] string listId, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var (error, access) = ResolveList(listId, edit: false);
                if (error != null)
                {
                    return error;
                }

                return Ok(await _service.GetViewAsync(access!, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Adds placeholders (movies already in the library go in as real items).</summary>
        /// <param name="listId">List id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ApplyResultDto"/>.</returns>
        [HttpPost("{listId}/items")]
        [Authorize]
        public Task<IActionResult> AddItems([FromRoute] string listId, [FromBody] AddItemsRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var (error, access) = ResolveList(listId, edit: true);
                if (error != null)
                {
                    return error;
                }

                if (request?.Placeholders == null || request.Placeholders.Count == 0 || request.Placeholders.Count > MaxEntries)
                {
                    return Bad("invalid_body", $"Send 1-{MaxEntries} placeholders.");
                }

                if (!ValidRequestId(request.RequestId) || !ValidPosition(request.Position))
                {
                    return Bad("invalid_body", "Invalid requestId or position.");
                }

                var placeholders = new List<Placeholder>(request.Placeholders.Count);
                for (var i = 0; i < request.Placeholders.Count; i++)
                {
                    if (!PlaceholderRules.TryCreate(request.Placeholders[i], access!.UserIdN, DateTime.UtcNow, out var placeholder, out var reason))
                    {
                        return Bad("invalid_entry", $"Placeholder {i}: {reason}.");
                    }

                    placeholders.Add(placeholder);
                }

                return ToResult(await _service.AddPlaceholdersAsync(access!, placeholders, request.Position, request.Rev, request.RequestId, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Applies ordered entries (real items and placeholders) at a position.</summary>
        /// <param name="listId">List id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ApplyResultDto"/>.</returns>
        [HttpPost("{listId}/apply")]
        [Authorize]
        public Task<IActionResult> Apply([FromRoute] string listId, [FromBody] ApplyRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var (error, access) = ResolveList(listId, edit: true);
                if (error != null)
                {
                    return error;
                }

                if (request?.Entries == null || request.Entries.Count == 0 || request.Entries.Count > MaxEntries)
                {
                    return Bad("invalid_body", $"Send 1-{MaxEntries} entries.");
                }

                if (!ValidRequestId(request.RequestId) || !ValidPosition(request.Position))
                {
                    return Bad("invalid_body", "Invalid requestId or position.");
                }

                var (entryError, entries) = ParseEntries(request.Entries, access!.UserIdN);
                if (entryError != null)
                {
                    return entryError;
                }

                return ToResult(await _service.ApplyAsync(access, entries!, request.Position, request.Rev, request.RequestId, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Edits a placeholder: note, or link a custom entry to a TMDB title.</summary>
        /// <param name="listId">List id.</param>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>.</returns>
        [HttpPatch("{listId}/items/{placeholderId}")]
        [Authorize]
        public Task<IActionResult> PatchItem([FromRoute] string listId, [FromRoute] string placeholderId, [FromBody] PatchPlaceholderRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var (error, access) = ResolveList(listId, edit: true);
                if (error != null)
                {
                    return error;
                }

                if (!IsPlaceholderId(placeholderId) || request?.Rev == null || !ValidRequestId(request.RequestId))
                {
                    return Bad("invalid_body", "A placeholder id, rev and a valid requestId are required.");
                }

                string? note = null;
                if (request.Note != null)
                {
                    note = PlaceholderRules.CleanText(request.Note);
                    if (note.Length > PlaceholderRules.MaxNote)
                    {
                        return Bad("invalid_body", "Note must be at most 300 characters.");
                    }
                }

                Placeholder? link = null;
                if (request.Link != null && !PlaceholderRules.TryNormalize(request.Link, allowCustom: false, out link, out var reason))
                {
                    return Bad("invalid_entry", $"Link: {reason}.");
                }

                if (note == null && link == null)
                {
                    return Bad("invalid_body", "Nothing to change.");
                }

                return ToResult(await _service.PatchAsync(access!, placeholderId, request.Rev.Value, note, link, request.RequestId, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Removes a placeholder.</summary>
        /// <param name="listId">List id.</param>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <param name="rev">Expected revision.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>.</returns>
        [HttpDelete("{listId}/items/{placeholderId}")]
        [Authorize]
        public Task<IActionResult> DeleteItem([FromRoute] string listId, [FromRoute] string placeholderId, [FromQuery] int? rev, [FromQuery] string? requestId, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var (error, access) = ResolveList(listId, edit: true);
                if (error != null)
                {
                    return error;
                }

                if (!IsPlaceholderId(placeholderId) || rev == null || !ValidRequestId(requestId))
                {
                    return Bad("invalid_body", "A placeholder id, rev and a valid requestId are required.");
                }

                return ToResult(await _service.DeleteAsync(access!, placeholderId, rev.Value, requestId, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Saves the order after a drag (playlists only); a moved real row is moved in Jellyfin by the server.</summary>
        /// <param name="listId">Playlist id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>, or 409 with the fresh view.</returns>
        [HttpPut("{listId}/order")]
        [Authorize]
        public Task<IActionResult> PutOrder([FromRoute] string listId, [FromBody] OrderRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var (error, access) = ResolveList(listId, edit: true);
                if (error != null)
                {
                    return error;
                }

                if (access!.List.Kind != ListKinds.Playlist)
                {
                    return Bad("not_playlist", "Only playlists have an order.");
                }

                if (request?.Rev == null || request.Order == null || request.Order.Count > MaxOrderTokens || !ValidRequestId(request.RequestId)
                    || request.Order.Any(t => !(ListPlaceholderOrder.IsReal(t) || IsPlaceholderToken(t)))
                    || (request.Moved != null && !ListPlaceholderOrder.IsReal(request.Moved)))
                {
                    return Bad("invalid_body", "rev, a valid token order and requestId are required.");
                }

                return ToResult(await _service.ReorderAsync(access, request.Rev.Value, request.Order, request.Moved, request.RequestId, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Lists the caller can add to (playlists they can edit; collections for admins / collection managers).</summary>
        /// <returns><see cref="EditableListsDto"/>.</returns>
        [HttpGet("editable-lists")]
        [Authorize]
        public Task<IActionResult> GetEditableLists() =>
            Guarded(() =>
            {
                var user = CurrentUser(out var error);
                return Task.FromResult(error ?? Ok(_service.GetEditableLists(user!)));
            });

        /// <summary>Creates a playlist owned by the caller, optionally with initial entries.</summary>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="CreateListResultDto"/>.</returns>
        [HttpPost("playlists")]
        [Authorize]
        public Task<IActionResult> CreatePlaylist([FromBody] CreateListRequest request, CancellationToken cancellationToken) =>
            Guarded(() => CreateList(ListKinds.Playlist, request, cancellationToken));

        /// <summary>Creates a collection (admins and collection managers), optionally with initial entries.</summary>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="CreateListResultDto"/>.</returns>
        [HttpPost("collections")]
        [Authorize]
        public Task<IActionResult> CreateCollection([FromBody] CreateListRequest request, CancellationToken cancellationToken) =>
            Guarded(() => CreateList(ListKinds.Collection, request, cancellationToken));

        private async Task<IActionResult> CreateList(string kind, CreateListRequest request, CancellationToken cancellationToken)
        {
            var user = CurrentUser(out var error);
            if (error != null)
            {
                return error;
            }

            if (kind == ListKinds.Collection && !ListAccessService.CanManageCollections(user!))
            {
                return StatusCode(403, new ListErrorDto { Code = "forbidden", Message = "You can't manage collections." });
            }

            var name = PlaceholderRules.CleanText(request?.Name);
            if (request == null || name.Length == 0 || name.Length > PlaceholderRules.MaxTitle || !ValidRequestId(request.RequestId)
                || (request.Entries?.Count ?? 0) > MaxEntries)
            {
                return Bad("invalid_body", "A name of 1-200 characters is required.");
            }

            var (entryError, entries) = ParseEntries(request.Entries ?? new List<ApplyEntryDto>(), user!.Id.ToString("N", CultureInfo.InvariantCulture));
            if (entryError != null)
            {
                return entryError;
            }

            return ToResult(await _service.CreateListAsync(user, kind, name, request.IsPublic, entries!, request.RequestId, cancellationToken).ConfigureAwait(false));
        }

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

        private (IActionResult? Error, ListAccess? Access) ResolveList(string listId, bool edit)
        {
            var user = CurrentUser(out var error);
            if (error != null)
            {
                return (error, null);
            }

            if (!Guid.TryParse(listId, out var id) || id == Guid.Empty)
            {
                return (Bad("invalid_list_id", "Invalid list id."), null);
            }

            var access = _access.Resolve(id, user!);
            if (access == null || !access.Permissions.CanView)
            {
                // Same answer for "doesn't exist" and "not yours to see": never confirm a hidden list exists.
                return (NotFound(new ListErrorDto { Code = "not_found", Message = "List not found." }), null);
            }

            if (edit && !access.Permissions.CanEdit)
            {
                return (StatusCode(403, new ListErrorDto { Code = "forbidden", Message = "You can't edit this list." }), null);
            }

            return (null, access);
        }

        private (IActionResult? Error, List<ApplyEntry>? Entries) ParseEntries(IReadOnlyList<ApplyEntryDto> dtos, string userIdN)
        {
            var entries = new List<ApplyEntry>(dtos.Count);
            for (var i = 0; i < dtos.Count; i++)
            {
                var dto = dtos[i];
                switch (dto?.Type)
                {
                    case "item":
                        if (!Guid.TryParse(dto.ItemId, out var itemId) || itemId == Guid.Empty)
                        {
                            return (Bad("invalid_entry", $"Entry {i}: invalid itemId."), null);
                        }

                        entries.Add(new ApplyEntry(i, itemId, null));
                        break;
                    case "placeholder":
                        if (!PlaceholderRules.TryCreate(dto.Placeholder, userIdN, DateTime.UtcNow, out var placeholder, out var reason))
                        {
                            return (Bad("invalid_entry", $"Entry {i}: {reason}."), null);
                        }

                        entries.Add(new ApplyEntry(i, null, placeholder));
                        break;
                    default:
                        return (Bad("invalid_entry", $"Entry {i}: type must be item or placeholder."), null);
                }
            }

            return (null, entries);
        }

        private static bool ValidRequestId(string? requestId) => requestId == null || ListPlaceholderStore.IsValidRequestId(requestId);

        private static bool ValidPosition(PositionDto? position)
        {
            if (position == null)
            {
                return true;
            }

            if (position.AtStart && position.AfterToken != null)
            {
                return false;
            }

            return position.AfterToken == null || ListPlaceholderOrder.IsReal(position.AfterToken) || IsPlaceholderToken(position.AfterToken);
        }

        private static bool IsPlaceholderId(string? id) => id != null && id.Length == 32 && Guid.TryParseExact(id, "N", out _) && id == id.ToLowerInvariant();

        private static bool IsPlaceholderToken(string? token) => IsPlaceholderId(ListPlaceholderOrder.PlaceholderIdOf(token));

        private BadRequestObjectResult Bad(string code, string message) => BadRequest(new ListErrorDto { Code = code, Message = message });

        private IActionResult ToResult(ListOutcome outcome)
        {
            if (outcome.RawJson != null)
            {
                return new ContentResult { StatusCode = outcome.StatusCode, Content = outcome.RawJson, ContentType = "application/json" };
            }

            return new ObjectResult(outcome.Value) { StatusCode = outcome.StatusCode };
        }
    }
}
