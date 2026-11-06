using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// One administrator rule of the Custom tag group: items carrying a Jellyfin tag
    /// (<see cref="Match"/> "tag") or belonging to a collection ("collection") named
    /// <see cref="Value"/> get a poster chip reading <see cref="Label"/>.
    /// </summary>
    public class CustomTagRule
    {
        /// <summary>"tag" (an item tag, BaseItem.Tags) or "collection" (a BoxSet the item is in).</summary>
        public string Match { get; set; } = CustomTagRuleSet.MatchTag;

        /// <summary>The tag or collection name, matched exactly but case-insensitively.</summary>
        public string Value { get; set; } = string.Empty;

        /// <summary>The chip text (also the Tag Styles label), at most <see cref="CustomTagRuleSet.MaxLabelLength"/> characters.</summary>
        public string Label { get; set; } = string.Empty;

        /// <summary>Optional icon (one of <see cref="CustomTagRuleSet.Icons"/>) drawn before the label; null for a text chip.</summary>
        public string? Icon { get; set; }
    }

    /// <summary>
    /// Validation of the Custom tag rules (<c>PluginConfiguration.CustomTagRules</c>) and the
    /// matcher the tag cache, the batch endpoint and native posters share. A rule is
    /// identified by its match type and value (<see cref="RuleId"/>), so editing its label,
    /// icon or colours never needs the cache to re-match; adding a rule does. The id hides the
    /// value (a keyed hash of it), so cache entries, /tag-data and the public configuration
    /// never name the tag or collection a rule matches.
    /// </summary>
    public static class CustomTagRuleSet
    {
        /// <summary>Match type: an item tag.</summary>
        public const string MatchTag = "tag";

        /// <summary>Match type: membership of a collection (BoxSet).</summary>
        public const string MatchCollection = "collection";

        /// <summary>Most rules kept; later rows are dropped.</summary>
        public const int MaxRules = 20;

        /// <summary>Longest chip label.</summary>
        public const int MaxLabelLength = 24;

        /// <summary>Longest tag or collection name.</summary>
        public const int MaxValueLength = 200;

        /// <summary>
        /// Icons a rule may show: the genre icons the bundled Material Symbols Outlined subset
        /// carries (js/tags/genretags.js genreIconMap; js/tags/customtags.js ICONS), so the web
        /// and native posters both have the glyph.
        /// </summary>
        public static readonly IReadOnlyList<string> Icons = new[]
        {
            "theaters", "sports_martial_arts", "explore", "animation", "mood", "local_police", "article", "theater_comedy",
            "family_restroom", "auto_awesome", "history_edu", "skull", "music_note", "psychology_alt", "favorite", "science", "tv",
            "psychology", "military_tech", "landscape", "domino_mask", "music_video", "menu_book", "sports_soccer", "quiz", "live_tv",
        };

        /// <summary>
        /// Rules as they are stored and served: unknown match types and rules without a value
        /// or with a reserved label (<see cref="IsReservedLabel"/>) dropped, value and label
        /// trimmed with inner whitespace collapsed, the
        /// label cut to <see cref="MaxLabelLength"/> characters, an icon not in
        /// <see cref="Icons"/> dropped, repeated match/value pairs collapsed (the first
        /// wins) and at most <see cref="MaxRules"/> rules. Never null.
        /// </summary>
        /// <param name="rules">The posted or stored rules.</param>
        /// <returns>The normalised rules.</returns>
        public static List<CustomTagRule> Normalize(IEnumerable<CustomTagRule?>? rules)
        {
            var result = new List<CustomTagRule>();
            if (rules == null) return result;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var rule in rules)
            {
                if (result.Count >= MaxRules) break;
                if (rule == null) continue;
                var match = NormalizeMatch(rule.Match);
                var value = Collapse(rule.Value);
                var label = Collapse(rule.Label);
                if (label.Length > MaxLabelLength) label = label[..MaxLabelLength].TrimEnd();
                if (match == null || value.Length == 0 || value.Length > MaxValueLength || label.Length == 0 || IsReservedLabel(label)) continue;
                var normalized = new CustomTagRule { Match = match, Value = value, Label = label, Icon = NormalizeIcon(rule.Icon) };
                if (!seen.Add(ContentKey(normalized))) continue;
                result.Add(normalized);
            }

            return result;
        }

        /// <summary>
        /// A rule's stable id: <c>tag:</c> or <c>collection:</c> and 16 hex digits of an HMAC
        /// of the match type and lower-cased value under the server's secret
        /// (<c>PluginConfiguration.CustomTagRuleKey</c>), so clients can tell rules apart without
        /// learning (or confirming a guess of) the tag or collection name.
        /// </summary>
        /// <param name="rule">A normalised rule.</param>
        /// <param name="key">The server's rule id key (empty in tests).</param>
        /// <returns>The id.</returns>
        public static string RuleId(CustomTagRule rule, string? key)
        {
            ArgumentNullException.ThrowIfNull(rule);
            var hash = HMACSHA256.HashData(Encoding.UTF8.GetBytes(key ?? string.Empty), Encoding.UTF8.GetBytes(ContentKey(rule)));
            return rule.Match + ":" + Convert.ToHexString(hash, 0, 8).ToLowerInvariant();
        }

        /// <summary>Whether a rule id belongs to a collection rule.</summary>
        /// <param name="id">A rule id.</param>
        /// <returns>True for a collection rule's id.</returns>
        public static bool IsCollectionId(string? id) => id != null && id.StartsWith(MatchCollection + ":", StringComparison.Ordinal);

        /// <summary>A new random rule id key (32 hex digits).</summary>
        /// <returns>The key.</returns>
        public static string NewKey() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();

        /// <summary>What makes two rules the same rule: the match type and the lower-cased value.</summary>
        private static string ContentKey(CustomTagRule rule) => rule.Match + ":" + rule.Value.ToLowerInvariant();

        /// <summary>
        /// Whether a string can be a Custom chip label (a Tag Styles <c>custom:</c> label):
        /// non-empty after trimming, at most <see cref="MaxLabelLength"/> characters, no
        /// control characters, not reserved (<see cref="IsReservedLabel"/>).
        /// </summary>
        /// <param name="label">A label.</param>
        /// <returns>True when valid.</returns>
        public static bool IsValidLabel(string? label)
        {
            if (string.IsNullOrWhiteSpace(label) || label.Length > MaxLabelLength) return false;
            return label == label.Trim() && !label.Any(char.IsControl) && !IsReservedLabel(label);
        }

        /// <summary>
        /// Whether a label is reserved: punctuation only (with spaces), which includes <c>*</c>,
        /// the Tag Styles sentinel for the whole group, so such a label could never have colours
        /// of its own. The rules table explains this next to the label.
        /// <para>
        /// This is the one definition the server (<see cref="Normalize"/>, <see cref="IsValidLabel"/>
        /// and so Tag Styles) and the rules table (configPage.html <c>isReservedLabel</c>) share: every
        /// Unicode scalar value of the label is in general category P (Pc, Pd, Ps, Pe, Pi, Pf, Po) or
        /// has the White_Space property. A supplementary-plane character such as U+10100 is one
        /// scalar value, not two surrogates. The table tests <c>/^[\p{P}\p{White_Space}]+$/u</c>, and
        /// tests/fixtures/custom-tag-labels.json holds the cases both sides are checked against.
        /// </para>
        /// </summary>
        /// <param name="label">A label.</param>
        /// <returns>True when reserved.</returns>
        public static bool IsReservedLabel(string label) => label.EnumerateRunes().All(r => Rune.IsPunctuation(r) || Rune.IsWhiteSpace(r));

        /// <summary>
        /// What decides which items match (match types and values in rule order, not labels
        /// or icons): equal before and after a configuration save means the cache needs no
        /// re-match.
        /// </summary>
        /// <param name="rules">The rules (normalised or not).</param>
        /// <param name="key">The server's rule id key.</param>
        /// <returns>The fingerprint.</returns>
        public static string MatchFingerprint(IEnumerable<CustomTagRule?>? rules, string? key) =>
            string.Join("\n", Normalize(rules).Select(rule => RuleId(rule, key)).Order(StringComparer.Ordinal));

        /// <summary>The canonical match type, or null when unknown.</summary>
        private static string? NormalizeMatch(string? match)
        {
            var value = (match ?? string.Empty).Trim().ToLowerInvariant();
            return value is MatchTag or MatchCollection ? value : null;
        }

        /// <summary>An icon of <see cref="Icons"/>, or null.</summary>
        private static string? NormalizeIcon(string? icon)
        {
            var value = (icon ?? string.Empty).Trim().ToLowerInvariant();
            return Icons.Contains(value, StringComparer.Ordinal) ? value : null;
        }

        /// <summary>Trimmed, with runs of whitespace (and control characters) as one space.</summary>
        private static string Collapse(string? text)
        {
            if (string.IsNullOrEmpty(text)) return string.Empty;
            var sb = new StringBuilder(text.Length);
            var space = false;
            foreach (var c in text)
            {
                if (char.IsWhiteSpace(c) || char.IsControl(c))
                {
                    space = sb.Length > 0;
                    continue;
                }

                if (space) sb.Append(' ');
                space = false;
                sb.Append(c);
            }

            return sb.ToString();
        }
    }

    /// <summary>
    /// The rules ready for matching: rule ids per lower-cased tag and per lower-cased
    /// collection name. Immutable; build one per configuration.
    /// </summary>
    public sealed class CustomTagMatcher
    {
        private static volatile Tuple<List<CustomTagRule>?, string, CustomTagMatcher>? _memo;
        private readonly Dictionary<string, int> _byTag;
        private readonly Dictionary<string, int> _byCollection;

        /// <summary>
        /// The matcher for a configuration's rules, kept while the rule list instance and the
        /// key stay the same (a configuration save replaces the list).
        /// </summary>
        /// <param name="config">The plugin configuration (null: no rules).</param>
        /// <returns>The matcher.</returns>
        public static CustomTagMatcher For(PluginConfiguration? config)
        {
            var rules = config?.CustomTagRules;
            var key = config?.CustomTagRuleKey ?? string.Empty;
            var memo = _memo;
            if (memo != null && ReferenceEquals(memo.Item1, rules) && string.Equals(memo.Item2, key, StringComparison.Ordinal)) return memo.Item3;
            var matcher = new CustomTagMatcher(rules, key);
            _memo = Tuple.Create(rules, key, matcher);
            return matcher;
        }

        /// <summary>A matcher over the normalised form of <paramref name="rules"/>.</summary>
        /// <param name="rules">The rules (normalised here).</param>
        /// <param name="key">The server's rule id key (see <see cref="CustomTagRuleSet.RuleId"/>).</param>
        public CustomTagMatcher(IEnumerable<CustomTagRule?>? rules, string? key = null)
        {
            Rules = CustomTagRuleSet.Normalize(rules);
            Ids = Rules.Select(rule => CustomTagRuleSet.RuleId(rule, key)).ToArray();
            Fingerprint = string.Join("\n", Ids.Order(StringComparer.Ordinal));
            _byTag = new Dictionary<string, int>(StringComparer.Ordinal);
            _byCollection = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var i = 0; i < Rules.Count; i++)
            {
                var value = Rules[i].Value.ToLowerInvariant();
                (Rules[i].Match == CustomTagRuleSet.MatchTag ? _byTag : _byCollection).TryAdd(value, i);
            }
        }

        /// <summary>The normalised rules, in their table order.</summary>
        public IReadOnlyList<CustomTagRule> Rules { get; }

        /// <summary>The rule ids, in table order.</summary>
        public IReadOnlyList<string> Ids { get; }

        /// <summary>What decides which items match (see <see cref="CustomTagRuleSet.MatchFingerprint"/>).</summary>
        public string Fingerprint { get; }

        /// <summary>True when there is no rule.</summary>
        public bool IsEmpty => Rules.Count == 0;

        /// <summary>True when a rule matches a collection (the library pass over collections is needed).</summary>
        public bool HasCollectionRules => _byCollection.Count > 0;

        /// <summary>Whether <paramref name="name"/> (any case) is the value of a collection rule.</summary>
        /// <param name="name">A collection name.</param>
        /// <returns>True when a rule names it.</returns>
        public bool IsRuleCollection(string? name) => name != null && _byCollection.ContainsKey(Fold(name));

        /// <summary>
        /// The ids of the rules an item matches, in rule table order, or null when none does.
        /// </summary>
        /// <param name="tags">The item's tags (its own and any it inherits).</param>
        /// <param name="collections">The names of the collections it belongs to.</param>
        /// <returns>The matching rule ids, or null.</returns>
        public string[]? Match(IEnumerable<string?>? tags, IEnumerable<string?>? collections)
        {
            if (IsEmpty) return null;
            List<int>? hits = null;
            void Add(Dictionary<string, int> map, IEnumerable<string?>? names)
            {
                if (names == null || map.Count == 0) return;
                foreach (var name in names)
                {
                    if (string.IsNullOrWhiteSpace(name) || !map.TryGetValue(Fold(name), out var index)) continue;
                    hits ??= new List<int>();
                    if (!hits.Contains(index)) hits.Add(index);
                }
            }

            Add(_byTag, tags);
            Add(_byCollection, collections);
            if (hits == null) return null;
            hits.Sort();
            return hits.Select(i => Ids[i]).ToArray();
        }

        /// <summary>A rule by id, or null.</summary>
        /// <param name="id">A rule id.</param>
        /// <returns>The rule.</returns>
        public CustomTagRule? Find(string? id)
        {
            if (id == null) return null;
            for (var i = 0; i < Ids.Count; i++)
            {
                if (string.Equals(Ids[i], id, StringComparison.Ordinal)) return Rules[i];
            }

            return null;
        }

        /// <summary>Lower-cased with inner whitespace collapsed, the way rule values are keyed.</summary>
        private static string Fold(string name) => string.Join(' ', name.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).ToLowerInvariant();
    }
}
