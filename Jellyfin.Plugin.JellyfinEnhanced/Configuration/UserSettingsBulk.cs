using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>How "Apply defaults to users" treats each selected key (design 4.4).</summary>
    public enum UserSettingsApplyMode
    {
        /// <summary>Follow the default only where that changes nothing today: Existing keys whose stored value is the default.</summary>
        FollowIfUnchanged,

        /// <summary>Every selected key that can follow a default follows it, whatever the user had.</summary>
        FollowAll,

        /// <summary>The old reset: the current default value is written and the key is no longer Following or Chosen.</summary>
        Overwrite,
    }

    /// <summary>
    /// One key an admin bulk operation changed for one user: the value, state and operation stamp
    /// before, and the value and state it wrote. Stored in the operation's undo record.
    /// </summary>
    public sealed class UserSettingsKeyChange
    {
        /// <summary>Gets or sets the registry key.</summary>
        public string Key { get; set; } = string.Empty;

        /// <summary>Gets or sets the stored value before the operation.</summary>
        public JToken? Before { get; set; }

        /// <summary>Gets or sets the key's state before the operation (see <see cref="UserSettingsBulk"/> state names).</summary>
        public string BeforeState { get; set; } = UserSettingsBulk.StateExisting;

        /// <summary>Gets or sets the operation that had changed the key before this one, if any.</summary>
        public string? BeforeOp { get; set; }

        /// <summary>Gets or sets the stored value the operation wrote.</summary>
        public JToken? After { get; set; }

        /// <summary>Gets or sets the state the operation left the key in.</summary>
        public string AfterState { get; set; } = UserSettingsBulk.StateExisting;

        /// <summary>Gets or sets a value indicating whether the user sees a different value afterwards (preview only, not stored).</summary>
        [JsonIgnore]
        public bool Visible { get; set; }
    }

    /// <summary>What a bulk operation does (or would do) to one user's settings.json.</summary>
    public sealed class UserSettingsBulkPlan
    {
        /// <summary>Gets the keys whose value or state changes, in registry order.</summary>
        public List<UserSettingsKeyChange> Changes { get; } = new();

        /// <summary>Gets the selected keys that keep the user's own value (FollowIfUnchanged: Chosen, or a value unlike the default).</summary>
        public List<string> Kept { get; } = new();

        /// <summary>Gets or sets a value indicating whether the document must be saved (key changes, or Overwrite's panel-tab reset).</summary>
        public bool Changed { get; set; }
    }

    /// <summary>
    /// The per-document part of "Apply defaults to users" and its undo, applied in place to a
    /// settings.json document the caller read (and, for a real run, holds the per-file lock for).
    /// A preview runs the very same code on a copy that is never saved, so a dry run reports
    /// exactly what the run would do. Every changed key is stamped with the operation id in
    /// "_je".Ops; any later write of the key by the user clears the stamp
    /// (<see cref="UserSettingsWriter"/>), which is what makes undo compare-and-swap.
    /// </summary>
    public static class UserSettingsBulk
    {
        /// <summary>A value from before tracking began (in neither list).</summary>
        public const string StateExisting = "Existing";

        /// <summary>The user's own choice.</summary>
        public const string StateChosen = "Chosen";

        /// <summary>A choice an administrator wrote for the user.</summary>
        public const string StateChangedByAdmin = "ChangedByAdmin";

        /// <summary>Uses the current admin default.</summary>
        public const string StateFollowing = "Following";

        /// <summary>The value the old reset wrote for the device-local panel tab (not a registry key, never undone).</summary>
        private const string SeededPanelTab = "shortcuts";

        /// <summary>The state of a key in a normalised provenance block.</summary>
        /// <param name="meta">The normalised block.</param>
        /// <param name="key">A canonical registry key.</param>
        /// <returns>One of the state names.</returns>
        public static string StateOf(UserSettingsMeta meta, string key)
        {
            ArgumentNullException.ThrowIfNull(meta);
            if (meta.Following.Contains(key, StringComparer.Ordinal)) return StateFollowing;
            if (meta.ChangedByAdmin.Contains(key, StringComparer.Ordinal)) return StateChangedByAdmin;
            if (meta.Chosen.Contains(key, StringComparer.Ordinal)) return StateChosen;
            return StateExisting;
        }

        /// <summary>
        /// Whether FollowIfUnchanged adopts a key: it can follow a default, is Existing (never Chosen,
        /// not already Following), and its stored value is the default after the adapter, a sentinel
        /// that already means "the admin value" counting as equal. The stored value is compared, so a
        /// value that only looks equal because of a lock does not qualify.
        /// </summary>
        /// <param name="descriptor">The registry entry.</param>
        /// <param name="stored">The stored document.</param>
        /// <param name="meta">Its normalised provenance.</param>
        /// <param name="defaults">The admin defaults (<see cref="UserSettingsRegistry.BuildDefaults"/>).</param>
        /// <returns>True when following the default changes nothing the user sees.</returns>
        public static bool IsAdoptable(UserSettingDescriptor descriptor, UserSettings stored, UserSettingsMeta meta, UserSettings defaults)
        {
            ArgumentNullException.ThrowIfNull(descriptor);
            ArgumentNullException.ThrowIfNull(stored);
            return UserSettingsRegistry.CanFollow(descriptor)
                && StateOf(meta, descriptor.Key) == StateExisting
                && UserSettingsResolver.EqualsDefault(descriptor, descriptor.Property.GetValue(stored), defaults);
        }

        /// <summary>
        /// Applies one bulk operation to a stored settings.json document, in place. FollowIfUnchanged
        /// and FollowAll make keys Following (their stored value becomes the default's cached value);
        /// Overwrite writes the default value (the initializer for a key without an admin default) and
        /// makes the key Existing again, and resets the panel tab as the old reset did. Keys already
        /// in the target state with the target value are left alone. Every changed key is stamped
        /// with <paramref name="operationId"/>.
        /// </summary>
        /// <param name="document">The stored document; changed in place.</param>
        /// <param name="config">The plugin configuration holding the admin defaults.</param>
        /// <param name="keys">The selected registry keys (Follow modes: keys that can follow).</param>
        /// <param name="mode">The operation mode.</param>
        /// <param name="operationId">The operation id stamped on every changed key.</param>
        /// <param name="utcNow">The time recorded in the provenance block.</param>
        /// <returns>The changes, the keys that kept the user's value, and whether to save.</returns>
        public static UserSettingsBulkPlan Apply(UserSettings document, PluginConfiguration config, IEnumerable<UserSettingDescriptor> keys, UserSettingsApplyMode mode, string operationId, DateTime utcNow)
        {
            ArgumentNullException.ThrowIfNull(document);
            ArgumentNullException.ThrowIfNull(config);
            ArgumentNullException.ThrowIfNull(keys);
            var plan = new UserSettingsBulkPlan();
            var before = UserSettingsResolver.Resolve(document, config);
            var defaults = before.Defaults!;
            var meta = before.Meta;
            var selected = new HashSet<string>(keys.Select(descriptor => descriptor.Key), StringComparer.Ordinal);

            foreach (var descriptor in UserSettingsRegistry.All.Where(descriptor => selected.Contains(descriptor.Key)))
            {
                var key = descriptor.Key;
                var state = StateOf(meta, key);
                var stored = descriptor.Property.GetValue(document);
                var target = descriptor.Property.GetValue(defaults);
                string targetState;
                if (mode == UserSettingsApplyMode.Overwrite)
                {
                    targetState = StateExisting;
                    if (state == StateExisting && Equals(stored, target))
                    {
                        continue;
                    }
                }
                else
                {
                    if (!UserSettingsRegistry.CanFollow(descriptor) || state == StateFollowing)
                    {
                        continue;
                    }

                    if (mode == UserSettingsApplyMode.FollowIfUnchanged && !IsAdoptable(descriptor, document, meta, defaults))
                    {
                        plan.Kept.Add(key);
                        continue;
                    }

                    targetState = StateFollowing;
                }

                plan.Changes.Add(new UserSettingsKeyChange
                {
                    Key = key,
                    Before = Token(stored),
                    BeforeState = state,
                    BeforeOp = meta.Ops.TryGetValue(key, out var previousOp) ? previousOp : null,
                    After = Token(target),
                    AfterState = targetState,
                });
                descriptor.Property.SetValue(document, target);
                SetState(meta, key, targetState);
                meta.Ops[key] = operationId;
            }

            if (mode == UserSettingsApplyMode.Overwrite && !string.Equals(document.LastOpenedTab, SeededPanelTab, StringComparison.Ordinal))
            {
                // The old reset wrote the seed's panel tab too (device-local state, not a setting).
                document.LastOpenedTab = SeededPanelTab;
                plan.Changed = true;
            }

            if (plan.Changes.Count == 0)
            {
                return plan;
            }

            // Every read-modify-write refreshes the cached values of Following keys (design 7.2).
            foreach (var key in meta.Following)
            {
                if (UserSettingsRegistry.TryGet(key, out var descriptor))
                {
                    descriptor.Property.SetValue(document, descriptor.Property.GetValue(defaults));
                }
            }

            meta.Schema = UserSettingsMeta.CurrentSchema;
            meta.Updated = utcNow;
            document.Meta = UserSettingsResolver.Normalize(meta);
            plan.Changed = true;

            var after = UserSettingsResolver.Resolve(document, config);
            foreach (var change in plan.Changes)
            {
                UserSettingsRegistry.TryGet(change.Key, out var descriptor);
                change.Visible = !SameEffectiveValue(descriptor!, descriptor!.Property.GetValue(before.Values), descriptor.Property.GetValue(after.Values), defaults);
            }

            return plan;
        }

        /// <summary>
        /// Undoes one operation's changes to a stored settings.json document, in place, key by key:
        /// a key is restored (value, state and the stamp it had before) only while it still carries
        /// the operation's stamp, has the state the operation left, and (unless the operation made it
        /// Following, whose value is only a cache) still holds the value the operation wrote. Any
        /// other key was changed since and is kept.
        /// </summary>
        /// <param name="document">The stored document; changed in place.</param>
        /// <param name="config">The plugin configuration, or null when it is not loaded.</param>
        /// <param name="changes">The operation's changes for this user.</param>
        /// <param name="operationId">The operation being undone.</param>
        /// <param name="utcNow">The time recorded in the provenance block.</param>
        /// <param name="restored">The keys restored.</param>
        /// <param name="kept">The keys changed since, left as they are.</param>
        /// <returns>True when the document changed and must be saved.</returns>
        public static bool Undo(UserSettings document, PluginConfiguration? config, IEnumerable<UserSettingsKeyChange> changes, string operationId, DateTime utcNow, List<string> restored, List<string> kept)
        {
            ArgumentNullException.ThrowIfNull(document);
            ArgumentNullException.ThrowIfNull(changes);
            ArgumentNullException.ThrowIfNull(restored);
            ArgumentNullException.ThrowIfNull(kept);
            var resolved = UserSettingsResolver.Resolve(document, config);
            var meta = resolved.Meta;
            foreach (var change in changes)
            {
                if (change == null || !UserSettingsRegistry.TryGet(change.Key ?? string.Empty, out var descriptor))
                {
                    continue;
                }

                var key = descriptor.Key;
                var current = descriptor.Property.GetValue(document);
                var unchangedSince = meta.Ops.TryGetValue(key, out var stamp)
                    && string.Equals(stamp, operationId, StringComparison.Ordinal)
                    && StateOf(meta, key) == change.AfterState
                    && (change.AfterState == StateFollowing || JToken.DeepEquals(Token(current), change.After ?? JValue.CreateNull()));
                if (!unchangedSince || !TryValue(descriptor, change.Before, out var value))
                {
                    kept.Add(key);
                    continue;
                }

                if (change.BeforeState == StateFollowing && resolved.Defaults != null && UserSettingsRegistry.CanFollow(descriptor))
                {
                    value = descriptor.Property.GetValue(resolved.Defaults);
                }

                descriptor.Property.SetValue(document, value);
                SetState(meta, key, change.BeforeState);
                if (change.BeforeOp != null)
                {
                    meta.Ops[key] = change.BeforeOp;
                }
                else
                {
                    meta.Ops.Remove(key);
                }

                restored.Add(key);
            }

            if (restored.Count == 0)
            {
                return false;
            }

            meta.Schema = UserSettingsMeta.CurrentSchema;
            meta.Updated = utcNow;
            document.Meta = UserSettingsResolver.Normalize(meta);
            return true;
        }

        /// <summary>A stored value as JSON (null for null).</summary>
        /// <param name="value">The value.</param>
        /// <returns>The JSON token.</returns>
        public static JToken Token(object? value) => value == null ? JValue.CreateNull() : JToken.FromObject(value);

        /// <summary>
        /// Whether two effective values look the same to the user: equal, or one is a sentinel that
        /// means "the admin value" and the other is that value.
        /// </summary>
        private static bool SameEffectiveValue(UserSettingDescriptor descriptor, object? before, object? after, UserSettings defaults)
        {
            if (Equals(before, after)) return true;
            var beforeIsDefault = UserSettingsResolver.EqualsDefault(descriptor, before, defaults);
            var afterIsDefault = UserSettingsResolver.EqualsDefault(descriptor, after, defaults);
            return beforeIsDefault && afterIsDefault;
        }

        private static bool TryValue(UserSettingDescriptor descriptor, JToken? token, out object? value)
        {
            value = null;
            var type = descriptor.Property.PropertyType;
            if (token == null || token.Type == JTokenType.Null)
            {
                return !type.IsValueType || Nullable.GetUnderlyingType(type) != null;
            }

            try
            {
                value = token.ToObject(type);
                return true;
            }
            catch (Exception ex) when (ex is JsonException || ex is ArgumentException || ex is FormatException || ex is InvalidCastException || ex is OverflowException)
            {
                return false;
            }
        }

        private static void SetState(UserSettingsMeta meta, string key, string state)
        {
            meta.Following.Remove(key);
            meta.Chosen.Remove(key);
            meta.ChangedByAdmin.Remove(key);
            switch (state)
            {
                case StateFollowing:
                    meta.Following.Add(key);
                    break;
                case StateChangedByAdmin:
                    meta.Chosen.Add(key);
                    meta.ChangedByAdmin.Add(key);
                    break;
                case StateChosen:
                    meta.Chosen.Add(key);
                    break;
            }
        }
    }
}
