using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using static JE.Tests.ListPlaceholdersHarness;

namespace JE.Tests;

// C1 granularity resolver and the C3 completion rule.
[Collection("Plugin singleton")]
public class ListPlaceholdersResolverTests
{
    private const string Past = "2020-01-01";
    private const string Future = "2099-01-01";

    private static Placeholder Season(int tmdb, int season) =>
        Ph($"{{\"kind\":\"season\",\"tmdbId\":{tmdb},\"seasonNumber\":{season},\"title\":\"Show S{season}\"}}");

    private static Placeholder Series(int tmdb) => Ph($"{{\"kind\":\"series\",\"tmdbId\":{tmdb},\"title\":\"Show\"}}");

    private static Placeholder EpisodesOf(int tmdb, int season, params int[] episodes) =>
        Ph($"{{\"kind\":\"episodes\",\"tmdbId\":{tmdb},\"seasonNumber\":{season},\"title\":\"Show\",\"episodes\":[{string.Join(',', episodes.Select(e => $"{{\"s\":{season},\"e\":{e}}}"))}]}}");

    private static PlaceholderEpisode Ep(int s, int e, string? air) => new() { S = s, E = e, AirDate = air };

    private static FilledEpisode F(int s, int e) => new() { ItemId = Guid.NewGuid().ToString("N"), S = s, E = e };

    [Fact]
    public void PlaylistsOnlyEverGetSortedRealEpisodesWhileCollectionsGetTheFolders()
    {
        using var h = new ListPlaceholdersHarness();
        var series = h.Host.AddSeries(tmdb: 100);
        var s1e2 = h.Host.AddEpisode(series, 1, 2);
        var s1e1 = h.Host.AddEpisode(series, 1, 1);
        var special = h.Host.AddEpisode(series, 0, 1);
        var s2e1 = h.Host.AddEpisode(series, 2, 1);
        h.Host.AddEpisode(series, 2, 2, isVirtual: true); // "missing episode" metadata, no file
        // The same show in a second library: its S1E1 copy must not double the episode, its S2E2 fills the gap.
        var copy = h.Host.AddSeries(tmdb: 100);
        h.Host.AddEpisode(copy, 1, 1);
        var copyS2e2 = h.Host.AddEpisode(copy, 2, 2);

        var whole = h.Resolver.Resolve(Series(100), ListKinds.Playlist, Array.Empty<Jellyfin.Database.Implementations.Entities.User>());
        Assert.Equal(new[] { s1e1, s1e2, s2e1, copyS2e2 }, whole.Items.Select(i => i.ItemId));
        Assert.All(whole.Items, i => Assert.Equal(BaseItemKind.Episode, i.Kind));
        Assert.DoesNotContain(whole.Items, i => i.ItemId == special); // specials aren't part of a whole series

        var season = h.Resolver.Resolve(Season(100, 1), ListKinds.Playlist, Array.Empty<Jellyfin.Database.Implementations.Entities.User>());
        Assert.Equal(new[] { s1e1, s1e2 }, season.Items.Select(i => i.ItemId));

        var collectionSeries = h.Resolver.Resolve(Series(100), ListKinds.Collection, Array.Empty<Jellyfin.Database.Implementations.Entities.User>());
        Assert.Equal(BaseItemKind.Series, Assert.Single(collectionSeries.Items).Kind);

        var collectionSeason = h.Resolver.Resolve(Season(100, 1), ListKinds.Collection, Array.Empty<Jellyfin.Database.Implementations.Entities.User>());
        Assert.Equal(h.Host.Seasons[(series, 1)].Id, Assert.Single(collectionSeason.Items).ItemId);
        Assert.Equal(new[] { s1e1, s1e2 }, collectionSeason.Episodes.Select(e => e.ItemId));

        // Specials can still be asked for explicitly.
        Assert.Equal(new[] { special }, h.Resolver.Resolve(Season(100, 0), ListKinds.Playlist, Array.Empty<Jellyfin.Database.Implementations.Entities.User>()).Items.Select(i => i.ItemId));
    }

    [Fact]
    public void EpisodesScopesMatchByCoordinatesIncludingMultiEpisodeFilesAndOnlyWhatEveryUserCanSee()
    {
        using var h = new ListPlaceholdersHarness();
        var caller = h.NewUser("caller");
        var owner = h.NewUser("owner");
        var series = h.Host.AddSeries(tvdb: 555); // matched through the TVDB id only
        var double89 = h.Host.AddEpisode(series, 1, 8, episodeEnd: 9);
        var e10 = h.Host.AddEpisode(series, 1, 10);
        h.Host.AddEpisode(series, 1, 11);
        var placeholder = EpisodesOf(1, 1, 9, 10, 12);
        placeholder.TvdbId = 555;

        var both = h.Resolver.Resolve(placeholder, ListKinds.Playlist, new[] { caller, owner });
        Assert.Equal(new[] { double89, e10 }, both.Items.Select(i => i.ItemId));
        Assert.Equal(new[] { new EpisodeCoord(1, 9) }, both.Items[0].Coords); // only the listed part of the double episode

        h.Host.Hide(e10, owner);
        Assert.Equal(new[] { double89 }, h.Resolver.Resolve(placeholder, ListKinds.Playlist, new[] { caller, owner }).Items.Select(i => i.ItemId));
        Assert.False(h.Resolver.Resolve(Season(999, 1), ListKinds.Playlist, new[] { caller }).Found);
        Assert.False(h.Resolver.Resolve(Ph("{\"kind\":\"custom\",\"title\":\"x\"}"), ListKinds.Playlist, new[] { caller }).Found);
    }

    [Fact]
    public void MoviesMatchByTmdbOrImdbAndACollectionSeasonNeedsARealEpisode()
    {
        using var h = new ListPlaceholdersHarness();
        var viewer = h.NewUser("viewer");
        var byImdb = h.Host.AddMovie(imdb: "tt0770828");
        var movie = Movie(49521);
        movie.ImdbId = "tt0770828";
        Assert.Equal(byImdb, Assert.Single(h.Resolver.Resolve(movie, ListKinds.Playlist, new[] { viewer }).Items).ItemId);
        h.Host.Hide(byImdb, viewer);
        Assert.False(h.Resolver.Resolve(movie, ListKinds.Playlist, new[] { viewer }).Found);

        // Only a virtual season (missing-episode metadata): nothing to add yet.
        var series = h.Host.AddSeries(tmdb: 7);
        h.Host.AddEpisode(series, 3, 1, isVirtual: true);
        var resolution = h.Resolver.Resolve(Season(7, 3), ListKinds.Collection, Array.Empty<Jellyfin.Database.Implementations.Entities.User>());
        Assert.False(resolution.Found);
        Assert.Empty(resolution.Episodes);
    }

    [Fact]
    public void TheCompletionRuleKeepsAiringAndUnknownSeasonsAndRetiresFinishedOnes()
    {
        var today = new DateTime(2026, 10, 10, 0, 0, 0, DateTimeKind.Utc);
        var episodes = EpisodesOf(1, 1, 8, 9);
        episodes.Filled = new() { F(1, 8) };
        Assert.False(PlaceholderProgress.IsComplete(episodes, today));
        episodes.Filled.Add(F(1, 9));
        Assert.True(PlaceholderProgress.IsComplete(episodes, today));

        var airing = Season(1, 1);
        airing.InProduction = true;
        airing.Expected = new() { Ep(1, 1, Past), Ep(1, 2, Past), Ep(1, 3, Future) };
        airing.Filled = new() { F(1, 1), F(1, 2) };
        Assert.False(PlaceholderProgress.IsComplete(airing, today)); // caught up, but the season isn't finished
        Assert.Equal(3, PlaceholderProgress.ExpectedCount(airing));
        Assert.Equal(2, PlaceholderProgress.AiredCount(airing, today));
        airing.Expected[2].AirDate = Past;
        Assert.False(PlaceholderProgress.IsComplete(airing, today));
        airing.Filled.Add(F(1, 3));
        Assert.True(PlaceholderProgress.IsComplete(airing, today));

        // Ended show: an announced episode that never aired isn't required.
        var cancelled = Season(1, 2);
        cancelled.InProduction = false;
        cancelled.Expected = new() { Ep(2, 1, Past), Ep(2, 2, null) };
        cancelled.Filled = new() { F(2, 1) };
        Assert.True(PlaceholderProgress.IsComplete(cancelled, today));

        // Unknown production state or expected set: never complete.
        var unknown = Season(1, 3);
        unknown.Expected = new() { Ep(3, 1, Past) };
        unknown.Filled = new() { F(3, 1) };
        Assert.False(PlaceholderProgress.IsComplete(unknown, today));
        unknown.InProduction = false;
        unknown.Expected.Clear();
        Assert.False(PlaceholderProgress.IsComplete(unknown, today));

        var series = Series(1);
        series.InProduction = true;
        series.Expected = new() { Ep(1, 1, Past), Ep(2, 1, Past) };
        series.Filled = new() { F(1, 1), F(2, 1) };
        Assert.False(PlaceholderProgress.IsComplete(series, today)); // a running show stays
        series.InProduction = false;
        Assert.True(PlaceholderProgress.IsComplete(series, today));
    }

    [Fact]
    public void ArrivingEpisodesGoInEpisodeOrderRelativeToTheFilledOnesElseRightBeforeThePlaceholder()
    {
        var placeholder = Season(1, 1);
        var e1 = Guid.NewGuid();
        var e3 = Guid.NewGuid();
        var x = Guid.NewGuid();
        placeholder.Filled = new() { new FilledEpisode { ItemId = e1.ToString("N"), S = 1, E = 1 }, new FilledEpisode { ItemId = e3.ToString("N"), S = 1, E = 3 } };
        var order = new List<string> { E(e1), E(e3), E(x), P(placeholder.Id) };
        ResolvedItem Arriving(int e) => new(Guid.NewGuid(), BaseItemKind.Episode, new[] { new EpisodeCoord(1, e) });

        // E02 goes before E03; E04 and E05 (the latest) form one run right before the placeholder, after the unrelated X.
        var (index, run) = ListPlaceholderSwapService.PlanRun(order, placeholder, new[] { Arriving(2), Arriving(4) });
        Assert.Equal(1, index);
        Assert.Single(run);
        var e4 = Arriving(4);
        var e5 = Arriving(5);
        (index, run) = ListPlaceholderSwapService.PlanRun(order, placeholder, new[] { e4, e5 });
        Assert.Equal(3, index);
        Assert.Equal(new[] { e4, e5 }, run);

        // Nothing filled yet: right before the placeholder.
        var empty = Season(1, 2);
        Assert.Equal(1, ListPlaceholderSwapService.PlanRun(new List<string> { E(x), P(empty.Id) }, empty, new[] { Arriving(1) }).Index);
    }
}
