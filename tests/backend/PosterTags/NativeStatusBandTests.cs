using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;

namespace JE.Tests;

public class NativeStatusBandTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
    private static PosterTagSettings Settings(string json, PluginConfiguration? config = null) => PosterTagSettings.FromSettingsJson(json, config ?? new());

    [Theory]
    [InlineData("bg", "4.10")]
    [InlineData("cs", "4. 10.")]
    [InlineData("es", "4 oct")]
    [InlineData("fa", "۱۲ مهر")]
    [InlineData("fi", "4.10.")]
    [InlineData("sk", "4. 10.")]
    public void Short_dates_match_browser_month_day_formats_reported_in_review(string locale, string expected)
        => Assert.Equal(expected, StatusRules.FormatShortDate(new DateOnly(2026, 10, 4), System.Globalization.CultureInfo.GetCultureInfo(locale)));

    [Fact]
    public void Every_generated_browser_region_matches_native_on_calendar_boundaries()
    {
        using var stream = typeof(NativeStatusBandTests).Assembly.GetManifestResourceStream("NativeStatusDates.json")!;
        var fixtures = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string[]>>(stream)!;
        var dates = new[] { new DateOnly(2026, 1, 4), new DateOnly(2026, 3, 20), new DateOnly(2026, 3, 21), new DateOnly(2026, 10, 4) };
        foreach (var (locale, expected) in fixtures)
        {
            // Test all browser enumeration entries, including regions .NET does
            // not register for persistence. Unknown shipped `pr` uses English.
            var culture = System.Globalization.CultureInfo.GetCultureInfo(locale.StartsWith("pr", StringComparison.Ordinal) ? "en" : locale);
            for (var i = 0; i < dates.Length; i++)
                Assert.True(expected[i] == StatusRules.FormatShortDate(dates[i], culture), $"{locale} {dates[i]}: {expected[i]}");
        }
    }

    [Theory]
    [InlineData("en-IN-posix", "4 Oct")]
    [InlineData("zh-Hant-HK-posix", "10月4日")]
    public void Ungenerated_variants_keep_the_closest_regional_ancestor(string locale, string expected)
        => Assert.Equal(expected, StatusRules.FormatShortDate(new DateOnly(2026, 10, 4), System.Globalization.CultureInfo.GetCultureInfo(locale)));

    [Fact]
    public void Status_urls_retire_each_five_minutes_even_when_settings_snapshot_is_cached()
    {
        Assert.Equal("18", PosterTagSettings.ResolverVersion);
        var on = Settings("{statusTagsEnabled:true}");
        var off = Settings("{qualityTagsEnabled:true}");
        Assert.NotEqual(on.DigestAt(Now), on.DigestAt(Now.AddMinutes(5)));
        Assert.Equal(on.DigestAt(Now), on.DigestAt(Now.AddMinutes(4)));
        Assert.Equal(off.DigestAt(Now), off.DigestAt(Now.AddDays(1)));
        Assert.NotEqual(on.DigestAt(Now), Settings("{statusTagsEnabled:true,statusTagsSchedule:false}").DigestAt(Now));
        Assert.NotEqual(Settings("{statusTagsEnabled:true,nativePosterTimeZone:'UTC'}").DigestAt(Now), Settings("{statusTagsEnabled:true,nativePosterTimeZone:'Australia/Perth'}").DigestAt(Now));
        Assert.NotEqual(on.DigestAt(Now), Settings("{statusTagsEnabled:true,nativePosterDateLocale:'de-DE'}").DigestAt(Now));
        Assert.NotEqual(on.DigestAt(Now), Settings("{statusTagsEnabled:true}", new() { StatusTagsJustAddedDays = 2 }).DigestAt(Now));
    }

    [Fact]
    public void Legacy_status_arrives_before_language_in_a_shared_corner_like_the_web()
    {
        var settings = Settings("{statusTagsEnabled:true,languageTagsEnabled:true,statusTagsPosition:'bottom-left'}");
        var entry = new TagCacheEntry { Type = "Movie", DateCreated = Now.AddDays(-1).ToUnixTimeMilliseconds(), AudioLanguages = ["eng"] };
        var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null, new(Now)), false)!;
        Assert.Equal(new[] { PosterTagGroup.Status, PosterTagGroup.Language }, layout.Groups.Select(g => g.Group));
        Assert.All(layout.Groups, g => Assert.Equal(PosterTagCorner.BottomLeft, g.Corner));
    }

    [Fact]
    public void Native_defaults_seed_all_status_preferences_and_windows()
    {
        var config = new PluginConfiguration { StatusTagsEnabled = true, StatusTagsJustAdded = false, StatusTagsSchedule = false,
            StatusTagsMilestones = false, StatusTagsSeriesStatus = true, StatusTagsNewReleaseDays = 900, StatusTagsJustAddedDays = 0 };
        var settings = PosterTagSettings.FromSettingsJson(null, config);
        Assert.True(settings.AnyGroupEnabled);
        Assert.False(settings.StatusJustAdded);
        Assert.False(settings.StatusSchedule);
        Assert.False(settings.StatusMilestones);
        Assert.True(settings.StatusSeriesStatus);
        Assert.Equal(365, settings.StatusNewReleaseDays);
        Assert.Equal(1, settings.StatusJustAddedDays);
        Assert.False(Settings("{}", config).StatusTagsEnabled);
    }

    [Fact]
    public void Native_popular_needs_admin_and_user_switches_and_a_key()
    {
        var user = "{statusTagsEnabled:true}";
        Assert.False(Settings(user).StatusTrending);
        Assert.False(Settings(user, new() { TMDB_API_KEY = "fixture" }).StatusTrending);
        Assert.True(Settings(user, new() { StatusTagsEnabled = true, TMDB_API_KEY = "fixture" }).StatusTrending);
        Assert.False(Settings("{statusTagsEnabled:true,statusTagsTrending:false}", new() { StatusTagsEnabled = true, TMDB_API_KEY = "fixture" }).StatusTrending);
    }

    [Theory]
    [InlineData("caption")]
    [InlineData("summary")]
    [InlineData("minimal")]
    public void Title_and_hover_layouts_fall_back_to_saved_corners(string layout)
    {
        var settings = Settings("{statusTagsEnabled:true,tagLayoutSettingsVersion:1,tagLayout:'" + layout + "',tagLayouts:{corners:{groups:[{group:'status',slot:'bc'}]}}}");
        Assert.False(settings.Bands);
        Assert.Equal("bottom-center", settings.StatusTagsPosition);
    }

    [Fact]
    public void Bands_resolve_saved_profile_default_order_caps_and_compact_labels()
    {
        var settings = Settings("{statusTagsEnabled:true,qualityTagsEnabled:true,ratingTagsEnabled:true,ageRatingTagsEnabled:true,tagLayoutSettingsVersion:1,tagLayout:'bands',tagLabelDensity:'compact',tagGroupCaps:{quality:1},tagLayouts:{bands:{groups:[{group:'ageRating',slot:'off'}]}}}");
        var entry = new TagCacheEntry { Type = "Movie", DateCreated = Now.AddDays(-1).ToUnixTimeMilliseconds(), OfficialRating = "R", CommunityRating = 8, CriticRating = 90,
            StreamData = new() { Streams = [new() { Type = "Video", Height = 2160, Codec = "hevc" }] } };
        var layout = PosterTagResolver.Resolve(entry, settings, new("Movie", true, null, null, null, new(Now)), false)!;
        Assert.True(layout.Bands);
        Assert.True(layout.TopRightOffset);
        Assert.Equal(new[] { PosterTagGroup.Status, PosterTagGroup.Quality, PosterTagGroup.Rating }, layout.Groups.Select(g => g.Group));
        Assert.Single(layout.Groups[1].Tags);
        Assert.Equal("Added", Assert.IsType<StatusTag>(layout.Groups[0].Tags.Single()).Text);
        Assert.Single(layout.Groups[2].Tags); // compact drops critic beside community
        Assert.Equal(PosterTagCorner.TopLeft, layout.Groups[0].Corner);
        Assert.Equal(PosterTagCorner.BottomLeft, layout.Groups[1].Corner);
    }

    [Fact]
    public void Bands_fit_whole_chips_keep_middle_clear_and_show_exact_overflow_count()
    {
        using var renderer = new PosterTagRenderer();
        using var source = new SKBitmap(360, 540);
        source.Erase(new SKColor(70, 90, 130));
        var layout = new PosterTagLayout([
            new(PosterTagGroup.Status, PosterTagCorner.TopLeft, [new StatusTag("season_finale", "Season Finale", "season_finale")]),
            new(PosterTagGroup.Quality, PosterTagCorner.BottomLeft, Enumerable.Range(1, 12).Select(i => (PosterTag)new QualityTag("Quality " + i, "source")).ToArray())
        ], false, false, Bands: true);
        var plan = renderer.Plan(360, 540, layout);
        Assert.Equal(2, plan.Bands.Count);
        var bottom = plan.Groups[1].Items;
        var more = Assert.IsType<OverflowTag>(bottom.Last().Tag);
        Assert.Equal(12 - (bottom.Count - 1), more.Count);
        Assert.Equal("+" + more.Count, bottom.Last().Text);
        Assert.True(bottom.Select(i => i.Y).Distinct().Count() <= 2);
        Assert.All(bottom, i => Assert.InRange(i.X + i.Width, 0, plan.CardWidth - 6));
        using var rendered = renderer.Render(source, layout);
        Assert.NotNull(rendered);
        Assert.Equal(source.GetPixel(180, 270), rendered.GetPixel(180, 270));
        Assert.NotEqual(source.GetPixel(0, 0), rendered.GetPixel(0, 0));
        Assert.NotEqual(source.GetPixel(0, 539), rendered.GetPixel(0, 539));
    }

    [Theory]
    [InlineData(PosterTagCorner.TopLeft, 180)]
    [InlineData(PosterTagCorner.BottomLeft, 180)]
    [InlineData(PosterTagCorner.TopLeft, 360)]
    [InlineData(PosterTagCorner.BottomLeft, 360)]
    public void Bands_natural_narrow_4I_metrics_match_browser_nine_chips_and_plus_three(PosterTagCorner corner, int width)
    {
        using var renderer = new PosterTagRenderer();
        var layout = new PosterTagLayout([new(PosterTagGroup.Quality, corner,
            Enumerable.Repeat<PosterTag>(new QualityTag("4I", "resolution"), 12).ToArray())], false, false, Bands: true);
        var chips = renderer.Plan(width, width * 3 / 2, layout).Groups.Single().Items;
        Assert.Equal(9, chips.Count(i => i.Tag is QualityTag));
        Assert.Equal("+3", chips.Last().Text);
        Assert.All(chips.Where(i => i.Tag is QualityTag), i => Assert.InRange(i.Width, 29.09375f - 0.01f, 29.09375f + 0.01f));
    }

    [Fact]
    public void Bands_shared_web_width_height_fixtures_skip_rejected_chips_and_count_all_omissions()
    {
        using var stream = typeof(NativeStatusBandTests).Assembly.GetManifestResourceStream("NativeBandFit.json")!;
        using var doc = System.Text.Json.JsonDocument.Parse(stream);
        foreach (var fixture in doc.RootElement.EnumerateArray())
        {
            float Number(string key) => fixture.GetProperty(key).GetSingle();
            var widths = fixture.GetProperty("widths").EnumerateArray().Select(v => v.GetSingle()).ToArray();
            var heights = fixture.GetProperty("heights").EnumerateArray().Select(v => v.GetSingle()).ToArray();
            float MoreWidth(int count) => fixture.TryGetProperty("moreWidths", out var measured)
                ? measured.GetProperty(count >= 10 ? "12" : "1").GetSingle() : Number("moreWidth");
            var expected = fixture.GetProperty("shown").EnumerateArray().Select(v => v.GetBoolean()).ToArray();
            Assert.Equal(expected, PosterTagPlanner.BandChipsThatFit(widths, Number("available"), Number("gap"), (int)Number("maxRows"), MoreWidth(widths.Length)));
            var items = widths.Select((w, i) => new PlannedItem(PosterTagTileKind.Status, new StatusTag("fixture", i.ToString(), ""), i.ToString(), "", w, heights[i])).ToArray();
            var placed = PosterTagPlanner.FitBandChips(items, Number("available"), Number("height"), Number("gap"), count =>
                new PlannedItem(PosterTagTileKind.Status, new StatusTag("overflow", "+" + count, ""), "+" + count, "", MoreWidth(count), 18));
            Assert.Equal(expected, items.Select(placed.Contains));
            var more = placed.SingleOrDefault(p => p.Text.StartsWith('+'));
            Assert.Equal(Number("hidden") == 0 ? null : "+" + Number("hidden"), more?.Text);
        }
    }

    [Fact]
    public void Bands_render_skips_a_wide_middle_quality_chip_but_keeps_later_small_chips()
    {
        using var renderer = new PosterTagRenderer();
        using var source = new SKBitmap(360, 540);
        source.Erase(SKColors.DarkSlateBlue);
        var layout = new PosterTagLayout([new(PosterTagGroup.Quality, PosterTagCorner.BottomLeft,
            [new QualityTag("4K", "resolution"), new QualityTag(new string('W', 100), "edition"), new QualityTag("BD", "source")])], false, false, Bands: true);
        var plan = renderer.Plan(360, 540, layout);
        Assert.Equal(new[] { "4K", "BD", "+1" }, plan.Groups.Single().Items.Select(i => i.Text));
        using var rendered = renderer.Render(source, layout);
        Assert.NotNull(rendered);
        Assert.NotEqual(source.Bytes, rendered.Bytes);
    }

    [Fact]
    public void Status_label_colours_and_compact_quality_keep_distinct_warm_tiles()
    {
        using var renderer = new PosterTagRenderer();
        using var cold = new PosterTagRenderer(0);
        using var source = new SKBitmap(360, 540);
        source.Erase(SKColors.Black);
        var styles = TagStyleSet.Parse("{\"v\":2,\"labels\":{\"status:season_finale\":{\"background\":\"#ff0000\"},\"status:series_finale\":{\"background\":\"#00ff00\"}}}", "default");
        byte[] Pixels(PosterTagRenderer r, string key)
        {
            var layout = new PosterTagLayout([new(PosterTagGroup.Status, PosterTagCorner.TopLeft, [new StatusTag(key, "Finale", key)])], false, false, styles);
            using var result = r.Render(source, layout);
            return result!.Bytes;
        }
        var season = Pixels(renderer, "season_finale");
        var series = Pixels(renderer, "series_finale");
        Assert.NotEqual(season, series);
        Assert.Equal(series, Pixels(cold, "series_finale"));
        Assert.Equal(season, Pixels(renderer, "season_finale"));
    }
}
