using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;
using SkiaSharp;

namespace JE.Tests.Features.MediaTags;

/// <summary>The Poster Tag Styles preset: dominant colour, normalisation, precedence and native pixels.</summary>
public class PosterColourTests
{
    private static SKBitmap Bitmap(int width, int height, Func<int, int, SKColor> paint)
    {
        var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
                bitmap.SetPixel(x, y, paint(x, y));
        return bitmap;
    }

    private static (int R, int G, int B) Rgb(string? css)
    {
        Assert.True(CssColorParse(css, out var c), css);
        return (c.Red, c.Green, c.Blue);
    }

    private static bool CssColorParse(string? css, out SKColor colour)
    {
        colour = default;
        var parts = css?.Replace("rgba(", string.Empty).TrimEnd(')').Split(',');
        if (parts is not { Length: 4 }) return false;
        colour = new SKColor(byte.Parse(parts[0].Trim()), byte.Parse(parts[1].Trim()), byte.Parse(parts[2].Trim()));
        return true;
    }

    private static double Contrast(TagColors c)
    {
        var bg = Rgb(c.Background);
        bool white = Rgb(c.Text) == (255, 255, 255);
        return PosterColour.TextContrast(bg, white);
    }

    [Fact]
    public void A_solid_poster_gives_its_own_hue_with_legible_text()
    {
        using var red = Bitmap(200, 300, (_, _) => new SKColor(200, 30, 30));
        var c = PosterColour.Sample(red);
        var (r, g, b) = Rgb(c.Background);
        Assert.True(r > 2 * g && r > 2 * b, $"a red poster gives a red badge, got {c.Background}");
        Assert.Equal((255, 255, 255), Rgb(c.Text));
        Assert.True(Contrast(c) >= 4.5);
        var border = Rgb(c.Border);
        Assert.True(border.R > r, "the border is a lighter shade of the same hue under white text");

        using var navy = Bitmap(120, 180, (_, _) => new SKColor(20, 30, 90));
        var blue = Rgb(PosterColour.Sample(navy).Background);
        Assert.True(blue.B > blue.R && blue.B > blue.G, $"a dark blue poster gives a blue badge, got {blue}");
    }

    [Fact]
    public void Bright_posters_get_black_text_and_every_result_reaches_four_and_a_half_to_one()
    {
        foreach (var colour in new[] { new SKColor(250, 230, 40), new SKColor(60, 220, 60), new SKColor(80, 200, 230), new SKColor(255, 140, 0), new SKColor(200, 30, 30), new SKColor(110, 40, 160) })
        {
            using var poster = Bitmap(40, 60, (_, _) => colour);
            var c = PosterColour.Sample(poster);
            Assert.True(Contrast(c) >= 4.5, $"{colour}: {c}");
        }

        using var yellow = Bitmap(40, 60, (_, _) => new SKColor(250, 230, 40));
        Assert.Equal((0, 0, 0), Rgb(PosterColour.Sample(yellow).Text));
        Assert.True(PosterColour.WorstCaseContrast >= 4.5, $"worst case {PosterColour.WorstCaseContrast}");
        Assert.True(PosterColour.WorstCaseContrast < 5, "the worst case is the edge of the band, not a loose bound");
    }

    [Fact]
    public void Two_tone_posters_take_the_larger_area_and_colour_beats_an_equal_grey_area()
    {
        using var mostlyBlue = Bitmap(30, 30, (x, _) => x < 20 ? new SKColor(30, 60, 200) : new SKColor(200, 40, 40));
        var blue = Rgb(PosterColour.Sample(mostlyBlue).Background);
        Assert.True(blue.B > blue.R, $"two thirds blue wins, got {blue}");

        using var half = Bitmap(30, 30, (x, _) => x < 15 ? new SKColor(128, 128, 128) : new SKColor(40, 140, 60));
        var green = Rgb(PosterColour.Sample(half).Background);
        Assert.True(green.G > green.R && green.G > green.B, $"the colourful half wins a tie with grey, got {green}");
    }

    [Fact]
    public void Letterbox_bars_and_white_borders_are_ignored()
    {
        // Black bars top and bottom (60%), white side borders: the artwork between them is teal.
        using var letterboxed = Bitmap(32, 48, (x, y) => y < 15 || y >= 33 ? SKColors.Black : x < 3 || x >= 29 ? SKColors.White : new SKColor(20, 130, 140));
        var teal = Rgb(PosterColour.Sample(letterboxed).Background);
        Assert.True(teal.G > teal.R && teal.B > teal.R, $"teal artwork, got {teal}");
    }

