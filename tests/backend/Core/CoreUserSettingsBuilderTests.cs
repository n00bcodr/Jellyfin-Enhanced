using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace JE.Tests;

/// <summary>
/// UserSettings.FromAdminDefaults, the one builder behind the first-access seed and reset-all.
/// Every UserSettings property needs exactly one mapping decision here, so a new per-user setting
/// (or an admin default the builder forgets, like TagsHideOnHover before A9) fails until it is
/// classified; randomized admin configs then check each decision holds.
/// </summary>
public class CoreUserSettingsBuilderTests
{
    // Admin defaults stored on PluginConfiguration under another name.
    private static readonly Dictionary<string, string> Aliases = new()
    {
        [nameof(UserSettings.SelectedStylePresetIndex)] = nameof(PluginConfiguration.DefaultSubtitleStyle),
        [nameof(UserSettings.SelectedFontSizePresetIndex)] = nameof(PluginConfiguration.DefaultSubtitleSize),
        [nameof(UserSettings.SelectedFontFamilyPresetIndex)] = nameof(PluginConfiguration.DefaultSubtitleFont),
        [nameof(UserSettings.SelectedTextEffectPresetIndex)] = nameof(PluginConfiguration.DefaultSubtitleTextEffect),
        [nameof(UserSettings.WatchProgressMode)] = nameof(PluginConfiguration.WatchProgressDefaultMode),
        [nameof(UserSettings.DisplayLanguage)] = nameof(PluginConfiguration.DefaultLanguage),
    };

    // A blank admin value writes the initializer instead.
    private static readonly HashSet<string> BlankAdminUsesInitializer =
    [
        nameof(UserSettings.WatchProgressMode), nameof(UserSettings.WatchProgressTimeFormat),
    ];

    // Not copied from the admin config (even where a same-named admin setting exists): every built document gets this value.
    private static readonly Dictionary<string, object?> Fixed = new()
    {
        [nameof(UserSettings.UseNativePosterTags)] = null, // not chosen: on while the admin allows native poster tags
        [nameof(UserSettings.QualityTagsPreferredAudioLanguage)] = "", // use the server default
        [nameof(UserSettings.LastOpenedTab)] = "shortcuts",
        [nameof(UserSettings.CalendarDisplayMode)] = "list",
        [nameof(UserSettings.CalendarDefaultViewMode)] = "agenda",
    };

    // Per-user only: the admin page has no default for these, so the initializer is written.
    private static readonly HashSet<string> UserOnly =
    [
        nameof(UserSettings.CustomSubtitleTextColor), nameof(UserSettings.CustomSubtitleBgColor), nameof(UserSettings.UsingCustomColors),
        nameof(UserSettings.SubtitleVerticalPosition), nameof(UserSettings.SubtitleHorizontalPosition), nameof(UserSettings.RandomSourceId),
    ];

    private static readonly PropertyInfo[] UserProperties = typeof(UserSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance);

    private static PropertyInfo? AdminProperty(string name) => typeof(PluginConfiguration).GetProperty(name, BindingFlags.Public | BindingFlags.Instance);

    /// <summary>
    /// A PluginConfiguration with every public bool, int and string property set from a seeded
    /// random source; strings include blank and whitespace values. Shared with CoreSettingsDefaultsTests.
    /// </summary>
    internal static void Randomize(PluginConfiguration config, int seed)
    {
        var random = new Random(seed);
        string[] blanks = ["", " ", "\t"];
        foreach (var property in typeof(PluginConfiguration).GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!property.CanWrite || property.GetIndexParameters().Length > 0) continue;
            if (property.PropertyType == typeof(bool)) property.SetValue(config, random.Next(2) == 1);
            else if (property.PropertyType == typeof(int)) property.SetValue(config, random.Next(0, 100));
            else if (property.PropertyType == typeof(string) && !(property.GetValue(config) as string ?? "").TrimStart().StartsWith('['))
            {
                property.SetValue(config, random.Next(4) == 0 ? blanks[random.Next(blanks.Length)] : $"{property.Name}-{random.Next(1000)}");
            }
        }
    }

    [Fact]
    public void EveryUserSettingHasExactlyOneMappingDecision()
    {
        var names = UserProperties.Select(p => p.Name).ToHashSet();
        foreach (var property in UserProperties)
        {
            var decisions = new List<string>();
            if (AdminProperty(property.Name) != null && !Fixed.ContainsKey(property.Name)) decisions.Add("copied from the same-named admin setting");
            if (Aliases.ContainsKey(property.Name)) decisions.Add("aliased");
            if (Fixed.ContainsKey(property.Name)) decisions.Add("fixed");
            if (UserOnly.Contains(property.Name)) decisions.Add("user only");
            Assert.True(decisions.Count == 1, $"{property.Name}: expected one mapping decision, found [{string.Join(", ", decisions)}]");
        }
        // No stale entries: every listed name is a UserSettings property, every alias target an admin setting.
        Assert.DoesNotContain(Aliases.Keys.Concat(Fixed.Keys).Concat(UserOnly).Concat(BlankAdminUsesInitializer), name => !names.Contains(name));
        Assert.All(Aliases.Values, target => Assert.NotNull(AdminProperty(target)));
        // A user-only key must not shadow an admin setting of the same name (it would belong in Fixed).
        Assert.All(UserOnly, name => Assert.Null(AdminProperty(name)));
    }

    public static IEnumerable<object[]> Seeds() => Enumerable.Range(0, 32).Select(seed => new object[] { seed });

    [Theory]
    [MemberData(nameof(Seeds))]
    public void BuilderWritesEachAdminDefaultForRandomizedConfigs(int seed)
    {
        var config = new PluginConfiguration();
        Randomize(config, seed);
        var built = UserSettings.FromAdminDefaults(config);
        var initializers = new UserSettings();
        foreach (var property in UserProperties)
        {
            object? expected;
            if (Fixed.TryGetValue(property.Name, out var value)) expected = value;
            else if (UserOnly.Contains(property.Name)) expected = property.GetValue(initializers);
            else
            {
                expected = AdminProperty(Aliases.GetValueOrDefault(property.Name, property.Name))!.GetValue(config);
                if (BlankAdminUsesInitializer.Contains(property.Name) && string.IsNullOrWhiteSpace((string?)expected)) expected = property.GetValue(initializers);
            }
            var actual = property.GetValue(built);
            Assert.True(Equals(expected, actual), $"seed {seed}: {property.Name} built {actual ?? "null"}, expected {expected ?? "null"}");
        }
    }
}
