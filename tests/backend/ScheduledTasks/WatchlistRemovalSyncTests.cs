using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

public class WatchlistSyncPlannerTests
{
    private static HashSet<string> Set(params string[] keys) => new(keys, StringComparer.OrdinalIgnoreCase);

    private static WatchlistSyncPlanner.Plan Run(string[] previous, string[] jellyfin, string[] seerr, WatchlistRemovalSource mode, string[]? library = null)
        => WatchlistSyncPlanner.Compute(previous, Set(jellyfin), Set(seerr), Set(library ?? previous.Concat(jellyfin).Concat(seerr).ToArray()), mode);

    [Fact]
    public void FirstRunRemovesNothingAndRecordsWhatIsOnBothLists()
    {
        var plan = Run([], ["movie:1", "movie:2"], ["movie:2", "movie:3"], WatchlistRemovalSource.Both);
        Assert.Empty(plan.RemoveFromSeerr);
        Assert.Empty(plan.RemoveFromJellyfin);
        Assert.Equal(["movie:2"], plan.NextSynced);
    }

    [Theory]
    [InlineData(WatchlistRemovalSource.Jellyfin, true, false)]
    [InlineData(WatchlistRemovalSource.Both, true, false)]
    [InlineData(WatchlistRemovalSource.Seerr, false, false)]
    [InlineData(WatchlistRemovalSource.Off, false, false)]
    public void ARemovalInJellyfinIsCopiedToSeerrOnlyWhenJellyfinIsFollowed(WatchlistRemovalSource mode, bool removeFromSeerr, bool removeFromJellyfin)
    {
        var plan = Run(["tv:5"], [], ["tv:5"], mode);
        Assert.Equal(removeFromSeerr, plan.RemoveFromSeerr.Contains("tv:5"));
        Assert.Equal(removeFromJellyfin, plan.RemoveFromJellyfin.Contains("tv:5"));
        Assert.Equal(!removeFromSeerr && mode != WatchlistRemovalSource.Off, plan.NextSynced.Contains("tv:5"));
    }

    [Theory]
    [InlineData(WatchlistRemovalSource.Seerr, true)]
    [InlineData(WatchlistRemovalSource.Both, true)]
    [InlineData(WatchlistRemovalSource.Jellyfin, false)]
    [InlineData(WatchlistRemovalSource.Off, false)]
    public void ARemovalInSeerrIsCopiedToJellyfinOnlyWhenSeerrIsFollowed(WatchlistRemovalSource mode, bool removeFromJellyfin)
    {
        var plan = Run(["movie:7"], ["movie:7"], [], mode);
        Assert.Empty(plan.RemoveFromSeerr);
        Assert.Equal(removeFromJellyfin, plan.RemoveFromJellyfin.Contains("movie:7"));
    }

    [Fact]
    public void AnItemOnOneSideThatWasNeverOnBothIsAPendingAdditionNotARemoval()
    {
        var plan = Run(["movie:1"], ["movie:1", "movie:9"], ["movie:1", "movie:8"], WatchlistRemovalSource.Both);
        Assert.Empty(plan.RemoveFromSeerr);
        Assert.Empty(plan.RemoveFromJellyfin);
        Assert.Equal(["movie:1"], plan.NextSynced);
    }

    [Fact]
    public void AnItemDeletedFromTheLibraryIsNotAWatchlistRemoval()
    {
        var plan = Run(["movie:4"], [], ["movie:4"], WatchlistRemovalSource.Both, library: []);
        Assert.Empty(plan.RemoveFromSeerr);
        Assert.Contains("movie:4", plan.NextSynced);
    }

    [Fact]
    public void AnItemRemovedFromBothSidesIsForgotten()
    {
        var plan = Run(["movie:4"], [], [], WatchlistRemovalSource.Both);
        Assert.Empty(plan.NextSynced);
        Assert.Empty(plan.RemoveFromSeerr);
    }

