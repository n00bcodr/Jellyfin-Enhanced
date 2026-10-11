using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// The keys an administrator unlocked while this process ran, each with every value its lock
    /// enforced during that lock period (the admin default can change while a key stays locked).
    /// A browser tab that loaded while a key was locked still holds one of those values and an
    /// older bundle posts it back with every whole-document save; the legacy POST refuses such a
    /// value when it differs from the user's stored choice (reason "stale"), so the unlock gives
    /// the user's own choice back instead of overwriting it. In memory only, like the file locks:
    /// a restart forgets it (tabs from before a restart reload their settings anyway).
    /// </summary>
    public static class RecentlyUnlockedSettings
    {
        private static readonly object Sync = new();

        // Locked keys: the values each lock enforced in its current lock period, as seen by config saves.
        private static readonly Dictionary<string, List<object?>> WhileLocked = new(StringComparer.Ordinal);

        // Unlocked keys: the values their last lock period enforced.
        private static readonly Dictionary<string, List<object?>> Enforced = new(StringComparer.Ordinal);

        /// <summary>
        /// Records the effect of an admin config save: a key that stays locked adds the value the
        /// new configuration enforces to its lock period, a key unlocked is remembered with every
        /// value its lock period enforced, and a key locked again starts a new lock period and is
        /// forgotten as unlocked.
        /// </summary>
        /// <param name="before">The configuration being replaced, or null on first load.</param>
        /// <param name="after">The configuration now in effect.</param>
        public static void Record(PluginConfiguration? before, PluginConfiguration? after)
        {
            var wasLocked = UserSettingsResolver.LockedKeys(before);
            var nowLocked = UserSettingsResolver.LockedKeys(after);
            var unlocked = wasLocked.Except(nowLocked, StringComparer.Ordinal).ToArray();
            var beforeDefaults = before != null && wasLocked.Count > 0 ? UserSettingsRegistry.BuildDefaults(before) : null;
            var afterDefaults = after != null && nowLocked.Count > 0 ? UserSettingsRegistry.BuildDefaults(after) : null;

            lock (Sync)
            {
                foreach (var key in nowLocked)
                {
                    Enforced.Remove(key);
                    if (!UserSettingsRegistry.TryGet(key, out var descriptor))
                    {
                        continue;
                    }

                    // A key that was not locked before starts a new lock period.
                    if (!wasLocked.Contains(key, StringComparer.Ordinal) || !WhileLocked.TryGetValue(key, out var values))
                    {
                        values = new List<object?>();
                        WhileLocked[key] = values;
                    }

                    if (beforeDefaults != null && wasLocked.Contains(key, StringComparer.Ordinal))
                    {
                        AddDistinct(values, descriptor.Property.GetValue(beforeDefaults));
                    }

                    if (afterDefaults != null)
                    {
                        AddDistinct(values, descriptor.Property.GetValue(afterDefaults));
                    }
                }

                foreach (var key in unlocked)
                {
                    WhileLocked.Remove(key, out var values);
                    values ??= new List<object?>();
                    if (beforeDefaults != null && UserSettingsRegistry.TryGet(key, out var descriptor))
                    {
                        AddDistinct(values, descriptor.Property.GetValue(beforeDefaults));
                    }

                    Enforced[key] = values;
                }
            }
        }

        /// <summary>Whether a value is one the lock on a key enforced before it was lifted.</summary>
        /// <param name="key">A canonical registry key.</param>
        /// <param name="value">The posted value.</param>
        /// <returns>True when the key was unlocked in this process, is not locked again, and its last lock period enforced the value.</returns>
        public static bool WasEnforced(string key, object? value)
        {
            lock (Sync)
            {
                return Enforced.TryGetValue(key, out var values) && values.Exists(enforced => Equals(enforced, value));
            }
        }

        /// <summary>Gets the recorded keys (for tests and diagnostics).</summary>
        public static IReadOnlyCollection<string> Keys
        {
            get
            {
                lock (Sync)
                {
                    return Enforced.Keys.ToArray();
                }
            }
        }

        /// <summary>Forgets every recorded key and lock period (tests).</summary>
        internal static void Clear()
        {
            lock (Sync)
            {
                WhileLocked.Clear();
                Enforced.Clear();
            }
        }

        private static void AddDistinct(List<object?> values, object? value)
        {
            if (!values.Exists(existing => Equals(existing, value)))
            {
                values.Add(value);
            }
        }
    }
}