    [Fact]
    public void Near_black_grey_and_transparent_posters_give_the_neutral_dark_badge()
    {
        using var black = Bitmap(20, 30, (_, _) => new SKColor(10, 12, 14));
        Assert.Equal(PosterColour.Neutral, PosterColour.Sample(black));
        using var grey = Bitmap(20, 30, (x, y) => new SKColor((byte)(90 + x), (byte)(90 + x), (byte)(95 + x)));
        Assert.Equal(PosterColour.Neutral, PosterColour.Sample(grey));
        using var clear = Bitmap(20, 30, (_, _) => new SKColor(200, 30, 30, 0));
        Assert.Equal(PosterColour.Neutral, PosterColour.Sample(clear));
        Assert.Equal((255, 255, 255), Rgb(PosterColour.Neutral.Text));
        Assert.True(Contrast(PosterColour.Neutral) >= 4.5);
    }

    [Fact]
    public void Blurhash_like_noise_still_resolves_deterministically()
    {
        var random = new Random(7);
        var noise = new byte[32 * 48 * 4];
        random.NextBytes(noise);
        for (int i = 3; i < noise.Length; i += 4) noise[i] = 255;
        var first = PosterColour.Dominant(noise, 32, 48);
        Assert.Equal(first, PosterColour.Dominant(noise, 32, 48));
        Assert.NotNull(first);
        var c = PosterColour.Normalise(first);
        Assert.True(Contrast(c) >= 4.5);
    }

    [Fact]
    public void Dominant_is_the_rounded_mean_of_the_winning_bin_and_ties_go_to_the_lower_bin()
    {
        // Two pixels in one bin average with half-up rounding: (200 + 201) / 2 = 200.5 → 201.
        byte[] one = { 200, 40, 40, 255, 201, 41, 41, 255 };
        Assert.Equal((201, 41, 41), PosterColour.Dominant(one, 2, 1));
        // Equal counts and equal chroma: the lower bin (blue < red in bin order) wins.
        byte[] tie = { 200, 40, 40, 255, 40, 40, 200, 255 };
        Assert.Equal((40, 40, 200), PosterColour.Dominant(tie, 2, 1));
        Assert.Null(PosterColour.Dominant(new byte[] { 0, 0, 0, 255 }, 1, 1));
    }

    [Fact]
    public void The_poster_preset_is_listed_and_its_palette_is_empty_except_in_the_editor()
    {
        Assert.Contains("poster", TagStyleKeys.Presets);
        Assert.Equal("poster", TagStyleKeys.KnownPreset(" POSTER "));
        Assert.True(TagStylePalettes.Preset("poster", "quality", "4K").IsEmpty);
        Assert.Equal(PosterColour.Example, TagStylePalettes.Concrete("poster", "quality", "4K"));
        Assert.Equal(TagStylePalettes.Builtin("language", "flag"), TagStylePalettes.Concrete("poster", "language", "flag"));
        var set = TagStyleSet.Parse(string.Empty, "poster");
        Assert.False(set.IsEmpty);
        Assert.True(set.IsPoster);
        Assert.True(set.Resolve("quality", "4K").IsEmpty, "without artwork nothing resolves (the web model only lists overrides)");
    }

    [Fact]
    public void Precedence_is_label_then_group_then_the_sampled_colour_field_by_field()
    {
        var sampled = new TagColors("rgba(150, 20, 20, 1)", "rgba(200, 60, 60, 1)", "rgba(255, 255, 255, 1)");
        var set = TagStyleSet.Parse("{\"v\":2,\"preset\":\"poster\",\"groups\":{\"quality\":{\"text\":\"#00ff00\"}},\"labels\":{\"quality:4K\":{\"background\":\"#0000ff\"}}}", "poster").WithSampled(sampled);
        Assert.Equal(new TagColors("rgba(0, 0, 255, 1)", sampled.Border, "rgba(0, 255, 0, 1)"), set.Resolve("quality", "4K"));
        Assert.Equal(new TagColors(sampled.Background, sampled.Border, "rgba(0, 255, 0, 1)"), set.Resolve("quality", "HEVC"));
        Assert.Equal(sampled, set.Resolve("genre", "genre"));
        Assert.Equal(new TagColors(sampled.Background, sampled.Border, "rgba(0, 255, 0, 1)"), set.ResolveQuality("ATMOS 7.1"));
        Assert.Equal(new TagColors(null, null, null), set.Resolve("language", "flag"));
        // Sampling neither changes the hash nor applies to another preset.
        Assert.Equal(TagStyleSet.Parse(string.Empty, "poster").Hash, TagStyleSet.Parse(string.Empty, "poster").WithSampled(sampled).Hash);
        var glass = TagStyleSet.Parse(string.Empty, "glass");
        Assert.Same(glass, glass.WithSampled(sampled));
    }

