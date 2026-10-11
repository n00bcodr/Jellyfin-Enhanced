using System.Reflection;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace JE.Tests;

/// <summary>
/// The [UserSetting] registry on UserSettings (design 7.1 and the build checks of section 8): every
/// property is registered or deliberately left out, every admin default exists and fits, every
/// string key is validated, the flags agree with each other and with the code that reads them,
/// and every lockable key has exactly one admin control on configPage.html.
/// </summary>
public class CoreUserSettingsRegistryTests
{
    private static readonly PropertyInfo[] UserProperties = typeof(UserSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance);

    private static readonly Dictionary<string, UserSettingDescriptor> Registered = UserSettingsRegistry.All.ToDictionary(d => d.Key);

    private static PropertyInfo? AdminProperty(string? name)
        => name == null ? null : typeof(PluginConfiguration).GetProperty(name, BindingFlags.Public | BindingFlags.Instance);

    private static string ConfigPage()
    {
        using var stream = typeof(PluginConfiguration).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.Configuration.configPage.html")!;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private static int Count(string page, string attribute, string value)
        => Regex.Matches(page, $"\\b{attribute}=\"{Regex.Escape(value)}\"").Count;

    /// <summary>Whether the value satisfies the key's declared Min/Max, Choices, Pattern and MaxLength.</summary>
    private static bool Satisfies(UserSettingAttribute setting, object? value)
    {
        switch (value)
        {
            case int number:
                return number >= setting.Min && number <= setting.Max;
            case string text:
                return text.Length <= setting.MaxLength
                    && (setting.Choices == null || setting.Choices.Contains(text, StringComparer.Ordinal))
                    && (setting.Pattern == null || Regex.IsMatch(text, setting.Pattern));
            default:
                return true;
        }
    }

    [Fact]
    public void EveryUserSettingIsRegisteredOrDeliberatelyLeftOut()
    {
        foreach (var property in UserProperties)
        {
            var attributed = property.GetCustomAttribute<UserSettingAttribute>() != null;
            var leftOut = UserSettingsRegistry.NotRegistered.ContainsKey(property.Name);
            Assert.True(attributed != leftOut, $"{property.Name}: needs [UserSetting] or an entry in UserSettingsRegistry.NotRegistered (not both)");
            Assert.Equal(attributed, Registered.ContainsKey(property.Name));
        }
        Assert.All(UserSettingsRegistry.NotRegistered.Keys, name => Assert.Contains(UserProperties, p => p.Name == name));
        Assert.Equal(68, UserProperties.Length);
        Assert.Equal(67, Registered.Count);
        // Case-insensitive lookup (request bodies arrive camelCase); unknown keys are not found.
        Assert.True(UserSettingsRegistry.TryGet("autoPipEnabled", out var autoPip));
        Assert.Equal(nameof(UserSettings.AutoPipEnabled), autoPip.Key);
        Assert.False(UserSettingsRegistry.TryGet(nameof(UserSettings.LastOpenedTab), out _));
        Assert.False(UserSettingsRegistry.TryGet("IsAdmin", out _));
    }

    [Fact]
    public void EveryAdminDefaultExistsAndFitsTheUserKey()
    {
        foreach (var descriptor in UserSettingsRegistry.All)
        {
            var setting = descriptor.Setting;
            var admin = AdminProperty(setting.AdminDefault);
            Assert.Equal(admin, descriptor.AdminProperty);
            if (setting.AdminDefault == null) continue;
            Assert.True(admin != null, $"{descriptor.Key}: PluginConfiguration.{setting.AdminDefault} does not exist");
            var target = Nullable.GetUnderlyingType(descriptor.Property.PropertyType) ?? descriptor.Property.PropertyType;
            Assert.True(target.IsAssignableFrom(admin!.PropertyType), $"{descriptor.Key} ({descriptor.Property.PropertyType}) cannot hold {admin.Name} ({admin.PropertyType})");
            Assert.True(admin.CanRead && admin.CanWrite, descriptor.Key);
        }
        // 58 keys have an admin default: 52 under the same name and these 6 renamed ones (design 3.1).
        var renamed = UserSettingsRegistry.All.Where(d => d.AdminProperty != null && d.AdminProperty.Name != d.Key)
            .ToDictionary(d => d.Key, d => d.AdminProperty!.Name);
        Assert.Equal(new Dictionary<string, string>
        {
            [nameof(UserSettings.SelectedStylePresetIndex)] = nameof(PluginConfiguration.DefaultSubtitleStyle),
            [nameof(UserSettings.SelectedFontSizePresetIndex)] = nameof(PluginConfiguration.DefaultSubtitleSize),
            [nameof(UserSettings.SelectedFontFamilyPresetIndex)] = nameof(PluginConfiguration.DefaultSubtitleFont),
            [nameof(UserSettings.SelectedTextEffectPresetIndex)] = nameof(PluginConfiguration.DefaultSubtitleTextEffect),
            [nameof(UserSettings.WatchProgressMode)] = nameof(PluginConfiguration.WatchProgressDefaultMode),
            [nameof(UserSettings.DisplayLanguage)] = nameof(PluginConfiguration.DefaultLanguage),
        }, renamed);
        Assert.Equal(58, UserSettingsRegistry.All.Count(d => d.AdminProperty != null));
        // A user-only key must not shadow a same-named admin setting it forgot to declare.
        Assert.All(UserSettingsRegistry.All.Where(d => d.AdminProperty == null), d => Assert.Null(AdminProperty(d.Key)));
    }

    [Fact]
    public void EveryStringKeyDeclaresChoicesPatternOrMaxLength()
    {
        foreach (var descriptor in UserSettingsRegistry.All.Where(d => d.Property.PropertyType == typeof(string)))
        {
            // MaxLength has a default, so it only counts when the attribute names it.
            var named = descriptor.Property.GetCustomAttributesData().Single(a => a.AttributeType == typeof(UserSettingAttribute))
                .NamedArguments.Select(a => a.MemberName).ToHashSet();
            Assert.True(named.Overlaps(new[] { nameof(UserSettingAttribute.Choices), nameof(UserSettingAttribute.Pattern), nameof(UserSettingAttribute.MaxLength) }),
                $"{descriptor.Key}: a string key must declare Choices, Pattern or MaxLength");
            Assert.True(descriptor.Setting.MaxLength is > 0 and <= 64, descriptor.Key);
            if (descriptor.Setting.Pattern != null) _ = new Regex(descriptor.Setting.Pattern);
        }
        // Validation metadata only where it can apply.
        foreach (var descriptor in UserSettingsRegistry.All)
        {
            var type = Nullable.GetUnderlyingType(descriptor.Property.PropertyType) ?? descriptor.Property.PropertyType;
            var setting = descriptor.Setting;
            if (type != typeof(int)) Assert.True(setting.Min == int.MinValue && setting.Max == int.MaxValue, $"{descriptor.Key}: Min/Max on a non-int key");
            else Assert.True(setting.Min <= setting.Max, descriptor.Key);
            if (type != typeof(string)) Assert.True(setting.Choices == null && setting.Pattern == null, $"{descriptor.Key}: Choices/Pattern on a non-string key");
        }
    }

    [Fact]
    public void InitializersAndShippedAdminDefaultsAreValidValues()
    {
        var initializers = new UserSettings();
        var shipped = new PluginConfiguration();
        foreach (var descriptor in UserSettingsRegistry.All)
        {
            var initial = descriptor.Property.GetValue(initializers);
            Assert.True(Satisfies(descriptor.Setting, initial), $"{descriptor.Key}: initializer {initial} fails its own validation");
            if (descriptor.AdminProperty == null || descriptor.Setting.DefaultIsSentinel) continue;
            var admin = descriptor.AdminProperty.GetValue(shipped);
            Assert.True(Satisfies(descriptor.Setting, admin), $"{descriptor.Key}: shipped admin default {admin} fails the user key's validation");
        }
    }

    [Fact]
    public void FlagsAreConsistent()
    {
        foreach (var descriptor in UserSettingsRegistry.All)
        {
            var setting = descriptor.Setting;
            var type = descriptor.Property.PropertyType;
            var key = descriptor.Key;
            Assert.True(setting.Inheritable == (setting.AdminDefault != null), $"{key}: Inheritable must be false exactly when there is no admin default");
            if (setting.Lockable) Assert.True(setting.Inheritable, $"{key}: a lockable key needs an admin default");
            if (setting.Incidental) Assert.True(setting.Inheritable, $"{key}: an incidental key needs an admin default to follow");
            if (setting.NullInheritsAdmin) Assert.True(Nullable.GetUnderlyingType(type) != null && setting.AdminDefault != null, $"{key}: NullInheritsAdmin needs a nullable key with an admin default");
            if (setting.EmptyInheritsAdmin) Assert.True(type == typeof(string) && setting.AdminDefault != null && Satisfies(setting, ""), $"{key}: EmptyInheritsAdmin needs a string key that accepts \"\"");
            if (setting.DefaultIsSentinel) Assert.True(setting.NullInheritsAdmin || setting.EmptyInheritsAdmin, $"{key}: DefaultIsSentinel needs a sentinel flag");
            if (setting.BlankAdminUsesInitializer) Assert.True(type == typeof(string) && setting.AdminDefault != null, $"{key}: BlankAdminUsesInitializer needs a string admin default");
            if (setting.AdminControlId != null || setting.AdminRowKey != null) Assert.True(setting.Lockable, $"{key}: a control locator only matters for a lockable key");
            Assert.False(setting.AdminControlId != null && setting.AdminRowKey != null, $"{key}: declare a control id or a row key, not both");
            if (setting.GateBy != null) Assert.Equal(typeof(bool), AdminProperty(setting.GateBy)?.PropertyType);
        }
        // The values the design fixes (7.1, 3.3).
        Assert.False(Registered[nameof(UserSettings.PauseScreenDelaySeconds)].Setting.Lockable);
        Assert.Equal([nameof(UserSettings.WatchProgressMode), nameof(UserSettings.ReviewsExpandedByDefault)],
            UserSettingsRegistry.All.Where(d => d.Setting.Incidental).Select(d => d.Key));
        Assert.Equal(6, UserSettingsRegistry.All.Count(d => d.Setting.NullInheritsAdmin && d.Key.EndsWith("TagOrder", StringComparison.Ordinal)));
        Assert.Equal(5, UserSettingsRegistry.All.Count(d => d.Setting.EmptyInheritsAdmin && d.Key.EndsWith("TagsPosition", StringComparison.Ordinal)));
        Assert.Equal(nameof(PluginConfiguration.NativePosterTagsEnabled), Registered[nameof(UserSettings.UseNativePosterTags)].Setting.GateBy);
        Assert.Equal(57, UserSettingsRegistry.All.Count(d => d.Setting.Lockable));
    }

    [Fact]
    public void EveryLockableKeyResolvesToExactlyOneAdminControl()
    {
        var page = ConfigPage();
        foreach (var descriptor in UserSettingsRegistry.All.Where(d => d.AdminProperty != null))
        {
            var setting = descriptor.Setting;
            var admin = descriptor.AdminProperty!.Name;
            var camel = char.ToLowerInvariant(admin[0]) + admin[1..];
            if (!setting.Lockable)
            {
                // A key with an admin default but no lock has no control yet; once one is added it must become lockable.
                Assert.True(Count(page, "id", camel) + Count(page, "id", admin) + Count(page, "data-order-key", admin) == 0,
                    $"{descriptor.Key}: the admin page has a control for {admin}, so the key should be Lockable");
                continue;
            }
            if (setting.AdminRowKey != null)
            {
                Assert.True(Count(page, "data-order-key", setting.AdminRowKey) == 1, $"{descriptor.Key}: expected one data-order-key=\"{setting.AdminRowKey}\" row");
                continue;
            }
            var id = setting.AdminControlId ?? camel;
            Assert.True(Count(page, "id", id) == 1, $"{descriptor.Key}: expected exactly one id=\"{id}\" on configPage.html, found {Count(page, "id", id)}");
            // AdminControlId is only for the exceptions to the camelCase convention.
            if (setting.AdminControlId != null) Assert.True(Count(page, "id", camel) == 0, $"{descriptor.Key}: id=\"{camel}\" exists, so AdminControlId is not needed");
        }
    }

    /// <summary>A few other values for a key, to see whether PosterTagSettings reads it.</summary>
    private static IEnumerable<object?> Alternatives(UserSettingDescriptor descriptor, object? current)
    {
        var type = descriptor.Property.PropertyType;
        if (type == typeof(bool)) return [!(bool)current!];
        if (type == typeof(bool?)) return [null, true, false];
        if (type == typeof(int?)) return new object?[] { null }.Concat(Enumerable.Range(1, 6).Cast<object?>());
        if (type == typeof(int)) return [(int)current! + 1, (int)current! - 1];
        return (descriptor.Setting.Choices ?? ["", "fra", "auto", "none"]).Cast<object?>();
    }

    private static Dictionary<string, object?> Effective(UserSettings user, PluginConfiguration config)
    {
        var settings = PosterTagSettings.FromUserSettings(user, config, "deu");
        return typeof(PosterTagSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.Name != nameof(PosterTagSettings.Digest))
            .Where(p => (Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType) is var t && (t.IsPrimitive || t.IsEnum || t == typeof(string)))
            .ToDictionary(p => p.Name, p => p.GetValue(settings));
    }

    [Fact]
    public void ReachIsWebExactlyForKeysPosterTagSettingsNeverReads()
    {
        var config = new PluginConfiguration { NativePosterTagsEnabled = true };
        var baseline = UserSettingsRegistry.BuildDefaults(config);
        var expected = Effective(baseline, config);
        foreach (var descriptor in UserSettingsRegistry.All)
        {
            var current = descriptor.Property.GetValue(baseline);
            var read = false;
            foreach (var value in Alternatives(descriptor, current))
            {
                var changed = UserSettingsRegistry.BuildDefaults(config);
                descriptor.Property.SetValue(changed, value);
                var effective = Effective(changed, config);
                read |= effective.Any(pair => !Equals(pair.Value, expected[pair.Key]));
            }
            Assert.True(read == (descriptor.Setting.Reach != SettingReach.Web),
                $"{descriptor.Key}: Reach {descriptor.Setting.Reach}, but PosterTagSettings {(read ? "reads" : "never reads")} it");
        }
    }
}
