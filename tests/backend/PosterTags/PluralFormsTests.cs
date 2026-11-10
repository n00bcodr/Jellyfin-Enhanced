using System.Globalization;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution;
using Xunit;

namespace JE.Tests;

public class PluralFormsTests
{
    [Fact]
    public void TheNativeCategoriesAreTheBrowsersForEveryListedLanguage()
    {
        // tests/fixtures/plural-categories.json is Intl.PluralRules' answer, which JE.t uses on the web.
        using var stream = typeof(PluralFormsTests).Assembly.GetManifestResourceStream("PluralCategories.json")!;
        using var document = JsonDocument.Parse(stream);
        var numbers = document.RootElement.GetProperty("numbers").EnumerateArray().Select(n => n.GetInt64()).ToArray();
        var mismatches = new List<string>();
        foreach (var language in document.RootElement.GetProperty("languages").EnumerateObject())
        {
            var expected = language.Value.EnumerateArray().Select(c => c.GetString()).ToArray();
            for (var i = 0; i < numbers.Length; i++)
            {
                var actual = PluralRules.Category(language.Name, numbers[i]);
                if (actual != expected[i]) mismatches.Add($"{language.Name} {numbers[i]}: {actual}, Intl {expected[i]}");
            }
        }

        Assert.True(mismatches.Count == 0, string.Join("; ", mismatches.Take(40)));
        Assert.Equal("one", PluralRules.Category("xx", 1)); // a language Intl does not know takes English rules (JE.t asks [lang, "en"])
    }

    [Fact]
    public void NativeTextPicksTheFormOfTheCountByJeTsRule()
    {
        var english = CultureInfo.GetCultureInfo("en");
        Assert.Equal("within {days} day of being added", StatusRules.Text("panel_media_tags_badge_window_added", english, 1));
        Assert.Equal("within {days} days of being added", StatusRules.Text("panel_media_tags_badge_window_added", english, 2));
        // A kind of English takes the English forms; a string without forms is the key's own.
        Assert.Equal("within {days} day of being added", StatusRules.Text("panel_media_tags_badge_window_added", CultureInfo.GetCultureInfo("en-GB"), 1));
        Assert.Equal(StatusRules.Text("quality_versions_count", english), StatusRules.Text("quality_versions_count", english, 2));
        // A locale's own sentence never turns English for one count; a key it lacks is English, with English forms.
        var german = CultureInfo.GetCultureInfo("de");
        foreach (var key in new[] { "panel_media_tags_badge_window_added", "language_tags_count_tooltip", "quality_versions_count" })
        {
            // German has its own singular form for some keys and none for others; either way the count never turns it English.
            Assert.NotEqual(StatusRules.Text(key, english, 1), StatusRules.Text(key, german, 1));
            Assert.NotEqual(StatusRules.Text(key, english, 2), StatusRules.Text(key, german, 2));
        }
    }

    [Theory]
    [InlineData("1h 52m", false, "1h 52m")]
    [InlineData("1h 52m", true, "1h52")]
    [InlineData("47m", false, "47m")]
    [InlineData("47m", true, "47m")]
    [InlineData("12h 05m", true, "12h05")]
    public void RuntimeTextReadsTheLabelInTheLocaleUnitsAndEnglishIsUnchanged(string label, bool compact, string expected)
    {
        Assert.Equal(expected, Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution.TechnicalQualityRules.RuntimeText(label, compact, CultureInfo.GetCultureInfo("en")));
    }
}
