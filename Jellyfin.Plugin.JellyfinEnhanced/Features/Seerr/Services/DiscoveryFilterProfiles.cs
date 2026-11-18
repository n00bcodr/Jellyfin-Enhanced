using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services
{
    /// <summary>
    /// A user's saved Seerr filter profiles: named sets of the Filters menu's filters (All / Movies / Series, the
    /// order, the further filters and how a list matches), each user's own, in <see cref="File"/> in the user's
    /// directory. A profile's filters are the address form the discovery pages read and write
    /// (<c>client/src/features/seerr/discovery/address.ts</c>): <c>jeType=movies&amp;jeScore=7..&amp;jeAny=keywords</c>.
    /// The server checks only their shape (the filter pairs, plain address characters, lengths); the page reads each
    /// value as it reads its own address, leaving out anything not of its filter's shape.
    /// </summary>
    public static class DiscoveryFilterProfiles
    {
        /// <summary>The file in the user's directory.</summary>
        public const string File = "discovery-filter-profiles.json";

        /// <summary>How many profiles a user can keep.</summary>
        public const int MaxProfiles = 30;

        /// <summary>The longest name.</summary>
        public const int MaxName = 60;

        /// <summary>The longest set of filters, in characters.</summary>
        public const int MaxFilters = 4000;

        /// <summary>The largest request body a save takes.</summary>
        public const int MaxRequestBytes = 16 * 1024;

        /// <summary>The filter pairs a profile may hold: the address's own, less the category page it names.</summary>
        public static readonly IReadOnlySet<string> Pairs = new HashSet<string>(StringComparer.Ordinal)
        {
            "jeType", "jeSort", "jeReleased", "jeScore", "jeVotes", "jeRuntime", "jeRole", "jeGenres", "jeLanguage",
            "jeRating", "jeServices", "jeKeywords", "jeWithout", "jeWithoutGenres", "jeWithoutLanguage", "jeAny", "jeAll",
        };

        // What a value is written with: encodeURIComponent's own characters, '%' escapes, and the ':', ',', '/' and '.'
        // the address leaves readable.
        private static readonly Regex Value = new(@"^[A-Za-z0-9%._~:,/\-!*'()]{1,2000}$", RegexOptions.Compiled);

        /// <summary>A user's saved profiles (<see cref="File"/>).</summary>
        public sealed class Store
        {
            /// <summary>Gets or sets the profiles, oldest first.</summary>
            public List<Profile> Profiles { get; set; } = new List<Profile>();
        }

        /// <summary>One saved profile.</summary>
        public sealed class Profile
        {
            /// <summary>Gets or sets the id.</summary>
            public string Id { get; set; } = string.Empty;

            /// <summary>Gets or sets the name.</summary>
            public string Name { get; set; } = string.Empty;

            /// <summary>Gets or sets the filters, in the address form (<c>name=value</c> pairs joined by <c>&amp;</c>).</summary>
            public string Filters { get; set; } = string.Empty;
        }

        /// <summary>
        /// Reads a profile to save from a request body <c>{"name": "…", "filters": "…"}</c>.
        /// </summary>
        /// <param name="body">The request body.</param>
        /// <param name="name">The name, trimmed.</param>
        /// <param name="filters">The filters, as given.</param>
        /// <param name="error">Why it was refused: <c>name</c>, <c>filters</c> or <c>empty</c>.</param>
        /// <returns>Whether it can be saved.</returns>
        public static bool TryRead(JsonElement body, out string name, out string filters, out string error)
        {
            name = string.Empty;
            filters = string.Empty;
            error = string.Empty;
            if (body.ValueKind != JsonValueKind.Object)
            {
                error = "filters";
                return false;
            }

            name = body.TryGetProperty("name", out var given) && given.ValueKind == JsonValueKind.String ? given.GetString()!.Trim() : string.Empty;
            if (name.Length == 0 || name.Length > MaxName || name.Any(char.IsControl))
            {
                error = "name";
                return false;
            }

            filters = body.TryGetProperty("filters", out var pairs) && pairs.ValueKind == JsonValueKind.String ? pairs.GetString()! : string.Empty;
            if (filters.Length == 0)
            {
                error = "empty";
                return false;
            }

            if (filters.Length > MaxFilters || !IsFilters(filters))
            {
                error = "filters";
                return false;
            }

            return true;
        }

        /// <summary>Whether text is a set of filter pairs: each one of <see cref="Pairs"/>, once, with a value of plain address characters.</summary>
        /// <param name="filters">The filters.</param>
        /// <returns>Whether they are.</returns>
        public static bool IsFilters(string filters)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var pair in filters.Split('&'))
            {
                var at = pair.IndexOf('=', StringComparison.Ordinal);
                if (at <= 0) return false;
                var key = pair[..at];
                if (!Pairs.Contains(key) || !seen.Add(key) || !Value.IsMatch(pair[(at + 1)..])) return false;
            }

            return seen.Count > 0;
        }

        /// <summary>A profile as the endpoints answer it.</summary>
        /// <param name="profile">The profile.</param>
        /// <returns>Its document.</returns>
        public static object ToDocument(Profile profile) => new { id = profile.Id, name = profile.Name, filters = profile.Filters };
    }
}
