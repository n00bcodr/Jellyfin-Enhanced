using System;
using System.Linq;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Known title-list JSON adapters. Never interprets request, person or genre IDs as title IDs.</summary>
public static class TitleFeedProjection
{
    /// <summary>Projects a fresh JSON tree after raw caches and access checks, before limits or personalized caches.</summary>
    public static string Hidden(string json, HiddenContentPolicy policy, string surface, string? fallbackKind = null, string resource = "")
        => ProviderPresentationSchema.Project(json, policy, null, surface, resource: resource, kind: fallbackKind);

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

    private static string? Text(JsonObject obj, string field) => obj[field] is JsonValue value ? value.ToString() : null;
}
