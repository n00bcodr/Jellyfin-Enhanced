using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;

/// <summary>
/// Strict, lossless boundary for one user's elsewhere.json. Only an absent file has
/// defaults. An existing document is returned as stored or rejected, never repaired,
/// and a save changes only the editable fields it names.
/// </summary>
public sealed class ElsewhereDocumentService(UserConfigurationManager store)
{
    /// <summary>Stored document name, relative to the user's configuration directory.</summary>
    public const string FileName = "elsewhere.json";

    // A save carries no client revision, so a retry merges the same edit into the
    // newest document. The bound keeps a contended request from running indefinitely.
    private const int MaxSaveAttempts = 3;

    private static readonly IReadOnlyList<string> EditableFields =
    [
        nameof(ElsewhereSettings.Region),
        nameof(ElsewhereSettings.Regions),
        nameof(ElsewhereSettings.Services),
        nameof(ElsewhereSettings.SeasonProviders)
    ];

    /// <summary>Returns the validated document as JSON, or the typed defaults when the file is absent.</summary>
    /// <param name="userId">The authorized user whose document is read.</param>
    /// <returns>JSON that retains every stored field and numeric literal.</returns>
    /// <exception cref="InvalidDataException">The existing document is corrupt or has an invalid editable field.</exception>
    public string ReadJson(string userId)
    {
        var snapshot = store.ReadUserConfigurationDocument(userId, FileName);
        var document = snapshot.Exists ? Validated(snapshot.Document) : Defaults();
        return document.ToString(Formatting.None);
    }

    /// <summary>
    /// Validates a request body into the editable fields it sets. Unknown properties are
    /// ignored: the stored copy of a field this version cannot edit remains authoritative.
    /// </summary>
    /// <param name="body">The raw request body, before any host coercion of its values.</param>
    /// <param name="update">The named editable fields, spelled canonically.</param>
    /// <param name="error">Why the body was rejected.</param>
    /// <returns>True when the body names at least one editable field and all of them are valid.</returns>
    public static bool TryParseUpdate(JsonElement body, [NotNullWhen(true)] out JObject? update, [NotNullWhen(false)] out string? error)
    {
        update = null;
        error = null;
        if (body.ValueKind != JsonValueKind.Object)
        {
            error = "Elsewhere settings must be a JSON object.";
            return false;
        }

        var fields = new JObject();
        foreach (var property in body.EnumerateObject())
        {
            var name = EditableFields.FirstOrDefault(field => string.Equals(field, property.Name, StringComparison.OrdinalIgnoreCase));
            if (name == null)
            {
                continue;
            }

            if (fields.ContainsKey(name))
            {
                error = $"{name} was supplied more than once.";
                return false;
            }

            if (!TryReadValue(property.Value, out var value) || !HasEditableType(name, value))
            {
                error = $"{name} has an invalid value.";
                return false;
            }

            fields[name] = value;
        }

        if (!fields.HasValues)
        {
            error = "Elsewhere settings must include at least one editable field.";
            return false;
        }

        update = fields;
        return true;
    }

    /// <summary>
    /// Merges an update into the current document under the shared revision check. This
    /// protects a request from concurrent writers on the server; it does not detect a
    /// client that edited an older copy, because the route carries no client revision.
    /// </summary>
    /// <param name="userId">The authorized user whose document is changed.</param>
    /// <param name="update">Fields from <see cref="TryParseUpdate"/>.</param>
    /// <returns>False when concurrent writers outlasted every attempt; nothing was merged.</returns>
    /// <exception cref="InvalidDataException">The existing document is corrupt or has an invalid editable field.</exception>
    public bool TrySave(string userId, JObject update)
    {
        ArgumentNullException.ThrowIfNull(update);
        for (var attempt = 0; attempt < MaxSaveAttempts; attempt++)
        {
            var revision = store.ReadUserConfigurationDocument(userId, FileName).Revision;
            var saved = store.TryUpdateUserConfigurationDocument(userId, FileName, revision, raw =>
            {
                var document = raw == null ? Defaults() : Validated(raw);
                foreach (var field in update.Properties())
                {
                    document[field.Name] = field.Value.DeepClone();
                }

                return document;
            }, out _);
            if (saved)
            {
                return true;
            }
        }

        return false;
    }

    private static JObject Defaults() => JObject.FromObject(new ElsewhereSettings());

    private static bool TryReadValue(JsonElement element, [NotNullWhen(true)] out JToken? value)
    {
        try
        {
            value = UserConfigurationManager.LosslessToken(element);
            return true;
        }
        catch (Exception ex) when (ex is InvalidDataException || ex is InvalidOperationException)
        {
            // Duplicate nested keys, or an escape that is not valid UTF-16.
            value = null;
            return false;
        }
    }

    private static bool HasEditableType(string name, JToken value) => name switch
    {
        nameof(ElsewhereSettings.Region) => value.Type == JTokenType.String,
        nameof(ElsewhereSettings.SeasonProviders) => value.Type == JTokenType.Boolean,
        _ => value is JArray items && items.All(item => item.Type == JTokenType.String)
    };

    // Older documents can omit an editable field or hold null, and both mean "unset".
    // Every other value of the wrong type is corruption. Earlier versions read names
    // case-insensitively while the client's are exact, so an accepted name is canonical.
    private static JObject Validated(JToken? raw)
    {
        if (raw is not JObject document)
        {
            throw new InvalidDataException("Elsewhere settings must be an object.");
        }

        foreach (var name in EditableFields)
        {
            var matches = document.Properties().Where(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (matches.Length > 1)
            {
                throw new InvalidDataException($"Elsewhere field {name} has ambiguous casing.");
            }

            if (matches.Length == 0)
            {
                continue;
            }

            var property = matches[0];
            if (property.Value.Type != JTokenType.Null && !HasEditableType(name, property.Value))
            {
                throw new InvalidDataException($"Elsewhere field {name} has an invalid value.");
            }

            if (!string.Equals(property.Name, name, StringComparison.Ordinal))
            {
                property.Replace(new JProperty(name, property.Value));
            }
        }

        return document;
    }
}
