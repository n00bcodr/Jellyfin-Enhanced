using System;
using System.Globalization;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering
{
    /// <summary>
    /// The web tags' CSS, evaluated for one logical card width. Every length is in CSS px of a card
    /// <see cref="CardWidth"/> px wide (the container-query rules in tag-pipeline.js and ageratingtags.js);
    /// the renderer scales them to the image afterwards.
    /// </summary>
    internal readonly struct PosterTagCss
    {
        /// <summary>Logical card width of a portrait poster, in CSS px.</summary>
        public const float PortraitCardWidth = 180f;

        /// <summary>Logical card width of a landscape (thumb) card, in CSS px.</summary>
        public const float LandscapeCardWidth = 290f;

        /// <summary>Distance of every tag container from the two edges of its corner.</summary>
        public const float CornerInset = 6f;

        /// <summary>Gap the corner stacking leaves between containers sharing a corner (CORNER_STACK_GAP).</summary>
        public const float CornerStackGap = 4f;

        /// <summary>
        /// <c>margin-top: clamp(20px, 3vw, 30px)</c> for top-right containers when the card shows a played or count
        /// indicator; 30 at every desktop/TV viewport.
        /// </summary>
        public const float TopRightIndicatorOffset = 30f;

        /// <summary>Fixed size of the user-review <c>person_heart</c> icon (<c>font-size: 14px !important</c>).</summary>
        public const float UserReviewIconSize = 14f;

        /// <summary>Synthesised small caps: lowercase letters drawn as capitals at this fraction of the font size (rounded).</summary>
        public const float SmallCapsScale = 0.7f;

        public PosterTagCss(float cardWidth)
        {
            CardWidth = cardWidth;
            float cqw = cardWidth / 100f;

            QualityFontSize = Clamp(9f, 6.6f * cqw, 13.6f);
            QualityPaddingV = Clamp(0f, 0.6f * cqw, 2f);
            QualityPaddingH = Clamp(4f, 4.2f * cqw, 10f);
            QualityRadius = Clamp(2f, 2.4f * cqw, 5f);
            QualityGap = Clamp(1f, 1.8f * cqw, 4f);

            GenreSize = Clamp(18f, 15f * cqw, 30f);
            GenreGlyphSize = Clamp(11f, 9.5f * cqw, 20f);
            GenreGap = Clamp(2f, 1.8f * cqw, 4f);

            FlagWidth = Clamp(16f, 15f * cqw, 32f);
            LanguageGap = Clamp(1f, 1.8f * cqw, 3f);

            RatingGap = Clamp(2f, 1.8f * cqw, 3f);
            ChipFontSize = Clamp(9f, 6.8f * cqw, 13f);
            ChipPaddingV = Clamp(2f, 2f * cqw, 4f);
            ChipPaddingH = Clamp(4f, 4.5f * cqw, 8f);
            RatingInnerGap = Clamp(2f, 2.2f * cqw, 4f);
            RatingIconSize = Clamp(9f, 7f * cqw, 14f);
        }

        public float CardWidth { get; }

        public float QualityFontSize { get; }

        public float QualityPaddingV { get; }

        public float QualityPaddingH { get; }

        public float QualityRadius { get; }

        public float QualityGap { get; }

        /// <summary>Genre circle content size (border-box adds the 1px border on each side).</summary>
        public float GenreSize { get; }

        public float GenreGlyphSize { get; }

        public float GenreGap { get; }

        public float FlagWidth { get; }

        public float LanguageGap { get; }

        public float RatingGap { get; }

        /// <summary>Font size of rating chips and the age badge.</summary>
        public float ChipFontSize { get; }

        /// <summary>Vertical padding of rating chips and the age badge.</summary>
        public float ChipPaddingV { get; }

        /// <summary>Horizontal padding of rating chips and the age badge.</summary>
        public float ChipPaddingH { get; }

        public float RatingInnerGap { get; }

        /// <summary>Star glyph size and tomato box size.</summary>
        public float RatingIconSize { get; }

        private static float Clamp(float min, float value, float max) => Math.Max(min, Math.Min(max, value));

        /// <summary>
        /// Blink's LayoutUnit: lengths are truncated to 1/64 px when they enter layout. Matching it keeps chip boxes
        /// identical to the web's (e.g. 1.08px padding lays out as 1.078125px).
        /// </summary>
        public static float Lu(float value) => (float)(Math.Floor((value * 64.0) + 1e-6) / 64.0);

        /// <summary>Text runs enter layout rounded up to the next LayoutUnit.</summary>
        public static float LuCeil(float value) => (float)(Math.Ceiling((value * 64.0) - 1e-6) / 64.0);

        /// <summary>Skia's SkScalarRoundToInt (floor(x + 0.5)), used by Blink for hinted advances and metrics.</summary>
        public static float RoundHalfUp(float value) => MathF.Floor(value + 0.5f);
    }

    /// <summary>Parses the CSS colour syntax used by the tag styles (rgb[a](), #rgb[a], #rrggbb[aa], a few names).</summary>
    internal static class CssColor
    {
        /// <summary>Parses <paramref name="value"/>; returns <paramref name="fallback"/> when it is empty or unknown.</summary>
        public static SKColor Parse(string? value, SKColor fallback)
        {
            return TryParse(value, out var color) ? color : fallback;
        }

        public static bool TryParse(string? value, out SKColor color)
        {
            color = SKColors.Transparent;
            if (string.IsNullOrWhiteSpace(value))
            {
                return false;
            }

            var s = value.Trim().ToLowerInvariant();
            if (s.StartsWith('#'))
            {
                var hex = s.Substring(1);
                if (hex.Length is 3 or 4)
                {
                    hex = ExpandShortHex(hex);
                }

                if (hex.Length is not (6 or 8) || !uint.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var v))
                {
                    return false;
                }

                color = hex.Length == 6
                    ? new SKColor((byte)(v >> 16), (byte)(v >> 8), (byte)v)
                    : new SKColor((byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v);
                return true;
            }

            if (s.StartsWith("rgb", StringComparison.Ordinal))
            {
                int open = s.IndexOf('(');
                int close = s.LastIndexOf(')');
                if (open < 0 || close <= open)
                {
                    return false;
                }

                var parts = s.Substring(open + 1, close - open - 1).Split(new[] { ',', ' ', '/' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length is not (3 or 4))
                {
                    return false;
                }

                Span<byte> c = stackalloc byte[3];
                for (int i = 0; i < 3; i++)
                {
                    if (!float.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var f))
                    {
                        return false;
                    }

                    c[i] = (byte)Math.Clamp(MathF.Round(f), 0f, 255f);
                }

                float a = 1f;
                if (parts.Length == 4)
                {
                    var p = parts[3];
                    bool percent = p.EndsWith('%');
                    if (!float.TryParse(percent ? p.TrimEnd('%') : p, NumberStyles.Float, CultureInfo.InvariantCulture, out a))
                    {
                        return false;
                    }

                    if (percent)
                    {
                        a /= 100f;
                    }
                }

                color = new SKColor(c[0], c[1], c[2], AlphaByte(a));
                return true;
            }

            switch (s)
            {
                case "red": color = new SKColor(0xFF, 0x00, 0x00); return true;
                case "white": color = SKColors.White; return true;
                case "black": color = SKColors.Black; return true;
                case "transparent": color = SKColors.Transparent; return true;
                default: return false;
            }
        }

        /// <summary>CSS opacity / alpha (0..1) to an 8-bit alpha, rounding like Skia's float-to-byte conversion.</summary>
        public static byte AlphaByte(float alpha) => (byte)Math.Clamp(MathF.Round(Math.Clamp(alpha, 0f, 1f) * 255f), 0f, 255f);

        private static string ExpandShortHex(string hex)
        {
            Span<char> chars = stackalloc char[hex.Length * 2];
            for (int i = 0; i < hex.Length; i++)
            {
                chars[2 * i] = hex[i];
                chars[(2 * i) + 1] = hex[i];
            }

            return new string(chars);
        }
    }
}
