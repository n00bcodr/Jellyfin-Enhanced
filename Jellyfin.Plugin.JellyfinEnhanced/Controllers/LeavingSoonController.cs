using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>A deletion request as the page draws it, with the Jellyfin title and person it is about.</summary>
    public sealed record LeavingSoonRequestDto(
        [property: JsonPropertyName("id")] int Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("year")] int? Year,
        [property: JsonPropertyName("mediaType")] string MediaType,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("createdAt")] string? CreatedAt,
        [property: JsonPropertyName("requestedBy")] string? RequestedBy,
        [property: JsonPropertyName("note")] string? Note,
        [property: JsonPropertyName("jellyfinUser")] string? JellyfinUser,
        [property: JsonPropertyName("jellyfinUserId")] string? JellyfinUserId,
        [property: JsonPropertyName("itemId")] string? ItemId,
        [property: JsonPropertyName("posterPath")] string? PosterPath);

    /// <summary>
    /// Backend of the Leaving soon page: what is leaving (the facts of whichever removal tool is on) for the items the
    /// signed-in user can see, soonest first, and for Reclaimerr the deletion requests (every pending one for an
    /// administrator, the caller's own for anyone else), which administrators approve or deny through <c>reclaimerr/requests</c>. Answers
    /// <c>404</c> while the page is off or no removal tool is set up.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced/leaving-soon")]
    public class LeavingSoonController : ControllerBase
    {
        /// <summary>Most items one answer lists.</summary>
        public const int MaxItems = 500;

        private readonly LeavingSoonService _leaving;
        private readonly ReclaimerrActions _reclaimerr;
        private readonly IUserManager _userManager;
        private readonly ILibraryManager _libraryManager;

        public LeavingSoonController(LeavingSoonService leaving, ReclaimerrActions reclaimerr, IUserManager userManager, ILibraryManager libraryManager)
        {
            _leaving = leaving;
            _reclaimerr = reclaimerr;
            _userManager = userManager;
            _libraryManager = libraryManager;
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

        private static bool PageOn(Configuration.PluginConfiguration? config) => config != null && config.LeavingSoonPageEnabled && LeavingSoonService.ApiConfigured(config);

        /// <summary>
        /// What is leaving, soonest first (undated last): <c>{provider, admin, items[], requests[], mine[], canRequest}</c>.
        /// Items the user cannot see are left out.
        /// </summary>
        [HttpGet("list")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public async Task<IActionResult> List(CancellationToken token)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!PageOn(config)) return NotFound();
            var userId = UserHelper.GetCurrentUserId(User);
            var user = userId.HasValue && userId.Value != Guid.Empty ? _userManager.GetUserById(userId.Value) : null;
            if (user == null) return Forbid();

            var items = new List<object>();
            foreach (var (id, deleteAt) in _leaving.MaintainerrItems(config)
                .OrderBy(m => m.DeleteAt ?? long.MaxValue))
            {
                var item = _libraryManager.GetItemById(id);
                if (item == null || !item.IsVisible(user)) continue;
                items.Add(Describe(item, deleteAt));
                if (items.Count >= MaxItems) break;
            }

            var reclaimerr = LeavingSoonService.UsesReclaimerr(config);
            var admin = IsAdmin();
            IReadOnlyList<LeavingSoonRequestDto> requests = Array.Empty<LeavingSoonRequestDto>();
            IReadOnlyList<LeavingSoonRequestDto> mine = Array.Empty<LeavingSoonRequestDto>();
            if (reclaimerr && ReclaimerrActions.Enabled(config))
            {
                // Both lists are read at once under one short budget: a slow Reclaimerr leaves them empty instead of holding the page.
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                budget.CancelAfter(TimeSpan.FromSeconds(8));
                async Task<IReadOnlyList<LeavingSoonRequestDto>> Load(bool pending)
                {
                    try { return await DescribeAsync(await _reclaimerr.RequestsAsync(config!, user.Username, mine: !pending, budget.Token).ConfigureAwait(false), config!, user, budget.Token).ConfigureAwait(false); }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested) { return Array.Empty<LeavingSoonRequestDto>(); }
                }

                var pendingTask = admin ? Load(true) : Task.FromResult<IReadOnlyList<LeavingSoonRequestDto>>(Array.Empty<LeavingSoonRequestDto>());
                var mineTask = Load(false);
                requests = await pendingTask.ConfigureAwait(false);
                mine = await mineTask.ConfigureAwait(false);
            }

            return Ok(new
            {
                provider = reclaimerr ? "reclaimerr" : "maintainerr",
                admin,
                canRequest = reclaimerr && ReclaimerrActions.RequestsEnabled(config),
                actions = admin && (MaintainerrActions.Enabled(config) || ReclaimerrActions.Enabled(config)),
                items,
                requests,
                mine,
            });
        }

        /// <summary>
        /// Requests with the Jellyfin title (matched by TMDB id, only one the viewer can see) and the Jellyfin person: the
        /// request's reason starts "Requested by NAME from Jellyfin" whoever filed it, so the person shows even when
        /// Reclaimerr knows them as <c>NAME_user</c> or the service account.
        /// </summary>
        private async Task<IReadOnlyList<LeavingSoonRequestDto>> DescribeAsync(IReadOnlyList<ReclaimerrRequestRow> rows, Configuration.PluginConfiguration config, Jellyfin.Database.Implementations.Entities.User viewer, CancellationToken token)
        {
            var list = new List<LeavingSoonRequestDto>(rows.Count);
            foreach (var r in rows)
            {
                string? itemId = null;
                var tmdb = await _reclaimerr.TmdbIdAsync(config, r.MediaType, r.MediaId, token).ConfigureAwait(false);
                if (tmdb != null)
                {
                    var query = new InternalItemsQuery(viewer)
                    {
                        IncludeItemTypes = new[] { r.MediaType == "movie" ? Jellyfin.Data.Enums.BaseItemKind.Movie : Jellyfin.Data.Enums.BaseItemKind.Series },
                        HasAnyProviderId = new Dictionary<string, string> { ["Tmdb"] = tmdb },
                        Recursive = true,
                        IsVirtualItem = false,
                        Limit = 5,
                    };
                    var found = _libraryManager.GetItemList(query).FirstOrDefault(i => i.IsVisible(viewer));
                    itemId = found?.Id.ToString("N");
                }

                var (person, note) = ParseReason(r.Reason);
                var jellyfinUser = person != null ? _userManager.GetUserByName(person) : null;
                list.Add(new LeavingSoonRequestDto(r.Id, r.Title, r.Year, r.MediaType, r.Status, r.CreatedAt, r.RequestedBy, note, jellyfinUser?.Username ?? person, jellyfinUser?.Id.ToString("N"), itemId, r.PosterPath));
            }

            return list;
        }

        /// <summary>"Requested by NAME from Jellyfin: note" to (NAME, note); any other reason is all note.</summary>
        internal static (string? Person, string? Note) ParseReason(string? reason)
        {
            if (string.IsNullOrWhiteSpace(reason)) return (null, null);
            const string head = "Requested by ";
            const string tail = " from Jellyfin";
            if (!reason.StartsWith(head, StringComparison.Ordinal)) return (null, reason.Trim());
            var end = reason.IndexOf(tail, head.Length, StringComparison.Ordinal);
            if (end <= head.Length) return (null, reason.Trim());
            var person = reason[head.Length..end].Trim();
            var rest = reason[(end + tail.Length)..].TrimStart(':', ' ').Trim();
            return (person.Length == 0 ? null : person, rest.Length == 0 ? null : rest);
        }

        /// <summary>The page's view of one item.</summary>
        internal static object Describe(BaseItem item, long? deleteAt) => new
        {
            id = item.Id.ToString("N"),
            name = item is Episode episode ? (episode.SeriesName ?? item.Name) : item is Season season ? (season.SeriesName ?? item.Name) : item.Name,
            detail = item is Episode e ? e.Name : item is Season ? item.Name : null,
            type = item.GetBaseItemKind().ToString(),
            year = item.ProductionYear,
            deleteAt,
        };
    }
}
