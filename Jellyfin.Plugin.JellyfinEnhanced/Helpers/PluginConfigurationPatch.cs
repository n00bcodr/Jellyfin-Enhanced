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
        // Patches are read-modify-write: one at a time.
        private static readonly object Gate = new object();

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
        /// <see cref="JellyfinEnhanced.UpdateConfiguration"/> (the same side effects as a full save).
        /// </summary>
        /// <param name="plugin">The plugin.</param>
        /// <param name="changes">Field (PluginConfiguration property name) → new value.</param>
        /// <param name="expected">Field → the value the caller read before editing it (optional per field).</param>
        /// <returns>The result.</returns>
        public static Result Apply(JellyfinEnhanced plugin, IReadOnlyDictionary<string, JsonElement> changes, IReadOnlyDictionary<string, JsonElement>? expected)
        {
            var options = JsonDefaults.Options;
            lock (Gate)
            {
                var current = plugin.Configuration;
                var properties = new Dictionary<string, PropertyInfo>(StringComparer.Ordinal);
                foreach (var key in changes.Keys)
                {
                    var property = typeof(PluginConfiguration).GetProperty(key, BindingFlags.Public | BindingFlags.Instance);
                    if (property == null || property.GetSetMethod() == null || property.GetIndexParameters().Length > 0)
                    {
                        return new Result { Error = $"Unknown configuration field '{key}'." };
                    }

                    properties[key] = property;
                }

                var conflicts = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
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

                if (conflicts.Count > 0) return new Result { Conflicts = conflicts };

                // A shallow copy keeps every field this request does not name (including ones the API never shows);
                // the named ones are replaced, never mutated, so the live configuration is untouched until the swap.
                var next = (PluginConfiguration)MemberwiseCloneMethod.Invoke(current, null)!;
                foreach (var (key, property) in properties)
                {
                    try
                    {
                        property.SetValue(next, changes[key].Deserialize(property.PropertyType, options));
                    }
                    catch (Exception ex) when (ex is JsonException or NotSupportedException or ArgumentException)
                    {
                        return new Result { Error = $"Invalid value for '{key}'." };
                    }
                }

                plugin.UpdateConfiguration(next);
                var saved = plugin.Configuration;
                var values = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
                foreach (var (key, property) in properties)
                {
                    values[key] = ToNode(property.GetValue(saved), property.PropertyType, options);
                }

                return new Result { Values = values };
            }
        }

        // Round-trips through text so values compare by their JSON, whatever node type produced them.
        private static JsonNode? ToNode(object? value, Type type, JsonSerializerOptions options)
            => JsonNode.Parse(JsonSerializer.Serialize(value, type, options));
    }
}
