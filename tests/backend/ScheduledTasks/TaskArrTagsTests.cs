using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

/// <summary>
/// Arr tag sync on the arr state store: a failed instance read never strips the tags it would have
/// confirmed, and series match by TVDB, TMDB or IMDb (no longer IMDb only).
/// </summary>
[Collection("Plugin singleton")]
public class TaskArrTagsTests
{
    private static Task Run(FakeArr arr, params BaseItem[] items) => RunWithPrefix(arr, "Arr: ", items);

    private static async Task RunWithPrefix(FakeArr arr, string? prefix, params BaseItem[] items)
    {
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrTagsSyncEnabled = true;
        config.ArrTagsClearOldTags = true;
        config.ArrTagsPrefix = prefix!;
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(items);
        library.Setup(l => l.UpdateItemAsync(It.IsAny<BaseItem>(), It.IsAny<BaseItem>(), ItemUpdateType.MetadataEdit, It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var previous = BaseItem.LibraryManager;
        BaseItem.LibraryManager = library.Object;
        try
        {
            await new ArrTagsSyncTask(library.Object, arr.Store(), arr.Plugin.Core.Logger).ExecuteAsync(new Progress<double>(), default);
        }
        finally { BaseItem.LibraryManager = previous; }
    }

    private static FakeArr Rig(out FakeArr.Host radarr, out FakeArr.Host sonarr)
    {
        var arr = new FakeArr();
        radarr = arr.Add("radarr.lan", "Radarr");
        sonarr = arr.Add("sonarr.lan", "Sonarr");
        arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
        return arr;
    }

    [Fact]
    public async Task SeriesMatchByTvdbTmdbOrImdbNotOnlyImdb()
    {
        using var arr = Rig(out _, out var sonarr);
        sonarr.Tags[1] = "kids";
        sonarr.Tags[2] = "anime";
        sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly", tmdb: 1437, imdb: "tt0303461", tags: new[] { 1 }));
        sonarr.Series.Add(FakeArr.SeriesRow(2, 81797, "One Piece", tmdb: 37854, imdb: null, tags: new[] { 2 }));
        var tvdbOnly = new Series { Id = Guid.NewGuid(), Name = "a", ProviderIds = new() { ["Tvdb"] = "78874" } };
        var tmdbOnly = new Series { Id = Guid.NewGuid(), Name = "b", ProviderIds = new() { ["Tmdb"] = "37854" } };
        var imdbOnly = new Series { Id = Guid.NewGuid(), Name = "c", ProviderIds = new() { ["Imdb"] = "tt0303461" } };
        var none = new Series { Id = Guid.NewGuid(), Name = "d", ProviderIds = new() { ["Tvdb"] = "1" }, Tags = ["Arr: old"] };

        await Run(arr, tvdbOnly, tmdbOnly, imdbOnly, none);

        Assert.Equal(new[] { "Arr: kids" }, tvdbOnly.Tags);
        Assert.Equal(new[] { "Arr: anime" }, tmdbOnly.Tags);
        Assert.Equal(new[] { "Arr: kids" }, imdbOnly.Tags);
        Assert.Empty(none.Tags);      // every instance answered: a stale prefixed tag is cleared as before
    }

    [Fact]
    public async Task AnInstanceThatCannotBeReadDoesNotClearTheTagsOfItsKind()
    {
        using var arr = Rig(out var radarr, out var sonarr);
        radarr.FailWith = 500;
        sonarr.Tags[1] = "kids";
        sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly", tags: new[] { 1 }));
        var movie = new Movie { Id = Guid.NewGuid(), Name = "m", Tags = ["Keep", "Arr: family"], ProviderIds = new() { ["Tmdb"] = "45745" } };
        var series = new Series { Id = Guid.NewGuid(), Name = "s", Tags = ["Arr: stale"], ProviderIds = new() { ["Tvdb"] = "78874" } };

        await Run(arr, movie, series);

        Assert.Equal(new[] { "Keep", "Arr: family" }, movie.Tags);   // Radarr failed: kept
        Assert.Equal(new[] { "Arr: kids" }, series.Tags);           // Sonarr answered: replaced
    }

    [Fact]
    public async Task ACorruptInstanceListKeepsTagsToo()
    {
        using var arr = Rig(out _, out _);
        arr.Plugin.Plugin.Configuration.RadarrInstances = "{not json";
        var movie = new Movie { Id = Guid.NewGuid(), Name = "m", Tags = ["Arr: family"], ProviderIds = new() { ["Tmdb"] = "45745" } };

        await Run(arr, movie);

        Assert.Equal(new[] { "Arr: family" }, movie.Tags);
    }

    [Fact]
    public async Task AnInstanceWhoseSavedKeyCannotBeReadKeepsTheTagsOfItsKind()
    {
        using var arr = Rig(out _, out var sonarr);
        sonarr.Tags[1] = "kids";
        sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly", tags: new[] { 1 }));
        // secrets.json lost the Radarr key (unreadable, replaced, wrong owner): the row keeps its placeholder.
        var radarrId = arr.Instance("Movies").Id;
        arr.Plugin.Plugin.Secrets.Remove(Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets.SecretsStore.ArrKeyName(radarrId));
        var movie = new Movie { Id = Guid.NewGuid(), Name = "m", Tags = ["Keep", "Arr: family"], ProviderIds = new() { ["Tmdb"] = "45745" } };
        var series = new Series { Id = Guid.NewGuid(), Name = "s", Tags = ["Arr: stale"], ProviderIds = new() { ["Tvdb"] = "78874" } };

        await Run(arr, movie, series);

        Assert.Equal(new[] { "Keep", "Arr: family" }, movie.Tags);   // nothing fetched for Radarr: kept
        Assert.Equal(new[] { "Arr: kids" }, series.Tags);           // Sonarr answered: replaced
        Assert.Equal(0, arr.CallCount("radarr.lan"));
    }

    // C07: clearing needs proof of absence.

    [Fact]
    public async Task ItemsWithoutAUsableIdKeepTheirTags()
    {
        using var arr = Rig(out var radarr, out var sonarr);
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly"));
        var unkeyedMovie = new Movie { Id = Guid.NewGuid(), Name = "m", Tags = ["Arr: old", "Mine"] };
        var unkeyedSeries = new Series { Id = Guid.NewGuid(), Name = "s", Tags = ["Arr: old"] };
        var zeroMovie = new Movie { Id = Guid.NewGuid(), Name = "m0", Tags = ["Arr: old"], ProviderIds = new() { ["Tmdb"] = "0", ["Imdb"] = "0" } };
        var malformedSeries = new Series { Id = Guid.NewGuid(), Name = "s0", Tags = ["Arr: old"], ProviderIds = new() { ["Tvdb"] = "abc", ["Tmdb"] = "-5", ["Imdb"] = "nm123" } };

        await Run(arr, unkeyedMovie, unkeyedSeries, zeroMovie, malformedSeries);

        Assert.Equal(new[] { "Arr: old", "Mine" }, unkeyedMovie.Tags);
        Assert.Equal(new[] { "Arr: old" }, unkeyedSeries.Tags);
        Assert.Equal(new[] { "Arr: old" }, zeroMovie.Tags);
        Assert.Equal(new[] { "Arr: old" }, malformedSeries.Tags);
    }

    [Fact]
    public async Task TagSyncUsesTheSharedProviderValidationWithoutLosingAbsenceProof()
    {
        using var arr = Rig(out var radarr, out var sonarr);
        radarr.Tags[1] = "family";
        radarr.Movies.Add(FakeArr.Movie(1, 101, "Alpha", tags: new[] { 1 }));
        sonarr.Tags[2] = "kids";
        sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Show", tmdb: 1437, imdb: "tt0303461", tags: new[] { 2 }));
        var movie = new Movie { Id = Guid.NewGuid(), Tags = ["Arr: old"], ProviderIds = new() { ["Tmdb"] = " 00101 " } };
        var series = new Series { Id = Guid.NewGuid(), Tags = ["Arr: old"], ProviderIds = new() { ["Imdb"] = " TT0303461 " } };
        var signed = new Movie { Id = Guid.NewGuid(), Tags = ["Arr: keep"], ProviderIds = new() { ["Tmdb"] = "+101" } };
        var oversized = new Movie { Id = Guid.NewGuid(), Tags = ["Arr: keep"], ProviderIds = new() { ["Tmdb"] = "2147483648", ["Imdb"] = "tt123456789012345" } };
        await Run(arr, movie, series, signed, oversized);
        Assert.Equal(new[] { "Arr: family" }, movie.Tags);
        Assert.Equal(new[] { "Arr: kids" }, series.Tags);
        Assert.Equal(new[] { "Arr: keep" }, signed.Tags);
        Assert.Equal(new[] { "Arr: keep" }, oversized.Tags);
    }

    [Fact]
    public async Task SeriesKnownOnlyByIdsNoSonarrEntryHasKeepTheirTags()
    {
        using var arr = Rig(out _, out var sonarr);
        sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly", tmdb: 1437, imdb: "tt0303461"));
        var imdbOnly = new Series { Id = Guid.NewGuid(), Name = "i", Tags = ["Arr: old"], ProviderIds = new() { ["Imdb"] = "tt9999999" } };
        var tmdbOnly = new Series { Id = Guid.NewGuid(), Name = "t", Tags = ["Arr: old"], ProviderIds = new() { ["Tmdb"] = "9999" } };
        // Matched through an alias to a Sonarr entry with no tags: its stale tags go.
        var matchedUntagged = new Series { Id = Guid.NewGuid(), Name = "f", Tags = ["Arr: old", "Mine"], ProviderIds = new() { ["Tmdb"] = "1437" } };
        var matchedByImdb = new Series { Id = Guid.NewGuid(), Name = "g", Tags = ["Arr: old"], ProviderIds = new() { ["Imdb"] = " TT0303461 " } };

        await Run(arr, imdbOnly, tmdbOnly, matchedUntagged, matchedByImdb);

        Assert.Equal(new[] { "Arr: old" }, imdbOnly.Tags);
        Assert.Equal(new[] { "Arr: old" }, tmdbOnly.Tags);
        Assert.Equal(new[] { "Mine" }, matchedUntagged.Tags);
        Assert.Empty(matchedByImdb.Tags);
    }

    [Fact]
    public async Task MoviesMatchByImdbTooAndKeepTagsWhenOnlyAnUnknownImdbIdIsKnown()
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Tags[1] = "family";
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", tags: new[] { 1 }));   // imdbId tt45745
        radarr.Movies.Add(FakeArr.Movie(2, 10378, "Big Buck Bunny"));             // imdbId tt10378, no tags
        var imdbMatched = new Movie { Id = Guid.NewGuid(), Name = "a", Tags = ["Arr: stale"], ProviderIds = new() { ["Imdb"] = "tt45745" } };
        var imdbUntagged = new Movie { Id = Guid.NewGuid(), Name = "b", Tags = ["Arr: stale"], ProviderIds = new() { ["Imdb"] = "tt10378" } };
        var imdbUnknown = new Movie { Id = Guid.NewGuid(), Name = "c", Tags = ["Arr: stale"], ProviderIds = new() { ["Imdb"] = "tt0000001" } };
        var tmdbAbsent = new Movie { Id = Guid.NewGuid(), Name = "d", Tags = ["Arr: stale"], ProviderIds = new() { ["Tmdb"] = "1" } };

        await Run(arr, imdbMatched, imdbUntagged, imdbUnknown, tmdbAbsent);

        Assert.Equal(new[] { "Arr: family" }, imdbMatched.Tags);
        Assert.Empty(imdbUntagged.Tags);                         // in Radarr with no tags
        Assert.Equal(new[] { "Arr: stale" }, imdbUnknown.Tags);  // can't tell: kept
        Assert.Empty(tmdbAbsent.Tags);                           // TMDB id in no instance: cleared as before
    }

    [Fact]
    public async Task AMovieMatchedByTmdbGetsOnlyItsOwnLabelsAndASharedImdbIdNamesNoMovie()
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Tags[1] = "kids";
        radarr.Tags[2] = "adult";
        // Two Radarr movies carry one IMDb id (a duplicate entry, a stale id).
        var a = FakeArr.Movie(1, 100, "A", tags: new[] { 1 });
        var b = FakeArr.Movie(2, 200, "B", tags: new[] { 2 });
        a["imdbId"] = "tt0000001";
        b["imdbId"] = "tt0000001";
        radarr.Movies.Add(a);
        radarr.Movies.Add(b);
        // C: one movie on two instances would be one TMDB id; here one entry with its own IMDb id.
        radarr.Movies.Add(FakeArr.Movie(3, 300, "C", tags: new[] { 1 }));
        var byTmdb = new Movie { Id = Guid.NewGuid(), Name = "a", Tags = ["Arr: stale"], ProviderIds = new() { ["Tmdb"] = "100", ["Imdb"] = "tt0000001" } };
        // Jellyfin's IMDb id is B's, its TMDB id is A's: TMDB decides.
        var crossed = new Movie { Id = Guid.NewGuid(), Name = "x", Tags = [], ProviderIds = new() { ["Tmdb"] = "100", ["Imdb"] = "tt300" } };
        var sharedImdbOnly = new Movie { Id = Guid.NewGuid(), Name = "s", Tags = ["Arr: stale"], ProviderIds = new() { ["Imdb"] = "tt0000001" } };
        var unknownTmdbSharedImdb = new Movie { Id = Guid.NewGuid(), Name = "u", Tags = ["Arr: stale"], ProviderIds = new() { ["Tmdb"] = "999", ["Imdb"] = "tt0000001" } };
        var unknownTmdbOwnImdb = new Movie { Id = Guid.NewGuid(), Name = "o", Tags = [], ProviderIds = new() { ["Tmdb"] = "999", ["Imdb"] = "tt300" } };

        await Run(arr, byTmdb, crossed, sharedImdbOnly, unknownTmdbSharedImdb, unknownTmdbOwnImdb);

        Assert.Equal(new[] { "Arr: kids" }, byTmdb.Tags);
        Assert.Equal(new[] { "Arr: kids" }, crossed.Tags);
        Assert.Equal(new[] { "Arr: stale" }, sharedImdbOnly.Tags);          // ambiguous: no labels, kept
        Assert.Equal(new[] { "Arr: stale" }, unknownTmdbSharedImdb.Tags);   // ambiguous: no proof either
        Assert.Equal(new[] { "Arr: kids" }, unknownTmdbOwnImdb.Tags);       // one movie carries it: matched
    }

