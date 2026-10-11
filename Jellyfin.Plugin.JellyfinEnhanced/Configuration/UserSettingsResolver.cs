using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>A user's settings as the server serves them, with the per-key state they were resolved from.</summary>
    public sealed class ResolvedUserSettings
    {
        internal ResolvedUserSettings(UserSettings values, UserSettings? defaults, UserSettingsMeta meta, IReadOnlyList<string> locked)
        {
            Values = values;
            Defaults = defaults;
            Meta = meta;
            Locked = locked;
        }

        /// <summary>Gets the effective values (no provenance block).</summary>
        public UserSettings Values { get; }

        /// <summary>Gets what each inheritable key resolves to while it follows the admin default; null without a plugin configuration.</summary>
        public UserSettings? Defaults { get; }

        /// <summary>Gets the stored provenance, normalised to registry keys (empty lists for a legacy file).</summary>
        public UserSettingsMeta Meta { get; }

        /// <summary>Gets the keys an admin lock forces to the admin value (always empty until locks exist).</summary>
        public IReadOnlyList<string> Locked { get; }

        /// <summary>Whether the key follows the admin default.</summary>
        /// <param name="key">A canonical registry key.</param>
        /// <returns>True when the key is Following.</returns>
        public bool IsFollowing(string key) => Meta.Following.Contains(key, StringComparer.Ordinal);

        /// <summary>Whether an admin lock forces the key to the admin value.</summary>
        /// <param name="key">A canonical registry key.</param>
        /// <returns>True when the key is locked.</returns>
        public bool IsLocked(string key) => Locked.Contains(key, StringComparer.Ordinal);
    }

    /// <summary>
    /// The one place that turns a stored settings.json into the values the server serves (the GET,
    /// bootstrap and the native poster path), first match winning:
    /// 1. Locked: the admin value (the hook is in place; locks arrive with LockedUserSettings).
    /// 2. Following: the current admin default, as the seed would write it.
    /// 3. Chosen or Existing: the stored value, sentinels included (null *TagOrder, "" positions).
    /// 4. A key missing from the file already holds its C# initializer from the typed read.
    /// A legacy file (no "_je" block) is all-Existing, so it resolves to exactly what it stores.
    /// </summary>
    public static class UserSettingsResolver
    {
        /// <summary>Resolves a stored document against the current plugin configuration.</summary>
        /// <param name="stored">The document as read from disk.</param>
        /// <param name="config">The plugin configuration, or null when it is not loaded (Following keys then keep their cached values).</param>
        /// <returns>The effective values and their state.</returns>
        public static ResolvedUserSettings Resolve(UserSettings stored, PluginConfiguration? config)
        {
            ArgumentNullException.ThrowIfNull(stored);
            var meta = Normalize(stored.Meta);
            var values = stored.CloneValues();
            var defaults = config == null ? null : UserSettingsRegistry.BuildDefaults(config);
            var locked = LockedKeys(config);
            if (defaults != null)
            {
                foreach (var descriptor in UserSettingsRegistry.All)
                {
                    if (locked.Contains(descriptor.Key, StringComparer.Ordinal) || meta.Following.Contains(descriptor.Key, StringComparer.Ordinal))
                    {
                        descriptor.Property.SetValue(values, descriptor.Property.GetValue(defaults));
                    }
                }
            }

            return new ResolvedUserSettings(values, defaults, meta, locked);
        }

        /// <summary>
        /// The Meta sibling of a served settings document (GET ?meta=true, bootstrap SettingsMeta and the
        /// /patch answer), with every setting name in PascalCase: Schema, Revision, ConfigEpoch; the
        /// Following, Chosen, ChangedByAdmin and Locked keys; Saved (the stored value of each locked
        /// key); Defaults (what each key with an admin default resolves to while it follows it); Reach
        /// (the effective reach of every key that is not web-only); Unavailable (keys whose admin gate
        /// is off, with the gate's name).
        /// </summary>
        /// <param name="resolved">The resolved document.</param>
        /// <param name="stored">The stored document it was resolved from.</param>
        /// <param name="revision">The stored document's revision.</param>
        /// <param name="configEpoch">The plugin's current config epoch.</param>
        /// <param name="config">The plugin configuration, or null when it is not loaded.</param>
        /// <returns>The Meta object.</returns>
        public static JsonObject DescribeMeta(ResolvedUserSettings resolved, UserSettings stored, string revision, string configEpoch, PluginConfiguration? config)
        {
            ArgumentNullException.ThrowIfNull(resolved);
            ArgumentNullException.ThrowIfNull(stored);
            var saved = new JsonObject();
            var defaults = new JsonObject();
            var reach = new JsonObject();
            var unavailable = new JsonObject();
            foreach (var descriptor in UserSettingsRegistry.All)
            {
                var type = descriptor.Property.PropertyType;
                if (resolved.IsLocked(descriptor.Key))
                {
                    saved[descriptor.Key] = JsonSerializer.SerializeToNode(descriptor.Property.GetValue(stored), type);
                }

                if (resolved.Defaults != null && descriptor.AdminProperty != null)
                {
                    defaults[descriptor.Key] = JsonSerializer.SerializeToNode(descriptor.Property.GetValue(resolved.Defaults), type);
                }

                if (config == null)
                {
                    continue;
                }

                if (descriptor.Setting.Reach != SettingReach.Web)
                {
                    reach[descriptor.Key] = UserSettingsRegistry.EffectiveReach(descriptor, config).ToString();
                }

                if (descriptor.Setting.GateBy != null
                    && typeof(PluginConfiguration).GetProperty(descriptor.Setting.GateBy)?.GetValue(config) is false)
                {
                    unavailable[descriptor.Key] = descriptor.Setting.GateBy;
                }
            }

            return new JsonObject
            {
                ["Schema"] = UserSettingsMeta.CurrentSchema,
                ["Revision"] = revision,
                ["ConfigEpoch"] = configEpoch,
                ["Following"] = Names(resolved.Meta.Following),
                ["Chosen"] = Names(resolved.Meta.Chosen),
                ["ChangedByAdmin"] = Names(resolved.Meta.ChangedByAdmin),
                ["Locked"] = Names(resolved.Locked),
                ["Saved"] = saved,
                ["Defaults"] = defaults,
                ["Reach"] = reach,
                ["Unavailable"] = unavailable,
            };
        }

        /// <summary>
        /// A clean copy of a stored "_je" block: entries matched to registry keys ignoring case and
        /// written in their canonical spelling, unknown or renamed keys dropped, Following limited to
        /// keys with an admin default, a key Following or Chosen but never both (Following wins), and
        /// ChangedByAdmin limited to Chosen keys. Always returns a new object.
        /// </summary>
        /// <param name="meta">The stored block, or null for a legacy file.</param>
        /// <returns>The normalised block.</returns>
        public static UserSettingsMeta Normalize(UserSettingsMeta? meta)
        {
            var following = Keys(meta?.Following);
            var chosen = Keys(meta?.Chosen);
            var changedByAdmin = Keys(meta?.ChangedByAdmin);
            var result = new UserSettingsMeta
            {
                Schema = meta?.Schema ?? UserSettingsMeta.CurrentSchema,
                Ops = meta?.Ops == null
                    ? new Dictionary<string, string>()
                    : new Dictionary<string, string>(meta.Ops.Where(op => op.Key != null && op.Value != null), StringComparer.Ordinal),
                Updated = meta?.Updated,
            };
            foreach (var descriptor in UserSettingsRegistry.All)
            {
                var key = descriptor.Key;
                if (following.Contains(key) && descriptor.AdminProperty != null)
                {
                    result.Following.Add(key);
                }
                else if (chosen.Contains(key))
                {
                    result.Chosen.Add(key);
                    if (changedByAdmin.Contains(key))
                    {
                        result.ChangedByAdmin.Add(key);
                    }
                }
            }

            return result;
        }

        /// <summary>
        /// The keys an admin lock forces to the admin value. Locks (LockedUserSettings) are not part of
        /// the configuration yet, so nothing is locked; every read and write path already consults this.
        /// </summary>
        /// <param name="config">The plugin configuration.</param>
        /// <returns>The locked registry keys.</returns>
        internal static IReadOnlyList<string> LockedKeys(PluginConfiguration? config) => Array.Empty<string>();

        private static JsonArray Names(IEnumerable<string> keys) => new(keys.Select(key => (JsonNode?)key).ToArray());

        private static HashSet<string> Keys(IEnumerable<string>? entries)
            => new HashSet<string>((entries ?? Enumerable.Empty<string>()).Where(entry => entry != null), StringComparer.OrdinalIgnoreCase);
    }
}
