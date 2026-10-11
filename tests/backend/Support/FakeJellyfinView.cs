using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace JE.Tests;

/// <summary>
/// An in-memory Jellyfin side for the status composer: users (role, policy, missing-episode
/// display), items with the users who may see them, copies per title key, and episodes/seasons
/// per series. Counts every call so tests can prove which surfaces touch Jellyfin.
/// </summary>
internal sealed class FakeJellyfinView : IArrJellyfinView
{
    public sealed record Item(JfItemRef Ref, HashSet<Guid>? VisibleTo);

    public Dictionary<Guid, StatusViewer> Users { get; } = new();
    public Dictionary<Guid, Item> Items { get; } = new();
    public Dictionary<string, List<(JfCopy Copy, HashSet<Guid>? VisibleTo)>> CopiesByKey { get; } = new();
    public Dictionary<Guid, List<(JfEpisode Episode, HashSet<Guid>? VisibleTo)>> EpisodesBySeries { get; } = new();
    public Dictionary<Guid, List<(JfSeason Season, HashSet<Guid>? VisibleTo)>> SeasonsBySeries { get; } = new();
    public long Rev { get; set; }
    public int EpisodeCalls { get; private set; }

    public long Revision => Rev;

    public StatusViewer AddUser(bool admin, string policy = "p", bool missing = false, bool parental = false)
    {
        var id = Guid.NewGuid();
        var viewer = new StatusViewer { UserId = id, IsAdmin = admin, PolicyRevision = policy + (admin ? "A" : "U"), DisplayMissingEpisodes = missing, HasParentalLimit = parental };
        Users[id] = viewer;
        return viewer;
    }

    public JfItemRef AddItem(JfItemRef item, params Guid[] visibleTo)
    {
        Items[item.ItemId] = new Item(item, visibleTo.Length == 0 ? null : visibleTo.ToHashSet());
        return item;
    }

    public void AddCopy(TitleKey key, JfCopy copy, params Guid[] visibleTo)
    {
        if (!CopiesByKey.TryGetValue(key.ToString(), out var list)) CopiesByKey[key.ToString()] = list = new();
        list.Add((copy, visibleTo.Length == 0 ? null : visibleTo.ToHashSet()));
    }

    public void AddEpisode(Guid seriesId, JfEpisode episode, params Guid[] visibleTo)
    {
        if (!EpisodesBySeries.TryGetValue(seriesId, out var list)) EpisodesBySeries[seriesId] = list = new();
        list.Add((episode, visibleTo.Length == 0 ? null : visibleTo.ToHashSet()));
    }

    public void AddSeason(Guid seriesId, JfSeason season, params Guid[] visibleTo)
    {
        if (!SeasonsBySeries.TryGetValue(seriesId, out var list)) SeasonsBySeries[seriesId] = list = new();
        list.Add((season, visibleTo.Length == 0 ? null : visibleTo.ToHashSet()));
    }

    public StatusViewer? Viewer(Guid userId) => Users.TryGetValue(userId, out var v) ? v : null;

    public JfItemRef? Resolve(Guid itemId, StatusViewer viewer)
        => Items.TryGetValue(itemId, out var item) && (item.VisibleTo == null || item.VisibleTo.Contains(viewer.UserId)) ? item.Ref : null;

    public IReadOnlyList<JfCopy> Copies(TitleKey titleKey, StatusViewer viewer)
        => CopiesByKey.TryGetValue(titleKey.ToString(), out var list)
            ? list.Select(c => new JfCopy { ItemId = c.Copy.ItemId, LibraryId = c.Copy.LibraryId, LibraryName = c.Copy.LibraryName, Path = c.Copy.Path, DateCreated = c.Copy.DateCreated, Visible = c.VisibleTo == null || c.VisibleTo.Contains(viewer.UserId) }).ToList()
            : new List<JfCopy>();

    public IReadOnlyList<JfEpisode> Episodes(Guid seriesItemId, int? season, StatusViewer viewer, bool includeVirtual)
    {
        EpisodeCalls++;
        if (!EpisodesBySeries.TryGetValue(seriesItemId, out var list)) return new List<JfEpisode>();
        bool Sees((JfEpisode Episode, HashSet<Guid>? VisibleTo) e) => e.VisibleTo == null || e.VisibleTo.Contains(viewer.UserId);
        var inSeason = list.Where(e => season == null || e.Episode.Season == season).ToList();
        var result = inSeason.Where(e => Sees(e) && (includeVirtual || !e.Episode.Virtual)).Select(e => e.Episode).ToList();
        // Like the real view: episodes (real or virtual, whatever includeVirtual says) hidden from a
        // viewer with parental limits, numbers only.
        if (!viewer.IsAdmin && viewer.HasParentalLimit)
            result.AddRange(inSeason.Where(e => !Sees(e)).Select(e => new JfEpisode { Season = e.Episode.Season, Episode = e.Episode.Episode, EpisodeEnd = e.Episode.EpisodeEnd, Virtual = e.Episode.Virtual, Hidden = true }));
        return result;
    }

    public IReadOnlyList<JfSeason> Seasons(Guid seriesItemId, StatusViewer viewer)
    {
        if (!SeasonsBySeries.TryGetValue(seriesItemId, out var list)) return new List<JfSeason>();
        bool Sees((JfSeason Season, HashSet<Guid>? VisibleTo) s) => s.VisibleTo == null || s.VisibleTo.Contains(viewer.UserId);
        var result = list.Where(Sees).Select(s => s.Season).ToList();
        // Like the real view: seasons hidden from a viewer with parental limits, numbers only.
        if (!viewer.IsAdmin && viewer.HasParentalLimit)
            result.AddRange(list.Where(s => !Sees(s) && !result.Any(r => r.Season == s.Season.Season)).Select(s => new JfSeason { Season = s.Season.Season, Hidden = true }));
        return result;
    }
}
