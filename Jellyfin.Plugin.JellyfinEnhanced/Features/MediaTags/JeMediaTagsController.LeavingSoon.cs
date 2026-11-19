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
        /// requestsUnavailable}</c>. Items the user cannot see are left out; each says what leaving frees (<c>size</c>).
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
                var item = _libraryManager.GetItemById(id);
                if (item == null || !item.IsVisible(user)) continue;
                var versionOnly = leaving.IsVersionOnly(id, config);
                items.Add(DescribeLeaving(item, deleteAt, versionOnly, versionOnly ? await VersionSizeAsync(leaving, reclaimerr, item, config, token).ConfigureAwait(false) : SizeOf(item)));
                if (items.Count >= LeavingSoonMaxItems) break;
            }

            var usesReclaimerr = LeavingSoonSources.UsesReclaimerr(config);
            var admin = IsAdminUser();
            IReadOnlyList<LeavingSoonRequestDto> requests = Array.Empty<LeavingSoonRequestDto>();
            IReadOnlyList<LeavingSoonRequestDto> mine = Array.Empty<LeavingSoonRequestDto>();
            var requestsUnavailable = false;
            if (usesReclaimerr && ReclaimerrActions.Enabled(config))
            {
                // Both lists are read at once under one short budget: a slow Reclaimerr leaves them short instead of holding the
                // page, and the page is told so it can say the requests could not be read (rather than showing none). Rows that
                // were read stay when only their title lookups run out of it (upstream 40738412 lost them with the lookups).
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                budget.CancelAfter(reclaimerr.ListBudget);
                async Task<IReadOnlyList<LeavingSoonRequestDto>> Load(bool pending)
                {
                    IReadOnlyList<ReclaimerrRequestRow> rows;
                    try { rows = await reclaimerr.RequestsAsync(config, user.Username, mine: !pending, budget.Token).ConfigureAwait(false); }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested) { requestsUnavailable = true; return Array.Empty<LeavingSoonRequestDto>(); }
                    return await DescribeRequestsAsync(reclaimerr, rows, config, user, budget.Token, token).ConfigureAwait(false);
                }

                var pendingTask = admin ? Load(true) : Task.FromResult<IReadOnlyList<LeavingSoonRequestDto>>(Array.Empty<LeavingSoonRequestDto>());
                var mineTask = Load(false);
                requests = await pendingTask.ConfigureAwait(false);
                mine = await mineTask.ConfigureAwait(false);
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
        /// Requests with the Jellyfin title (matched by TMDB id, only one the viewer can see) and the Jellyfin person: the
        /// request's reason starts "Requested by NAME from Jellyfin" whoever filed it, so the person shows even when
        /// Reclaimerr knows them as <c>NAME_user</c> or the service account. The title lookups run under <paramref name="budget"/>;
        /// one that fails or runs out of it only leaves that card without its Jellyfin link.
        /// </summary>
        private async Task<IReadOnlyList<LeavingSoonRequestDto>> DescribeRequestsAsync(ReclaimerrActions reclaimerr, IReadOnlyList<ReclaimerrRequestRow> rows, PluginConfiguration config, JUser viewer, CancellationToken budget, CancellationToken token)
        {
            // One title lookup per distinct title, all at once (each is kept after the first read).
            async Task<string?> Tmdb(string mediaType, int mediaId)
            {
                try { return await reclaimerr.TmdbIdAsync(config, mediaType, mediaId, budget).ConfigureAwait(false); }
                catch (OperationCanceledException) when (!token.IsCancellationRequested) { return null; }
            }

            var tmdbs = new Dictionary<(string, int), Task<string?>>();
            foreach (var r in rows) tmdbs.TryAdd((r.MediaType, r.MediaId), Tmdb(r.MediaType, r.MediaId));
            await Task.WhenAll(tmdbs.Values).ConfigureAwait(false);
            var list = new List<LeavingSoonRequestDto>(rows.Count);
            foreach (var r in rows)
            {
                string? itemId = null;
                var tmdb = tmdbs[(r.MediaType, r.MediaId)].Result;
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

                var (person, note) = ParseLeavingSoonReason(r.Reason);
                // Filed straight in Reclaimerr (no "Requested by NAME from Jellyfin" text): a Jellyfin user of the same name is the person.
                var jellyfinUser = person != null ? _userManager.GetUserByName(person) : (string.IsNullOrWhiteSpace(r.RequestedBy) ? null : _userManager.GetUserByName(r.RequestedBy));
                list.Add(new LeavingSoonRequestDto(r.Id, r.Title, r.Year, r.MediaType, r.Status, r.CreatedAt, r.RequestedBy, note, jellyfinUser?.Username ?? person, jellyfinUser?.Id.ToString("N"), itemId, r.PosterPath,
                    r.Scope, r.SeasonNumber, r.EpisodeNumber, r.VersionResolution, r.VersionSize, r.AdminNotes, r.ExecutionError, r.Deferred));
            }

            return list;
        }

        /// <summary>The size of the one version of a movie that is leaving, from Reclaimerr (it alone knows which copy); a slow answer is skipped.</summary>
        private static async Task<long?> VersionSizeAsync(LeavingSoonService leaving, ReclaimerrActions reclaimerr, BaseItem item, PluginConfiguration config, CancellationToken token)
        {
            if (!LeavingSoonSources.UsesReclaimerr(config) || !ReclaimerrActions.Enabled(config) || leaving.CollectionOf(item.Id, config) is not { } owner) return null;
            try
            {
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
                budget.CancelAfter(TimeSpan.FromSeconds(4));
                return await reclaimerr.VersionSizeAsync(item, owner, config, budget.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                return null;
            }
        }

        /// <summary>
        /// What leaving frees, from the library's own file sizes: a movie's file, or all of a series' episode files. Null when no
        /// size is known (Reclaimerr's candidate list carries none).
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

        /// <summary>"Requested by NAME from Jellyfin: note" to (NAME, note); any other reason is all note.</summary>
        internal static (string? Person, string? Note) ParseLeavingSoonReason(string? reason)
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
