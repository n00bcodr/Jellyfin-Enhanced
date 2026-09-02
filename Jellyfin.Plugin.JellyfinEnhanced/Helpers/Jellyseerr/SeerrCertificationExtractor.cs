using System;
using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// Extracts the content-rating certification from a Seerr movie/TV detail
    /// payload (<c>/api/v1/movie/{id}</c> or <c>/api/v1/tv/{id}</c>) or from TMDB's
    /// dedicated <c>/movie/{id}/release_dates</c> and <c>/tv/{id}/content_ratings</c>
    /// responses. This is a C# port of the client's <c>getContentRating</c>
    /// (js/jellyseerr/moreinfo/more-info-modal-data.js) so the server-side parental
    /// filter reads exactly the certification the more-info modal displays.
    ///
    /// Region resolution: prefer the requested region, then <c>US</c>, then the
    /// first available entry. The ISO actually used is returned alongside the
    /// certification so the caller can resolve the score against that country's
    /// rating system.
    ///
    /// Adapted from Jellyfin-Canopy (GPL-3.0), Helpers/Seerr/SeerrCertificationExtractor.cs.
    /// </summary>
    public static class SeerrCertificationExtractor
    {
        /// <summary>Result of a certification lookup.</summary>
        /// <param name="Certification">The certification string (e.g. "PG-13"), or null when none is available.</param>
        /// <param name="Iso">The ISO-3166-1 country code the certification was taken from, or null.</param>
        public readonly record struct CertificationResult(string? Certification, string? Iso);

        /// <summary>
        /// Reads the certification for <paramref name="mediaType"/> ("movie" or "tv")
        /// from a detail object, preferring <paramref name="region"/>.
        /// </summary>
        public static CertificationResult Extract(JsonElement detail, string? mediaType, string region)
        {
            if (detail.ValueKind != JsonValueKind.Object)
            {
                return default;
            }

            var normalizedRegion = string.IsNullOrWhiteSpace(region) ? "US" : region.Trim().ToUpperInvariant();

            return string.Equals(mediaType, "movie", StringComparison.OrdinalIgnoreCase)
                ? ExtractMovie(detail, normalizedRegion)
                : ExtractTv(detail, normalizedRegion);
        }

        // For movies: releases.results[].release_dates[].certification
        private static CertificationResult ExtractMovie(JsonElement detail, string region)
        {
            if (!TryGetResultsArray(detail, "releases", out var results))
            {
                return default;
            }

            // The preferred region's entry often exists with only empty
            // certifications (digital/physical rows). For enforcement that must not
            // read as "unrated" while another entry is rated: fall through region ->
            // US -> first entry that actually carries a certification.
            foreach (var entry in CandidateEntries(results, region))
            {
                var result = MovieCertFromEntry(entry);
                if (!string.IsNullOrWhiteSpace(result.Certification))
                {
                    return result;
                }
            }

            return default;
        }

        private static CertificationResult MovieCertFromEntry(JsonElement regionRelease)
        {
            if (!regionRelease.TryGetProperty("release_dates", out var dates) || dates.ValueKind != JsonValueKind.Array)
            {
                return default;
            }

            // Prefer the theatrical release (type 3) that carries a certification,
            // else the first entry with any certification — matching the client.
            string? cert = null;
            foreach (var rd in dates.EnumerateArray())
            {
                if (rd.ValueKind == JsonValueKind.Object
                    && rd.TryGetProperty("type", out var type)
                    && type.ValueKind == JsonValueKind.Number
                    && type.TryGetInt32(out var typeValue)
                    && typeValue == 3)
                {
                    var c = ReadString(rd, "certification");
                    if (!string.IsNullOrWhiteSpace(c))
                    {
                        cert = c;
                        break;
                    }
                }
            }

            if (string.IsNullOrWhiteSpace(cert))
            {
                foreach (var rd in dates.EnumerateArray())
                {
                    var c = ReadString(rd, "certification");
                    if (!string.IsNullOrWhiteSpace(c))
                    {
                        cert = c;
                        break;
                    }
                }
            }

            return string.IsNullOrWhiteSpace(cert)
                ? default
                : new CertificationResult(cert, ReadString(regionRelease, "iso_3166_1"));
        }

        // For TV: contentRatings.results[].rating
        private static CertificationResult ExtractTv(JsonElement detail, string region)
        {
            if (!TryGetResultsArray(detail, "contentRatings", out var results))
            {
                return default;
            }

            foreach (var entry in CandidateEntries(results, region))
            {
                var rating = ReadString(entry, "rating");
                if (!string.IsNullOrWhiteSpace(rating))
                {
                    return new CertificationResult(rating, ReadString(entry, "iso_3166_1"));
                }
            }

            return default;
        }

        // Entries in preference order: the requested region, then US, then the rest.
        private static IEnumerable<JsonElement> CandidateEntries(JsonElement results, string region)
        {
            JsonElement? regionEntry = null;
            JsonElement? usEntry = null;
            var others = new List<JsonElement>();
            foreach (var entry in results.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var iso = ReadString(entry, "iso_3166_1");
                if (regionEntry is null && string.Equals(iso, region, StringComparison.OrdinalIgnoreCase))
                {
                    regionEntry = entry;
                }
                else if (usEntry is null && string.Equals(iso, "US", StringComparison.OrdinalIgnoreCase))
                {
                    usEntry = entry;
                }
                else
                {
                    others.Add(entry);
                }
            }

            if (regionEntry is not null)
            {
                yield return regionEntry.Value;
            }

            if (usEntry is not null)
            {
                yield return usEntry.Value;
            }

            foreach (var entry in others)
            {
                yield return entry;
            }
        }

        private static bool TryGetResultsArray(JsonElement detail, string container, out JsonElement results)
        {
            // Seerr's detail body wraps the data under `releases`/`contentRatings`;
            // TMDB's dedicated `/movie/{id}/release_dates` and `/tv/{id}/content_ratings`
            // endpoints return `{ results: [...] }` directly. Accept both.
            results = default;
            if (detail.TryGetProperty(container, out var containerEl)
                && containerEl.ValueKind == JsonValueKind.Object
                && containerEl.TryGetProperty("results", out results)
                && results.ValueKind == JsonValueKind.Array)
            {
                return true;
            }

            return detail.TryGetProperty("results", out results)
                && results.ValueKind == JsonValueKind.Array;
        }

        private static string? ReadString(JsonElement element, string property)
        {
            return element.ValueKind == JsonValueKind.Object
                && element.TryGetProperty(property, out var value)
                && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
    }
}
