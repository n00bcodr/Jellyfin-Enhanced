using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.EventHandlers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// One cache-invalidation path (design item B4): the per-user read caches (hidden-content
/// response filter, Spoiler Guard state, poster tag settings) are dropped by
/// <see cref="UserConfigurationManager.UserConfigurationSaved"/>, raised for every write through
/// <see cref="UserConfigurationManager.SaveUserConfiguration"/>, and one throwing subscriber cannot
/// stop the others.
/// </summary>
[Collection("Plugin singleton")]
public class CoreCacheInvalidationTests
{
    private const string HiddenContent = "hidden-content.json";
    private const string SpoilerBlur = "spoilerblur.json";

    /// <summary>The three readers, each subscribed to the fixture's manager.</summary>
    private sealed class Readers : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public UserConfigurationManager Manager => Plugin.Core.Manager;
        public Mock<IUserManager> Users { get; } = new();
        public Mock<ILibraryManager> Library { get; } = new();
        public HiddenContentResponseFilter Filter { get; }
        public SpoilerUserResolver Resolver { get; }
        public PosterTagSettingsProvider Poster { get; }

        public Readers()
        {
            Filter = new HiddenContentResponseFilter(Manager, Plugin.Core.Logger);
            Resolver = new SpoilerUserResolver(Manager, Library.Object, Plugin.Core.Logger, null!);
            Poster = new PosterTagSettingsProvider(Manager, new PosterTagUserCache(Users.Object));
        }

