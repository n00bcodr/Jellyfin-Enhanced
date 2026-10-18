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

    /// <summary>
    /// When set, the copies Jellyfin returns are the production lookup's (<see cref="FakeJellyfinLibrary"/> under the real
    /// <see cref="ArrJellyfinView"/>), so its bounds apply; the viewer's visibility still comes from this fake.
    /// </summary>
    public ArrJellyfinView? Production { get; set; }

    /// <summary>The complete copy lookup can't be made now (completeness unknown).</summary>
    public bool CopiesUnknown { get; set; }

    /// <summary>Every physical copy of the title (the key and its aliases of the same kind), complete; null when unknown.</summary>
    public IReadOnlyList<Guid>? TitleCopyIds(TitleKey titleKey, IReadOnlyCollection<TitleKey>? aliases = null)
    {
        if (CopiesUnknown) return null;
        if (Production != null) return Production.TitleCopyIds(titleKey, aliases);
        var keys = new[] { titleKey }.Concat(aliases ?? Array.Empty<TitleKey>()).Where(k => k.IsMovie == titleKey.IsMovie).Select(k => k.Title.ToString()).Distinct();
        return keys.SelectMany(k => CopiesByKey.TryGetValue(k, out var list) ? list.Select(c => c.Copy.ItemId) : Enumerable.Empty<Guid>()).Distinct().ToList();
    }

    /// <summary>Copies carrying the key or any alias of the same kind (Jellyfin's "any provider id"), once per item.</summary>
    public IReadOnlyList<JfCopy> Copies(TitleKey titleKey, StatusViewer viewer, IReadOnlyCollection<TitleKey>? aliases = null)
    {
        OnCopies?.Invoke();
        var returned = Production?.Copies(titleKey, StatusViewer.Library, aliases).Select(c => c.ItemId).ToHashSet();
        var keys = new[] { titleKey }.Concat(aliases ?? Array.Empty<TitleKey>()).Where(k => k.IsMovie == titleKey.IsMovie).Select(k => k.Title.ToString()).Distinct().ToList();
        CopyQueries.Add(keys);
        var seen = new HashSet<Guid>();
        var result = new List<JfCopy>();
        foreach (var key in keys)
        {
            if (!CopiesByKey.TryGetValue(key, out var list)) continue;
            foreach (var c in list)
            {
                if ((returned != null && !returned.Contains(c.Copy.ItemId)) || !seen.Add(c.Copy.ItemId)) continue;
                result.Add(new JfCopy { ItemId = c.Copy.ItemId, LibraryId = c.Copy.LibraryId, LibraryName = c.Copy.LibraryName, Path = c.Copy.Path, DateCreated = c.Copy.DateCreated, Visible = viewer.IsLibraryContext || c.VisibleTo == null || c.VisibleTo.Contains(viewer.UserId) });
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

    // ------------------------------------------------------------------ media sources (versions)

    /// <summary>
    /// The media sources of movie and episode items, the way Jellyfin's GetMediaSources lists them: one per version
    /// (file), each with its own id and video dimensions. An item with a file but no registered source has one
    /// source whose dimensions Jellyfin hasn't read (the fake's default, so older tests keep a playable copy).
    /// </summary>
    public Dictionary<Guid, List<JfSource>> SourcesByItem { get; } = new();

    /// <summary>
    /// True when this build's Jellyfin keeps an episode's second file as a version of the first episode item (12.x:
    /// supportMultiEditions); false on 10.11, which lists it as a second episode item of the same number.
    /// </summary>
#if JF12
    public static bool EpisodeVersionsOnOneItem => true;
#else
    public static bool EpisodeVersionsOnOneItem => false;
#endif

    /// <summary>Adds a version (one file) to a movie or episode item: its own source id, dimensions and path.</summary>
    public JfSource AddSource(Guid itemId, int? width, int? height, string? path = null, DateTime? created = null)
    {
        if (!SourcesByItem.TryGetValue(itemId, out var list)) SourcesByItem[itemId] = list = new();
        // The first file is the item's own; another is a version with its own item (Jellyfin's alternate version).
        var id = list.Count == 0 ? itemId : Guid.NewGuid();
        var source = new JfSource { SourceId = id, ItemId = itemId, BackingItemId = id, Width = width, Height = height, Path = path, DateCreated = created };
        list.Add(source);
        Rev++;
        return source;
    }

    /// <summary>
    /// A file of one episode imported into exactly one series item's folder, as Jellyfin adds it: the first file
    /// is a new episode item; another file of the same number in the same series item is a version of that item on
    /// 12.x and a second episode item on 10.11. Returns the episode item the file is listed under.
    /// </summary>
    public Guid AddEpisodeFile(Guid seriesId, TitleKey seriesKey, int season, int episode, int? width, int? height, DateTime? created = null, int? episodeEnd = null)
    {
        var path = $"/media/{seriesId:N}/S{season:00}E{episode:00} {width}x{height}.mkv";
        if (EpisodeVersionsOnOneItem && EpisodesBySeries.TryGetValue(seriesId, out var existing)
            && existing.FirstOrDefault(e => !e.Episode.Virtual && e.Episode.ItemId != Guid.Empty && e.Episode.Season == season && e.Episode.Episode == episode) is { Episode: { } primary })
        {
            AddSource(primary.ItemId, width, height, path, created);
            return primary.ItemId;
        }
        var id = Guid.NewGuid();
        AddItem(new JfItemRef { ItemId = id, Kind = "episode", Key = seriesKey.WithEpisode(season, episode), SeriesId = seriesId, Season = season, Episode = episode, EpisodeEnd = episodeEnd, Path = path, DateCreated = created });
        AddEpisode(seriesId, new JfEpisode { ItemId = id, Season = season, Episode = episode, EpisodeEnd = episodeEnd, DateCreated = created });
        AddSource(id, width, height, path, created);
        return id;
    }

    /// <summary>The item's sources: the registered ones, else one unread source for an item with a file.</summary>
    private IReadOnlyList<JfSource> SourcesOf(Guid itemId, DateTime? created)
        => SourcesByItem.TryGetValue(itemId, out var list) ? list : new[] { new JfSource { SourceId = itemId, ItemId = itemId, BackingItemId = itemId, DateCreated = created } };

    /// <summary>Like Jellyfin: the sources of a movie or episode with a file the viewer can open.</summary>
    public IReadOnlyList<JfSource> Sources(Guid itemId, StatusViewer viewer)
    {
        bool Sees(HashSet<Guid>? to) => viewer.IsLibraryContext || to == null || to.Contains(viewer.UserId);
        if (Items.TryGetValue(itemId, out var item))
        {
            if (!Sees(item.VisibleTo) || item.Ref.Virtual || item.Ref.Kind is not ("movie" or "episode")) return Array.Empty<JfSource>();
            if (item.Ref.SeriesId is Guid series && !viewer.IsLibraryContext && !SeesSeries(series, viewer)) return Array.Empty<JfSource>();
            return SourcesOf(itemId, item.Ref.DateCreated);
        }
        foreach (var list in CopiesByKey.Values)
        {
            foreach (var (copy, to) in list)
            {
                if (copy.ItemId == itemId && Sees(to)) return SourcesOf(itemId, copy.DateCreated);
            }
        }
        return Array.Empty<JfSource>();
    }

    /// <summary>Like Jellyfin's ancestry query: exactly this series item's episodes with a file the viewer can open, with their sources.</summary>
    public IReadOnlyList<JfEpisodeSources> EpisodeSources(Guid seriesItemId, int? season, StatusViewer viewer, bool readDimensions = true)
    {
        bool Sees(HashSet<Guid>? to) => viewer.IsLibraryContext || to == null || to.Contains(viewer.UserId);
        if ((!viewer.IsLibraryContext && !SeesSeries(seriesItemId, viewer)) || !EpisodesBySeries.TryGetValue(seriesItemId, out var list)) return Array.Empty<JfEpisodeSources>();
        return list.Where(e => !e.Episode.Virtual && !e.Episode.Hidden && e.Episode.ItemId != Guid.Empty && (season == null || e.Episode.Season == season)
                && Sees(e.VisibleTo) && (!Items.TryGetValue(e.Episode.ItemId, out var item) || Sees(item.VisibleTo)))
            .Select(e => new JfEpisodeSources { ItemId = e.Episode.ItemId, Season = e.Episode.Season, Episode = e.Episode.Episode, EpisodeEnd = e.Episode.EpisodeEnd, Sources = SourcesOf(e.Episode.ItemId, e.Episode.DateCreated) })
            .ToList();
    }

    /// <summary>Like Jellyfin's presentation key: the other series items grouped with this one that the viewer can open.</summary>
    public IReadOnlyList<Guid> GroupedSeries(Guid seriesItemId, StatusViewer viewer)
        => PresentationGroups.FirstOrDefault(g => g.Contains(seriesItemId)) is { } group
            ? group.Where(id => id != seriesItemId && SeesSeries(id, viewer)).ToList()
            : new List<Guid>();

    /// <summary>Movie or episode items and the ids of items whose files Jellyfin now keeps as their versions.</summary>
    public Dictionary<Guid, HashSet<Guid>> FormerItemsOf { get; } = new();

    public Guid? VersionHolder(Guid itemId, IReadOnlyList<Guid> candidates, StatusViewer viewer)
        => candidates.FirstOrDefault(c => FormerItemsOf.TryGetValue(c, out var former) && former.Contains(itemId) && Resolve(c, viewer) != null) is var holder && holder != Guid.Empty ? holder : null;
}
