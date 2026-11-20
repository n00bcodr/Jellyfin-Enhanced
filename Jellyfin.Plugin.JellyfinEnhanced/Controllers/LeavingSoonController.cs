using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
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
        [property: JsonPropertyName("posterPath")] string? PosterPath,
        [property: JsonPropertyName("scope")] string Scope,
        [property: JsonPropertyName("seasonNumber")] int? SeasonNumber,
        [property: JsonPropertyName("episodeNumber")] int? EpisodeNumber,
        [property: JsonPropertyName("versionResolution")] string? VersionResolution,
        [property: JsonPropertyName("versionSize")] long? VersionSize,
        [property: JsonPropertyName("adminNotes")] string? AdminNotes,
        [property: JsonPropertyName("executionError")] string? ExecutionError,
        [property: JsonPropertyName("deferred")] bool Deferred,
        [property: JsonPropertyName("scheduledAt")] string? ScheduledAt,
        [property: JsonPropertyName("scheduleState")] string? ScheduleState);

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
        private readonly IDtoService _dtoService;

        public LeavingSoonController(LeavingSoonService leaving, ReclaimerrActions reclaimerr, IUserManager userManager, ILibraryManager libraryManager, IDtoService dtoService)
        {
            _dtoService = dtoService;
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
        /// The leaving titles as a standard Jellyfin item list (<c>{Items, TotalRecordCount}</c>, soonest removal first,
        /// movies and series the user can see). Meant for other home screen plugins such as KefinTweaks, whose custom
        /// sections read any path that answers like <c>/Items</c>. Does not need the Home row or Page switches.
        /// </summary>
        [HttpGet("items")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public ActionResult<QueryResult<BaseItemDto>> Items([FromQuery] int? limit)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !LeavingSoonService.ApiConfigured(config)) return NotFound();
            var userId = UserHelper.GetCurrentUserId(User);
            var user = userId.HasValue && userId.Value != Guid.Empty ? _userManager.GetUserById(userId.Value) : null;
            if (user == null) return Forbid();

            var items = LeavingSoonSectionResults.Order(_leaving.MaintainerrItems(config), id => _libraryManager.GetItemById(id), item => item.IsVisibleStandalone(user));
            if (limit is > 0) items = items.Take(limit.Value).ToList();
            var dtos = _dtoService.GetBaseItemDtos(items, new DtoOptions(), user);
            return new QueryResult<BaseItemDto>(dtos);
        }

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
                // Standalone: the library the item is in must be one the user may open, not only its rating (as the item list route does).
                var item = _libraryManager.GetItemById(id);
                if (item == null || !item.IsVisibleStandalone(user)) continue;
                var versionOnly = _leaving.IsVersionOnly(id, config);
                // What leaving frees: the removal tool's own figure (Reclaimerr's, which alone knows which copy goes), else the library's.
                var size = _leaving.SizeOf(id, config);
                items.Add(Describe(item, deleteAt, versionOnly, versionOnly ? size : size ?? SizeOf(item)));
                if (items.Count >= MaxItems) break;
            }

            var reclaimerr = LeavingSoonService.UsesReclaimerr(config);
            var admin = IsAdmin();
            IReadOnlyList<LeavingSoonRequestDto> requests = Array.Empty<LeavingSoonRequestDto>();
            IReadOnlyList<LeavingSoonRequestDto> mine = Array.Empty<LeavingSoonRequestDto>();
            var requestsUnavailable = false;
            string? requestsError = null;
            int? graceDays = null;
            if (reclaimerr && ReclaimerrActions.Enabled(config))
            {
                // Both lists are read at once under one short budget: a slow Reclaimerr leaves them short instead of holding the page,
                // and the page is told so it can say the requests could not be read (rather than showing none).
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                budget.CancelAfter(TimeSpan.FromSeconds(8));
                async Task<IReadOnlyList<LeavingSoonRequestDto>> Load(bool pending)
                {
                    try
                    {
                        var (rows, error) = await _reclaimerr.RequestsAsync(config!, user.Id, mine: !pending, budget.Token).ConfigureAwait(false);
                        if (rows == null) { requestsUnavailable = true; requestsError ??= error; return Array.Empty<LeavingSoonRequestDto>(); }
                        return Describe(rows, user);
                    }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested) { requestsUnavailable = true; requestsError ??= "Reclaimerr did not answer in time"; return Array.Empty<LeavingSoonRequestDto>(); }
                }

                // The delay an approval gets when no day is named, so the page can say what "Reclaimerr's grace period" means
                // (only asked of administrators, who are the ones who approve). Read alongside the lists, never ahead of them.
                async Task<int?> Grace()
                {
                    try { return await _reclaimerr.GracePeriodDaysAsync(config!, budget.Token).ConfigureAwait(false); }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested) { return null; }
                }

                var graceTask = admin ? Grace() : Task.FromResult<int?>(null);
                var pendingTask = admin ? Load(true) : Task.FromResult<IReadOnlyList<LeavingSoonRequestDto>>(Array.Empty<LeavingSoonRequestDto>());
                var mineTask = Load(false);
                requests = await pendingTask.ConfigureAwait(false);
                mine = await mineTask.ConfigureAwait(false);
                graceDays = await graceTask.ConfigureAwait(false);
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
                requestsUnavailable,
                // Why, for administrators (Reclaimerr's own reason, such as a scope the token lacks); others only learn that they could not be read.
                requestsError = admin ? requestsError : null,
                graceDays,
                // Which Reclaimerr the requests came from: a review sends it back, so a card read from one is never approved at another.
                source = reclaimerr ? ReclaimerrApi.SourceId(config!) : null,
            });
        }

        /// <summary>
        /// Requests with the Jellyfin title and person they are about, both by the ids Reclaimerr gives: the first item it names that the
        /// viewer can open (its library included; none: the card neither links nor shows the item's own poster), and the Jellyfin user the
        /// requester's Reclaimerr account is linked to (none: the card shows the Reclaimerr name).
        /// </summary>
        private IReadOnlyList<LeavingSoonRequestDto> Describe(IReadOnlyList<ReclaimerrRequestRow> rows, Jellyfin.Database.Implementations.Entities.User viewer)
        {
            var list = new List<LeavingSoonRequestDto>(rows.Count);
            foreach (var r in rows)
            {
                var itemId = (r.ItemIds ?? Array.Empty<Guid>()).Select(id => _libraryManager.GetItemById(id)).FirstOrDefault(i => i != null && i.IsVisibleStandalone(viewer))?.Id.ToString("N");
                var person = (r.RequesterIds ?? Array.Empty<Guid>()).Select(id => _userManager.GetUserById(id)).FirstOrDefault(u => u != null);
                list.Add(new LeavingSoonRequestDto(r.Id, r.Title, r.Year, r.MediaType, r.Status, r.CreatedAt, r.RequestedBy, string.IsNullOrWhiteSpace(r.Reason) ? null : r.Reason.Trim(), person?.Username, person?.Id.ToString("N"), itemId, r.PosterPath,
                    r.Scope, r.SeasonNumber, r.EpisodeNumber, r.VersionResolution, r.VersionSize, r.AdminNotes, r.ExecutionError, r.Deferred, r.ScheduledAt, r.ScheduleState));
            }

            return list;
        }

        /// <summary>
        /// What leaving frees, from the library's own file sizes: a movie's file, or all of a series' episode files. Null when no size
        /// is known. Used when the removal tool gives none (Maintainerr never does).
        /// </summary>
        private long? SizeOf(BaseItem item)
        {
            try
            {
                long total = 0;
                if (item is Series series)
                {
                    var episodes = _libraryManager.GetItemList(new InternalItemsQuery
                    {
                        AncestorIds = new[] { series.Id },
                        IncludeItemTypes = new[] { Jellyfin.Data.Enums.BaseItemKind.Episode },
                        Recursive = true,
                        IsVirtualItem = false,
                    });
                    foreach (var episode in episodes) total += (episode as MediaBrowser.Controller.Entities.Video)?.Size ?? 0;
                }
                else if (item is MediaBrowser.Controller.Entities.Video video) total = video.Size ?? 0;
                return total > 0 ? total : null;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>The page's view of one item.</summary>
        internal static object Describe(BaseItem item, long? deleteAt, bool versionOnly = false, long? size = null) => new
        {
            id = item.Id.ToString("N"),
            name = item is Episode episode ? (episode.SeriesName ?? item.Name) : item is Season season ? (season.SeriesName ?? item.Name) : item.Name,
            detail = item is Episode e ? e.Name : item is Season ? item.Name : null,
            type = item.GetBaseItemKind().ToString(),
            year = item.ProductionYear,
            deleteAt,
            versionOnly,
            size,
        };
    }
}