        /// <summary>Fills all three caches for the user.</summary>
        public PosterTagSettings Warm(Guid user)
        {
            HiddenContentResponseFilter.SeedCacheForTest(user.ToString("N"));
            SpoilerUserResolver.SeedUserStateCacheForTest(user.ToString("N"));
            var snapshot = Poster.Get(user);
            Assert.True(HiddenContentResponseFilter.IsCachedForTest(user.ToString("N")));
            Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(user.ToString("N")));
            Assert.Same(snapshot, Poster.Get(user));
            return snapshot;
        }

        /// <summary>A controller acting as <paramref name="caller"/>.</summary>
        public JellyfinEnhancedController Controller(Guid caller, bool admin = false)
        {
            var maintenance = new MaintenanceModeService(Users.Object, Mock.Of<ISessionManager>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            var controller = ApiAssetTests.Controller(Plugin.Core, Manager, Users.Object, Library.Object, maintenance, Resolver);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", caller.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return controller;
        }

        public User AddUser(Guid id)
        {
            var user = new User("user-" + id.ToString("N")[..8], "default", "default") { Id = id };
            Users.Setup(u => u.GetUserById(id)).Returns(user);
            return user;
        }

        public void Dispose()
        {
            Poster.Dispose();
            Resolver.Dispose();
            Filter.Dispose();
            Plugin.Dispose();
        }
    }

    private static UserHiddenContent HiddenItem(Guid item, string scope = "global") => new()
    { Items = new() { [item.ToString()] = new HiddenContentItem { ItemId = item.ToString(), Type = "Movie", HideScope = scope } } };

    private static void AssertOnlyInvalidated(Readers r, Guid user, PosterTagSettings snapshot, string file)
    {
        var n = user.ToString("N");
        Assert.Equal(file != HiddenContent, HiddenContentResponseFilter.IsCachedForTest(n));
        Assert.Equal(file != SpoilerBlur, SpoilerUserResolver.IsUserStateCachedForTest(n));
        Assert.Equal(file != "settings.json", ReferenceEquals(snapshot, r.Poster.Get(user)));
    }

    public static TheoryData<string, string> ManagerWriters => new()
    {
        { "save", HiddenContent }, { "save", SpoilerBlur }, { "save", "settings.json" },
        { "rmw", HiddenContent }, { "rmw", SpoilerBlur }, { "rmw", "settings.json" },
        { "save-dashed-upper-id", HiddenContent }, { "save-dashed-upper-id", SpoilerBlur }, { "save-dashed-upper-id", "settings.json" },
    };

    /// <summary>Both manager write primitives drop exactly the reader of the file written, whatever the id form.</summary>
    [Theory]
    [MemberData(nameof(ManagerWriters))]
    public void EveryManagerWriteInvalidatesTheReaderOfThatFile(string writer, string file)
    {
        using var r = new Readers();
        var user = Guid.NewGuid();
        var snapshot = r.Warm(user);
        switch (writer)
        {
            case "save": r.Manager.SaveUserConfiguration(user.ToString("N"), file, new { Touched = true }); break;
            case "save-dashed-upper-id": r.Manager.SaveUserConfiguration(user.ToString("D").ToUpperInvariant(), file, new { Touched = true }); break;
            case "rmw": Assert.Equal(1, r.Manager.RmwUserConfiguration<Dictionary<string, object>>(user.ToString("N"), file, d => { d["Touched"] = true; return 1; })); break;
        }
        AssertOnlyInvalidated(r, user, snapshot, file);
    }

    /// <summary>A read-modify-write that changes nothing writes nothing and keeps every cache.</summary>
    [Fact]
    public void NoOpReadModifyWriteKeepsCaches()
    {
        using var r = new Readers();
        var user = Guid.NewGuid();
        var snapshot = r.Warm(user);
        foreach (var file in new[] { HiddenContent, SpoilerBlur, "settings.json" })
            Assert.Equal(0, r.Manager.RmwUserConfiguration<Dictionary<string, object>>(user.ToString("N"), file, _ => 0));
        AssertOnlyInvalidated(r, user, snapshot, "none");
    }

    /// <summary>
    /// Raise loop: a throwing subscriber (first, or between others) neither fails the save nor stops
    /// later subscribers, and each subscriber runs exactly once. The readers subscribe after the first
    /// thrower, so their caches being dropped proves the Spoiler cache no longer needs the direct call.
    /// </summary>
    [Fact]
    public void FirstSubscriberThrowsLaterSubscribersStillRun()
    {
        var calls = new List<string>();
        using var plugin = new ApiPluginFixture();
        var manager = plugin.Core.Manager;
        manager.UserConfigurationSaved += (_, file) => { calls.Add("first:" + file); throw new InvalidOperationException("first subscriber failure"); };
        using var filter = new HiddenContentResponseFilter(manager, plugin.Core.Logger);
        manager.UserConfigurationSaved += (_, file) => { calls.Add("middle:" + file); throw new IOException("middle subscriber failure"); };
        using var resolver = new SpoilerUserResolver(manager, Mock.Of<ILibraryManager>(), plugin.Core.Logger, null!);
        using var poster = new PosterTagSettingsProvider(manager, new PosterTagUserCache(Mock.Of<IUserManager>()));
        string? lastUser = null;
        manager.UserConfigurationSaved += (user, file) => { calls.Add("last:" + file); lastUser = user; };

        var id = Guid.NewGuid();
        var n = id.ToString("N");
        HiddenContentResponseFilter.SeedCacheForTest(n);
        SpoilerUserResolver.SeedUserStateCacheForTest(n);
        var snapshot = poster.Get(id);

        manager.SaveUserConfiguration(n, HiddenContent, HiddenItem(Guid.NewGuid()));
        manager.SaveUserConfiguration(n, SpoilerBlur, new UserSpoilerBlur());
        manager.SaveUserConfiguration(n, "settings.json", new UserSettings { QualityTagsEnabled = true });

        Assert.False(HiddenContentResponseFilter.IsCachedForTest(n));
        Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(n));
        Assert.NotSame(snapshot, poster.Get(id));
        Assert.True(poster.Get(id).QualityTagsEnabled);
        Assert.Equal(n, lastUser);
        Assert.Equal(new[]
        {
            "first:" + HiddenContent, "middle:" + HiddenContent, "last:" + HiddenContent,
            "first:" + SpoilerBlur, "middle:" + SpoilerBlur, "last:" + SpoilerBlur,
            "first:settings.json", "middle:settings.json", "last:settings.json",
        }, calls);
        // Every save landed despite the throwing subscribers.
        Assert.Single(manager.GetUserConfiguration<UserHiddenContent>(n, HiddenContent).Items);
        Assert.True(manager.GetUserConfiguration<UserSettings>(n, "settings.json").QualityTagsEnabled);
    }

    /// <summary>A disposed reader stops listening.</summary>
    [Fact]
    public void DisposedReadersUnsubscribe()
    {
        using var plugin = new ApiPluginFixture();
        var filter = new HiddenContentResponseFilter(plugin.Core.Manager, plugin.Core.Logger);
        var resolver = new SpoilerUserResolver(plugin.Core.Manager, Mock.Of<ILibraryManager>(), plugin.Core.Logger, null!);
        filter.Dispose();
        resolver.Dispose();
        var n = Guid.NewGuid().ToString("N");
        HiddenContentResponseFilter.SeedCacheForTest(n);
        SpoilerUserResolver.SeedUserStateCacheForTest(n);
        plugin.Core.Manager.SaveUserConfiguration(n, HiddenContent, new UserHiddenContent());
        plugin.Core.Manager.SaveUserConfiguration(n, SpoilerBlur, new UserSpoilerBlur());
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(n));
        Assert.True(SpoilerUserResolver.IsUserStateCachedForTest(n));
        HiddenContentResponseFilter.InvalidateUser(n);
        SpoilerUserResolver.InvalidateUser(n);
    }

    public static TheoryData<string> HiddenContentEndpoints => new()
    {
        "get-seed", "post", "admin-hide", "admin-unhide", "hide-continue-watching", "unhide-continue-watching", "reset-all",
    };

    /// <summary>Every endpoint that writes hidden-content.json drops the response filter's cache (no direct calls left).</summary>
    [Theory]
    [MemberData(nameof(HiddenContentEndpoints))]
    public void EveryHiddenContentEndpointInvalidatesTheFilterCache(string endpoint)
    {
        using var r = new Readers();
        r.Plugin.Plugin.Configuration.HiddenContentEnabled = true;
        r.Plugin.Plugin.Configuration.HiddenContentAdmin = true;
        var admin = Guid.NewGuid();
        var user = Guid.NewGuid();
        var jfUser = r.AddUser(user);
        r.AddUser(admin);
        var item = new Movie { Id = Guid.NewGuid(), Name = "Movie" };
        r.Library.Setup(l => l.GetItemById<BaseItem>(item.Id, jfUser)).Returns(item);
        var n = user.ToString("N");
        if (endpoint is "admin-unhide" or "unhide-continue-watching" or "reset-all")
        {
            var hidden = HiddenItem(item.Id, "continuewatching");
            // Reset-all (Overwrite) only writes a document whose settings differ from the defaults.
            if (endpoint == "reset-all") hidden.Settings.FilterSearch = !hidden.Settings.FilterSearch;
            r.Manager.SaveUserConfiguration(n, HiddenContent, hidden);
        }
        var snapshot = r.Warm(user);

        IActionResult result = endpoint switch
        {
            "get-seed" => r.Controller(user).GetUserHiddenContent(n),
            "post" => r.Controller(user).SaveUserHiddenContent(n, HiddenItem(item.Id)),
            "admin-hide" => r.Controller(admin, admin: true).AdminHideForUser(n, [new HiddenContentItem { ItemId = item.Id.ToString(), Type = "Movie" }]),
            "admin-unhide" => r.Controller(admin, admin: true).AdminUnhideForUser(n, [item.Id.ToString()]),
            "hide-continue-watching" => r.Controller(user).HideFromContinueWatching(item.Id.ToString()),
            "unhide-continue-watching" => r.Controller(user).UnhideFromContinueWatching(item.Id.ToString()),
            "reset-all" => r.Controller(admin, admin: true).ResetAllUsersSettings(),
            _ => throw new ArgumentOutOfRangeException(nameof(endpoint)),
        };

        Assert.IsAssignableFrom<OkObjectResult>(result);
        Assert.True(File.Exists(Path.Combine(r.Plugin.Core.ConfigRoot, n, HiddenContent)));
        Assert.False(HiddenContentResponseFilter.IsCachedForTest(n));
        if (endpoint != "reset-all")
            AssertOnlyInvalidated(r, user, snapshot, HiddenContent);
    }

    public static TheoryData<string> SpoilerEndpoints => new()
    {
        "post", "prefs", "enable-series", "disable-series", "enable-movie", "disable-movie",
        "enable-collection", "disable-collection", "enable-pending", "disable-pending", "reset-all",
    };

    /// <summary>Every endpoint that writes spoilerblur.json drops the Spoiler Guard state cache.</summary>
    [Theory]
    [MemberData(nameof(SpoilerEndpoints))]
    public void EverySpoilerEndpointInvalidatesTheResolverCache(string endpoint)
    {
        using var r = new Readers();
        r.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        var admin = Guid.NewGuid();
        var user = Guid.NewGuid();
        var jfUser = r.AddUser(user);
        r.AddUser(admin);
        var series = new Series { Id = Guid.NewGuid(), Name = "Series" };
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Movie" };
        var collection = new BoxSet { Id = Guid.NewGuid(), Name = "Collection" };
        foreach (var item in new BaseItem[] { series, movie, collection })
            r.Library.Setup(l => l.GetItemById<BaseItem>(item.Id, jfUser)).Returns(item);
        var tmdb = Interlocked.Increment(ref _tmdbId).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var n = user.ToString("N");
        if (endpoint.StartsWith("disable-", StringComparison.Ordinal) || endpoint == "reset-all")
        {
            var state = new UserSpoilerBlur();
            state.Series[series.Id.ToString("N")] = new SpoilerBlurSeriesEntry { SeriesId = series.Id.ToString("N"), SeriesName = "Series" };
            state.Movies[movie.Id.ToString("N")] = new SpoilerBlurMovieEntry { MovieId = movie.Id.ToString("N"), MovieName = "Movie" };
            state.Collections[collection.Id.ToString("N")] = new SpoilerBlurCollectionEntry { CollectionId = collection.Id.ToString("N"), CollectionName = "Collection" };
            state.PendingTmdb["tv:" + tmdb] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = tmdb };
            state.Prefs = new SpoilerBlurUserPrefs { HideTags = true };
            r.Manager.SaveUserConfiguration(n, SpoilerBlur, state);
        }
        var snapshot = r.Warm(user);

        try
        {
            IActionResult result = endpoint switch
            {
                "post" => r.Controller(user).SaveUserSpoilerBlur(n, new UserSpoilerBlur()),
                "prefs" => r.Controller(user).SetSpoilerBlurUserPrefs(new SpoilerBlurUserPrefs { HideTags = true }),
                "enable-series" => r.Controller(user).EnableSpoilerBlurForSeries(series.Id.ToString()),
                "disable-series" => r.Controller(user).DisableSpoilerBlurForSeries(series.Id.ToString()),
                "enable-movie" => r.Controller(user).EnableSpoilerBlurForMovie(movie.Id.ToString()),
                "disable-movie" => r.Controller(user).DisableSpoilerBlurForMovie(movie.Id.ToString()),
                "enable-collection" => r.Controller(user).EnableSpoilerBlurForCollection(collection.Id.ToString()),
                "disable-collection" => r.Controller(user).DisableSpoilerBlurForCollection(collection.Id.ToString()),
                "enable-pending" => r.Controller(user).EnableSpoilerBlurPending("tv", tmdb, "Pending"),
                "disable-pending" => r.Controller(user).DisableSpoilerBlurPending("tv", tmdb),
                "reset-all" => r.Controller(admin, admin: true).ResetAllUsersSettings(),
                _ => throw new ArgumentOutOfRangeException(nameof(endpoint)),
            };

            Assert.IsAssignableFrom<OkObjectResult>(result);
            Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(n));
            if (endpoint != "reset-all")
                AssertOnlyInvalidated(r, user, snapshot, SpoilerBlur);
        }
        finally
        {
            SpoilerSeerrPendingPromoter.UnregisterPending("tv:" + tmdb, user);
        }
    }

    private static int _tmdbId = 2900000;

    public static TheoryData<string> SpoilerBackgroundWriters => new() { "first-play", "armer", "seerr-promoter" };

    /// <summary>
    /// The background writers of spoilerblur.json (first-play auto-enable, the library-add /
    /// apply-existing armer, the Seerr pending promoter) drop the Spoiler Guard state cache too.
    /// </summary>
    [Theory]
    [MemberData(nameof(SpoilerBackgroundWriters))]
    public async Task EverySpoilerBackgroundWriterInvalidatesTheResolverCache(string writer)
    {
        using var r = new Readers();
        r.Plugin.Plugin.Configuration.SpoilerBlurEnabled = true;
        r.Plugin.Plugin.Configuration.SpoilerAutoEnableOnFirstPlay = true;
        var user = Guid.NewGuid();
        var jfUser = r.AddUser(user);
        var n = user.ToString("N");
        var tmdb = Interlocked.Increment(ref _tmdbId).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var series = new Series
        {
            Id = Guid.NewGuid(), Name = "Series",
            ProviderIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = tmdb },
        };
        r.Library.Setup(l => l.GetItemById(series.Id)).Returns(series);
        r.Library.Setup(l => l.GetItemById<BaseItem>(series.Id, jfUser)).Returns(series);
        r.Library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new List<BaseItem>());
        SpoilerSeerrPendingPromoter? promoter = null;
        if (writer == "seerr-promoter")
        {
            var pending = new UserSpoilerBlur();
            pending.PendingTmdb["tv:" + tmdb] = new SpoilerBlurPendingEntry { MediaType = "tv", TmdbId = tmdb };
            r.Manager.SaveUserConfiguration(n, SpoilerBlur, pending);
            promoter = new SpoilerSeerrPendingPromoter(r.Library.Object, r.Users.Object, r.Manager, r.Plugin.Core.Paths.Object, r.Plugin.Core.Logger) { SweepSettleDelay = TimeSpan.Zero };
            await promoter.StartAsync(CancellationToken.None);
        }
        var snapshot = r.Warm(user);

        try
        {
            switch (writer)
            {
                case "first-play":
                    var episode = new Episode { Id = Guid.NewGuid(), SeriesId = series.Id, ParentIndexNumber = 1, IndexNumber = 1 };
                    await new SpoilerAutoEnableOnFirstPlayConsumer(r.Manager, r.Library.Object, r.Users.Object, r.Plugin.Core.Logger).OnEvent(new PlaybackStartEventArgs
                    { Item = episode, Session = new SessionInfo(Mock.Of<ISessionManager>(), NullLogger.Instance) { UserId = user } });
                    break;
                case "armer":
                    var candidate = new SpoilerAutoEnableArmer.Candidate { Id = series.Id, IdN = series.Id.ToString("N"), IsSeries = true, Name = "Series" };
                    Assert.Equal(1, SpoilerAutoEnableArmer.ArmForUser(r.Manager, n, [candidate], _ => SpoilerAutoEnableArmer.SkipReason.None, false, "new").Armed);
                    break;
                case "seerr-promoter":
                    r.Library.Raise(l => l.ItemAdded += null, r.Library.Object, new ItemChangeEventArgs { Item = series });
                    await promoter!.WaitForSweepsAsync().WaitAsync(TimeSpan.FromSeconds(15));
                    break;
            }

            Assert.Contains(series.Id.ToString("N"), r.Manager.GetUserConfiguration<UserSpoilerBlur>(n, SpoilerBlur).Series.Keys);
            AssertOnlyInvalidated(r, user, snapshot, SpoilerBlur);
        }
        finally
        {
            if (promoter != null)
                await promoter.StopAsync(CancellationToken.None);
            SpoilerSeerrPendingPromoter.UnregisterPending("tv:" + tmdb, user);
        }
    }

    /// <summary>"Apply defaults to users" rewrites all three documents and drops all three caches.</summary>
    [Fact]
    public void ResetAllInvalidatesEveryReader()
    {
        using var r = new Readers();
        var admin = Guid.NewGuid();
        r.AddUser(admin);
        var user = Guid.NewGuid();
        var n = user.ToString("N");
        // Every document differs from the defaults, so the Overwrite rewrites all three (an
        // unchanged document is no longer written).
        r.Manager.SaveUserConfiguration(n, SpoilerBlur, new UserSpoilerBlur { Prefs = new SpoilerBlurUserPrefs { HideTags = false } });
        r.Manager.SaveUserConfiguration(n, HiddenContent, new UserHiddenContent { Settings = new HiddenContentSettings { FilterSearch = !new HiddenContentSettings().FilterSearch } });
        r.Manager.SaveUserConfiguration(n, "settings.json", new UserSettings { AutoPipEnabled = true });
        var snapshot = r.Warm(user);

        Assert.IsType<OkObjectResult>(r.Controller(admin, admin: true).ResetAllUsersSettings());

        Assert.False(HiddenContentResponseFilter.IsCachedForTest(n));
        Assert.False(SpoilerUserResolver.IsUserStateCachedForTest(n));
        Assert.NotSame(snapshot, r.Poster.Get(user));
    }
}