    [Fact]
    public async Task OneMovieOnTwoRadarrsIsOneOwnerOfItsImdbId()
    {
        using var arr = new FakeArr();
        var main = arr.Add("radarr.lan", "Radarr");
        var uhd = arr.Add("radarr4k.lan", "Radarr");
        arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("Movies 4K", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR-KEY-9876543210"));
        main.Tags[1] = "kids";
        uhd.Tags[1] = "uhd";
        main.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", tags: new[] { 1 }));
        uhd.Movies.Add(FakeArr.Movie(7, 45745, "Sintel", tags: new[] { 1 }));
        var imdbOnly = new Movie { Id = Guid.NewGuid(), Name = "s", Tags = ["Arr: stale"], ProviderIds = new() { ["Imdb"] = "tt45745" } };

        await Run(arr, imdbOnly);

        Assert.Equal(new[] { "Arr: kids", "Arr: uhd" }, imdbOnly.Tags.OrderBy(t => t, StringComparer.Ordinal));
    }

    [Fact]
    public async Task AnUnreadRadarrInstanceStopsTheImdbFallbackFromAddingLabels()
    {
        using var arr = new FakeArr();
        var online = arr.Add("radarr.lan", "Radarr");
        var offline = arr.Add("radarr4k.lan", "Radarr");
        arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("Movies 4K", ArrKind.Radarr, "http://radarr4k.lan:7878", "RADARR-KEY-9876543210"));
        online.Tags[1] = "kids";
        var a = FakeArr.Movie(1, 100, "A", tags: new[] { 1 });
        a["imdbId"] = "tt111";
        online.Movies.Add(a);
        // B (TMDB 200) lives on the instance that can't be read this run.
        offline.Movies.Add(FakeArr.Movie(2, 200, "B"));
        offline.FailWith = 500;
        // Jellyfin's B carries a stale IMDb id: A's.
        var staleImdb = new Movie { Id = Guid.NewGuid(), Name = "b", Tags = ["Arr: stale"], ProviderIds = new() { ["Tmdb"] = "200", ["Imdb"] = "tt111" } };
        var imdbOnly = new Movie { Id = Guid.NewGuid(), Name = "i", Tags = [], ProviderIds = new() { ["Imdb"] = "tt111" } };
        var byTmdb = new Movie { Id = Guid.NewGuid(), Name = "a", Tags = [], ProviderIds = new() { ["Tmdb"] = "100" } };

        await Run(arr, staleImdb, imdbOnly, byTmdb);

        Assert.Equal(new[] { "Arr: stale" }, staleImdb.Tags);   // not A's labels; nothing cleared either
        Assert.Empty(imdbOnly.Tags);                             // one owner among the instances read proves nothing
        Assert.Equal(new[] { "Arr: kids" }, byTmdb.Tags);        // Radarr's own id still matches
    }

