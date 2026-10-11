using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>One key a settings write did not apply, and why.</summary>
    /// <param name="Key">The key as the caller sent it (canonical spelling when it is a registry key).</param>
    /// <param name="Reason">One of the <see cref="UserSettingsWriter"/> reason constants.</param>
    public sealed record SettingsRejection(string Key, string Reason);

    /// <summary>What a settings write did to the document it was given.</summary>
    public sealed class UserSettingsWriteResult
    {
        /// <summary>Gets the keys the write applied (set or made to follow the default).</summary>
        public List<string> Applied { get; } = new();

        /// <summary>Gets the keys the write refused, with the reason.</summary>
        public List<SettingsRejection> Rejected { get; } = new();

        /// <summary>Gets the stored values that changed, as "Key: old → new" (for the log).</summary>
        public List<string> Changes { get; } = new();

        /// <summary>Gets or sets a value indicating whether the document (values or provenance) changed and must be saved.</summary>
        public bool Changed { get; set; }
    }

    /// <summary>
    /// Key-level writes to a user's settings.json document, applied in place inside the caller's
    /// per-file read-modify-write. Provenance ("_je") always comes from the stored document, never
    /// from the request. Both routes first refresh the cached values of Following keys to the
    /// current admin defaults, so the file stays complete and close to what an older JE would need.
    /// </summary>
    public static class UserSettingsWriter
    {
        /// <summary>Not a registry key (also IsAdmin, LastOpenedTab and client-only keys).</summary>
        public const string ReasonUnknown = "unknown";

        /// <summary>The value has the wrong type or breaks the key's Min/Max, Choices, Pattern or MaxLength; or the key cannot follow a default.</summary>
        public const string ReasonInvalid = "invalid";

        /// <summary>An admin lock forces the key.</summary>
        public const string ReasonLocked = "locked";

        /// <summary>Whole-document POST: the key follows the admin default and only /patch can change that.</summary>
        public const string ReasonFollowing = "following";

        /// <summary>Whole-document POST: the value is the one a lock enforced until it was lifted, from a tab that loaded while it was locked.</summary>
        public const string ReasonStale = "stale";

        /// <summary>
        /// Applies a key-level patch. A Set key is validated and becomes Chosen (marked ChangedByAdmin
        /// when an admin writes it for another user); a Follow key takes the current admin default and
        /// becomes Following. Unknown, invalid and locked keys are rejected one by one; the others apply.
        /// A key in both Set and Follow ends up Following.
        /// </summary>
        /// <param name="document">The stored document; changed in place.</param>
        /// <param name="config">The plugin configuration, or null when it is not loaded (Follow is then rejected).</param>
        /// <param name="set">Keys and values to set.</param>
        /// <param name="follow">Keys to make follow the admin default.</param>
        /// <param name="byOwner">False when an administrator writes another user's settings.</param>
        /// <param name="utcNow">The time recorded in the provenance block.</param>
        /// <returns>What was applied and rejected.</returns>
        public static UserSettingsWriteResult ApplyPatch(UserSettings document, PluginConfiguration? config, IEnumerable<KeyValuePair<string, JsonElement>> set, IEnumerable<string> follow, bool byOwner, DateTime utcNow)
        {
            ArgumentNullException.ThrowIfNull(document);
            ArgumentNullException.ThrowIfNull(set);
            ArgumentNullException.ThrowIfNull(follow);
            var result = new UserSettingsWriteResult();
            var resolved = UserSettingsResolver.Resolve(document, config);
            var meta = resolved.Meta;
            var metaChanged = RefreshFollowing(document, resolved, result);

            foreach (var (name, descriptor, value) in LastValuePerKey(set))
            {
                if (descriptor == null)
                {
                    result.Rejected.Add(new SettingsRejection(name, ReasonUnknown));
                    continue;
                }

                // Incidental keys (a Set equal to the current default goes back to Following) are a later step.
                if (!UserSettingsRegistry.TryValidate(descriptor, value, out var coerced))
                {
                    result.Rejected.Add(new SettingsRejection(descriptor.Key, ReasonInvalid));
                    continue;
                }

                if (resolved.IsLocked(descriptor.Key))
                {
                    result.Rejected.Add(new SettingsRejection(descriptor.Key, ReasonLocked));
                    continue;
                }

                Store(document, descriptor, coerced, result);
                metaChanged |= MakeChosen(meta, descriptor.Key, byOwner);
                result.Applied.Add(descriptor.Key);
            }

            foreach (var name in follow.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (!UserSettingsRegistry.TryGet(name, out var descriptor))
                {
                    result.Rejected.Add(new SettingsRejection(name, ReasonUnknown));
                    continue;
                }

                if (descriptor.AdminProperty == null || resolved.Defaults == null)
                {
                    result.Rejected.Add(new SettingsRejection(descriptor.Key, ReasonInvalid));
                    continue;
                }

                if (resolved.IsLocked(descriptor.Key))
                {
                    result.Rejected.Add(new SettingsRejection(descriptor.Key, ReasonLocked));
                    continue;
                }

                Store(document, descriptor, descriptor.Property.GetValue(resolved.Defaults), result);
                metaChanged |= MakeFollowing(meta, descriptor.Key);
                result.Applied.Remove(descriptor.Key);
                result.Applied.Add(descriptor.Key);
            }

            Finish(document, meta, metaChanged, utcNow, result);
            return result;
        }

        /// <summary>
        /// Applies a whole (or partial) settings document from the legacy POST. Only registry keys
        /// present in the body count, matched ignoring case; absent keys stay as stored, and IsAdmin,
        /// the provenance block and every other non-registry key are ignored. A value equal to the
        /// current resolved value changes nothing, so re-posting a loaded document never turns
        /// defaults into choices. Otherwise locked and Following keys are refused (Following keys
        /// change only through /patch), invalid values are refused, and any other value is stored
        /// and becomes Chosen.
        /// </summary>
        /// <param name="document">The stored document; changed in place.</param>
        /// <param name="config">The plugin configuration, or null when it is not loaded.</param>
        /// <param name="body">The posted JSON object.</param>
        /// <param name="byOwner">False when an administrator writes another user's settings.</param>
        /// <param name="utcNow">The time recorded in the provenance block.</param>
        /// <returns>What was applied and rejected.</returns>
        public static UserSettingsWriteResult ApplyDocument(UserSettings document, PluginConfiguration? config, JsonElement body, bool byOwner, DateTime utcNow)
        {
            ArgumentNullException.ThrowIfNull(document);
            if (body.ValueKind != JsonValueKind.Object)
            {
                throw new ArgumentException("The settings document must be a JSON object.", nameof(body));
            }

            var result = new UserSettingsWriteResult();
            var resolved = UserSettingsResolver.Resolve(document, config);
            var meta = resolved.Meta;
            var metaChanged = RefreshFollowing(document, resolved, result);

            foreach (var (_, descriptor, value) in LastValuePerKey(body.EnumerateObject().Select(property => new KeyValuePair<string, JsonElement>(property.Name, property.Value))))
            {
                if (descriptor == null)
                {
                    continue;
                }

                var valid = UserSettingsRegistry.TryValidate(descriptor, value, out var coerced);
                if (valid && Equals(coerced, descriptor.Property.GetValue(resolved.Values)))
                {
                    continue;
                }

                var reason = resolved.IsLocked(descriptor.Key) ? ReasonLocked
                    : resolved.IsFollowing(descriptor.Key) ? ReasonFollowing
                    : IsStaleUnlockedValue(descriptor, coerced, document) ? ReasonStale
                    : !valid ? ReasonInvalid
                    : null;
                if (reason != null)
                {
                    result.Rejected.Add(new SettingsRejection(descriptor.Key, reason));
                    continue;
                }

                Store(document, descriptor, coerced, result);
                metaChanged |= MakeChosen(meta, descriptor.Key, byOwner);
                result.Applied.Add(descriptor.Key);
            }

            Finish(document, meta, metaChanged, utcNow, result);
            return result;
        }

        /// <summary>
        /// The posted entries with registry keys matched ignoring case: each registry key once, in the
        /// order it first appears, with the last value posted for it (as the typed read takes the last
        /// duplicate). Non-registry names come through as they are, with no descriptor.
        /// </summary>
        private static List<(string Name, UserSettingDescriptor? Descriptor, JsonElement Value)> LastValuePerKey(IEnumerable<KeyValuePair<string, JsonElement>> entries)
        {
            var list = new List<(string Name, UserSettingDescriptor? Descriptor, JsonElement Value)>();
            var index = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var (name, value) in entries)
            {
                if (!UserSettingsRegistry.TryGet(name, out var descriptor))
                {
                    list.Add((name, null, value));
                }
                else if (index.TryGetValue(descriptor.Key, out var at))
                {
                    list[at] = (descriptor.Key, descriptor, value);
                }
                else
                {
                    index[descriptor.Key] = list.Count;
                    list.Add((descriptor.Key, descriptor, value));
                }
            }

            return list;
        }

        /// <summary>
        /// Whether a whole-document post carries a value a lock enforced until an admin lifted it in
        /// this process (a tab that loaded while the key was locked) over a different stored choice.
        /// </summary>
        private static bool IsStaleUnlockedValue(UserSettingDescriptor descriptor, object? posted, UserSettings stored)
            => RecentlyUnlockedSettings.WasEnforced(descriptor.Key, posted)
                && !Equals(posted, descriptor.Property.GetValue(stored));

        /// <summary>Re-caches every Following key's stored value as its current resolved value.</summary>
        private static bool RefreshFollowing(UserSettings document, ResolvedUserSettings resolved, UserSettingsWriteResult result)
        {
            foreach (var key in resolved.Meta.Following)
            {
                if (resolved.Defaults != null && UserSettingsRegistry.TryGet(key, out var descriptor))
                {
                    Store(document, descriptor, descriptor.Property.GetValue(resolved.Values), result);
                }
            }

            // A block that differs from its normalised form (stray or misspelt keys) is rewritten clean.
            return document.Meta != null && !SameMeta(document.Meta, resolved.Meta);
        }

        private static void Store(UserSettings document, UserSettingDescriptor descriptor, object? value, UserSettingsWriteResult result)
        {
            var old = descriptor.Property.GetValue(document);
            if (Equals(old, value))
            {
                return;
            }

            descriptor.Property.SetValue(document, value);
            result.Changes.Add($"{descriptor.Key}: {Describe(old)} → {Describe(value)}");
            result.Changed = true;
        }

        private static bool MakeChosen(UserSettingsMeta meta, string key, bool byOwner)
        {
            var changed = meta.Following.Remove(key);
            if (!meta.Chosen.Contains(key))
            {
                meta.Chosen.Add(key);
                changed = true;
            }

            if (byOwner)
            {
                changed |= meta.ChangedByAdmin.Remove(key);
            }
            else if (!meta.ChangedByAdmin.Contains(key))
            {
                meta.ChangedByAdmin.Add(key);
                changed = true;
            }

            return changed;
        }

        private static bool MakeFollowing(UserSettingsMeta meta, string key)
        {
            var changed = meta.Chosen.Remove(key);
            changed |= meta.ChangedByAdmin.Remove(key);
            if (!meta.Following.Contains(key))
            {
                meta.Following.Add(key);
                changed = true;
            }

            return changed;
        }

        private static void Finish(UserSettings document, UserSettingsMeta meta, bool metaChanged, DateTime utcNow, UserSettingsWriteResult result)
        {
            if (!metaChanged)
            {
                return;
            }

            meta.Schema = UserSettingsMeta.CurrentSchema;
            meta.Updated = utcNow;
            document.Meta = UserSettingsResolver.Normalize(meta);
            result.Changed = true;
        }

        // The stored block can carry explicit nulls ("Following": null overrides the initializer); a
        // null list is never the same as the normalised one, so the block is rewritten clean.
        private static bool SameMeta(UserSettingsMeta a, UserSettingsMeta b)
            => a.Schema == b.Schema
                && a.Following is { } following && following.SequenceEqual(b.Following, StringComparer.Ordinal)
                && a.Chosen is { } chosen && chosen.SequenceEqual(b.Chosen, StringComparer.Ordinal)
                && a.ChangedByAdmin is { } changedByAdmin && changedByAdmin.SequenceEqual(b.ChangedByAdmin, StringComparer.Ordinal);

        private static string Describe(object? value) => value switch
        {
            null => "null",
            bool flag => flag ? "true" : "false",
            _ => value.ToString() ?? string.Empty,
        };
    }
}
