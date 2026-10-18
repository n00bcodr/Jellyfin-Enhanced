using System;
using System.Linq;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Known title-list JSON adapters. Never interprets request, person or genre IDs as title IDs.</summary>
public static class TitleFeedProjection
{
    /// <summary>Projects a fresh JSON tree after raw caches and access checks, before limits or personalized caches.</summary>
    public static string Hidden(string json, HiddenContentPolicy policy, string surface, string? fallbackKind = null)
    {
        var node = JsonNode.Parse(json);
        if (node is JsonArray root) Filter(root, policy, surface, fallbackKind);
        else if (node is JsonObject obj)
        {
            foreach (var field in new[] { "results", "cast", "crew", "parts", "requests", "items", "events", "mine", "soon", "ready" })
                if (obj[field] is JsonArray rows) Filter(rows, policy, surface, field == "parts" ? "movie" : fallbackKind);
            if (obj["groups"] is JsonArray groups)
            {
                for (var i = groups.Count - 1; i >= 0; i--)
                {
                    if (groups[i] is not JsonObject group) continue;
                    if (policy.IsHidden(Text(group, "key"), null, null, surface)) { groups.RemoveAt(i); continue; }
                    if (group["results"] is JsonArray cards) Filter(cards, policy, surface, fallbackKind);
                    if (group["results"] is JsonArray { Count: 0 }) groups.RemoveAt(i);
                }
            }
        }
        return node?.ToJsonString() ?? json;
    }

    /// <summary>A row's semantic title key, independent of its request/list database id.</summary>
    public static string? Identity(JsonObject row, string? fallbackKind = null)
    {
        if (HiddenContentPolicy.CanonicalTitle(Text(row, "key")) is { } key) return key;
        if (Acquire.TitleKey.Parse(Text(row, "series") ?? Text(row, "key")) is { } owner) return owner.Title.ToString();
        var media = row["media"] as JsonObject ?? row;
        var kind = Text(media, "mediaType") ?? Text(media, "media_type") ?? Text(media, "kind") ?? Text(media, "type") ?? fallbackKind;
        var id = Text(media, "tmdbId") ?? Text(media, "tmdb_id");
        if (id == null && (media != row || kind is "movie" or "tv")) id = Text(media, "id");
        return HiddenContentPolicy.TitleIdentity(kind, id);
    }

    private static void Filter(JsonArray rows, HiddenContentPolicy policy, string surface, string? kind)
    {
        for (var i = rows.Count - 1; i >= 0; i--)
        {
            if (rows[i] is not JsonObject row) continue;
            var media = row["mediaInfo"] as JsonObject ?? row["media"] as JsonObject;
            var hidden = policy.IsHidden(Identity(row, kind), Text(row, "itemId") ?? Text(row, "jellyfinMediaId") ?? (media == null ? null : Text(media, "jellyfinMediaId")), null, surface)
                || media != null && policy.IsHidden(null, Text(media, "jellyfinMediaId4k"), null, surface);
            if (hidden) rows.RemoveAt(i);
        }
    }

    private static string? Text(JsonObject obj, string field) => obj[field] is JsonValue value ? value.ToString() : null;
}
