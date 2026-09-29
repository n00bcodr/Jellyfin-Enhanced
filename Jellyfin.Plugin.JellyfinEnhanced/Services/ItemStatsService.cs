using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Total file size and watch progress of an item and everything playable
    /// under it, for the details-page media-info chips (file-size,
    /// watch-progress and the combined item-stats endpoint).
    ///
    /// The playable leaves are resolved with the same user-scoped queries
    /// Jellyfin's own listings use (a series' seasons and episodes, a
    /// collection's linked children, a folder's children), so library access
    /// and parental rules apply exactly as in the client. Unlike the previous
    /// tree walk this never materialises a media source per episode: the
    /// size and runtime a media source reports are the item's own
    /// <see cref="BaseItem.Size"/> and <see cref="BaseItem.RunTimeTicks"/>,
    /// so a series is one items query, one alternate-version check and one
    /// user-data batch instead of ~3 database round trips per episode.
    /// Only videos that actually have alternate versions still go through
    /// <see cref="BaseItem.GetMediaSources"/>, because their size is the sum
    /// of every version (and a mediaSourceId may select just one).
    /// </summary>
    public sealed class ItemStatsService
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IUserDataManager _userDataManager;

        public ItemStatsService(ILibraryManager libraryManager, IUserDataManager userDataManager)
        {
            _libraryManager = libraryManager;
            _userDataManager = userDataManager;
        }

        /// <summary>Result of <see cref="Compute"/>: the same numbers the two legacy endpoints returned.</summary>
        /// <param name="Size">Summed size in bytes of every media source (or the selected one).</param>
        /// <param name="Progress">Watched share in whole percent, clamped to 0-100.</param>
        /// <param name="TotalPlaybackTicks">Watched ticks: full runtime for played items, else the resume position.</param>
        /// <param name="TotalRuntimeTicks">Summed runtime of every leaf's primary media source.</param>
        public sealed record ItemStats(long Size, int Progress, long TotalPlaybackTicks, long TotalRuntimeTicks);

        /// <summary>
        /// Computes size and watch progress for <paramref name="root"/> as seen
        /// by <paramref name="user"/> (the item must already have been resolved
        /// with that user, so a hidden root never gets here).
        /// </summary>
        /// <param name="user">The requesting user; scopes every child lookup.</param>
        /// <param name="root">Any library item: a movie/episode, season, series, collection or folder.</param>
        /// <param name="mediaSourceId">Optional media source to restrict the file size to (the watch progress ignores it, as before).</param>
        public ItemStats Compute(JUser user, BaseItem root, string? mediaSourceId)
        {
            var leaves = CollectLeaves(user, root);
            var size = SumSize(leaves, mediaSourceId);

            long totalRuntimeTicks = 0;
            foreach (var leaf in leaves)
            {
                // The first media source of any item is the item itself
                // (GetMediaSources orders the item's own id first), whose
                // RunTimeTicks is the item's; virtual leaves are excluded.
                totalRuntimeTicks += leaf.RunTimeTicks ?? 0;
            }

            long totalPlaybackTicks = 0;
#if JF12
            // One query for the whole batch (Jellyfin 12 API).
            var userData = _userDataManager.GetUserDataBatch(leaves, user);
            foreach (var leaf in leaves)
            {
                if (!userData.TryGetValue(leaf.Id, out var data) || data is null)
                {
                    continue;
                }

                totalPlaybackTicks += data.Played
                    // PlaybackPositionTicks is 0 once an item is marked watched.
                    ? leaf.RunTimeTicks ?? 0
                    : data.PlaybackPositionTicks;
            }
#else
            foreach (var leaf in leaves)
            {
                var data = _userDataManager.GetUserData(user, leaf);
                if (data is null)
                {
                    continue;
                }

                totalPlaybackTicks += data.Played ? leaf.RunTimeTicks ?? 0 : data.PlaybackPositionTicks;
            }
#endif

            var progress = totalRuntimeTicks == 0 ? 0 : (double)totalPlaybackTicks / totalRuntimeTicks * 100;
            // Floating point numbers are not needed in the frontend UI.
            return new ItemStats(size, (int)Math.Clamp(progress, 0, 100), totalPlaybackTicks, totalRuntimeTicks);
        }

        /// <summary>
        /// Every playable, non-virtual item under <paramref name="root"/>
        /// (including the root itself when it is playable), deduplicated by id.
        /// </summary>
        private List<BaseItem> CollectLeaves(JUser user, BaseItem root)
        {
            var leaves = new List<BaseItem>();
            var seen = new HashSet<Guid>();
            var visitedFolders = new HashSet<Guid>();
            Collect(user, root, leaves, seen, visitedFolders);
            return leaves;
        }

        private void Collect(JUser user, BaseItem item, List<BaseItem> leaves, HashSet<Guid> seen, HashSet<Guid> visitedFolders)
        {
            // Lightweight DTO options: no images, no extra fields — only the
            // columns already on the entity are read.
            var options = new DtoOptions(false);
            switch (item)
            {
                case Series series:
                    if (!visitedFolders.Add(series.Id))
                    {
                        return;
                    }

                    // Jellyfin's own series listing: one query for the seasons
                    // and episodes visible to this user, then per-season
                    // filtering in memory (specials-in-seasons, missing
                    // episodes). Seasons hidden from the user drop their
                    // episodes, as in the previous seasons-then-episodes walk.
                    AddLeaves(series.GetEpisodes(user, options, shouldIncludeMissingEpisodes: false), leaves, seen);
                    return;

                case Season season:
                    if (!visitedFolders.Add(season.Id))
                    {
                        return;
                    }

                    AddLeaves(season.GetEpisodes(user, options, shouldIncludeMissingEpisodes: false), leaves, seen);
                    return;

                case Folder folder:
                    // Collections (linked children filtered per user), plain
                    // folders, and any other container: the user-scoped
                    // children, recursing into nested containers.
                    if (!visitedFolders.Add(folder.Id))
                    {
                        return;
                    }

                    foreach (var child in folder.GetChildren(user, true))
                    {
                        if (child is Folder)
                        {
                            Collect(user, child, leaves, seen, visitedFolders);
                        }
                        else
                        {
                            AddLeaf(child, leaves, seen);
                        }
                    }

                    return;

                default:
                    AddLeaf(item, leaves, seen);
                    return;
            }
        }

        private static void AddLeaves(IEnumerable<BaseItem> items, List<BaseItem> leaves, HashSet<Guid> seen)
        {
            foreach (var item in items)
            {
                AddLeaf(item, leaves, seen);
            }
        }

        private static void AddLeaf(BaseItem item, List<BaseItem> leaves, HashSet<Guid> seen)
        {
            // Videos and audio are the item kinds that expose media sources.
            // Virtual (missing/unaired) episodes have no file: they contribute
            // neither size nor runtime.
            if ((item is Video || item is Audio) && !item.IsVirtualItem && seen.Add(item.Id))
            {
                leaves.Add(item);
            }
        }

        /// <summary>
        /// Sum of the leaves' sizes, restricted to one media source when
        /// <paramref name="mediaSourceId"/> is given. A media source id is the
        /// owning item's id in "N" format, so for the common single-version
        /// item this is just the item's own size. Videos with alternate
        /// versions (linked or local, or being one themselves) still resolve
        /// their media sources so every version counts, exactly as before.
        /// </summary>
        private long SumSize(List<BaseItem> leaves, string? mediaSourceId)
        {
            var multiVersion = FindMultiVersionIds(leaves);
            long total = 0;
            foreach (var leaf in leaves)
            {
                if (multiVersion.Contains(leaf.Id))
                {
                    foreach (var source in leaf.GetMediaSources(false))
                    {
                        if (string.IsNullOrEmpty(mediaSourceId)
                            || string.Equals(source.Id, mediaSourceId, StringComparison.OrdinalIgnoreCase))
                        {
                            total += source.Size ?? 0;
                        }
                    }

                    continue;
                }

                if (string.IsNullOrEmpty(mediaSourceId)
                    || string.Equals(leaf.Id.ToString("N", CultureInfo.InvariantCulture), mediaSourceId, StringComparison.OrdinalIgnoreCase))
                {
                    total += leaf.Size ?? 0;
                }
            }

            return total;
        }

        /// <summary>Ids of the leaves whose media sources are more than the item itself.</summary>
        private HashSet<Guid> FindMultiVersionIds(List<BaseItem> leaves)
        {
            var result = new HashSet<Guid>();
#if JF12
            var videoIds = new List<Guid>(leaves.Count);
#endif
            foreach (var leaf in leaves)
            {
                if (leaf is not Video video)
                {
                    continue;
                }

                // A secondary version lists its primary (and that one's
                // versions) among its media sources.
#if JF12
                if (video.PrimaryVersionId.HasValue)
                {
                    result.Add(video.Id);
                    continue;
                }

                videoIds.Add(video.Id);
#else
                if (!string.IsNullOrEmpty(video.PrimaryVersionId))
                {
                    result.Add(video.Id);
                    continue;
                }


                if ((video.LinkedAlternateVersions?.Length ?? 0) > 0 || (video.LocalAlternateVersions?.Length ?? 0) > 0)
                {
                    result.Add(video.Id);
                }
#endif
            }

#if JF12
            if (videoIds.Count > 0)
            {
                // One query for the whole batch (Jellyfin 12 API): the subset
                // that owns a linked or local alternate version.
                result.UnionWith(_libraryManager.GetItemIdsWithAlternateVersions(videoIds));
            }
#endif

            return result;
        }
    }
}
