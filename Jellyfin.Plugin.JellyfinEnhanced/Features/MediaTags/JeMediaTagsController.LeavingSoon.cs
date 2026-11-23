using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags
{
    // Backend of the Leaving soon page (upstream da0ea773's LeavingSoonController, here as a partial of the feature's
    // one controller): what is leaving (the facts of whichever removal tool is on) for the items the signed-in user can
    // see, soonest first, and for Reclaimerr the deletion requests (every pending one for an administrator, the
    // caller's own for anyone else), which administrators approve or deny through reclaimerr/requests. Answers 404
    // while the page is off or no removal tool can be read.
    public partial class JeMediaTagsController
    {
        /// <summary>Most items one Leaving soon answer lists.</summary>
        public const int LeavingSoonMaxItems = 500;

        /// <summary>
        /// What is leaving, soonest first (undated last): <c>{provider, admin, canRequest, actions, items[], requests[], mine[],
        /// requestsUnavailable, requestsError, graceDays, source}</c>. Items the user cannot open (their library included) are left
        /// out; each says what leaving frees (<c>size</c>). <c>graceDays</c> is the delay Reclaimerr gives an approval that names no
        /// day (administrators; null when unknown), <c>requestsError</c> why the requests could not be read and <c>source</c> which
        /// Reclaimerr they came from (both administrators only; upstream da3d9ee9).
        /// </summary>
        /// <param name="leaving">The Leaving soon facts.</param>
        /// <param name="reclaimerr">The Reclaimerr actions (deletion requests).</param>
        /// <param name="token">The request's cancellation.</param>
        /// <returns>The page's list.</returns>
        [HttpGet("leaving-soon/list")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public async Task<IActionResult> GetLeavingSoonList([FromServices] LeavingSoonService leaving, [FromServices] ReclaimerrActions reclaimerr, CancellationToken token)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !config.LeavingSoonPageEnabled || !LeavingSoonSources.ApiConfigured(config)) return NotFound();
            var user = CallerUser();
            if (user == null) return Forbid();

            var items = new List<object>();
            foreach (var (id, deleteAt) in leaving.MaintainerrItems(config).OrderBy(m => m.DeleteAt ?? long.MaxValue))
            {
                // Standalone: the library the item is in must be one the user may open, not only its rating (as the item list route does).
                var item = _libraryManager.GetItemById(id);
                if (item == null || !item.IsVisibleStandalone(user)) continue;
                var versionOnly = leaving.IsVersionOnly(id, config);
                // What leaving frees: the removal tool's own figure (Reclaimerr's, which alone knows which copy goes), else the library's.
                var size = leaving.SizeOf(id, config);
                items.Add(DescribeLeaving(item, deleteAt, versionOnly, versionOnly ? size : size ?? SizeOf(item)));
                if (items.Count >= LeavingSoonMaxItems) break;
            }

            var usesReclaimerr = LeavingSoonSources.UsesReclaimerr(config);
            var admin = IsAdminUser();
            IReadOnlyList<LeavingSoonRequestDto> requests = Array.Empty<LeavingSoonRequestDto>();
            IReadOnlyList<LeavingSoonRequestDto> mine = Array.Empty<LeavingSoonRequestDto>();
            var requestsUnavailable = false;
            string? requestsError = null;
            int? graceDays = null;
            if (usesReclaimerr && ReclaimerrActions.Enabled(config))
            {
                // Both lists and the grace period are read at once under one short budget: a slow Reclaimerr leaves them short instead
                // of holding the page, and the page is told so it can say the requests could not be read (rather than showing none),
                // and an administrator why (Reclaimerr's own reason, such as a scope the token lacks).
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                budget.CancelAfter(reclaimerr.ListBudget);
                async Task<IReadOnlyList<LeavingSoonRequestDto>> Load(bool pending)
                {
                    try
                    {
                        var (rows, error) = await reclaimerr.RequestsAsync(config, user.Id, mine: !pending, budget.Token).ConfigureAwait(false);
                        if (rows == null) { requestsUnavailable = true; requestsError ??= error; return Array.Empty<LeavingSoonRequestDto>(); }
                        return DescribeRequests(rows, user);
                    }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested) { requestsUnavailable = true; requestsError ??= "Reclaimerr did not answer in time"; return Array.Empty<LeavingSoonRequestDto>(); }
                }

                // The delay an approval gets when no day is named, so the page can say what "Reclaimerr's grace period" means (only
                // asked for administrators, who are the ones who approve). Read alongside the lists, never ahead of them.
                async Task<int?> Grace()
                {
                    try { return await reclaimerr.GracePeriodDaysAsync(config, budget.Token).ConfigureAwait(false); }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested) { return null; }
                }

                var graceTask = admin ? Grace() : Task.FromResult<int?>(null);
                var pendingTask = admin ? Load(true) : Task.FromResult<IReadOnlyList<LeavingSoonRequestDto>>(Array.Empty<LeavingSoonRequestDto>());
                // A user's own requests go with Request removal: while requests are off there is no list of them to read.
                var mineTask = ReclaimerrActions.RequestsEnabled(config) ? Load(false) : Task.FromResult<IReadOnlyList<LeavingSoonRequestDto>>(Array.Empty<LeavingSoonRequestDto>());
                requests = await pendingTask.ConfigureAwait(false);
                mine = await mineTask.ConfigureAwait(false);
                graceDays = await graceTask.ConfigureAwait(false);
            }

            return Ok(new
            {
                provider = usesReclaimerr ? "reclaimerr" : "maintainerr",
                admin,
                canRequest = usesReclaimerr && ReclaimerrActions.RequestsEnabled(config),
                actions = admin && (MaintainerrActions.Enabled(config) || ReclaimerrActions.Enabled(config)),
                items,
                requests,
                mine,
                requestsUnavailable,
                // Why, for administrators (Reclaimerr's own reason, such as a scope the token lacks); others only learn that they could not be read.
                requestsError = admin ? requestsError : null,
                graceDays,
                // Which Reclaimerr the requests came from: a review sends it back, so a card read from one is never approved at another.
                // Administrators only (they are the ones who review): it is a digest of the address, which nobody else needs.
                source = usesReclaimerr && admin ? ReclaimerrApi.SourceId(config) : null,
            });
        }

        /// <summary>
        /// The leaving titles as a standard Jellyfin item list (<c>{Items, TotalRecordCount}</c>), for other home screen
        /// plugins such as KefinTweaks, whose custom sections read any path that answers like <c>/Items</c> (upstream
        /// 6c922d10): the home row's items (movies and series the user can see, a leaving season or episode as its
        /// series, soonest removal first, at most <see cref="LeavingSoonHomeSection.Limit"/>), cut to
        /// <paramref name="limit"/> when one is given. Needs neither the home row nor the page switch, only a removal
        /// tool with an address; 404 without one.
        /// </summary>
        /// <param name="leaving">The Leaving soon facts.</param>
        /// <param name="dtoService">Jellyfin's item DTOs.</param>
        /// <param name="limit">The most items to list (none or not positive: the row's limit).</param>
        /// <returns>The item list.</returns>
        [HttpGet("leaving-soon/items")]
        [Authorize]
        [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
        [Produces("application/json")]
        public ActionResult<QueryResult<BaseItemDto>> GetLeavingSoonItems([FromServices] LeavingSoonService leaving, [FromServices] IDtoService dtoService, [FromQuery] int? limit)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || !LeavingSoonSources.ApiConfigured(config)) return NotFound();
            var user = CallerUser();
            if (user == null) return Forbid();

            var items = LeavingSoonSectionResults.Order(leaving.MaintainerrItems(config), id => _libraryManager.GetItemById(id), item => item.IsVisibleStandalone(user));
            if (limit is > 0) items = items.Take(limit.Value).ToList();
            return new QueryResult<BaseItemDto>(dtoService.GetBaseItemDtos(items, new DtoOptions(), user));
        }

        /// <summary>
        /// Requests with the Jellyfin title and person they are about, both by the ids Reclaimerr gives (upstream da3d9ee9): the first
        /// item it names that the viewer can open (its library included; none: the card neither links nor shows the item's own poster),
        /// and the Jellyfin user the requester's Reclaimerr account is linked to (none: the card shows the Reclaimerr name).
        /// </summary>
        private IReadOnlyList<LeavingSoonRequestDto> DescribeRequests(IReadOnlyList<ReclaimerrRequestRow> rows, JUser viewer)
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
        /// What leaving frees, from the library's own file sizes: a movie's file, or all of a series' episode files. Null when no
        /// size is known. Used when the removal tool gives none (Maintainerr never does).
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
                    foreach (var episode in episodes) total += (episode as Video)?.Size ?? 0;
                }
                else if (item is Video video) total = video.Size ?? 0;
                return total > 0 ? total : null;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>The page's view of one item.</summary>
        internal static object DescribeLeaving(BaseItem item, long? deleteAt, bool versionOnly = false, long? size = null) => new
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
