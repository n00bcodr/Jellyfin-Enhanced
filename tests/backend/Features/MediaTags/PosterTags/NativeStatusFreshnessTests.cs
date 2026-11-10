using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
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
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;

namespace JE.Tests.Features.MediaTags;

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

    [Theory]
    [InlineData(false, 1)]
    [InlineData(true, 2)]
    public async Task A_poster_renders_once_across_URL_buckets_unless_its_status_changed(bool statusEnds, int renders)
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.NativePosterTagsEnabled = config.StatusTagsEnabled = config.GenreTagsEnabled = true;
        config.StatusTagsJustAddedDays = 1;
        config.StatusTagsTrending = false;
        var first = DateTimeOffset.Parse("2026-10-30T12:01:00Z");
        var second = DateTimeOffset.Parse("2026-10-30T12:06:00Z");
        var clock = new Clock { Now = first };
        var settings = PosterTagSettings.FromSettingsJson("{statusTagsEnabled:true,genreTagsEnabled:true,nativePosterTimeZone:'UTC'}", config);
        var user = new User("fixture", "default", "default") { Id = Guid.NewGuid() };
        var item = new Movie { Id = Guid.NewGuid() };
        // Just added until 12:03 (inside the first bucket only), or added long ago (no status in either).
        var entry = new TagCacheEntry
        {
            Type = "Movie", Genres = ["Drama"],
            DateCreated = (statusEnds ? first.AddDays(-1).AddMinutes(2) : first.AddDays(-30)).ToUnixTimeMilliseconds(),
        };
        Assert.Equal(statusEnds, StatusRules.Resolve(entry, settings, new(first)) != null);
        Assert.Null(StatusRules.Resolve(entry, settings, new(second)));
        var library = new Mock<ILibraryManager>();
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        using var data = new PosterTagDataProvider(cache, library.Object, null!, null!, null!, f.Core.Logger);
        var composites = CompositeImageCache.Create(null, 1024 * 1024 * 16, 0, 1, TimeSpan.FromSeconds(1), _ => { });
        using var renderer = new PosterTagRenderer();
        using var services = new ServiceCollection().AddSingleton(renderer).AddSingleton(new PosterTagStatusProvider(null!, data, library.Object)).BuildServiceProvider();
        var composer = new PosterTagComposer(data, composites, services);
        var filter = new PosterTagImageFilter(null!, null!, null!, data, composer, null!, null!, library.Object, null!, f.Core.Logger, clock);
        var snapshot = new PosterTagDataSnapshot(entry, PosterTagReviewSummary.None, "abcdef");
        var tokenService = PosterTagVariantToken.CreateForPath(Path.Combine(f.Core.Root, "native-key"), _ => { });
        using var bitmap = new SKBitmap(360, 540);
        bitmap.Erase(SKColors.DarkSlateBlue);
        using var encoded = bitmap.Encode(SKEncodedImageFormat.Jpeg, 100);
        foreach (var instant in new[] { first, second })
        {
            clock.Now = instant;
            var token = tokenService.Mint(user.Id, item.Id, settings.DigestAt(instant), PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
            Assert.True(tokenService.Verify(token, user.Id, item.Id, settings.DigestAt(instant), PosterTagComposer.PixelVersion, out var variant));
            var plan = new PosterTagImageFilter.Plan(item, user, settings, variant, "base-jet" + token, snapshot, true, false, instant);
            var http = new DefaultHttpContext();
            http.Request.Method = "GET";
            http.Response.StatusCode = 200;
            var original = new FileContentResult(encoded.ToArray(), "image/jpeg");
            var response = new ActionExecutedContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), [], new object()) { Result = original };
            await filter.PostProcessAsync(response, plan, default);
            Assert.NotSame(original, response.Result);
        }

        // The URL still moves with the bucket (clients ask again); the pixels are drawn again only when they differ.
        Assert.Equal(renders, composites.MemoryCount);
    }

    // Upstream 8d91169c: "watched all of it" is one viewer's state. It reaches the composer through that viewer's own
    // image address, and the composed-poster cache keeps the two pictures apart (its key carries the badge drawn).
    [Fact]
    public async Task A_viewer_who_watched_all_of_a_series_and_one_who_did_not_each_get_their_own_poster()
    {
        using var f = new ApiPluginFixture();
        var config = f.Plugin.Configuration;
        config.NativePosterTagsEnabled = config.StatusTagsEnabled = true;
        config.StatusTagsTrending = false;
        var now = DateTimeOffset.Parse("2026-10-30T12:01:00Z");
        var clock = new Clock { Now = now };
        var settings = PosterTagSettings.FromSettingsJson("{statusTagsEnabled:true,nativePosterTimeZone:'UTC'}", config);
        var item = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
        // In the library for a year, with an episode added an hour ago: New Episode.
        var entry = new TagCacheEntry { Type = "Series", DateCreated = now.AddYears(-1).ToUnixTimeMilliseconds(), LatestEpisodeAdded = now.AddHours(-1).ToUnixTimeMilliseconds() };
        Assert.Equal("new_episode", StatusRules.Resolve(entry, settings, new(now))?.Key);
        Assert.Null(StatusRules.Resolve(entry, settings, new(now, WatchedAll: true)));
        var library = new Mock<ILibraryManager>();
        using var cache = new TagCacheService(library.Object, f.Core.Paths.Object, Mock.Of<ILocalizationManager>(), f.Core.Logger, new MatroskaLanguageCache(f.Core.Paths.Object, f.Core.Logger));
        using var data = new PosterTagDataProvider(cache, library.Object, null!, null!, null!, f.Core.Logger);
        var composites = CompositeImageCache.Create(null, 1024 * 1024 * 16, 0, 1, TimeSpan.FromSeconds(1), _ => { });
        using var renderer = new PosterTagRenderer();
        using var services = new ServiceCollection().AddSingleton(renderer).AddSingleton(new PosterTagStatusProvider(null!, data, library.Object)).BuildServiceProvider();
        var composer = new PosterTagComposer(data, composites, services);
        var filter = new PosterTagImageFilter(null!, null!, null!, data, composer, null!, null!, library.Object, null!, f.Core.Logger, clock);
        var snapshot = new PosterTagDataSnapshot(entry, PosterTagReviewSummary.None, "abcdef");
        var tokenService = PosterTagVariantToken.CreateForPath(Path.Combine(f.Core.Root, "native-key"), _ => { });
        using var bitmap = new SKBitmap(360, 540);
        bitmap.Erase(SKColors.DarkSlateBlue);
        using var encoded = bitmap.Encode(SKEncodedImageFormat.Jpeg, 100);
        var plain = encoded.ToArray();

        async Task<byte[]> Poster(User viewer, PosterTagVariantFlags flags)
        {
            var token = tokenService.Mint(viewer.Id, item.Id, settings.DigestAt(now), PosterTagComposer.PixelVersion, flags, "abcdef");
            Assert.True(tokenService.Verify(token, viewer.Id, item.Id, settings.DigestAt(now), PosterTagComposer.PixelVersion, out var variant));
            Assert.Equal(flags, variant.Flags);
            var plan = new PosterTagImageFilter.Plan(item, viewer, settings, variant, "base-jet" + token, snapshot, true, false, now);
            var http = new DefaultHttpContext();
            http.Request.Method = "GET";
            http.Response.StatusCode = 200;
            var original = new FileContentResult(plain.ToArray(), "image/jpeg");
            var response = new ActionExecutedContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), [], new object()) { Result = original };
            await filter.PostProcessAsync(response, plan, default);
            return response.Result is FileContentResult file ? file.FileContents : [];
        }

        var behind = new User("behind", "default", "default") { Id = Guid.NewGuid() };
        var finished = new User("finished", "default", "default") { Id = Guid.NewGuid() };
        var withBadge = await Poster(behind, PosterTagVariantFlags.None);
        var withoutBadge = await Poster(finished, PosterTagVariantFlags.WatchedAll);
        Assert.NotEqual(plain, withBadge);
        Assert.NotEqual(withBadge, withoutBadge);
        // Whoever asks second gets their own picture, in either order.
        Assert.Equal(withBadge, await Poster(behind, PosterTagVariantFlags.None));
        Assert.Equal(withoutBadge, await Poster(finished, PosterTagVariantFlags.WatchedAll));
        // The same viewer, once finished, loses the badge too (their next address carries the bit).
        Assert.Equal(withoutBadge, await Poster(behind, PosterTagVariantFlags.WatchedAll));
    }

    [Fact]
    public void Subsecond_and_crossed_bucket_responses_have_no_freshness()
    {
        var bucket = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
        Assert.Equal(0, PosterTagImageFilter.StatusMaxAge(bucket, bucket.AddMinutes(5).AddMilliseconds(-100)));
        Assert.Equal(0, PosterTagImageFilter.StatusMaxAge(bucket, bucket.AddMinutes(5)));
        Assert.Equal(0, PosterTagImageFilter.StatusMaxAge(bucket, bucket.AddMinutes(6)));
    }

    [Fact]
    public void A_status_URL_minted_just_before_a_bucket_ends_still_verifies_in_the_next_one_but_not_after()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.NativePosterTagsEnabled = f.Plugin.Configuration.StatusTagsEnabled = true;
        var settings = PosterTagSettings.FromSettingsJson("{statusTagsEnabled:true,nativePosterTimeZone:'UTC'}", f.Plugin.Configuration);
        var tokens = PosterTagVariantToken.CreateForPath(Path.Combine(f.Core.Root, "native-key"), _ => { });
        var user = Guid.NewGuid();
        var item = Guid.NewGuid();
        var minted = DateTimeOffset.Parse("2026-10-30T12:04:59Z");
        var token = tokens.Mint(user, item, settings.DigestAt(minted), PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.True(PosterTagImageFilter.VerifyToken(tokens, token, user, item, settings, minted, out _));
        Assert.True(PosterTagImageFilter.VerifyToken(tokens, token, user, item, settings, minted.AddSeconds(2), out _), "fetched two seconds later, in the next bucket");
        Assert.True(PosterTagImageFilter.VerifyToken(tokens, token, user, item, settings, minted.AddSeconds(300), out _));
        Assert.False(PosterTagImageFilter.VerifyToken(tokens, token, user, item, settings, minted.AddSeconds(302), out _), "two buckets later the URL has retired");
        // Without Status there is no bucket at all: the URL stays valid.
        var plain = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true}", f.Plugin.Configuration);
        var stable = tokens.Mint(user, item, plain.DigestAt(minted), PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "abcdef");
        Assert.True(PosterTagImageFilter.VerifyToken(tokens, stable, user, item, plain, minted.AddDays(3), out _));
    }
}
