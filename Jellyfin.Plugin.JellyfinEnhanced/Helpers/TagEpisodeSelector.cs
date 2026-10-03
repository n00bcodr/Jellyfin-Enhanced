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
            return ScanEpisodes(libraryManager, container, user, HasAudioOrVideoStreams, stopAtFirstRegular: true);
        }

        /// <summary>
        /// Whether an episode has at least one audio or video stream. A source can
        /// exist for a disc stub or an unprobed file while containing no streams,
        /// so source count alone cannot supply tags.
        /// </summary>
        public static bool HasAudioOrVideoStreams(BaseItem episode)
        {
            return episode.GetMediaSources(false).Any(source => source.MediaStreams?.Any(
                stream => stream.Type == MediaStreamType.Video || stream.Type == MediaStreamType.Audio) == true);
        }

        /// <summary>
        /// Walks the container's non-virtual episodes in PremiereDate/SortName
        /// order and returns the representative episode: the first regular one
        /// (or, within a Specials season, the first of any kind) that
        /// <paramref name="hasUsableStreams"/> accepts, falling back to the first
        /// accepted special. The callback is where callers do their per-episode
        /// work — the persisted cache aggregates audio languages across every
        /// episode in it — and it reports whether the episode had streams so
        /// the representative pick stays consistent with the aggregate. With
        /// <paramref name="stopAtFirstRegular"/> the walk ends as soon as the
        /// representative is known; otherwise every page is read.
        /// </summary>
        public static BaseItem? ScanEpisodes(
            ILibraryManager libraryManager,
            BaseItem container,
            User? user,
            Func<BaseItem, bool> hasUsableStreams,
            bool stopAtFirstRegular)
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

            BaseItem? firstRegular = null;
            BaseItem? firstSpecial = null;
            for (var offset = 0; ; offset += pageSize)
            {
                query.StartIndex = offset;
                var episodes = libraryManager.GetItemList(query);
                foreach (var episode in episodes)
                {
                    if (!hasUsableStreams(episode))
                    {
                        continue;
                    }

                    // Within a season there is no other season to prefer. In
                    // particular, a Specials season can stop at its first match.
                    if (episode.ParentIndexNumber != 0 || container is Season)
                    {
                        if (stopAtFirstRegular)
                        {
                            return episode;
                        }

                        firstRegular ??= episode;
                    }
                    else
                    {
                        firstSpecial ??= episode;
                    }
                }

                // Do not stop at a fixed candidate count: missing streams and long
                // runs of specials can precede the first usable regular episode.
                if (episodes.Count < pageSize)
                {
                    return firstRegular ?? firstSpecial;
                }
            }
        }
    }
}
