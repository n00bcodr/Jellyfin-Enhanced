using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class TaskRegressionTests
{
    private sealed class ProgressLog : IProgress<double>
    {
        public List<double> Values { get; } = new();
        public void Report(double value) => Values.Add(value);
    }

    [Fact]
    public async Task DisabledTasksCompleteWithoutTouchingDependencies()
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.ArrTagsSyncEnabled = false;
        c.AudioLanguageTagSyncEnabled = false;
        c.MdblistRatingsEnabled = false;
        c.JellyseerrEnabled = false;
        c.TagCacheServerMode = false;
        IScheduledTask[] tasks = [
            new ArrTagsSyncTask(null!, null!, f.Core.Logger),
            new AudioLanguageTagsSyncTask(null!, null!, null!, f.Core.Logger),
            new MdblistRatingsFetchTask(null!, null!, f.Core.Logger),
            new MdblistRatingsSyncTask(null!, null!, f.Core.Logger),
            new JellyseerrUserImportTask(null!, null!, f.Core.Logger),
            new JellyfinToSeerrWatchlistSyncTask(null!, null!, null!, null!, null!, f.Core.Logger),
            new JellyseerrWatchlistSyncTask(null!, null!, null!, null!, null!, f.Core.Logger),
            new BuildTagCacheTask(null!, null!, f.Core.Logger)
        ];
        Assert.Equal(tasks.Length, tasks.Select(t => t.Key).Distinct().Count());
        foreach (var task in tasks)
        {
            var progress = new ProgressLog();
            await task.ExecuteAsync(progress, CancellationToken.None);
            Assert.Equal(100, Assert.Single(progress.Values));
        }
    }

    [Fact]
    public void DestructiveOrOptInTasksHaveNoAutomaticTriggers()
    {
        using var f = new CoreFixture();
        IScheduledTask[] tasks = [new ArrTagsSyncTask(null!, null!, f.Logger),
            new AudioLanguageTagsSyncTask(null!, null!, null!, f.Logger),
            new MdblistRatingsFetchTask(null!, null!, f.Logger),
            new MdblistRatingsSyncTask(null!, null!, f.Logger),
            new SpoilerApplyExistingTitlesTask(null!)];
        foreach (var task in tasks) Assert.Empty(task.GetDefaultTriggers());
        Assert.Equal(TaskTriggerInfoType.StartupTrigger, Assert.Single(new ClearTranslationCacheTask(f.Logger).GetDefaultTriggers()).Type);
    }

    [Fact]
    public async Task TranslationRefreshSetsClientInvalidationSignal()
    {
        using var f = new ApiPluginFixture();
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var progress = new ProgressLog();
        await new ClearTranslationCacheTask(f.Core.Logger).ExecuteAsync(progress, default);
        Assert.InRange(f.Plugin.Configuration.ClearTranslationCacheTimestamp, before, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        Assert.Equal(100, Assert.Single(progress.Values));
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task WatchlistExportUsesLinkedIdentityAndDeduplicatesLibraryItems(bool alreadyPresent)
    {
        using var f = new ApiPluginFixture();
        var user = new User("alice", "default", "default") { Id = Guid.NewGuid() };
        var blocked = new User("blocked", "default", "default") { Id = Guid.NewGuid() };
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.SyncJellyfinWatchlistToSeerr = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "test-key";
        config.JellyseerrImportBlockedUsers = blocked.Id.ToString();
        var movies = new[] { "+123", " 123 ", "00123", "not-an-id", "0", "-1", "2147483648", "123", "123" }
            .Select((id, index) => (BaseItem)new Movie
            {
                Id = Guid.NewGuid(), Name = "Edition " + index,
                ProviderIds = new() { ["Tmdb"] = id }
            }).ToArray();
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns((InternalItemsQuery q) => q.IncludeItemTypes.Contains(Jellyfin.Data.Enums.BaseItemKind.Movie) ? movies : Array.Empty<BaseItem>());
        var users = new Mock<IUserManager>();
        var parameter = System.Linq.Expressions.Expression.Parameter(typeof(IUserManager), "u");
        var method = typeof(IUserManager).GetMethod("GetUsers", Type.EmptyTypes);
        System.Linq.Expressions.Expression body = method != null
            ? System.Linq.Expressions.Expression.Call(parameter, method)
            : System.Linq.Expressions.Expression.Property(parameter, "Users");
        users.Setup(System.Linq.Expressions.Expression.Lambda<Func<IUserManager, IEnumerable<User>>>(body, parameter)).Returns(new[] { user, blocked });
        var data = new Mock<IUserDataManager>(MockBehavior.Strict);
        data.Setup(d => d.GetUserData(user, It.IsAny<BaseItem>())).Returns(new UserItemData { Key = "test", Likes = true });
        var posts = 0;
        using var transport = new IntegrationTransport(async (request, ct) =>
        {
            Assert.Equal("test-key", Assert.Single(request.Headers.GetValues("X-Api-Key")));
            if (request.RequestUri!.AbsolutePath == "/api/v1/user")
                return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = 27, jellyfinUserId = user.Id.ToString().ToUpperInvariant() }, new { id = 28, jellyfinUserId = blocked.Id.ToString() } } }));
            Assert.Equal("27", Assert.Single(request.Headers.GetValues("X-Api-User")));
            if (request.Method == HttpMethod.Get)
                return IntegrationTransport.Response(alreadyPresent ? "{\"results\":[{\"tmdbId\":123,\"mediaType\":\"movie\"}]}" : "{\"results\":[]}");
            posts++;
            Assert.Equal("/api/v1/watchlist", request.RequestUri.AbsolutePath);
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            Assert.Equal(123, payload.RootElement.GetProperty("tmdbId").GetInt32());
            Assert.Equal("movie", payload.RootElement.GetProperty("mediaType").GetString());
            return IntegrationTransport.Response();
        });
        var progress = new ProgressLog();
        await new JellyfinToSeerrWatchlistSyncTask(library.Object, users.Object, data.Object, transport, f.Core.Manager, f.Core.Logger).ExecuteAsync(progress, default);
        Assert.Equal(alreadyPresent ? 0 : 1, posts);
        Assert.Equal(alreadyPresent ? 2 : 3, transport.Calls);
        Assert.Equal(100, progress.Values.Last());
        data.Verify(d => d.GetUserData(blocked, It.IsAny<BaseItem>()), Times.Never);
    }

    [Fact]
    public void DisabledWatchlistMonitorDoesNotSubscribeAndDisposalUnsubscribes()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.AddRequestedMediaToWatchlist = false;
        var library = new Mock<ILibraryManager>();
        using (var monitor = new WatchlistMonitor(library.Object, null!, null!, null!, f.Core.Manager, f.Core.Logger)) monitor.Initialize();
        library.VerifyAdd(l => l.ItemAdded += It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Never);
        library.VerifyRemove(l => l.ItemAdded -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
        library.VerifyRemove(l => l.ItemUpdated -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
    }
    [Fact]
    public void ReinitializingWatchlistMonitorDoesNotLeakEventSubscriptions()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.AddRequestedMediaToWatchlist = true;
        f.Plugin.Configuration.JellyseerrEnabled = true;
        var library = new Mock<ILibraryManager>();
        using (var monitor = new WatchlistMonitor(library.Object, null!, null!, null!, f.Core.Manager, f.Core.Logger))
        {
            monitor.Initialize();
            monitor.Initialize();
        }
        library.VerifyAdd(l => l.ItemAdded += It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
        library.VerifyAdd(l => l.ItemUpdated += It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
        library.VerifyRemove(l => l.ItemAdded -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
        library.VerifyRemove(l => l.ItemUpdated -= It.IsAny<EventHandler<ItemChangeEventArgs>>(), Times.Once);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task AnalyticsTaskHonorsConsentAndReportingCadence(bool consent)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.AnalyticsEnabled = consent;
        config.AnalyticsLastReportedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        config.AnalyticsLastReportedPluginVersion = f.Plugin.Version.ToString();
        config.AnalyticsLastReportedJellyfinTarget = HostCompatibilityService.BuiltFor;
        config.AnalyticsLastReportedJellyfinVersion = "test-host";
        var host = new Mock<MediaBrowser.Controller.IServerApplicationHost>();
        host.SetupGet(h => h.ApplicationVersionString).Returns("test-host");
        var http = new Mock<IHttpClientFactory>(MockBehavior.Strict);
        var service = new AnalyticsReportingService(http.Object, f.Core.Paths.Object, host.Object, null!, f.Core.Manager, f.Core.Logger);
        var progress = new ProgressLog();
        await new AnalyticsReportTask(service).ExecuteAsync(progress, default);
        Assert.Equal(new double[] { 0, 100 }, progress.Values);
        http.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ArrSyncCancellationStopsBeforeLibraryMutations()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.ArrTagsSyncEnabled = true;
        var library = new Mock<ILibraryManager>(MockBehavior.Strict);
        var http = new Mock<IHttpClientFactory>(MockBehavior.Strict);
        var progress = new ProgressLog();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new ArrTagsSyncTask(library.Object, http.Object, f.Core.Logger).ExecuteAsync(progress, new CancellationToken(true)));
        library.VerifyNoOtherCalls();
        http.VerifyNoOtherCalls();
        Assert.DoesNotContain(100, progress.Values);
    }

    [Theory]
    [InlineData("", "key")][InlineData("http://seerr.test", "")]
    public async Task EnabledSeerrTasksWithoutCredentialsDoNotTouchLibraryOrNetwork(string url, string apiKey)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.JellyseerrAutoImportUsers = true;
        config.SyncJellyfinWatchlistToSeerr = true;
        config.SyncJellyseerrWatchlist = true;
        config.AddRequestedMediaToWatchlist = true;
        config.JellyseerrUrls = url;
        config.JellyseerrApiKey = apiKey;
        IScheduledTask[] tasks = [new JellyseerrUserImportTask(null!, null!, f.Core.Logger),
            new JellyfinToSeerrWatchlistSyncTask(null!, null!, null!, null!, null!, f.Core.Logger),
            new JellyseerrWatchlistSyncTask(null!, null!, null!, null!, null!, f.Core.Logger)];
        foreach (var task in tasks)
        {
            var progress = new ProgressLog();
            await task.ExecuteAsync(progress, default);
            Assert.Equal(100, Assert.Single(progress.Values));
        }
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task SeerrMasterSwitchAloneKeepsSeerrTasksIdle(bool seerrEnabled)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        // Every task flag on and valid credentials: only the master switch differs.
        config.JellyseerrEnabled = seerrEnabled;
        config.JellyseerrAutoImportUsers = true;
        config.SyncJellyfinWatchlistToSeerr = true;
        config.SyncJellyseerrWatchlist = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "seerr-key";
        foreach (var name in new[] { "import", "export", "watchlist" })
        {
            var library = new Mock<ILibraryManager>(); var users = new Mock<IUserManager>();
            var data = new Mock<IUserDataManager>(); var http = new Mock<IHttpClientFactory>();
            IScheduledTask task = name switch
            {
                "import" => new JellyseerrUserImportTask(users.Object, http.Object, f.Core.Logger),
                "export" => new JellyfinToSeerrWatchlistSyncTask(library.Object, users.Object, data.Object, http.Object, f.Core.Manager, f.Core.Logger),
                _ => new JellyseerrWatchlistSyncTask(library.Object, users.Object, data.Object, http.Object, f.Core.Manager, f.Core.Logger),
            };
            var progress = new ProgressLog();
            try { await task.ExecuteAsync(progress, default); }
            catch (Exception) when (seerrEnabled) { /* the unconfigured fakes may fail a running task */ }
            var touched = library.Invocations.Count + users.Invocations.Count + data.Invocations.Count + http.Invocations.Count;
            if (seerrEnabled)
            {
                // Control: with the switch on, the same setup reaches the task's dependencies.
                Assert.True(touched > 0, name + " never ran with Seerr enabled");
            }
            else
            {
                Assert.Equal(0, touched);
                Assert.Equal(100, Assert.Single(progress.Values));
            }
        }
    }
}
