using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;
namespace JE.Tests;

public class LanguageChipStyleTests
{
    [Fact]
    public void LanguageChipFixturesShareQualityMetricsAndResolveEveryPresetAndLabelBeforePainting()
    {
        using var stream = typeof(LanguageChipStyleTests).Assembly.GetManifestResourceStream("LanguageChipStyles.json")!;
        var fixture = JsonNode.Parse(stream)!;
        using var renderer = new PosterTagRenderer();
        foreach (var preset in fixture["presets"]!.AsArray())
        {
            var document = preset!["document"]?.ToJsonString() ?? "";
            Assert.True(TagStyleSet.TryValidate(document, (string)preset["id"]!, out var styles, out var error), error);
            if (styles.IsPoster) styles = styles.WithSampled(PosterColour.Example);
            foreach (var chip in fixture["chips"]!.AsArray())
            {
                var tag = new LanguageTag("gb", "English", false) { Code = (string?)chip!["code"], CountBadge = (string?)chip["badge"], Subtitle = (bool?)chip["subtitle"] ?? false, Sdh = (bool?)chip["sdh"] ?? false, StyleLabel = "en" };
                var kind = tag.CountBadge is not null ? "countBadge" : tag.Subtitle ? "subtitles" : "code";
                var label = tag.CountBadge?.ToLowerInvariant() ?? "en";
                var actual = styles.ResolveLanguageChip(label, kind).Over(TagStylePalettes.Builtin("language", kind));
                var expected = styles.IsPoster ? PosterColour.Example : new TagColors((string)preset["background"]!, (string)preset["border"]!, (string)preset["text"]!);
                if (preset["document"] is not null) expected = expected with { Background = label == "multi" ? "rgba(102, 0, 102, 1)" : expected.Background, Text = label == "en" ? "rgba(255, 0, 0, 1)" : expected.Text };
                Assert.Equal(expected, actual);
                var layout = new PosterTagLayout([new(PosterTagGroup.Language, PosterTagCorner.TopLeft, [tag])], false, false, styles);
                var item = Assert.Single(Assert.Single(renderer.Plan(180, 270, layout).Groups).Items);
                Assert.Equal((string)chip["text"]!, item.Text);
                var quality = new PosterTagLayout([new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, [new QualityTag((string)chip["text"]!, "other")])], false, false);
                var other = Assert.Single(Assert.Single(renderer.Plan(180, 270, quality).Groups).Items);
                if (kind == "code") Assert.True(item.Width < other.Width, "Short codes use tighter padding without shrinking their text.");
                else Assert.Equal(other.Width, item.Width);
                Assert.Equal(other.Height, item.Height);
                Assert.Equal(other.TextLayout!.FontSize, item.TextLayout!.FontSize);
                using var source = new SKBitmap(180, 270); source.Erase(SKColors.Transparent);
                using var painted = renderer.Render(source, layout);
                Assert.NotNull(painted);
                Assert.Contains(painted.Bytes, b => b > 0);
            }
        }
    }

    [Fact]
    public void OnlyFlagImagesKeepTheirRingAndPartialChipsOnlyDim()
    {
        var styles = TagStyleSet.Parse("{\"v\":2,\"groups\":{\"language\":{\"background\":\"#123456\",\"text\":\"#abcdef\",\"border\":\"#ffffff\"}}}", "poster").WithSampled(PosterColour.Example);
        Assert.Null(styles.Resolve("language", "flag").Background);
        Assert.Null(styles.Resolve("language", "flag").Text);
        Assert.Equal("rgba(255, 255, 255, 1)", styles.Resolve("language", "flag").Border);
        Assert.True(TagStyleCatalog.IsLabel("language", "en-us"));
        Assert.False(TagStyleCatalog.IsLabel("language", "en\";body{}"));
        Assert.True(TagStyleKeys.FieldApplies("language", "background"));
    }
}
