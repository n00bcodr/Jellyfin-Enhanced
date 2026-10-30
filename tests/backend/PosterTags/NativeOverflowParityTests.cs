using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;
using Xunit.Abstractions;

namespace JE.Tests.PosterTags;

public class NativeOverflowParityTests(ITestOutputHelper output)
{
    private static Stream Fixture(string name) => typeof(NativeOverflowParityTests).Assembly.GetManifestResourceStream("NativeOverflow." + name)!;

    [Theory]
    [InlineData(false, 1)]
    [InlineData(false, 12)]
    [InlineData(true, 1)]
    [InlineData(true, 12)]
    public void Overflow_matches_browser_metrics_and_chip_pixels_in_corners_and_bands(bool bands, int count)
    {
        using var metrics = JsonDocument.Parse(Fixture("metrics.json"));
        using var renderer = new PosterTagRenderer();
        using var cold = new PosterTagRenderer(0);
        using var source = new SKBitmap(180, 270);
        source.Erase(new SKColor(70, 90, 130));
        var layout = new PosterTagLayout([new(PosterTagGroup.Status, PosterTagCorner.TopLeft, [new OverflowTag(count)])], false, false,
            TagStyleSet.Parse("{\"v\":2,\"groups\":{\"status\":{\"background\":\"#ff0000\",\"text\":\"#00ff00\"}}}"), Bands: bands);
        var chip = renderer.Plan(180, 270, layout).Groups.Single().Items.Single();
        var tolerance = metrics.RootElement.GetProperty("rectTolerance").GetSingle();
        var width = metrics.RootElement.GetProperty("widths").GetProperty(count.ToString()).GetSingle();
        var height = metrics.RootElement.GetProperty("height").GetSingle();
        Assert.Equal(PosterTagTileKind.Overflow, chip.Kind);
        Assert.InRange(Math.Abs(chip.Width - width), 0, tolerance);
        Assert.InRange(Math.Abs(chip.Height - height), 0, tolerance);
        Assert.All(chip.TextLayout!.Runs, run => Assert.Equal(11, run.FontSize));
        Assert.False(renderer.HarfBuzzUnavailable);

        // Prime a Status tile with the same text before the overflow, then compare warm/cold output.
        using var status = renderer.Render(source, new PosterTagLayout([new(PosterTagGroup.Status, PosterTagCorner.TopLeft,
            [new StatusTag("added", "+" + count, "added")])], false, false));
        // Both host-context web captures isolate the tile on a solid backdrop. The band plan above
        // must select the same overflow kind/metrics; omit only its unrelated gradient for pixel comparison.
        var tileLayout = layout with { Bands = false };
        using var actual = renderer.Render(source, tileLayout)!;
        using var uncached = cold.Render(source, tileLayout)!;
        Assert.Equal(uncached.Pixels, actual.Pixels);
        using var web = SKBitmap.Decode(Fixture($"{(bands ? "bands" : "corners")}-{count}.png"));

        // Compare only the chip plus a 2px surround, so the rest of the poster cannot hide bad paint.
        // Small raster rounding is allowed; text, padding, colours, radius and absent shadow are all sampled.
        long delta = 0, boxDelta = 0;
        int pixels = 0, severe = 0, boxPixels = 0, boxMax = 0;
        for (int y = 4; y < Math.Ceiling(6 + height) + 2; y++)
        for (int x = 4; x < Math.Ceiling(6 + width) + 2; x++)
        {
            var a = actual.GetPixel(x, y);
            var b = web.GetPixel(x, y);
            var d = new[] { Math.Abs(a.Red - b.Red), Math.Abs(a.Green - b.Green), Math.Abs(a.Blue - b.Blue) };
            delta += d.Sum();
            // The remaining browser/native variation is confined to glyph antialiasing at this 11px size.
            // Keep the padding, border, radius, background and shadow surround under a tighter limit.
            if (y < 11 || y >= 19 || x < 12 || x >= 6 + width - 6)
            {
                boxDelta += d.Sum(); boxPixels++; boxMax = Math.Max(boxMax, d.Max());
            }
            if (d.Max() > 32) severe++;
            pixels++;
        }
        double mean = delta / (3d * pixels), fraction = severe / (double)pixels;
        output.WriteLine($"{bands} +{count}: mean RGB delta {mean:F4}, >32px fraction {fraction:F4}");
        output.WriteLine($"Non-glyph mean {boxDelta / (3d * boxPixels):F4}, max {boxMax}");
        Assert.True(boxDelta / (3d * boxPixels) <= 0.2, "Non-glyph mean exceeds 0.2/255");
        Assert.InRange(boxMax, 0, 10);
        Assert.True(mean <= 5, $"Mean chip RGB difference {mean:F4} exceeds 5/255");
        Assert.True(fraction <= 0.07, $"Chip pixels differing by >32/255: {fraction:P2}, limit 7%");
    }
}
