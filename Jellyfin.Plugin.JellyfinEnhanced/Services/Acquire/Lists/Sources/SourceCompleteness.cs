using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>What one page of a paged list read said about the list (each paging loop reports every page it read).</summary>
    /// <param name="Rows">Rows on the page, as the source sent them (before JE drops any it can't use).</param>
    /// <param name="PageCount">The page count the page reported (TMDB <c>total_pages</c>, Seerr <c>totalPages</c>, Trakt <c>X-Pagination-Page-Count</c>).</param>
    /// <param name="ItemCount">The list's total the page reported (TMDB <c>item_count</c>/<c>total_results</c>, Seerr <c>totalResults</c>, Trakt <c>X-Pagination-Item-Count</c>, IMDb <c>total</c>).</param>
    /// <param name="HasNext">IMDb <c>pageInfo.hasNextPage</c>, when the page carried it as a boolean.</param>
    /// <param name="HasCursor">IMDb: the page carried an <c>endCursor</c>.</param>
    /// <param name="Errors">The page came with errors next to its data (IMDb GraphQL <c>errors</c>).</param>
    internal readonly record struct SourcePage(int Rows, int? PageCount = null, int? ItemCount = null, bool? HasNext = null, bool HasCursor = false, bool Errors = false);

    /// <summary>Why a paging loop stopped.</summary>
    internal enum SourceReadEnd
    {
        /// <summary>Stopped without an end: no end marker, an empty page, no cursor to go on with.</summary>
        Stalled,

        /// <summary>The source's own end: the last page of its page count, or <c>hasNextPage=false</c>.</summary>
        Last,

        /// <summary>A chart's first pages were read (charts are endless; JE reads their top) and the chart goes on.</summary>
        Window,

        /// <summary>JE's entry cap was reached with more of the list left.</summary>
        Cap,

        /// <summary>JE's page limit was reached with more pages left.</summary>
        PageLimit,
    }

    /// <summary>The facts one paged read collected: its pages, why it stopped, and whether the list moved meanwhile.</summary>
    internal sealed class SourceRead
    {
        private readonly List<SourcePage> _pages = new();

        /// <summary>The pages read, in order.</summary>
        public IReadOnlyList<SourcePage> Pages => _pages;

        /// <summary>Why the loop stopped (<see cref="SourceReadEnd.Stalled"/> until it says otherwise).</summary>
        public SourceReadEnd End { get; private set; } = SourceReadEnd.Stalled;

        /// <summary>The list changed while it was read (offset pages: a row came back, a probe didn't match).</summary>
        public bool Drifted { get; private set; }

        /// <summary>Reports a page.</summary>
        /// <param name="page">The page.</param>
        public void Page(SourcePage page) => _pages.Add(page);

        /// <summary>Reports why the loop stopped.</summary>
        /// <param name="end">The reason.</param>
        public void Stop(SourceReadEnd end) => End = end;

        /// <summary>Reports that the list moved while it was read.</summary>
        public void Drift() => Drifted = true;
    }

    /// <summary>The completeness of a read: complete only when neither partial nor truncated.</summary>
    /// <param name="Partial">Rows may be missing (nothing may be removed on this read).</param>
    /// <param name="Truncated">JE stopped before the end on purpose (a cap or a page limit with more left).</param>
    internal readonly record struct SourceVerdict(bool Partial, bool Truncated)
    {
        /// <summary>The whole list was read.</summary>
        public bool Complete => !Partial && !Truncated;

        /// <summary>A whole one-answer list.</summary>
        public static readonly SourceVerdict Whole = new(false, false);
    }

    /// <summary>
    /// When a list read is complete, per provider (review round 2, D53 rule 1). Completeness is POSITIVELY established:
    /// a read is complete only when every fact that proves the whole list was read holds, never because no known bad
    /// sign showed up. Anything less is partial (nothing may be removed on it) or truncated (JE stopped on purpose); an
    /// answer without the list it should carry is a typed failure before it gets here.
    /// <list type="bullet">
    /// <item><b>Offset lists</b> (TMDB lists; Trakt lists and watchlists), <see cref="OffsetList"/>: every page reports the
    /// page count and the list's total, the same on every page; the loop ended on the page count's last page; no page is
    /// empty (an empty list's single page aside); the rows read equal the total; the list didn't move while it was read;
    /// no error.</item>
    /// <item><b>Charts</b> (TMDB and Seerr charts, Trakt charts), <see cref="Chart"/>: every page reports the page count and
    /// the total, the same on every page; no page is empty; no error; and either the chart's last page was read and the
    /// rows read equal its total, or JE's chart window ended before the chart did.</item>
    /// <item><b>Cursor lists</b> (IMDb), <see cref="Cursor"/>: every page carries <c>pageInfo.hasNextPage</c> as a boolean
    /// and the same <c>total</c>; every page that says more follow is non-empty and has a cursor; the last page says
    /// <c>hasNextPage=false</c>; the edges read equal the total; no GraphQL errors.</item>
    /// <item><b>MDBList</b>: the public JSON is one answer by the endpoint's contract: complete when it carries the list
    /// array, announces nothing more and is below the entry cap (<see cref="MdblistPublic"/>). The API reads one page of
    /// up to the cap: complete on an explicit <c>has_more=false</c>, or on a page shorter than the limit asked for
    /// (<see cref="MdblistApi"/>).</item>
    /// <item><b>One-answer sources</b> (TMDB and Seerr collections; Trakt's box office, which isn't paginated), <see cref="SourceVerdict.Whole"/>:
    /// the answer carries its list array (else a typed failure).</item>
    /// <item><b>Chronolists</b> (<see cref="Chronolists"/>): the page's data was read, every entry of it is usable and none
    /// was left over the cap.</item>
    /// </list>
    /// An HTTP error on any page fails the whole read (a typed failure), so no partial page set is ever "complete".
    /// </summary>
    internal static class SourceCompleteness
    {
        /// <summary>TMDB lists; Trakt lists and watchlists.</summary>
        /// <param name="read">The read.</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict OffsetList(SourceRead read)
        {
            var pages = read.Pages;
            if (pages.Count == 0)
            {
                return new SourceVerdict(true, false);
            }

            var pageCount = Same(pages, p => p.PageCount);
            var total = Same(pages, p => p.ItemCount);
            var sound = pageCount is int && total is int && NoEmptyPage(pages, total) && !read.Drifted && !pages.Any(p => p.Errors);
            return read.End switch
            {
                SourceReadEnd.Last => new SourceVerdict(!(sound && pages.Count == System.Math.Max(pageCount!.Value, 1) && pages.Sum(p => p.Rows) == total), false),
                SourceReadEnd.Cap or SourceReadEnd.PageLimit => new SourceVerdict(!sound, true),
                _ => new SourceVerdict(true, false),
            };
        }

        /// <summary>TMDB and Seerr charts; Trakt charts (their first pages).</summary>
        /// <param name="read">The read.</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict Chart(SourceRead read)
        {
            var pages = read.Pages;
            if (pages.Count == 0)
            {
                return new SourceVerdict(true, false);
            }

            var pageCount = Same(pages, p => p.PageCount);
            var total = Same(pages, p => p.ItemCount);
            var sound = pageCount is int && total is int && NoEmptyPage(pages, total) && !pages.Any(p => p.Errors);
            var complete = read.End switch
            {
                SourceReadEnd.Last => sound && pages.Count == System.Math.Max(pageCount!.Value, 1) && pages.Sum(p => p.Rows) == total,
                SourceReadEnd.Window => sound && pages.Count < pageCount!.Value,
                _ => false,
            };
            return new SourceVerdict(!complete, false);
        }

        /// <summary>IMDb's cursor pages.</summary>
        /// <param name="read">The read.</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict Cursor(SourceRead read)
        {
            var pages = read.Pages;
            if (pages.Count == 0)
            {
                return new SourceVerdict(true, false);
            }

            var total = Same(pages, p => p.ItemCount);
            var sound = total is int
                && pages.All(p => p.HasNext is bool && !p.Errors)
                && pages.Where(p => p.HasNext == true).All(p => p.HasCursor && p.Rows > 0);
            return read.End switch
            {
                SourceReadEnd.Last => new SourceVerdict(!(sound && pages[^1].HasNext == false && pages.Sum(p => p.Rows) == total), false),
                SourceReadEnd.Cap or SourceReadEnd.PageLimit => new SourceVerdict(!sound, true),
                _ => new SourceVerdict(true, false),
            };
        }

        /// <summary>MDBList's public JSON (one answer).</summary>
        /// <param name="rows">Rows of the answer.</param>
        /// <param name="moreAnnounced">The answer announced more (a header or pagination).</param>
        /// <param name="cap">JE's entry cap.</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict MdblistPublic(int rows, bool moreAnnounced, int cap) =>
            moreAnnounced || rows >= cap ? new SourceVerdict(false, true) : SourceVerdict.Whole;

        /// <summary>The MDBList API's one page.</summary>
        /// <param name="rows">Rows of the page.</param>
        /// <param name="hasMore">The page's own answer to "more follow" (null: it didn't say).</param>
        /// <param name="limit">The limit asked for.</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict MdblistApi(int rows, bool? hasMore, int limit) => hasMore switch
        {
            true => new SourceVerdict(false, true),
            false when rows <= limit => SourceVerdict.Whole,
            null when rows < limit => SourceVerdict.Whole, // a page shorter than the limit asked for is the last one
            _ => new SourceVerdict(false, true),
        };

        /// <summary>A Chronolists watch order.</summary>
        /// <param name="list">The page's data.</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict Chronolists(ChronolistsList list) => new(list.Unusable > 0, list.Truncated || list.Total > list.Items.Count);

        // The value every page reported (null when a page didn't report it, or two pages disagree).
        private static int? Same(IReadOnlyList<SourcePage> pages, System.Func<SourcePage, int?> value)
        {
            var first = value(pages[0]);
            return first is int && pages.All(p => value(p) == first) ? first : null;
        }

        // No page is empty, except the single page of an empty list.
        private static bool NoEmptyPage(IReadOnlyList<SourcePage> pages, int? total) =>
            pages.All(p => p.Rows > 0) || (pages.Count == 1 && pages[0].Rows == 0 && total == 0);
    }
}
