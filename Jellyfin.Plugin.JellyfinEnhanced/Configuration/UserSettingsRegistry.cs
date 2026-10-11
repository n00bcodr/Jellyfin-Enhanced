using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;

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

        private static UserSettingDescriptor[] Build()
        {
            var descriptors = new List<UserSettingDescriptor>();
            foreach (var property in typeof(UserSettings).GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
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
