using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests.Features.Platform;

// proxy/avatar keeps Seerr's answers in one process-wide cache. Seerr answers one avatar under many
// spellings of its path (letter case, a trailing slash) and a placeholder image for any unknown user
// id, so any signed-in user can ask for as many distinct cache entries as they like.
[Collection("Plugin singleton")]
public class AvatarProxyCacheTests
{
    private static long CachedBytes => SeerrCaches._avatarCache.Sum(e => (long)e.Value.Content.Length);

    private static async Task<int> Fetch(IEnumerable<string> paths, int bytes, IntegrationTransport? seerr = null)
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.JellyseerrUrls = "http://seerr.test";
        seerr ??= Seerr(bytes);
        var controller = (JePlatformController)ApiAssetTests.Controller(typeof(JePlatformController), f.Core, seerr, f.Core.Manager);
        var served = 0;
        foreach (var path in paths)
            if (await controller.ProxyAvatar(path) is FileContentResult) served++;
        return served;
    }

    private static IntegrationTransport Seerr(int bytes) => new((_, _) =>
    {
        var content = new ByteArrayContent(new byte[bytes]);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
    });

    private static IEnumerable<string> Ids(int count, int from = 0) => Enumerable.Range(from, count).Select(i => $"/avatarproxy/{i:x32}");

    [Fact]
    public async Task TheCacheKeepsAtMostFiveHundredAvatarsAndSixtyFourMegabytesNewestFirst()
    {
        SeerrCaches._avatarCache.Clear();
        try
        {
            Assert.Equal(600, await Fetch(Ids(600), 1_024));
            Assert.Equal(500, SeerrCaches._avatarCache.Count);

            Assert.Equal(80, await Fetch(Ids(80, 1_000), 1024 * 1024));
            Assert.InRange(CachedBytes, 1, 64L * 1024 * 1024);

            // The newest answers are the ones kept: asking again does not reach Seerr.
            var seerr = Seerr(1024 * 1024);
            Assert.Equal(10, await Fetch(Ids(10, 1_070), 0, seerr));
            Assert.Equal(0, seerr.Calls);
        }
        finally
        {
            SeerrCaches._avatarCache.Clear();
        }
    }

    [Fact]
    public async Task AnAvatarOverTenMegabytesIsNeitherServedNorCached()
    {
        SeerrCaches._avatarCache.Clear();
        try
        {
            Assert.Equal(0, await Fetch(Ids(1), 10 * 1024 * 1024 + 1));
            Assert.Empty(SeerrCaches._avatarCache);
            Assert.Equal(1, await Fetch(Ids(1, 1), 10 * 1024 * 1024));
        }
        finally
        {
            SeerrCaches._avatarCache.Clear();
        }
    }
}