    [Theory]
    [InlineData(null, WatchlistRemovalSource.Jellyfin)]
    [InlineData("", WatchlistRemovalSource.Jellyfin)]
    [InlineData("Jellyfin", WatchlistRemovalSource.Jellyfin)]
    [InlineData("SEERR", WatchlistRemovalSource.Seerr)]
    [InlineData("both", WatchlistRemovalSource.Both)]
    [InlineData("off", WatchlistRemovalSource.Off)]
    [InlineData("garbage", WatchlistRemovalSource.Off)]
    public void ModeParsingDefaultsToJellyfinAndFailsSafeToOff(string? value, WatchlistRemovalSource expected)
        => Assert.Equal(expected, WatchlistSyncPlanner.ParseMode(value));
}

[Collection("Plugin singleton")]
public class WatchlistRemovalSyncTaskTests
{
    private sealed record Run(int Deletes, string? DeletedPath, string? ApiUser, WatchlistSyncState State, UserItemData Data, UserItemData[] AllData);

    private static async Task<Run> Execute(string[] previousSynced, bool jellyfinLiked, string[] seerrList, string mode = "jellyfin", bool seerrFails = false, int versions = 1)
    {
        using var f = new ApiPluginFixture();
        var user = new User("alice", "default", "default") { Id = Guid.NewGuid() };
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.SyncJellyfinWatchlistToSeerr = true;
        config.WatchlistRemovalSync = mode;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-key";
        if (previousSynced.Length > 0)
            f.Core.Manager.SaveWatchlistSyncState(user.Id, new WatchlistSyncState { Synced = previousSynced.ToList() });

        // A movie with several versions is several library items sharing one TMDB id.
        var movies = Enumerable.Range(0, versions)
            .Select(_ => (BaseItem)new Movie { Id = Guid.NewGuid(), Name = "Matrix", ProviderIds = new() { ["Tmdb"] = "603" } }).ToArray();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(movies);
        var users = new Mock<IUserManager>();
        var parameter = System.Linq.Expressions.Expression.Parameter(typeof(IUserManager), "u");
        var method = typeof(IUserManager).GetMethod("GetUsers", Type.EmptyTypes);
        System.Linq.Expressions.Expression body = method != null
            ? System.Linq.Expressions.Expression.Call(parameter, method)
            : System.Linq.Expressions.Expression.Property(parameter, "Users");
        users.Setup(System.Linq.Expressions.Expression.Lambda<Func<IUserManager, IEnumerable<User>>>(body, parameter)).Returns(new[] { user });
        // The like sits on the last version only, as when it was saved against a non-primary item.
        var allData = movies.Select((_, i) => new UserItemData { Key = "test" + i, Likes = jellyfinLiked && i == versions - 1 ? true : null }).ToArray();
        var data = allData[^1];
        var dataManager = new Mock<IUserDataManager>();
        for (var i = 0; i < movies.Length; i++)
        {
            var d = allData[i];
            dataManager.Setup(m => m.GetUserData(user, movies[i])).Returns(d);
        }

        var deletes = 0;
        string? deletedPath = null, apiUser = null;
        using var transport = new IntegrationTransport((request, ct) =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/user")
                return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = user.Id.ToString() } } })));
            if (request.Method == HttpMethod.Delete)
            {
                deletes++;
                deletedPath = request.RequestUri.AbsolutePath;
                // Seerr 3.x rejects this call (400) without mediaType.
                if (request.RequestUri.Query != "?mediaType=movie") return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.BadRequest));
                apiUser = request.Headers.GetValues("X-Api-User").Single();
                return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.NoContent));
            }
            if (seerrFails) return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.InternalServerError));
            var results = seerrList.Select(k => new { mediaType = k.Split(':')[0], tmdbId = int.Parse(k.Split(':')[1]) });
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results })));
        });

        await new WatchlistRemovalSyncTask(library.Object, users.Object, dataManager.Object, transport, f.Core.Manager, f.Core.Logger).ExecuteAsync(null!, default);
        return new Run(deletes, deletedPath, apiUser, f.Core.Manager.GetWatchlistSyncState(user.Id), data, allData);
    }

    [Fact]
    public async Task ItemRemovedFromJellyfinIsRemovedFromSeerr()
    {
        var run = await Execute(["movie:603"], jellyfinLiked: false, seerrList: ["movie:603"]);
        Assert.Equal(1, run.Deletes);
        Assert.Equal("/api/v1/watchlist/603", run.DeletedPath);
        Assert.Equal("27", run.ApiUser);
        Assert.Empty(run.State.Synced);
    }

    [Fact]
    public async Task FirstRunRemovesNothingAndRemembersItemsOnBothLists()
    {
        var run = await Execute([], jellyfinLiked: false, seerrList: ["movie:603"]);
        Assert.Equal(0, run.Deletes);
        Assert.Empty(run.State.Synced);

        var both = await Execute([], jellyfinLiked: true, seerrList: ["movie:603"]);
        Assert.Equal(0, both.Deletes);
        Assert.Equal(["movie:603"], both.State.Synced);
    }

    [Fact]
    public async Task ItemRemovedFromSeerrIsOnlyRemovedFromJellyfinWhenSeerrIsFollowed()
    {
        var jellyfinMode = await Execute(["movie:603"], jellyfinLiked: true, seerrList: [], mode: "jellyfin");
        Assert.True(jellyfinMode.Data.Likes);

        var both = await Execute(["movie:603"], jellyfinLiked: true, seerrList: [], mode: "both");
        Assert.Null(both.Data.Likes);
        Assert.Equal(0, both.Deletes);
        Assert.Empty(both.State.Synced);
    }

    [Fact]
    public async Task ALikeOnAnyVersionOfAMovieCountsAndRemovalClearsEveryVersion()
    {
        // Jellyfin keeps one library item per version, so the like can sit on a non-primary one.
        var kept = await Execute(["movie:603"], jellyfinLiked: true, seerrList: ["movie:603"], versions: 3);
        Assert.Equal(0, kept.Deletes);
        Assert.Equal(["movie:603"], kept.State.Synced);

        var removed = await Execute(["movie:603"], jellyfinLiked: true, seerrList: [], mode: "seerr", versions: 3);
        Assert.All(removed.AllData, d => Assert.Null(d.Likes));
        Assert.Empty(removed.State.Synced);
    }

    [Fact]
    public async Task UnreadableSeerrWatchlistRemovesNothingAndKeepsTheState()
    {
        var run = await Execute(["movie:603"], jellyfinLiked: false, seerrList: [], seerrFails: true);
        Assert.Equal(0, run.Deletes);
        Assert.Equal(["movie:603"], run.State.Synced);
    }

    [Fact]
    public async Task TurnedOffNeverRemoves()
    {
        var run = await Execute(["movie:603"], jellyfinLiked: false, seerrList: ["movie:603"], mode: "off");
        Assert.Equal(0, run.Deletes);
    }
}

