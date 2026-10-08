using System.Linq.Expressions;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class TaskSeerrSyncTests
{
    private sealed class ProgressLog : IProgress<double>
    {
        public List<double> Values { get; } = new();
        public void Report(double value) => Values.Add(value);
    }

    private static Mock<IUserManager> Users(params User[] users)
    {
        var mock = new Mock<IUserManager>();
        var p = Expression.Parameter(typeof(IUserManager), "u");
        var method = typeof(IUserManager).GetMethod("GetUsers", Type.EmptyTypes);
        Expression body = method != null ? Expression.Call(p, method) : Expression.Property(p, "Users");
        mock.Setup(Expression.Lambda<Func<IUserManager, IEnumerable<User>>>(body, p)).Returns(users);
        return mock;
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task UserImportNormalizesIdsExcludesBlockedUsersAndFailsOver(bool allFail)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.JellyseerrAutoImportUsers = true;
        config.JellyseerrUrls = "http://first.test\nhttp://second.test";
        config.JellyseerrApiKey = "test";
        var allowed = new User("allowed", "default", "default") { Id = Guid.NewGuid() };
        var blocked = new User("blocked", "default", "default") { Id = Guid.NewGuid() };
        config.JellyseerrImportBlockedUsers = blocked.Id.ToString("D").ToUpperInvariant();
        var requests = new List<(string Host, string Body, string Key)>();
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            requests.Add((request.RequestUri!.Host, await request.Content!.ReadAsStringAsync(ct), request.Headers.GetValues("X-Api-Key").Single()));
            return IntegrationTransport.Response(requests.Count <= 2 ? "[{\"id\":27}]" : "[]", allFail || request.RequestUri.Host == "first.test" ? 500 : 200);
        });
        var task = new JellyseerrUserImportTask(Users(allowed, blocked).Object, transport, f.Core.Logger);
        var progress = new ProgressLog();
        await task.ExecuteAsync(progress, default);
        await task.ExecuteAsync(progress, default);
        Assert.Equal(new[] { "first.test", "second.test", "first.test", "second.test" }, requests.Select(r => r.Host));
        foreach (var request in requests)
        {
            Assert.Equal("test", request.Key);
            using var body = JsonDocument.Parse(request.Body);
            Assert.Equal(allowed.Id.ToString("N"), Assert.Single(body.RootElement.GetProperty("jellyfinUserIds").EnumerateArray()).GetString());
        }
        Assert.Equal(100, progress.Values.Last());
    }

    [Fact]
    public async Task UserImportCancellationPropagatesWithoutContactingProvider()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.JellyseerrEnabled = true;
        f.Plugin.Configuration.JellyseerrAutoImportUsers = true;
        f.Plugin.Configuration.JellyseerrUrls = "http://seerr.test";
        f.Plugin.Configuration.JellyseerrApiKey = "test";
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Must not call provider"));
        var progress = new ProgressLog();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => new JellyseerrUserImportTask(Users().Object, transport, f.Core.Logger).ExecuteAsync(progress, new CancellationToken(true)));
        Assert.Equal(0, transport.Calls);
        Assert.DoesNotContain(100, progress.Values);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    [InlineData(false, false, true)]
    public async Task InboundWatchlistIsUserScopedIdempotentAndDoesNotReaddRemovedItems(bool upstreamFails, bool invalidJson, bool cancelDuringFetch)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.SyncJellyseerrWatchlist = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test";
        config.PreventWatchlistReAddition = true;
        config.WatchlistMemoryRetentionDays = 30;
        config.AddRequestedMediaToWatchlist = true;
        var allowed = new User("allowed", "default", "default") { Id = Guid.NewGuid() };
        var blocked = new User("blocked", "default", "default") { Id = Guid.NewGuid() };
        config.JellyseerrImportBlockedUsers = blocked.Id.ToString();
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var otherUsersMovie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "456" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie, otherUsersMovie });
        var userData = new UserItemData { Key = "movie", Likes = false };
        // Loose, so a regression that processes the other user's request would reach these
        // calls instead of throwing inside the task's per-item catch.
        var data = new Mock<IUserDataManager>();
        data.Setup(d => d.GetUserData(allowed, movie)).Returns(userData);
        data.Setup(d => d.GetUserData(allowed, otherUsersMovie)).Returns(new UserItemData { Key = "other", Likes = false });
        var writes = 0;
        data.Setup(d => d.SaveUserData(allowed, movie, userData, MediaBrowser.Model.Entities.UserDataSaveReason.UpdateUserRating, It.IsAny<CancellationToken>())).Callback(() => writes++);
        var identities = new List<string>();
        using var cts = new CancellationTokenSource();
        using var transport = new IntegrationTransport((request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/user")
                return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = allowed.Id.ToString("N").ToUpperInvariant() }, new { id = 28, jellyfinUserId = blocked.Id.ToString() } } })));
            identities.Add(request.Headers.GetValues("X-Api-User").Single());
            if (cancelDuringFetch) cts.Cancel();
            if (upstreamFails) return Task.FromResult(IntegrationTransport.Response("{}", 500));
            if (invalidJson) return Task.FromResult(IntegrationTransport.Response("{"));
            return Task.FromResult(IntegrationTransport.Response(request.RequestUri.AbsolutePath.EndsWith("watchlist")
                ? "{\"results\":[{\"tmdbId\":123,\"mediaType\":\"movie\"},{\"tmdbId\":123,\"mediaType\":\"movie\"}]}"
                : "{\"results\":[{\"requestedBy\":{\"id\":27},\"media\":{\"tmdbId\":123,\"mediaType\":\"movie\"}},{\"requestedBy\":{\"id\":28},\"media\":{\"tmdbId\":456,\"mediaType\":\"movie\"}}]}"));
        });
        var task = new JellyseerrWatchlistSyncTask(library.Object, Users(allowed, blocked).Object, data.Object, transport, f.Core.Manager, f.Core.Logger);
        var progress = new ProgressLog();
        if (cancelDuringFetch)
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task.ExecuteAsync(progress, cts.Token));
            Assert.Equal(0, writes);
            Assert.DoesNotContain(100, progress.Values);
            return;
        }
        await task.ExecuteAsync(progress, default);
        Assert.Equal(upstreamFails || invalidJson ? 0 : 1, writes);
        if (!upstreamFails && !invalidJson)
        {
            Assert.True(userData.Likes);
            var processed = Assert.Single(f.Core.Manager.GetProcessedWatchlistItems(allowed.Id).Items);
            Assert.Equal(123, processed.TmdbId);
            Assert.Equal("movie", processed.MediaType);
            userData.Likes = false; // User deliberately removed the item after the first sync.
        }
        await task.ExecuteAsync(progress, default);
        Assert.Equal(upstreamFails || invalidJson ? 0 : 1, writes);
        Assert.False(userData.Likes);
        Assert.NotEmpty(identities);
        Assert.All(identities, id => Assert.Equal("27", id));
        Assert.Empty(f.Core.Manager.GetProcessedWatchlistItems(blocked.Id).Items);
        // The blocked user's request for 456 never touches the allowed user's data.
        data.Verify(d => d.GetUserData(It.IsAny<User>(), otherUsersMovie), Times.Never);
        data.Verify(d => d.SaveUserData(It.IsAny<User>(), otherUsersMovie, It.IsAny<UserItemData>(), It.IsAny<MediaBrowser.Model.Entities.UserDataSaveReason>(), It.IsAny<CancellationToken>()), Times.Never);
        Assert.DoesNotContain(f.Core.Manager.GetProcessedWatchlistItems(allowed.Id).Items, item => item.TmdbId == 456);
        Assert.Equal(100, progress.Values.Last());
    }

    [Fact]
    public async Task ManualWatchlistSyncHonoursBlockedUsersReadditionPreventionAndTheRequestSetting()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.SyncJellyseerrWatchlist = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test";
        config.PreventWatchlistReAddition = true;
        config.WatchlistMemoryRetentionDays = 30;
        config.AddRequestedMediaToWatchlist = false;
        var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
        var blocked = new User("blocked", "default", "default") { Id = Guid.NewGuid() };
        config.JellyseerrImportBlockedUsers = blocked.Id.ToString();
        Movie Movie(string tmdb) => new() { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = tmdb } };
        var fresh = Movie("123"); var removed = Movie("789"); var blockedPick = Movie("456"); var requested = Movie("555");
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { fresh, removed, blockedPick, requested });
        // An earlier sync added 789 for the admin, who has since removed it.
        f.Core.Manager.SaveProcessedWatchlistItems(admin.Id, new ProcessedWatchlistItems
        { Items = { new ProcessedWatchlistItem { TmdbId = 789, MediaType = "movie", ProcessedAt = DateTime.UtcNow, Source = "sync" } } });
        var data = new Mock<IUserDataManager>();
        data.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>())).Returns(() => new UserItemData { Key = "fixture", Likes = false });
        var saved = new List<(Guid User, Guid Item)>();
        data.Setup(d => d.SaveUserData(It.IsAny<User>(), It.IsAny<BaseItem>(), It.IsAny<UserItemData>(), It.IsAny<MediaBrowser.Model.Entities.UserDataSaveReason>(), It.IsAny<CancellationToken>()))
            .Callback((User user, BaseItem item, UserItemData _, MediaBrowser.Model.Entities.UserDataSaveReason _, CancellationToken _) => saved.Add((user.Id, item.Id)));
        using var transport = new IntegrationTransport((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            return Task.FromResult(IntegrationTransport.Response(
                path == "/api/v1/user" ? JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = admin.Id.ToString("N") }, new { id = 28, jellyfinUserId = blocked.Id.ToString("N") } } })
                : path == "/api/v1/user/27/watchlist" ? "{\"results\":[{\"tmdbId\":123,\"mediaType\":\"movie\"},{\"tmdbId\":789,\"mediaType\":\"movie\"}]}"
                : path == "/api/v1/user/28/watchlist" ? "{\"results\":[{\"tmdbId\":456,\"mediaType\":\"movie\"}]}"
                : "{\"results\":[{\"requestedBy\":{\"id\":27},\"media\":{\"tmdbId\":555,\"mediaType\":\"movie\"}}]}"));
        });
        var controller = ApiAssetTests.Controller(f.Core, Users(admin, blocked).Object, library.Object, data.Object, transport, f.Core.Manager);
        controller.ControllerContext.HttpContext.User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(admin.Id, admin: true);

        var result = Assert.IsType<OkObjectResult>(await controller.SyncJellyseerrWatchlist());
        // Only the admin's new watchlist item: not the blocked user's 456, not the
        // removed 789, and not the 555 request while requested media is off.
        Assert.Equal(new[] { (admin.Id, fresh.Id) }, saved);
        // The admin's two watchlist entries (123 and the removed 789) were processed;
        // the blocked user's list and the requests were never read.
        Assert.Equal("{\"success\":true,\"itemsProcessed\":2,\"itemsAdded\":1,\"errors\":null}", JsonSerializer.Serialize(result.Value));
        Assert.Contains(f.Core.Manager.GetProcessedWatchlistItems(admin.Id).Items, item => item.TmdbId == 123);
        Assert.Empty(f.Core.Manager.GetProcessedWatchlistItems(blocked.Id).Items);
    }

    [Theory]
    [InlineData("")]
    [InlineData("\n  \n")]
    public async Task ManualWatchlistSyncWithoutAUsableUrlIsABadRequest(string urls)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.SyncJellyseerrWatchlist = true;
        config.JellyseerrUrls = urls;
        config.JellyseerrApiKey = "test";
        var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("Must not call Seerr"));
        var controller = ApiAssetTests.Controller(f.Core, Users(admin).Object, new Mock<ILibraryManager>().Object, new Mock<IUserDataManager>().Object, transport, f.Core.Manager);
        controller.ControllerContext.HttpContext.User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(admin.Id, admin: true);

        var result = Assert.IsType<BadRequestObjectResult>(await controller.SyncJellyseerrWatchlist());
        Assert.Equal("{\"error\":\"Jellyseerr URL or API key is not configured\"}", JsonSerializer.Serialize(result.Value));
        Assert.Equal(0, transport.Calls);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task ManualWatchlistSyncUsesTheFirstUrlThatAnswersAndFailsWhenNoneDoes(bool allFail)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.SyncJellyseerrWatchlist = true;
        config.JellyseerrUrls = "http://first.test\n http://second.test \nhttp://third.test";
        config.JellyseerrApiKey = "test";
        var admin = new User("admin", "default", "default") { Id = Guid.NewGuid() };
        var movie = new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "123" } };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(new BaseItem[] { movie });
        var data = new Mock<IUserDataManager>();
        data.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>())).Returns(() => new UserItemData { Key = "fixture", Likes = false });
        var saved = 0;
        data.Setup(d => d.SaveUserData(It.IsAny<User>(), It.IsAny<BaseItem>(), It.IsAny<UserItemData>(), It.IsAny<MediaBrowser.Model.Entities.UserDataSaveReason>(), It.IsAny<CancellationToken>()))
            .Callback(() => saved++);
        var calls = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            var uri = request.RequestUri!;
            lock (calls) calls.Add(uri.Host + uri.AbsolutePath);
            // The first URL refuses the connection; the second answers unless every URL is down.
            if (uri.Host == "first.test") throw new HttpRequestException("connection refused");
            if (allFail) return Task.FromResult(IntegrationTransport.Response("<html>bad gateway</html>", 502, "text/html"));
            return Task.FromResult(IntegrationTransport.Response(uri.AbsolutePath == "/api/v1/user"
                ? JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = admin.Id.ToString("N") } } })
                : "{\"results\":[{\"tmdbId\":123,\"mediaType\":\"movie\"}]}"));
        });
        var controller = ApiAssetTests.Controller(f.Core, Users(admin).Object, library.Object, data.Object, transport, f.Core.Manager);
        controller.ControllerContext.HttpContext.User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(admin.Id, admin: true);

        var result = await controller.SyncJellyseerrWatchlist();

        if (allFail)
        {
            // No URL answered: a failure, not a 200 with nothing processed.
            var failure = Assert.IsType<ObjectResult>(result);
            Assert.Equal(502, failure.StatusCode);
            Assert.Equal("{\"error\":\"Could not load the user list from any configured Jellyseerr URL.\"}", JsonSerializer.Serialize(failure.Value));
            Assert.Equal(new[] { "first.test/api/v1/user", "second.test/api/v1/user", "third.test/api/v1/user" }, calls);
            Assert.Equal(0, saved);
            return;
        }

        var ok = Assert.IsType<OkObjectResult>(result);
        Assert.Equal("{\"success\":true,\"itemsProcessed\":1,\"itemsAdded\":1,\"errors\":null}", JsonSerializer.Serialize(ok.Value));
        Assert.Equal(1, saved);
        // The rest of the pass stays on the URL whose user list loaded; the third is never tried.
        Assert.Equal(new[] { "first.test/api/v1/user", "second.test/api/v1/user", "second.test/api/v1/user/27/watchlist" }, calls);
    }

    [Fact]
    public async Task ConcurrentSyncPassesKeepEveryProcessedEntry()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.SyncJellyseerrWatchlist = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test";
        config.PreventWatchlistReAddition = true;
        config.WatchlistMemoryRetentionDays = 30;
        var user = new User("viewer", "default", "default") { Id = Guid.NewGuid() };
        const int perPass = 60;
        var movies = Enumerable.Range(1, perPass * 2).Select(i => new Movie { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = i.ToString() } }).ToArray();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(movies);
        // Even TMDB ids are already on the watchlist, so both the "added" and the
        // "already there" records are written concurrently.
        var data = new Mock<IUserDataManager>();
        data.Setup(d => d.GetUserData(It.IsAny<User>(), It.IsAny<BaseItem>()))
            .Returns((User _, BaseItem item) => new UserItemData { Key = "fixture", Likes = int.Parse(item.ProviderIds["Tmdb"]) % 2 == 0 });
        // Both passes fetch the user list before either processes an item, so their
        // processed-items writes for the same user overlap.
        using var bothStarted = new Barrier(2);
        IntegrationTransport Seerr(int first) => new((request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/user")
            {
                bothStarted.SignalAndWait(TimeSpan.FromSeconds(30));
                return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = user.Id.ToString("N") } } })));
            }
            var items = Enumerable.Range(first, perPass).Select(i => new { tmdbId = i, mediaType = "movie" });
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = items })));
        });
        // The scheduled run and a manual sync, each seeing a different half of the watchlist.
        using var scheduledSeerr = Seerr(1);
        using var manualSeerr = Seerr(perPass + 1);
        var scheduled = new JellyseerrWatchlistSyncTask(library.Object, Users(user).Object, data.Object, scheduledSeerr, f.Core.Manager, f.Core.Logger);
        var manual = new JellyseerrWatchlistSyncTask(library.Object, Users(user).Object, data.Object, manualSeerr, f.Core.Manager, f.Core.Logger);

        var passes = await Task.WhenAll(Task.Run(() => scheduled.RunAsync(null, default)), Task.Run(() => manual.RunAsync(null, default)));

        Assert.All(passes, pass => Assert.Equal(perPass / 2, pass!.ItemsAdded));
        var recorded = f.Core.Manager.GetProcessedWatchlistItems(user.Id).Items.Select(item => item.TmdbId).OrderBy(id => id);
        Assert.Equal(Enumerable.Range(1, perPass * 2), recorded);
    }
}
