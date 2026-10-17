using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Requests &amp; downloads lists: playlist and collection entries for titles that aren't in the library. Every route
    /// needs a signed-in person (no API key, no disabled user) and answers 404 <c>{code:"disabled"}</c> while lists are
    /// off (<see cref="ListFlags.Lists"/>). Viewing needs list visibility; editing needs the authoring switch and playlist
    /// ownership / an edit share / admin, or for collections admin / collection management (<see cref="ListAccessRules"/>);
    /// asking needs the request switches and the request policy's own permission. Everything the client sends is
    /// re-validated; bodies are capped before binding (16 KiB, 1 MiB for the routes that carry up to 2000 entries).
    /// Views are private and revalidated (ETag); mutations are private and not stored.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class AcquireListsController : ControllerBase
    {
        /// <summary>Body cap of the routes that carry up to <see cref="ListStore.MaxPlaceholders"/> entries or a long order.</summary>
        public const int LargeBody = 1024 * 1024;

        private const int MaxEntries = ListStore.MaxPlaceholders;
        private const int MaxOrderTokens = 20000;
        private static readonly JsonSerializerOptions FingerprintJson = new() { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

        private readonly IUserManager _userManager;
        private readonly ListAccessService _access;
        private readonly ListService _service;
        private readonly ListAcquisition? _acquisition;
        private readonly ExperimentalListImporter? _importer;
        private readonly ListSummaryService? _summaries;
        private readonly Logger _logger;

        /// <summary>Creates the controller.</summary>
        /// <param name="userManager">User manager.</param>
        /// <param name="access">Access service.</param>
        /// <param name="service">List service.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="acquisition">List requests.</param>
        /// <param name="importer">The experimental-list importer (administrators).</param>
        /// <param name="summaries">Playlists page summaries (phase 4c3a).</param>
        public AcquireListsController(IUserManager userManager, ListAccessService access, ListService service, Logger logger, ListAcquisition? acquisition = null, ExperimentalListImporter? importer = null, ListSummaryService? summaries = null)
        {
            _userManager = userManager;
            _access = access;
            _service = service;
            _logger = logger;
            _acquisition = acquisition;
            _importer = importer;
            _summaries = summaries;
        }

        private static Configuration.PluginConfiguration? Config => JellyfinEnhanced.Instance?.Configuration;

        /// <summary>The caller's view of a list (entries, projected order, actions, request status).</summary>
        /// <param name="listId">Playlist or collection id.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>.</returns>
        [HttpGet("acquire/lists/{listId}")]
        [Authorize]
        public Task<IActionResult> GetList([FromRoute] string listId, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var (error, access) = ResolveList(listId, edit: false);
                if (error != null)
                {
                    return error;
                }

                // Rights read again once the statuses are in (they can take a while): never a list the caller lost meanwhile.
                var view = await _service.ViewAsync(access!, cancellationToken).ConfigureAwait(false);
                return view == null ? Refused(404, "not_found", "List not found.") : Revalidated(access!.User, view);
            });

        /// <summary>Adds entries (titles already in the library go in as real items).</summary>
        /// <param name="listId">List id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ApplyResultDto"/>.</returns>
        [HttpPost("acquire/lists/{listId}/items")]
        [Authorize]
        [BodyLimit(LargeBody)]
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
                    return Bad("invalid_body", $"Send 1-{MaxEntries} entries.");
                }

                if (!ValidRequestId(request.RequestId) || !ValidPosition(request.Position))
                {
                    return Bad("invalid_body", "Invalid requestId or position.");
                }

                var placeholders = new List<Placeholder>(request.Placeholders.Count);
                for (var i = 0; i < request.Placeholders.Count; i++)
                {
                    if (!ListRules.TryCreate(request.Placeholders[i], access!.UserIdN, DateTime.UtcNow, out var placeholder, out var reason))
                    {
                        return Bad("invalid_entry", $"Entry {i}: {reason}.");
                    }

                    placeholders.Add(placeholder);
                }

                return ToResult(await _service.AddPlaceholdersAsync(access!, placeholders, request.Position, request.Rev, Key("add", listId, request.RequestId, request), cancellationToken, recheckAccess: true).ConfigureAwait(false));
            });

        /// <summary>Applies ordered entries (real items and placeholders) at a position.</summary>
        /// <param name="listId">List id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ApplyResultDto"/>.</returns>
        [HttpPost("acquire/lists/{listId}/apply")]
        [Authorize]
        [BodyLimit(LargeBody)]
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

                return ToResult(await _service.ApplyAsync(access, entries!, request.Position, request.Rev, Key("apply", listId, request.RequestId, request), cancellationToken, recheckAccess: true).ConfigureAwait(false));
            });

        /// <summary>Edits an entry: note, or link a custom entry to a title.</summary>
        /// <param name="listId">List id.</param>
        /// <param name="placeholderId">Entry id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>.</returns>
        [HttpPatch("acquire/lists/{listId}/items/{placeholderId}")]
        [Authorize]
        [BodyLimit]
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
                    return Bad("invalid_body", "An entry id, rev and a valid requestId are required.");
                }

                string? note = null;
                if (request.Note != null)
                {
                    note = ListRules.CleanText(request.Note);
                    if (note.Length > ListRules.MaxNote)
                    {
                        return Bad("invalid_body", "Note must be at most 300 characters.");
                    }
                }

                Placeholder? link = null;
                if (request.Link != null && !ListRules.TryNormalize(request.Link, allowCustom: false, out link, out var reason))
                {
                    return Bad("invalid_entry", $"Link: {reason}.");
                }

                if (note == null && link == null)
                {
                    return Bad("invalid_body", "Nothing to change.");
                }

                return ToResult(await _service.PatchAsync(access!, placeholderId, request.Rev.Value, note, link, Key("patch", listId + "/" + placeholderId, request.RequestId, request), cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Removes an entry.</summary>
        /// <param name="listId">List id.</param>
        /// <param name="placeholderId">Entry id.</param>
        /// <param name="rev">Expected revision.</param>
        /// <param name="requestId">Client request id.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>.</returns>
        [HttpDelete("acquire/lists/{listId}/items/{placeholderId}")]
        [Authorize]
        [BodyLimit]
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
                    return Bad("invalid_body", "An entry id, rev and a valid requestId are required.");
                }

                return ToResult(await _service.DeleteAsync(access!, placeholderId, rev.Value, Key("delete", listId + "/" + placeholderId, requestId, rev.Value), cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Saves the order after a drag (playlists only); a moved real row is moved in Jellyfin by the server.</summary>
        /// <param name="listId">Playlist id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>, or 409 with the fresh view.</returns>
        [HttpPut("acquire/lists/{listId}/order")]
        [Authorize]
        [BodyLimit(LargeBody)]
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
                    || request.Order.Any(t => !(ListOrder.IsReal(t) || IsPlaceholderToken(t)))
                    || (request.Moved != null && !ListOrder.IsReal(request.Moved)))
                {
                    return Bad("invalid_body", "rev, a valid token order and requestId are required.");
                }

                return ToResult(await _service.ReorderAsync(access, request.Rev.Value, request.Order, request.Moved, Key("order", listId, request.RequestId, request), cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Turns automatic swap-in on or off for a list (the caller's consent; their own swap-in setting must agree too).</summary>
        /// <param name="listId">List id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListViewDto"/>.</returns>
        [HttpPut("acquire/lists/{listId}/swap-in")]
        [Authorize]
        [BodyLimit]
        public Task<IActionResult> PutSwapIn([FromRoute] string listId, [FromBody] SwapInRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                if (!ListFlags.SwapIn(Config))
                {
                    return Refused(403, "swap_in_disabled", "Automatic swap-in is off.");
                }

                var (error, access) = ResolveList(listId, edit: true, authoring: false);
                if (error != null)
                {
                    return error;
                }

                if (request?.Rev == null || !ValidRequestId(request.RequestId))
                {
                    return Bad("invalid_body", "rev and a valid requestId are required.");
                }

                return ToResult(await _service.SetSwapInAsync(access!, request.Rev.Value, request.Enabled, Key("swap_in", listId, request.RequestId, request), cancellationToken).ConfigureAwait(false));
            });

        /// <summary>What asking for entries would do (nothing is written).</summary>
        /// <param name="listId">List id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListRequestPreviewDto"/>.</returns>
        [HttpPost("acquire/lists/{listId}/requests/preview")]
        [Authorize]
        [BodyLimit]
        public Task<IActionResult> PreviewRequests([FromRoute] string listId, [FromBody] ListRequestPreviewRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var multiple = request?.All == true || (request?.PlaceholderIds?.Count ?? 0) > 1;
                if (RequestsRefusal(multiple) is { } refused)
                {
                    return refused;
                }

                var (error, access) = ResolveList(listId, edit: false);
                if (error != null)
                {
                    return error;
                }

                if (request == null || (request.PlaceholderIds?.Any(id => !IsPlaceholderId(id)) ?? false))
                {
                    return Bad("invalid_body", "Invalid entries.");
                }

                return ToResult(await _acquisition!.PreviewAsync(access!, request.PlaceholderIds, request.All, cancellationToken).ConfigureAwait(false));
            });

        /// <summary>Asks for at most 20 entries (one confirmation).</summary>
        /// <param name="listId">List id.</param>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListRequestSubmitDto"/>.</returns>
        [HttpPost("acquire/lists/{listId}/requests")]
        [Authorize]
        [BodyLimit]
        public Task<IActionResult> SubmitRequests([FromRoute] string listId, [FromBody] ListRequestSubmitRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                if (RequestsRefusal((request?.PlaceholderIds?.Count ?? 0) > 1) is { } refused)
                {
                    return refused;
                }

                var (error, access) = ResolveList(listId, edit: false);
                if (error != null)
                {
                    return error;
                }

                if (request?.PlaceholderIds == null || request.PlaceholderIds.Any(id => !IsPlaceholderId(id))
                    || string.IsNullOrEmpty(request.ClientId) || !ListStore.IsValidRequestId(request.ClientId))
                {
                    return Bad("invalid_body", "A clientId and 1-20 entries are required.");
                }

                var outcome = await _acquisition!.SubmitAsync(access!, request.ClientId, request.PlaceholderIds, cancellationToken).ConfigureAwait(false);
                if (outcome.Value is ListRequestSubmitDto submitted)
                {
                    submitted.View = await _service.ViewAsync(access!, cancellationToken).ConfigureAwait(false);
                }

                return ToResult(outcome);
            });

        /// <summary>Lists the caller can add to (playlists they can edit; collections for admins / collection managers).</summary>
        /// <returns><see cref="EditableListsDto"/>.</returns>
        [HttpGet("acquire/lists/editable")]
        [Authorize]
        public Task<IActionResult> GetEditableLists() =>
            Guarded(() =>
            {
                if (!ListFlags.Authoring(Config))
                {
                    return Task.FromResult(Refused(403, "authoring_disabled", "Editing lists is off."));
                }

                var user = CurrentUser(out var error);
                return Task.FromResult(error ?? Private(Ok(_service.GetEditableLists(user!))));
            });

        /// <summary>Creates a playlist owned by the caller, optionally with initial entries.</summary>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="CreateListResultDto"/>.</returns>
        [HttpPost("acquire/lists/playlists")]
        [Authorize]
        [BodyLimit(LargeBody)]
        public Task<IActionResult> CreatePlaylist([FromBody] CreateListRequest request, CancellationToken cancellationToken) =>
            Guarded(() => CreateList(ListKinds.Playlist, request, cancellationToken));

        /// <summary>Creates a collection (admins and collection managers), optionally with initial entries.</summary>
        /// <param name="request">Body.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="CreateListResultDto"/>.</returns>
        [HttpPost("acquire/lists/collections")]
        [Authorize]
        [BodyLimit(LargeBody)]
        public Task<IActionResult> CreateCollection([FromBody] CreateListRequest request, CancellationToken cancellationToken) =>
            Guarded(() => CreateList(ListKinds.Collection, request, cancellationToken));

        // ---- Phase 4c3a: list pages ----

        /// <summary>
        /// Which of the lists on screen (the Playlists page) have entries the caller can see that aren't in the library,
        /// and how many: such a list is shown as incomplete rather than with Jellyfin's "played" check. Lists the caller
        /// can't see, or with no entry they can see, are left out. Nothing is answered while the caller's playlist and
        /// collection pages are both off (the administrator's switches, then their own preferences).
        /// </summary>
        /// <param name="request">Body: the list ids (at most <see cref="ListSummaryService.MaxIds"/>).</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns><see cref="ListSummariesDto"/>.</returns>
        [HttpPost("acquire/lists/summaries")]
        [Authorize]
        [BodyLimit]
        public Task<IActionResult> Summaries([FromBody] ListSummariesRequest request, CancellationToken cancellationToken) =>
            Guarded(async () =>
            {
                var user = CurrentUser(out var error);
                if (error != null)
                {
                    return error;
                }

                if (_summaries == null)
                {
                    return Refused(404, "disabled", "Lists are off.");
                }

                var ids = new List<Guid>();
                if (request?.ListIds == null || request.ListIds.Count == 0 || request.ListIds.Count > ListSummaryService.MaxIds)
                {
                    return Bad("invalid_body", $"Send 1-{ListSummaryService.MaxIds} list ids.");
                }

                foreach (var raw in request.ListIds)
                {
                    if (!Guid.TryParse(raw, out var id) || id == Guid.Empty)
                    {
                        return Bad("invalid_list_id", "Invalid list id.");
                    }

                    ids.Add(id);
                }

                return Private(Ok(await _summaries.SummariesAsync(user!, ids, cancellationToken).ConfigureAwait(false)));
            });

        // ---- end Phase 4c3a ----

        /// <summary>
        /// Administrators: dry run of the experimental-list importer (closed PR #936's schema-1 lists): what would be
        /// imported, quarantined or skipped. Reads only; never changes the originals or any list.
        /// </summary>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns>The report.</returns>
        [HttpGet("arr/admin/lists/import")]
        [Authorize]
        [PrivateResponse]
        public Task<IActionResult> ImportDryRun(CancellationToken cancellationToken) => Admin(async () =>
            Private(Ok(await _importer!.RunAsync(apply: false, cancellationToken).ConfigureAwait(false))));

        /// <summary>
        /// Administrators: runs the experimental-list importer. The originals are read, never changed; imported lists keep
        /// swap-in and every consent off and wait for reconciliation before anything new is inserted.
        /// </summary>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns>The report.</returns>
        [HttpPost("arr/admin/lists/import")]
        [Authorize]
        [PrivateResponse]
        [BodyLimit]
        public Task<IActionResult> ImportApply(CancellationToken cancellationToken) => Admin(async () =>
            Private(Ok(await _importer!.RunAsync(apply: true, cancellationToken).ConfigureAwait(false))));

        private async Task<IActionResult> CreateList(string kind, CreateListRequest request, CancellationToken cancellationToken)
        {
            if (!ListFlags.Authoring(Config))
            {
                return Refused(403, "authoring_disabled", "Editing lists is off.");
            }

            var user = CurrentUser(out var error);
            if (error != null)
            {
                return error;
            }

            if (kind == ListKinds.Collection && !ListAccessService.CanManageCollections(user!))
            {
                return Refused(403, "forbidden", "You can't manage collections.");
            }

            var name = ListRules.CleanText(request?.Name);
            if (request == null || name.Length == 0 || name.Length > ListRules.MaxTitle || !ValidRequestId(request.RequestId)
                || (request.Entries?.Count ?? 0) > MaxEntries)
            {
                return Bad("invalid_body", "A name of 1-200 characters is required.");
            }

            var (entryError, entries) = ParseEntries(request.Entries ?? new List<ApplyEntryDto>(), user!.Id.ToString("N", CultureInfo.InvariantCulture));
            if (entryError != null)
            {
                return entryError;
            }

            return ToResult(await _service.CreateListAsync(user, kind, name, request.IsPublic, entries!, Key("create", kind, request.RequestId, request), cancellationToken).ConfigureAwait(false));
        }

        // ── Helpers ──────────────────────────────────────────────────────────

        private async Task<IActionResult> Guarded(Func<Task<IActionResult>> action)
        {
            // A person first (API keys, unknown and disabled users: 403 user_required), then the switches.
            if (ArrCaller.Human(User, _userManager) == null)
            {
                return Refused(403, "user_required", "Sign in as a person to use lists.");
            }

            if (!ListFlags.Lists(Config))
            {
                return Private(NotFound(new ListErrorDto { Code = "disabled", Message = "Lists are off." }));
            }

            try
            {
                return await action().ConfigureAwait(false);
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

        private async Task<IActionResult> Admin(Func<Task<IActionResult>> action)
        {
            var user = ArrCaller.Human(User, _userManager);
            if (user == null || !ListAccessService.IsAdmin(user))
            {
                return Refused(403, "admin_required", "Administrators only.");
            }

            if (_importer == null || !ListFlags.Lists(Config))
            {
                return Refused(404, "disabled", "Lists are off.");
            }

            try
            {
                return await action().ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (HttpContext?.RequestAborted.IsCancellationRequested == true)
            {
                return StatusCode(499);
            }
        }

        // Request routes: the list request switches (Request all missing for more than one entry).
        private IActionResult? RequestsRefusal(bool multiple)
        {
            if (_acquisition == null || !ListFlags.Requests(Config))
            {
                return Refused(403, "requests_disabled", "Asking from lists is off.");
            }

            return multiple && !ListFlags.RequestAll(Config) ? Refused(403, "request_all_disabled", "Request all missing is off.") : null;
        }

        private User? CurrentUser(out IActionResult? error)
        {
            error = null;
            // A person only: API keys, unknown and disabled users never act on lists.
            var user = ArrCaller.Human(User, _userManager);
            if (user == null)
            {
                error = Refused(403, "user_required", "Sign in as a person to use lists.");
            }

            return user;
        }

        private (IActionResult? Error, ListAccess? Access) ResolveList(string listId, bool edit, bool authoring = true)
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

            if (edit && authoring && !ListFlags.Authoring(Config))
            {
                return (Refused(403, "authoring_disabled", "Editing lists is off."), null);
            }

            var access = _access.Resolve(id, user!);
            if (access == null || !access.Permissions.CanView)
            {
                // Same answer for "doesn't exist" and "not yours to see": never confirm a hidden list exists.
                return (Refused(404, "not_found", "List not found."), null);
            }

            if (edit && !access.Permissions.CanEdit)
            {
                return (Refused(403, "forbidden", "You can't edit this list."), null);
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
                        if (!ListRules.TryCreate(dto.Placeholder, userIdN, DateTime.UtcNow, out var placeholder, out var reason))
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

        // The durable key of a mutation: the client's request id and a digest of exactly what this request asks for.
        private static ListRequestKey? Key(string kind, string scope, string? requestId, object body)
        {
            if (requestId == null)
            {
                return null;
            }

            var json = JsonSerializer.Serialize(body, body.GetType(), FingerprintJson);
            var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(kind + "|" + scope + "|" + json)));
            return new ListRequestKey(requestId, digest);
        }

        private static bool ValidRequestId(string? requestId) => requestId == null || ListStore.IsValidRequestId(requestId);

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

            return position.AfterToken == null || ListOrder.IsReal(position.AfterToken) || IsPlaceholderToken(position.AfterToken);
        }

        private static bool IsPlaceholderId(string? id) => id != null && id.Length == 32 && Guid.TryParseExact(id, "N", out _) && id == id.ToLowerInvariant();

        private static bool IsPlaceholderToken(string? token) => IsPlaceholderId(ListOrder.PlaceholderIdOf(token));

        private IActionResult Bad(string code, string message) => Refused(400, code, message);

        private IActionResult Refused(int status, string code, string message) =>
            Private(new ObjectResult(new ListErrorDto { Code = code, Message = message }) { StatusCode = status });

        private IActionResult Private(IActionResult result)
        {
            Response.Headers["Cache-Control"] = PrivateResponseAttribute.CacheControl;
            return result;
        }

        // A view for one person: private, revalidated with an ETag bound to the person and the body.
        private IActionResult Revalidated(User user, ListViewDto view)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(view, FingerprintJson);
            var etag = "\"" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(user.Id.ToString("N", CultureInfo.InvariantCulture) + "|").Concat(bytes).ToArray()), 0, 16) + "\"";
            Response.Headers["Cache-Control"] = "private, no-cache";
            Response.Headers["ETag"] = etag;
            if (Services.TmdbResponseCache.IfNoneMatchMatches(Request.Headers["If-None-Match"], etag))
            {
                return StatusCode(304);
            }

            return File(bytes, "application/json; charset=utf-8");
        }

        private IActionResult ToResult(ListOutcome outcome)
        {
            Response.Headers["Cache-Control"] = PrivateResponseAttribute.CacheControl;
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
