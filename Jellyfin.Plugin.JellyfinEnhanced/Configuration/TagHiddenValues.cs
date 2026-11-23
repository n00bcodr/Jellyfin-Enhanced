using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// Hidden tags (#1043): per tag group, the Tag Styles labels (the tiles of the Colours tag list) whose chips
    /// never draw. A label hides exactly the chips it colours: a genre label every spelling of that genre (Other:
    /// every genre without an icon of its own), an age rating board every rating on it, a logo style every logo of
    /// that kind, a language code every chip of that language. Set by the administrator for everyone; null hides
    /// nothing.
    /// </summary>
    public class TagHiddenValues
    {
        public string[]? Quality { get; set; }
        public string[]? AgeRating { get; set; }
        public string[]? Rating { get; set; }
        public string[]? Genre { get; set; }
        public string[]? Status { get; set; }
        public string[]? Language { get; set; }
        public string[]? Awards { get; set; }
        public string[]? Logos { get; set; }
        public string[]? Custom { get; set; }
    }

    /// <summary>
    /// Validation of <see cref="TagHiddenValues"/> and the label each chip is matched by, shared by the settings
    /// endpoints and native posters; core/tag-layout.js (hiddenChip) and core/tag-renderer-base.js
    /// (JE.core.tagHidden) do the same for the web tags.
    /// </summary>
    public static class TagHiddenRules
    {
        /// <summary>Most labels kept per group (the largest catalog, languages, has fewer).</summary>
        public const int MaxValues = 300;

        /// <summary>Groups that take a hidden list (every Tag Styles group), in editor order.</summary>
        public static IReadOnlyList<string> Groups => TagStyleKeys.Groups;

        /// <summary>Language labels that name a chip style rather than chips (their colours apply to every flag or code).</summary>
        private static readonly HashSet<string> LanguageStyleOnly = new(StringComparer.Ordinal) { "flag", "code" };

        /// <summary>A group's list (null when unset or for an unknown group).</summary>
        /// <param name="values">The lists, or null.</param>
        /// <param name="group">A group id.</param>
        /// <returns>The list, or null.</returns>
        public static string[]? ListOf(TagHiddenValues? values, string group) => values == null ? null : group switch
        {
            TagStyleKeys.Quality => values.Quality, TagStyleKeys.AgeRating => values.AgeRating, TagStyleKeys.Rating => values.Rating,
            TagStyleKeys.Genre => values.Genre, TagStyleKeys.Status => values.Status, TagStyleKeys.Language => values.Language,
            TagStyleKeys.Awards => values.Awards, TagStyleKeys.Logos => values.Logos, TagStyleKeys.Custom => values.Custom, _ => null,
        };

        /// <summary>Whether a label can be hidden: a catalog label of the group (language: not the flag/code styles).</summary>
        /// <param name="group">A group id.</param>
        /// <param name="label">A label key.</param>
        /// <returns>True when hideable.</returns>
        public static bool IsHideable(string group, string? label)
            => !string.IsNullOrEmpty(label) && label != TagStyleKeys.AnyLabel && TagStyleCatalog.IsLabel(group, label)
                && !(group == TagStyleKeys.Language && LanguageStyleOnly.Contains(label));

        /// <summary>Every list with unknown labels and duplicates dropped; null when nothing is hidden.</summary>
        /// <param name="values">The lists, or null.</param>
        /// <returns>The normalized lists, or null.</returns>
        public static TagHiddenValues? Normalize(TagHiddenValues? values)
        {
            if (values == null) return null;
            string[]? Read(string group)
            {
                var list = ListOf(values, group);
                if (list == null) return null;
                var result = list.Where(label => IsHideable(group, label)).Distinct(StringComparer.Ordinal).Take(MaxValues).ToArray();
                return result.Length == 0 ? null : result;
            }

            var result = new TagHiddenValues
            {
                Quality = Read(TagStyleKeys.Quality), AgeRating = Read(TagStyleKeys.AgeRating), Rating = Read(TagStyleKeys.Rating),
                Genre = Read(TagStyleKeys.Genre), Status = Read(TagStyleKeys.Status), Language = Read(TagStyleKeys.Language),
                Awards = Read(TagStyleKeys.Awards), Logos = Read(TagStyleKeys.Logos), Custom = Read(TagStyleKeys.Custom),
            };
            return Groups.All(g => ListOf(result, g) == null) ? null : result;
        }

        /// <summary>
        /// The ratings on the hidden age rating boards, as the badges show them (the web matches badges by these,
        /// as Tag Styles colours them).
        /// </summary>
        /// <param name="values">Normalized lists.</param>
        /// <returns>The ratings; empty when no board is hidden.</returns>
        public static string[] HiddenAgeRatings(TagHiddenValues? values)
        {
            var boards = ListOf(values, TagStyleKeys.AgeRating);
            if (boards is not { Length: > 0 }) return Array.Empty<string>();
            return TagStyleCatalog.AgeGroups.Where(a => boards.Contains(a.Id, StringComparer.Ordinal)).SelectMany(a => a.Ratings).Distinct(StringComparer.Ordinal).ToArray();
        }

        /// <summary>The genre label a genre name takes its colours from (its icon's canonical genre, else Other).</summary>
        /// <param name="genre">A genre name.</param>
        /// <returns>The label.</returns>
        public static string GenreLabel(string genre) => GenreIcons.LabelOfIcon(GenreIcons.IconFor(genre));

        /// <summary>The age rating board a badge's colour key belongs to, or null (a rating on no board).</summary>
        /// <param name="colorKey">The normalized rating.</param>
        /// <returns>The board id, or null.</returns>
        public static string? AgeBoard(string? colorKey)
            => colorKey is null ? null : TagStyleCatalog.AgeGroups.FirstOrDefault(a => a.Ratings.Contains(colorKey, StringComparer.Ordinal))?.Id;

        /// <summary>The quality label a quality chip takes its colours from (composites by their base), or null.</summary>
        /// <param name="tag">An arranged quality tag.</param>
        /// <returns>The label, or null.</returns>
        public static string? QualityLabel(QualityTag tag)
            => tag.Category is "runtime" or "aspectRatio" or "frameRate" or "versions" ? null : TagStyleCatalog.QualityKey(tag.Label);

        /// <summary>The logo style a logo chip takes its colours from: its pill kind, or the name chip without an image.</summary>
        /// <param name="kind">"provider", "network" or "studio".</param>
        /// <param name="hasLogo">Whether the logo has an image the server serves.</param>
        /// <returns>The label.</returns>
        public static string LogoLabel(string kind, bool hasLogo) => !hasLogo ? "text" : kind == "provider" ? "provider" : "company";

        /// <summary>The canonical language code a track's language takes its colours from, or null.</summary>
        /// <param name="code">A track language.</param>
        /// <returns>The code, or null.</returns>
        public static string? LanguageLabel(string? code)
            => code is not null && LanguageFlagRules.Parse(code, out var parsed) && LanguageFlagRules.CanonicalBase(parsed.Base) is { Length: > 0 } c ? c : null;
    }

    /// <summary>The hidden labels per group (immutable).</summary>
    public sealed class TagHiddenSet
    {
        /// <summary>Nothing hidden.</summary>
        public static readonly TagHiddenSet Empty = new(new Dictionary<string, HashSet<string>>(StringComparer.Ordinal));

        private readonly Dictionary<string, HashSet<string>> _labels;

        private TagHiddenSet(Dictionary<string, HashSet<string>> labels)
        {
            _labels = labels;
        }

        /// <summary>The set the administrator's lists hide.</summary>
        /// <param name="values">The administrator's lists.</param>
        /// <returns>The set.</returns>
        public static TagHiddenSet For(TagHiddenValues? values)
        {
            var normalized = TagHiddenRules.Normalize(values);
            if (normalized == null) return Empty;
            var labels = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
            foreach (var group in TagHiddenRules.Groups)
            {
                if (TagHiddenRules.ListOf(normalized, group) is { Length: > 0 } list) labels[group] = new HashSet<string>(list, StringComparer.Ordinal);
            }

            return labels.Count == 0 ? Empty : new TagHiddenSet(labels);
        }

        /// <summary>Whether a group hides anything.</summary>
        /// <param name="group">A group id.</param>
        /// <returns>True when its list is not empty.</returns>
        public bool Any(string group) => _labels.ContainsKey(group);

        /// <summary>Whether chips of this label are hidden.</summary>
        /// <param name="group">A group id.</param>
        /// <param name="label">The chip's Tag Styles label.</param>
        /// <returns>True when hidden.</returns>
        public bool Hides(string group, string? label) => label is not null && _labels.TryGetValue(group, out var set) && set.Contains(label);

        /// <summary>A stable text of a group's labels for settings digests (empty when it hides nothing).</summary>
        /// <param name="group">A group id.</param>
        /// <returns>The sorted labels, joined.</returns>
        public string DigestOf(string group)
            => _labels.TryGetValue(group, out var set) ? string.Join("\u001f", set.Order(StringComparer.Ordinal)) : string.Empty;
    }
}
