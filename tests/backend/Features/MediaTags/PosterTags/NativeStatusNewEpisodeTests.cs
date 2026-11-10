using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;

namespace JE.Tests.Features.MediaTags;

// Upstream 6ece3f52: an episode is a New Episode when it aired recently, not when its file was added recently.
[Collection("Plugin singleton")]
public class NativeStatusNewEpisodeTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-30T12:00:00Z");
    private static long Ago(double days) => Now.AddDays(-days).ToUnixTimeMilliseconds();

    private static string? Resolve(TagCacheEntry entry, string settingsJson = "{statusTagsEnabled:true,nativePosterTimeZone:'UTC'}")
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.StatusTagsEnabled = true;
        return StatusRules.Resolve(entry, PosterTagSettings.FromSettingsJson(settingsJson, f.Plugin.Configuration), new(Now))?.Key;
    }

    [Fact]
    public void An_episode_added_recently_but_aired_long_ago_is_Just_Added()
        => Assert.Equal("just_added", Resolve(new TagCacheEntry { Type = "Episode", PremiereDate = Ago(400), DateCreated = Ago(1) }));

    [Fact]
    public void An_episode_that_aired_recently_is_a_New_Episode_whenever_it_was_added()
    {
        Assert.Equal("new_episode", Resolve(new TagCacheEntry { Type = "Episode", PremiereDate = Ago(2), DateCreated = Ago(400) }));
        Assert.Equal("new_episode", Resolve(new TagCacheEntry { Type = "Episode", PremiereDate = Ago(2), DateCreated = Ago(1) }));
    }

    [Fact]
    public void An_episode_added_recently_with_no_air_date_is_Just_Added_and_nothing_with_Just_Added_off()
    {
        var entry = new TagCacheEntry { Type = "Episode", DateCreated = Ago(1) };
        Assert.Equal("just_added", Resolve(entry));
        Assert.Null(Resolve(entry, "{statusTagsEnabled:true,statusTagsJustAdded:false,nativePosterTimeZone:'UTC'}"));
    }
}
