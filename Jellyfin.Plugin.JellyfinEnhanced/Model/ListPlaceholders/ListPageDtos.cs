using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders
{
    // Wire contracts of the list pages (Requests & downloads, phase 4c3a): the Playlists page asks which of the lists it
    // shows have entries that aren't in the library, for the person looking, without reading each list's whole view.

    /// <summary>Body of POST acquire/lists/summaries.</summary>
    public sealed class ListSummariesRequest
    {
        /// <summary>The lists on screen (playlist or collection ids), at most <c>ListSummaryService.MaxIds</c>.</summary>
        [JsonPropertyName("listIds")] public List<string>? ListIds { get; set; }
    }

    /// <summary>One list that has entries the caller can see that aren't in the library.</summary>
    public sealed class ListSummaryDto
    {
        /// <summary>The list id ("N").</summary>
        [JsonPropertyName("listId")] public string ListId { get; set; } = string.Empty;

        /// <summary>"playlist" or "collection".</summary>
        [JsonPropertyName("listKind")] public string ListKind { get; set; } = ListKinds.Playlist;

        /// <summary>
        /// How many of the list's entries that aren't in the library the caller can see (never fewer than 1: a list with
        /// none the caller can see is left out, so a hidden entry is never revealed by a count or by being listed).
        /// </summary>
        [JsonPropertyName("missing")] public int Missing { get; set; }
    }

    /// <summary>Response of POST acquire/lists/summaries.</summary>
    public sealed class ListSummariesDto
    {
        /// <summary>The asked-for lists that have entries the caller can see that aren't in the library.</summary>
        [JsonPropertyName("lists")] public List<ListSummaryDto> Lists { get; set; } = new();

        /// <summary>Lists that weren't worked out in time (a slow parental check): ask for them again a little later.</summary>
        [JsonPropertyName("pending")] public List<string> Pending { get; set; } = new();
    }
}