    // C08: one prefix resolver; an empty prefix never wipes.

    [Theory]
    [InlineData(null, PluginConfiguration.DefaultArrTagsPrefix)]
    [InlineData("", PluginConfiguration.DefaultArrTagsPrefix)]
    [InlineData(" ", " ")]
    [InlineData("Req: ", "Req: ")]
    public void TheTagPrefixFallsBackToTheDefaultOnlyWhenEmpty(string? configured, string expected)
    {
        var config = new PluginConfiguration { ArrTagsPrefix = configured! };
        Assert.Equal(expected, ArrTagsSyncTask.ResolveTagPrefix(config));
        Assert.Equal(PluginConfiguration.DefaultArrTagsPrefix, ArrTagsSyncTask.ResolveTagPrefix(null));
    }

    [Fact]
    public void TheDefaultPrefixIsTheConfigurationDefaultAndNotEmpty()
    {
        Assert.Equal(PluginConfiguration.DefaultArrTagsPrefix, new PluginConfiguration().ArrTagsPrefix);
        Assert.False(string.IsNullOrWhiteSpace(PluginConfiguration.DefaultArrTagsPrefix));
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    public async Task AnEmptyPrefixNeverClearsUserTagsNorAddsBareLabels(string? prefix)
    {
        using var arr = Rig(out _, out var sonarr);
        sonarr.Tags[1] = "kids";
        sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly", tags: new[] { 1 }));
        var series = new Series { Id = Guid.NewGuid(), Name = "s", Tags = ["Favourite", "Watch later"], ProviderIds = new() { ["Tvdb"] = "78874" } };

        await RunWithPrefix(arr, prefix, series);

        Assert.Equal(new[] { "Favourite", "Watch later", PluginConfiguration.DefaultArrTagsPrefix + "kids" }, series.Tags);
        Assert.DoesNotContain("kids", series.Tags);
    }
}
