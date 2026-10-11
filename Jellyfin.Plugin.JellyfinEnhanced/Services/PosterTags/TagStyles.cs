using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>One tag's colour override. Every value is a normalised <c>rgba(r, g, b, a)</c> string or null (keep the default).</summary>
    /// <param name="Background">Background colour.</param>
    /// <param name="Border">Border colour (not used by the rating chips, which have none).</param>
    /// <param name="Text">Text colour (the glyph colour for the genre circle).</param>
    public sealed record TagColors(string? Background, string? Border, string? Text)
    {
        private const char Sep = '\n';

        /// <summary>Packs the override into a tile-key style fragment; the inverse of <see cref="Decode"/>.</summary>
        internal string Encode() => string.Concat(Background, Sep, Border, Sep, Text);

        internal static (SKColor? Background, SKColor? Border, SKColor? Text) Decode(string encoded)
        {
            var parts = encoded.Split(Sep);
            return (Part(parts, 0), Part(parts, 1), Part(parts, 2));
        }

        private static SKColor? Part(string[] parts, int i) =>
            i < parts.Length && CssColor.TryParse(parts[i], out var c) ? c : null;
    }

    /// <summary>
    /// The admin's tag colour overrides (<c>PluginConfiguration.TagStyleOverrides</c>), validated and normalised.
    /// Shape of the stored JSON: <c>{"quality":{"4K":{"background":"#..","color":".."}},"age":{"&lt;group&gt;":{..}},
    /// "rating":{"community":{..},"critic":{..}},"genre":{..}}</c>. Anything that is not a colour
    /// <see cref="CssColor"/> understands is dropped, so a value can never reach generated CSS unchecked.
    /// </summary>
    public sealed class TagStyleSet
    {
        private const int MaxEntries = 400;
        private const int MaxKeyLength = 64;

        /// <summary>No overrides.</summary>
        public static readonly TagStyleSet Empty = new(
            new Dictionary<string, TagColors>(),
            new Dictionary<string, TagColors>(),
            new Dictionary<string, TagColors>(),
            null);

        private TagStyleSet(
            Dictionary<string, TagColors> quality,
            Dictionary<string, TagColors> age,
            Dictionary<string, TagColors> rating,
            TagColors? genre)
        {
            Quality = quality;
            Age = age;
            Rating = rating;
            Genre = genre;
            IsEmpty = quality.Count == 0 && age.Count == 0 && rating.Count == 0 && genre is null;
            Hash = IsEmpty ? string.Empty : ComputeHash();
        }

        /// <summary>Quality label to colours (the label as in the catalog, e.g. "4K").</summary>
        public IReadOnlyDictionary<string, TagColors> Quality { get; }

        /// <summary>Age rating colour group id (see <see cref="TagStyleCatalog"/>) to colours.</summary>
        public IReadOnlyDictionary<string, TagColors> Age { get; }

        /// <summary>"community" and "critic" rating chips.</summary>
        public IReadOnlyDictionary<string, TagColors> Rating { get; }

        /// <summary>The genre circle.</summary>
        public TagColors? Genre { get; }

        /// <summary>True when nothing is overridden.</summary>
        public bool IsEmpty { get; }

        /// <summary>Stable hash of the effective overrides, empty when there are none. Part of the poster cache key.</summary>
        public string Hash { get; }

        /// <summary>Parses the stored JSON; never throws, anything unusable is skipped.</summary>
        /// <param name="json">The stored JSON.</param>
        /// <returns>The overrides.</returns>
        public static TagStyleSet Parse(string? json)
        {
            if (string.IsNullOrWhiteSpace(json)) return Empty;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return Empty;
                var root = doc.RootElement;
                var set = new TagStyleSet(
                    ReadSection(root, "quality"),
                    ReadSection(root, "age"),
                    ReadSection(root, "rating"),
                    root.TryGetProperty("genre", out var g) ? ReadColors(g) : null);
                return set.IsEmpty ? Empty : set;
            }
            catch (JsonException)
            {
                return Empty;
            }
        }

        /// <summary>
        /// The overrides as the web needs them: every key resolved to concrete selectors
        /// (age groups expanded to their ratings), colours as <c>{background, border, color}</c>.
        /// </summary>
        /// <returns>A JSON-serialisable object.</returns>
        public object ToWebModel()
        {
            static object Web(TagColors c) => new { background = c.Background, border = c.Border, color = c.Text };

            var age = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var group in TagStyleCatalog.AgeGroups)
            {
                if (!Age.TryGetValue(group.Id, out var c)) continue;
                foreach (var rating in group.Ratings) age[rating] = Web(c);
            }

            return new
            {
                quality = Quality.ToDictionary(kv => kv.Key, kv => Web(kv.Value), StringComparer.Ordinal),
                age,
                rating = Rating.ToDictionary(kv => kv.Key, kv => Web(kv.Value), StringComparer.Ordinal),
                genre = Genre is null ? null : Web(Genre),
            };
        }

        private static Dictionary<string, TagColors> ReadSection(JsonElement root, string name)
        {
            var map = new Dictionary<string, TagColors>(StringComparer.Ordinal);
            if (!root.TryGetProperty(name, out var section) || section.ValueKind != JsonValueKind.Object) return map;
            foreach (var entry in section.EnumerateObject())
            {
                if (map.Count >= MaxEntries) break;
                if (entry.Name.Length is 0 or > MaxKeyLength) continue;
                if (ReadColors(entry.Value) is { } colors) map[entry.Name] = colors;
            }

            return map;
        }

        private static TagColors? ReadColors(JsonElement e)
        {
            if (e.ValueKind != JsonValueKind.Object) return null;
            var colors = new TagColors(Normalise(e, "background"), Normalise(e, "border"), Normalise(e, "color"));
            return colors.Background is null && colors.Border is null && colors.Text is null ? null : colors;
        }

        private static string? Normalise(JsonElement e, string name)
        {
            if (!e.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.String) return null;
            if (!CssColor.TryParse(v.GetString(), out var c)) return null;
            return string.Create(
                CultureInfo.InvariantCulture,
                $"rgba({c.Red}, {c.Green}, {c.Blue}, {Math.Round(c.Alpha / 255.0, 3)})");
        }

        private string ComputeHash()
        {
            var sb = new StringBuilder();
            void Add(string section, IEnumerable<KeyValuePair<string, TagColors>> items)
            {
                foreach (var (k, v) in items.OrderBy(i => i.Key, StringComparer.Ordinal))
                {
                    sb.Append(section).Append('|').Append(k).Append('|').Append(v.Encode()).Append('\n');
                }
            }

            Add("q", Quality);
            Add("a", Age);
            Add("r", Rating);
            if (Genre is not null) sb.Append("g||").Append(Genre.Encode());
            return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())).AsSpan(0, 8));
        }
    }

    /// <summary>One age rating colour group: the ratings that share a style in age-rating-colours.json.</summary>
    /// <param name="Id">Group id (index into the styles list), used as the override key.</param>
    /// <param name="Background">Default background.</param>
    /// <param name="Border">Default border.</param>
    /// <param name="Text">Default text colour.</param>
    /// <param name="Ratings">Every rating in the group.</param>
    public sealed record AgeColorGroup(string Id, string Background, string Border, string Text, IReadOnlyList<string> Ratings);

    /// <summary>The shipped default tag colours, read from the embedded poster tag assets; what the config page edits.</summary>
    public static class TagStyleCatalog
    {
        private static readonly Lazy<IReadOnlyList<(string Label, string Background, string Text)>> QualityList = new(LoadQuality);
        private static readonly Lazy<IReadOnlyList<AgeColorGroup>> AgeList = new(LoadAge);

        /// <summary>Quality labels with their default colours.</summary>
        public static IReadOnlyList<(string Label, string Background, string Text)> Quality => QualityList.Value;

        /// <summary>Age rating colour groups.</summary>
        public static IReadOnlyList<AgeColorGroup> AgeGroups => AgeList.Value;

        private static JsonDocument Read(string name)
        {
            using var stream = typeof(TagStyleCatalog).Assembly.GetManifestResourceStream(PosterTagAssets.ResourcePrefix + name)
                ?? throw new InvalidDataException($"Missing resource {name}");
            return JsonDocument.Parse(stream);
        }

        private static IReadOnlyList<(string, string, string)> LoadQuality()
        {
            using var doc = Read("quality-colours.json");
            return doc.RootElement.GetProperty("labels").EnumerateObject()
                .Select(l => (l.Name, l.Value.GetProperty("background").GetString() ?? string.Empty, l.Value.GetProperty("color").GetString() ?? "#ffffff"))
                .ToList();
        }

        private static IReadOnlyList<AgeColorGroup> LoadAge()
        {
            using var doc = Read("age-rating-colours.json");
            var members = new Dictionary<int, List<string>>();
            foreach (var r in doc.RootElement.GetProperty("ratings").EnumerateObject())
            {
                var idx = r.Value.GetInt32();
                if (!members.TryGetValue(idx, out var list)) members[idx] = list = new List<string>();
                list.Add(r.Name);
            }

            var groups = new List<AgeColorGroup>();
            var i = 0;
            foreach (var s in doc.RootElement.GetProperty("styles").EnumerateArray())
            {
                string Get(string key, string fallback) => s.TryGetProperty(key, out var v) ? v.GetString() ?? fallback : fallback;
                members.TryGetValue(i, out var ratings);
                groups.Add(new AgeColorGroup(
                    i.ToString(CultureInfo.InvariantCulture),
                    Get("background-color", "#607D8B"),
                    Get("border-color", "rgba(255, 255, 255, 0.25)"),
                    Get("color", "#ffffff"),
                    ratings ?? new List<string>()));
                i++;
            }

            return groups;
        }
    }
}
