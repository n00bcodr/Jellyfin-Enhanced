using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Settings;

/// <summary>Revision and content always come from the same locked store snapshot.</summary>
public sealed class SettingsDocumentService(UserConfigurationManager store)
{
    public RevisionedSettingsResponse Read(string userId, Func<JellyfinEnhancedUserSettings> defaults, bool isAdmin)
    {
        var snapshot = store.ReadUserConfigurationDocument(userId, "settings.json");
        if (!snapshot.Exists)
            store.TryUpdateUserConfigurationDocument(userId, "settings.json", snapshot.Revision,
                _ => JObject.Parse(JsonSerializer.Serialize(defaults())), out snapshot);
        return Project(snapshot, isAdmin);
    }

    public bool TrySave(string userId, RevisionedSettingsRequest request, bool isAdmin, out RevisionedSettingsResponse? response)
    {
        var saved = store.TryUpdateUserConfigurationDocument(userId, "settings.json", request.Revision, raw =>
        {
            if (raw is not JObject document) throw new InvalidDataException("Settings must be an object.");
            // Validate existing known fields before touching the document; corruption is not a reset.
            Project(new UserConfigurationDocument(document, request.Revision), isAdmin);
            var merged = SettingsDocumentPatch.Apply(document, request.Settings);
            foreach (var field in merged.Properties().Where(p => string.Equals(p.Name, "IsAdmin", StringComparison.OrdinalIgnoreCase)).ToArray()) field.Remove();
            return merged;
        }, out var result);
        response = saved ? Project(result, isAdmin) : null;
        return saved;
    }

    private static readonly HashSet<string> NonNullableValueFields = typeof(BootstrapSettings).GetProperties()
        .Where(p => p.PropertyType.IsValueType && Nullable.GetUnderlyingType(p.PropertyType) == null)
        .Select(p => p.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static RevisionedSettingsResponse Project(UserConfigurationDocument snapshot, bool isAdmin)
    {
        if (snapshot.Document is not JObject document) throw new InvalidDataException("Settings must be an object.");
        var node = System.Text.Json.Nodes.JsonNode.Parse(document.ToString())!.AsObject();
        foreach (var key in node.Select(p => p.Key).Where(k => string.Equals(k, "IsAdmin", StringComparison.OrdinalIgnoreCase)).ToArray()) node.Remove(key);
        node["IsAdmin"] = isAdmin;
        // JE 11.9 stored null in switches that are now bool. Read such a null as the property's
        // default, as the reader this replaced did; the stored document itself is not changed.
        foreach (var key in node.Where(p => p.Value is null && NonNullableValueFields.Contains(p.Key)).Select(p => p.Key).ToArray()) node.Remove(key);
        var settings = node.Deserialize<BootstrapSettings>(new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException("Invalid settings document.");
        // Expose stable repaired rule IDs before clients reorder/edit them. The raw snapshot
        // and revision remain unchanged until an explicit CAS save.
        settings.TagLookRules = TagLookValidation.NormalizeRules(settings.TagLookRules);
        return new RevisionedSettingsResponse { Revision = snapshot.Revision, Settings = settings };
    }
}
