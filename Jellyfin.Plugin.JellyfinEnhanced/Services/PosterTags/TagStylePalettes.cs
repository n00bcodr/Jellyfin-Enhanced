using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>Group, label and preset ids of the Tag Styles model; the group ids match the tag layout groups.</summary>
    public static class TagStyleKeys
    {
        /// <summary>Quality chips.</summary>
        public const string Quality = "quality";

        /// <summary>Age rating chips (labels are the age board ids of <see cref="TagStyleCatalog.AgeGroups"/>).</summary>
        public const string AgeRating = "ageRating";

        /// <summary>Rating chips: community, critic and user review.</summary>
        public const string Rating = "rating";

        /// <summary>The genre circle.</summary>
        public const string Genre = "genre";

        /// <summary>Status Tags, shared by web and native posters.</summary>
        public const string Status = "status";

        /// <summary>Language flags (only the border ring applies: a flag is an image).</summary>
        public const string Language = "language";
        public const string Awards = "awards";

        /// <summary>The label every chip of a group falls back to when it is not in the catalog.</summary>
        public const string AnyLabel = "*";

        /// <summary>The preset that keeps the built-in colours.</summary>
        public const string DefaultPreset = "default";

        /// <summary>Every group, in editor tab order.</summary>
        public static readonly IReadOnlyList<string> Groups = new[] { Quality, AgeRating, Rating, Genre, Status, Language, Awards };

        /// <summary>Every preset, in editor order.</summary>
        public static readonly IReadOnlyList<string> Presets = new[] { DefaultPreset, "glass", "outline", "dark", "light", "mono" };

        /// <summary>The rating chip labels.</summary>
        public static readonly IReadOnlyList<(string Key, string Name)> RatingLabels = new[] { ("community", "Community"), ("critic", "Critic"), ("userReview", "User review"), ("imdb", "IMDb"), ("tmdb", "TMDb"), ("rtCritic", "RT critic"), ("rtAudience", "RT audience"), ("metacritic", "Metacritic"), ("letterboxd", "Letterboxd"), ("trakt", "Trakt") };

        public static readonly IReadOnlyList<(string Key, string Name)> AwardLabels = new[] { ("imdbTop250", "IMDb Top 250"), ("certifiedFresh", "Certified Fresh"), ("oscar", "Oscar winner"), ("emmy", "Emmy winner"), ("letterboxdTop250", "Letterboxd Top 250") };

        /// <summary>The Status Tags labels (the <c>data-je-status</c> values the web draws).</summary>
        public static readonly IReadOnlyList<(string Key, string Name)> StatusLabels = Resolution.StatusRules.StyleLabels;

        /// <summary>A known preset id, or null.</summary>
        /// <param name="preset">Any string.</param>
        /// <returns>The canonical id, or null when it is not a preset.</returns>
        public static string? KnownPreset(string? preset)
        {
            if (string.IsNullOrWhiteSpace(preset)) return null;
            var p = preset.Trim().ToLowerInvariant();
            return Presets.Contains(p, StringComparer.Ordinal) ? p : null;
        }

        /// <summary>The stored admin preset: a known id, else <see cref="DefaultPreset"/> (covers the old "custom").</summary>
        /// <param name="preset">The stored value.</param>
        /// <returns>A preset id.</returns>
        public static string NormalizePreset(string? preset) => KnownPreset(preset) ?? DefaultPreset;

        /// <summary>Whether <paramref name="group"/> is a group id.</summary>
        /// <param name="group">Any string.</param>
        /// <returns>True for a group id.</returns>
        public static bool IsGroup(string? group) => group is not null && Groups.Contains(group, StringComparer.Ordinal);

        /// <summary>The fields a group can override; language flags only take the border ring.</summary>
        /// <param name="group">A group id.</param>
        /// <param name="field">"background", "border" or "text".</param>
        /// <returns>True when the field applies.</returns>
        public static bool FieldApplies(string group, string field) =>
            field is "background" or "border" or "text" && (group != Language || field == "border");
    }

    /// <summary>
    /// The colours each preset gives each chip, and the built-in colours they replace. Shared by the web
    /// (through <c>GET /JellyfinEnhanced/tag-styles</c>), the config page (the catalog) and native posters.
    /// </summary>
    public static class TagStylePalettes
    {
        private const string Transparent = "rgba(0, 0, 0, 0)";
        private const string White = "#ffffff";
        private const string Gold = "#ffd166";

        // Outline tints per quality category, as the minimal layout's dots.
        private const string ResolutionTint = "#1e88e5";
        private const string DynamicRangeTint = "#ef6c00";
        private const string AudioTint = "#2e7d32";
        private const string CodecTint = "#546e7a";

        private static readonly TagColors Unknown = new(null, null, null);

        /// <summary>
        /// The built-in colours of a chip (what the tag modules draw without Tag Styles); every field is a
        /// normalised colour. A chip without a border reports a transparent one.
        /// </summary>
        /// <param name="group">A group id.</param>
        /// <param name="label">A label of the group, or <see cref="TagStyleKeys.AnyLabel"/>.</param>
        /// <returns>The colours.</returns>
        public static TagColors Builtin(string group, string label)
        {
            TagColors c = group switch
            {
                TagStyleKeys.Quality => TagStyleCatalog.Quality.FirstOrDefault(q => q.Label == label) is { Label: not null } q
                    ? new TagColors(q.Background, "rgba(255, 255, 255, 0.15)", q.Text)
                    : new TagColors(Transparent, "rgba(255, 255, 255, 0.15)", White),
                TagStyleKeys.AgeRating => TagStyleCatalog.AgeGroups.FirstOrDefault(a => a.Id == label) is { } a
                    ? new TagColors(a.Background, a.Border, a.Text)
                    : new TagColors("#607D8B", "rgba(255, 255, 255, 0.25)", White),
                TagStyleKeys.Rating => label switch
                {
                    "community" => new TagColors("rgba(0, 0, 0, 0.85)", Transparent, "#ffc107"),
                    "userReview" => new TagColors("rgba(0, 0, 0, 0.8)", Transparent, "#e91e8c"),
                    _ => new TagColors("rgba(0, 0, 0, 0.8)", Transparent, White),
                },
                TagStyleKeys.Genre => new TagColors("rgba(10, 10, 10, 0.8)", "rgba(255, 255, 255, 0.2)", "#E0E0E0"),
                TagStyleKeys.Status => new TagColors("rgba(15, 15, 15, 0.72)", "rgba(255, 255, 255, 0.18)", White),
                TagStyleKeys.Language => new TagColors(Transparent, Transparent, White),
                TagStyleKeys.Awards => new TagColors("rgba(15, 15, 15, 0.85)", Transparent, White),
                _ => Unknown,
            };
            return Normalised(c);
        }

        /// <summary>
        /// The colours a preset gives a chip. Null fields keep the built-in colour; the default preset is all
        /// null, so it changes nothing (no CSS, no native style, the same poster cache key).
        /// </summary>
        /// <param name="preset">A preset id.</param>
        /// <param name="group">A group id.</param>
        /// <param name="label">A label of the group, or <see cref="TagStyleKeys.AnyLabel"/>.</param>
        /// <returns>The colours.</returns>
        public static TagColors Preset(string preset, string group, string label)
        {
            if (!TagStyleKeys.IsGroup(group)) return Unknown;
            var tint = Tint(group, label);
            bool hasBox = group != TagStyleKeys.Rating && group != TagStyleKeys.Language;
            TagColors c = preset switch
            {
                "glass" => group == TagStyleKeys.Language
                    ? new TagColors(null, "rgba(255, 255, 255, 0.35)", null)
                    : new TagColors("rgba(255, 255, 255, 0.16)", "rgba(255, 255, 255, 0.35)", Accent(group, label, White, Gold, "#ff8a8a", "#ff8ac4")),
                "outline" => group == TagStyleKeys.Language
                    ? new TagColors(null, "rgba(255, 255, 255, 0.6)", null)
                    : tint is null
                        ? new TagColors("rgba(0, 0, 0, 0.35)", "rgba(255, 255, 255, 0.6)", White)
                        : new TagColors("rgba(0, 0, 0, 0.35)", tint, tint),
                "dark" => group == TagStyleKeys.Language
                    ? Unknown
                    : new TagColors("rgba(0, 0, 0, 0.82)", hasBox ? Transparent : null, Accent(group, label, White, Gold, "#ff8a8a", "#ff8ac4")),
                "light" => group == TagStyleKeys.Language
                    ? Unknown
                    : new TagColors(
                        "rgba(255, 255, 255, 0.92)",
                        hasBox ? Transparent : null,
                        group == TagStyleKeys.AgeRating ? tint : Accent(group, label, "#111111", "#b8860b", "#c62828", "#ad1457", trendingGold: false)),
                "mono" => group == TagStyleKeys.Language
                    ? new TagColors(null, "rgba(255, 255, 255, 0.2)", null)
                    : new TagColors("rgba(20, 20, 20, 0.75)", "rgba(255, 255, 255, 0.2)", "#e0e0e0"),
                _ => Unknown,
            };
            return Normalised(c);
        }

        /// <summary>
        /// The colours a preset shows for a chip in the editor: the preset's colour where it sets one, else the
        /// built-in colour. Every field is concrete.
        /// </summary>
        /// <param name="preset">A preset id.</param>
        /// <param name="group">A group id.</param>
        /// <param name="label">A label of the group.</param>
        /// <returns>The colours.</returns>
        public static TagColors Concrete(string preset, string group, string label) =>
            Preset(preset, group, label).Over(Builtin(group, label));

        /// <summary>The quality tint a label belongs to (outline preset), by its quality category.</summary>
        /// <param name="label">A quality label, possibly composite ("ATMOS 7.1").</param>
        /// <returns>A hex colour.</returns>
        public static string QualityTint(string label) => QualityTagRules.CategoryOf(label) switch
        {
            QualityTagRules.Resolution => ResolutionTint,
            QualityTagRules.DynamicRange or QualityTagRules.SpecialFormat => DynamicRangeTint,
            QualityTagRules.AudioInfo => AudioTint,
            _ => CodecTint,
        };

        /// <summary>
        /// WCAG 2 contrast ratio of <paramref name="text"/> over <paramref name="background"/>, both composited
        /// over the dark poster backdrop (#262626) the chips usually sit on.
        /// </summary>
        /// <param name="text">Text colour.</param>
        /// <param name="background">Background colour.</param>
        /// <returns>The ratio (1 to 21), or null when a colour does not parse.</returns>
        public static double? Contrast(string? text, string? background)
        {
            if (!CssColor.TryParse(text, out var t) || !CssColor.TryParse(background, out var b)) return null;
            var backdrop = new SKColor(0x26, 0x26, 0x26);
            var bg = Composite(b, backdrop);
            var fg = Composite(t, bg);
            double l1 = Luminance(fg);
            double l2 = Luminance(bg);
            return (Math.Max(l1, l2) + 0.05) / (Math.Min(l1, l2) + 0.05);
        }

        /// <summary>The contrast badge level: "aa" (4.5 and up), "large" (3 and up) or "low".</summary>
        /// <param name="ratio">A contrast ratio.</param>
        /// <returns>The level.</returns>
        public static string ContrastLevel(double ratio) => ratio >= 4.5 ? "aa" : ratio >= 3 ? "large" : "low";

        /// <summary>A colour as the normalised <c>rgba(r, g, b, a)</c> string the model stores, or null.</summary>
        /// <param name="value">Any CSS colour <see cref="CssColor"/> understands.</param>
        /// <returns>The normalised string, or null when it does not parse.</returns>
        public static string? NormaliseColour(string? value)
        {
            if (!CssColor.TryParse(value, out var c)) return null;
            return string.Create(
                CultureInfo.InvariantCulture,
                $"rgba({c.Red}, {c.Green}, {c.Blue}, {Math.Round(c.Alpha / 255.0, 3)})");
        }

        private static TagColors Normalised(TagColors c) =>
            new(NormaliseColour(c.Background), NormaliseColour(c.Border), NormaliseColour(c.Text));

        /// <summary>The outline tint of a chip, or null when the preset draws it white (genre, status, language).</summary>
        private static string? Tint(string group, string label) => group switch
        {
            TagStyleKeys.Quality => QualityTint(label),
            TagStyleKeys.AgeRating => AgeTint(label),
            TagStyleKeys.Rating => label switch { "community" => Gold, "critic" => "#ff6b6b", "userReview" => "#e91e8c", _ => Gold },
            _ => null,
        };

        /// <summary>An age board's own colour; a near-black board (R18+) uses its border colour so it stays visible.</summary>
        private static string AgeTint(string label)
        {
            var b = Builtin(TagStyleKeys.AgeRating, label);
            if (CssColor.TryParse(b.Background, out var bg) && Luminance(bg) < 0.03 && b.Border is not null) return b.Border;
            return b.Background ?? "#607D8B";
        }

        /// <summary>The text colour of the accent presets: gold for community and trending, red for critic.</summary>
        private static string Accent(string group, string label, string plain, string gold, string critic, string userReview, bool trendingGold = true) => (group, label) switch
        {
            (TagStyleKeys.Rating, "community") => gold,
            (TagStyleKeys.Rating, "critic") => critic,
            (TagStyleKeys.Rating, "userReview") => userReview,
            (TagStyleKeys.Status, "trending") when trendingGold => gold,
            _ => plain,
        };

        private static SKColor Composite(SKColor top, SKColor under)
        {
            double a = top.Alpha / 255.0;
            byte Mix(byte t, byte u) => (byte)Math.Round((t * a) + (u * (1 - a)));
            return new SKColor(Mix(top.Red, under.Red), Mix(top.Green, under.Green), Mix(top.Blue, under.Blue));
        }

        private static double Luminance(SKColor c)
        {
            static double Channel(byte v)
            {
                double s = v / 255.0;
                return s <= 0.04045 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
            }

            return (0.2126 * Channel(c.Red)) + (0.7152 * Channel(c.Green)) + (0.0722 * Channel(c.Blue));
        }
    }
}
