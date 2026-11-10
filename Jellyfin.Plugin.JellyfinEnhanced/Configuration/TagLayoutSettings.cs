using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// One poster tag group's slot within a layout profile. Group and slot are
    /// string values (not dictionary keys) so the client's recursive
    /// camel/Pascal key conversion never touches them.
    /// </summary>
    public class TagLayoutGroupSlot
    {
        /// <summary>Group id: quality, genre, language, rating, ageRating, status, awards, logos or custom.</summary>
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
        public int? Awards { get; set; }
        public int? Logos { get; set; }
        public int? Custom { get; set; }
    }

    /// <summary>
    /// Where one tag group shows: on each item type, and in the Continue Watching and Next Up home rows.
    /// A null switch follows the administrator's default (personal document) or means "on" (administrator
    /// defaults), so a document that never touched these shows every group everywhere, as before.
    /// </summary>
    public class TagScopeSet
    {
        public bool? Movies { get; set; }
        public bool? Series { get; set; }
        public bool? Seasons { get; set; }
        public bool? Episodes { get; set; }
        public bool? ContinueWatching { get; set; }
        public bool? NextUp { get; set; }
    }

    /// <summary>
    /// "Where to show" for every card tag group. The administrator's Rating switches keep their own settings
    /// (RatingTagsOnMovies …); a user's Rating switches live here like every other group's.
    /// People Tags are on cast cards, not media cards, so they have none.
    /// </summary>
    public class TagGroupScopes
    {
        /// <summary>Personal Rating switches (the administrator's stay in RatingTagsOn…).</summary>
        public TagScopeSet? Rating { get; set; }
        public TagScopeSet? Quality { get; set; }
        public TagScopeSet? Genre { get; set; }
        public TagScopeSet? Language { get; set; }
        public TagScopeSet? AgeRating { get; set; }
        public TagScopeSet? Status { get; set; }
        public TagScopeSet? Awards { get; set; }
        public TagScopeSet? Logos { get; set; }
        public TagScopeSet? Custom { get; set; }
    }

    /// <summary>
    /// One tag kind's own opacity and size, in percent of today's look (100 = unchanged). A kind is a quality
    /// category (resolution, source, dynamicRange, specialFormat, videoCodec, audio, edition, runtime, aspectRatio,
    /// frameRate, versions) or another card tag group (status, rating, ageRating, language, genre, awards, logos,
    /// custom); the web client lists them (core/tag-layout.js TAG_KINDS). A null value follows the administrator's
    /// (personal document), then 100. The kind is a string value, not a dictionary key, so the client's camel/Pascal
    /// key conversion never touches it.
    /// </summary>
    public class TagKindLook
    {
        /// <summary>Kind id, e.g. "resolution" or "language".</summary>
        public string Kind { get; set; } = string.Empty;

        /// <summary>Opacity in percent (<see cref="TagLayoutRules.MinKindOpacity"/>..100); null follows the default.</summary>
        public int? Opacity { get; set; }

        /// <summary>Size in percent of today's (<see cref="TagLayoutRules.MinKindScale"/>..<see cref="TagLayoutRules.MaxKindScale"/>); null follows the default.</summary>
        public int? Scale { get; set; }
    }

    /// <summary>A kind's effective opacity and size in percent.</summary>
    public readonly record struct TagKindLookValue(int Opacity, int Scale);

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

        /// <summary>Per-kind opacity range in percent (a tag is never made invisible).</summary>
        public const int MinKindOpacity = 10;
        public const int MaxKindOpacity = 100;

        /// <summary>Per-kind size range in percent of today's size.</summary>
        public const int MinKindScale = 50;
        public const int MaxKindScale = 200;

        /// <summary>Most kind entries kept: far more than there are kinds, so a list stays bounded.</summary>
        public const int MaxKindLooks = 64;

        // A kind id: a word as the web client spells its groups and quality categories. Anything else never reaches
        // a stylesheet or a cache key.
        private static readonly Regex KindIdRegex = new Regex("^[a-z][A-Za-z0-9]{0,31}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>Group ids in the default priority order.</summary>
        public static readonly IReadOnlyList<string> DefaultGroupOrder = new[] { "status", "quality", "rating", "ageRating", "language", "genre", "awards", "logos", "custom" };

        /// <summary>Valid slots per layout ("off" is valid everywhere).</summary>
        public static readonly IReadOnlyDictionary<string, string[]> LayoutSlots = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["corners"] = new[] { "tl", "tc", "tr", "ml", "c", "mr", "bl", "bc", "br", "off" },
            ["bands"] = new[] { "top", "bottom", "off" },
            ["caption"] = new[] { "poster", "caption", "off" },
            ["summary"] = new[] { "pill", "hover", "off" },
            ["minimal"] = new[] { "top", "dots", "corner", "hover", "off" },
        };

        /// <summary>Canonical tag size; null for an absent or unknown value.</summary>
        public static string? ReadScale(string? value) => ReadChoice(value, "smaller", "default", "larger", "largest");

        /// <summary>Canonical tag spacing; null for an absent or unknown value.</summary>
        public static string? ReadGap(string? value) => ReadChoice(value, "tight", "default", "roomy");

        /// <summary>Canonical size, with the unchanged appearance as fallback.</summary>
        public static string NormalizeScale(string? value) => ReadScale(value) ?? "default";

        /// <summary>Canonical spacing, with the unchanged appearance as fallback.</summary>
        public static string NormalizeGap(string? value) => ReadGap(value) ?? "default";

        /// <summary>Size multiplier shared with the web tag host.</summary>
        public static float ScaleFactor(string? value) => NormalizeScale(value) switch
        {
            "smaller" => 0.85f, "larger" => 1.15f, "largest" => 1.30f, _ => 1f,
        };

        /// <summary>Spacing multiplier shared with the web tag host.</summary>
        public static float GapFactor(string? value) => NormalizeGap(value) switch
        {
            "tight" => 0.75f, "roomy" => 1.5f, _ => 1f,
        };

        private static string? ReadChoice(string? value, params string[] choices)
        {
            var normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
            return choices.Contains(normalized) ? normalized : null;
        }

        private static readonly string[] Densities = { "full", "compact" };

        /// <summary>Corners layout edge spacing ids, with the inset (CSS px) each puts between a chip and the card edge.</summary>
        public static readonly IReadOnlyDictionary<string, float> EdgeSpacings = new Dictionary<string, float>(StringComparer.Ordinal)
        {
            ["default"] = 6f,
            ["tight"] = 3f,
            ["flush"] = 0f,
        };

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
        /// Canonical edge spacing of the corners layout: null stays null (inherit the
        /// administrator's), anything unknown is "default".
        /// </summary>
        public static string? NormalizeEdgeSpacing(string? edge)
        {
            if (edge == null) return null;
            var value = edge.Trim().ToLowerInvariant();
            return EdgeSpacings.ContainsKey(value) ? value : "default";
        }

        /// <summary>The inset (CSS px) of an edge spacing id; anything unknown is the default 6px.</summary>
        public static float EdgeInset(string? edge) =>
            EdgeSpacings.TryGetValue(NormalizeEdgeSpacing(edge) ?? "default", out var inset) ? inset : 6f;

        /// <summary>
        /// A profile with unknown groups, slots invalid for the layout and
        /// repeated groups (first entry wins) removed; null when nothing is left.
        /// Quality is the only group allowed in the minimal layout's dots slot.
        /// </summary>
        public static TagLayoutProfile? NormalizeProfile(string layout, TagLayoutProfile? profile)
            => NormalizeProfile(layout, profile, null);

        internal static TagLayoutProfile? NormalizeProfile(string layout, TagLayoutProfile? profile, Action<TagLayoutGroupSlot, TagLayoutGroupSlot>? onNormalized)
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
                var normalized = new TagLayoutGroupSlot { Group = group, Slot = slot };
                groups.Add(normalized);
                onNormalized?.Invoke(entry!, normalized);
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
                Awards = Clamp(caps.Awards),
                Logos = Clamp(caps.Logos),
                Custom = Clamp(caps.Custom),
            };
            return result.Quality == null && result.Genre == null && result.Language == null
                && result.Rating == null && result.AgeRating == null && result.Status == null && result.Awards == null && result.Logos == null && result.Custom == null
                ? null
                : result;
        }

        /// <summary>
        /// Kind looks with well-formed kinds only (the first entry of a kind wins, at most <see cref="MaxKindLooks"/>),
        /// values clamped to their ranges, and entries that set nothing left out; null when nothing is left.
        /// </summary>
        public static List<TagKindLook>? NormalizeKindLooks(IEnumerable<TagKindLook?>? looks)
        {
            if (looks == null) return null;
            var result = new List<TagKindLook>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var look in looks)
            {
                var kind = look?.Kind?.Trim();
                if (look == null || kind == null || !KindIdRegex.IsMatch(kind) || !seen.Add(kind)) continue;
                if (look.Opacity == null && look.Scale == null) continue;
                result.Add(new TagKindLook
                {
                    Kind = kind,
                    Opacity = look.Opacity.HasValue ? Math.Clamp(look.Opacity.Value, MinKindOpacity, MaxKindOpacity) : null,
                    Scale = look.Scale.HasValue ? Math.Clamp(look.Scale.Value, MinKindScale, MaxKindScale) : null,
                });
                if (result.Count == MaxKindLooks) break;
            }

            return result.Count == 0 ? null : result;
        }

        /// <summary>
        /// The kind looks a user's tags are drawn with: per kind and per value the user's own, else the
        /// administrator's, else 100. Only kinds that differ from today's look are listed; a document saved before
        /// layouts keeps the look it always had (like its size and spacing).
        /// </summary>
        public static IReadOnlyDictionary<string, TagKindLookValue> EffectiveKindLooks(JellyfinEnhancedUserSettings user, PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(user);
            ArgumentNullException.ThrowIfNull(config);
            var result = new SortedDictionary<string, TagKindLookValue>(StringComparer.Ordinal);
            if (IsLegacy(user)) return result;
            var own = (NormalizeKindLooks(user.TagKindLooks) ?? new List<TagKindLook>()).ToDictionary(l => l.Kind, StringComparer.Ordinal);
            var admin = (NormalizeKindLooks(config.TagKindLooks) ?? new List<TagKindLook>()).ToDictionary(l => l.Kind, StringComparer.Ordinal);
            foreach (var kind in own.Keys.Union(admin.Keys, StringComparer.Ordinal))
            {
                own.TryGetValue(kind, out var mine);
                admin.TryGetValue(kind, out var theirs);
                var value = new TagKindLookValue(mine?.Opacity ?? theirs?.Opacity ?? 100, mine?.Scale ?? theirs?.Scale ?? 100);
                if (value != new TagKindLookValue(100, 100)) result[kind] = value;
            }

            return result;
        }

        /// <summary>Scope ids in display order (also the web tag-scopes keys).</summary>
        public static readonly IReadOnlyList<string> ScopeIds = new[] { "movies", "series", "seasons", "episodes", "continueWatching", "nextUp" };

        /// <summary>Groups that take a "Where to show" set in <see cref="TagGroupScopes"/>.</summary>
        public static readonly IReadOnlyList<string> ScopedGroups = new[] { "quality", "genre", "language", "ageRating", "status", "awards", "logos", "custom" };

        /// <summary>A group's set in <paramref name="scopes"/> (null for Rating, People or an unknown group).</summary>
        public static TagScopeSet? ScopeSet(TagGroupScopes? scopes, string group) => scopes == null ? null : group switch
        {
            "quality" => scopes.Quality, "genre" => scopes.Genre, "language" => scopes.Language, "ageRating" => scopes.AgeRating,
            "status" => scopes.Status, "awards" => scopes.Awards, "logos" => scopes.Logos, "custom" => scopes.Custom, "rating" => scopes.Rating, _ => null,
        };

        /// <summary>One switch of a set (null when unset).</summary>
        public static bool? ScopeValue(TagScopeSet? set, string scope) => set == null ? null : scope switch
        {
            "movies" => set.Movies, "series" => set.Series, "seasons" => set.Seasons, "episodes" => set.Episodes,
            "continueWatching" => set.ContinueWatching, "nextUp" => set.NextUp, _ => null,
        };

        /// <summary>The scope an item type belongs to (null for types no switch governs, e.g. BoxSet or Video).</summary>
        public static string? ScopeOfType(string? itemType) => itemType switch
        {
            "Movie" => "movies", "Series" => "series", "Season" => "seasons", "Episode" => "episodes", _ => null,
        };

        /// <summary>A set with only its explicit switches, or null when it has none.</summary>
        public static TagScopeSet? NormalizeScopeSet(TagScopeSet? set)
        {
            if (set == null) return null;
            var result = new TagScopeSet { Movies = set.Movies, Series = set.Series, Seasons = set.Seasons, Episodes = set.Episodes, ContinueWatching = set.ContinueWatching, NextUp = set.NextUp };
            return ScopeIds.All(id => ScopeValue(result, id) == null) ? null : result;
        }

        /// <summary>Scopes with empty sets removed, or null when no group has a switch set.</summary>
        public static TagGroupScopes? NormalizeScopes(TagGroupScopes? scopes)
        {
            if (scopes == null) return null;
            var result = new TagGroupScopes
            {
                Quality = NormalizeScopeSet(scopes.Quality), Genre = NormalizeScopeSet(scopes.Genre), Language = NormalizeScopeSet(scopes.Language),
                AgeRating = NormalizeScopeSet(scopes.AgeRating), Status = NormalizeScopeSet(scopes.Status), Awards = NormalizeScopeSet(scopes.Awards),
                Logos = NormalizeScopeSet(scopes.Logos), Custom = NormalizeScopeSet(scopes.Custom), Rating = NormalizeScopeSet(scopes.Rating),
            };
            return ScopedGroups.All(g => ScopeSet(result, g) == null) && result.Rating == null ? null : result;
        }

        /// <summary>
        /// Whether a scoped group shows in a scope: the personal switch, else the administrator's, else on.
        /// Rating and People are not governed here (true).
        /// </summary>
        public static bool ScopeAllows(TagGroupScopes? personal, TagGroupScopes? admin, string group, string? scope)
            => scope == null || (ScopeValue(ScopeSet(personal, group), scope) ?? ScopeValue(ScopeSet(admin, group), scope) ?? true);

        /// <summary>
        /// A user's effective Rating switch: their own (TagGroupScopes.Rating), else an older document's
        /// RatingTagsOn… turned off (kept as their choice), else the administrator's RatingTagsOn…. An older
        /// document's "on" is the default everyone had and now follows the administrator, so nothing changes
        /// until the administrator turns a switch off.
        /// </summary>
        public static bool RatingScope(JellyfinEnhancedUserSettings user, PluginConfiguration config, string scope)
        {
            var own = ScopeValue(user.TagGroupScopes?.Rating, scope);
            if (own.HasValue) return own.Value;
            var (legacy, admin) = scope switch
            {
                "movies" => (user.RatingTagsOnMovies, config.RatingTagsOnMovies),
                "series" => (user.RatingTagsOnSeries, config.RatingTagsOnSeries),
                "seasons" => (user.RatingTagsOnSeasons, config.RatingTagsOnSeasons),
                "episodes" => (user.RatingTagsOnEpisodes, config.RatingTagsOnEpisodes),
                "continueWatching" => (user.RatingTagsOnContinueWatching, config.RatingTagsOnContinueWatching),
                "nextUp" => (user.RatingTagsOnNextUp, config.RatingTagsOnNextUp),
                _ => (true, true),
            };
            return legacy && admin;
        }

        /// <summary>The document version alone decides whether legacy presentation and facts apply.</summary>
        public static bool IsLegacy(JellyfinEnhancedUserSettings settings) => settings.TagLayoutSettingsVersion < 1;

        /// <summary>Normalize the layout settings of a user document in place.</summary>
        public static void Normalize(JellyfinEnhancedUserSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);
            settings.TagLayout = NormalizeLayout(settings.TagLayout);
            settings.TagLabelDensity = NormalizeDensity(settings.TagLabelDensity);
            settings.TagScale = settings.TagScale == null ? null : NormalizeScale(settings.TagScale);
            settings.TagGap = settings.TagGap == null ? null : NormalizeGap(settings.TagGap);
            settings.TagLayoutSettingsVersion = Math.Clamp(settings.TagLayoutSettingsVersion, 0, CurrentVersion);
            settings.TagLayouts = NormalizeProfiles(settings.TagLayouts);
            settings.TagGroupOrder = NormalizeOrder(settings.TagGroupOrder);
            settings.TagGroupCaps = NormalizeCaps(settings.TagGroupCaps);
            settings.TagGroupScopes = NormalizeScopes(settings.TagGroupScopes);
            settings.TagEdgeSpacing = NormalizeEdgeSpacing(settings.TagEdgeSpacing);
            settings.TagKindLooks = NormalizeKindLooks(settings.TagKindLooks);
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
            settings.TagScale = NormalizeScale(config.TagScale);
            settings.TagGap = NormalizeGap(config.TagGap);
            settings.TagLayouts = NormalizeProfiles(config.TagLayouts);
            settings.TagGroupOrder = NormalizeOrder(config.TagGroupOrder);
            settings.TagGroupCaps = NormalizeCaps(config.TagGroupCaps);
            settings.TagEdgeSpacing = NormalizeEdgeSpacing(config.TagEdgeSpacing) ?? "default";
            settings.TagKindLooks = NormalizeKindLooks(config.TagKindLooks);
            settings.TagLayoutSettingsVersion = CurrentVersion;
        }
    }
}
