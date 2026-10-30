using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// One poster tag group's slot within a layout profile. Group and slot are
    /// string values (not dictionary keys) so the client's recursive
    /// camel/Pascal key conversion never touches them.
    /// </summary>
    public class TagLayoutGroupSlot
    {
        /// <summary>Group id: quality, genre, language, rating, ageRating or status.</summary>
        public string Group { get; set; } = string.Empty;

        /// <summary>Slot id valid for the profile's layout, or "off".</summary>
        public string Slot { get; set; } = string.Empty;
    }

    /// <summary>The slot assignments of one layout. Groups not listed use the layout's default slot.</summary>
    public class TagLayoutProfile
    {
        public List<TagLayoutGroupSlot> Groups { get; set; } = new List<TagLayoutGroupSlot>();
    }

    /// <summary>
    /// Per-layout slot profiles. A null profile (or a group missing from one)
    /// falls back to the administrator's profile, then to the built-in table.
    /// Each layout keeps its own profile when the user switches layouts.
    /// </summary>
    public class TagLayoutProfiles
    {
        public TagLayoutProfile? Corners { get; set; }
        public TagLayoutProfile? Bands { get; set; }
        public TagLayoutProfile? Caption { get; set; }
        public TagLayoutProfile? Summary { get; set; }
        public TagLayoutProfile? Minimal { get; set; }
    }

    /// <summary>
    /// Maximum chips per group (0 = unlimited). A null cap falls back to the
    /// administrator's cap, then to the built-in default, which equals the
    /// limit each group had before caps existed.
    /// </summary>
    public class TagGroupCaps
    {
        public int? Quality { get; set; }
        public int? Genre { get; set; }
        public int? Language { get; set; }
        public int? Rating { get; set; }
        public int? AgeRating { get; set; }
        public int? Status { get; set; }
    }

    /// <summary>
    /// Validation and normalization of the poster tag layout settings shared by
    /// the per-user document and the administrator defaults. Unknown layouts,
    /// densities, groups and slots are normalized away rather than rejected so a
    /// stale or hand-edited value never blocks saving the rest of the document.
    /// </summary>
    public static class TagLayoutRules
    {
        /// <summary>Settings version written once a user saves a layout setting.</summary>
        public const int CurrentVersion = 1;

        /// <summary>Largest per-group cap accepted.</summary>
        public const int MaxCap = 10;

        /// <summary>Group ids in the default priority order.</summary>
        public static readonly IReadOnlyList<string> DefaultGroupOrder = new[] { "status", "quality", "rating", "ageRating", "language", "genre" };

        /// <summary>Valid slots per layout ("off" is valid everywhere).</summary>
        public static readonly IReadOnlyDictionary<string, string[]> LayoutSlots = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["corners"] = new[] { "tl", "tr", "bl", "br", "off" },
            ["bands"] = new[] { "top", "bottom", "off" },
            ["caption"] = new[] { "poster", "caption", "off" },
            ["summary"] = new[] { "pill", "hover", "off" },
            ["minimal"] = new[] { "top", "dots", "corner", "hover", "off" },
        };

        private static readonly string[] Densities = { "full", "compact" };

        /// <summary>
        /// Canonical group id for a case-insensitive name ("agerating" → "ageRating"), or null when unknown.
        /// </summary>
        public static string? NormalizeGroup(string? group)
        {
            if (string.IsNullOrWhiteSpace(group)) return null;
            var trimmed = group.Trim();
            return DefaultGroupOrder.FirstOrDefault(g => string.Equals(g, trimmed, StringComparison.OrdinalIgnoreCase));
        }

        /// <summary>Canonical layout id, or "corners" for anything unknown.</summary>
        public static string NormalizeLayout(string? layout)
        {
            var value = (layout ?? string.Empty).Trim().ToLowerInvariant();
            return LayoutSlots.ContainsKey(value) ? value : "corners";
        }

        /// <summary>Canonical density, or "full" for anything unknown.</summary>
        public static string NormalizeDensity(string? density)
        {
            var value = (density ?? string.Empty).Trim().ToLowerInvariant();
            return Densities.Contains(value) ? value : "full";
        }

        /// <summary>
        /// A profile with unknown groups, slots invalid for the layout and
        /// repeated groups (first entry wins) removed; null when nothing is left.
        /// Quality is the only group allowed in the minimal layout's dots slot.
        /// </summary>
        public static TagLayoutProfile? NormalizeProfile(string layout, TagLayoutProfile? profile)
        {
            if (profile?.Groups == null) return null;
            var slots = LayoutSlots[layout];
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var groups = new List<TagLayoutGroupSlot>();
            foreach (var entry in profile.Groups)
            {
                var group = NormalizeGroup(entry?.Group);
                var slot = (entry?.Slot ?? string.Empty).Trim().ToLowerInvariant();
                if (group == null || !slots.Contains(slot) || !seen.Add(group)) continue;
                if (slot == "dots" && group != "quality") continue;
                groups.Add(new TagLayoutGroupSlot { Group = group, Slot = slot });
            }

            return groups.Count == 0 ? null : new TagLayoutProfile { Groups = groups };
        }

        /// <summary>Every profile normalized; null when none is left.</summary>
        public static TagLayoutProfiles? NormalizeProfiles(TagLayoutProfiles? profiles)
        {
            if (profiles == null) return null;
            var result = new TagLayoutProfiles
            {
                Corners = NormalizeProfile("corners", profiles.Corners),
                Bands = NormalizeProfile("bands", profiles.Bands),
                Caption = NormalizeProfile("caption", profiles.Caption),
                Summary = NormalizeProfile("summary", profiles.Summary),
                Minimal = NormalizeProfile("minimal", profiles.Minimal),
            };
            return result.Corners == null && result.Bands == null && result.Caption == null
                && result.Summary == null && result.Minimal == null
                ? null
                : result;
        }

        /// <summary>Known groups only, deduplicated, in the given order; null when empty.</summary>
        public static List<string>? NormalizeOrder(IEnumerable<string>? order)
        {
            if (order == null) return null;
            var result = new List<string>();
            foreach (var entry in order)
            {
                var group = NormalizeGroup(entry);
                if (group != null && !result.Contains(group, StringComparer.Ordinal)) result.Add(group);
            }

            return result.Count == 0 ? null : result;
        }

        /// <summary>Caps clamped to 0..<see cref="MaxCap"/>; null when no cap is set.</summary>
        public static TagGroupCaps? NormalizeCaps(TagGroupCaps? caps)
        {
            if (caps == null) return null;
            static int? Clamp(int? value) => value.HasValue ? Math.Clamp(value.Value, 0, MaxCap) : null;
            var result = new TagGroupCaps
            {
                Quality = Clamp(caps.Quality),
                Genre = Clamp(caps.Genre),
                Language = Clamp(caps.Language),
                Rating = Clamp(caps.Rating),
                AgeRating = Clamp(caps.AgeRating),
                Status = Clamp(caps.Status),
            };
            return result.Quality == null && result.Genre == null && result.Language == null
                && result.Rating == null && result.AgeRating == null && result.Status == null
                ? null
                : result;
        }

        /// <summary>Normalize the layout settings of a user document in place.</summary>
        public static void Normalize(JellyfinEnhancedUserSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);
            settings.TagLayout = NormalizeLayout(settings.TagLayout);
            settings.TagLabelDensity = NormalizeDensity(settings.TagLabelDensity);
            settings.TagLayoutSettingsVersion = Math.Clamp(settings.TagLayoutSettingsVersion, 0, CurrentVersion);
            settings.TagLayouts = NormalizeProfiles(settings.TagLayouts);
            settings.TagGroupOrder = NormalizeOrder(settings.TagGroupOrder);
            settings.TagGroupCaps = NormalizeCaps(settings.TagGroupCaps);
        }

        /// <summary>
        /// Copy the administrator's layout defaults onto a user document as a
        /// normalized (version <see cref="CurrentVersion"/>) document: new users
        /// and "apply defaults to all users" start from the admin's choice.
        /// </summary>
        public static void ApplyDefaults(JellyfinEnhancedUserSettings settings, PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(settings);
            ArgumentNullException.ThrowIfNull(config);
            settings.TagLayout = NormalizeLayout(config.TagLayout);
            settings.TagLabelDensity = NormalizeDensity(config.TagLabelDensity);
            settings.TagLayouts = NormalizeProfiles(config.TagLayouts);
            settings.TagGroupOrder = NormalizeOrder(config.TagGroupOrder);
            settings.TagGroupCaps = NormalizeCaps(config.TagGroupCaps);
            settings.TagLayoutSettingsVersion = CurrentVersion;
        }
    }
}
