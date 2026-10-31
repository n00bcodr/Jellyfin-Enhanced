using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using System.Net;

namespace JE.Tests;

public class IntegrationStatusScenesTests
{
    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task KeywordsResolveOnceDailyThroughSharedResponsesAndKeepLastGoodFactsOnFailure()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        int calls = 0;
        bool fail = false;
        using var transport = new IntegrationTransport((request, _) =>
        {
            calls++;
            Assert.Equal("/3/movie/7/keywords", request.RequestUri!.AbsolutePath);
            return Task.FromResult(fail ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                : IntegrationTransport.Response("{\"keywords\":[{\"name\":\"aftercreditsstinger\"}]}"));
        });
        using var cache = new TmdbResponseCache(transport, clock);
        var scenes = new StatusTagsScenesService(cache, env.Logger, clock);
        await scenes.WarmAsync("key", ["7", "7"], default);
        Assert.Equal(new TagScenes(true, false), scenes.Get("key", "7"));
        await scenes.WarmAsync("key", ["7"], default);
        Assert.Equal(1, calls);
        clock.Now = clock.Now.AddDays(1);
        await scenes.WarmAsync("key", ["7"], default);
        Assert.Equal(2, calls);
        fail = true;
        clock.Now = clock.Now.AddDays(1);
        await scenes.WarmAsync("key", ["7"], default);
        Assert.Equal(3, calls);
        Assert.Equal(new TagScenes(true, false), scenes.Get("key", "7"));
        await scenes.WarmAsync("key", ["7"], default);
        Assert.Equal(3, calls);
        await scenes.WarmAsync("key", ["8", "9"], default);
        Assert.Equal(3, calls);
        await scenes.WarmAsync("", ["7"], default);
        Assert.Equal(3, calls);
    }

    [Fact]
    public async Task CancellationStopsTheMoviePassWithoutCancellingSharedTransport()
    {
        using var env = new IntegrationEnvironment();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, _) =>
        {
            started.TrySetResult();
            await release.Task;
            return IntegrationTransport.Response("{\"keywords\":[]}");
        });
        using var responses = new TmdbResponseCache(transport, TimeProvider.System);
        var scenes = new StatusTagsScenesService(responses, env.Logger);
        using var cancellation = new CancellationTokenSource();
        var refresh = scenes.WarmAsync("key", ["7", "8", "9"], cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => refresh.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(1, transport.Calls);
            Assert.Null(scenes.Get("key", "7"));
        }
        finally { release.TrySetResult(); }
    }

    [Fact]
    public async Task DailyRefreshHonoursFailurePauseAcrossMidnightAndRetriesAfterTheHour()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock { Now = DateTimeOffset.Parse("2026-10-30T23:45:00Z") };
        bool fail = true;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(fail
            ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) : IntegrationTransport.Response("{\"keywords\":[]}")));
        using var responses = new TmdbResponseCache(transport, clock);
        var scenes = new StatusTagsScenesService(responses, env.Logger, clock);
        await scenes.WarmAsync("key", ["7", "8"], default);
        Assert.Equal(1, transport.Calls);
        clock.Now = clock.Now.AddMinutes(30);
        Assert.False(scenes.IsDue("key", "8"));
        await scenes.WarmAsync("key", ["8", "7"], default);
        Assert.Equal(1, transport.Calls);
        clock.Now = clock.Now.AddMinutes(31);
        fail = false;
        Assert.True(scenes.IsDue("key", "8"));
        await scenes.WarmAsync("key", ["8"], default);
        Assert.Equal(2, transport.Calls);
        Assert.False(scenes.IsDue("key", "8"));
    }

}

[Collection("Plugin singleton")]
public class StatusScenesReadTests
{
    private sealed class Movie : MediaBrowser.Controller.Entities.Movies.Movie
    {
        public override List<MediaBrowser.Model.Dto.MediaSourceInfo> GetMediaSources(bool enablePathSubstitution) => [];
    }

