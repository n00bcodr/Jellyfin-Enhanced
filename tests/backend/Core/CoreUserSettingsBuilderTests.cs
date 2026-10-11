using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace JE.Tests;

/// <summary>
/// UserSettingsRegistry.BuildDefaults, the one builder behind the first-access seed, reset-all and
/// the native poster path's defaults. The expected value of every key is read straight from its
/// [UserSetting] attribute here (copy the admin default, a blank one gives the initializer where
/// declared, a sentinel default or a user-only key keeps the initializer), and randomized admin
/// configs check the builder honours each declaration. Coverage and the metadata itself are
/// checked in CoreUserSettingsRegistryTests.
/// </summary>
public class CoreUserSettingsBuilderTests
{
    // Not registry keys, but the builder still writes this value (UserSettingsRegistry.NotRegistered).
    private static readonly Dictionary<string, object?> Unregistered = new()
    {
        [nameof(UserSettings.LastOpenedTab)] = "shortcuts",
    };

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
    public void UnregisteredKeysAreExactlyTheRegistryAllowlist()
    {
        Assert.Equal(UserSettingsRegistry.NotRegistered.Keys.OrderBy(k => k), Unregistered.Keys.OrderBy(k => k));
    }

    public static IEnumerable<object[]> Seeds() => Enumerable.Range(0, 32).Select(seed => new object[] { seed });

    [Theory]
    [MemberData(nameof(Seeds))]
    public void BuilderWritesEachAdminDefaultForRandomizedConfigs(int seed)
    {
        var config = new PluginConfiguration();
        Randomize(config, seed);
        var built = UserSettingsRegistry.BuildDefaults(config);
        var initializers = new UserSettings();
        foreach (var property in UserProperties)
        {
            object? expected;
            var setting = property.GetCustomAttribute<UserSettingAttribute>();
            if (setting == null) expected = Unregistered[property.Name];
            else if (setting.AdminDefault == null || setting.DefaultIsSentinel) expected = property.GetValue(initializers);
            else
            {
                expected = AdminProperty(setting.AdminDefault)!.GetValue(config);
                if (setting.BlankAdminUsesInitializer && string.IsNullOrWhiteSpace((string?)expected)) expected = property.GetValue(initializers);
            }
            var actual = property.GetValue(built);
            Assert.True(Equals(expected, actual), $"seed {seed}: {property.Name} built {actual ?? "null"}, expected {expected ?? "null"}");
        }
    }
}
