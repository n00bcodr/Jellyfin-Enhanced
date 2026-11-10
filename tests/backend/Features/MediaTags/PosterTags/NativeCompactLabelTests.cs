using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;

namespace JE.Tests.Features.MediaTags;

public class NativeCompactLabelTests
{
    [Theory]
    [InlineData("corners", 1, "compact", true)]
    [InlineData("bands", 1, "compact", true)]
    [InlineData("corners", 1, "full", false)]
    [InlineData("corners", 0, "compact", false)]
    [InlineData("caption", 1, "compact", false)]
    [InlineData("summary", 1, "compact", false)]
    [InlineData("minimal", 1, "compact", false)]
    public void Static_layout_density_reaches_quality_rating_and_status(string layout, int version, string density, bool compact)
    {
        var user = new JellyfinEnhancedUserSettings
        {
            TagLayoutSettingsVersion = version, TagLayout = layout, TagLabelDensity = density,
            QualityTagsEnabled = true, RatingTagsEnabled = true, StatusTagsEnabled = true,
            RatingTagsSources = ["community", "critic"], ShowSourceTag = true,
        };
        var settings = PosterTagSettings.FromUserSettings(user, new());
        var now = DateTimeOffset.Parse("2026-11-01T00:00:00Z");
        var entry = new TagCacheEntry
        {
            Type = "Movie", Source = "BluRay", CommunityRating = 8, CriticRating = 90,
            DateCreated = now.AddDays(-1).ToUnixTimeMilliseconds(),
            StreamData = new() { Streams = [new() { Type = "Video", Codec = "h264", Height = 1080 }] },
        };
        var result = PosterTagResolver.Resolve(entry, settings, new("Movie", false, null, null, null, new(now)), false)!;
        var quality = result.Groups.SelectMany(g => g.Tags).OfType<QualityTag>();
        var source = Assert.Single(quality, t => t.Label == "BluRay");
        Assert.Equal(compact ? "BD" : "BluRay", source.DisplayText ?? source.Label);
        var tags = result.Groups.SelectMany(g => g.Tags).ToArray();
        Assert.Equal(compact ? "Added" : "Just Added", Assert.Single(tags.OfType<StatusTag>()).Text);
        Assert.Equal(!compact, tags.OfType<RatingTag>().Any(t => t.Source == PosterRatingSource.Critic));
        Assert.Equal(compact, settings.CompactLabels);
    }

    [Fact]
    public void Corners_density_changes_the_variant_without_changing_the_full_colour_label()
    {
        var user = new JellyfinEnhancedUserSettings { TagLayoutSettingsVersion = 1, QualityTagsEnabled = true };
        var full = PosterTagSettings.FromUserSettings(user, new());
        user.TagLabelDensity = "compact";
        var compact = PosterTagSettings.FromUserSettings(user, new());
        Assert.NotEqual(full.Digest, compact.Digest);
    }
}
