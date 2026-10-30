using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using SkiaSharp;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class NativeStatusFreshnessTests
{
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.Parse("2026-10-30T12:04:29Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Theory]
    [InlineData("GET", 200)]
    [InlineData("HEAD", 200)]
    [InlineData("GET", 304)]
    public async Task Late_bucket_HTTP_responses_cannot_keep_a_status_past_its_URL_bucket(string method, int status)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.NativePosterTagsEnabled = config.StatusTagsEnabled = true;
        config.StatusTagsJustAddedDays = 1;
        config.StatusTagsTrending = false;
        var clock = new Clock();
        var bucket = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        var settings = PosterTagSettings.FromSettingsJson("{statusTagsEnabled:true,nativePosterTimeZone:'UTC'}", config);
        var user = new User("fixture", "default", "default") { Id = Guid.NewGuid() };
        var item = new Movie { Id = Guid.NewGuid() };
        // This badge's window ends at 12:02, within the URL's 12:00–12:05 bucket.
        var entry = new TagCacheEntry { Type = "Movie", DateCreated = bucket.AddDays(-1).AddMinutes(2).ToUnixTimeMilliseconds() };
        Assert.NotNull(StatusRules.Resolve(entry, settings, new(bucket)));
        Assert.Null(StatusRules.Resolve(entry, settings, new(clock.Now)));
        var library = new Mock<ILibraryManager>();
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        using var data = new PosterTagDataProvider(cache, library.Object, null!, null!, null!, f.Core.Logger);
        var composites = CompositeImageCache.Create(null, 1024 * 1024, 0, 1, TimeSpan.FromSeconds(1), _ => { });
        using var renderer = new PosterTagRenderer();
        using var services = new ServiceCollection().AddSingleton(renderer).AddSingleton(new PosterTagStatusProvider(null!, data, library.Object)).BuildServiceProvider();
        var composer = new PosterTagComposer(data, composites, services);
        var filter = new PosterTagImageFilter(null!, null!, null!, data, composer, null!, null!, library.Object, null!, f.Core.Logger, clock);
        var snapshot = new PosterTagDataSnapshot(entry, PosterTagReviewSummary.None, "abcdef");
        var tokenService = PosterTagVariantToken.CreateForPath(Path.Combine(f.Core.Root, "native-key"), _ => { });
        var token = tokenService.Mint(user.Id, item.Id, settings.DigestAt(bucket), PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.True(tokenService.Verify(token, user.Id, item.Id, settings.DigestAt(clock.Now), PosterTagComposer.PixelVersion, out var variant));
        var plan = new PosterTagImageFilter.Plan(item, user, settings, variant, "base-jet" + token, snapshot, true, false, clock.Now);
        using var bitmap = new SKBitmap(360, 540);
        bitmap.Erase(SKColors.DarkSlateBlue);
        using var encoded = bitmap.Encode(SKEncodedImageFormat.Jpeg, 100);
        var original = new FileContentResult(encoded.ToArray(), "image/jpeg");
        ActionExecutedContext Response()
        {
            var http = new DefaultHttpContext();
            http.Request.Method = method;
            http.Response.StatusCode = status;
            return new ActionExecutedContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), [], new object()) { Result = original };
        }
        var response = Response();
        await filter.PostProcessAsync(response, plan, default);
        Assert.Equal("public,max-age=31", response.HttpContext.Response.Headers.CacheControl.ToString());
        Assert.Equal(bucket.AddMinutes(5), clock.Now.AddSeconds(31)); // browser/CDN freshness deadline
        if (status == 200) Assert.NotSame(original, response.Result); // actual image composition, including HEAD
        clock.Now = bucket.AddMinutes(5);
        Assert.False(tokenService.Verify(token, user.Id, item.Id, settings.DigestAt(clock.Now), PosterTagComposer.PixelVersion, out _));
        var expired = Response();
        await filter.PostProcessAsync(expired, plan, default);
        Assert.Contains("no-store", expired.HttpContext.Response.Headers.CacheControl.ToString());
        Assert.Same(original, expired.Result);
    }

    [Fact]
    public void Subsecond_and_crossed_bucket_responses_have_no_freshness()
    {
        var bucket = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        Assert.Equal(0, PosterTagImageFilter.StatusMaxAge(bucket, bucket.AddMinutes(5).AddMilliseconds(-100)));
        Assert.Equal(0, PosterTagImageFilter.StatusMaxAge(bucket, bucket.AddMinutes(5)));
        Assert.Equal(0, PosterTagImageFilter.StatusMaxAge(bucket, bucket.AddMinutes(6)));
    }
}
