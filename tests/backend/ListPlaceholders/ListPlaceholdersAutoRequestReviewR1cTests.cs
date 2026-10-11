using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using static JE.Tests.ListPlaceholdersHarness;
using R = Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.ListPlaceholderAutoRequestRules;

namespace JE.Tests;

// Review round 1 (F13, F15): the collection anchor's specificity and the season a series placeholder requests.
public class ListPlaceholdersAutoRequestReviewR1cTests
{
    [Fact]
    public void CollectionWindowAnchorsAtTheMostSpecificEntryInTheCollection()
    {
        Guid series = Guid.NewGuid(), season = Guid.NewGuid(), episode = Guid.NewGuid();
        var early = Ph("{\"kind\":\"movie\",\"tmdbId\":1,\"title\":\"2013\",\"releaseDate\":\"2013-06-01\"}");
        var middle = Ph("{\"kind\":\"movie\",\"tmdbId\":2,\"title\":\"2014\",\"releaseDate\":\"2014-06-01\"}");
        var late = Ph("{\"kind\":\"movie\",\"tmdbId\":3,\"title\":\"2015\",\"releaseDate\":\"2015-01-01\"}");
        var placeholders = new List<Placeholder> { early, middle, late };
        var real = new List<DatedEntry>
        {
            new(series, new DateTime(2012, 10, 10)),
            new(season, new DateTime(2014, 1, 1)),
            new(episode, new DateTime(2014, 12, 3)),
        };

        // The episode is in the collection: it anchors, however much earlier its series or season sorts.
        Assert.Equal(new[] { late.Id }, R.CollectionWindow(real, placeholders, new List<Guid> { episode, season, series }));
        // Without the episode, its season; without that either, its series.
        Assert.Equal(new[] { middle.Id, late.Id }, R.CollectionWindow(real.Where(e => e.ItemId != episode).ToList(), placeholders, new List<Guid> { episode, season, series }));
        Assert.Equal(new[] { early.Id, middle.Id, late.Id }, R.CollectionWindow(real.Where(e => e.ItemId == series).ToList(), placeholders, new List<Guid> { episode, season, series }));
    }

    [Fact]
    public void ASeriesPlaceholderRequestsSeasonOneHoweverMuchOfItIsInTheList()
    {
        var series = Ph("{\"kind\":\"series\",\"tmdbId\":5,\"title\":\"Show\"}");
        series.Expected = new List<PlaceholderEpisode>
        {
            new() { S = 1, E = 1, AirDate = "2020-01-01" },
            new() { S = 2, E = 1, AirDate = "2021-01-01" },
            new() { S = 3, E = 1, AirDate = "2999-01-01" },
        };
        series.Filled = new List<FilledEpisode> { Fill(1, 1) };
        Assert.Equal(1, R.RequestSeason(series));
        series.Filled.Add(Fill(2, 1));
        Assert.Equal(1, R.RequestSeason(series)); // every aired episode in the list: still season 1, never null

        // Expected set not known yet: Seerr's seasons only decide whether there is a season 1.
        var pending = Ph("{\"kind\":\"series\",\"tmdbId\":5,\"title\":\"Show\"}");
        pending.Filled = new List<FilledEpisode> { Fill(1, 1), Fill(1, 2) };
        using var counts = JsonDocument.Parse("{\"seasons\":[{\"seasonNumber\":1,\"episodeCount\":2,\"airDate\":\"2020-01-01\"},{\"seasonNumber\":2,\"episodeCount\":8,\"airDate\":\"2021-01-01\"}]}");
        Assert.Equal(1, R.RequestSeason(pending, counts.RootElement));
        Assert.True(R.SeasonDependsOnSeerrDetails(pending));
        Assert.False(R.SeasonDependsOnSeerrDetails(series));
    }

    private static FilledEpisode Fill(int s, int e) => new() { ItemId = Guid.NewGuid().ToString("N"), S = s, E = e };
}
