using System.Globalization;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
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
        Assert.Equal("other", PluralRules.Category("xx", 1)); // a language with no rules has no forms, as in Intl
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
        foreach (var key in new[] { "panel_media_tags_badge_window_added", "language_tags_count_tooltip", "admin_tags_presets_name_desc" })
        {
            var own = StatusRules.Text(key, german);
            Assert.Equal(own == StatusRules.Text(key, english) ? StatusRules.Text(key, english, 1) : own, StatusRules.Text(key, german, 1));
        }
    }
}
