using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders
{
    /// <summary>Immutable reconciled coordinate; display projections receive separate mutable copies.</summary>
    /// <param name="S">Season number.</param>
    /// <param name="E">Episode number.</param>
    /// <param name="AirDate">Exact reconciled air date, when known.</param>
    /// <param name="Title">Retained episode display title.</param>
    /// <param name="KnownAired">Positive airing evidence independent of whether an exact date is known.</param>
    public sealed record CompletionEpisode(
        [property: JsonPropertyName("s")] int S,
        [property: JsonPropertyName("e")] int E,
        [property: JsonPropertyName("airDate")] string? AirDate,
        [property: JsonPropertyName("title")] string? Title,
        [property: JsonPropertyName("knownAired")] bool KnownAired = false);

    /// <summary>Positive, versioned reconciliation proof. Absent on legacy or unreconciled documents.</summary>
    public sealed class CompletionAuthority
    {
        /// <summary>Provider reconciliation or a new explicit user declaration; legacy absence cannot declare a scope.</summary>
        [JsonPropertyName("origin")] public string Origin { get; init; } = "provider";
        /// <summary>Evaluator evidence format version.</summary>
        [JsonPropertyName("evidenceVersion")] public int EvidenceVersion { get; init; }
        /// <summary>Fingerprint of all reconciled provider evidence.</summary>
        [JsonPropertyName("fingerprint")] public string Fingerprint { get; init; } = string.Empty;
        /// <summary>UTC time at which the evaluator reconciled the evidence.</summary>
        [JsonPropertyName("reconciledAt")] public DateTime ReconciledAt { get; init; }
        /// <summary>Identity and explicit scope to which this proof applies.</summary>
        [JsonPropertyName("scope")] public string Scope { get; init; } = string.Empty;
        /// <summary>Descriptive series coverage limit for a narrower scope; never grants broader authority.</summary>
        [JsonPropertyName("seriesCoverageReason")] public string? SeriesCoverageReason { get; init; }
        /// <summary>Reconciled episode coordinates, with independent positive airing evidence.</summary>
        [JsonPropertyName("episodes")] public IReadOnlyList<CompletionEpisode> Episodes { get; init; } = Array.Empty<CompletionEpisode>();
        /// <summary>Whether terminal status or a fully aired season permits retirement.</summary>
        [JsonPropertyName("canComplete")] public bool CanComplete { get; init; }
    }
}
