using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace JE.Tests;

/// <summary>
/// The native poster path for a user without settings.json uses the registry's admin defaults as the
/// first GET would write them and the server would read them back, so native posters match what the
/// web shows after the seed.
/// </summary>
public class PosterDefaultsAsWrittenTests
{
    private static Dictionary<string, object?> Values(PosterTagSettings settings)
        => typeof(PosterTagSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => (Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType) is var t && (t.IsPrimitive || t.IsEnum || t == typeof(string)))
            .ToDictionary(p => p.Name, p => p.GetValue(settings));

    public static IEnumerable<object[]> Seeds() => Enumerable.Range(-1, 17).Select(seed => new object[] { seed });

    [Theory]
    [MemberData(nameof(Seeds))]
    public void UserWithoutSettingsGetsTheSeedAsWrittenAndReadBack(int seed)
    {
        using var fixture = new CoreFixture();
        var config = new PluginConfiguration();
        if (seed >= 0) CoreUserSettingsBuilderTests.Randomize(config, seed);
        if (seed % 4 == 3)
        {
            // Null admin strings are written as JSON null and read back as the initializers.
            config.QualityTagsPosition = null!;
            config.RatingTagsPosition = null!;
        }
        var user = Guid.NewGuid().ToString("N");
        fixture.Manager.SaveUserConfiguration(user, "settings.json", UserSettingsRegistry.BuildDefaults(config));
        var seeded = fixture.Manager.GetUserConfiguration<UserSettings>(user, "settings.json");

        var withoutFile = PosterTagSettings.FromUserSettings(null, config, "eng");
        var afterSeed = PosterTagSettings.FromUserSettings(seeded, config, "eng");
        Assert.Equal(afterSeed.Digest, withoutFile.Digest);
        Assert.Equal(Values(afterSeed), Values(withoutFile));
    }
}
