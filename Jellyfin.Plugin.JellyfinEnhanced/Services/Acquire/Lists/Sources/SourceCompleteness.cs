using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>What a row of a list answer stands for in the snapshot (review round 3, D53 rule 1).</summary>
    internal enum SourceRowKind
    {
        /// <summary>A title JE imports, under one usable key.</summary>
        Usable,

        /// <summary>A deliberately unsupported entry (a person, a game, an adult title): counted, never a key.</summary>
        Excluded,

        /// <summary>An entry of a supported type JE couldn't key (no id, an id of the wrong form, missing season or episode).</summary>
        Malformed,
    }

    /// <summary>
    /// One row of a list answer as its parser read it. A row is <see cref="SourceRowKind.Usable"/> only when its entry has a
    /// key (<see cref="Of"/> decides: an entry without one is malformed); the entry of an excluded or malformed row may still
    /// be kept (an id-less gap, a title-only entry), but it never stands for a key of the snapshot.
    /// </summary>
    /// <param name="Kind">What the row stands for.</param>
    /// <param name="Item">The entry it gives the list, if any.</param>
    internal readonly record struct SourceRow(SourceRowKind Kind, SourceItem? Item)
    {
        /// <summary>A row of a supported type for this entry: usable when it has a key, else malformed (the entry kept).</summary>
        /// <param name="item">The parsed entry (null: unreadable).</param>
        /// <returns>The row.</returns>
        public static SourceRow Of(SourceItem? item) => new(item?.Key != null ? SourceRowKind.Usable : SourceRowKind.Malformed, item);

        /// <summary>A deliberately unsupported entry (counted separately).</summary>
        /// <param name="gap">An id-less entry that keeps its place in the list, or null.</param>
        /// <returns>The row.</returns>
        public static SourceRow Excluded(SourceItem? gap = null) => new(SourceRowKind.Excluded, gap);

        /// <summary>An entry of a supported type JE can't read.</summary>
        public static readonly SourceRow Malformed = new(SourceRowKind.Malformed, null);
    }

    /// <summary>
    /// A row's declared type, classified BEFORE the row is keyed (review round 4, 4c2-R4-2; D53 rule 2: a row whose type
    /// JE doesn't import must never become a key of a title it isn't). Per provider, every row's type is one of:
    /// <list type="bullet">
    /// <item><b>supported</b> (keyed as that type);</item>
    /// <item><b>deliberately unsupported</b> (a person, a game…): a counted exclusion, only where the source mixes types;</item>
    /// <item><b>malformed</b> (partial): a type JE doesn't know; no type where the source declares one; or, in a context
    /// that fixes one type, any other type, an unsupported one included (the source changed shape).</item>
    /// </list>
    /// A missing type is taken from the context only where the context fixes it reliably (a chart or collection of one
    /// media type, an MDBList official list of movies or shows) and the provider doesn't always declare one. The provider
    /// rules are in each parser (ListSourceFetcher: TmdbRow, SeerrRow, TraktRow, ImdbRow, MdblistItems; ChronolistsPage).
    /// </summary>
    internal static class SourceTypes
    {
        /// <summary>Classifies a row's declared type.</summary>
        /// <param name="declared">The type the row declares (null: none).</param>
        /// <param name="context">The type the source context fixes, in the provider's own words (null: the source mixes types).</param>
        /// <param name="media">The JE media type ("movie", "tv") of a supported provider type, else null.</param>
        /// <param name="excluded">The provider's deliberately unsupported types.</param>
        /// <param name="alwaysDeclared">The provider declares a type on every row (a missing one is malformed in any context).</param>
        /// <returns><see cref="SourceRowKind.Usable"/> with the type to key the row as (its entry still needs a key), or
        /// <see cref="SourceRowKind.Excluded"/> / <see cref="SourceRowKind.Malformed"/>.</returns>
        public static (SourceRowKind Kind, string? Type) Classify(string? declared, string? context, System.Func<string, string?> media, IReadOnlySet<string> excluded, bool alwaysDeclared = false)
        {
            if (declared == null)
            {
                return context == null || alwaysDeclared ? (SourceRowKind.Malformed, null) : (SourceRowKind.Usable, context);
            }

            if (excluded.Contains(declared))
            {
                return (context == null ? SourceRowKind.Excluded : SourceRowKind.Malformed, declared);
            }

            var kind = media(declared);
            return kind == null || (context != null && kind != media(context)) ? (SourceRowKind.Malformed, declared) : (SourceRowKind.Usable, declared);
        }
    }

    /// <summary>What one page of a paged list read said about the list (each paging loop reports every page it read).</summary>
    /// <param name="Rows">Rows the parser read on the page (every kind), counted by <see cref="SourceRead"/>, never by the caller.</param>
    /// <param name="PageCount">The page count the page reported (TMDB <c>total_pages</c>, Seerr <c>totalPages</c>, Trakt <c>X-Pagination-Page-Count</c>).</param>
    /// <param name="ItemCount">The list's total the page reported (TMDB <c>item_count</c>/<c>total_results</c>, Seerr <c>totalResults</c>, Trakt <c>X-Pagination-Item-Count</c>, IMDb <c>total</c>).</param>
    /// <param name="HasNext">IMDb <c>pageInfo.hasNextPage</c>, when the page carried it as a boolean.</param>
    /// <param name="HasCursor">IMDb: the page carried an <c>endCursor</c>.</param>
    /// <param name="Errors">The page came with errors next to its data (IMDb GraphQL <c>errors</c>).</param>
    internal readonly record struct SourcePage(int Rows, int? PageCount = null, int? ItemCount = null, bool? HasNext = null, bool HasCursor = false, bool Errors = false);

    /// <summary>Why a paging loop stopped.</summary>
    internal enum SourceReadEnd
    {
        /// <summary>Stopped without an end: no end marker, an empty page, no cursor to go on with, a cursor read before.</summary>
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

    /// <summary>
    /// The facts one read collected: every row its parser read (review round 3, D53 rule 1: completeness is about what the
    /// snapshot represents, so the rows are reported here as parsed, and the provider functions count distinct usable
    /// keys and counted exclusions, never the transport's row count), its pages, why it stopped, and whether the list moved
    /// meanwhile.
    /// </summary>
    internal sealed class SourceRead
    {
        private readonly List<SourcePage> _pages = new();
        private readonly HashSet<string> _keys = new(System.StringComparer.Ordinal);
        private readonly HashSet<string> _cursors = new(System.StringComparer.Ordinal);
        private int _pageRows;

        /// <summary>The pages read, in order.</summary>
        public IReadOnlyList<SourcePage> Pages => _pages;

        /// <summary>Why the loop stopped (<see cref="SourceReadEnd.Stalled"/> until it says otherwise).</summary>
        public SourceReadEnd End { get; private set; } = SourceReadEnd.Stalled;

        /// <summary>The list changed while it was read (offset pages: a row came back, a probe didn't match; a cursor came back).</summary>
        public bool Drifted { get; private set; }

        /// <summary>Distinct usable keys read.</summary>
        public int Keys => _keys.Count;

        /// <summary>Deliberately unsupported rows (counted, never keys).</summary>
        public int Excluded { get; private set; }

        /// <summary>Rows of a supported type that JE couldn't key.</summary>
        public int Malformed { get; private set; }

        /// <summary>Usable rows whose key was read before (in this read, on any page).</summary>
        public int Repeated { get; private set; }

        /// <summary>Rows read, of every kind.</summary>
        public int Rows { get; private set; }

        /// <summary>Rows the snapshot represents: one per distinct key, plus the counted exclusions.</summary>
        public int Represented => Keys + Excluded;

        /// <summary>Every row read is one distinct usable key or a counted exclusion, and nothing came back twice.</summary>
        public bool RowsSound => Malformed == 0 && Repeated == 0 && !Drifted;

        /// <summary>Reports a row as its parser read it.</summary>
        /// <param name="row">The row.</param>
        /// <returns>The entry it gives the list (null: none).</returns>
        public SourceItem? Row(SourceRow row)
        {
            _pageRows++;
            Rows++;
            switch (row.Kind)
            {
                case SourceRowKind.Usable when !_keys.Add(row.Item!.Key!):
                    Repeated++;
                    break;
                case SourceRowKind.Excluded:
                    Excluded++;
                    break;
                case SourceRowKind.Malformed:
                    Malformed++;
                    break;
            }

            return row.Item;
        }

        /// <summary>Closes a page: the rows reported since the last page, and what the page said.</summary>
        /// <param name="pageCount">The page count it reported.</param>
        /// <param name="itemCount">The list's total it reported.</param>
        /// <param name="hasNext">IMDb <c>hasNextPage</c>.</param>
        /// <param name="cursor">IMDb <c>endCursor</c> (a cursor read before is drift).</param>
        /// <param name="errors">Errors next to the data.</param>
        public void Page(int? pageCount = null, int? itemCount = null, bool? hasNext = null, string? cursor = null, bool errors = false)
        {
            if (cursor != null && !_cursors.Add(cursor))
            {
                Drifted = true;
            }

            _pages.Add(new SourcePage(_pageRows, pageCount, itemCount, hasNext, cursor != null, errors));
            _pageRows = 0;
        }

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
    }

    /// <summary>
    /// When a list read is complete, per provider (review round 2, D53 rule 1; review round 3: about the snapshot). A read
    /// is complete only when every fact that proves the whole list was read holds, never because no known bad sign showed
    /// up: the provider's positive end below, AND every row read is one distinct usable key or a counted exclusion
    /// (<see cref="SourceRead.RowsSound"/>: no malformed row, no key read twice, no cursor read twice), with the rows the
    /// snapshot represents (<see cref="SourceRead.Represented"/>, never the transport's row count) equal to the total the
    /// source announced where it announces one. Anything less is partial (nothing may be removed on it) or truncated (JE
    /// stopped on purpose); an answer without the list it should carry is a typed failure before it gets here.
    /// <list type="bullet">
    /// <item><b>Offset lists</b> (TMDB lists; Trakt lists and watchlists), <see cref="OffsetList"/>: every page reports the
    /// page count and the list's total, the same on every page; the loop ended on the page count's last page; no page is
    /// empty (an empty list's single page aside); the rows represented equal the total; the list didn't move while it
    /// was read; no error.</item>
    /// <item><b>Charts</b> (TMDB and Seerr charts, Trakt charts), <see cref="Chart"/>: every page reports the page count and
    /// the total, the same on every page; no page is empty; no error; and either the chart's last page was read and the
    /// rows represented equal its total, or JE's chart window ended before the chart did.</item>
    /// <item><b>Cursor lists</b> (IMDb), <see cref="Cursor"/>: every page carries <c>pageInfo.hasNextPage</c> as a boolean
    /// and the same <c>total</c>; every page that says more follow is non-empty and has a cursor never seen before; the
    /// last page says <c>hasNextPage=false</c>; the rows represented equal the total; no GraphQL errors.</item>
    /// <item><b>MDBList</b>: the public JSON is one answer by the endpoint's contract: complete when it carries the list
    /// array, announces nothing more and is below the entry cap (<see cref="MdblistPublic"/>). The API reads one page of
    /// up to the cap: complete on an explicit <c>has_more=false</c>, or on a page shorter than the limit asked for
    /// (<see cref="MdblistApi"/>).</item>
    /// <item><b>One-answer sources</b> (TMDB and Seerr collections; Trakt's box office, which isn't paginated), <see cref="Whole"/>:
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
            var sound = pageCount is int && total is int && NoEmptyPage(pages, total) && read.RowsSound && !pages.Any(p => p.Errors);
            return read.End switch
            {
                SourceReadEnd.Last => new SourceVerdict(!(sound && pages.Count == System.Math.Max(pageCount!.Value, 1) && read.Represented == total), false),
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
            var sound = pageCount is int && total is int && NoEmptyPage(pages, total) && read.RowsSound && !pages.Any(p => p.Errors);
            var complete = read.End switch
            {
                SourceReadEnd.Last => sound && pages.Count == System.Math.Max(pageCount!.Value, 1) && read.Represented == total,
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
                && read.RowsSound
                && pages.All(p => p.HasNext is bool && !p.Errors)
                && pages.Where(p => p.HasNext == true).All(p => p.HasCursor && p.Rows > 0);
            return read.End switch
            {
                SourceReadEnd.Last => new SourceVerdict(!(sound && pages[^1].HasNext == false && read.Represented == total), false),
                SourceReadEnd.Cap or SourceReadEnd.PageLimit => new SourceVerdict(!sound, true),
                _ => new SourceVerdict(true, false),
            };
        }

        /// <summary>A one-answer source (collections, Trakt's box office): the answer's array, every row of it sound.</summary>
        /// <param name="read">The read (its one answer's rows).</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict Whole(SourceRead read) => new(!read.RowsSound, false);

        /// <summary>MDBList's public JSON (one answer).</summary>
        /// <param name="read">The read (its one answer's rows).</param>
        /// <param name="moreAnnounced">The answer announced more (a header or pagination).</param>
        /// <param name="cap">JE's entry cap.</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict MdblistPublic(SourceRead read, bool moreAnnounced, int cap) =>
            new(!read.RowsSound, moreAnnounced || read.Rows >= cap);

        /// <summary>The MDBList API's one page.</summary>
        /// <param name="read">The read (its one page's rows).</param>
        /// <param name="hasMore">The page's own answer to "more follow" (null: it didn't say).</param>
        /// <param name="limit">The limit asked for.</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict MdblistApi(SourceRead read, bool? hasMore, int limit) => new(!read.RowsSound, hasMore switch
        {
            true => true,
            false when read.Rows <= limit => false,
            null when read.Rows < limit => false, // a page shorter than the limit asked for is the last one
            _ => true,
        });

        /// <summary>A Chronolists watch order.</summary>
        /// <param name="list">The page's data.</param>
        /// <param name="read">The read (the page's entries).</param>
        /// <returns>The verdict.</returns>
        public static SourceVerdict Chronolists(ChronolistsList list, SourceRead read) =>
            new(list.Unusable > 0 || !read.RowsSound, list.Truncated || list.Total > list.Items.Count);

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
