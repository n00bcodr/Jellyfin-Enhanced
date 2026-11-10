using System;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags
{
    /// <summary>
    /// One logo chip of the Logos tag group: a streaming provider, a TV network
    /// or a movie studio. Immutable and value-compared, so entries can share
    /// one instance. JSON keys are short and lower-case like
    /// <see cref="TagSourceRatings"/>.
    /// </summary>
    public sealed record TagLogo
    {
        /// <summary>"provider", "network" or "studio".</summary>
        [JsonPropertyName("kind")] public string Kind { get; init; } = string.Empty;

        /// <summary>Display name ("Netflix", "HBO", "A24"); alt and title text, and the text chip.</summary>
        [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;

        /// <summary>
        /// TMDB image path ("/abc.png") served through the logo proxy, or null
        /// when no logo is known (the chip shows the name instead).
        /// </summary>
        [JsonPropertyName("logo")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Logo { get; init; }

        /// <summary>Ordinal, order-sensitive compare of two logo lists.</summary>
        public static bool SequencesEqual(TagLogo[]? a, TagLogo[]? b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null || a.Length != b.Length) return false;
            for (var i = 0; i < a.Length; i++)
            {
                if (!Equals(a[i], b[i])) return false;
            }

            return true;
        }
    }
}
