using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;

namespace JE.Tests;

public class NativeCentreOverflowTests
{
    [Theory]
    [InlineData(PosterTagCorner.CenterLeft, PosterTagCorner.CenterRight)]
    [InlineData(PosterTagCorner.CenterRight, PosterTagCorner.CenterLeft)]
    public void Opposite_side_quality_keeps_the_visible_facts_and_counts_the_wide_audio_chip(PosterTagCorner statusCorner, PosterTagCorner qualityCorner)
    {
        using var renderer = new PosterTagRenderer();
        var layout = new PosterTagLayout([
            new(PosterTagGroup.Status, statusCorner, [new StatusTag("added", "Just Added", "added")]),
            new(PosterTagGroup.Quality, qualityCorner, [new QualityTag("1080p", "resolution"), new QualityTag("BluRay", "source"), new QualityTag("HEVC", "videoCodec"), new QualityTag("Dolby Digital+ 7.1", "audioInfo")]),
        ], false, false);
        var plan = renderer.Plan(180, 270, layout);
        var quality = Assert.Single(plan.Groups, g => g.Group == PosterTagGroup.Quality);
        Assert.Equal(3, quality.Items.Count(i => !i.Hidden && i.Tag is QualityTag));
        var overflow = Assert.Single(quality.Items, i => i.Tag is OverflowTag);
        Assert.Equal(1, Assert.IsType<OverflowTag>(overflow.Tag).Count);
        Assert.Equal("+1", overflow.Text);
        Assert.False(overflow.Hidden);
        Assert.Equal(quality.Y + quality.Height, overflow.Y + overflow.Height, 3);
        Assert.True(overflow.X >= quality.X && overflow.X + overflow.Width <= quality.X + quality.Width + 0.01f);
        Assert.Equal(135, quality.Y + quality.Height / 2, 3);
        using var source = new SKBitmap(180, 270); source.Erase(SKColors.DarkSlateBlue);
        using var drawn = renderer.Render(source, layout);
        Assert.NotNull(drawn);
    }

    [Theory]
    [InlineData(PosterTagCorner.TopCenter)]
    [InlineData(PosterTagCorner.BottomCenter)]
    [InlineData(PosterTagCorner.Center)]
    public void Horizontal_centre_counts_an_oversized_later_fact(PosterTagCorner corner)
    {
        using var renderer = new PosterTagRenderer();
        var plan = renderer.Plan(180, 270, new([
            new(PosterTagGroup.Quality, corner, [new QualityTag("4K", "resolution"), new QualityTag(new string('W', 80), "edition"), new QualityTag("HEVC", "videoCodec")]),
        ], false, false));
        var group = Assert.Single(plan.Groups);
        Assert.Equal(2, group.Items.Count(i => !i.Hidden && i.Tag is QualityTag));
        Assert.Equal(1, Assert.IsType<OverflowTag>(Assert.Single(group.Items, i => i.Tag is OverflowTag).Tag).Count);
    }
}
