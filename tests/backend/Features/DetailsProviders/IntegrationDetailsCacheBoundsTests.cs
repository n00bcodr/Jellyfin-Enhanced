using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Models;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Mdblist;

namespace JE.Tests.Features.DetailsProviders;

// Each lookup by TMDB id adds a cache entry that is persisted; a signed-in user can ask about any id.
public class IntegrationDetailsCacheBoundsTests
{
    private static string CacheFile(IntegrationEnvironment env, string name)
    {
        var path = Path.Combine(env.Root, "configurations/Jellyfin.Plugin.JellyfinEnhanced", name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        return path;
    }

    [Fact]
    public async Task MdblistCacheDropsExpiredMissesThenTheOldestButKeepsExpiredRatings()
    {
        using var env = new IntegrationEnvironment();
        var path = CacheFile(env, "mdblist-ratings.json");
        var now = DateTimeOffset.UtcNow;
        // Ratings past their seven days are still what a failed refresh keeps and what rating tags show.
        var items = Enumerable.Range(0, MdblistService.MaxCacheEntries).ToDictionary(
            i => $"movie-{i}", i => new MdblistCacheEntry { Found = true, Confirmed = true, FetchedAtUnixMs = now.AddDays(-8).AddMinutes(-i).ToUnixTimeMilliseconds(), Ratings = [new() { Source = "tmdb", Score = 70 }] });
        for (var i = 0; i < 5; i++)
        {
            items[$"tv-{i}"] = new MdblistCacheEntry { Found = false, Confirmed = true, FetchedAtUnixMs = now.AddDays(-4).ToUnixTimeMilliseconds() };
        }

        File.WriteAllText(path, JsonSerializer.Serialize(new MdblistCacheDiskFormat { SchemaVersion = 2, Items = items }));
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 500)));
        using (var service = new MdblistService(transport, env.Paths.Object, env.Logger))
        {
            await service.GetRatingsAsync("movie", "123456789", default);
            Assert.True(service.GetCachedEntry("movie", "0")!.Found);
        }

        var saved = JsonSerializer.Deserialize<MdblistCacheDiskFormat>(File.ReadAllText(path))!.Items;
        Assert.Equal(MdblistService.MaxCacheEntries, saved.Count);
        Assert.Contains("movie-123456789", saved.Keys);
        Assert.DoesNotContain($"movie-{MdblistService.MaxCacheEntries - 1}", saved.Keys);
        Assert.DoesNotContain(saved.Keys, k => k.StartsWith("tv-", StringComparison.Ordinal));
    }

    [Fact]
    public async Task DoesTheDogDieCacheDropsExpiredEntriesThenTheOldest()
    {
        using var env = new IntegrationEnvironment();
        var path = CacheFile(env, "ddd-cache.json");
        var now = DateTimeOffset.UtcNow;
        var items = Enumerable.Range(0, DoesTheDogDieService.MaxCacheEntries).ToDictionary(
            i => $"movie-{i}", i => new DddCacheEntry { Found = true, Confirmed = true, FetchedAtUnixMs = now.AddMinutes(-i).ToUnixTimeMilliseconds() });
        for (var i = 0; i < 5; i++)
        {
            items[$"tv-{i}"] = new DddCacheEntry { Found = false, Confirmed = true, FetchedAtUnixMs = now.AddDays(-15).ToUnixTimeMilliseconds() };
        }

        File.WriteAllText(path, JsonSerializer.Serialize(new DddCacheDiskFormat { SchemaVersion = 1, Items = items }));
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("[]")));
        using (var service = new DoesTheDogDieService(transport, env.Paths.Object, env.Logger))
        {
            await service.GetWarningsAsync("movie", "123456789", default);
        }

        var saved = JsonSerializer.Deserialize<DddCacheDiskFormat>(File.ReadAllText(path))!.Items;
        Assert.Equal(DoesTheDogDieService.MaxCacheEntries, saved.Count);
        Assert.Contains("movie-123456789", saved.Keys);
        Assert.Contains("movie-0", saved.Keys);
        Assert.DoesNotContain($"movie-{DoesTheDogDieService.MaxCacheEntries - 1}", saved.Keys);
        Assert.DoesNotContain(saved.Keys, k => k.StartsWith("tv-", StringComparison.Ordinal));
    }
}

[Collection("Plugin singleton")]
public class ApiDetailsProvidersTmdbIdTests
{
    [Fact]
    public async Task AnOverlongTmdbIdIsRefusedBeforeItReachesARatingsOrWarningsCache()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.MdblistRatingsEnabled = true;
        f.Plugin.Configuration.DoesTheDogDieEnabled = true;
        f.Plugin.Configuration.DoesTheDogDieApiKey = "test";
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("[]")));
        using var mdblist = new MdblistService(transport, env.Paths.Object, env.Logger);
        using var ddd = new DoesTheDogDieService(transport, env.Paths.Object, env.Logger);
        var controller = (JeDetailsProvidersController)ApiAssetTests.Controller(typeof(JeDetailsProvidersController), f.Core, mdblist, ddd);
        var overlong = new string('7', 11);

        Assert.IsType<BadRequestObjectResult>(await controller.GetMdblistRatings("movie", overlong, default));
        Assert.Null(mdblist.GetCachedEntry("movie", overlong));
        Assert.IsType<BadRequestObjectResult>(await controller.GetDoesTheDogDie("movie", overlong, default));
        Assert.Equal(0, transport.Calls);

        Assert.IsType<OkObjectResult>(await controller.GetMdblistRatings("movie", "1234567890", default));
        Assert.NotNull(mdblist.GetCachedEntry("movie", "1234567890"));
        Assert.IsType<OkObjectResult>(await controller.GetDoesTheDogDie("movie", "1234567890", default));
        Assert.Equal(1, transport.Calls);
    }
}