    [Fact]
    public void The_web_model_says_poster_and_lists_only_the_overrides()
    {
        var model = JsonSerializer.SerializeToElement(TagStyleSet.Parse("{\"v\":2,\"groups\":{\"genre\":{\"text\":\"#ff0000\"}}}", "poster").ToWebModel());
        Assert.Equal("poster", model.GetProperty("preset").GetString());
        Assert.Empty(model.GetProperty("quality").EnumerateObject());
        Assert.Equal("rgba(255, 0, 0, 1)", model.GetProperty("genre").GetProperty("*").GetProperty("color").GetString());
        Assert.Equal(JsonValueKind.Null, model.GetProperty("genre").GetProperty("*").GetProperty("background").ValueKind);
    }

    [Fact]
    public void Native_settings_digest_changes_with_the_poster_preset()
    {
        string Digest(string preset) => PosterTagSettings.Create(null, new PluginConfiguration { TagStylesEnabled = true, TagStyleTarget = "both", TagStylePreset = preset }).Digest;
        Assert.NotEqual(Digest("default"), Digest("poster"));
        Assert.NotEqual(Digest("glass"), Digest("poster"));
    }

    private static (SKColor Chip, string Describe) DrawOn(SKColor artwork)
    {
        using var renderer = new PosterTagRenderer();
        var tags = new List<PosterTagGroupLayout> { new(PosterTagGroup.Quality, PosterTagCorner.TopLeft, [new QualityTag("4K", "resolution")]) };
        var layout = new PosterTagLayout(tags, false, false, TagStyleSet.Parse(string.Empty, "poster"));
        using var source = new SKBitmap(180, 270);
        source.Erase(artwork);
        using var drawn = renderer.Render(source, layout)!;
        var styled = layout with { Styles = layout.Styles!.WithSampled(PosterColour.Sample(source)) };
        return (drawn.GetPixel(14, 14), renderer.Plan(180, 270, styled).Describe());
    }

    [Fact]
    public void Native_posters_draw_the_artworks_colour_and_the_tile_key_changes_with_it()
    {
        var (onRed, redPlan) = DrawOn(new SKColor(190, 30, 30));
        var (onBlue, bluePlan) = DrawOn(new SKColor(30, 50, 190));
        Assert.True(onRed.Red > onRed.Blue + 60, $"red chip on a red poster, got {onRed}");
        Assert.True(onBlue.Blue > onBlue.Red + 60, $"blue chip on a blue poster, got {onBlue}");
        // The planned item's style (part of every tile key) carries the sampled colour.
        Assert.NotEqual(redPlan, bluePlan);
        Assert.Contains(PosterColour.Sample(Solid(190, 30, 30)).Background!, redPlan);
    }

    [Fact]
    public void Poster_status_and_awards_keep_colour_and_identity_in_warm_scaled_tiles()
    {
        using var warm = new PosterTagRenderer();
        using var cold = new PosterTagRenderer(0);
        var layout = new PosterTagLayout([
            new(PosterTagGroup.Status, PosterTagCorner.TopLeft, [new StatusTag("added", "Added", "added")]),
            new(PosterTagGroup.Awards, PosterTagCorner.BottomRight, [new AwardTag("oscar", "Oscar winner")]),
        ], false, false, TagStyleSet.Parse(string.Empty, "poster"))
            { EdgeInset = 0, TagScale = "largest", TagGap = "roomy" };
        foreach (var color in new[] { SKColors.DarkRed, SKColors.DarkBlue, SKColors.DarkRed })
        {
            using var source = new SKBitmap(180, 270);
            source.Erase(color);
            var sampled = PosterColour.Sample(source);
            var plan = warm.Plan(180, 270, layout with { Styles = layout.Styles!.WithSampled(sampled) });
            Assert.All(plan.Groups.SelectMany(g => g.Items), item => Assert.Contains(sampled.Background!, item.Style));
            Assert.StartsWith("added\n", plan.Groups[0].Items[0].Style);
            Assert.StartsWith("oscar\n", plan.Groups[1].Items[0].Style);
            using var actual = warm.Render(source, layout);
            using var expected = cold.Render(source, layout);
            Assert.Equal(expected!.Pixels, actual!.Pixels);
        }
    }

    private static SKBitmap Solid(byte r, byte g, byte b)
    {
        var bitmap = new SKBitmap(180, 270);
        bitmap.Erase(new SKColor(r, g, b));
        return bitmap;
    }
}
