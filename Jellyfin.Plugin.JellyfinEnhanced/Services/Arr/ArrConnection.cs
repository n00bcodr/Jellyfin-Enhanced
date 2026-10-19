using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>The arr application behind an instance.</summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ArrKind
    {
        /// <summary>Sonarr (TV).</summary>
        Sonarr,
        /// <summary>Radarr (movies).</summary>
        Radarr,
    }

    /// <summary>
    /// One registered arr instance (registry v2), read-only. Carries no credential: the key is
    /// resolved from the secrets store only when a client is created
    /// (<see cref="ArrInstanceRegistry.ResolveApiKey"/>).
    /// </summary>
    public sealed class ArrConnection
    {
        /// <summary>Stable id.</summary>
        public string Id { get; init; } = string.Empty;

        /// <summary>Sonarr or Radarr.</summary>
        public ArrKind Kind { get; init; }

        /// <summary>Display name.</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>Server-side base URL.</summary>
        public string Url { get; init; } = string.Empty;

        /// <summary>Browser link mappings ("jellyfin_url|arr_url" lines).</summary>
        public string UrlMappings { get; init; } = string.Empty;

        /// <summary>Admin toggle.</summary>
        public bool Enabled { get; init; } = true;

        /// <summary>Kept for history only.</summary>
        public bool Retired { get; init; }

        /// <summary>Routing role (see <see cref="ArrInstanceRole"/>).</summary>
        public string Role { get; init; } = ArrInstanceRole.Standard;

        /// <summary>Default instance for its kind and role.</summary>
        public bool IsDefault { get; init; }

        /// <summary>Linked Jellyfin library ids.</summary>
        public IReadOnlyList<string> LinkedLibraryIds { get; init; } = Array.Empty<string>();

        /// <summary>Arr-to-Jellyfin path mappings.</summary>
        public IReadOnlyList<ArrPathMapping> PathMappings { get; init; } = Array.Empty<ArrPathMapping>();

        /// <summary>Add defaults (profile, root folder, ...).</summary>
        public ArrInstanceDefaults? Defaults { get; init; }

        /// <summary>Matching Seerr server id, if imported from Seerr.</summary>
        public int? SeerrServerId { get; init; }

        /// <summary>"auto" or "off".</summary>
        public string LiveUpdates { get; init; } = "auto";

        /// <summary>"off" or "provisioned".</summary>
        public string Webhook { get; init; } = "off";

        /// <summary>True when the instance can be used now (enabled and not retired).</summary>
        [JsonIgnore]
        public bool Usable => Enabled && !Retired;

        /// <summary>The stored key placeholder (never the key). Internal: resolved by the registry.</summary>
        [JsonIgnore]
        internal string StoredKey { get; init; } = string.Empty;

        /// <summary>Builds a connection from a stored row.</summary>
        internal static ArrConnection FromRow(ArrInstance row, ArrKind kind) => new()
        {
            Id = row.Id,
            Kind = kind,
            Name = row.Name,
            Url = row.Url,
            UrlMappings = row.UrlMappings ?? string.Empty,
            Enabled = row.Enabled,
            Retired = row.Retired,
            Role = ArrInstanceRole.Normalize(row.Role),
            IsDefault = row.IsDefault,
            LinkedLibraryIds = row.LinkedLibraryIds ?? new List<string>(),
            PathMappings = row.PathMappings ?? new List<ArrPathMapping>(),
            Defaults = row.Defaults,
            SeerrServerId = row.SeerrServerId,
            LiveUpdates = row.LiveUpdates ?? "auto",
            Webhook = row.Webhook ?? "off",
            StoredKey = row.ApiKey ?? string.Empty,
        };
    }
}
