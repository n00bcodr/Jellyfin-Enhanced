using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services;

namespace JE.Tests.Features.Platform;

/// <summary>
/// Canopy #7 (with L7): no runtime asset comes from a mutable upstream branch. Locales come only from the
/// plugin's embedded set; the plugin's own repository assets are exact URLs at a pinned commit; every fetch
/// stays https on an allow-listed host and under its source's size cap. Pinned fetches use forceRefresh so
/// the service's process-wide hot and negative caches cannot leak between tests.
/// </summary>
public class CdnAssetPinningTests
{
    private static string Embedded(string code)
    {
        using var stream = Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Assets.PackedResources.Open(typeof(CdnAssetService).Assembly, $"Jellyfin.Plugin.JellyfinEnhanced.js.locales.{code}.json")!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    [Fact]
    public void EverySourceUrlIsHttpsOnAnAllowListedHostAndNoneFollowsABranch()
    {
        var urls = CdnAssetService.SourceUrls().ToList();
        Assert.NotEmpty(urls);
        Assert.All(urls, url => Assert.True(CdnAssetService.IsAllowedUrl(new Uri(url)), url));
        Assert.DoesNotContain(urls, url => url.Contains("raw.githubusercontent.com", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(urls, url => url.Contains("n00bcodr/Jellyfin-Enhanced@main", StringComparison.OrdinalIgnoreCase)
            || url.Contains("n00bcodr/Jellyfin-Enhanced/main", StringComparison.OrdinalIgnoreCase));
        Assert.Matches("^[0-9a-f]{40}$", CdnAssetService.JellyfinEnhancedPinnedCommit);

        Assert.False(CdnAssetService.IsAllowedUrl(new Uri("http://cdn.jsdelivr.net/gh/x")));
        Assert.False(CdnAssetService.IsAllowedUrl(new Uri("https://raw.githubusercontent.com/n00bcodr/Jellyfin-Enhanced/main/x")));
        Assert.False(CdnAssetService.IsAllowedUrl(new Uri("https://api.github.com/repos/x")));
        Assert.True(CdnAssetService.IsAllowedUrl(new Uri("https://cdn.jsdelivr.net/gh/x")));
    }

    [Theory]
    [InlineData("de")]
    [InlineData("en")]
    [InlineData("zh-HK")]
    public async Task LocalesAreServedFromTheEmbeddedSetWithoutAnyNetworkCall(string code)
    {
        using var f = new CoreFixture();
        using var transport = new IntegrationTransport((_, _) => throw new InvalidOperationException("network used"));
        var service = new CdnAssetService(f.Logger, transport, f.Paths.Object);
        Assert.True(service.IsValidSource("locales"));

        var asset = await service.GetAsync("locales", code + ".json", forceRefresh: true, CancellationToken.None);
        Assert.NotNull(asset);
        Assert.Equal("application/json", asset.ContentType);
        Assert.Equal(Embedded(code), Encoding.UTF8.GetString(asset.Content).TrimStart('﻿'));

        // A language the plugin does not ship is a 404, not a fetch from the upstream repository.
        Assert.Null(await service.GetAsync("locales", "xx-YY.json", forceRefresh: true, CancellationToken.None));
        Assert.Null(await service.GetAsync("locales", "de.js", forceRefresh: true, CancellationToken.None));
        Assert.Equal(0, transport.Calls);
    }

    [Theory]
    [InlineData("je-css", "ratings.css", "text/css", "css/ratings.css")]
    [InlineData("je-docs-img", "ratings.png", "image/png", "docs/images/ratings.png")]
    [InlineData("je-docs-img", "plugin-icons.png", "image/png", "docs/images/plugin-icons.png")]
    public async Task RepositoryAssetsAreFetchedFromTheirExactPinnedUrlOnly(string source, string path, string type, string repoPath)
    {
        using var f = new CoreFixture();
        var requested = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            requested.Add(request.RequestUri!.ToString());
            return Task.FromResult(IntegrationTransport.Response("asset", type: type));
        });
        var service = new CdnAssetService(f.Logger, transport, f.Paths.Object);

        Assert.NotNull(await service.GetAsync(source, path, forceRefresh: true, CancellationToken.None));
        Assert.Equal(
            new[] { $"https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@{CdnAssetService.JellyfinEnhancedPinnedCommit}/{repoPath}" },
            requested);

        // Anything not on the source's exact list is refused before any network call.
        Assert.Null(await service.GetAsync(source, "other.css", forceRefresh: true, CancellationToken.None));
        Assert.Null(await service.GetAsync(source, "sub/" + path, forceRefresh: true, CancellationToken.None));
        Assert.Single(requested);
    }

    [Fact]
    public async Task APinnedAssetOverItsSourcesSizeCapIsRefused()
    {
        using var f = new CoreFixture();
        var size = 0;
        using var transport = new IntegrationTransport((_, _) =>
            Task.FromResult(IntegrationTransport.Response(new string('a', size), type: "text/css")));
        var service = new CdnAssetService(f.Logger, transport, f.Paths.Object);

        size = 256 * 1024 + 1;   // je-css: 256 KiB
        Assert.Null(await service.GetAsync("je-css", "ratings.css", forceRefresh: true, CancellationToken.None));
        size = 256 * 1024;
        Assert.NotNull(await service.GetAsync("je-css", "ratings.css", forceRefresh: true, CancellationToken.None));
    }

    [Fact]
    public async Task AResponseRedirectedOffTheAllowListIsDiscarded()
    {
        using var f = new CoreFixture();
        using var transport = new IntegrationTransport((_, _) =>
        {
            var response = IntegrationTransport.Response("<svg/>", type: "image/svg+xml");
            response.RequestMessage = new HttpRequestMessage(HttpMethod.Get, "https://attacker.example/icon.svg");
            return Task.FromResult(response);
        });
        var service = new CdnAssetService(f.Logger, transport, f.Paths.Object);
        var path = "svg/redirected-" + Guid.NewGuid().ToString("N") + ".svg";
        Assert.Null(await service.GetAsync("selfhst", path, forceRefresh: true, CancellationToken.None));
        Assert.Equal(1, transport.Calls);
    }
}
