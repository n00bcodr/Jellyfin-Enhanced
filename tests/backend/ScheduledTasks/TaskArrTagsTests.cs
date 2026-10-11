using Jellyfin.Data.Enums;
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
    private static async Task Run(FakeArr arr, params BaseItem[] items)
    {
        var config = arr.Plugin.Plugin.Configuration;
        config.ArrTagsSyncEnabled = true;
        config.ArrTagsClearOldTags = true;
        config.ArrTagsPrefix = "Arr: ";
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
}
