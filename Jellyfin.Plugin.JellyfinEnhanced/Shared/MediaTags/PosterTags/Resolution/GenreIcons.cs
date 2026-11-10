using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Resolution
{
    /// <summary>
    /// Port of <c>js/tags/genretags.js</c>: the first three genres, each mapped to a Material
    /// Symbols glyph name by its lowercased name (default "theaters"), and the Tag Styles label each glyph
    /// stands for. Both read <c>js/tags/genre-icons.json</c> (<c>scripts/generate_genre_labels.py</c>).
    /// </summary>
    internal static class GenreIcons
    {
        /// <summary>The web shows at most this many genres.</summary>
        public const int MaxGenres = 3;

        /// <summary>Icon for genres missing from the map.</summary>
        public const string DefaultIcon = "theaters";

        // js/tags/genre-icons.json, the table genretags.js is generated from. The web looks keys up by
        // genreName.toLowerCase(), so the mixed-case key "НФ и Фэнтези" can never match; it is kept as-is for parity.
        private static readonly Table Data = Load();

        private static FrozenDictionary<string, string> Map => Data.Map;

        /// <summary>
        /// The Tag Styles labels of the genre group, in editor order: one per glyph, keyed by its canonical
        /// English genre (every alias, localized or not, resolves to it), then <see cref="OtherLabel"/>.
        /// </summary>
        public static IReadOnlyList<(string Key, string Name)> Labels => Data.Labels;

        /// <summary>The label of every genre outside the table (the default glyph).</summary>
        public static string OtherLabel => Data.Other;

        /// <summary>The glyph of a label key (the default glyph for Other), or null for an unknown key.</summary>
        /// <param name="label">A label key.</param>
        /// <returns>The glyph name, or null.</returns>
        public static string? IconOfLabel(string label) =>
            label == Data.Other ? DefaultIcon : Data.IconOfLabel.GetValueOrDefault(label);

        /// <summary>
        /// The Tag Styles label a drawn glyph belongs to: the canonical genre that owns it, else
        /// <see cref="OtherLabel"/> (the default glyph and the inherited-member texts too), as genretags.js resolves it.
        /// </summary>
        /// <param name="icon">What <see cref="IconFor"/> returned.</param>
        /// <returns>The label key.</returns>
        public static string LabelOfIcon(string icon) => Data.LabelOfIcon.GetValueOrDefault(icon) ?? Data.Other;

        /// <summary>The Tag Styles label of a genre (see <see cref="LabelOfIcon"/>).</summary>
        /// <param name="genre">A genre name.</param>
        /// <returns>The label key.</returns>
        public static string LabelFor(string genre) => LabelOfIcon(IconFor(genre));

        /// <summary>
        /// The genre chips the web shows for <paramref name="genres"/>, or null when it renders
        /// none (no genres, or a null genre anywhere in the list: the web builds a chip for every
        /// genre before the cap applies, and a null one throws).
        /// </summary>
        /// <param name="genres">The entry's genres.</param>
        /// <param name="cap">Most chips shown (0 = all); the layout's genre cap, <see cref="MaxGenres"/> by default.</param>
        public static List<GenreTag>? Resolve(string?[]? genres, int cap = MaxGenres)
        {
            if (genres is null || genres.Length == 0) return null;
            if (Array.IndexOf(genres, null) >= 0) return null;
            var count = cap > 0 ? Math.Min(cap, genres.Length) : genres.Length;
            var tags = new List<GenreTag>(count);
            for (var i = 0; i < count; i++)
            {
                var genre = genres[i]!;
                tags.Add(new GenreTag(genre, IconFor(genre)));
            }

            return tags;
        }

        /// <summary>The glyph name for one genre.</summary>
        public static string IconFor(string genre)
        {
            var key = JsText.ToLower(genre);
            if (Map.TryGetValue(key, out var icon)) return icon;

            // genreIconMap[key] is a plain-object lookup, so a lowercased name equal to an inherited
            // Object.prototype member finds that truthy non-string, and String(member) becomes the
            // icon span's text. Only the all-lowercase member names can match a lowercased genre.
            return key switch
            {
                "constructor" => ObjectConstructorText,
                "__proto__" => ObjectPrototypeText,
                _ => DefaultIcon,
            };
        }

        /// <summary>String(Object.prototype.constructor) in V8: the icon text for a genre named "constructor".</summary>
        internal const string ObjectConstructorText = "function Object() { [native code] }";

        /// <summary>String(Object.prototype): the icon text for a genre named "__proto__".</summary>
        internal const string ObjectPrototypeText = "[object Object]";

        private static Table Load()
        {
            using var stream = typeof(GenreIcons).Assembly.GetManifestResourceStream("Jellyfin.Plugin.JellyfinEnhanced.js.tags.genre-icons.json")
                ?? throw new InvalidDataException("Missing resource js/tags/genre-icons.json");
            using var doc = JsonDocument.Parse(stream);
            var root = doc.RootElement;
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var language in root.GetProperty("names").EnumerateObject())
            {
                foreach (var entry in language.Value.EnumerateObject()) map[entry.Name] = entry.Value.GetString()!;
            }

            var labels = new List<(string Key, string Name)>();
            var iconOfLabel = new Dictionary<string, string>(StringComparer.Ordinal);
            var labelOfIcon = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var label in root.GetProperty("labels").EnumerateObject())
            {
                var icon = map[label.Name];
                labels.Add((label.Name, label.Value.GetString()!));
                iconOfLabel[label.Name] = icon;
                labelOfIcon[icon] = label.Name;
            }

            var other = root.GetProperty("other");
            labels.Add((other.GetProperty("key").GetString()!, other.GetProperty("name").GetString()!));
            return new Table(
                map.ToFrozenDictionary(StringComparer.Ordinal),
                labels,
                other.GetProperty("key").GetString()!,
                iconOfLabel.ToFrozenDictionary(StringComparer.Ordinal),
                labelOfIcon.ToFrozenDictionary(StringComparer.Ordinal));
        }

        private sealed record Table(
            FrozenDictionary<string, string> Map,
            IReadOnlyList<(string Key, string Name)> Labels,
            string Other,
            FrozenDictionary<string, string> IconOfLabel,
            FrozenDictionary<string, string> LabelOfIcon);
    }
}