    [Fact]
    public async Task ColdBatchAndNativeReadsMakeZeroOutboundCallsAndGatherOneRefresh()
    {
        using var fixture = new ApiPluginFixture();
        var config = fixture.Plugin.Configuration;
        config.StatusTagsEnabled = config.StatusTagsScenes = true;
        config.SpoilerBlurEnabled = false;
        config.TMDB_API_KEY = "key";
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{\"keywords\":[{\"name\":\"aftercreditsstinger\"}]}")));
        using var responses = new TmdbResponseCache(transport, TimeProvider.System);
        var scenes = new StatusTagsScenesService(responses, fixture.Core.Logger);
        var movie = new Movie { Id = Guid.NewGuid(), Name = "Film", ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "7" } };
        var user = new Jellyfin.Database.Implementations.Entities.User("viewer", "default", "default") { Id = Guid.NewGuid() };
        var users = new Moq.Mock<MediaBrowser.Controller.Library.IUserManager>();
        users.Setup(x => x.GetUserById(user.Id)).Returns(user);
        var library = new Moq.Mock<MediaBrowser.Controller.Library.ILibraryManager>();
        library.Setup(x => x.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(movie.Id, user)).Returns(movie);
        using var cache = new TagCacheService(library.Object, fixture.Core.Paths.Object, Moq.Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Helpers.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger), scenesService: scenes)
            { ScenesRefreshDelay = TimeSpan.FromSeconds(1) };
        var controller = ApiAssetTests.Controller(fixture.Core, users.Object, library.Object, cache);
        controller.HttpContext.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
            [new System.Security.Claims.Claim("Jellyfin-UserId", user.Id.ToString())], "test"));
        var result = Assert.IsType<Microsoft.AspNetCore.Mvc.OkObjectResult>(controller.GetTagData(user.Id, [movie.Id.ToString()]));
        var json = System.Text.Json.JsonSerializer.SerializeToElement(result.Value);
        Assert.Equal(System.Text.Json.JsonValueKind.Null, json.GetProperty("Items")[0].GetProperty("Scenes").ValueKind);
        Assert.Null(cache.BuildEntryOnDemand(movie)!.Scenes);
        Assert.Null(cache.GetScenes(movie));
        Assert.Equal(0, transport.Calls);
        Assert.Equal(1, cache.PendingScenesRefreshes);
        await cache.ScenesWorkQueue.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, transport.Calls);
        Assert.Equal(new TagScenes(true, false), cache.GetScenes(movie));
        Assert.Equal(0, cache.PendingScenesRefreshes);
    }

    [Fact]
    public async Task DisposalCancelsGatheredRefreshBeforeAnyOutboundCall()
    {
        using var fixture = new ApiPluginFixture();
        fixture.Plugin.Configuration.StatusTagsEnabled = fixture.Plugin.Configuration.StatusTagsScenes = true;
        fixture.Plugin.Configuration.TMDB_API_KEY = "key";
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        using var responses = new TmdbResponseCache(transport, TimeProvider.System);
        using var cache = new TagCacheService(Moq.Mock.Of<MediaBrowser.Controller.Library.ILibraryManager>(), fixture.Core.Paths.Object,
            Moq.Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>(), fixture.Core.Logger,
            new Jellyfin.Plugin.JellyfinEnhanced.Helpers.MatroskaLanguageCache(fixture.Core.Paths.Object, fixture.Core.Logger),
            scenesService: new StatusTagsScenesService(responses, fixture.Core.Logger)) { ScenesRefreshDelay = TimeSpan.FromMinutes(1) };
        cache.QueueScenesRefresh([new Movie { ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "7" } }]);
        Assert.Equal(1, cache.PendingScenesRefreshes);
        cache.Dispose();
        await cache.ScenesWorkQueue.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, transport.Calls);
        Assert.Equal(0, cache.PendingScenesRefreshes);
    }
}
