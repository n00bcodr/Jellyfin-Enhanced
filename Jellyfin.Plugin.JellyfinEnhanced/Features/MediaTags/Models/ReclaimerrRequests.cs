using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Models
{
    /// <summary>Body of the Reclaimerr item actions (upstream da0ea773).</summary>
    public class ReclaimerrItemRequest
    {
        /// <summary>Gets or sets the item to act on.</summary>
        [JsonPropertyName("itemId")]
        public Guid? ItemId { get; set; }

        /// <summary>Gets or sets, for postpone, how many days later the removal moves (1-3650).</summary>
        [JsonPropertyName("days")]
        public int? Days { get; set; }

        /// <summary>Gets or sets, for mark or postpone, the exact day (ISO 8601). A cleanup candidate only moves later; a scheduled deletion either way.</summary>
        [JsonPropertyName("date")]
        public DateTimeOffset? Date { get; set; }

        /// <summary>Gets or sets, for request, an optional note for the administrator.</summary>
        [JsonPropertyName("reason")]
        public string? Reason { get; set; }

        /// <summary>Gets or sets the version picked on the item page; it tells apart the 4K and 1080p copies of one movie.</summary>
        [JsonPropertyName("mediaSourceId")]
        public string? MediaSourceId { get; set; }
    }

    /// <summary>Body of the request review routes (approve, deny).</summary>
    public class ReclaimerrReviewRequest
    {
        /// <summary>Gets or sets the administrator's note.</summary>
        [JsonPropertyName("note")]
        public string? Note { get; set; }
    }

    /// <summary>Body of the service-account route: a Reclaimerr administrator, used for this one call and never stored.</summary>
    public class ReclaimerrServiceAccountRequest
    {
        /// <summary>Gets or sets the Reclaimerr administrator's username.</summary>
        [JsonPropertyName("adminUsername")]
        public string? AdminUsername { get; set; }

        /// <summary>Gets or sets that administrator's password; empty signs in by name through Reclaimerr's trusted-proxy sign-in.</summary>
        [JsonPropertyName("adminPassword")]
        public string? AdminPassword { get; set; }
    }

    /// <summary>Body of the create-users route: what every new Reclaimerr account gets.</summary>
    public class ReclaimerrCreateUsersRequest
    {
        /// <summary>Gets or sets the permissions every new account gets (only the grantable ones are used).</summary>
        [JsonPropertyName("permissions")]
        public string[]? Permissions { get; set; }

        /// <summary>Gets or sets the Reclaimerr pages every new account can open (at least one grantable page).</summary>
        [JsonPropertyName("pages")]
        public string[]? Pages { get; set; }
    }

    /// <summary>
    /// A deletion request as the Leaving soon page draws it, with the Jellyfin title and person it is about, what it would
    /// delete (<c>scope</c>: movie, series, season, episode or movie_version) and how an approved one ended (upstream 40738412).
    /// </summary>
    public sealed record LeavingSoonRequestDto(
        [property: JsonPropertyName("id")] int Id,
        [property: JsonPropertyName("title")] string Title,
        [property: JsonPropertyName("year")] int? Year,
        [property: JsonPropertyName("mediaType")] string MediaType,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("createdAt")] string? CreatedAt,
        [property: JsonPropertyName("requestedBy")] string? RequestedBy,
        [property: JsonPropertyName("note")] string? Note,
        [property: JsonPropertyName("jellyfinUser")] string? JellyfinUser,
        [property: JsonPropertyName("jellyfinUserId")] string? JellyfinUserId,
        [property: JsonPropertyName("itemId")] string? ItemId,
        [property: JsonPropertyName("posterPath")] string? PosterPath,
        [property: JsonPropertyName("scope")] string Scope,
        [property: JsonPropertyName("seasonNumber")] int? SeasonNumber,
        [property: JsonPropertyName("episodeNumber")] int? EpisodeNumber,
        [property: JsonPropertyName("versionResolution")] string? VersionResolution,
        [property: JsonPropertyName("versionSize")] long? VersionSize,
        [property: JsonPropertyName("adminNotes")] string? AdminNotes,
        [property: JsonPropertyName("executionError")] string? ExecutionError,
        [property: JsonPropertyName("deferred")] bool Deferred);
}
