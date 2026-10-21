using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// A configuration page save as the changes the administrator made on the page: the fields they changed (by name) and,
    /// for the Sonarr and Radarr instance lists, the instances they added or removed and the instance fields they changed
    /// (by instance id). The server applies it to the configuration it holds at that moment, so a setting another
    /// administrator, tab or server write changed since the page read it keeps that value unless this page changed it too.
    /// </summary>
    public sealed class ConfigurationPatch
    {
        /// <summary>Fields to set: configuration property name → new value.</summary>
        public Dictionary<string, JsonElement>? Set { get; set; }

        /// <summary>Instance list operations: "SonarrInstances" / "RadarrInstances" → operations.</summary>
        public Dictionary<string, InstanceListPatch>? Instances { get; set; }
    }

    /// <summary>Operations on one instance list, applied in this order: reset, remove, change, add.</summary>
    public sealed class InstanceListPatch
    {
        /// <summary>
        /// The administrator confirmed replacing a stored list the server can't read (its instances can't be recovered): the
        /// list starts empty, then the additions apply. Skipped (and reported) when the stored list is readable by then, for
        /// example because another administrator repaired it; nothing of this list's operations is applied then.
        /// </summary>
        public bool ResetUnreadable { get; set; }

        /// <summary>Instances to append (each with its Id).</summary>
        public List<JsonElement>? Add { get; set; }

        /// <summary>Ids of instances to remove.</summary>
        public List<string>? Remove { get; set; }

        /// <summary>Field changes of existing instances.</summary>
        public List<InstanceChange>? Change { get; set; }
    }

    /// <summary>The fields of one instance to set: "Field" or "Object.Field" (e.g. "Defaults.QualityProfileId") → value.</summary>
    public sealed class InstanceChange
    {
        /// <summary>The instance's Id.</summary>
        public string? Id { get; set; }

        /// <summary>Field path → new value.</summary>
        public Dictionary<string, JsonElement>? Set { get; set; }
    }

    /// <summary>What a patch did.</summary>
    public sealed class ConfigurationPatchResult
    {
        /// <summary>Fields set ("Field", or "RadarrInstances[id].Field" and the like).</summary>
        public List<string> Applied { get; } = new();

        /// <summary>Fields the patch named that a patch can't set (unknown, server-minted or derived): left as stored.</summary>
        public List<string> Ignored { get; } = new();

        /// <summary>
        /// Instance operations that no longer fit the stored list: a change or removal of an instance that is gone, an
        /// addition whose Id is already there. Nothing of them was applied.
        /// </summary>
        public List<string> Skipped { get; } = new();
    }

    /// <summary>A patch that can't be applied: a value of the wrong type, or an instance list the server can't read.</summary>
    /// <summary>
    /// A whole configuration (Jellyfin's plugin-configuration route) built on an earlier generation than the one stored: it is
    /// refused, nothing is written (see <see cref="PluginConfiguration.ConfigurationGeneration"/>).
    /// </summary>
    public sealed class ConfigurationConflictException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public ConfigurationConflictException(long sent, long current)
            : base($"The Jellyfin Enhanced configuration has changed since this copy was read (generation {sent}, now {current}), so it was not saved. Read it again and make the change to what it holds now.")
        {
            Sent = sent;
            Current = current;
        }

        /// <summary>The generation the refused configuration was built on.</summary>
        public long Sent { get; }

        /// <summary>The generation stored now.</summary>
        public long Current { get; }
    }

    public sealed class ConfigurationPatchException : Exception
    {
        /// <summary>Creates the exception.</summary>
        public ConfigurationPatchException(string field, string message) : base(message)
        {
            Field = field;
        }

        /// <summary>The field the patch could not apply.</summary>
        public string Field { get; }
    }

    /// <summary>Applies a <see cref="ConfigurationPatch"/> to a copy of the stored configuration.</summary>
    internal static class ConfigurationPatcher
    {
        /// <summary>The instance lists, which a patch changes only through instance operations.</summary>
        internal static readonly string[] InstanceLists = { nameof(PluginConfiguration.SonarrInstances), nameof(PluginConfiguration.RadarrInstances) };

        // Server-minted (analytics identity and bookkeeping, the page's old read marker) or derived from the instance lists
        // (the first instance's address, key and mappings, kept for older readers): never set by a patch.
        private static readonly HashSet<string> NotSettable = new(StringComparer.Ordinal)
        {
            nameof(PluginConfiguration.AnalyticsInstallId), nameof(PluginConfiguration.AnalyticsInstallSecret),
            nameof(PluginConfiguration.AnalyticsLastReportedAt), nameof(PluginConfiguration.AnalyticsLastPayloadJson),
            nameof(PluginConfiguration.AnalyticsLastReportedPluginVersion), nameof(PluginConfiguration.AnalyticsLastReportedJellyfinTarget),
            nameof(PluginConfiguration.AnalyticsLastReportedJellyfinVersion), nameof(PluginConfiguration.AnalyticsForbiddenSinceLastSuccess),
            nameof(PluginConfiguration.ArrServerOwnedSeen), nameof(PluginConfiguration.ConfigurationGeneration),
            nameof(PluginConfiguration.SonarrInstances), nameof(PluginConfiguration.RadarrInstances),
            nameof(PluginConfiguration.SonarrUrl), nameof(PluginConfiguration.SonarrApiKey), nameof(PluginConfiguration.SonarrUrlMappings),
            nameof(PluginConfiguration.RadarrUrl), nameof(PluginConfiguration.RadarrApiKey), nameof(PluginConfiguration.RadarrUrlMappings),
        };

        // What Jellyfin's configuration route reads a posted configuration with (property names as declared).
        private static readonly JsonSerializerOptions ReadOptions = new() { NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.AllowReadingFromString };

        // The instance lists are stored as the page wrote them (JSON.stringify): no escaping beyond what JSON needs.
        private static readonly JsonSerializerOptions ListWriteOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

        /// <summary>A copy of <paramref name="config"/> as Jellyfin's configuration route would read it back.</summary>
        internal static PluginConfiguration Clone(PluginConfiguration config)
            => JsonSerializer.Deserialize<PluginConfiguration>(JsonSerializer.SerializeToUtf8Bytes(config), ReadOptions) ?? new PluginConfiguration();

        /// <summary>
        /// Applies <paramref name="patch"/> to <paramref name="target"/> (a copy of the stored configuration). Throws
        /// <see cref="ConfigurationPatchException"/> before changing anything the caller keeps when a value can't be read.
        /// </summary>
        internal static ConfigurationPatchResult Apply(PluginConfiguration target, ConfigurationPatch? patch)
        {
            var result = new ConfigurationPatchResult();
            if (patch == null) return result;
            foreach (var (name, value) in patch.Set ?? new Dictionary<string, JsonElement>())
            {
                var property = NotSettable.Contains(name) ? null : typeof(PluginConfiguration).GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                if (property == null || property.GetSetMethod() == null || property.GetGetMethod() == null || property.GetIndexParameters().Length > 0)
                {
                    result.Ignored.Add(name);
                    continue;
                }

                object? read;
                try
                {
                    read = value.Deserialize(property.PropertyType, ReadOptions);
                }
                catch (Exception ex) when (ex is JsonException or NotSupportedException or InvalidOperationException)
                {
                    throw new ConfigurationPatchException(name, $"{name} can't be read as {property.PropertyType.Name}.");
                }

                if (read == null && property.PropertyType.IsValueType && Nullable.GetUnderlyingType(property.PropertyType) == null)
                {
                    throw new ConfigurationPatchException(name, $"{name} needs a value.");
                }

                property.SetValue(target, read);
                result.Applied.Add(name);
            }

            foreach (var (list, operations) in patch.Instances ?? new Dictionary<string, InstanceListPatch>())
            {
                if (!InstanceLists.Contains(list, StringComparer.Ordinal) || operations == null)
                {
                    result.Ignored.Add(list);
                    continue;
                }

                ApplyInstanceOperations(target, list, operations, result);
            }

            return result;
        }

        private static void ApplyInstanceOperations(PluginConfiguration target, string list, InstanceListPatch operations, ConfigurationPatchResult result)
        {
            var sonarr = list == nameof(PluginConfiguration.SonarrInstances);
            var stored = sonarr ? target.SonarrInstances : target.RadarrInstances;
            JsonArray? readable;
            try
            {
                readable = JsonNode.Parse(string.IsNullOrWhiteSpace(stored) ? "[]" : stored) as JsonArray;
            }
            catch (JsonException)
            {
                readable = null;
            }

            var changed = false;
            JsonArray instances;
            if (operations.ResetUnreadable)
            {
                if (readable != null)
                {
                    result.Skipped.Add($"{list} reset (the stored list is readable)");
                    return;
                }

                instances = new JsonArray();
                result.Applied.Add($"{list} reset");
                changed = true;
            }
            else
            {
                instances = readable ?? throw new ConfigurationPatchException(list, $"The stored {list} can't be read; fix or clear it before changing instances.");
            }

            foreach (var id in operations.Remove ?? new List<string>())
            {
                var index = IndexOf(instances, id);
                if (index < 0)
                {
                    result.Skipped.Add($"{list}[{id}] remove");
                    continue;
                }

                instances.RemoveAt(index);
                result.Applied.Add($"{list}[{id}] removed");
                changed = true;
            }

            foreach (var change in operations.Change ?? new List<InstanceChange>())
            {
                var index = IndexOf(instances, change?.Id);
                if (change == null || index < 0)
                {
                    result.Skipped.Add($"{list}[{change?.Id}] change");
                    continue;
                }

                var instance = (JsonObject)instances[index]!;
                foreach (var (path, value) in change.Set ?? new Dictionary<string, JsonElement>())
                {
                    var parts = path.Split('.');
                    if (parts.Length > 2 || parts.Any(string.IsNullOrEmpty) || (parts.Length == 1 && path == "Id"))
                    {
                        result.Ignored.Add($"{list}[{change.Id}].{path}");
                        continue;
                    }

                    var node = JsonNode.Parse(value.GetRawText());
                    if (parts.Length == 1)
                    {
                        instance[path] = node;
                    }
                    else
                    {
                        if (instance[parts[0]] is not JsonObject parent)
                        {
                            parent = new JsonObject();
                            instance[parts[0]] = parent;
                        }

                        parent[parts[1]] = node;
                    }

                    result.Applied.Add($"{list}[{change.Id}].{path}");
                    changed = true;
                }
            }

            foreach (var added in operations.Add ?? new List<JsonElement>())
            {
                if (added.ValueKind != JsonValueKind.Object)
                {
                    throw new ConfigurationPatchException(list, $"An instance added to {list} must be an object.");
                }

                var instance = (JsonObject)JsonNode.Parse(added.GetRawText())!;
                var id = Text(instance["Id"]);
                if (string.IsNullOrEmpty(id) || IndexOf(instances, id) >= 0)
                {
                    result.Skipped.Add($"{list}[{id}] add");
                    continue;
                }

                instances.Add(instance);
                result.Applied.Add($"{list}[{id}] added");
                changed = true;
            }

            if (!changed) return;
            var json = instances.ToJsonString(ListWriteOptions);
            // The first instance is also kept in the single-instance fields older readers use.
            var first = instances.FirstOrDefault() as JsonObject;
            if (sonarr)
            {
                target.SonarrInstances = json;
                target.SonarrUrl = Text(first?["Url"]);
                target.SonarrApiKey = Text(first?["ApiKey"]);
                target.SonarrUrlMappings = Text(first?["UrlMappings"]);
            }
            else
            {
                target.RadarrInstances = json;
                target.RadarrUrl = Text(first?["Url"]);
                target.RadarrApiKey = Text(first?["ApiKey"]);
                target.RadarrUrlMappings = Text(first?["UrlMappings"]);
            }
        }

        private static int IndexOf(JsonArray instances, string? id)
        {
            if (string.IsNullOrEmpty(id)) return -1;
            for (var i = 0; i < instances.Count; i++)
            {
                if (instances[i] is JsonObject o && string.Equals(Text(o["Id"]), id, StringComparison.OrdinalIgnoreCase)) return i;
            }

            return -1;
        }

        private static string Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : string.Empty;
    }
}
