using System;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Bookmarks.Services;

public sealed class BookmarkDocumentService(UserConfigurationManager store)
{
    private const string FileName = "bookmark.json";
    public BookmarkDocumentResponse Read(string userId)
    {
        var snapshot = store.ReadUserConfigurationDocument(userId, FileName);
        var document = Document(snapshot.Document);
        return new() { Revision = snapshot.Revision, Document = document.ToString(Newtonsoft.Json.Formatting.None) };
    }
    public bool TryMutate(string userId, BookmarkMutationRequest request, out BookmarkSaveReceipt? receipt)
    {
        if (request.Operations == null || request.Operations.Count == 0 || request.Operations.Count > 10000)
            throw new ArgumentException("A bounded, nonempty operation batch is required.");
        var success = store.TryUpdateUserConfigurationDocument(userId, FileName, request.Revision, raw =>
        {
            var document = Document(raw);
            var records = Records(document);
            foreach (var operation in request.Operations) Apply(records, operation);
            return document;
        }, out var saved);
        receipt = success ? new() { Revision = saved.Revision } : null;
        return success;
    }
    private static JProperty? Property(JObject value, string name)
    {
        var matches = value.Properties().Where(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length > 1) throw new InvalidDataException("Ambiguous bookmark field casing.");
        return matches.SingleOrDefault();
    }
    private static JObject Document(JToken? raw)
    {
        var document = raw == null ? new JObject { ["bookmarks"] = new JObject() } : raw as JObject
            ?? throw new InvalidDataException("Bookmark document must be an object.");
        _ = Records(document);
        return document;
    }
    private static JObject Records(JObject document)
    {
        var property = Property(document, "bookmarks");
        if (property == null) { document["bookmarks"] = new JObject(); return (JObject)document["bookmarks"]!; }
        return property.Value as JObject ?? throw new InvalidDataException("Bookmarks must be an object.");
    }
    private static void Set(JObject record, string name, JToken value)
    {
        var property = Property(record, name);
        if (property == null) record[name] = value; else property.Value = value;
    }
    private static JToken? Get(JObject record, string name) => Property(record, name)?.Value;
    private static JObject Existing(JObject records, string? id, string? expectedItemId)
    {
        if (string.IsNullOrWhiteSpace(id) || records[id] is not JObject record) throw new ArgumentException("Bookmark selection changed. Reload before saving again.");
        if (expectedItemId != null && (string?)Get(record, "itemId") != expectedItemId)
            throw new ArgumentException("Bookmark item identity changed. Reload before saving again.");
        return record;
    }
    private static void Apply(JObject records, BookmarkOperation op)
    {
        if (op == null) throw new ArgumentException("Invalid operation.");
        if (op.Kind == "delete-all") { records.RemoveAll(); return; }
        JObject record;
        if (op.Kind is "create" or "copy" or "replace")
        {
            if (string.IsNullOrWhiteSpace(op.Id) || records.Property(op.Id) != null) throw new ArgumentException("New bookmark ID must be unique.");
            record = op.Kind == "create" ? new JObject() : (JObject)Existing(records, op.SourceId, op.ExpectedItemId).DeepClone();
            if (op.Kind != "create")
            {
                Set(record, "syncedFrom", Get(record, "itemId")?.DeepClone() ?? JValue.CreateNull());
                Offset(record, op.Offset ?? 0);
            }
            Patch(record, op.Fields);
            if (Get(record, "createdAt") == null) Set(record, "createdAt", DateTimeOffset.UtcNow.ToString("O"));
            if (op.Kind == "replace") records.Remove(op.SourceId!);
            records[op.Id!] = record;
        }
        else
        {
            record = Existing(records, op.Id, op.ExpectedItemId);
            switch (op.Kind)
            {
                case "delete": records.Remove(op.Id!); return;
                case "edit": Patch(record, op.Fields); break;
                case "backfill":
                    if (Get(record, "episodeNumber") is { Type: not JTokenType.Null }) return;
                    Patch(record, op.Fields); return;
                case "offset": Offset(record, op.Offset ?? throw new ArgumentException("Offset required.")); Set(record, "syncedFrom", ""); break;
                default: throw new ArgumentException("Unknown bookmark operation.");
            }
        }
        Set(record, "updatedAt", DateTimeOffset.UtcNow.ToString("O"));
    }
    private static void Offset(JObject record, double offset)
    {
        var value = Get(record, "timestamp");
        if (value == null || !double.TryParse(value.ToString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var timestamp)
            || !double.IsFinite(timestamp + offset)) throw new ArgumentException("Invalid bookmark timestamp or offset.");
        Set(record, "timestamp", Math.Max(0, timestamp + offset));
    }
    private static void Patch(JObject record, System.Text.Json.JsonElement? fields)
    {
        if (fields == null) return;
        if (fields.Value.ValueKind != System.Text.Json.JsonValueKind.Object) throw new ArgumentException("Fields must be an object.");
        foreach (var field in fields.Value.EnumerateObject())
        {
            if (field.Name is "id" or "exactMatch") throw new ArgumentException("Record identity is not a field.");
            if (string.Equals(field.Name, "timestamp", StringComparison.OrdinalIgnoreCase)
                && (field.Value.ValueKind != System.Text.Json.JsonValueKind.Number || !field.Value.TryGetDouble(out var timestamp) || !double.IsFinite(timestamp) || timestamp < 0)) throw new ArgumentException("Invalid bookmark timestamp.");
            // Preserve JSON kinds: date-shaped text is text, and extension numbers remain exact.
            Set(record, field.Name, UserConfigurationManager.LosslessToken(field.Value));
        }
    }
}
