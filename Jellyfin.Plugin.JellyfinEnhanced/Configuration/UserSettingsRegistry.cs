using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>One registered per-user setting: the <see cref="UserSettings"/> property and its <see cref="UserSettingAttribute"/>.</summary>
    public sealed class UserSettingDescriptor
    {
        internal UserSettingDescriptor(PropertyInfo property, UserSettingAttribute setting, PropertyInfo? adminProperty)
        {
            Property = property;
            Setting = setting;
            AdminProperty = adminProperty;
        }

        /// <summary>Gets the settings.json key (the UserSettings property name).</summary>
        public string Key => Property.Name;

        /// <summary>Gets the UserSettings property.</summary>
        public PropertyInfo Property { get; }

        /// <summary>Gets the registry metadata declared on the property.</summary>
        public UserSettingAttribute Setting { get; }

        /// <summary>Gets the PluginConfiguration property holding the admin default, or null for a user-only key.</summary>
        public PropertyInfo? AdminProperty { get; }
    }

    /// <summary>
    /// The per-user settings registry, built once by reflection from the [UserSetting] attributes on
    /// <see cref="UserSettings"/>. It is the one place that maps admin defaults onto user keys:
    /// the first-access seed, reset-all and the native poster path's defaults all come from
    /// <see cref="BuildDefaults"/>.
    /// </summary>
    public static class UserSettingsRegistry
    {
        /// <summary>Subtitle colours as the panel writes them (#RRGGBB or #RRGGBBAA), plus the "transparent" a style preset stores.</summary>
        public const string ColourPattern = "^(#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?|transparent)$";

        /// <summary>
        /// UserSettings properties that are deliberately not registry keys, with the reason. Device-local
        /// UI state is not a setting (design 3.1); <see cref="BuildDefaults"/> still writes the value the
        /// seed has always written for it.
        /// </summary>
        public static readonly IReadOnlyDictionary<string, string> NotRegistered = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [nameof(UserSettings.LastOpenedTab)] = "Device-local panel state; seeded as \"shortcuts\".",
        };

        private static readonly UserSettingDescriptor[] Descriptors = Build();

        private static readonly Dictionary<string, UserSettingDescriptor> ByKey =
            Descriptors.ToDictionary(d => d.Key, StringComparer.OrdinalIgnoreCase);

        /// <summary>Gets every registered key, in UserSettings declaration order.</summary>
        public static IReadOnlyList<UserSettingDescriptor> All => Descriptors;

        /// <summary>Looks up a registered key, ignoring case.</summary>
        /// <param name="key">The settings.json key.</param>
        /// <param name="descriptor">The registry entry when found.</param>
        /// <returns>True when the key is registered.</returns>
        public static bool TryGet(string key, [NotNullWhen(true)] out UserSettingDescriptor? descriptor)
            => ByKey.TryGetValue(key, out descriptor);

        /// <summary>
        /// The settings a user gets from the administrator's current defaults: the first-access seed of
        /// settings.json and "reset all users" both write this. Each key with an admin default copies it
        /// (a blank admin value gives the initializer where the key says so, and a key whose default is
        /// its sentinel keeps the sentinel); user-only keys keep their initializers.
        /// </summary>
        /// <param name="config">The plugin configuration holding the admin defaults.</param>
        /// <returns>A new settings document built from the admin defaults.</returns>
        public static UserSettings BuildDefaults(PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(config);
            var settings = new UserSettings();
            foreach (var descriptor in Descriptors)
            {
                if (descriptor.AdminProperty == null || descriptor.Setting.DefaultIsSentinel)
                {
                    continue;
                }

                var value = descriptor.AdminProperty.GetValue(config);
                if (descriptor.Setting.BlankAdminUsesInitializer && string.IsNullOrWhiteSpace(value as string))
                {
                    continue;
                }

                descriptor.Property.SetValue(settings, value);
            }

            settings.LastOpenedTab = "shortcuts";
            return settings;
        }

        /// <summary>
        /// Whether a key's default is published to signed-in users in the public config's
        /// UserSettingDefaults block: it must copy an admin default (not a sentinel), and that admin
        /// value must be a bool, an int or a string limited to the key's Choices. Free-form strings
        /// (the display language) stay out, so the block never carries text an admin typed.
        /// </summary>
        /// <param name="descriptor">The registry entry.</param>
        /// <returns>True when <see cref="PublicDefaults"/> includes the key.</returns>
        public static bool IsPublicDefault(UserSettingDescriptor descriptor)
        {
            ArgumentNullException.ThrowIfNull(descriptor);
            var admin = descriptor.AdminProperty;
            if (admin == null || descriptor.Setting.DefaultIsSentinel)
            {
                return false;
            }

            return admin.PropertyType == typeof(bool)
                || admin.PropertyType == typeof(int)
                || (admin.PropertyType == typeof(string) && descriptor.Setting.Choices != null);
        }

        /// <summary>
        /// The UserSettingDefaults block of the authenticated public config: for each
        /// <see cref="IsPublicDefault"/> key, the value <see cref="BuildDefaults"/> seeds, by settings.json
        /// key. The client falls back to it when a stored value is missing. A string outside the key's
        /// Choices (an admin value saved through the API) is left out, so the client uses its own default.
        /// </summary>
        /// <param name="config">The plugin configuration holding the admin defaults.</param>
        /// <returns>The published defaults, in UserSettings declaration order.</returns>
        public static IReadOnlyDictionary<string, object> PublicDefaults(PluginConfiguration config)
        {
            var defaults = BuildDefaults(config);
            var published = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var descriptor in Descriptors)
            {
                if (!IsPublicDefault(descriptor))
                {
                    continue;
                }

                var value = descriptor.Property.GetValue(defaults);
                if (value is string text && !descriptor.Setting.Choices!.Contains(text, StringComparer.Ordinal))
                {
                    continue;
                }

                if (value != null)
                {
                    published[descriptor.Key] = value;
                }
            }

            return published;
        }

        /// <summary>
        /// Coerces a posted JSON value to the key's property type and checks the key's constraints
        /// (Min/Max, Choices, Pattern, MaxLength). Numbers and booleans are also accepted as strings,
        /// as Jellyfin's JSON options read them for the typed model. JSON null is accepted only for a
        /// nullable key (the *TagOrder and UseNativePosterTags sentinels).
        /// </summary>
        /// <param name="descriptor">The registry entry.</param>
        /// <param name="value">The posted value.</param>
        /// <param name="coerced">The value to store when valid.</param>
        /// <returns>True when the value can be stored.</returns>
        public static bool TryValidate(UserSettingDescriptor descriptor, JsonElement value, out object? coerced)
        {
            ArgumentNullException.ThrowIfNull(descriptor);
            coerced = null;
            var type = descriptor.Property.PropertyType;
            var underlying = Nullable.GetUnderlyingType(type);
            if (value.ValueKind == JsonValueKind.Null)
            {
                return underlying != null;
            }

            var target = underlying ?? type;
            var setting = descriptor.Setting;
            if (target == typeof(bool))
            {
                if (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False)
                {
                    coerced = value.GetBoolean();
                    return true;
                }

                if (value.ValueKind == JsonValueKind.String && bool.TryParse(value.GetString(), out var parsed))
                {
                    coerced = parsed;
                    return true;
                }

                return false;
            }

            if (target == typeof(int))
            {
                int number;
                if (value.ValueKind == JsonValueKind.Number)
                {
                    if (!value.TryGetInt32(out number))
                    {
                        return false;
                    }
                }
                else if (value.ValueKind != JsonValueKind.String
                    || !int.TryParse(value.GetString(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out number))
                {
                    return false;
                }

                if (number < setting.Min || number > setting.Max)
                {
                    return false;
                }

                coerced = number;
                return true;
            }

            if (target == typeof(string))
            {
                if (value.ValueKind != JsonValueKind.String)
                {
                    return false;
                }

                var text = value.GetString() ?? string.Empty;
                if (setting.Choices != null)
                {
                    if (!setting.Choices.Contains(text, StringComparer.Ordinal))
                    {
                        return false;
                    }
                }
                else if (text.Length > setting.MaxLength
                    || (setting.Pattern != null && !Regex.IsMatch(text, setting.Pattern, RegexOptions.None, TimeSpan.FromMilliseconds(100))))
                {
                    return false;
                }

                coerced = text;
                return true;
            }

            return false;
        }

        /// <summary>
        /// Where a key takes effect under the current config: a key that also drives native poster
        /// images only reaches them while the admin has native poster tags on.
        /// </summary>
        /// <param name="descriptor">The registry entry.</param>
        /// <param name="config">The plugin configuration.</param>
        /// <returns>The effective reach.</returns>
        public static SettingReach EffectiveReach(UserSettingDescriptor descriptor, PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(descriptor);
            ArgumentNullException.ThrowIfNull(config);
            return descriptor.Setting.Reach == SettingReach.Both && !config.NativePosterTagsEnabled
                ? SettingReach.Web
                : descriptor.Setting.Reach;
        }

        private static UserSettingDescriptor[] Build()
        {
            var descriptors = new List<UserSettingDescriptor>();
            foreach (var property in typeof(UserSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                if (property.Name == nameof(UserSettings.Meta))
                {
                    // The "_je" provenance block, not a setting.
                    continue;
                }

                var setting = property.GetCustomAttribute<UserSettingAttribute>();
                if (setting == null)
                {
                    if (NotRegistered.ContainsKey(property.Name))
                    {
                        continue;
                    }

                    throw new InvalidOperationException($"UserSettings.{property.Name} has no [UserSetting] and is not listed in UserSettingsRegistry.NotRegistered.");
                }

                PropertyInfo? admin = null;
                if (setting.AdminDefault != null)
                {
                    admin = typeof(PluginConfiguration).GetProperty(setting.AdminDefault, BindingFlags.Public | BindingFlags.Instance)
                        ?? throw new InvalidOperationException($"UserSettings.{property.Name}: admin default PluginConfiguration.{setting.AdminDefault} does not exist.");
                    var target = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
                    if (!target.IsAssignableFrom(admin.PropertyType))
                    {
                        throw new InvalidOperationException($"UserSettings.{property.Name} ({property.PropertyType.Name}) cannot hold PluginConfiguration.{admin.Name} ({admin.PropertyType.Name}).");
                    }
                }

                descriptors.Add(new UserSettingDescriptor(property, setting, admin));
            }

            return descriptors.ToArray();
        }
    }
}
