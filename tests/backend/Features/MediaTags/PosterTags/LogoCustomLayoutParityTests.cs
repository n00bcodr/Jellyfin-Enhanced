using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;

namespace JE.Tests.Features.MediaTags;

public class LogoCustomLayoutParityTests
{
    [Fact]
    public void New_groups_match_browser_size_gap_and_edge_fixtures()
    {
        using var json = JsonDocument.Parse(typeof(LogoCustomLayoutParityTests).Assembly.GetManifestResourceStream("LogoCustomLayout.json")!);
        using var renderer = new PosterTagRenderer();
        foreach (var row in json.RootElement.EnumerateArray())
        {
            var logo = row.GetProperty("group").GetString() == "logos";
            var layout = new PosterTagLayout([new(logo ? PosterTagGroup.Logos : PosterTagGroup.Custom,
                logo ? PosterTagCorner.BottomLeft : PosterTagCorner.TopLeft,
                logo ? [new LogoTag("network", "Northwind", null), new LogoTag("studio", "Studio", null)]
                    : [new CustomTag("Plot fact", null, "tag:1"), new CustomTag("Second", null, "tag:2")])], false, false)
            {
                TagScale = row.GetProperty("scale").GetString()!, TagGap = row.GetProperty("gap").GetString()!,
                EdgeInset = row.GetProperty("edge").GetString() == "flush" ? 0 : 3,
            };
            var plan = renderer.Plan(180, 270, layout);
            var group = Assert.Single(plan.Groups); var chip = group.Items[0];
            Assert.InRange(Math.Abs(chip.Width - row.GetProperty("width").GetSingle()), 0, 1.1f);
            Assert.InRange(Math.Abs(chip.Height - row.GetProperty("height").GetSingle()), 0, .1f);
            Assert.InRange(Math.Abs(group.Gap - row.GetProperty("gapPx").GetSingle()), 0, .02f);
            Assert.InRange(Math.Abs(chip.X - row.GetProperty("left").GetSingle()), 0, .1f);
            Assert.InRange(Math.Abs(chip.Y - row.GetProperty("top").GetSingle()), 0, .15f);
        }
    }
}
