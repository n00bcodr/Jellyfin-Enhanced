using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Stamps;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>The real stamps route, feeder, database and feed across settlement, source updates and expiry.</summary>
public class IntegrationAcquisitionStampFeedTests
{
    private sealed class Preferences : IAcquisitionBadgePreferences
    {
        public bool? WebBadges(Guid user) => null;
    }

    private static JsonElement Read(StampWorld w, Guid user, Guid item)
    {
        var view = new FakeJellyfinView();
        view.Users[user] = new Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.StatusViewer { UserId = user, Handle = view.AddUser(admin: false).Handle };
        var controller = new AcquisitionStampsController(w.Resolver, w.Library, view, new Preferences())
        {
            Config = () => w.Config,
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = TestCallers.Principal(user, admin: false) } },
        };
        return JsonDocument.Parse(Assert.IsType<FileContentResult>(controller.GetStamps(item.ToString("N"))).FileContents).RootElement.Clone();
    }

    [Fact]
    public async Task EarlyLibraryNotificationThenDelayedCommittedStampRefreshesTheSubscribedCard()
    {
        using var w = new StampWorld(live: true);
        var user = Guid.NewGuid();
        var key = StampWorld.Movie(603);
        w.Interests.Add(key, StampWorld.Interest(user, w.Now.AddDays(-1)));
        await w.Feeder.TickAsync(default);
        var movie = w.AddMovie(key, w.Now);
        w.Library.RaiseAdded(movie);
        w.Feed.Bump(new[] { key.ToString() }); // scanner announces Ready before the 60-second settlement
        var early = Read(w, user, movie.Id);
        Assert.Empty(early.GetProperty("items").EnumerateArray());
        var subscription = early.GetProperty("subscriptions")[0].GetProperty("keys")[0].GetString();
        var cursor = w.Feed.Cursor;
        w.Now = w.Now.AddSeconds(59);
        await w.Feeder.TickAsync(default);
        Assert.Equal(cursor, w.Feed.Cursor);
        w.Now = w.Now.AddSeconds(2);
        await w.Feeder.TickAsync(default);
        var changes = w.Feed.Read(w.Feed.Epoch, cursor);
        Assert.Contains(changes.Changes, c => c.Key == subscription);
        Assert.Equal("new", Read(w, user, movie.Id).GetProperty("items")[0].GetProperty("stamp").GetString());
        Assert.All(changes.Changes, c => Assert.Null(c.InstanceId));
    }

    [Fact]
    public async Task AFourKSourceOnAnOldHdPrimaryPublishesUpgradedAfterSettlement()
    {
        using var w = new StampWorld(live: true);
        var user = Guid.NewGuid();
        var hd = w.AddMovie(StampWorld.Movie(603), w.Now.AddYears(-1), path: "/movies/matrix-hd.mkv");
        hd = w.Library.Put(hd with { Sources = new[] { new StampSource(hd.Id.ToString("N"), hd.Path!, 1920, 1080, hd.DateCreated) } });
        await w.Feeder.TickAsync(default); // source baseline before a version is added
        var early = Read(w, user, hd.Id);
        Assert.Empty(early.GetProperty("items").EnumerateArray());
        var cursor = w.Feed.Cursor;
        var changed = hd with { Sources = new[] { new StampSource(hd.Id.ToString("N"), hd.Path!, 1920, 1080, hd.DateCreated), new StampSource("uhd", "/movies/matrix-4k.mkv", 3840, 2160, w.Now) } };
        w.Library.RaiseUpdated(changed);
        w.Now = w.Now.AddSeconds(61);
        await w.Feeder.TickAsync(default);
        Assert.Equal(cursor + 1, w.Feed.Cursor);
        Assert.Single(w.Feed.Read(w.Feed.Epoch, cursor).Changes, c => c.Key == "movie:tmdb:603");
        Assert.Equal("upgraded", Read(w, user, hd.Id).GetProperty("items")[0].GetProperty("stamp").GetString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExpiryInvalidatesTheSubscribedCardOnceWithoutALibraryEvent(bool upgraded)
    {
        using var w = new StampWorld(live: true);
        var user = Guid.NewGuid();
        var movie = w.AddMovie(StampWorld.Movie(603), w.Now.AddHours(-1));
        if (upgraded) w.Store.AddUpgraded(movie, w.Now, "import");
        else w.Store.AddNew(user, movie, w.Now, "follow");
        await w.Feeder.TickAsync(default);
        Assert.Single(Read(w, user, movie.Id).GetProperty("items").EnumerateArray());
        var cursor = w.Feed.Cursor;
        w.Now = w.Now.AddDays(7);
        await w.Feeder.TickAsync(default);
        Assert.Contains(w.Feed.Read(w.Feed.Epoch, cursor).Changes, c => c.Key == "movie:tmdb:603");
        Assert.Empty(Read(w, user, movie.Id).GetProperty("items").EnumerateArray());
        var expired = w.Feed.Cursor;
        await w.Feeder.TickAsync(default);
        Assert.Equal(expired, w.Feed.Cursor);
    }

    [Fact]
    public void CommitsPublishAfterTheIndexChangesAndNoOpsOrRejectedWritesDoNotPublish()
    {
        using var w = new StampWorld(live: true);
        var movie = w.AddMovie(StampWorld.Movie(603), w.Now);
        var user = Guid.NewGuid();
        Assert.True(w.Store.AddNew(user, movie, w.Now, "follow"));
        Assert.Contains(w.Feed.Read(w.Feed.Epoch, 0).Changes, c => c.Key == "movie:tmdb:603");
        Assert.Equal(AcquisitionStamp.NewForYou, w.Resolver.Resolve(movie.Id, user, w.Now));
        var cursor = w.Feed.Cursor;
        Assert.False(w.Store.AddNew(user, movie, w.Now, "follow"));
        Assert.False(w.Store.AddUpgraded(movie, w.Now, "import", generation: -1));
        Assert.Equal(cursor, w.Feed.Cursor);
        Assert.True(w.Store.AddUpgraded(movie, w.Now, "import"));
        Assert.True(w.Feed.Cursor > cursor);
        Assert.Equal(AcquisitionStamp.Upgraded, w.Resolver.Resolve(movie.Id, user, w.Now));
    }

    [Fact]
    public void RemovingAPersonalFactPublishesTheAffectedTitle()
    {
        using var w = new StampWorld(live: true);
        var movie = w.AddMovie(StampWorld.Movie(603), w.Now);
        var user = Guid.NewGuid();
        w.Store.AddNew(user, movie, w.Now, "follow");
        var cursor = w.Feed.Cursor;
        w.Store.PurgeUser(user);
        Assert.Contains(w.Feed.Read(w.Feed.Epoch, cursor).Changes, c => c.Key == "movie:tmdb:603");
        Assert.Empty(w.Store.FactsFor(movie.Id));
    }

    [Fact]
    public async Task LibraryRemovalPublishesAfterTheFourKIndexIsRebuilt()
    {
        using var w = new StampWorld(live: true);
        var movie = w.AddMovie(StampWorld.Movie(603), w.Now, fourK: true);
        await w.Feeder.TickAsync(default);
        var cursor = w.Feed.Cursor;
        w.Library.RaiseRemoved(movie);
        await w.Feeder.TickAsync(default);
        Assert.Contains(w.Feed.Read(w.Feed.Epoch, cursor).Changes, c => c.Key == "movie:tmdb:603");
        Assert.Empty(w.Store.FactsFor(movie.Id));
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ReplacingOrPurgingAnExpiredFactPublishesExactlyOnce(bool purge)
    {
        using var w = new StampWorld(live: true);
        var store = new AcquisitionStampStore(w.Db, w.Clock, w.Feed);
        var movie = w.AddMovie(StampWorld.Movie(603), w.Now.AddYears(-1));
        if (purge) store.AddUpgraded(movie, w.Now.AddDays(-29), "import");
        else store.AddNew(Guid.NewGuid(), movie, w.Now.AddDays(-8), "follow");
        store.InvalidateExpired(w.Now, TimeSpan.FromDays(7), TimeSpan.FromDays(7)); // expiry is already announced
        var cursor = w.Feed.Cursor;
        if (purge)
        {
            w.Now = w.Now.AddDays(2); // beyond the 30-day retention limit
            Assert.True(store.Purge() > 0);
        }
        else Assert.True(store.AddUpgraded(movie, w.Now, "replacement"));
        Assert.Equal(cursor + 1, w.Feed.Cursor);
        store.InvalidateExpired(w.Now, TimeSpan.FromDays(7), TimeSpan.FromDays(7));
        store.InvalidateExpired(w.Now, TimeSpan.FromDays(7), TimeSpan.FromDays(7));
        Assert.Equal(cursor + 1, w.Feed.Cursor);
    }

    [Fact]
    public async Task LifetimeExtensionReactivatesAStoredExpiredFactExactlyOnce()
    {
        using var w = new StampWorld(live: true, controlledClock: true);
        var movie = w.AddMovie(StampWorld.Movie(603), w.Now.AddYears(-1));
        w.Store.AddNew(Guid.NewGuid(), movie, w.Now.AddDays(-8), "follow");
        await w.Feeder.TickAsync(default);
        var cursor = w.Feed.Cursor;
        w.Config.ArrAcquisitionNewDays = 14;
        await w.Feeder.TickAsync(default);
        Assert.Equal(cursor + 1, w.Feed.Cursor);
        await w.Feeder.TickAsync(default);
        Assert.Equal(cursor + 1, w.Feed.Cursor);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RemovingTheLastFourKSourcePublishesOnceAndUnchangedRefreshStaysQuiet(bool separateCopy)
    {
        using var w = new StampWorld(live: true);
        var user = Guid.NewGuid();
        var key = StampWorld.Movie(603);
        var hd = w.AddMovie(key, w.Now.AddYears(-1), path: "/movies/hd.mkv");
        var uhd = w.AddMovie(key, w.Now.AddYears(-1), fourK: true, path: "/movies/uhd.mkv");
        if (!separateCopy)
        {
            w.Library.Items.Remove(uhd.Id);
            hd = w.Library.Put(hd with { Sources = new[] {
                new StampSource("hd", hd.Path, 1920, 1080, hd.DateCreated),
                new StampSource("uhd", uhd.Path, 3840, 2160, hd.DateCreated) } });
        }
        await w.Feeder.TickAsync(default);
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(hd.Id, user));
        var cursor = w.Feed.Cursor;
        for (var n = 0; n < 3; n++)
        {
            w.Library.RaiseUpdated(hd);
            w.Now = w.Now.AddSeconds(61);
            await w.Feeder.TickAsync(default);
        }
        Assert.Equal(cursor, w.Feed.Cursor);
        if (separateCopy) w.Library.RaiseRemoved(uhd);
        else w.Library.RaiseUpdated(hd with { Sources = new[] { hd.Sources[0] } });
        await w.Feeder.TickAsync(default);
        Assert.Equal(AcquisitionStamp.None, w.Resolver.Resolve(hd.Id, user));
        Assert.Equal(cursor + 1, w.Feed.Cursor);
        Assert.Single(w.Feed.Read(w.Feed.Epoch, cursor).Changes);
        w.Now = w.Now.AddSeconds(61);
        await w.Feeder.TickAsync(default);
        Assert.Equal(cursor + 1, w.Feed.Cursor);
        Assert.Empty(Read(w, user, hd.Id).GetProperty("items").EnumerateArray());
    }

    [Fact]
    public async Task AFailedIndexRefreshHoldsCommittedNotificationsUntilTheResolverCatchesUp()
    {
        using var w = new StampWorld(live: true);
        var key = StampWorld.Movie(603);
        var hd = w.AddMovie(key, w.Now.AddYears(-1));
        await w.Feeder.TickAsync(default);
        var cursor = w.Feed.Cursor;
        w.AddMovie(key, w.Now.AddYears(-1), fourK: true, path: "/movies/upgraded.mkv");
        w.Upgrades.Imports.Add(new StampUpgradeImport("import", "/movies/upgraded.mkv", w.Now));
        w.Library.FourKFailure = new IOException("library unavailable");
        await Assert.ThrowsAsync<IOException>(() => w.Feeder.TickAsync(default));
        Assert.Equal(cursor, w.Feed.Cursor);
        w.Library.FourKFailure = null;
        await w.Feeder.TickAsync(default);
        Assert.Equal(cursor + 1, w.Feed.Cursor);
        Assert.Equal(AcquisitionStamp.FourK, w.Resolver.Resolve(hd.Id, Guid.NewGuid()));
    }

    [Fact]
    public async Task EpisodeRemovalRetainsTheOrdinaryEpisodeAndSeasonInvalidations()
    {
        using var w = new StampWorld(live: true);
        var show = w.AddSeries(StampWorld.Show(700));
        var season = w.AddSeason(show, 1);
        var episode = w.AddEpisode(show, season, 1, 2, w.Now.AddYears(-1), fourK: true);
        await w.Feeder.TickAsync(default);
        var cursor = w.Feed.Cursor;
        w.Library.RaiseRemoved(episode);
        await w.Feeder.TickAsync(default);
        var keys = w.Feed.Read(w.Feed.Epoch, cursor).Changes.Select(c => c.Key).Order().ToArray();
        Assert.Equal(new[] { "tv:tvdb:700", "tv:tvdb:700:s1", "tv:tvdb:700:s1:e2" }, keys);
        Assert.Equal(cursor + 3, w.Feed.Cursor);
    }

    [Fact]
    public async Task DisablingBadgesDoesNotDropAnAlreadyQueuedPhysicalRemoval()
    {
        using var w = new StampWorld(live: true);
        var movie = w.AddMovie(StampWorld.Movie(603), w.Now.AddYears(-1), fourK: true);
        await w.Feeder.TickAsync(default);
        var cursor = w.Feed.Cursor;
        w.Library.RaiseRemoved(movie);
        w.Config.ArrPhase4AcquisitionBadgesEnabled = false;
        await w.Feeder.TickAsync(default);
        Assert.Equal(cursor + 1, w.Feed.Cursor);
        await w.Feeder.TickAsync(default);
        Assert.Equal(cursor + 1, w.Feed.Cursor);
    }

}
