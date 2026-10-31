using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Extensions.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Writes a few configuration fields on top of the configuration the server holds at that moment, so a page
    /// that saves field by field (the Media Tags page) never writes back a stale copy of fields it did not change.
    /// Each changed field may carry the value the page read before it was edited; when the server's value has moved
    /// on since (another administrator saved it) and is not already the requested value, nothing is written and the
    /// fields are reported as conflicts with the server's value. Values use the JSON shape of the plugin
    /// configuration API (<c>GET /Plugins/{id}/Configuration</c>).
    /// </summary>
    public static class PluginConfigurationPatch
    {
        /// <summary>
        /// The largest request body the patch endpoint reads. The page usually sends a few fields at a time; an
        /// imported settings document (<see cref="MediaTagsPortable"/>) sends every field it changes in one patch,
        /// with the values read before, so the import is written or refused as a whole.
        /// </summary>
        public const int MaxRequestBytes = 256 * 1024;

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
            var values = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var (key, property) in properties)
            {
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
            plugin.UpdateConfiguration(
                current =>
                {
                    foreach (var (key, property) in properties)
                    {
                        if (expected == null || !expected.TryGetValue(key, out var before)) continue;
                        var now = ToNode(property.GetValue(current), property.PropertyType, options);
                        if (!JsonNode.DeepEquals(now, JsonNode.Parse(before.GetRawText()))
                            && !JsonNode.DeepEquals(now, JsonNode.Parse(changes[key].GetRawText())))
                        {
                            conflicts[key] = now;
                        }
                    }

                    if (conflicts.Count > 0) return null;

                    // A shallow copy keeps every field this request does not name (including ones the API never shows);
                    // the named ones are replaced, never mutated, so the live configuration is untouched until the swap.
                    var next = (PluginConfiguration)MemberwiseCloneMethod.Invoke(current, null)!;
                    foreach (var (key, property) in properties) property.SetValue(next, values[key]);
                    return next;
                },
                // The stored values, as the save normalised them, before any later save.
                saved =>
                {
                    foreach (var (key, property) in properties) stored[key] = ToNode(property.GetValue(saved), property.PropertyType, options);
                });
            if (conflicts.Count > 0) return new Result { Conflicts = conflicts };

            return new Result { Values = stored };
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
