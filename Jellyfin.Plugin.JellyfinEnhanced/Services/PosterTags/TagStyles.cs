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
    /// <param name="Border">Border colour (an inner ring on rating chips and flags, which have no border of their own).</param>
    /// <param name="Text">Text colour (the glyph colour for the genre circle).</param>
    public sealed record TagColors(string? Background, string? Border, string? Text)
    {
        private const char Sep = '\n';

        /// <summary>True when no field is set.</summary>
        public bool IsEmpty => Background is null && Border is null && Text is null;

        /// <summary>This override with every unset field taken from <paramref name="lower"/>.</summary>
        /// <param name="lower">The colours underneath (group override, preset palette), or null.</param>
        /// <returns>The combined colours.</returns>
        public TagColors Over(TagColors? lower) => lower is null
            ? this
            : new TagColors(Background ?? lower.Background, Border ?? lower.Border, Text ?? lower.Text);

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
    /// The admin's Tag Styles (<c>PluginConfiguration.TagStyleOverrides</c> with <c>TagStylePreset</c>), validated
    /// and normalised. A chip's colours resolve field by field: label override, else group override, else the
    /// preset's palette (<see cref="TagStylePalettes"/>), else the tag module's built-in colour.
    /// </summary>
    /// <remarks>
    /// Stored document (version 2):
    /// <c>{"v":2,"preset":"glass","groups":{"quality":{"background":"rgba(..)","border":"..","text":".."}},
    /// "labels":{"quality:4K":{..},"ageRating:7":{..},"rating:community":{..},"status:trending":{..}}}</c>.
    /// Version 1 (no <c>v</c>) is still read: <c>{"quality":{"4K":{"background":"..","color":".."}},"age":{"&lt;board id&gt;":{..}},
    /// "rating":{"community":{..},"critic":{..}},"genre":{..}}</c>, migrated onto <see cref="Labels"/> as the colours it
    /// drew, under the default preset. Anything that is not a colour <see cref="CssColor"/> understands is dropped, so a
    /// value can never reach generated CSS unchecked.
    /// </remarks>
    public sealed class TagStyleSet
    {
        /// <summary>The largest stored document accepted on save, in characters.</summary>
        public const int MaxDocumentLength = 32 * 1024;

        private const int MaxEntries = 400;
        private const int MaxKeyLength = 64;
        private static readonly string[] V2Keys = { "v", "preset", "groups", "labels" };
        private static readonly Dictionary<string, TagColors> NoEntries = new(StringComparer.Ordinal);

        /// <summary>No overrides and the default preset.</summary>
        public static readonly TagStyleSet Empty = new(TagStyleKeys.DefaultPreset, NoEntries, NoEntries);

        private TagStyleSet(string preset, Dictionary<string, TagColors> groups, Dictionary<string, TagColors> labels)
        {
            Preset = preset;
            Groups = groups;
            Labels = labels;
            IsEmpty = preset == TagStyleKeys.DefaultPreset && groups.Count == 0 && labels.Count == 0;
            Hash = IsEmpty ? string.Empty : ComputeHash();
        }

        /// <summary>The preset id (see <see cref="TagStyleKeys.Presets"/>).</summary>
        public string Preset { get; }

        /// <summary>Group id to the colours every chip of the group takes.</summary>
        public IReadOnlyDictionary<string, TagColors> Groups { get; }

        /// <summary><c>group:label</c> to one chip's colours (age labels are board ids, quality labels catalog labels).</summary>
        public IReadOnlyDictionary<string, TagColors> Labels { get; }

        /// <summary>True when the set changes nothing (default preset, no overrides).</summary>
        public bool IsEmpty { get; }

        /// <summary>Stable hash of the preset and overrides, empty when the set is empty. Part of the poster cache key.</summary>
        public string Hash { get; }

        /// <summary>
        /// Parses the stored document; never throws, anything unusable is skipped. A version 1 document is
        /// migrated to the colours it drew (see <see cref="ReadV1"/>) under the default preset.
        /// </summary>
        /// <param name="json">The stored JSON (version 1 or 2).</param>
        /// <param name="preset">The stored <c>TagStylePreset</c>; it wins over a version 2 document's own <c>preset</c>.</param>
        /// <returns>The set.</returns>
        public static TagStyleSet Parse(string? json, string? preset = null)
        {
            var stored = TagStyleKeys.KnownPreset(preset);
            if (string.IsNullOrWhiteSpace(json)) return Create(stored ?? TagStyleKeys.DefaultPreset, NoEntries, NoEntries);
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return Create(stored ?? TagStyleKeys.DefaultPreset, NoEntries, NoEntries);
                var root = doc.RootElement;
                return root.TryGetProperty("v", out _) ? ReadV2(root, stored, strict: false, out _)! : ReadV1(root, strict: false, out _)!;
            }
            catch (JsonException)
            {
                return Create(stored ?? TagStyleKeys.DefaultPreset, NoEntries, NoEntries);
            }
        }

        /// <summary>
        /// Validates a document being saved. Either version must only hold known keys, known groups and labels,
        /// fields that apply to the group and parseable colours (so leaving out <c>v</c> is no way around the
        /// checks); a valid version 1 document is migrated like <see cref="Parse"/> does. Nothing over
        /// <see cref="MaxDocumentLength"/> is accepted.
        /// </summary>
        /// <param name="json">The posted document.</param>
        /// <param name="preset">The posted <c>TagStylePreset</c>.</param>
        /// <param name="set">The normalised set when valid.</param>
        /// <param name="error">Why it was rejected, when invalid.</param>
        /// <returns>True when valid.</returns>
        public static bool TryValidate(string? json, string? preset, out TagStyleSet set, out string? error)
        {
            set = Empty;
            error = null;
            var stored = TagStyleKeys.KnownPreset(preset);
            if (!string.IsNullOrEmpty(preset) && stored is null && preset != "custom")
            {
                error = $"unknown preset '{Clip(preset)}'";
                return false;
            }

            if (json is not null && json.Length > MaxDocumentLength)
            {
                error = $"document is larger than {MaxDocumentLength} characters";
                return false;
            }

            if (string.IsNullOrWhiteSpace(json))
            {
                set = Create(stored ?? TagStyleKeys.DefaultPreset, NoEntries, NoEntries);
                return true;
            }

            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    error = "document is not a JSON object";
                    return false;
                }

                var parsed = root.TryGetProperty("v", out _) ? ReadV2(root, stored, strict: true, out error) : ReadV1(root, strict: true, out error);
                if (parsed is null) return false;
                set = parsed;
                return true;
            }
            catch (JsonException)
            {
                error = "document is not valid JSON";
                return false;
            }
        }

        /// <summary>
        /// Applies save validation to a configuration being saved: a valid document is stored normalised to
        /// version 2 with its preset; anything else keeps the current document and preset, since a save can
        /// come from anywhere (API, restored backup).
        /// </summary>
        /// <param name="posted">The configuration being saved; its Tag Styles fields are rewritten.</param>
        /// <param name="current">The stored configuration, or null.</param>
        /// <param name="error">Why the posted styles were rejected.</param>
        /// <returns>True when the posted styles were accepted.</returns>
        internal static bool ApplyToSave(Configuration.PluginConfiguration posted, Configuration.PluginConfiguration? current, out string? error)
        {
            if (TryValidate(posted.TagStyleOverrides, posted.TagStylePreset, out var styles, out error))
            {
                posted.TagStyleOverrides = styles.Serialize();
                posted.TagStylePreset = styles.Preset;
                return true;
            }

            posted.TagStyleOverrides = current?.TagStyleOverrides ?? string.Empty;
            posted.TagStylePreset = current?.TagStylePreset ?? TagStyleKeys.DefaultPreset;
            return false;
        }

        /// <summary>The same overrides under another preset.</summary>
        /// <param name="preset">A preset id; anything unknown keeps this set.</param>
        /// <returns>The set.</returns>
        public TagStyleSet WithPreset(string? preset)
        {
            var known = TagStyleKeys.KnownPreset(preset);
            return known is null || known == Preset
                ? this
                : Create(known, new Dictionary<string, TagColors>(Groups, StringComparer.Ordinal), new Dictionary<string, TagColors>(Labels, StringComparer.Ordinal));
        }

        /// <summary>The set one user sees: their own preset when the admin lets users pick one, else this set.</summary>
        /// <param name="userPreset">The user's <c>TagStylePreset</c> (null = the admin's).</param>
        /// <param name="allowed"><c>TagStylesAllowUserPreset</c>.</param>
        /// <returns>The set.</returns>
        public TagStyleSet ForUser(string? userPreset, bool allowed) => allowed ? WithPreset(userPreset) : this;

        /// <summary>A chip's effective colours, field by field: label, group, preset. Null fields keep the built-in colour.</summary>
        /// <param name="group">A group id.</param>
        /// <param name="label">A label of the group, or <see cref="TagStyleKeys.AnyLabel"/> for chips outside the catalog.</param>
        /// <returns>The colours.</returns>
        public TagColors Resolve(string group, string label)
        {
            Labels.TryGetValue(group + ":" + label, out var own);
            Groups.TryGetValue(group, out var shared);
            var c = (own ?? new TagColors(null, null, null)).Over(shared).Over(TagStylePalettes.Preset(Preset, group, label));
            return group == TagStyleKeys.Language ? c with { Background = null, Text = null } : c;
        }

        /// <summary>A quality chip's colours: catalog labels by name, composite labels ("ATMOS 7.1") by their base, anything else as <c>*</c> (as the web's selectors match).</summary>
        /// <param name="label">The drawn quality label.</param>
        /// <returns>The colours.</returns>
        public TagColors ResolveQuality(string label)
        {
            if (IsEmpty) return new TagColors(null, null, null);
            return Resolve(TagStyleKeys.Quality, TagStyleCatalog.QualityKey(label) ?? TagStyleKeys.AnyLabel);
        }

        /// <summary>The stored form: canonical version 2 JSON, or an empty string when there are no overrides.</summary>
        /// <returns>The document.</returns>
        public string Serialize()
        {
            if (Groups.Count == 0 && Labels.Count == 0) return string.Empty;
            static Dictionary<string, object> Entries(IReadOnlyDictionary<string, TagColors> map) => map
                .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .ToDictionary(kv => kv.Key, kv => (object)Stored(kv.Value), StringComparer.Ordinal);
            var doc = new Dictionary<string, object> { ["v"] = 2, ["preset"] = Preset };
            if (Groups.Count > 0) doc["groups"] = Entries(Groups);
            if (Labels.Count > 0) doc["labels"] = Entries(Labels);
            return JsonSerializer.Serialize(doc);
        }

        /// <summary>
        /// The effective colours as the web needs them: every catalog label resolved (age boards with the ratings
        /// they cover), <c>*</c> entries for chips outside the catalog, colours as <c>{background, border, color}</c>.
        /// Only chips with at least one non-default field are listed.
        /// </summary>
        /// <returns>A JSON-serialisable object.</returns>
        public object ToWebModel()
        {
            static object Web(TagColors c) => new { background = c.Background, border = c.Border, color = c.Text };

            Dictionary<string, object> Map(string group, IEnumerable<string> labels)
            {
                var map = new Dictionary<string, object>(StringComparer.Ordinal);
                foreach (var label in labels)
                {
                    var c = Resolve(group, label);
                    if (!c.IsEmpty) map[label] = Web(c);
                }

                return map;
            }

            var age = new List<object>();
            foreach (var board in TagStyleCatalog.AgeGroups)
            {
                var c = Resolve(TagStyleKeys.AgeRating, board.Id);
                if (!c.IsEmpty) age.Add(new { ratings = board.Ratings, background = c.Background, border = c.Border, color = c.Text });
            }

            TagColors Single(string group, string label) => Resolve(group, label);
            var genre = Single(TagStyleKeys.Genre, "genre");
            var language = Single(TagStyleKeys.Language, "flag");
            return new
            {
                v = 2,
                preset = Preset,
                quality = Map(TagStyleKeys.Quality, TagStyleCatalog.Quality.Select(q => q.Label).Prepend(TagStyleKeys.AnyLabel)),
                age,
                ageDefault = Resolve(TagStyleKeys.AgeRating, TagStyleKeys.AnyLabel) is { IsEmpty: false } d ? Web(d) : null,
                rating = Map(TagStyleKeys.Rating, TagStyleKeys.RatingLabels.Select(l => l.Key)),
                genre = genre.IsEmpty ? null : Web(genre),
                status = Map(TagStyleKeys.Status, TagStyleKeys.StatusLabels.Select(l => l.Key)),
                language = language.IsEmpty ? null : Web(language),
            };
        }

        private static TagStyleSet Create(string preset, Dictionary<string, TagColors> groups, Dictionary<string, TagColors> labels) =>
            preset == TagStyleKeys.DefaultPreset && groups.Count == 0 && labels.Count == 0 ? Empty : new TagStyleSet(preset, groups, labels);

        private static Dictionary<string, string> Stored(TagColors c)
        {
            var o = new Dictionary<string, string>(StringComparer.Ordinal);
            if (c.Background is not null) o["background"] = c.Background;
            if (c.Border is not null) o["border"] = c.Border;
            if (c.Text is not null) o["text"] = c.Text;
            return o;
        }

        /// <summary>
        /// Version 1: per-section label maps holding only what differs from the built-in colours. The old editor
        /// baked its presets into those differences (leaving out every field a preset kept, such as Glass's text
        /// colours) and saved the preset's name only to remember the dropdown, so the web and native posters drew
        /// stored field else built-in colour, for catalog labels (of the rating chips only community and critic), with
        /// no border on rating chips. Each stored
        /// label is materialised to exactly those colours and the preset becomes the default one, so neither
        /// the new palettes nor the saved preset name recolour anything (including groups the old preset
        /// never touched when it was applied to one tab only).
        /// </summary>
        /// <param name="root">The document.</param>
        /// <param name="strict">Save validation: reject the first problem (unknown key, reserved key, field or
        /// a value that is not a colour) instead of skipping it.</param>
        /// <param name="error">The problem, in strict mode.</param>
        /// <returns>The set, or null with <paramref name="error"/> in strict mode.</returns>
        private static TagStyleSet? ReadV1(JsonElement root, bool strict, out string? error)
        {
            error = null;
            var labels = new Dictionary<string, TagColors>(StringComparer.Ordinal);

            // One label entry; false (with error) stops a strict read.
            bool Entry(string group, string label, JsonElement value, out string? problem)
            {
                problem = null;
                if (labels.Count >= MaxEntries)
                {
                    problem = strict ? $"more than {MaxEntries} labels" : null;
                    return !strict;
                }

                if (label.Length is 0 or > MaxKeyLength || IsReservedKey(label) || !IsV1Label(group, label))
                {
                    problem = strict ? (IsReservedKey(label) ? $"reserved key '{label}'" : $"unknown label '{Clip(label)}'") : null;
                    return !strict;
                }

                var stored = ReadColorsV1(value, group, strict, out problem);
                if (problem is not null) return false;
                if (stored is null) return true;
                var builtin = TagStylePalettes.Builtin(group, label);
                labels[group + ":" + label] = new TagColors(
                    stored.Background ?? builtin.Background,
                    group == TagStyleKeys.Rating ? null : stored.Border ?? builtin.Border,
                    stored.Text ?? builtin.Text);
                return true;
            }

            foreach (var section in root.EnumerateObject())
            {
                var group = section.Name switch
                {
                    "quality" => TagStyleKeys.Quality,
                    "age" => TagStyleKeys.AgeRating,
                    "rating" => TagStyleKeys.Rating,
                    "genre" => TagStyleKeys.Genre,
                    _ => null,
                };
                if (group is null)
                {
                    if (!strict) continue;
                    error = IsReservedKey(section.Name) ? $"reserved key '{section.Name}'" : $"unknown key '{Clip(section.Name)}'";
                    return null;
                }

                if (section.Value.ValueKind != JsonValueKind.Object)
                {
                    if (!strict) continue;
                    error = $"'{section.Name}' is not an object";
                    return null;
                }

                if (group == TagStyleKeys.Genre)
                {
                    if (!Entry(group, "genre", section.Value, out error)) return null;
                    continue;
                }

                foreach (var entry in section.Value.EnumerateObject())
                {
                    if (!Entry(group, entry.Name, entry.Value, out error)) return null;
                }
            }

            return Create(TagStyleKeys.DefaultPreset, new Dictionary<string, TagColors>(StringComparer.Ordinal), labels);
        }

        /// <summary>Version 2; strict mode returns null with an error at the first problem, lenient mode skips it.</summary>
        private static TagStyleSet? ReadV2(JsonElement root, string? preset, bool strict, out string? error)
        {
            error = null;
            string? Fail(string message)
            {
                return strict ? message : null;
            }

            if (strict)
            {
                if (!root.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var version) || version != 2)
                {
                    error = "unsupported document version";
                    return null;
                }

                foreach (var p in root.EnumerateObject())
                {
                    if (Array.IndexOf(V2Keys, p.Name) < 0)
                    {
                        error = $"unknown key '{Clip(p.Name)}'";
                        return null;
                    }
                }
            }

            var docPreset = root.TryGetProperty("preset", out var pr) && pr.ValueKind == JsonValueKind.String ? pr.GetString() : null;
            if (strict && docPreset is not null && TagStyleKeys.KnownPreset(docPreset) is null)
            {
                error = $"unknown preset '{Clip(docPreset)}'";
                return null;
            }

            var groups = new Dictionary<string, TagColors>(StringComparer.Ordinal);
            if (root.TryGetProperty("groups", out var gs))
            {
                if (gs.ValueKind != JsonValueKind.Object)
                {
                    error = Fail("'groups' is not an object");
                    if (strict) return null;
                }
                else
                {
                    foreach (var entry in gs.EnumerateObject())
                    {
                        if (!TagStyleKeys.IsGroup(entry.Name))
                        {
                            error = Fail($"unknown group '{Clip(entry.Name)}'");
                            if (strict) return null;
                            continue;
                        }

                        var colors = ReadColorsV2(entry.Value, entry.Name, strict, out error);
                        if (error is not null) return null;
                        if (colors is not null) groups[entry.Name] = colors;
                    }
                }
            }

            var labels = new Dictionary<string, TagColors>(StringComparer.Ordinal);
            if (root.TryGetProperty("labels", out var ls))
            {
                if (ls.ValueKind != JsonValueKind.Object)
                {
                    error = Fail("'labels' is not an object");
                    if (strict) return null;
                }
                else
                {
                    foreach (var entry in ls.EnumerateObject())
                    {
                        if (labels.Count >= MaxEntries)
                        {
                            error = Fail($"more than {MaxEntries} labels");
                            if (strict) return null;
                            break;
                        }

                        var sep = entry.Name.IndexOf(':', StringComparison.Ordinal);
                        var group = sep > 0 ? entry.Name[..sep] : string.Empty;
                        var label = sep > 0 ? entry.Name[(sep + 1)..] : string.Empty;
                        if (entry.Name.Length > MaxKeyLength || !TagStyleCatalog.IsLabel(group, label))
                        {
                            error = Fail($"unknown label '{Clip(entry.Name)}'");
                            if (strict) return null;
                            continue;
                        }

                        var colors = ReadColorsV2(entry.Value, group, strict, out error);
                        if (error is not null) return null;
                        if (colors is not null) labels[entry.Name] = colors;
                    }
                }
            }

            return Create(preset ?? TagStyleKeys.KnownPreset(docPreset) ?? TagStyleKeys.DefaultPreset, groups, labels);
        }

        private static TagColors? ReadColorsV2(JsonElement e, string group, bool strict, out string? error)
        {
            error = null;
            if (e.ValueKind != JsonValueKind.Object)
            {
                if (strict) error = $"colours of '{group}' are not an object";
                return null;
            }

            string? background = null, border = null, text = null;
            foreach (var p in e.EnumerateObject())
            {
                var colour = p.Value.ValueKind == JsonValueKind.String ? TagStylePalettes.NormaliseColour(p.Value.GetString()) : null;
                if (!TagStyleKeys.FieldApplies(group, p.Name) || colour is null)
                {
                    if (strict)
                    {
                        error = colour is null && TagStyleKeys.FieldApplies(group, p.Name)
                            ? $"'{Clip(p.Name)}' of '{group}' is not a colour"
                            : $"field '{Clip(p.Name)}' does not apply to '{group}'";
                        return null;
                    }

                    continue;
                }

                switch (p.Name)
                {
                    case "background": background = colour; break;
                    case "border": border = colour; break;
                    default: text = colour; break;
                }
            }

            var colors = new TagColors(background, border, text);
            return colors.IsEmpty ? null : colors;
        }

        /// <summary>A label version 1 could style: a catalog label, and of the rating chips only community and critic.</summary>
        private static bool IsV1Label(string group, string label) =>
            TagStyleCatalog.IsLabel(group, label) && (group != TagStyleKeys.Rating || label is "community" or "critic");

        /// <summary>
        /// A version 1 colour object: <c>background</c>, <c>border</c> (not on rating chips, which never drew one)
        /// and <c>color</c> for the text. Lenient mode skips anything else; strict mode rejects it.
        /// </summary>
        private static TagColors? ReadColorsV1(JsonElement e, string group, bool strict, out string? error)
        {
            error = null;
            if (e.ValueKind != JsonValueKind.Object)
            {
                if (strict) error = $"colours of '{group}' are not an object";
                return null;
            }

            string? background = null, border = null, text = null;
            foreach (var p in e.EnumerateObject())
            {
                bool applies = p.Name is "background" or "color" || (p.Name == "border" && group != TagStyleKeys.Rating);
                var colour = applies && p.Value.ValueKind == JsonValueKind.String ? TagStylePalettes.NormaliseColour(p.Value.GetString()) : null;
                if (colour is null)
                {
                    if (!strict) continue;
                    error = !applies
                        ? IsReservedKey(p.Name) ? $"reserved key '{p.Name}'" : $"field '{Clip(p.Name)}' does not apply to '{group}'"
                        : $"'{p.Name}' of '{group}' is not a colour";
                    return null;
                }

                switch (p.Name)
                {
                    case "background": background = colour; break;
                    case "border": border = colour; break;
                    default: text = colour; break;
                }
            }

            var colors = new TagColors(background, border, text);
            return colors.IsEmpty ? null : colors;
        }

        /// <summary>Object-prototype names a JavaScript reader of the document could trip over; never a valid key.</summary>
        private static bool IsReservedKey(string key) => key is "__proto__" or "constructor" or "prototype";

        private static string Clip(string value) => value.Length > 40 ? value[..40] : value;

        private string ComputeHash()
        {
            var sb = new StringBuilder();
            sb.Append("p|").Append(Preset).Append('\n');
            void Add(string section, IEnumerable<KeyValuePair<string, TagColors>> items)
            {
                foreach (var (k, v) in items.OrderBy(i => i.Key, StringComparer.Ordinal))
                {
                    sb.Append(section).Append('|').Append(k).Append('|').Append(v.Encode()).Append('\n');
                }
            }

            Add("g", Groups);
            Add("l", Labels);
            return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString())).AsSpan(0, 8));
        }
    }

    /// <summary>One age rating colour group: the ratings that share a style in age-rating-colours.json.</summary>
    /// <param name="Id">Group id (index into the styles list), used as the override key.</param>
    /// <param name="Background">Default background.</param>
    /// <param name="Border">Default border.</param>
    /// <param name="Text">Default text colour.</param>
    /// <param name="Ratings">Every rating in the group.</param>
    public sealed record AgeColorGroup(string Id, string Background, string Border, string Text, IReadOnlyList<string> Ratings)
    {
        // Well-known ratings shown as a board's sample chip, in order of preference.
        private static readonly string[] SamplePreference = { "G", "PG", "PG-13", "R", "NC-17", "NR", "R18+", "AU-M", "16", "TV-MA" };

        /// <summary>The rating the editor shows for the board.</summary>
        public string Sample => SamplePreference.FirstOrDefault(Ratings.Contains) ?? Ratings.FirstOrDefault() ?? "NR";
    }

    /// <summary>The shipped default tag colours, read from the embedded poster tag assets; what the config page edits.</summary>
    public static class TagStyleCatalog
    {
        private static readonly Lazy<IReadOnlyList<(string Label, string Background, string Text)>> QualityList = new(LoadQuality);
        private static readonly Lazy<IReadOnlyList<AgeColorGroup>> AgeList = new(LoadAge);
        private static readonly Lazy<IReadOnlyList<string>> CompositeBaseList = new(LoadCompositeBases);

        /// <summary>Quality labels with their default colours.</summary>
        public static IReadOnlyList<(string Label, string Background, string Text)> Quality => QualityList.Value;

        /// <summary>Age rating colour groups.</summary>
        public static IReadOnlyList<AgeColorGroup> AgeGroups => AgeList.Value;

        /// <summary>The editable labels of a group, as (key, display name).</summary>
        /// <param name="group">A group id.</param>
        /// <returns>The labels; empty for an unknown group.</returns>
        public static IReadOnlyList<(string Key, string Name)> Labels(string group) => group switch
        {
            TagStyleKeys.Quality => Quality.Select(q => (q.Label, q.Label)).ToList(),
            TagStyleKeys.AgeRating => AgeGroups.Select(a => (a.Id, a.Sample)).ToList(),
            TagStyleKeys.Rating => TagStyleKeys.RatingLabels,
            TagStyleKeys.Genre => new[] { ("genre", "Genre") },
            TagStyleKeys.Status => TagStyleKeys.StatusLabels,
            TagStyleKeys.Language => new[] { ("flag", "Flag") },
            _ => Array.Empty<(string, string)>(),
        };

        /// <summary>Whether <paramref name="label"/> is an editable label of <paramref name="group"/>.</summary>
        /// <param name="group">A group id.</param>
        /// <param name="label">A label key.</param>
        /// <returns>True when known.</returns>
        public static bool IsLabel(string group, string label) => Labels(group).Any(l => l.Key == label);

        /// <summary>The catalog label a drawn quality label takes its colours from (composites by their base), or null.</summary>
        /// <param name="label">A drawn quality label.</param>
        /// <returns>The catalog label, or null.</returns>
        public static string? QualityKey(string label)
        {
            if (Quality.Any(q => q.Label == label)) return label;
            foreach (var b in CompositeBaseList.Value)
            {
                if (label.StartsWith(b + " ", StringComparison.Ordinal) && Quality.Any(q => q.Label == b)) return b;
            }

            return null;
        }

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

        private static IReadOnlyList<string> LoadCompositeBases()
        {
            using var doc = Read("quality-colours.json");
            return doc.RootElement.TryGetProperty("compositeBases", out var bases)
                ? bases.EnumerateArray().Select(b => b.GetString() ?? string.Empty).Where(b => b.Length > 0).ToList()
                : new List<string>();
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
