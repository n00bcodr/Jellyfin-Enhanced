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
    /// fallback, from a few sorted, limited queries instead of every episode.
    /// Each query fetches the episodes that decide one fact (the newest added,
    /// every episode of the newest air date, the newest season, the last
    /// episode of the latest season, the first aired episode of the seasons
    /// <see cref="StatusTagsEpisodeFacts.SeasonPremiere"/> reads), and they are
    /// all fed to <see cref="StatusTagsEpisodeFacts"/>, so the rules (specials,
    /// ties, future dates, a Season's own number for unnumbered episodes) stay
    /// the ones the tag cache applies to the full walk. A Season's added span
    /// counts its episodes with an id-only query.
    /// </summary>
    internal static class StatusTagsEpisodeLookup
    {
        // Episodes fetched per page when a fact's first candidates may not
        // count (a special for a Series, another season's episode in a Season).
        private const int Page = 4;

        // Jellyfin stores a missing date as DateTime.MinValue, which the rules ignore.
        private static readonly DateTime AfterUnset = DateTime.MinValue.AddDays(1);

        /// <summary>
        /// The newest added date (Unix ms) and the schedule/milestone facts of a container.
        /// </summary>
        /// <param name="library">The library.</param>
        /// <param name="container">The Series or Season.</param>
        /// <param name="query">A new query for the container's episodes as the user (parent, type, recursion, non-virtual, user).</param>
        /// <param name="now">The time the facts are computed for.</param>
        public static (long? LatestAdded, StatusTagsEpisodeFacts Facts) Load(ILibraryManager library, BaseItem container, Func<InternalItemsQuery> query, DateTime now)
        {
            var isSeason = container is Season;
            var own = (container as Season)?.IndexNumber;
            var facts = new StatusTagsEpisodeFacts(isSeason, own, now);
            var noted = new HashSet<Guid>();
            int? SeasonOf(Episode episode) => episode.ParentIndexNumber ?? own;
            Episode? Note(Episode? episode)
            {
                if (episode != null && noted.Add(episode.Id))
                    facts.Note(episode.Id, episode.DateCreated, episode.PremiereDate, episode.ParentIndexNumber, episode.IndexNumber);
                return episode;
            }

            // Episodes in the given order, a page at a time, read only as far as the caller looks.
            IEnumerable<Episode> Ordered(Action<InternalItemsQuery> shape, params (ItemSortBy, JSortOrder)[] order)
            {
                for (var start = 0; ; start += Page)
                {
                    var q = query();
                    shape(q);
                    q.OrderBy = order;
                    q.StartIndex = start;
                    q.Limit = Page;
                    var page = library.GetItemList(q);
                    foreach (var item in page)
                    {
                        if (item is Episode episode) yield return episode;
                    }

                    if (page.Count < Page) yield break;
                }
            }

            static void Any(InternalItemsQuery q) { }
            const ItemSortBy Aired = ItemSortBy.PremiereDate, Added = ItemSortBy.DateCreated;
            const JSortOrder desc = JSortOrder.Descending, asc = JSortOrder.Ascending;

            // Newest added (a missing date sorts last, so it is the newest only when all are missing).
            var newest = Note(Ordered(Any, (Added, desc)).FirstOrDefault());
            DateTime? latestAdded = newest != null && newest.DateCreated != default ? newest.DateCreated : null;

            // Newest aired up to now: every episode of that air date, so ties resolve as in the full walk.
            var latest = Ordered(q => { q.MinPremiereDate = AfterUnset; q.MaxPremiereDate = now; }, (Aired, desc))
                .FirstOrDefault(e => isSeason || SeasonOf(e) > 0);
            if (latest?.PremiereDate is { } latestAired)
            {
                foreach (var tie in Ordered(q => { q.MinPremiereDate = latestAired; q.MaxPremiereDate = latestAired; }, (ItemSortBy.ParentIndexNumber, desc), (ItemSortBy.IndexNumber, desc)))
                    Note(tie);
            }

            // The newest season: the highest number (unnumbered episodes sort last), or a
            // Season's own number when it has unnumbered episodes (they sort first).
            var highest = Note(Ordered(Any, (ItemSortBy.ParentIndexNumber, desc)).FirstOrDefault());
            var unnumbered = isSeason ? Ordered(Any, (ItemSortBy.ParentIndexNumber, asc)).FirstOrDefault() is { ParentIndexNumber: null } first ? Note(first) : null : null;
            var newestSeason = new[] { highest?.ParentIndexNumber, unnumbered != null ? own : null }.Where(s => s > 0).Max()
                // A Season with only specials reads its premiere from them.
                ?? (isSeason ? highest?.ParentIndexNumber ?? (unnumbered != null ? own : null) : null);

            // Whether the latest aired episode is the last one of its season.
            if (facts.LatestIndex is { Season: var latestSeason })
            {
                Note(Ordered(q => { if (!isSeason) q.ParentIndexNumber = latestSeason; }, (ItemSortBy.IndexNumber, desc))
                    .FirstOrDefault(e => SeasonOf(e) == latestSeason));
            }

            // The first aired episode 1 of the seasons the premiere is read from.
            foreach (var season in new[] { isSeason ? own : null, newestSeason }.OfType<int>().Distinct())
            {
                Note(Ordered(q => { q.IndexNumber = 1; q.MinPremiereDate = AfterUnset; q.MaxPremiereDate = now; if (!isSeason) q.ParentIndexNumber = season; }, (Aired, asc))
                    .FirstOrDefault(e => SeasonOf(e) == season));
            }

            if (isSeason)
            {
                // A Season's added span: its episode count (ids only) and oldest added date.
                var oldest = Note(Ordered(Any, (Added, asc)).FirstOrDefault());
                facts.UseAddedSpan(library.GetItemIds(query()).Count, oldest?.DateCreated, latestAdded);
            }

            return (TagCacheService.ToUnixMilliseconds(latestAdded), facts);
        }
    }
}
