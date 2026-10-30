using System.Net;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using Microsoft.AspNetCore.Mvc;
using SkiaSharp;

namespace JE.Tests;

/// <summary>The Logos tag group: lookups, the image proxy, projection into cache entries and native posters.</summary>
[Collection("Plugin singleton")]
public class LogoTagTests
{
    private sealed class Clock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan by) => _now += by;
    }

    private const string Providers = """
        {"id":603,"results":{"US":{"flatrate":[
          {"provider_id":8,"provider_name":"Netflix","logo_path":"/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg"},
          {"provider_id":9,"provider_name":"Prime Video","logo_path":"/emthp39XA2YScoYL1p0sdbAH2WA.jpg"},
          {"provider_id":10,"provider_name":"Bad","logo_path":"../../etc/passwd"}]},
         "GB":{"flatrate":[{"provider_id":11,"provider_name":"Now","logo_path":"/now.png"}]}}}
        """;

    private const string MovieDetails = """
        {"id":603,"production_companies":[
          {"id":1,"name":"Warner Bros. Pictures","logo_path":"/wb.png"},
          {"id":2,"name":"Village Roadshow","logo_path":null},
          {"id":3,"name":"","logo_path":"/blank.png"}]}
        """;

    private static readonly byte[] Png = SyntheticPng(40, 20, new SKColor(255, 0, 255));

    private static byte[] SyntheticPng(int width, int height, SKColor color)
    {
        using var bitmap = new SKBitmap(width, height);
        bitmap.Erase(color);
        using var image = SKImage.FromBitmap(bitmap);
        return image.Encode(SKEncodedImageFormat.Png, 100).ToArray();
    }

    private static (TagLogoService Service, IntegrationTransport Transport, Clock Clock, string Dir) Service(Func<HttpRequestMessage, HttpResponseMessage> answer, Func<bool>? slow = null)
    {
        var dir = Path.Combine(Path.GetTempPath(), "je-logos-" + Guid.NewGuid().ToString("N"));
        var clock = new Clock();
        // A slow answer makes lookups queue for the four upstream slots, as on a real network.
        var transport = new IntegrationTransport(async (request, _) =>
        {
            if (slow?.Invoke() == true) await Task.Delay(20);
            return answer(request);
        });
        var cache = new TmdbResponseCache(transport, clock);
        var service = new TagLogoService(transport, cache, clock, Path.Combine(dir, "tag-logos.json"), Path.Combine(dir, "logos"), null, 4, 1000, TimeSpan.FromSeconds(10));
        return (service, transport, clock, dir);
    }

    private static void Cleanup(TagLogoService service, string dir)
    {
        service.Dispose();
        if (Directory.Exists(dir)) Directory.Delete(dir, true);
    }

    private static HttpResponseMessage Image(byte[] bytes)
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
        response.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
        return response;
    }

    [Fact]
    public void ParsesTheRegionsFlatRateProvidersAndTheCompaniesWithServableLogosOnly()
    {
        var us = TagLogoService.ParseProviders(Providers, "US")!;
        Assert.Equal(new[] { "Netflix", "Prime Video" }, us.Select(p => p.Name));
        Assert.Equal("/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg", us[0].Logo);
        Assert.Empty(TagLogoService.ParseProviders(Providers, "DE")!);
        Assert.Null(TagLogoService.ParseProviders("not json", "US"));

        var companies = TagLogoService.ParseDetails(MovieDetails, "movie")!;
        Assert.Equal(new[] { "Warner Bros. Pictures", "Village Roadshow" }, companies.Select(c => c.Name));
        Assert.Null(companies[1].Logo);
        var networks = TagLogoService.ParseDetails("""{"networks":[{"name":"HBO","logo_path":"/hbo.png"},{"name":"Evil","logo_path":"/a/../b.png"}]}""", "tv")!;
        Assert.Equal("/hbo.png", networks[0].Logo);
        Assert.Null(networks[1].Logo);
        Assert.False(TagLogoService.IsLogoPath("/x.svg"));
        Assert.False(TagLogoService.IsLogoPath("x.png"));
    }

    [Fact]
    public async Task LookupsAreKeptForADayAndAuthoritativeMissesAreEmptyAnswers()
    {
        var (service, transport, clock, dir) = Service(request => request.RequestUri!.AbsolutePath.EndsWith("/watch/providers", StringComparison.Ordinal)
            ? IntegrationTransport.Response(Providers)
            : IntegrationTransport.Response("{}", 404));
        try
        {
            Assert.Equal(0, await service.WarmAsync(null, [("movie", "603", TagLogoService.LookupKind.Providers)], "US", CancellationToken.None));
            Assert.Equal(0, transport.Calls);
            await service.WarmAsync("key", [("movie", "603", TagLogoService.LookupKind.Providers), ("tv", "7", TagLogoService.LookupKind.Details), ("movie", "x1", TagLogoService.LookupKind.Providers)], "US", CancellationToken.None);
            Assert.Equal(2, transport.Calls);
            Assert.True(service.TryGet("movie", "603", TagLogoService.LookupKind.Providers, "US", out var found));
            Assert.Equal(2, found.Items.Length);
            Assert.True(service.TryGet("tv", "7", TagLogoService.LookupKind.Details, "US", out var missing));
            Assert.False(missing.Failed);
            Assert.Empty(missing.Items);
            Assert.True(service.IsAllowed("w92", "pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg"));

            clock.Advance(TimeSpan.FromHours(23));
            await service.WarmAsync("key", [("movie", "603", TagLogoService.LookupKind.Providers)], "US", CancellationToken.None);
            Assert.Equal(2, transport.Calls);
            clock.Advance(TimeSpan.FromHours(7)); // past both the lookup TTL and the response cache's six hours
            await service.WarmAsync("key", [("movie", "603", TagLogoService.LookupKind.Providers)], "US", CancellationToken.None);
            Assert.Equal(3, transport.Calls);

            // Another region is another lookup; the lookups survive a restart.
            Assert.False(service.TryGet("movie", "603", TagLogoService.LookupKind.Providers, "GB", out _));
            service.SaveToDisk();
            var reloaded = new TagLogoService(transport, new TmdbResponseCache(transport, clock), clock, Path.Combine(dir, "tag-logos.json"), Path.Combine(dir, "logos"), null);
            Assert.True(reloaded.TryGet("movie", "603", TagLogoService.LookupKind.Providers, "US", out var restored));
            Assert.Equal(found.Items, restored.Items);
            Assert.True(reloaded.IsAllowed("w92", "pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg"));
        }
        finally
        {
            Cleanup(service, dir);
        }
    }

    [Fact]
    public async Task FailuresKeepEarlierDataRetryAfterAnHourAndStopEarlyWhenOffline()
    {
        var fail = false;
        var (service, transport, clock, dir) = Service(_ => fail ? IntegrationTransport.Response("{}", 503) : IntegrationTransport.Response(Providers), () => fail);
        try
        {
            await service.WarmAsync("key", [("movie", "603", TagLogoService.LookupKind.Providers)], "US", CancellationToken.None);
            fail = true;
            clock.Advance(TimeSpan.FromDays(2));
            await service.WarmAsync("key", [("movie", "603", TagLogoService.LookupKind.Providers)], "US", CancellationToken.None);
            Assert.True(service.TryGet("movie", "603", TagLogoService.LookupKind.Providers, "US", out var kept));
            Assert.True(kept.Failed);
            Assert.Equal(2, kept.Items.Length);
            Assert.False(service.IsDue("movie", "603", TagLogoService.LookupKind.Providers, "US"));
            clock.Advance(TagLogoService.RetryAfter);
            Assert.True(service.IsDue("movie", "603", TagLogoService.LookupKind.Providers, "US"));

            // Offline: after the first failures the rest of a large warm is left for the next run.
            var calls = transport.Calls;
            var many = Enumerable.Range(1000, 200).Select(id => ("movie", id.ToString(System.Globalization.CultureInfo.InvariantCulture), TagLogoService.LookupKind.Providers));
            await service.WarmAsync("key", many, "US", CancellationToken.None);
            Assert.InRange(transport.Calls - calls, TagLogoService.FailFastAfter, TagLogoService.FailFastAfter + TagLogoService.MaxInFlight);
        }
        finally
        {
            Cleanup(service, dir);
        }
    }

    [Fact]
    public async Task TheProxyServesOnlyKnownLogosFromItsDiskCacheWithAStrongETag()
    {
        var images = 0;
        var (service, _, clock, dir) = Service(request =>
        {
            if (request.RequestUri!.Host == "image.tmdb.org")
            {
                images++;
                Assert.Equal("/t/p/w92/wb.png", request.RequestUri.AbsolutePath);
                return Image(Png);
            }

            return IntegrationTransport.Response(MovieDetails);
        });
        try
        {
            Assert.Null(await service.GetImageAsync("w92", "wb.png", CancellationToken.None));
            await service.WarmAsync("key", [("movie", "603", TagLogoService.LookupKind.Details)], "US", CancellationToken.None);
            Assert.False(service.IsAllowed("w500", "wb.png"));
            Assert.False(service.IsAllowed("w92", "../wb.png"));
            Assert.False(service.IsAllowed("w92", "unknown.png"));

            var first = await service.GetImageAsync("w92", "wb.png", CancellationToken.None);
            var second = await service.GetImageAsync("w92", "wb.png", CancellationToken.None);
            Assert.NotNull(first);
            Assert.Equal(1, images);
            Assert.Equal(Png, second!.Bytes);
            Assert.Equal(first!.ETag, second.ETag);
            Assert.Equal("image/png", first.ContentType);
            Assert.True(service.IsCached("w92", "wb.png"));
            Assert.NotNull(service.TryReadCached("w92", "wb.png"));

            using var fixture = new CoreFixture();
            var controller = ApiAssetTests.Controller(fixture);
            var ok = Assert.IsType<FileContentResult>(await controller.GetLogoImage("w92", "wb.png", service, CancellationToken.None));
            Assert.Equal(Png, ok.FileContents);
            Assert.Equal(first.ETag, controller.Response.Headers.ETag.ToString());
            Assert.Contains("max-age", controller.Response.Headers.CacheControl.ToString());
            controller = ApiAssetTests.Controller(fixture);
            controller.Request.Headers.IfNoneMatch = first.ETag;
            Assert.Equal(304, Assert.IsType<StatusCodeResult>(await controller.GetLogoImage("w92", "wb.png", service, CancellationToken.None)).StatusCode);
            Assert.IsType<NotFoundResult>(await ApiAssetTests.Controller(fixture).GetLogoImage("w92", "other.png", service, CancellationToken.None));
            Assert.IsType<NotFoundResult>(await ApiAssetTests.Controller(fixture).GetLogoImage("original", "wb.png", service, CancellationToken.None));
        }
        finally
        {
            Cleanup(service, dir);
        }
    }

    [Fact]
    public async Task AFailedImageIsRetriedOnlyAfterTenMinutesAndSvgIsRefused()
    {
        var images = 0;
        var (service, _, clock, dir) = Service(request =>
        {
            if (request.RequestUri!.Host != "image.tmdb.org") return IntegrationTransport.Response(MovieDetails);
            images++;
            return IntegrationTransport.Response("<svg/>", 200, "image/svg+xml");
        });
        try
        {
            await service.WarmAsync("key", [("movie", "603", TagLogoService.LookupKind.Details)], "US", CancellationToken.None);
            Assert.Null(await service.GetImageAsync("w92", "wb.png", CancellationToken.None));
            Assert.Null(await service.GetImageAsync("w92", "wb.png", CancellationToken.None));
            Assert.Equal(1, images);
            clock.Advance(TimeSpan.FromMinutes(11));
            Assert.Null(await service.GetImageAsync("w92", "wb.png", CancellationToken.None));
            Assert.Equal(2, images);
            Assert.False(service.IsCached("w92", "wb.png"));
        }
        finally
        {
            Cleanup(service, dir);
        }
    }

    [Fact]
    public async Task EntriesTakeProvidersStudiosOrNetworksPerModeWithTheAdministratorsMaximum()
    {
        var (service, _, _, dir) = Service(request => request.RequestUri!.AbsolutePath switch
        {
            "/3/movie/603/watch/providers" => IntegrationTransport.Response(Providers),
            "/3/movie/603" => IntegrationTransport.Response(MovieDetails),
            "/3/movie/604/watch/providers" => IntegrationTransport.Response("""{"results":{}}"""),
            _ => IntegrationTransport.Response("{}", 404),
        });
        try
        {
            var config = new PluginConfiguration();
            var movie = new Movie { Id = Guid.NewGuid(), Studios = ["Warner Bros Pictures", "Village Roadshow"], ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "603" } };
            var series = new Series { Id = Guid.NewGuid(), Studios = ["Home Box Office"], ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "1399" } };

            // No lookup yet (no key, offline): the studio / network names.
            var offline = TagCacheService.ResolveLogos(movie, config, service)!;
            Assert.Equal(new TagLogo { Kind = "studio", Name = "Warner Bros Pictures" }, Assert.Single(offline));
            Assert.Equal(new TagLogo { Kind = "network", Name = "Home Box Office" }, Assert.Single(TagCacheService.ResolveLogos(series, config, service)!));

            await service.WarmAsync("key", [("movie", "603", TagLogoService.LookupKind.Providers), ("movie", "603", TagLogoService.LookupKind.Details)], "US", CancellationToken.None);
            Assert.Equal(new TagLogo { Kind = "provider", Name = "Netflix", Logo = "/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg" }, Assert.Single(TagCacheService.ResolveLogos(movie, config, service)!));
            config.LogoTagsMaxLogos = 2;
            Assert.Equal(new[] { "Netflix", "Prime Video" }, TagCacheService.ResolveLogos(movie, config, service)!.Select(l => l.Name));

            // Studio mode: Jellyfin's names, with the TMDB company logo of the same name.
            config.LogoTagsMovieMode = "studio";
            var studios = TagCacheService.ResolveLogos(movie, config, service)!;
            Assert.Equal("/wb.png", studios[0].Logo);
            Assert.Null(studios[1].Logo);
            Assert.All(studios, s => Assert.Equal("studio", s.Kind));

            // Provider mode for a title nothing streams falls back to the studio.
            config.LogoTagsMovieMode = "provider";
            var other = new Movie { Id = Guid.NewGuid(), Studios = ["A24"], ProviderIds = new(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = "604" } };
            await service.WarmAsync("key", [("movie", "604", TagLogoService.LookupKind.Providers)], "US", CancellationToken.None);
            Assert.Equal("studio", Assert.Single(TagCacheService.ResolveLogos(other, config, service)!).Kind);

            config.LogoTagsMovieMode = "off";
            Assert.Null(TagCacheService.ResolveLogos(movie, config, service));
            Assert.Null(TagCacheService.ResolveLogos(new Movie { Id = Guid.NewGuid() }, new PluginConfiguration { LogoTagsMovieMode = "studio" }, service));
            Assert.True(TagCacheService.SameName("Warner Bros. Pictures", "warner bros pictures"));
        }
        finally
        {
            Cleanup(service, dir);
        }
    }

    [Fact]
    public void SettingsNormaliseModesRegionAndMaximumAndTheLayoutKnowsTheGroup()
    {
        var config = new PluginConfiguration { LogoTagsMovieMode = "NETWORK", LogoTagsSeriesMode = "studio", LogoTagsMaxLogos = 9, LogoTagsRegion = "gb", DEFAULT_REGION = "de" };
        LogoTagRules.Normalize(config);
        Assert.Equal("provider", config.LogoTagsMovieMode);
        Assert.Equal("network", config.LogoTagsSeriesMode);
        Assert.Equal(2, config.LogoTagsMaxLogos);
        Assert.Equal("GB", LogoTagRules.Region(config));
        config.LogoTagsRegion = "nowhere";
        LogoTagRules.Normalize(config);
        Assert.Equal(string.Empty, config.LogoTagsRegion);
        Assert.Equal("DE", LogoTagRules.Region(config));
        Assert.Equal(1, LogoTagRules.Max(0));

        Assert.False(new PluginConfiguration().LogoTagsEnabled);
        Assert.False(new JellyfinEnhancedUserSettings().LogoTagsEnabled);
        Assert.Equal("logos", TagLayoutRules.NormalizeGroup("LOGOS"));
        Assert.Equal(7, TagLayoutRules.NormalizeCaps(new TagGroupCaps { Logos = 7 })!.Logos);
        Assert.Equal(TagLayoutRules.MaxCap, TagLayoutRules.NormalizeCaps(new TagGroupCaps { Logos = 99 })!.Logos);
        var profile = TagLayoutRules.NormalizeProfile("bands", new TagLayoutProfile { Groups = [new() { Group = "logos", Slot = "top" }, new() { Group = "logos", Slot = "dots" }] })!;
        Assert.Equal("top", Assert.Single(profile.Groups).Slot);
    }

    [Fact]
    public void CacheEntriesCompareCloneAndSerializeLogos()
    {
        var entry = new TagCacheEntry { Type = "Movie", Logos = [new() { Kind = "provider", Name = "Netflix", Logo = "/n.png" }] };
        var copy = entry.Clone();
        Assert.Same(entry.Logos, copy.Logos);
        Assert.True(TagCacheEntry.ContentEquals(entry, copy));
        copy.Logos = [new() { Kind = "provider", Name = "Netflix" }];
        Assert.False(TagCacheEntry.ContentEquals(entry, copy));
        Assert.NotEqual(PosterTagDataProvider.ContentHash(entry), PosterTagDataProvider.ContentHash(copy));
        var json = JsonSerializer.Serialize(copy.Logos);
        Assert.Equal("""[{"kind":"provider","name":"Netflix"}]""", json);
    }

    [Theory]
    [InlineData("HBO", "HBO")]
    [InlineData("Paramount+ Premium", "PP")]
    [InlineData("Home Box Office Max Extra", "HBOM")]
    [InlineData("Supercalifragilistic", "Supercalifr…")]
    [InlineData("  Twelve chars  ", "Twelve chars")]
    public void NameChipsUseTheNameAnInitialismOrACutName(string name, string expected) => Assert.Equal(expected, LogoRules.ShortName(name));

    [Fact]
    public void NativePostersShowTheGroupOnlyWhenOnAndKeepOtherDigestsUnchanged()
    {
        var off = PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(new JellyfinEnhancedUserSettings { QualityTagsEnabled = true }), new PluginConfiguration());
        var offWithAdminChoice = PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(new JellyfinEnhancedUserSettings { QualityTagsEnabled = true, LogoTagsPosition = "top-right" }), new PluginConfiguration { LogoTagsMaxLogos = 2 });
        Assert.False(off.Shows(PosterTagGroup.Logos));
        Assert.Equal(off.Digest, offWithAdminChoice.Digest);

        var on = PosterTagSettings.FromSettingsJson(JsonSerializer.Serialize(new JellyfinEnhancedUserSettings { LogoTagsEnabled = true, TagLayoutSettingsVersion = 1, TagGroupCaps = new() { Logos = 1 } }), new PluginConfiguration());
        Assert.True(on.AnyGroupEnabled);
        Assert.Equal("bottom-left", on.LogoTagsPosition);
        var entry = new TagCacheEntry { Type = "Episode", Logos = [new() { Kind = "network", Name = "HBO", Logo = "/hbo.png" }, new() { Kind = "network", Name = "Max" }] };
        var layout = PosterTagResolver.Resolve(entry, on, new("Episode", false, null, null, null), false)!;
        var group = Assert.Single(layout.Groups);
        Assert.Equal(PosterTagGroup.Logos, group.Group);
        Assert.Equal(PosterTagCorner.BottomLeft, group.Corner);
        Assert.Equal(new LogoTag("network", "HBO", "/hbo.png"), Assert.Single(group.Tags));
    }

    [Fact]
    public void NativePostersDrawTheCachedLogoOnItsPillAndTheNameWithoutOne()
    {
        var previous = PosterTagAssets.LogoSource;
        try
        {
            PosterTagAssets.LogoSource = path => path == "/synthetic.png" ? Png : null;
            using var renderer = new PosterTagRenderer();
            var tags = new PosterTag[] { new LogoTag("provider", "Streamflix", "/synthetic.png"), new LogoTag("network", "Home Box Office", "/missing.png") };
            var layout = new PosterTagLayout(new List<PosterTagGroupLayout> { new(PosterTagGroup.Logos, PosterTagCorner.TopLeft, tags) }, false, false);
            var plan = renderer.Plan(360, 540, layout);
            var items = Assert.Single(plan.Groups).Items;
            Assert.All(items, i => Assert.Equal(PosterTagTileKind.Logo, i.Kind));
            Assert.StartsWith("provider|", items[0].Style);
            Assert.Equal("HBO", items[1].Text);
            Assert.StartsWith("text|", items[1].Style);
            // 40x20 logo at the chip's image height: twice as wide as tall, plus padding and border.
            Assert.Equal(items[0].IconHeight * 2, items[0].IconWidth, 2);
            Assert.Equal(items[0].Height, items[1].Height);

            using var poster = new SKBitmap(360, 540);
            poster.Erase(new SKColor(20, 20, 20));
            using var drawn = renderer.Render(poster, layout)!;
            var scale = 360f / plan.CardWidth;
            var cx = (int)((items[0].X + items[0].Width / 2) * scale);
            var cy = (int)((items[0].Y + items[0].Height / 2) * scale);
            Assert.Equal(new SKColor(255, 0, 255), drawn.GetPixel(cx, cy));
            var tx = (int)((items[1].X + 1.5f) * scale);
            var ty = (int)((items[1].Y + items[1].Height / 2) * scale);
            Assert.NotEqual(new SKColor(20, 20, 20), drawn.GetPixel(tx, ty));
        }
        finally
        {
            PosterTagAssets.LogoSource = previous;
        }
    }

    [Fact]
    public void TagStylesOfferTheLogoPillsOnWebAndNativePosters()
    {
        Assert.Contains(TagStyleKeys.Logos, TagStyleKeys.Groups);
        Assert.Equal(new[] { "provider", "company", "text" }, TagStyleCatalog.Labels(TagStyleKeys.Logos).Select(l => l.Key));
        Assert.Equal("rgba(255, 255, 255, 0.902)", TagStylePalettes.Builtin(TagStyleKeys.Logos, "company").Background);
        Assert.Null(TagStylePalettes.Preset(TagStyleKeys.DefaultPreset, TagStyleKeys.Logos, "provider").Background);
        Assert.NotNull(TagStylePalettes.Preset("glass", TagStyleKeys.Logos, "text").Background);
        var json = JsonSerializer.Serialize(TagStyleSet.Parse("""{"v":2,"preset":"default","groups":{"logos":{"background":"#112233"}}}""").ToWebModel());
        Assert.Contains("\"logos\":{\"provider\":{\"background\":\"rgba(17, 34, 51, 1)\"", json);
    }
}
