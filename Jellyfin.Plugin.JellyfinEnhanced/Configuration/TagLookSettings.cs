using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// One condition of a tag look rule. Field and value are string values (not
    /// dictionary keys) so the client's camel/Pascal key conversion never
    /// touches them.
    /// </summary>
    public class TagLookCondition
    {
        /// <summary>library (library id, 32 hex), type (item type), genre (name) or ageRating (official rating).</summary>
        public string Field { get; set; } = string.Empty;

        /// <summary>The value the field must have; compared case-insensitively for genre and age rating.</summary>
        public string Value { get; set; } = string.Empty;
    }

    /// <summary>
    /// A "look" (layout + density, optional slot overrides) a poster card gets
    /// when every condition holds. Rules are evaluated in order; the first
    /// enabled rule whose conditions all hold wins.
    /// </summary>
    public class TagLookRule
    {
        /// <summary>Stable rule id (letters, digits, '-' and '_'; regenerated when missing or repeated).</summary>
        public string Id { get; set; } = string.Empty;

        /// <summary>Disabled rules are kept but skipped.</summary>
        public bool Enabled { get; set; } = true;

        /// <summary>Conditions, all of which must hold (1 to <see cref="TagLookValidation.MaxConditions"/>).</summary>
        public List<TagLookCondition> When { get; set; } = new List<TagLookCondition>();

        /// <summary>Layout the matching cards use.</summary>
        public string Layout { get; set; } = "corners";

        /// <summary>Label density the matching cards use.</summary>
        public string Density { get; set; } = "full";

        /// <summary>Reserved for colour presets (a later phase); null today.</summary>
        public string? ColourPreset { get; set; }

        /// <summary>Optional slot overrides for the rule's layout; null uses the user's profile for it.</summary>
        public List<TagLayoutGroupSlot>? Slots { get; set; }
    }

    /// <summary>
    /// A look frozen for one item: the layout, density and complete slot
    /// profile it had when the user locked it, so later rule, default or
    /// profile changes do not move it.
    /// </summary>
    public class TagLayoutLock
    {
        public string Layout { get; set; } = "corners";

        public string Density { get; set; } = "full";

        /// <summary>Reserved for colour presets (a later phase); null today.</summary>
        public string? ColourPreset { get; set; }

        /// <summary>The slot of each group at lock time; null uses the user's current profile.</summary>
        public List<TagLayoutGroupSlot>? Slots { get; set; }

        /// <summary>When the item was locked, Unix milliseconds (the oldest locks go first past the limit).</summary>
        public long LockedAt { get; set; }
    }

    /// <summary>
    /// Validation and normalization of the tag look rules and per-item locks.
    /// Invalid entries (unknown fields, malformed ids, unknown layouts or
    /// densities) are dropped individually, so one bad entry never blocks
    /// saving the rest of the document.
    /// </summary>
    public static class TagLookValidation
    {
        /// <summary>Most rules a user (or the administrator default) can have.</summary>
        public const int MaxRules = 50;

        /// <summary>Most conditions one rule can have.</summary>
        public const int MaxConditions = 5;

        /// <summary>Most locked items per user; the oldest are dropped first.</summary>
        public const int MaxLocks = 500;

        private const int MaxTextValue = 100;

        /// <summary>Item types a type condition can name, in their canonical spelling.</summary>
        public static readonly IReadOnlyList<string> ItemTypes = new[] { "Movie", "Series", "Season", "Episode", "BoxSet", "Video" };

        private static readonly string[] Fields = { "library", "type", "genre", "ageRating" };
        private static readonly string[] Densities = { "full", "compact" };
        private static readonly Regex RuleIdPattern = new Regex("^[A-Za-z0-9_-]{1,40}$", RegexOptions.CultureInvariant);
        private static readonly Regex PresetPattern = new Regex("^[a-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);

        /// <summary>
        /// An item or library id in N format (32 lowercase hex), or null when
        /// it is not a GUID. Accepts the hyphenated form too.
        /// </summary>
        public static string? NormalizeItemId(string? id)
        {
            if (string.IsNullOrWhiteSpace(id)) return null;
            var compact = id.Trim().Replace("-", string.Empty, StringComparison.Ordinal);
            if (compact.Length != 32 || !Guid.TryParseExact(compact, "N", out var guid)) return null;
            return guid.ToString("N");
        }

        private static string? NormalizeField(string? field)
        {
            if (string.IsNullOrWhiteSpace(field)) return null;
            var trimmed = field.Trim();
            return Fields.FirstOrDefault(f => string.Equals(f, trimmed, StringComparison.OrdinalIgnoreCase));
        }

        private static string? NormalizeLayoutStrict(string? layout)
        {
            var value = (layout ?? string.Empty).Trim().ToLowerInvariant();
            return TagLayoutRules.LayoutSlots.ContainsKey(value) ? value : null;
        }

        /// <summary>A density, "full" when empty, or null when it names something unknown.</summary>
        private static string? NormalizeDensityStrict(string? density)
        {
            if (string.IsNullOrWhiteSpace(density)) return "full";
            var value = density.Trim().ToLowerInvariant();
            return Densities.Contains(value) ? value : null;
        }

        private static string? NormalizePreset(string? preset)
        {
            var value = (preset ?? string.Empty).Trim().ToLowerInvariant();
            return PresetPattern.IsMatch(value) ? value : null;
        }

        /// <summary>One condition normalized, or null when its field or value is invalid.</summary>
        public static TagLookCondition? NormalizeCondition(TagLookCondition? condition)
        {
            var field = NormalizeField(condition?.Field);
            var raw = (condition?.Value ?? string.Empty).Trim();
            if (field == null || raw.Length == 0) return null;
            string? value = field switch
            {
                "library" => NormalizeItemId(raw),
                "type" => ItemTypes.FirstOrDefault(t => string.Equals(t, raw, StringComparison.OrdinalIgnoreCase)),
                _ => raw.Length <= MaxTextValue ? raw : null,
            };
            return value == null ? null : new TagLookCondition { Field = field, Value = value };
        }

        /// <summary>
        /// Rules normalized: rules with an unknown layout or density, or no
        /// valid condition left, are dropped; invalid conditions are dropped
        /// from their rule (at most <see cref="MaxConditions"/> kept); missing
        /// or repeated ids are replaced; at most <see cref="MaxRules"/> are
        /// kept. Null in, null out (inherit); an empty list stays empty.
        /// </summary>
        public static List<TagLookRule>? NormalizeRules(IEnumerable<TagLookRule?>? rules)
        {
            if (rules == null) return null;
            var result = new List<TagLookRule>();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var rule in rules)
            {
                if (result.Count >= MaxRules) break;
                if (rule == null) continue;
                var layout = NormalizeLayoutStrict(rule.Layout);
                var density = NormalizeDensityStrict(rule.Density);
                if (layout == null || density == null) continue;
                var when = (rule.When ?? new List<TagLookCondition>())
                    .Select(NormalizeCondition)
                    .Where(c => c != null)
                    .Take(MaxConditions)
                    .Cast<TagLookCondition>()
                    .ToList();
                if (when.Count == 0) continue;
                var id = (rule.Id ?? string.Empty).Trim();
                if (!RuleIdPattern.IsMatch(id) || ids.Contains(id))
                {
                    id = "r" + Guid.NewGuid().ToString("N").Substring(0, 12);
                }

                ids.Add(id);
                result.Add(new TagLookRule
                {
                    Id = id,
                    Enabled = rule.Enabled,
                    When = when,
                    Layout = layout,
                    Density = density,
                    ColourPreset = NormalizePreset(rule.ColourPreset),
                    Slots = TagLayoutRules.NormalizeProfile(layout, rule.Slots == null ? null : new TagLayoutProfile { Groups = rule.Slots })?.Groups,
                });
            }

            return result;
        }

        /// <summary>
        /// Locks normalized: keys that are not item ids are dropped (ids are
        /// stored lowercase N format; a repeated id keeps its newest lock), as
        /// are locks with an unknown layout or density; past
        /// <see cref="MaxLocks"/> the oldest go. Null in, null out.
        /// </summary>
        public static Dictionary<string, TagLayoutLock>? NormalizeLocks(IDictionary<string, TagLayoutLock?>? locks)
        {
            if (locks == null) return null;
            var byId = new Dictionary<string, TagLayoutLock>(StringComparer.Ordinal);
            foreach (var (key, value) in locks)
            {
                var id = NormalizeItemId(key);
                if (id == null || value == null) continue;
                var layout = NormalizeLayoutStrict(value.Layout);
                var density = NormalizeDensityStrict(value.Density);
                if (layout == null || density == null) continue;
                var normalized = new TagLayoutLock
                {
                    Layout = layout,
                    Density = density,
                    ColourPreset = NormalizePreset(value.ColourPreset),
                    Slots = TagLayoutRules.NormalizeProfile(layout, value.Slots == null ? null : new TagLayoutProfile { Groups = value.Slots })?.Groups,
                    LockedAt = Math.Max(0, value.LockedAt),
                };
                if (!byId.TryGetValue(id, out var existing) || existing.LockedAt < normalized.LockedAt)
                {
                    byId[id] = normalized;
                }
            }

            return byId
                .OrderByDescending(kv => kv.Value.LockedAt)
                .ThenBy(kv => kv.Key, StringComparer.Ordinal)
                .Take(MaxLocks)
                .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal);
        }

        /// <summary>Normalize the rules and locks of a user document in place.</summary>
        public static void Normalize(JellyfinEnhancedUserSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);
            settings.TagLookRules = NormalizeRules(settings.TagLookRules);
            settings.TagLayoutLocks = NormalizeLocks(settings.TagLayoutLocks?.ToDictionary(kv => kv.Key, kv => (TagLayoutLock?)kv.Value));
        }

        /// <summary>
        /// Copy the administrator's default rules onto a new (or reset) user
        /// document. Locks are personal and start empty.
        /// </summary>
        public static void ApplyDefaults(JellyfinEnhancedUserSettings settings, PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(settings);
            ArgumentNullException.ThrowIfNull(config);
            settings.TagLookRules = NormalizeRules(config.TagLookRules);
            settings.TagLayoutLocks = null;
        }
    }
}
