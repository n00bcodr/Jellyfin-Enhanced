using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace JE.Tests;

/// <summary>The physical folder read of <see cref="FakeJellyfinView"/> (<see cref="IArrJellyfinView.SeriesFolder"/>).</summary>
internal sealed partial class FakeJellyfinView
{
    /// <summary>
    /// Like the real view's ancestry query: exactly this series item's own episodes and seasons, never another series item
    /// <see cref="PresentationGroups"/> groups with it; missing episodes included; for a viewer with parental limits also the
    /// ones hidden from them, numbers only.
    /// </summary>
    public JfSeriesFolder SeriesFolder(Guid seriesItemId, StatusViewer viewer)
    {
        EpisodeCalls++;
        Read(seriesItemId);
        OnEpisodes?.Invoke();
        if (FailEpisodesOf == seriesItemId) throw new InvalidOperationException("library query failed");
        if (Withdrawn(seriesItemId, viewer)) return JfSeriesFolder.Empty;
        var parental = !viewer.IsAdmin && viewer.HasParentalLimit;
        var episodes = EpisodesBySeries.TryGetValue(seriesItemId, out var e) ? e : new();
        var seasons = SeasonsBySeries.TryGetValue(seriesItemId, out var s) ? s : new();
        bool Sees(Guid id, HashSet<Guid>? to) => (to == null || to.Contains(viewer.UserId)) && !Withdrawn(id, viewer);
        var shownEpisodes = episodes.Where(x => Sees(x.Episode.ItemId, x.VisibleTo)).Select(x => Shown(x.Episode)).ToList();
        if (parental)
            shownEpisodes.AddRange(episodes.Where(x => !Sees(x.Episode.ItemId, x.VisibleTo)).Select(x => new JfEpisode { Season = x.Episode.Season, Episode = x.Episode.Episode, EpisodeEnd = x.Episode.EpisodeEnd, Virtual = x.Episode.Virtual, Hidden = true }));
        var shownSeasons = seasons.Where(x => Sees(x.Season.ItemId, x.VisibleTo)).Select(x => x.Season).ToList();
        if (parental)
            shownSeasons.AddRange(seasons.Where(x => !Sees(x.Season.ItemId, x.VisibleTo) && !shownSeasons.Any(r => r.Season == x.Season.Season)).Select(x => new JfSeason { Season = x.Season.Season, Hidden = true }));
        return new JfSeriesFolder { Episodes = shownEpisodes, Seasons = shownSeasons };
    }
}
