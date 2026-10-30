using System.Text.Json;
using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;

namespace JE.Tests;

public class CoreTagScaleSettingsTests
{
    [Theory]
    [InlineData(" SMALLER ", " TIGHT ", "smaller", "tight")]
    [InlineData("largest", "roomy", "largest", "roomy")]
    [InlineData("huge", "huge", "default", "default")]
    [InlineData(null, null, null, null)]
    public void ValidationAndRoundTrip(string? scale, string? gap, string? expectedScale, string? expectedGap)
    {
        var user = new JellyfinEnhancedUserSettings { TagScale = scale, TagGap = gap, TagLayoutSettingsVersion = 1 };
        TagLayoutRules.Normalize(user);
        Assert.Equal(expectedScale, user.TagScale);
        Assert.Equal(expectedGap, user.TagGap);
        var restored = JsonSerializer.Deserialize<JellyfinEnhancedUserSettings>(JsonSerializer.Serialize(user))!;
        Assert.Equal((expectedScale, expectedGap), (restored.TagScale, restored.TagGap));
        var shape = TagShapeRules.NormalizeLook(new TagShapeLook { TagScale = scale, TagGap = gap })!;
        Assert.Equal(TagLayoutRules.ReadScale(scale), shape.TagScale);
        Assert.Equal(TagLayoutRules.ReadGap(gap), shape.TagGap);
    }

    [Fact]
    public void AdminDefaultsSeedAndRoundTripWhileLegacyKeepsItsLook()
    {
        var config = new PluginConfiguration { TagScale = "largest", TagGap = "roomy" };
        using var writer = new StringWriter();
        new XmlSerializer(typeof(PluginConfiguration)).Serialize(writer, config);
        using var reader = new StringReader(writer.ToString());
        var restored = (PluginConfiguration)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(reader)!;
        var seeded = new JellyfinEnhancedUserSettings();
        TagLayoutRules.ApplyDefaults(seeded, restored);
        Assert.Equal((1, "largest", "roomy"), (seeded.TagLayoutSettingsVersion, seeded.TagScale, seeded.TagGap));
        var legacy = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true}", config);
        Assert.Equal(("default", "default"), (legacy.TagScale, legacy.TagGap));
        var inherited = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,tagLayoutSettingsVersion:1}", config);
        Assert.Equal(("largest", "roomy"), (inherited.TagScale, inherited.TagGap));
        var own = PosterTagSettings.FromSettingsJson("{qualityTagsEnabled:true,tagLayoutSettingsVersion:1,tagScale:'default',tagGap:'tight'}", config);
        Assert.Equal(("default", "tight"), (own.TagScale, own.TagGap));
        Assert.NotEqual(legacy.Digest, inherited.Digest);
        Assert.NotEqual(inherited.Digest, own.Digest);
    }

    [Theory]
    [InlineData("smaller", 0.85f)]
    [InlineData("default", 1f)]
    [InlineData("larger", 1.15f)]
    [InlineData("largest", 1.30f)]
    public void NativeMetricsMultiplyClampsAndKeepEdgeInset(string scale, float multiplier)
    {
        var baseline = new PosterTagCss(180);
        var css = new PosterTagCss(180, scale);
        Assert.Equal(baseline.QualityFontSize * multiplier, css.QualityFontSize);
        Assert.Equal(baseline.QualityPaddingH * multiplier, css.QualityPaddingH);
        Assert.Equal(baseline.FlagWidth * multiplier, css.FlagWidth);
        Assert.Equal(baseline.GenreGlyphSize * multiplier, css.GenreGlyphSize);
        Assert.Equal(baseline.RatingIconSize * multiplier, css.RatingIconSize);
        Assert.Equal(baseline.IndicatorOffset * multiplier, css.IndicatorOffset);
        using var renderer = new PosterTagRenderer();
        var plan = renderer.Plan(180, 270, Layout() with { TagScale = scale });
        Assert.Equal(6f, plan.Groups[0].X);
        Assert.Equal(6f, plan.Groups[0].Y);
    }

    [Theory]
    [InlineData("tight", 0.75f)]
    [InlineData("default", 1f)]
    [InlineData("roomy", 1.5f)]
    public void NativeGapChangesSpacingWithoutChangingText(string gap, float multiplier)
    {
        var baseline = new PosterTagCss(180);
        var css = new PosterTagCss(180, "default", gap);
        Assert.Equal(baseline.QualityGap * multiplier, css.QualityGap);
        Assert.Equal(baseline.StackGap * multiplier, css.StackGap);
        Assert.Equal(baseline.QualityFontSize, css.QualityFontSize);
        Assert.Equal(baseline.RatingInnerGap, css.RatingInnerGap);
    }

    [Fact]
    public void NativeDefaultsRemainPixelIdenticalAndTilesStaySeparateAcrossSettings()
    {
        using var source = new SKBitmap(360, 540);
        source.Erase(SKColors.DarkSlateBlue);
        using var cached = new PosterTagRenderer();
        using var uncached = new PosterTagRenderer(0);
        using var baseline = cached.Render(source, Layout());
        using var explicitDefaults = cached.Render(source, Layout() with { TagScale = "default", TagGap = "default" });
        Assert.Equal(baseline!.Pixels, explicitDefaults!.Pixels);
        foreach (var scale in new[] { "smaller", "larger", "largest", "default" })
        foreach (var gap in new[] { "tight", "roomy", "default" })
        {
            var layout = Layout() with { TagScale = scale, TagGap = gap };
            using var actual = cached.Render(source, layout);
            using var expected = uncached.Render(source, layout);
            Assert.Equal(expected!.Pixels, actual!.Pixels);
            if (scale != "default" || gap != "default") Assert.False(baseline.Pixels.SequenceEqual(actual.Pixels));
        }
    }

    [Theory]
    [InlineData("smaller", "tight", 0.85f, 0.75f)]
    [InlineData("default", "default", 1f, 1f)]
    [InlineData("largest", "roomy", 1.3f, 1.5f)]
    public void AwardsScaleTheirIconAndInterChipGap(string scale, string gap, float size, float spacing)
    {
        using var renderer = new PosterTagRenderer();
        var plan = renderer.Plan(180, 270, Layout() with { TagScale = scale, TagGap = gap });
        var awards = Assert.Single(plan.Groups, g => g.Group == PosterTagGroup.Awards);
        Assert.Equal(14 * size, awards.Items[0].IconWidth);
        Assert.Equal(14 * size, awards.Items[0].IconHeight);
        Assert.Equal(PosterTagCss.Lu(4 * size * spacing), awards.Gap);
        Assert.Equal(awards.Items[0].Height + awards.Gap, awards.Items[1].Y - awards.Items[0].Y, 4);
    }

    private static PosterTagLayout Layout() => new([
        new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, [new QualityTag("4K", "resolution"), new QualityTag("HEVC", "videoCodec")]),
        new(PosterTagGroup.Rating, PosterTagCorner.TopLeft, [new RatingTag(PosterRatingSource.Community, "8.1", true)]),
        new(PosterTagGroup.Language, PosterTagCorner.BottomLeft, [new LanguageTag("gb", "English", false)]),
        new(PosterTagGroup.Awards, PosterTagCorner.BottomRight, [new AwardTag("imdbTop250", "Top 250"), new AwardTag("oscar", "Oscar winner")]),
    ], false, false);
}
