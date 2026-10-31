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
}
