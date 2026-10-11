using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// The keys an administrator unlocked while this process ran, each with the value its lock
    /// enforced. A browser tab that loaded while a key was locked still holds that enforced value
    /// and an older bundle posts it back with every whole-document save; the legacy POST refuses
    /// such a value when it differs from the user's stored choice (reason "stale"), so the unlock
    /// gives the user's own choice back instead of overwriting it. In memory only, like the file
    /// locks: a restart forgets it (tabs from before a restart reload their settings anyway).
    /// </summary>
    public static class RecentlyUnlockedSettings
    {
        private static readonly ConcurrentDictionary<string, object?> Enforced = new(StringComparer.Ordinal);

        /// <summary>
        /// Records the effect of an admin config save: every key locked before and not after is
        /// remembered with the value the old lock enforced; a key locked again is forgotten.
        /// </summary>
        /// <param name="before">The configuration being replaced, or null on first load.</param>
        /// <param name="after">The configuration now in effect.</param>
        public static void Record(PluginConfiguration? before, PluginConfiguration? after)
        {
            var nowLocked = UserSettingsResolver.LockedKeys(after);
            foreach (var key in nowLocked)
            {
                Enforced.TryRemove(key, out _);
            }

            if (before == null)
            {
                return;
            }

            var unlocked = UserSettingsResolver.LockedKeys(before).Except(nowLocked, StringComparer.Ordinal).ToArray();
            if (unlocked.Length == 0)
            {
                return;
            }

            var enforcedDefaults = UserSettingsRegistry.BuildDefaults(before);
            foreach (var key in unlocked)
            {
                if (UserSettingsRegistry.TryGet(key, out var descriptor))
                {
                    Enforced[key] = descriptor.Property.GetValue(enforcedDefaults);
                }
            }
        }

        /// <summary>Gets the value the lock on a key enforced before it was lifted.</summary>
        /// <param name="key">A canonical registry key.</param>
        /// <param name="value">The enforced value when the key was unlocked in this process.</param>
        /// <returns>True when the key was unlocked in this process and is not locked again.</returns>
        public static bool TryGetEnforcedValue(string key, out object? value) => Enforced.TryGetValue(key, out value);

        /// <summary>Gets the recorded keys (for tests and diagnostics).</summary>
        public static IReadOnlyCollection<string> Keys => Enforced.Keys.ToArray();

        /// <summary>Forgets every recorded key (tests).</summary>
        internal static void Clear() => Enforced.Clear();
    }
}
