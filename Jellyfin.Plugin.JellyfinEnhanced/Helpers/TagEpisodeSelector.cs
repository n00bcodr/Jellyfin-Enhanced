using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Selects a representative episode for Series/Season quality and language tags.
    /// Shared by the persisted cache and the user-scoped batch endpoint.
    /// </summary>
    internal static class TagEpisodeSelector
    {
        /// <summary>
        /// Finds a non-virtual episode with audio/video streams, preferring regular
        /// episodes over specials. Returns null when no episode has usable streams.
        /// The optional user keeps batch lookups subject to Jellyfin's access filters.
        /// </summary>
        public static BaseItem? GetFirstEpisode(ILibraryManager libraryManager, BaseItem container, User? user = null)
        {
            const int pageSize = 50;
            var query = new InternalItemsQuery(user)
            {
                ParentId = container.Id,
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                Recursive = true,
                IsVirtualItem = false,
                Limit = pageSize,
                OrderBy = new[]
                {
                    (ItemSortBy.PremiereDate, JSortOrder.Ascending),
                    (ItemSortBy.SortName, JSortOrder.Ascending)
                }
            };

            BaseItem? firstSpecial = null;
            for (var offset = 0; ; offset += pageSize)
            {
                query.StartIndex = offset;
                var episodes = libraryManager.GetItemList(query);
                foreach (var episode in episodes)
                {
                    // A source can exist for a disc stub or an unprobed file while
                    // containing no streams. Source count alone cannot supply tags.
                    if (!episode.GetMediaSources(false).Any(source => source.MediaStreams?.Any(
                        stream => stream.Type == MediaStreamType.Video || stream.Type == MediaStreamType.Audio) == true))
                    {
                        continue;
                    }

                    // Within a season there is no other season to prefer. In
                    // particular, a Specials season can stop at its first match.
                    if (episode.ParentIndexNumber != 0 || container is Season)
                    {
                        return episode;
                    }

                    firstSpecial ??= episode;
                }

                // Do not stop at a fixed candidate count: missing streams and long
                // runs of specials can precede the first usable regular episode.
                if (episodes.Count < pageSize)
                {
                    return firstSpecial;
                }
            }
        }
    }
}
