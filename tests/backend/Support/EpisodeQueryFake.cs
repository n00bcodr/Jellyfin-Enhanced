using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using JSortOrder = Jellyfin.Database.Implementations.Enums.SortOrder;

namespace JE.Tests;

/// <summary>
/// Answers library queries over a fixed set of episodes the way Jellyfin's item
/// repository does for the fields the Status Tags lookups use: parent (season
/// or series), premiere date range, season/episode numbers, ordering (unset
/// values sort first ascending, last descending, as in SQLite), paging and
/// id-only queries. Counts every episode it hands out as materialised.
/// </summary>
internal sealed class EpisodeQueryFake(IEnumerable<Episode> episodes)
{
    private readonly Episode[] _episodes = episodes.ToArray();

    /// <summary>Episodes returned by item (not id-only) queries so far.</summary>
    public int Materialised { get; private set; }

    /// <summary>Item queries run so far.</summary>
    public int Queries { get; private set; }

    public IReadOnlyList<BaseItem> List(InternalItemsQuery query)
    {
        Queries++;
        var page = Select(query).ToArray();
        Materialised += page.Length;
        return page;
    }

    public IReadOnlyList<Guid> Ids(InternalItemsQuery query) => Select(query).Select(e => e.Id).ToArray();

    private IEnumerable<Episode> Select(InternalItemsQuery q)
    {
        if (q.IncludeItemTypes.Length > 0 && !q.IncludeItemTypes.Contains(BaseItemKind.Episode)) return [];
        IEnumerable<Episode> found = _episodes.Where(e => q.ParentId == Guid.Empty || e.SeasonId == q.ParentId || e.SeriesId == q.ParentId);
        if (q.MinPremiereDate is { } min) found = found.Where(e => e.PremiereDate >= min);
        if (q.MaxPremiereDate is { } max) found = found.Where(e => e.PremiereDate <= max);
        if (q.ParentIndexNumber is { } season) found = found.Where(e => e.ParentIndexNumber == season);
        if (q.IndexNumber is { } number) found = found.Where(e => e.IndexNumber == number);
        IOrderedEnumerable<Episode>? ordered = null;
        foreach (var (by, order) in q.OrderBy)
        {
            Func<Episode, IComparable?> key = by switch
            {
                ItemSortBy.PremiereDate => e => e.PremiereDate,
                ItemSortBy.DateCreated => e => e.DateCreated,
                ItemSortBy.ParentIndexNumber => e => e.ParentIndexNumber,
                ItemSortBy.IndexNumber => e => e.IndexNumber,
                _ => throw new NotSupportedException(by.ToString()),
            };
            var comparer = Comparer<IComparable?>.Create((a, b) => a == null ? (b == null ? 0 : -1) : b == null ? 1 : a.CompareTo(b));
            ordered = ordered == null
                ? order == JSortOrder.Descending ? found.OrderByDescending(key, comparer) : found.OrderBy(key, comparer)
                : order == JSortOrder.Descending ? ordered.ThenByDescending(key, comparer) : ordered.ThenBy(key, comparer);
        }

        found = ordered ?? found;
        if (q.StartIndex is { } start) found = found.Skip(start);
        if (q.Limit is { } limit) found = found.Take(limit);
        return found;
    }
}
