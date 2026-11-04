using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace JE.Tests;

/// <summary>Native score numbers follow the user's locale with the web's Intl decimal separator and digits.</summary>
[Collection("Plugin singleton")]
public class ScoreNumbersTests
{
    [Theory]
    [InlineData("en", "8.1", "8.1")]
    [InlineData("en-GB", "81%", "81%")]
    [InlineData("de", "8.1", "8,1")]
    [InlineData("de-CH", "8.1", "8.1")]
    [InlineData("fr-CA", "4.1", "4,1")]
    [InlineData("pt-BR", "7.5", "7,5")]
    [InlineData("ar", "8.1", "8.1")]
    [InlineData("ar-SA", "8.1", "٨٫١")]
    [InlineData("fa", "81%", "۸۱%")]
    [InlineData("he", "8.1", "8.1")]
    [InlineData("de", "—", "—")]
    public void ScoresUseTheLocalesDecimalSeparatorAndDigits(string locale, string text, string expected)
        => Assert.Equal(expected, ScoreNumbers.Localize(text, CultureInfo.GetCultureInfo(locale)));

    [Fact]
    public void RatingChipsAndDigestsFollowTheSavedLocaleWhileEnglishTokensStayTheSame()
    {
        var entry = new TagCacheEntry { Type = "Movie", CommunityRating = 8.1f, CriticRating = 93 };
        PosterTagSettings Settings(string? locale) => PosterTagSettings.FromUserSettings(new() { RatingTagsEnabled = true, NativePosterDateLocale = locale }, new PluginConfiguration(), null);
        string[] Texts(PosterTagSettings settings) => RatingRules.ResolveScores(entry, settings).OfType<RatingTag>().Select(t => t.Text).ToArray();
        Assert.Equal(new[] { "93%", "8.1" }, Texts(Settings(null)));
        Assert.Equal(new[] { "93%", "8,1" }, Texts(Settings("de-DE")));
        Assert.Equal(Settings(null).Digest, Settings("en-US").Digest);
        Assert.NotEqual(Settings(null).Digest, Settings("de-DE").Digest);
    }
}

/// <summary>Native chip words (Dual/Multi, Mixed, editions) come from the same vocabulary the web translates.</summary>
[Collection("Plugin singleton")]
public class NativeChipVocabularyTests
{
    [Fact]
    public void CountBadgeKeepsItsStyleKeyAndDrawsTheVocabularyText()
    {
        var entry = new TagCacheEntry { Type = "Movie", AudioLanguages = ["eng", "fre", "ger"] };
        foreach (var locale in new[] { "en-US", "de-DE", "ar-SA" })
        {
            var settings = PosterTagSettings.FromUserSettings(new() { LanguageTagsEnabled = true, LanguageTagsCountBadge = "only", NativePosterDateLocale = locale }, new PluginConfiguration(), null);
            var badge = Assert.Single(LanguageFlagRules.ResolveGroup(entry, settings)!.OfType<LanguageTag>(), t => t.CountBadge != null);
            Assert.Equal("Multi", badge.CountBadge);
            Assert.Equal(StatusRules.Text("language_tags_multi", settings.StatusCulture), badge.CountBadgeText);
        }
    }

    [Fact]
    public void VocabularyFallsBackToEnglishThenTheKey()
    {
        Assert.Equal("Dual", StatusRules.Text("language_tags_dual", CultureInfo.GetCultureInfo("en")));
        Assert.Equal(StatusRules.Text("calendar_tomorrow", CultureInfo.GetCultureInfo("de")), StatusRules.Text("calendar_tomorrow", CultureInfo.GetCultureInfo("de-AT")));
        Assert.NotEqual(StatusRules.Text("calendar_tomorrow", CultureInfo.GetCultureInfo("en")), StatusRules.Text("calendar_tomorrow", CultureInfo.GetCultureInfo("de")));
        Assert.Equal("no_such_key", StatusRules.Text("no_such_key", CultureInfo.GetCultureInfo("de")));
    }
}

/// <summary>Premiere dates are calendar days in the viewer's time zone, not UTC instants.</summary>
[Collection("Plugin singleton")]
public class StatusPremiereDayTests
{
    [Theory]
    [InlineData("Australia/Sydney", "2026-11-04T21:00:00Z", "new_movie")]    // 08:00 on release day in Sydney
    [InlineData("Australia/Sydney", "2026-11-05T09:00:00Z", "new_movie")]    // 20:00 on release day
    [InlineData("Australia/Sydney", "2026-11-04T12:59:00Z", "coming_soon")]  // 23:59 the day before
    [InlineData("UTC", "2026-11-04T21:00:00Z", "coming_soon")]
    [InlineData("UTC", "2026-11-05T00:00:00Z", "new_movie")]
    [InlineData("America/Los_Angeles", "2026-11-05T15:00:00Z", "new_movie")]   // 07:00 on release day
    [InlineData("America/Los_Angeles", "2026-11-05T07:00:00Z", "coming_soon")] // 23:00 the day before
    public void ReleaseDayStartsAtLocalMidnight(string zone, string now, string expected)
    {
        var config = new PluginConfiguration { StatusTagsEnabled = true };
        var settings = PosterTagSettings.FromUserSettings(new() { StatusTagsEnabled = true, NativePosterTimeZone = zone }, config, null);
        var entry = new TagCacheEntry { Type = "Movie", PremiereDate = DateTimeOffset.Parse("2026-11-05T00:00:00Z").ToUnixTimeMilliseconds() };
        Assert.Equal(expected, StatusRules.Resolve(entry, settings, new(DateTimeOffset.Parse(now)))?.Key);
    }
}