public class SeerrWatchlistReaderTests
{
    [Fact]
    public async Task SendsOnlyPageAndFollowsTotalPages()
    {
        var queries = new List<string>();
        using var transport = new IntegrationTransport((request, ct) =>
        {
            queries.Add(request.RequestUri!.Query);
            var page = int.Parse(System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query)["page"]!);
            var results = page == 1
                ? new[] { new { mediaType = "movie", tmdbId = 1 } }
                : new[] { new { mediaType = "tv", tmdbId = 2 } };
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { page, totalPages = 2, totalResults = 2, results })));
        });
        var keys = await Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrWatchlistReader.ReadKeysAsync(
            transport.CreateClient(""), "http://seerr.test", "5", "key");
        Assert.Equal(["?page=1", "?page=2"], queries);
        Assert.Equal(new[] { "movie:1", "tv:2" }, keys!.OrderBy(k => k));
    }

    [Fact]
    public async Task ReturnsNullWhenAPageFailsSoAnUnreadableListIsNeverTreatedAsEmpty()
    {
        using var transport = new IntegrationTransport((request, ct) =>
            Task.FromResult(IntegrationTransport.Response("{\"message\":\"Unknown query parameter 'take'\"}", 400)));
        Assert.Null(await Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrWatchlistReader.ReadKeysAsync(
            transport.CreateClient(""), "http://seerr.test", "5", "key"));
    }
}
