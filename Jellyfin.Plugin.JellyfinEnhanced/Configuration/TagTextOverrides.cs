using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// Tag text overrides (#1063): per tag group, the text a Tag Styles label's chips show instead of their own
    /// ("Season Finale" -> "End of Season"). Stored as a JSON document in <c>TagTextOverrides</c>
    /// ({"status":{"seasonFinale":"End of Season"}}), keyed like the Colours tag list and Hidden tags: a chip is
    /// matched by the label that colours it, and the text replaces the chip's whole text. Only groups whose chips
    /// are plain text take one. core/tag-layout.js (applyTextOverrides) does the same for the web tags.
    /// </summary>
    public static class TagTextRules
    {
        /// <summary>Longest text a chip takes (a chip is a few words).</summary>
        public const int MaxLength = 32;

        /// <summary>Longest stored document.</summary>
        public const int MaxDocumentLength = 8192;

        /// <summary>Groups whose chips take a text: the ones that draw plain words (the others draw scores, logos, flags or a rule's own label).</summary>
        public static readonly IReadOnlyList<string> Groups = new[] { TagStyleKeys.Quality, TagStyleKeys.Genre, TagStyleKeys.Status, TagStyleKeys.Awards };

        /// <summary>Whether a label of a group can take a text.</summary>
        /// <param name="group">A group id.</param>
        /// <param name="label">A label key.</param>
        /// <returns>True for a catalog label of a text group.</returns>
        public static bool IsRenamable(string group, string? label)
            => Groups.Contains(group) && !string.IsNullOrEmpty(label) && label != TagStyleKeys.AnyLabel && TagStyleCatalog.IsLabel(group, label);

        /// <summary>Reads a document tolerantly: unknown groups, unknown labels and empty texts are dropped.</summary>
        /// <param name="json">The stored document, or null.</param>
        /// <returns>Group -> label -> text; empty when nothing is set or the text is not a valid document.</returns>
        public static Dictionary<string, Dictionary<string, string>> Parse(string? json)
        {
            var result = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
            if (string.IsNullOrWhiteSpace(json) || json.Length > MaxDocumentLength) return result;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return result;
                foreach (var group in doc.RootElement.EnumerateObject())
                {
                    if (!Groups.Contains(group.Name) || group.Value.ValueKind != JsonValueKind.Object) continue;
                    var labels = new Dictionary<string, string>(StringComparer.Ordinal);
                    foreach (var entry in group.Value.EnumerateObject())
                    {
                        if (entry.Value.ValueKind != JsonValueKind.String || !IsRenamable(group.Name, entry.Name)) continue;
                        var text = Clean(entry.Value.GetString());
                        if (text.Length > 0) labels[entry.Name] = text;
                    }

                    if (labels.Count > 0) result[group.Name] = labels;
                }
            }
            catch (JsonException)
            {
                result.Clear();
            }

            return result;
        }

        /// <summary>The canonical document of a stored one (null when nothing is set), as the settings endpoints serve it.</summary>
        /// <param name="json">The stored document, or null.</param>
        /// <returns>The canonical JSON, or null.</returns>
        public static string? Normalize(string? json)
        {
            var parsed = Parse(json);
            if (parsed.Count == 0) return null;
            var ordered = parsed.OrderBy(g => g.Key, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.Value.OrderBy(l => l.Key, StringComparer.Ordinal).ToDictionary(l => l.Key, l => l.Value), StringComparer.Ordinal);
            return JsonSerializer.Serialize(ordered);
        }

        /// <summary>Checks a document the page sends: it must be valid JSON of the shape above, with texts a chip can show.</summary>
        /// <param name="json">The document.</param>
        /// <param name="error">Why it was refused.</param>
        /// <returns>True when accepted (null or empty is accepted: no overrides).</returns>
        public static bool TryValidate(string? json, out string? error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(json)) return true;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException();
                foreach (var group in doc.RootElement.EnumerateObject())
                {
                    if (!Groups.Contains(group.Name) || group.Value.ValueKind != JsonValueKind.Object) throw new JsonException();
                    foreach (var entry in group.Value.EnumerateObject())
                    {
                        if (entry.Value.ValueKind != JsonValueKind.String || !IsRenamable(group.Name, entry.Name)) throw new JsonException();
                        if (Clean(entry.Value.GetString()).Length > MaxLength) throw new JsonException();
                    }
                }

                return true;
            }
            catch (JsonException)
            {
                error = $"must be a JSON object of group -> label -> text (texts up to {MaxLength} characters; groups {string.Join(", ", Groups)})";
                return false;
            }
        }

        /// <summary>Trimmed text without control characters or line breaks.</summary>
        private static string Clean(string? text)
            => new string((text ?? string.Empty).Where(c => !char.IsControl(c)).ToArray()).Trim();
    }

    /// <summary>The overridden texts per group (immutable).</summary>
    public sealed class TagTextSet
    {
        /// <summary>No overrides.</summary>
        public static readonly TagTextSet Empty = new(new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal));

        private readonly Dictionary<string, Dictionary<string, string>> _texts;

        private TagTextSet(Dictionary<string, Dictionary<string, string>> texts)
        {
            _texts = texts;
        }

        /// <summary>The set a stored document defines.</summary>
        /// <param name="json">The stored document, or null.</param>
        /// <returns>The set.</returns>
        public static TagTextSet For(string? json)
        {
            var parsed = TagTextRules.Parse(json);
            return parsed.Count == 0 ? Empty : new TagTextSet(parsed);
        }

        /// <summary>Whether a group overrides anything.</summary>
        /// <param name="group">A group id.</param>
        /// <returns>True when it has a text.</returns>
        public bool Any(string group) => _texts.ContainsKey(group);

        /// <summary>The text for chips of this label, or null to keep their own.</summary>
        /// <param name="group">A group id.</param>
        /// <param name="label">The chip's Tag Styles label.</param>
        /// <returns>The text, or null.</returns>
        public string? Of(string group, string? label)
            => label is not null && _texts.TryGetValue(group, out var labels) && labels.TryGetValue(label, out var text) ? text : null;

        /// <summary>A stable text of a group's overrides for settings digests (empty when it has none).</summary>
        /// <param name="group">A group id.</param>
        /// <returns>The sorted label=text pairs, joined.</returns>
        public string DigestOf(string group)
            => _texts.TryGetValue(group, out var labels) ? string.Join("\u001f", labels.OrderBy(l => l.Key, StringComparer.Ordinal).Select(l => l.Key + "=" + l.Value)) : string.Empty;
    }
}
