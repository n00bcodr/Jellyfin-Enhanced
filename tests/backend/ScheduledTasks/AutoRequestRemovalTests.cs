using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Moq;

namespace JE.Tests;

public class RequestRemovalPlannerTests
{
    private static RequestRemovalPlanner.Candidate Movie(int requestStatus = 2, int mediaStatus = 5)
        => new(1, false, requestStatus, mediaStatus, Array.Empty<int>(), new Dictionary<int, int>());

    private static RequestRemovalPlanner.Candidate Tv(int[] seasons, Dictionary<int, int> statuses, int requestStatus = 2)
        => new(2, true, requestStatus, 4, seasons, statuses);

    private static bool DecideMovie(RequestRemovalPlanner.Candidate c, params bool[] versionsPlayed)
        => RequestRemovalPlanner.Decide(c, versionsPlayed, null).Remove;

    private static bool DecideTv(RequestRemovalPlanner.Candidate c, Dictionary<int, bool[]> episodesPlayed)
        => RequestRemovalPlanner.Decide(c, null, episodesPlayed.ToDictionary(e => e.Key, e => (IReadOnlyCollection<bool>)e.Value)).Remove;

    [Theory]
    [InlineData(1, false)]
    [InlineData(2, true)]
    [InlineData(3, false)]
    [InlineData(4, false)]
    [InlineData(5, true)]
    public void OnlyApprovedOrCompletedRequestsAreRemoved(int requestStatus, bool removed)
        => Assert.Equal(removed, DecideMovie(Movie(requestStatus), true));

    [Fact]
    public void AMovieThatIsNotAvailableIsKept()
        => Assert.False(DecideMovie(Movie(mediaStatus: 3), true));

    [Fact]
    public void AnUnwatchedMovieIsKept()
        => Assert.False(DecideMovie(Movie(), false));

    [Fact]
    public void AWatchedMovieIsRemovedRightAway()
        => Assert.True(DecideMovie(Movie(), true));

    [Fact]
    public void AnyWatchedVersionOfAMovieCounts()
        => Assert.True(DecideMovie(Movie(), false, true));

    [Fact]
    public void ASeriesIsRemovedOnceEveryRequestedSeasonIsWatched()
    {
        var c = Tv([1, 2], new() { [1] = 5, [2] = 5 });
        Assert.True(DecideTv(c, new() { [1] = [true, true], [2] = [true, true] }));
    }

    [Fact]
    public void ASeriesWithOneUnwatchedEpisodeIsKept()
    {
        var c = Tv([1], new() { [1] = 5 });
        Assert.False(DecideTv(c, new() { [1] = [true, false] }));
    }

    [Fact]
    public void ASeriesWithARequestedSeasonNotAvailableIsKept()
    {
        var c = Tv([1, 2], new() { [1] = 5, [2] = 4 });
        Assert.False(DecideTv(c, new() { [1] = [true], [2] = [true] }));
    }

    [Fact]
    public void ASeriesWithARequestedSeasonMissingFromTheLibraryIsKept()
    {
        var c = Tv([1, 2], new() { [1] = 5, [2] = 5 });
        Assert.False(DecideTv(c, new() { [1] = [true] }));
    }

    [Fact]
    public void SeasonsTheRequestDidNotAskForAreIgnored()
    {
        var c = Tv([2], new() { [1] = 2, [2] = 5 });
        Assert.True(DecideTv(c, new() { [1] = [false], [2] = [true] }));
    }

    [Fact]
    public void ParsingReadsTheRequestQualityAndRequester()
    {
        using var doc = JsonDocument.Parse("""
            {"id":9,"status":2,"type":"tv","is4k":true,
             "media":{"tmdbId":1399,"status":5,"status4k":3,"seasons":[{"seasonNumber":1,"status":5,"status4k":3}]},
             "seasons":[{"seasonNumber":1}],
             "requestedBy":{"id":4,"jellyfinUserId":"aa-bb"}}
            """);
        var parsed = AutoRequestRemovalTask.Parse(doc.RootElement)!;
        Assert.Equal(9, parsed.Candidate.RequestId);
        Assert.True(parsed.Candidate.IsTv);
        Assert.Equal(3, parsed.Candidate.MediaStatus);
        Assert.Equal(3, parsed.Candidate.SeasonStatuses[1]);
        Assert.Equal(1399, parsed.TmdbId);
        Assert.Equal("aabb", parsed.RequesterJellyfinId);
    }
}

[Collection("Plugin singleton")]
public class AutoRequestRemovalTaskTests
{
    private sealed record Run(List<string> Deleted, List<string> Queries, List<string> DetailReads, bool SentApiUser);

    private sealed record Req(int Id, string Type, int TmdbId, Guid Requester, int Status = 2, int MediaStatus = 5, int[]? Seasons = null);

