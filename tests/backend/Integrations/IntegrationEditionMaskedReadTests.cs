using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// Edition round 14: the masked read of a Sonarr copy (<see cref="ArrCopyRead"/>) leaves out every part its mask hides, in
/// every fact it gives (season statistics and the series' counts, episodes, queue rows and history, by number or by Sonarr
/// episode id), and reads the mask only when a fact that names a part is asked for.
/// </summary>
public class IntegrationEditionMaskedReadTests
{
    private static readonly ArrConnection Sonarr = new() { Id = "s", Kind = ArrKind.Sonarr, Name = "Sonarr", Role = "standard" };

    /// <summary>Season 1 (E1 with a file, E2 with a file, E3 none) and season 2 (E1 with a file); E2 and season 2 hidden.</summary>
    private static (ArrCopyFacts Copy, HiddenParts Mask) Show()
    {
        var series = new ArrSeriesEntry
        {
            Id = 1, Title = "Show", Monitored = true, Path = "/data/tv/Show", EpisodeFileCount = 3, EpisodeCount = 4, NextAiring = new DateTime(2030, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            Seasons = new[]
            {
                new ArrSeasonEntry { SeasonNumber = 1, Monitored = true, EpisodeFileCount = 2, EpisodeCount = 3, TotalEpisodeCount = 3 },
                new ArrSeasonEntry { SeasonNumber = 2, Monitored = true, EpisodeFileCount = 1, EpisodeCount = 1, TotalEpisodeCount = 1, NextAiring = new DateTime(2030, 1, 1, 0, 0, 0, DateTimeKind.Utc) },
            },
        };
        var episodes = new ArrEpisodesSnapshot(1, new[]
        {
            new ArrEpisodeEntry { Id = 11, SeasonNumber = 1, EpisodeNumber = 1, HasFile = true },
            new ArrEpisodeEntry { Id = 12, SeasonNumber = 1, EpisodeNumber = 2, HasFile = true },
            new ArrEpisodeEntry { Id = 13, SeasonNumber = 1, EpisodeNumber = 3 },
            new ArrEpisodeEntry { Id = 21, SeasonNumber = 2, EpisodeNumber = 1, HasFile = true },
        });
        var copy = new ArrCopyFacts(Sonarr)
        {
            Series = series,
            Episodes = episodes,
            Queue = new[]
            {
                new ArrQueueEntry { Id = 1, SeasonNumber = 1, EpisodeNumber = 2, EpisodeId = 12 },
                new ArrQueueEntry { Id = 2, EpisodeId = 12 }, // no numbers: known by its episode id
                new ArrQueueEntry { Id = 3, SeasonNumber = 2, EpisodeNumber = 1, EpisodeId = 21 },
                new ArrQueueEntry { Id = 4, SeasonNumber = 1, EpisodeNumber = 3, EpisodeId = 13 },
            },
            History = new[]
            {
                new ArrHistoryEntry { Id = 1, EventType = "downloadFolderImported", SeasonNumber = 1, EpisodeNumber = 2, EpisodeId = 12 },
                new ArrHistoryEntry { Id = 2, EventType = "downloadFailed", EpisodeId = 21 },
                new ArrHistoryEntry { Id = 3, EventType = "grabbed", SeasonNumber = 1, EpisodeNumber = 3, EpisodeId = 13 },
            },
        };
        var (_, mask) = StatusComposer.SplitHidden(
            new[] { new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, Hidden = true } },
            new[] { new JfSeason { ItemId = Guid.NewGuid(), Season = 2, Hidden = true } });
        return (copy, mask);
    }

    [Fact]
    public void EveryFactOfAMaskedReadLeavesOutWhatTheMaskHides()
    {
        var (copy, mask) = Show();
        var read = copy.Through(mask);
        // Statistics: no hidden season; the hidden episode (and its file) counts nowhere, in the season or the series.
        var season = Assert.Single(read.Series!.Seasons);
        Assert.Equal((1, 1, 2, 2), (season.SeasonNumber, season.EpisodeFileCount, season.EpisodeCount, season.TotalEpisodeCount));
        Assert.Equal((1, 2), (read.Series.EpisodeFileCount, read.Series.EpisodeCount));
        Assert.Null(read.Series.NextAiring); // the next airing was the hidden season's
        Assert.Equal(new[] { 11, 13 }, read.Episodes!.Episodes.Select(e => e.Id).ToArray());
        Assert.Null(read.Episodes.Find(1, 2));
        Assert.Equal(new[] { 4 }, read.Queue.Select(r => r.Id).ToArray());
        Assert.Equal(new[] { 3 }, read.History.Select(h => h.Id).ToArray());
        // Nothing hidden: the facts as Sonarr gives them.
        var open = copy.Through(HiddenParts.None);
        Assert.Equal((3, 4, 2), (open.Series!.EpisodeFileCount, open.Series.EpisodeCount, open.Series.Seasons.Count));
        Assert.Equal((4, 4, 3), (open.Episodes!.Episodes.Count, open.Queue.Count, open.History.Count));
    }

    [Fact]
    public void TheMaskIsReadOnlyWhenAFactNamingAPartIsAskedFor()
    {
        var reads = 0;
        var empty = new ArrCopyFacts(Sonarr) { Series = new ArrSeriesEntry { Id = 1, Title = "Show" } };
        Assert.Empty(empty.Through(() => { reads++; return HiddenParts.None; }).Queue);
        Assert.Equal(0, reads);
        var (copy, mask) = Show();
        var read = copy.Through(() => { reads++; return mask; });
        Assert.Equal(0, reads);
        Assert.Single(read.Queue);
        Assert.Single(read.Queue);
        Assert.Single(read.Series!.Seasons);
        Assert.Equal(1, reads);
    }

    [Fact]
    public void ARadarrCopyIsNeverMaskedAndASonarrCopyIsNeverReadUnmasked()
    {
        var radarr = new ArrCopyFacts(new ArrConnection { Id = "r", Kind = ArrKind.Radarr, Name = "Radarr" }) { Movie = new ArrMovieEntry { Id = 1, Title = "Movie" }, Queue = new[] { new ArrQueueEntry { Id = 1 } } };
        Assert.Single(radarr.Radarr().Queue);
        Assert.Throws<InvalidOperationException>(() => radarr.Through(HiddenParts.None));
        var (sonarr, _) = Show();
        Assert.Throws<InvalidOperationException>(() => sonarr.Radarr());
        // What stays readable on the facts names the copy, never an episode.
        Assert.True(sonarr.IsSeries && sonarr.EpisodesInMemory && sonarr.HasDownloads);
        Assert.Equal("/data/tv/Show", sonarr.Path);
        Assert.Equal(new[] { 1, 2 }, sonarr.MonitoredSeasons.ToArray());
    }
}
