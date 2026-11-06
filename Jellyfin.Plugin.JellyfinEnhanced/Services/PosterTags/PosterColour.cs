using System;
using System.Globalization;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>
    /// The Poster Tag Styles preset's colours: a tag's background is the dominant colour of the artwork it sits on,
    /// normalised for legibility. The web (js/tags/tag-poster-colours.js) runs the same algorithm, step for step, on
    /// the card image the browser already shows; tests/poster/parity compares the two on synthetic posters.
    /// </summary>
    /// <remarks>
    /// <para>Algorithm (version <see cref="AlgorithmVersion"/>):</para>
    /// <list type="number">
    /// <item>Downscale the artwork so its longer side is at most <see cref="SampleSize"/> px (linear filtering over
    /// mipmaps, as the browser's <c>createImageBitmap</c> "medium" quality does).</item>
    /// <item>Skip translucent pixels (alpha below 128), near-black (brightest channel below 28) and near-white
    /// (darkest channel above 235) ones: letterbox bars and blank borders are not the artwork's colour.</item>
    /// <item>Count the rest in a 512-bin histogram (3 bits per channel). A bin scores its count times
    /// 256 + 2 × the chroma of its centre, so a colourful area beats an equally large grey one; ties go to the
    /// lower bin. The dominant colour is the rounded average of the winning bin's pixels.</item>
    /// <item>Normalise: a colour with chroma below 24 (a grey poster) gives a neutral dark badge; otherwise
    /// saturation is clamped to 0.45–0.85 and lightness to 0.20–0.42 (HSL), so a red poster yields a red badge. The
    /// text is white when it reaches 4.5:1 over the background, else black (one of the two always does). The border
    /// is the same hue 0.16 lighter (white text) or darker (black text).</item>
    /// </list>
    /// <para>Deliberate difference: the browser samples the image it was served (sized for the card) and the server the
    /// image it draws on; the two downscales can differ by a channel step or two, which the histogram and the
    /// normalisation absorb in practice. Everything after the downscale is integer or plain double arithmetic shared
    /// by both, so equal pixels give equal colours.</para>
    /// </remarks>
    public static class PosterColour
    {
        /// <summary>Bumped when the algorithm changes (the web's persisted cache keys carry it).</summary>
        public const int AlgorithmVersion = 1;

        /// <summary>Longest side, in px, of the downscaled artwork the colour is taken from.</summary>
        public const int SampleSize = 32;

        private const int MinAlpha = 128;
        private const int NearBlack = 28;
        private const int NearWhite = 235;
        private const int GreyChroma = 24;
        private const double MinSaturation = 0.45;
        private const double MaxSaturation = 0.85;
        private const double MinLightness = 0.20;
        private const double MaxLightness = 0.42;
        private const double BorderStep = 0.16;

        /// <summary>The neutral dark badge of a grey or blank poster.</summary>
        public static readonly TagColors Neutral = Colours((40, 40, 40), (88, 88, 88), (255, 255, 255));

        private static readonly Lazy<double> WorstCase = new(ComputeWorstCaseContrast);

        /// <summary>
        /// The lowest text contrast any artwork can produce: the worst case of the normalisation band, over the
        /// whole hue circle, the saturation and lightness band and the neutral badge (the admin editor's badge, which
        /// cannot know the artwork, shows it).
        /// </summary>
        public static double WorstCaseContrast => WorstCase.Value;

        /// <summary>The colours an example artwork (a red poster) gets: the editor's and the panel's sample.</summary>
        public static TagColors Example { get; } = Normalise((178, 34, 34));

        /// <summary>The colours for a poster bitmap (any size or colour type).</summary>
        /// <param name="source">The artwork.</param>
        /// <returns>The normalised colours (<see cref="Neutral"/> when nothing usable is left).</returns>
        public static TagColors Sample(SKBitmap source)
        {
            ArgumentNullException.ThrowIfNull(source);
            int width = source.Width, height = source.Height;
            if (width <= 0 || height <= 0) return Neutral;
            double scale = Math.Min(1.0, (double)SampleSize / Math.Max(width, height));
            int w = Math.Max(1, (int)Math.Floor((width * scale) + 0.5));
            int h = Math.Max(1, (int)Math.Floor((height * scale) + 0.5));
            using var small = new SKBitmap(new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Unpremul));
            if (!source.ScalePixels(small, new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear))) return Neutral;
            return Normalise(Dominant(small.GetPixelSpan(), w, h));
        }

        /// <summary>The dominant colour of RGBA pixels (unpremultiplied, 4 bytes each, row by row).</summary>
        /// <param name="rgba">The pixels.</param>
        /// <param name="width">Width in pixels.</param>
        /// <param name="height">Height in pixels.</param>
        /// <returns>The colour, or null when every pixel was skipped.</returns>
        public static (int R, int G, int B)? Dominant(ReadOnlySpan<byte> rgba, int width, int height)
        {
            Span<int> count = stackalloc int[512];
            Span<long> sumR = stackalloc long[512];
            Span<long> sumG = stackalloc long[512];
            Span<long> sumB = stackalloc long[512];
            count.Clear(); sumR.Clear(); sumG.Clear(); sumB.Clear();
            int pixels = Math.Min(width * height, rgba.Length / 4);
            for (int i = 0; i < pixels; i++)
            {
                int o = i * 4;
                int r = rgba[o], g = rgba[o + 1], b = rgba[o + 2], a = rgba[o + 3];
                if (a < MinAlpha) continue;
                int max = Math.Max(r, Math.Max(g, b)), min = Math.Min(r, Math.Min(g, b));
                if (max < NearBlack || min > NearWhite) continue;
                int bin = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
                count[bin]++;
                sumR[bin] += r; sumG[bin] += g; sumB[bin] += b;
            }

            int best = -1;
            long bestScore = 0;
            for (int bin = 0; bin < 512; bin++)
            {
                if (count[bin] == 0) continue;
                int cr = ((bin >> 6) << 5) + 16, cg = (((bin >> 3) & 7) << 5) + 16, cb = ((bin & 7) << 5) + 16;
                int chroma = Math.Max(cr, Math.Max(cg, cb)) - Math.Min(cr, Math.Min(cg, cb));
                long score = (long)count[bin] * (256 + (2 * chroma));
                if (score > bestScore)
                {
                    bestScore = score;
                    best = bin;
                }
            }

            if (best < 0) return null;
            long n = count[best];
            static int Mean(long sum, long n) => (int)(((2 * sum) + n) / (2 * n));
            return (Mean(sumR[best], n), Mean(sumG[best], n), Mean(sumB[best], n));
        }

        /// <summary>The tag colours for a dominant colour (see the class remarks).</summary>
        /// <param name="dominant">The dominant colour, or null for none.</param>
        /// <returns>Background, border and text colours.</returns>
        public static TagColors Normalise((int R, int G, int B)? dominant)
        {
            if (dominant is not { } c) return Neutral;
            int max = Math.Max(c.R, Math.Max(c.G, c.B)), min = Math.Min(c.R, Math.Min(c.G, c.B));
            int chroma = max - min;
            if (chroma < GreyChroma) return Neutral;
            double hue = max == c.R ? (double)(c.G - c.B) / chroma : max == c.G ? ((double)(c.B - c.R) / chroma) + 2 : ((double)(c.R - c.G) / chroma) + 4;
            if (hue < 0) hue += 6;
            double saturation = Math.Clamp((double)chroma / (255 - Math.Abs(max + min - 255)), MinSaturation, MaxSaturation);
            double lightness = Math.Clamp((max + min) / 510.0, MinLightness, MaxLightness);
            var background = Hsl(hue, saturation, lightness);
            bool white = TextContrast(background, true) >= 4.5;
            var border = Hsl(hue, saturation, Math.Clamp(lightness + (white ? BorderStep : -BorderStep), 0, 1));
            return Colours(background, border, white ? (255, 255, 255) : (0, 0, 0));
        }

        /// <summary>WCAG 2 contrast of white (or black) text over an opaque colour.</summary>
        internal static double TextContrast((int R, int G, int B) background, bool white)
        {
            double l = Luminance(background);
            return white ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
        }

        private static double Luminance((int R, int G, int B) c)
        {
            static double Channel(int v)
            {
                double s = v / 255.0;
                return s <= 0.04045 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
            }

            return (0.2126 * Channel(c.R)) + (0.7152 * Channel(c.G)) + (0.0722 * Channel(c.B));
        }

        /// <summary>HSL (hue in sextants, 0 to 6) to RGB, rounded half up per channel.</summary>
        private static (int R, int G, int B) Hsl(double hue, double saturation, double lightness)
        {
            double c = (1 - Math.Abs((2 * lightness) - 1)) * saturation;
            double x = c * (1 - Math.Abs((hue % 2) - 1));
            double m = lightness - (c / 2);
            var (r, g, b) = (int)hue switch
            {
                0 => (c, x, 0d),
                1 => (x, c, 0d),
                2 => (0d, c, x),
                3 => (0d, x, c),
                4 => (x, 0d, c),
                _ => (c, 0d, x),
            };
            static int Round(double v) => Math.Clamp((int)Math.Floor((v * 255) + 0.5), 0, 255);
            return (Round(r + m), Round(g + m), Round(b + m));
        }

        private static TagColors Colours((int R, int G, int B) background, (int R, int G, int B) border, (int R, int G, int B) text)
        {
            static string Css((int R, int G, int B) c) => string.Create(CultureInfo.InvariantCulture, $"rgba({c.R}, {c.G}, {c.B}, 1)");
            return new TagColors(Css(background), Css(border), Css(text));
        }

        private static double ComputeWorstCaseContrast()
        {
            double worst = TextContrast((40, 40, 40), true);
            for (int h = 0; h < 600; h++)
            {
                for (int s = 0; s <= 8; s++)
                {
                    for (int l = 0; l <= 44; l++)
                    {
                        var bg = Hsl(h / 100.0, MinSaturation + (s * 0.05), MinLightness + (l * 0.005));
                        double onWhite = TextContrast(bg, true);
                        worst = Math.Min(worst, onWhite >= 4.5 ? onWhite : TextContrast(bg, false));
                    }
                }
            }

            return worst;
        }
    }
}