    // A row of Seerr's request list. Like the real one, it has no media.seasons.
    private static object Row(Req r) => new
    {
        id = r.Id,
        status = r.Status,
        type = r.Type,
        media = new { tmdbId = r.TmdbId, status = r.MediaStatus },
        seasons = (r.Seasons ?? []).Select(s => new { seasonNumber = s }),
        requestedBy = new { id = 1, jellyfinUserId = r.Requester.ToString() }
    };

    // GET /api/v1/request/{id}: the same request with media.seasons and each season's status.
    private static object Detail(Req r) => new
    {
        id = r.Id,
        status = r.Status,
        type = r.Type,
        media = new
        {
            tmdbId = r.TmdbId,
            status = r.MediaStatus,
            seasons = (r.Seasons ?? []).Select(s => new { seasonNumber = s, status = r.MediaStatus })
        },
        seasons = (r.Seasons ?? []).Select(s => new { seasonNumber = s }),
        requestedBy = new { id = 1, jellyfinUserId = r.Requester.ToString() }
    };

    private static void SetupUsers(Mock<IUserManager> users, params User[] list)
    {
        var parameter = System.Linq.Expressions.Expression.Parameter(typeof(IUserManager), "u");
        var method = typeof(IUserManager).GetMethod("GetUsers", Type.EmptyTypes);
        System.Linq.Expressions.Expression body = method != null
            ? System.Linq.Expressions.Expression.Call(parameter, method)
            : System.Linq.Expressions.Expression.Property(parameter, "Users");
        users.Setup(System.Linq.Expressions.Expression.Lambda<Func<IUserManager, IEnumerable<User>>>(body, parameter)).Returns(list);
    }

    /// <param name="watchedBy">Which user watched the movie (and every episode), just now.</param>
    private static async Task<Run> Execute(
        Req[] requests,
        User requester,
        User watchedBy,
        bool enabled = true,
        bool failSecondPage = false,
        int deleteStatus = 204,
        string blocked = "",
        Episode[]? episodes = null,
        int detailStatus = 200)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.AutoRequestRemovalEnabled = enabled;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-key";
        config.JellyseerrImportBlockedUsers = blocked;

