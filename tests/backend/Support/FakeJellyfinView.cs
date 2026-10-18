using Jellyfin.Data;
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

    /// <summary>
    /// Jellyfin's automatic series grouping: series items of one group share a presentation key, and
    /// Jellyfin's own season and episode lists of any of them (Series.GetSeasons / GetEpisodes, which query
    /// by that key) hold every member's children, the other copies' first. Off (no groups) by default.
    /// </summary>
    public List<Guid[]> PresentationGroups { get; } = new();

    /// <summary>Groups series items the way automatic series grouping does (one presentation key).</summary>
    public void GroupSeries(params Guid[] seriesItemIds) => PresentationGroups.Add(seriesItemIds);

    /// <summary>The series items Jellyfin's grouped lists of this one cover: the other copies first, then itself.</summary>
    private IEnumerable<Guid> Presented(Guid seriesItemId)
        => PresentationGroups.FirstOrDefault(g => g.Contains(seriesItemId)) is { } group
            ? group.Where(id => id != seriesItemId).Append(seriesItemId)
            : new[] { seriesItemId };

    public long Revision => Rev;

    public StatusViewer AddUser(bool admin, string policy = "p", bool missing = false, bool parental = false)
    {
        var id = Guid.NewGuid();
        var user = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = id };
        user.SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, true);
        var viewer = new StatusViewer { UserId = id, IsAdmin = admin, PolicyRevision = policy + (admin ? "A" : "U"), DisplayMissingEpisodes = missing, HasParentalLimit = parental, Handle = user };
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

    /// <summary>
    /// Also resolve the ids of copies, episodes and seasons (with their visibility), like Jellyfin's
    /// own lookup; off by default so status tests only resolve what they added as items.
    /// </summary>
    public bool ResolveAnyItem { get; init; }

    /// <summary>Runs on every viewer lookup (tests use it to make something happen right after a user was checked).</summary>
    public Action<Guid>? OnViewer { get; set; }

    /// <summary>A prerequisite-read barrier for final authorization race tests.</summary>
    public Action? OnCopies { get; set; }

    public StatusViewer? Viewer(Guid userId)
    {
        OnViewer?.Invoke(userId);
        return Users.TryGetValue(userId, out var v) ? v : null;
    }

    public JfItemRef? Resolve(Guid itemId, StatusViewer viewer)
    {
        if (Items.TryGetValue(itemId, out var item)) return item.VisibleTo == null || item.VisibleTo.Contains(viewer.UserId) ? item.Ref : null;
        if (!ResolveAnyItem) return null;
        bool Sees(HashSet<Guid>? to) => to == null || to.Contains(viewer.UserId);
        foreach (var list in CopiesByKey.Values)
        {
            foreach (var (copy, to) in list)
            {
                if (copy.ItemId == itemId && Sees(to)) return new JfItemRef { ItemId = itemId, Kind = "copy", Path = copy.Path };
            }
        }
        foreach (var (series, list) in EpisodesBySeries)
        {
            foreach (var (episode, to) in list)
            {
                // An episode is seen when the viewer sees it and a copy of its series.
                if (episode.ItemId == itemId && Sees(to) && SeesSeries(series, viewer)) return new JfItemRef { ItemId = itemId, Kind = "episode", SeriesId = series, Season = episode.Season, Episode = episode.Episode, EpisodeEnd = episode.EpisodeEnd, Virtual = episode.Virtual };
            }
        }
        foreach (var (series, list) in SeasonsBySeries)
        {
            foreach (var (season, to) in list)
            {
                if (season.ItemId == itemId && Sees(to) && SeesSeries(series, viewer)) return new JfItemRef { ItemId = itemId, Kind = "season", SeriesId = series, Season = season.Season };
            }
        }
        return null;
    }

    private bool SeesSeries(Guid seriesItemId, StatusViewer viewer)
    {
        var copies = CopiesByKey.Values.SelectMany(l => l).Where(c => c.Copy.ItemId == seriesItemId).ToList();
        return copies.Count == 0 || copies.Any(c => c.VisibleTo == null || c.VisibleTo.Contains(viewer.UserId));
    }

    /// <summary>The keys every Copies call looked for (the key first, then its aliases of the same kind).</summary>
    public List<IReadOnlyList<string>> CopyQueries { get; } = new();

    /// <summary>Copies carrying the key or any alias of the same kind (Jellyfin's "any provider id"), once per item.</summary>
    public IReadOnlyList<JfCopy> Copies(TitleKey titleKey, StatusViewer viewer, IReadOnlyCollection<TitleKey>? aliases = null)
    {
        OnCopies?.Invoke();
        var keys = new[] { titleKey }.Concat(aliases ?? Array.Empty<TitleKey>()).Where(k => k.IsMovie == titleKey.IsMovie).Select(k => k.Title.ToString()).Distinct().ToList();
        CopyQueries.Add(keys);
        var seen = new HashSet<Guid>();
        var result = new List<JfCopy>();
        foreach (var key in keys)
        {
            if (!CopiesByKey.TryGetValue(key, out var list)) continue;
            foreach (var c in list)
            {
                if (!seen.Add(c.Copy.ItemId)) continue;
                result.Add(new JfCopy { ItemId = c.Copy.ItemId, LibraryId = c.Copy.LibraryId, LibraryName = c.Copy.LibraryName, Path = c.Copy.Path, DateCreated = c.Copy.DateCreated, Visible = c.VisibleTo == null || c.VisibleTo.Contains(viewer.UserId) });
            }
        }
        return result;
    }

    /// <summary>Runs on every episode lookup (tests use it to make something happen mid-way).</summary>
    public Action? OnEpisodes { get; set; }

    /// <summary>Episode lookups of this series item throw (a library query failing for one title).</summary>
    public Guid? FailEpisodesOf { get; set; }

    public IReadOnlyList<JfEpisode> Episodes(Guid seriesItemId, int? season, StatusViewer viewer, bool includeVirtual)
    {
        EpisodeCalls++;
        OnEpisodes?.Invoke();
        if (FailEpisodesOf == seriesItemId) throw new InvalidOperationException("library query failed");
        var list = Presented(seriesItemId).SelectMany(id => EpisodesBySeries.TryGetValue(id, out var l) ? l : new()).ToList();
        if (list.Count == 0) return new List<JfEpisode>();
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
        var list = Presented(seriesItemId).SelectMany(id => SeasonsBySeries.TryGetValue(id, out var l) ? l : new()).ToList();
        if (list.Count == 0) return new List<JfSeason>();
        bool Sees((JfSeason Season, HashSet<Guid>? VisibleTo) s) => s.VisibleTo == null || s.VisibleTo.Contains(viewer.UserId);
        var result = list.Where(Sees).Select(s => s.Season).ToList();
        // Like the real view: seasons hidden from a viewer with parental limits, numbers only.
        if (!viewer.IsAdmin && viewer.HasParentalLimit)
            result.AddRange(list.Where(s => !Sees(s) && !result.Any(r => r.Season == s.Season.Season)).Select(s => new JfSeason { Season = s.Season.Season, Hidden = true }));
        return result;
    }

    /// <summary>Like Jellyfin's ancestry query: only this series item's own seasons or episodes, whoever may see them.</summary>
    public IReadOnlyList<Guid> SeriesParts(Guid seriesItemId, int season, int? episode, StatusViewer viewer)
    {
        if (episode is int n)
        {
            EpisodeCalls++;
            OnEpisodes?.Invoke();
            if (FailEpisodesOf == seriesItemId) throw new InvalidOperationException("library query failed");
            return EpisodesBySeries.TryGetValue(seriesItemId, out var episodes)
                ? episodes.Where(e => e.Episode.ItemId != Guid.Empty && e.Episode.Season == season && new EpisodeRange(e.Episode.Episode, e.Episode.EpisodeEnd).Contains(n)).Select(e => e.Episode.ItemId).ToList()
                : new List<Guid>();
        }
        return SeasonsBySeries.TryGetValue(seriesItemId, out var seasons)
            ? seasons.Where(s => s.Season.ItemId != Guid.Empty && s.Season.Season == season).Select(s => s.Season.ItemId).ToList()
            : new List<Guid>();
    }

    /// <summary>Movie or episode items and the ids of items whose files Jellyfin now keeps as their versions.</summary>
    public Dictionary<Guid, HashSet<Guid>> FormerItemsOf { get; } = new();

    public Guid? VersionHolder(Guid itemId, IReadOnlyList<Guid> candidates, StatusViewer viewer)
        => candidates.FirstOrDefault(c => FormerItemsOf.TryGetValue(c, out var former) && former.Contains(itemId) && Resolve(c, viewer) != null) is var holder && holder != Guid.Empty ? holder : null;
}
