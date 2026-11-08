using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.SpoilerGuard.Configuration
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
        /// <summary>Stable rule id (letters, digits, '-' and '_'; a missing or repeated one becomes "rule-N").</summary>
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

        /// <summary>Optional per-shape looks over the rule's look (landscape cards, list rows); null = the rule's look on every shape.</summary>
        public TagShapeOverrides? Shapes { get; set; }
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

        /// <summary>Optional per-shape looks over the locked look (landscape cards, list rows); null = the locked look on every shape.</summary>
        public TagShapeOverrides? Shapes { get; set; }

        /// <summary>Chip limits over the user's ("Show up to" in the item editor); a null cap keeps the user's.</summary>
        public TagGroupCaps? Caps { get; set; }

        /// <summary>Tag size for this item (smaller, default, larger, largest); null keeps the user's.</summary>
        public string? TagScale { get; set; }

        /// <summary>Tag spacing for this item (tight, default, roomy); null keeps the user's.</summary>
        public string? TagGap { get; set; }

        /// <summary>Corners edge spacing for this item (default, tight, flush); null keeps the user's.</summary>
        public string? EdgeSpacing { get; set; }

        /// <summary>
        /// "item": a Series lock applies to the series card only; null (the default, and what every
        /// lock made before scopes meant): its seasons and episodes inherit it too.
        /// </summary>
        public string? Scope { get; set; }

        /// <summary>When the item was locked, Unix milliseconds (the oldest locks go first past the limit).</summary>
        public long LockedAt { get; set; }
    }

    /// <summary>
    /// A look the administrator gives one item for every user ("For everyone" in the item
    /// editor): the same document as a <see cref="TagLayoutLock"/>, kept in a list in the
    /// plugin configuration (XML cannot hold a dictionary). A user's own lock wins over it; it
    /// wins over every rule.
    /// </summary>
    public class TagLookItemOverride : TagLayoutLock
    {
        /// <summary>The item id (32 lowercase hex once normalized).</summary>
        public string ItemId { get; set; } = string.Empty;
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

        /// <summary>Most server-wide item looks (<see cref="PluginConfiguration.TagLookItemOverrides"/>); the oldest are dropped first.</summary>
        public const int MaxItemOverrides = 500;

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
                // Every condition must be valid: dropping one would silently widen the rule.
                var raw = rule.When ?? new List<TagLookCondition>();
                var when = raw.Select(NormalizeCondition).ToList();
                if (when.Count == 0 || when.Count > MaxConditions || when.Contains(null)) continue;
                var id = (rule.Id ?? string.Empty).Trim();
                if (!RuleIdPattern.IsMatch(id) || ids.Contains(id))
                {
                    // Deterministic, so the same stored rules always come out
                    // the same (public config is served with an ETag).
                    var n = result.Count + 1;
                    do
                    {
                        id = "rule-" + n++;
                    }
                    while (ids.Contains(id));
                }

                ids.Add(id);
                result.Add(new TagLookRule
                {
                    Id = id,
                    Enabled = rule.Enabled,
                    When = when.Cast<TagLookCondition>().ToList(),
                    Layout = layout,
                    Density = density,
                    ColourPreset = NormalizePreset(rule.ColourPreset),
                    Slots = TagLayoutRules.NormalizeProfile(layout, rule.Slots == null ? null : new TagLayoutProfile { Groups = rule.Slots })?.Groups,
                    Shapes = TagShapeRules.NormalizeDefaults(rule.Shapes),
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
                    Shapes = TagShapeRules.NormalizeDefaults(value.Shapes),
                    Caps = TagLayoutRules.NormalizeCaps(value.Caps),
                    TagScale = TagLayoutRules.ReadScale(value.TagScale),
                    TagGap = TagLayoutRules.ReadGap(value.TagGap),
                    EdgeSpacing = ReadEdge(value.EdgeSpacing),
                    Scope = string.Equals(value.Scope?.Trim(), "item", StringComparison.OrdinalIgnoreCase) ? "item" : null,
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

        /// <summary>An edge spacing id, or null when missing or unknown (the item keeps the user's).</summary>
        private static string? ReadEdge(string? edge)
        {
            var value = (edge ?? string.Empty).Trim().ToLowerInvariant();
            return TagLayoutRules.EdgeSpacings.ContainsKey(value) ? value : null;
        }

        /// <summary>
        /// Server-wide item looks normalized exactly like <see cref="NormalizeLocks"/> (the same
        /// document per item; an entry whose id is not an item id or whose look is invalid is
        /// dropped, a repeated id keeps its newest look, past <see cref="MaxItemOverrides"/> the
        /// oldest go), newest first. Null in, null out; null when nothing is left.
        /// </summary>
        public static List<TagLookItemOverride>? NormalizeItemOverrides(IEnumerable<TagLookItemOverride?>? overrides)
        {
            if (overrides == null) return null;
            var byId = new Dictionary<string, TagLayoutLock?>(StringComparer.Ordinal);
            foreach (var entry in overrides)
            {
                if (entry == null) continue;
                var id = NormalizeItemId(entry.ItemId);
                if (id == null) continue;
                // A repeated id keeps its newest look (NormalizeLocks keeps one per key).
                if (byId.TryGetValue(id, out var seen) && seen != null && seen.LockedAt >= entry.LockedAt) continue;
                byId[id] = entry;
            }

            var normalized = NormalizeLocks(byId);
            if (normalized == null || normalized.Count == 0) return null;
            return normalized.Take(MaxItemOverrides).Select(kv => new TagLookItemOverride
            {
                ItemId = kv.Key,
                Layout = kv.Value.Layout,
                Density = kv.Value.Density,
                ColourPreset = kv.Value.ColourPreset,
                Slots = kv.Value.Slots,
                Shapes = kv.Value.Shapes,
                Caps = kv.Value.Caps,
                TagScale = kv.Value.TagScale,
                TagGap = kv.Value.TagGap,
                EdgeSpacing = kv.Value.EdgeSpacing,
                Scope = kv.Value.Scope,
                LockedAt = kv.Value.LockedAt,
            }).ToList();
        }

        /// <summary>Normalize the rules and locks of a user document in place.</summary>
        public static void Normalize(SpoilerGuardUserSettings settings)
        {
            ArgumentNullException.ThrowIfNull(settings);
            settings.TagLookRules = NormalizeRules(settings.TagLookRules);
            settings.TagLayoutLocks = NormalizeLocks(settings.TagLayoutLocks!);
        }

        /// <summary>
        /// Copy the administrator's default rules onto a new (or reset) user
        /// document. Locks are personal and start empty.
        /// </summary>
        public static void ApplyDefaults(SpoilerGuardUserSettings settings, PluginConfiguration config)
        {
            ArgumentNullException.ThrowIfNull(settings);
            ArgumentNullException.ThrowIfNull(config);
            settings.TagLookRules = NormalizeRules(config.TagLookRules);
            settings.TagLayoutLocks = null;
        }
    }
}