        var movie = new Movie { Id = Guid.NewGuid(), Name = "Matrix", ProviderIds = new() { ["Tmdb"] = "603" } };
        var series = new Series { Id = Guid.NewGuid(), Name = "Thrones", ProviderIds = new() { ["Tmdb"] = "1399" } };
        episodes ??= [];

        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.IncludeItemTypes.Contains(BaseItemKind.Episode))))
            .Returns(episodes.Cast<BaseItem>().ToList());
        library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => !q.IncludeItemTypes.Contains(BaseItemKind.Episode))))
            .Returns(new List<BaseItem> { movie, series });

        var users = new Mock<IUserManager>();
        SetupUsers(users, requester.Id == watchedBy.Id ? [requester] : [requester, watchedBy]);

        var dataManager = new Mock<IUserDataManager>();
        dataManager.Setup(m => m.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>()))
            .Returns((User u, BaseItem _) => u.Id == watchedBy.Id
                ? new UserItemData { Key = "k", Played = true, LastPlayedDate = DateTime.UtcNow }
                : new UserItemData { Key = "k" });

        var deleted = new List<string>();
        var queries = new List<string>();
        var detailReads = new List<string>();
        var sentApiUser = false;
        using var transport = new IntegrationTransport((request, ct) =>
        {
            if (request.Method == HttpMethod.Delete)
            {
                deleted.Add(request.RequestUri!.AbsolutePath);
                sentApiUser |= request.Headers.Contains("X-Api-User");
                return Task.FromResult(new HttpResponseMessage((System.Net.HttpStatusCode)deleteStatus));
            }

            if (request.RequestUri!.AbsolutePath != "/api/v1/request")
            {
                detailReads.Add(request.RequestUri.AbsolutePath);
                var id = int.Parse(request.RequestUri.AbsolutePath.Split('/')[^1]);
                if (detailStatus != 200) return Task.FromResult(new HttpResponseMessage((System.Net.HttpStatusCode)detailStatus));
                return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(Detail(requests.Single(r => r.Id == id)))));
            }

            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            queries.Add(request.RequestUri.Query);
            var skip = int.Parse(query["skip"]!);
            var take = int.Parse(query["take"]!);
            if (failSecondPage && skip > 0) return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.InternalServerError));
            var page = requests.Skip(skip).Take(take).Select(Row).ToList();
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = page })));
        });

        await new AutoRequestRemovalTask(library.Object, users.Object, dataManager.Object, transport, f.Core.Logger).ExecuteAsync(null!, default);
        return new Run(deleted, queries, detailReads, sentApiUser);
    }

    private static User NewUser(string name) => new(name, "default", "default") { Id = Guid.NewGuid() };

    [Fact]
    public async Task AMovieWatchedByItsRequesterIsRemovedWithTheApiKeyOnly()
    {
        var alice = NewUser("alice");
        var run = await Execute([new Req(11, "movie", 603, alice.Id)], alice, alice);
        Assert.Equal(["/api/v1/request/11"], run.Deleted);
        Assert.False(run.SentApiUser);
    }

    [Fact]
    public async Task AnotherUserWatchingDoesNotRemoveTheRequest()
    {
        var alice = NewUser("alice");
        var bob = NewUser("bob");
        var run = await Execute([new Req(11, "movie", 603, alice.Id)], alice, bob);
        Assert.Empty(run.Deleted);
    }

    [Fact]
    public async Task TurnedOffSendsNothing()
    {
        var alice = NewUser("alice");
        var run = await Execute([new Req(11, "movie", 603, alice.Id)], alice, alice, enabled: false);
        Assert.Empty(run.Deleted);
        Assert.Empty(run.Queries);
    }

    [Fact]
    public async Task PendingRequestsAreKept()
    {
        var alice = NewUser("alice");
        var run = await Execute([new Req(11, "movie", 603, alice.Id, Status: 1)], alice, alice);
        Assert.Empty(run.Deleted);
    }

    [Fact]
    public async Task ABlockedRequesterIsSkipped()
    {
        var alice = NewUser("alice");
        var run = await Execute([new Req(11, "movie", 603, alice.Id)], alice, alice, blocked: alice.Id.ToString("N"));
        Assert.Empty(run.Deleted);
    }

    [Fact]
    public async Task AFailedPageRemovesNothing()
    {
        var alice = NewUser("alice");
        var requests = Enumerable.Range(1, 150).Select(i => new Req(i, "movie", 603, alice.Id)).ToArray();
        var run = await Execute(requests, alice, alice, failSecondPage: true);
        Assert.Empty(run.Deleted);
    }

    [Fact]
    public async Task EveryPageIsReadBeforeActing()
    {
        var alice = NewUser("alice");
        var requests = Enumerable.Range(1, 150).Select(i => new Req(i, "movie", i == 150 ? 603 : 999, alice.Id)).ToArray();
        var run = await Execute(requests, alice, alice);
        Assert.Equal(2, run.Queries.Count);
        Assert.Equal(["/api/v1/request/150"], run.Deleted);
    }

    [Fact]
    public async Task ARequestAlreadyGoneCountsAsRemoved()
    {
        var alice = NewUser("alice");
        var run = await Execute([new Req(11, "movie", 603, alice.Id), new Req(12, "movie", 603, alice.Id)], alice, alice, deleteStatus: 404);
        Assert.Equal(["/api/v1/request/11", "/api/v1/request/12"], run.Deleted);
    }

    private static Episode Ep(int season, int episode) => new() { Id = Guid.NewGuid(), ParentIndexNumber = season, IndexNumber = episode };

    [Fact]
    public async Task AFullyWatchedSeasonRemovesTheSeriesRequest()
    {
        // The list has no season statuses, so the task reads them from the request itself.
        var alice = NewUser("alice");
        var run = await Execute([new Req(21, "tv", 1399, alice.Id, Seasons: [1])], alice, alice, episodes: [Ep(1, 1), Ep(1, 2)]);
        Assert.Equal(["/api/v1/request/21"], run.DetailReads);
        Assert.Equal(["/api/v1/request/21"], run.Deleted);

        var noEpisodes = await Execute([new Req(21, "tv", 1399, alice.Id, Seasons: [1])], alice, alice);
        Assert.Empty(noEpisodes.Deleted);
    }

    [Fact]
    public async Task AnUnwatchedSeriesRequestCostsNoExtraCall()
    {
        var alice = NewUser("alice");
        var bob = NewUser("bob");
        var run = await Execute([new Req(21, "tv", 1399, alice.Id, Seasons: [1])], alice, bob, episodes: [Ep(1, 1)]);
        Assert.Empty(run.DetailReads);
        Assert.Empty(run.Deleted);
    }

    [Fact]
    public async Task ASeasonSeerrStillCallsUnavailableKeepsTheSeriesRequest()
    {
        var alice = NewUser("alice");
        var run = await Execute([new Req(21, "tv", 1399, alice.Id, MediaStatus: 4, Seasons: [1])], alice, alice, episodes: [Ep(1, 1)]);
        Assert.Equal(["/api/v1/request/21"], run.DetailReads);
        Assert.Empty(run.Deleted);
    }

    [Fact]
    public async Task AnUnreadableRequestIsKeptForTheNextRun()
    {
        var alice = NewUser("alice");
        var run = await Execute([new Req(21, "tv", 1399, alice.Id, Seasons: [1]), new Req(11, "movie", 603, alice.Id)], alice, alice,
            episodes: [Ep(1, 1)], detailStatus: 500);
        Assert.Equal(["/api/v1/request/11"], run.Deleted);
    }
}
