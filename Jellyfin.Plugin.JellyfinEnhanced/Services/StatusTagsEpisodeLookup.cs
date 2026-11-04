using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The Status Tags episode facts of one Series or Season for the /tag-data
    /// fallback, never reading every episode of a large container. One query
    /// reads up to <see cref="SmallContainer"/> episodes, newest added first:
    /// a container that fits is walked in full from it (each query has a cost
    /// of its own, so this is the cheapest for the usual season or short
    /// series). A larger one runs a fixed handful of queries instead, each
    /// filtered and sorted so that its first episode decides one fact (the
    /// newest added, the winner of the newest air date, the newest season, the
    /// last episode of the latest season, the first aired episode of the seasons
    /// <see cref="StatusTagsEpisodeFacts.SeasonPremiere"/> reads), so the work
    /// is bounded however many episodes tie or do not count. A Season reads the
    /// best unnumbered candidate of a fact separately, since an unnumbered
    /// episode takes the Season's own number. The episodes are all fed to
    /// <see cref="StatusTagsEpisodeFacts"/>, so the rules (specials, ties, future
    /// dates, a Season's own number) stay the ones the tag cache applies to the
    /// full walk. A Season's added span counts its episodes with a count query.
    /// </summary>
    internal static class StatusTagsEpisodeLookup
    {
        /// <summary>Containers with at most this many episodes are read in one query.</summary>
        internal const int SmallContainer = 100;

        // Jellyfin stores a missing date as DateTime.MinValue, which the rules ignore.
        private static readonly DateTime AfterUnset = DateTime.MinValue.AddDays(1);

        /// <summary>
        /// The newest added date (Unix ms) and the schedule/milestone facts of a container.
        /// </summary>
        /// <param name="library">The library.</param>
        /// <param name="container">The Series or Season.</param>
        /// <param name="query">A new query for the container's episodes as the user (parent, type, recursion, non-virtual, user).</param>
        /// <param name="now">The time the facts are computed for.</param>
        /// <param name="smallContainer">Containers with at most this many episodes are read in one query (tests lower it).</param>
        public static (long? LatestAdded, StatusTagsEpisodeFacts Facts) Load(ILibraryManager library, BaseItem container, Func<InternalItemsQuery> query, DateTime now, int smallContainer = SmallContainer)
        {
            var isSeason = container is Season;
            var own = (container as Season)?.IndexNumber;
            var facts = new StatusTagsEpisodeFacts(isSeason, own, now);
            var noted = new HashSet<Guid>();
            Episode? Note(Episode? episode)
            {
                if (episode != null && noted.Add(episode.Id))
                    facts.Note(episode.Id, episode.DateCreated, episode.PremiereDate, episode.ParentIndexNumber, episode.IndexNumber, episode.IndexNumberEnd);
                return episode;
            }

            // The first episode in the given order, or null.
            Episode? First(Action<InternalItemsQuery> shape, params (ItemSortBy, JSortOrder)[] order)
            {
                var q = query();
                shape(q);
                q.OrderBy = order;
                q.Limit = 1;
                return library.GetItemList(q).OfType<Episode>().FirstOrDefault();
            }

            // A Season's best unnumbered candidate, from an order that sorts unset season numbers
            // first (ascending) right after the keys that decide the fact; null when there is none.
            Episode? Unnumbered(Action<InternalItemsQuery> shape, params (ItemSortBy, JSortOrder)[] order)
                => isSeason && First(shape, order) is { ParentIndexNumber: null } episode ? episode : null;

            static void Any(InternalItemsQuery q) { }
            void AiredByNow(InternalItemsQuery q)
            {
                q.MinPremiereDate = AfterUnset;
                q.MaxPremiereDate = now;
            }

            // A season premiere counts once its day has begun in the earliest time zone (StatusTagsEpisodeFacts.EarliestDayLead).
            void AiredSomewhereToday(InternalItemsQuery q)
            {
                q.MinPremiereDate = AfterUnset;
                q.MaxPremiereDate = now + StatusTagsEpisodeFacts.EarliestDayLead;
            }

            const ItemSortBy Aired = ItemSortBy.PremiereDate, Added = ItemSortBy.DateCreated, SeasonNo = ItemSortBy.ParentIndexNumber, EpisodeNo = ItemSortBy.IndexNumber;
            const JSortOrder desc = JSortOrder.Descending, asc = JSortOrder.Ascending;

            // Newest added first (a missing date sorts last, so it is the newest only when all are missing).
            var head = query();
            head.OrderBy = new[] { (Added, desc) };
            head.Limit = smallContainer + 1;
            var firstPage = library.GetItemList(head);
            var newest = firstPage.OfType<Episode>().FirstOrDefault();
            DateTime? latestAdded = newest != null && newest.DateCreated != default ? newest.DateCreated : null;
            if (firstPage.Count <= smallContainer)
            {
                // Every episode is here: the full walk.
                foreach (var episode in firstPage.OfType<Episode>()) Note(episode);
                return (TagCacheService.ToUnixMilliseconds(latestAdded), facts);
            }

            Note(newest);

            // Newest aired up to now; a tie goes to the highest season, then episode (unset
            // numbers sort last descending), as in the full walk. A Series counts regular
            // seasons only: both filters together are exactly "season number > 0".
            Note(First(q =>
            {
                AiredByNow(q);
                if (!isSeason)
                {
                    q.ParentIndexNumberNotEquals = 0;
                    q.MinParentAndIndexNumber = (0, int.MaxValue);
                }
            }, (Aired, desc), (SeasonNo, desc), (EpisodeNo, desc)));
            Note(Unnumbered(AiredByNow, (Aired, desc), (SeasonNo, asc), (EpisodeNo, desc)));

            // The newest season: the highest number (unnumbered episodes sort last), or a
            // Season's own number when it has unnumbered episodes. That unnumbered episode
            // (the highest episode number) also decides IsLast when the latest season is the own one.
            var highest = Note(First(Any, (SeasonNo, desc)));
            var unnumbered = Note(Unnumbered(Any, (SeasonNo, asc), (EpisodeNo, desc)));
            var newestSeason = new[] { highest?.ParentIndexNumber, unnumbered != null ? own : null }.Where(s => s > 0).Max()
                // A Season with only specials reads its premiere from them.
                ?? (isSeason ? highest?.ParentIndexNumber ?? (unnumbered != null ? own : null) : null);

            // Whether the latest aired episode is the last one of its season.
            if (facts.LatestIndex is { Season: var latestSeason })
            {
                Note(First(q => q.ParentIndexNumber = latestSeason, (EpisodeNo, desc)));
            }

            // The first aired episode 1 of the seasons the premiere is read from.
            foreach (var season in new[] { isSeason ? own : null, newestSeason }.OfType<int>().Distinct())
            {
                Note(First(q => { q.IndexNumber = 1; AiredSomewhereToday(q); q.ParentIndexNumber = season; }, (Aired, asc)));
                if (season == own) Note(Unnumbered(q => { q.IndexNumber = 1; AiredSomewhereToday(q); }, (SeasonNo, asc), (Aired, asc)));
            }

            if (isSeason)
            {
                // A Season's added span: its episode count and oldest added date. GetCount,
                // not GetItemIds: only item and count queries turn the recursive parent into
                // an ancestor match, and a Season's episodes are not its children when the
                // series has no season folders.
                var oldest = Note(First(Any, (Added, asc)));
                facts.UseAddedSpan(library.GetCount(query()), oldest?.DateCreated, latestAdded);
            }

            return (TagCacheService.ToUnixMilliseconds(latestAdded), facts);
        }
    }
}
