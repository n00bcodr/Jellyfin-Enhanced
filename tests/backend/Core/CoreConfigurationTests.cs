using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Newtonsoft.Json;

namespace JE.Tests;

public class CoreConfigurationTests
{
    [Fact]
    public void DefaultUserSettingsPreserveOptInAndInheritedChoices()
    {
        var settings = new UserSettings();
        Assert.False(settings.AutoPauseEnabled);
        Assert.False(settings.AutoResumeEnabled);
        Assert.False(settings.AutoSkipIntro);
        Assert.Null(settings.UseNativePosterTags);
        Assert.True(settings.ShowResolutionTag);
        Assert.True(settings.ShowAudioInfoTag);
        Assert.Equal("percentage", settings.WatchProgressMode);
        Assert.Equal("list", settings.CalendarDisplayMode);
        Assert.Equal(85, settings.SubtitleVerticalPosition);
        Assert.Equal(50, settings.SubtitleHorizontalPosition);
        var hidden = new HiddenContentSettings();
        Assert.True(hidden.Enabled);
        Assert.True(hidden.FilterLibrary);
        Assert.False(hidden.FilterSearch);
        Assert.False(hidden.ExperimentalHideCollections);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public void SpoilerDictionaryLookupSurvivesBothSerializers(bool systemTextJson)
    {
        const string json = "{\"Series\":{\"ABC\":{\"SeriesName\":\"Series\"}},\"Movies\":{\"DEF\":{\"MovieName\":\"Movie\"}},\"Collections\":{\"GHI\":{}},\"PendingTmdb\":{\"TV:123\":{}}}";
        var state = systemTextJson
            ? System.Text.Json.JsonSerializer.Deserialize<UserSpoilerBlur>(json)!
            : JsonConvert.DeserializeObject<UserSpoilerBlur>(json)!;
        Assert.Equal("Series", state.Series["abc"].SeriesName);
        Assert.Equal("Movie", state.Movies["def"].MovieName);
        Assert.True(state.Collections.ContainsKey("ghi"));
        Assert.True(state.PendingTmdb.ContainsKey("tv:123"));
        Assert.Null(state.Prefs.HideRatings);
        Assert.Null(state.Prefs.UseAdvancedCategories);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"Series\":null,\"Movies\":null,\"Collections\":null,\"PendingTmdb\":null}")]
    public void LegacyAndNullSpoilerCollectionsLoadAsEmpty(string json)
    {
        var state = System.Text.Json.JsonSerializer.Deserialize<UserSpoilerBlur>(json)!;
        Assert.Empty(state.Series);
        Assert.Empty(state.Movies);
        Assert.Empty(state.Collections);
        Assert.Empty(state.PendingTmdb);
        Assert.NotNull(state.Prefs);
    }

    [Fact]
    public void BookmarkOptionalEpisodeIdentityAndUnicodeRoundTrip()
    {
        using var f = new CoreFixture();
        var id = Guid.NewGuid().ToString("N");
        var bookmarks = new UserBookmark { Bookmarks = new() { ["a"] = new BookmarkItem { ItemId = "a", Name = "日本語 🎬", Timestamp = 12.25, Label = "<scene>", SeasonNumber = 0, EpisodeNumber = 1 } } };
        f.Manager.SaveUserConfiguration(id, "bookmarks.json", bookmarks);
        var result = f.Manager.GetUserConfigurationStrict<UserBookmark>(id, "bookmarks.json").Bookmarks["a"];
        Assert.Equal("日本語 🎬", result.Name);
        Assert.Equal(12.25, result.Timestamp);
        Assert.Equal("<scene>", result.Label);
        Assert.Equal(0, result.SeasonNumber);
        Assert.Equal(1, result.EpisodeNumber);
    }
}
