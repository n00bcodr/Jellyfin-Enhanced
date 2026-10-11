using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;
namespace JE.Tests;

public class TagStyleTests
{
    private const string Json = "{\"quality\":{\"4K\":{\"background\":\"#ff0000\",\"color\":\"rgba(0,0,255,0.5)\"},\"X\":{\"background\":\"url(x)\"}},\"age\":{\"13\":{\"border\":\"#00ff00\"}},\"rating\":{\"community\":{\"background\":\"#123456\"}}}";

    [Fact]
    public void Parse_normalises_colours_and_drops_anything_that_is_not_a_colour()
    {
        var set = TagStyleSet.Parse(Json);
        Assert.Equal("rgba(255, 0, 0, 1)", set.Quality["4K"].Background);
        Assert.Equal("rgba(0, 0, 255, 0.502)", set.Quality["4K"].Text);
        Assert.False(set.Quality.ContainsKey("X"));
        Assert.Equal("rgba(0, 255, 0, 1)", set.Age["13"].Border);
        Assert.NotEmpty(set.Hash);
        Assert.True(TagStyleSet.Parse("not json").IsEmpty);
        Assert.True(TagStyleSet.Parse("").IsEmpty);
    }

    [Fact]
    public void Web_model_expands_age_groups_to_their_ratings()
    {
        var web = System.Text.Json.JsonSerializer.Serialize(TagStyleSet.Parse(Json).ToWebModel());
        Assert.Contains("\"PG\"", web);
        Assert.Contains("rgba(0, 255, 0, 1)", web);
    }

    [Fact]
    public void Native_settings_digest_and_pixels_follow_the_overrides_only_when_the_target_includes_native()
    {
        PosterTagSettings For(string target, bool enabled = true) => PosterTagSettings.Create(null, new PluginConfiguration { TagStylesEnabled = enabled, TagStyleOverrides = Json, TagStyleTarget = target });
        Assert.True(For("web").Styles.IsEmpty);
        Assert.True(For("both", enabled: false).Styles.IsEmpty);
        Assert.False(For("native").Styles.IsEmpty);
        Assert.NotEqual(For("web").Digest, For("both").Digest);
        Assert.Equal(For("native").Digest, For("both").Digest);

        using var renderer = new PosterTagRenderer();
        var tags = new List<PosterTagGroupLayout> { new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, [new QualityTag("4K", "resolution")]) };
        SKColor Pixel(TagStyleSet? styles)
        {
            using var source = new SKBitmap(180, 270);
            source.Erase(SKColors.Black);
            using var drawn = renderer.Render(source, new PosterTagLayout(tags, false, false, styles))!;
            return drawn.GetPixel(14, 14);
        }

        var plain = Pixel(null);
        var styled = Pixel(TagStyleSet.Parse(Json));
        Assert.NotEqual(plain, styled);
        Assert.True(styled.Red > 200 && styled.Green < 60, $"expected the red override, got {styled}");
    }
}
