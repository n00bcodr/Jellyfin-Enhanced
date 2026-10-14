using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// The keys an administrator unlocked while this process ran, each with every value a lock on
    /// it enforced (the admin default can change while a key stays locked, and a key can be locked
    /// and unlocked more than once).
    /// A browser tab that loaded while a key was locked still holds one of those values and an
    /// older bundle posts it back with every whole-document save; the legacy POST refuses such a
    /// value when it differs from the user's stored choice (reason "stale"), so the unlock gives
    /// the user's own choice back instead of overwriting it. In memory only, like the file locks:
    /// a restart forgets it (tabs from before a restart reload their settings anyway).
    /// </summary>
    public static class RecentlyUnlockedSettings
    {
        private static readonly object Sync = new();

        // Locked keys: the values their locks enforced so far, as seen by config saves.
        private static readonly Dictionary<string, List<object?>> WhileLocked = new(StringComparer.Ordinal);

        // Unlocked keys: the values their locks enforced.
        private static readonly Dictionary<string, List<object?>> Enforced = new(StringComparer.Ordinal);

        /// <summary>
        /// Records the effect of an admin config save: a key that stays locked adds the value the
        /// new configuration enforces, a key unlocked is remembered with every value its locks
        /// enforced, and a key locked again is no longer reported as unlocked but keeps the values
        /// of its earlier locks (a tab loaded under any of them can still post one back after the
        /// next unlock).
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
                    // A key locked again carries the values of its earlier locks into this one.
                    Enforced.Remove(key, out var earlier);
                    if (!UserSettingsRegistry.TryGet(key, out var descriptor))
                    {
                        continue;
                    }

                    if (!wasLocked.Contains(key, StringComparer.Ordinal) || !WhileLocked.TryGetValue(key, out var values))
                    {
                        values = earlier ?? new List<object?>();
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

        /// <summary>
        /// Copies what is recorded now. The plugin takes the copy with every configuration it puts
        /// in effect (<see cref="JellyfinEnhanced.ConfigurationSnapshot"/>), so a write checks the
        /// locks and the stale-tab guard against the same admin save, never a relock recorded in
        /// between.
        /// </summary>
        /// <returns>An unchanging copy of the unlocked keys and the values their locks enforced.</returns>
        public static Snapshot Capture()
        {
            lock (Sync)
            {
                return new Snapshot(Enforced.ToDictionary(pair => pair.Key, pair => pair.Value.ToArray(), StringComparer.Ordinal));
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

        /// <summary>The unlocked keys and the values their locks enforced, as recorded at one moment.</summary>
        public sealed class Snapshot
        {
            private readonly Dictionary<string, object?[]> _enforced;

            internal Snapshot(Dictionary<string, object?[]> enforced) => _enforced = enforced;

            /// <summary>Whether a value is one the lock on a key enforced before it was lifted.</summary>
            /// <param name="key">A canonical registry key.</param>
            /// <param name="value">The posted value.</param>
            /// <returns>True when the key was unlocked in this process, was not locked again, and one of its locks enforced the value.</returns>
            public bool WasEnforced(string key, object? value)
                => _enforced.TryGetValue(key, out var values) && Array.Exists(values, enforced => Equals(enforced, value));
        }
    }
}
