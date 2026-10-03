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
            var query = CreateEpisodeQuery(user);
            query.ParentId = container.Id;
            query.Limit = pageSize;

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

                    if (CountsAsRegular(episode.ParentIndexNumber, container is Season))
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

        /// <summary>
        /// The same pick as <see cref="ScanEpisodes"/> (with
        /// <c>stopAtFirstRegular: false</c>) over episodes the caller already
        /// holds in scan order, for the full cache build, which groups every
        /// episode of the library under its containers from one ordered query
        /// (<see cref="GetOrderedEpisodeIds"/>) instead of querying each
        /// container. <paramref name="hasUsableStreams"/> is called for every
        /// episode, in order, exactly as the scan's callback is.
        /// </summary>
        public static T? SelectRepresentative<T>(
            IEnumerable<T> orderedEpisodes,
            bool containerIsSeason,
            Func<T, int?> parentIndexNumber,
            Func<T, bool> hasUsableStreams)
            where T : class
        {
            T? firstRegular = null;
            T? firstSpecial = null;
            foreach (var episode in orderedEpisodes)
            {
                if (!hasUsableStreams(episode))
                {
                    continue;
                }

                if (CountsAsRegular(parentIndexNumber(episode), containerIsSeason))
                {
                    firstRegular ??= episode;
                }
                else
                {
                    firstSpecial ??= episode;
                }
            }

            return firstRegular ?? firstSpecial;
        }

        /// <summary>
        /// Every non-virtual episode in the library, in the order
        /// <see cref="ScanEpisodes"/> walks a container's episodes. That scan is
        /// this same query plus <c>ParentId</c> (which Jellyfin rewrites into an
        /// ancestor filter for a recursive query on a Series or Season) and
        /// paging, so the episodes of one container appear here in the same
        /// relative order as in its own scan. Only episodes tied on both sort
        /// keys (same or no premiere date AND same sort name) have no defined
        /// order in either query.
        /// </summary>
        public static IReadOnlyList<Guid> GetOrderedEpisodeIds(ILibraryManager libraryManager)
        {
            return libraryManager.GetItemIds(CreateEpisodeQuery(null));
        }

        /// <summary>
        /// Filter and sort shared by the per-container scan and the library-wide
        /// ordered episode list, so the two can't drift apart.
        /// </summary>
        private static InternalItemsQuery CreateEpisodeQuery(User? user)
        {
            return new InternalItemsQuery(user)
            {
                IncludeItemTypes = new[] { BaseItemKind.Episode },
                Recursive = true,
                IsVirtualItem = false,
                OrderBy = new[]
                {
                    (ItemSortBy.PremiereDate, JSortOrder.Ascending),
                    (ItemSortBy.SortName, JSortOrder.Ascending)
                }
            };
        }

        /// <summary>
        /// Whether an episode can be a container's regular (non-special)
        /// representative. Within a season there is no other season to prefer;
        /// in particular, a Specials season can stop at its first match.
        /// </summary>
        private static bool CountsAsRegular(int? parentIndexNumber, bool containerIsSeason)
        {
            return parentIndexNumber != 0 || containerIsSeason;
        }
    }
}
