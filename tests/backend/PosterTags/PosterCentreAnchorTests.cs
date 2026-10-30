using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Newtonsoft.Json;

namespace JE.Tests;

public class PosterCentreAnchorTests
{
    [Theory]
    [InlineData("tc", "top-center", PosterTagCorner.TopCenter)]
    [InlineData("bc", "bottom-center", PosterTagCorner.BottomCenter)]
    [InlineData("ml", "center-left", PosterTagCorner.CenterLeft)]
    [InlineData("mr", "center-right", PosterTagCorner.CenterRight)]
    [InlineData("c", "center", PosterTagCorner.Center)]
    public void Centre_slots_validate_and_legacy_settings_round_trip(string slot, string position, PosterTagCorner anchor)
    {
        var user = new JellyfinEnhancedUserSettings
        {
            QualityTagsPosition = position, GenreTagsPosition = position, LanguageTagsPosition = position,
            RatingTagsPosition = position, AgeRatingTagsPosition = position, StatusTagsPosition = position,
            TagLayoutSettingsVersion = 1,
            TagLayouts = new() { Corners = new() { Groups = [new() { Group = "quality", Slot = slot }, new() { Group = "genre", Slot = "unknown" }] } },
        };
        TagLayoutRules.Normalize(user);
        Assert.Single(user.TagLayouts!.Corners!.Groups);
        var copy = JsonConvert.DeserializeObject<JellyfinEnhancedUserSettings>(JsonConvert.SerializeObject(user))!;
        Assert.Equal(position, copy.StatusTagsPosition);
        Assert.Equal(position, copy.LanguageTagsPosition);
        var settings = PosterTagSettings.FromUserSettings(copy, new PluginConfiguration());
        Assert.Equal(position, settings.QualityTagsPosition);
        Assert.Equal(anchor, PosterTagSettings.CornerOf(settings.QualityTagsPosition));
        Assert.Equal(anchor, PosterTagSettings.CornerOf(settings.GenreTagsPosition));
        Assert.Equal(anchor, PosterTagSettings.CornerOf(settings.RatingTagsPosition));
        Assert.Equal(anchor, PosterTagSettings.CornerOf(settings.AgeRatingTagsPosition));
    }

    [Theory]
    [InlineData(PosterTagCorner.TopCenter)]
    [InlineData(PosterTagCorner.BottomCenter)]
    [InlineData(PosterTagCorner.CenterLeft)]
    [InlineData(PosterTagCorner.CenterRight)]
    [InlineData(PosterTagCorner.Center)]
    public void Native_planner_places_each_anchor_and_keeps_chips_inside_short_and_portrait_cards(PosterTagCorner anchor)
    {
        using var assets = PosterTagAssets.Load();
        using var text = new PosterTagText(assets.TextTypeface);
        var planner = new PosterTagPlanner(assets, text);
        foreach (int height in new[] { 100, 270 })
        {
            var layout = new PosterTagLayout([new(PosterTagGroup.Rating, anchor, [new RatingTag(PosterRatingSource.Community, "8.1", false)])], false, false);
            var plan = planner.Plan(180, height, layout);
            var group = Assert.Single(plan.Groups);
            var chip = Assert.Single(group.Items);
            Assert.False(chip.Hidden);
            Assert.InRange(chip.X, 6, plan.CardWidth - 6 - chip.Width);
            Assert.InRange(chip.Y, 6, plan.CardHeight - 6 - chip.Height);
            if (anchor is PosterTagCorner.TopCenter or PosterTagCorner.BottomCenter or PosterTagCorner.Center)
                Assert.Equal(plan.CardWidth / 2, chip.X + chip.Width / 2, 3);
            if (anchor is PosterTagCorner.CenterLeft or PosterTagCorner.CenterRight or PosterTagCorner.Center)
                Assert.Equal(plan.CardHeight / 2, chip.Y + chip.Height / 2, 3);
            if (anchor == PosterTagCorner.TopCenter) Assert.Equal(6, chip.Y);
            if (anchor == PosterTagCorner.BottomCenter) Assert.Equal(plan.CardHeight - 6, chip.Y + chip.Height, 3);
        }
    }

    [Fact]
    public void Centre_rows_reserve_corner_width_and_side_columns_reserve_corner_height()
    {
        using var assets = PosterTagAssets.Load();
        using var text = new PosterTagText(assets.TextTypeface);
        var planner = new PosterTagPlanner(assets, text);
        var corner = new PosterTagGroupLayout(PosterTagGroup.Rating, PosterTagCorner.TopLeft, [new RatingTag(PosterRatingSource.Community, "8.1", false)]);
        var row = new PosterTagGroupLayout(PosterTagGroup.Genre, PosterTagCorner.TopCenter, [new GenreTag("Drama", "theater_comedy")]);
        var side = new PosterTagGroupLayout(PosterTagGroup.Language, PosterTagCorner.CenterLeft, [new LanguageTag("gb", "English", false)]);
        var before = planner.Plan(180, 270, new([corner], false, false)).Groups.Single();
        var after = planner.Plan(180, 270, new([corner, row, side], false, false));
        Assert.Equal((before.X, before.Y, before.Width, before.Height), (after.Groups[0].X, after.Groups[0].Y, after.Groups[0].Width, after.Groups[0].Height));
        Assert.True(after.Groups[1].Items[0].X >= before.X + before.Width + 4);
        Assert.True(after.Groups[2].Items[0].Y >= before.Y + before.Height + 4);
    }
}
