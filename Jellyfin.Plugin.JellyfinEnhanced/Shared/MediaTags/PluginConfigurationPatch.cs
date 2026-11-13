using System;
using System.Collections.Generic;
using System.Reflection;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Extensions.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags
{
    /// <summary>
    /// Writes a few configuration fields on top of the configuration the server holds at that moment, so a page
    /// that saves field by field (the Media Tags tab) never writes back a stale copy of fields it did not change.
    /// Each changed field may carry the value the page read before it was edited; when the server's value has moved
    /// on since (another administrator saved it) and is not already the requested value, nothing is written and the
    /// fields are reported as conflicts with the server's value. Values use the JSON shape of the plugin
    /// configuration API (<c>GET /Plugins/{id}/Configuration</c>).
    /// </summary>
    public static class PluginConfigurationPatch
    {
        /// <summary>
        /// Whether a credential is never sent back to the page after a save. Every credential is: the Maintainerr
        /// key belongs to the Services tab's form now, not to a field of the Media Tags page
        /// (<see cref="MediaTagsPortable.IsSecret"/>).
        /// </summary>
        private static bool IsWriteOnly(string key) => MediaTagsPortable.IsSecret(key);

        /// <summary>
        /// The largest request body the patch endpoint reads. The page usually sends a few fields at a time; an
        /// imported settings document (<see cref="MediaTagsPortable"/>) sends every field it changes in one patch,
        /// with the values read before, so the import is written or refused as a whole.
        /// </summary>
        public const int MaxRequestBytes = 8 * 1024 * 1024;

        private static readonly MethodInfo MemberwiseCloneMethod = typeof(object).GetMethod("MemberwiseClone", BindingFlags.Instance | BindingFlags.NonPublic)!;

        /// <summary>The outcome of <see cref="Apply"/>.</summary>
        public sealed class Result
        {
            /// <summary>Gets a reason the request was refused (unknown field, bad value), or null.</summary>
            public string? Error { get; init; }

            /// <summary>Gets the changed fields whose server value moved on (field → the server's value); nothing was written.</summary>
            public Dictionary<string, JsonNode?> Conflicts { get; init; } = new(StringComparer.Ordinal);

            /// <summary>Gets the stored value of every changed field after the write (the server may normalise them).</summary>
            public Dictionary<string, JsonNode?> Values { get; init; } = new(StringComparer.Ordinal);
        }

        /// <summary>
        /// Applies <paramref name="changes"/> to the plugin's current configuration and saves it through
        /// the plugin's <c>UpdateConfiguration</c> (the same side effects as a full save, in the same critical section).
        /// </summary>
        /// <param name="plugin">The plugin.</param>
        /// <param name="changes">Field (PluginConfiguration property name) → new value.</param>
        /// <param name="expected">Field → the value the caller read before editing it (optional per field).</param>
        /// <param name="allowed">The fields the caller may write (<see cref="MediaTagsPageFields.Allowed"/>); any other refuses the request.</param>
        /// <returns>The result.</returns>
        public static Result Apply(JellyfinEnhanced plugin, IReadOnlyDictionary<string, JsonElement> changes, IReadOnlyDictionary<string, JsonElement>? expected, IReadOnlySet<string> allowed)
        {
            var options = JsonDefaults.Options;
            var properties = new Dictionary<string, PropertyInfo>(StringComparer.Ordinal);
            // Every name is checked before anything is read or written.
            foreach (var key in changes.Keys)
            {
                if (!allowed.Contains(key)) return new Result { Error = $"'{key}' is not a Media Tags setting; this endpoint saves only those." };
            }

            foreach (var key in changes.Keys)
            {
                var property = typeof(PluginConfiguration).GetProperty(key, BindingFlags.Public | BindingFlags.Instance);
                if (property == null || property.GetSetMethod() == null || property.GetIndexParameters().Length > 0)
                {
                    return new Result { Error = $"Unknown configuration field '{key}'." };
                }

                properties[key] = property;
            }

            // The values do not depend on the stored configuration: read them before taking the write lock.
            ItemOverrideMutation? itemMutation = null;
            var values = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var (key, property) in properties)
            {
                if (key == nameof(PluginConfiguration.TagLookItemOverrides) && changes[key].ValueKind == JsonValueKind.Object)
                {
                    if (!TryReadItemMutation(changes[key], property, out itemMutation))
                        return new Result { Error = "Invalid per-item mutation for 'TagLookItemOverrides'." };
                    continue;
                }

                if (!TryRead(property, changes[key], out var normalized, out var problem))
                {
                    return new Result { Error = problem == null ? $"Invalid value for '{key}'." : $"Invalid value for '{key}': {problem}." };
                }

                values[key] = normalized;
            }

            // The read, the conflict check and the swap happen inside the plugin's configuration write lock,
            // which every save takes (a full save from the main configuration page too): the copy is made from
            // the configuration as it is at that moment, never from one another save has replaced since.
            var conflicts = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
            var stored = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
            string? mutationError = null;
            plugin.UpdateConfiguration(
                current =>
                {
                    foreach (var (key, property) in properties)
                    {
                        if (key == nameof(PluginConfiguration.TagLookItemOverrides) && itemMutation != null) continue;
                        if (IsWriteOnly(key) || expected == null || !expected.TryGetValue(key, out var before)) continue;
                        var now = ToNode(property.GetValue(current), property.PropertyType, options);
                        if (!JsonNode.DeepEquals(now, JsonNode.Parse(before.GetRawText()))
                            && !JsonNode.DeepEquals(now, JsonNode.Parse(changes[key].GetRawText())))
                        {
                            conflicts[key] = now;
                        }
                    }

                    if (itemMutation != null)
                    {
                        var now = TagLookValidation.NormalizeItemOverrides(current.TagLookItemOverrides) ?? new List<TagLookItemOverride>();
                        var targets = itemMutation.Set!.Select(e => e.ItemId).Concat(itemMutation.Remove!).ToHashSet(StringComparer.Ordinal);
                        foreach (var id in targets)
                        {
                            var entry = now.Find(e => e.ItemId == id);
                            var desired = itemMutation.Set!.Find(e => e.ItemId == id);
                            var node = ToNode(entry, typeof(TagLookItemOverride), options);
                            if (!JsonNode.DeepEquals(node, JsonNode.Parse(itemMutation.Expected![id].GetRawText()))
                                && !JsonNode.DeepEquals(node, ToNode(desired, typeof(TagLookItemOverride), options)))
                            {
                                conflicts[nameof(PluginConfiguration.TagLookItemOverrides)] = ToNode(current.TagLookItemOverrides, typeof(List<TagLookItemOverride>), options);
                            }
                        }

                        var merged = now.Where(e => !targets.Contains(e.ItemId)).Concat(itemMutation.Set!).ToList();
                        if (merged.Count > TagLookValidation.MaxItemOverrides)
                        {
                            mutationError = "The item look list is full (500 entries). Remove an entry before adding one.";
                            return null;
                        }

                        if (targets.Count == 0)
                            stored[nameof(PluginConfiguration.TagLookItemOverrides)] = ToNode(current.TagLookItemOverrides, typeof(List<TagLookItemOverride>), options);
                        else
                            values[nameof(PluginConfiguration.TagLookItemOverrides)] = TagLookValidation.NormalizeItemOverrides(merged);
                    }

                    if (conflicts.Count > 0 || values.Count == 0) return null;

                    // A shallow copy keeps every field this request does not name (including ones the API never shows);
                    // the named ones are replaced, never mutated, so the live configuration is untouched until the swap.
                    var next = (PluginConfiguration)MemberwiseCloneMethod.Invoke(current, null)!;
                    foreach (var (key, value) in values) properties[key].SetValue(next, value);
                    return next;
                },
                // The stored values, as the save normalised them, before any later save.
                saved =>
                {
                    foreach (var (key, property) in properties) stored[key] = IsWriteOnly(key) ? JsonValue.Create(string.Empty) : ToNode(property.GetValue(saved), property.PropertyType, options);
                });
            if (mutationError != null) return new Result { Error = mutationError };
            if (conflicts.Count > 0) return new Result { Conflicts = conflicts };

            return new Result { Values = stored };
        }

        /// <summary>Atomic per-entry updates; Expected names every affected id (null means absent).</summary>
        public sealed class ItemOverrideMutation
        {
            public List<TagLookItemOverride>? Set { get; set; }
            public List<string>? Remove { get; set; }
            public Dictionary<string, JsonElement>? Expected { get; set; }
        }

        /// <summary>Validate a bounded item mutation before entering the configuration write lock.</summary>
        private static bool TryReadItemMutation(JsonElement raw, PropertyInfo property, out ItemOverrideMutation? mutation)
        {
            mutation = null;
            try
            {
                var read = raw.Deserialize<ItemOverrideMutation>(new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true });
                if (read?.Set == null || read.Remove == null || read.Expected == null || read.Set.Count + read.Remove.Count > TagLookValidation.MaxItemOverrides) return false;
                var ids = read.Set.Select(e => e?.ItemId).Concat(read.Remove).ToList();
                if (ids.Any(id => id == null || TagLookValidation.NormalizeItemId(id) != id) || ids.Distinct(StringComparer.Ordinal).Count() != ids.Count) return false;
                if (read.Expected.Count != ids.Count || ids.Any(id => !read.Expected.ContainsKey(id!))) return false;
                if (!TryRead(property, JsonSerializer.SerializeToElement(read.Set, JsonDefaults.Options), out var normalized, out _)) return false;
                read.Set = (List<TagLookItemOverride>?)normalized ?? new();
                mutation = read;
                return true;
            }
            catch (Exception ex) when (ex is JsonException or NotSupportedException or ArgumentException or InvalidOperationException)
            {
                return false;
            }
        }

        /// <summary>
        /// Reads one field's value in the configuration API's JSON shape and checks it against the field's contract
        /// (<see cref="MediaTagsPageFields.TryNormalize"/>): the same reading the patch applies to every changed field.
        /// </summary>
        /// <param name="property">The PluginConfiguration property.</param>
        /// <param name="value">The value as JSON.</param>
        /// <param name="normalized">The value to store.</param>
        /// <param name="error">Why the value was refused; null when it is not the property's type.</param>
        /// <returns>True when the value is accepted.</returns>
        public static bool TryRead(PropertyInfo property, JsonElement value, out object? normalized, out string? error)
        {
            normalized = null;
            error = null;
            object? read;
            try
            {
                read = value.Deserialize(property.PropertyType, JsonDefaults.Options);
            }
            catch (Exception ex) when (ex is JsonException or NotSupportedException or ArgumentException or InvalidOperationException)
            {
                return false;
            }

            // The field's own contract (ranges, known values, document normalisation, length).
            return MediaTagsPageFields.TryNormalize(property.Name, read, out normalized, out error);
        }

        /// <summary>A value as the configuration API's JSON (the shape the patch compares and returns).</summary>
        /// <param name="value">The value.</param>
        /// <param name="type">Its declared type.</param>
        /// <returns>The JSON node.</returns>
        public static JsonNode? ToJson(object? value, Type type) => ToNode(value, type, JsonDefaults.Options);

        // Round-trips through text so values compare by their JSON, whatever node type produced them.
        private static JsonNode? ToNode(object? value, Type type, JsonSerializerOptions options)
            => JsonNode.Parse(JsonSerializer.Serialize(value, type, options));
    }
}
