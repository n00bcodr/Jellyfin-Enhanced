using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Settings;

/// <summary>
/// Update the authoritative typed fields while retaining raw extension members of retained objects.
/// Nulls replace, dictionaries take the new key set, and object lists match domain identities, never positions.
/// </summary>
internal static class SettingsDocumentPatch
{
    public static JObject Apply(JObject stored, JellyfinEnhancedUserSettings settings)
        => (JObject)Merge(stored, JObject.Parse(JsonSerializer.Serialize(settings)), typeof(JellyfinEnhancedUserSettings));

    private static JToken Merge(JToken? stored, JToken patch, Type type, string? slotLayout = null)
    {
        if (patch is not JObject && patch is not JArray) return patch.DeepClone();
        var contract = JsonSerializerOptions.Default.GetTypeInfo(type);
        if (contract.Kind == JsonTypeInfoKind.Dictionary)
        {
            // This is a set of item overrides, not a record with extension properties.
            if (type != typeof(Dictionary<string, TagLayoutLock>))
                throw new InvalidDataException($"Settings dictionary {type.Name} requires an explicit key policy.");
            var candidates = LockOrigins(stored as JObject);
            var result = new JObject();
            foreach (var field in ((JObject)patch).Properties())
            {
                candidates.TryGetValue(field.Name, out var previous);
                result[field.Name] = Merge(previous, field.Value, typeof(TagLayoutLock));
            }
            return result;
        }
        if (contract.Kind == JsonTypeInfoKind.Enumerable)
        {
            var element = type.IsArray ? type.GetElementType()! : type.GetGenericArguments().Single();
            if (JsonSerializerOptions.Default.GetTypeInfo(element).Kind != JsonTypeInfoKind.Object) return patch.DeepClone();
            // A new structured list needs a deliberate identity policy; silently zipping by index loses or moves data.
            if (element != typeof(TagLookRule) && element != typeof(TagLayoutGroupSlot) && element != typeof(TagLookCondition))
                throw new InvalidDataException($"Settings list {element.Name} requires an explicit identity policy.");
            var candidates = ListOrigins(stored as JArray, element, slotLayout);
            var result = new JArray();
            foreach (var item in (JArray)patch)
            {
                var key = Identity(item, element);
                var index = key == null ? -1 : candidates.FindIndex(candidate => candidate.Key == key);
                var previous = index < 0 ? null : candidates[index].Raw;
                if (index >= 0) candidates.RemoveAt(index);
                result.Add(Merge(previous, item, element));
            }
            return result;
        }
        if (contract.Kind != JsonTypeInfoKind.Object || patch is not JObject fields)
            throw new InvalidDataException($"Unsupported settings structure {type.Name}.");

        if (stored is JObject layoutOwner)
        {
            if (type == typeof(TagLookRule) || type == typeof(TagLayoutLock))
                slotLayout = TagLayoutRules.NormalizeLayout(Text(layoutOwner, "Layout"));
            else if (type == typeof(TagShapeLook))
                slotLayout = TagShapeRules.NormalizeLook(Read<TagShapeLook>(layoutOwner))?.Layout;
        }
        var merged = stored is JObject document ? (JObject)document.DeepClone() : new JObject();
        foreach (var field in fields.Properties())
        {
            var property = contract.Properties.Single(p => p.Name == field.Name);
            var previous = Member(merged, field.Name);
            var context = type == typeof(TagLayoutProfiles) ? field.Name.ToLowerInvariant() : slotLayout;
            var value = Merge(previous, field.Value, property.PropertyType, context);
            foreach (var alias in merged.Properties().Where(p => string.Equals(p.Name, field.Name, StringComparison.OrdinalIgnoreCase)).ToArray()) alias.Remove();
            merged[field.Name] = value;
        }
        return merged;
    }

    private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNameCaseInsensitive = true };

    private static T Read<T>(JObject value) where T : class
        => JsonSerializer.Deserialize<T>(value.ToString(), ReadOptions) ?? throw new InvalidDataException("Invalid settings object.");

    private sealed record Origin(string? Key, JObject Raw);

    private static List<Origin> ListOrigins(JArray? stored, Type element, string? layout)
    {
        var result = new List<Origin>();
        var raw = stored?.OfType<JObject>().ToList() ?? [];
        if (element == typeof(TagLookRule))
        {
            var sources = raw.ToDictionary(Read<TagLookRule>, value => value);
            TagLookValidation.NormalizeRules(sources.Keys, (source, normalized) => result.Add(new(normalized.Id, sources[source])));
        }
        else if (element == typeof(TagLayoutGroupSlot))
        {
            var sources = raw.ToDictionary(Read<TagLayoutGroupSlot>, value => value);
            TagShapeRules.NormalizeSlots(layout, sources.Keys.ToList(), (source, normalized) => result.Add(new(normalized.Group, sources[source])));
        }
        else
        {
            foreach (var value in raw) result.Add(new(Identity(value, element), value));
        }
        return result;
    }

    private static Dictionary<string, JObject> LockOrigins(JObject? stored)
    {
        var sources = new Dictionary<TagLayoutLock, JObject>();
        var locks = new Dictionary<string, TagLayoutLock?>();
        foreach (var field in stored?.Properties() ?? [])
        {
            if (field.Value is not JObject raw) continue;
            var value = Read<TagLayoutLock>(raw);
            locks[field.Name] = value;
            sources[value] = raw;
        }
        var origins = new Dictionary<TagLayoutLock, JObject>();
        var normalized = TagLookValidation.NormalizeLocks(locks, (source, result) => origins[result] = sources[source])!;
        return normalized.ToDictionary(pair => pair.Key, pair => origins[pair.Value]);
    }

    // System.Text.Json's case-insensitive projection uses the last matching property.
    private static JToken? Member(JObject value, string name)
        => value.Properties().LastOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase))?.Value;

    private static string? Text(JObject value, string name)
        => Member(value, name) is JValue { Type: JTokenType.String } text ? text.Value<string>() : null;

    private static string? Identity(JToken value, Type element)
    {
        if (value is not JObject item) return null;
        if (element == typeof(TagLookRule)) return Text(item, nameof(TagLookRule.Id))?.Trim();
        if (element == typeof(TagLayoutGroupSlot)) return TagLayoutRules.NormalizeGroup(Text(item, nameof(TagLayoutGroupSlot.Group)));
        var condition = TagLookValidation.NormalizeCondition(new TagLookCondition
        {
            Field = Text(item, nameof(TagLookCondition.Field)) ?? string.Empty,
            Value = Text(item, nameof(TagLookCondition.Value)) ?? string.Empty,
        });
        return condition == null ? null : JsonSerializer.Serialize(new[] { condition.Field, condition.Value.ToUpperInvariant() });
    }
}
