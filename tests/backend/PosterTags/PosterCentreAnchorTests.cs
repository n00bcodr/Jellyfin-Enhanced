using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Newtonsoft.Json;
using SkiaSharp;

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
        using var renderer = new PosterTagRenderer();
        foreach (int height in new[] { 100, 270 })
        {
            var layout = new PosterTagLayout([new(PosterTagGroup.Rating, anchor, [new RatingTag(PosterRatingSource.Community, "8.1", false)])], false, false);
            var plan = planner.Plan(180, height, layout);
            using var source = new SKBitmap(180, height);
            source.Erase(SKColors.Transparent);
            using var rendered = renderer.Render(source, layout);
            Assert.NotNull(rendered);
            Assert.Contains(rendered.Pixels, pixel => pixel.Alpha > 0);
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
    [Fact]
    public void Side_Status_matches_browser_budgets_with_and_without_the_opposite_group()
    {
        using var json = System.Text.Json.JsonDocument.Parse(typeof(PosterCentreAnchorTests).Assembly.GetManifestResourceStream("SideStatusFit.json")!);
        using var renderer = new PosterTagRenderer();
        foreach (var row in json.RootElement.EnumerateArray())
        {
            bool right = row.GetProperty("slot").GetString() == "mr";
            bool opposite = row.GetProperty("opposite").GetBoolean();
            var anchor = right ? PosterTagCorner.CenterRight : PosterTagCorner.CenterLeft;
            var groups = new List<PosterTagGroupLayout> { new(PosterTagGroup.Status, anchor,
                [new StatusTag("season_premiere", row.GetProperty("label").GetString()!, "season_premiere")]) };
            if (opposite) groups.Add(new(PosterTagGroup.Quality, right ? PosterTagCorner.CenterLeft : PosterTagCorner.CenterRight,
                [new QualityTag("Dolby Vision", "dynamicRange")]));
            var layout = new PosterTagLayout(groups, false, false) { TagScale = "smaller", TagGap = "tight", EdgeInset = row.GetProperty("inset").GetSingle() };
            var plan = renderer.Plan(180, 270, layout);
            var group = plan.Groups[0]; var first = Assert.Single(group.Items);
            Assert.False(first.Hidden);
            Assert.Equal(row.GetProperty("budget").GetSingle(), group.Width, 3);
            Assert.InRange(first.Width, 1, group.Width);
            if (!opposite) Assert.True(first.Width > plan.CardWidth / 2);
            else
            {
                Assert.EndsWith("…", first.Text);
                var left = plan.Groups.SelectMany(g => g.Items).Where(i => !i.Hidden).OrderBy(i => i.X).ToArray();
                Assert.True(left[0].X + left[0].Width + plan.Css.StackGap <= left[1].X + .01f);
            }
        }
    }

    [Theory]
    [InlineData(PosterTagCorner.TopLeft)]
    [InlineData(PosterTagCorner.TopCenter)]
    [InlineData(PosterTagCorner.TopRight)]
    [InlineData(PosterTagCorner.CenterLeft)]
    [InlineData(PosterTagCorner.Center)]
    [InlineData(PosterTagCorner.CenterRight)]
    [InlineData(PosterTagCorner.BottomLeft)]
    [InlineData(PosterTagCorner.BottomCenter)]
    [InlineData(PosterTagCorner.BottomRight)]
    public void Every_anchor_keeps_a_lone_first_fact(PosterTagCorner anchor)
    {
        using var renderer = new PosterTagRenderer();
        var layout = new PosterTagLayout([new(PosterTagGroup.Status, anchor,
            [new StatusTag("season_premiere", new string('W', 100), "season_premiere")])], false, false) { TagScale = "smaller" };
        var item = Assert.Single(Assert.Single(renderer.Plan(180, 270, layout).Groups).Items);
        Assert.False(item.Hidden);
        Assert.IsType<StatusTag>(item.Tag);
        if (anchor is PosterTagCorner.TopCenter or PosterTagCorner.BottomCenter or PosterTagCorner.CenterLeft or PosterTagCorner.CenterRight or PosterTagCorner.Center)
        {
            Assert.EndsWith("…", item.Text);
            Assert.InRange(item.Width, 1, 168);
        }
    }

}
