using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 12: only an answer no cache can have kept proves which build the server runs (RBS1-R12-9). A page took
/// the X-JE-Build header of an Awards answer its browser had kept for 30 minutes as the running build and asked to be
/// reloaded. The page now confirms any build a cacheable answer names through one handshake, GET /JellyfinEnhanced/version,
/// which it asks for with no-store and which the server answers no-store.
/// </summary>
public class ApiBuildAuthorityTests
{
    private static ResponseCacheAttribute? CacheOf(string action)
        => typeof(JellyfinEnhancedController).GetMethod(action, BindingFlags.Instance | BindingFlags.Public)?.GetCustomAttribute<ResponseCacheAttribute>();

    [Fact]
    public void TheHandshakeIsAnsweredNoStore()
    {
        var cache = CacheOf(nameof(JellyfinEnhancedController.GetVersion));
        Assert.NotNull(cache);
        Assert.True(cache!.NoStore);
        Assert.Equal(ResponseCacheLocation.None, cache.Location);
    }

    [Fact]
    public void TheBootstrapStaysNoStore()
    {
        var cache = CacheOf(nameof(JellyfinEnhancedController.GetBootstrap));
        Assert.NotNull(cache);
        Assert.True(cache!.NoStore);
    }
}
