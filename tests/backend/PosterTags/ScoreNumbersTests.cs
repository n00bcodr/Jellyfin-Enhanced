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
