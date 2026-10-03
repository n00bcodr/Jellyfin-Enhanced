using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using SkiaSharp;
using SkiaSharp.HarfBuzz;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering
{
    /// <summary>
    /// Lays out and draws tag text the way Blink does on a DPR 1 card: HarfBuzz shaping (kerning) with every glyph
    /// advance rounded to whole CSS px (Blink rounds hinted advances when subpixel positioning is off), synthesised
    /// small caps, CSS letter-spacing after every character, and per-character fallback to host fonts for codepoints
    /// the embedded Noto Sans lacks. Layouts are cached; everything here is thread-safe.
    /// </summary>
    internal sealed class PosterTagText : IDisposable
    {
        private const int MaxCachedLayouts = 4096;
        private const int MaxCachedShapes = 4096;
        private const int MaxCachedFallbacks = 4096;

        private readonly SKTypeface _primary;
        private readonly ConcurrentDictionary<LayoutKey, PosterTagTextLayout> _layouts = new();
        private readonly ConcurrentDictionary<(SKTypeface Face, string Text), ShapedRun> _shapes = new();
        private readonly ConcurrentDictionary<int, SKTypeface?> _fallbacks = new();
        private readonly HashSet<SKTypeface> _fallbackFaces = new(ReferenceEqualityComparer.Instance);
        private readonly Dictionary<SKTypeface, IDisposable> _shapers = new();
        private readonly object _shaperGate = new();
        private bool _harfBuzzUnavailable;
        private bool _disposed;

        public PosterTagText(SKTypeface primary)
        {
            _primary = primary;
        }

        /// <summary>True once HarfBuzz could not be loaded and text falls back to unshaped glyph advances.</summary>
        public bool HarfBuzzUnavailable => Volatile.Read(ref _harfBuzzUnavailable);

        /// <summary>
        /// Text layout in CSS px for <paramref name="text"/> at <paramref name="fontSize"/>. Glyph positions are relative
        /// to the start of the text; <see cref="PosterTagTextLayout.Width"/> includes trailing letter-spacing like CSS.
        /// </summary>
        public PosterTagTextLayout Layout(string text, float fontSize, bool smallCaps, float letterSpacing)
        {
            var key = new LayoutKey(text, fontSize, smallCaps, letterSpacing);
            if (_layouts.TryGetValue(key, out var cached))
            {
                return cached;
            }

            var layout = BuildLayout(text, fontSize, smallCaps, letterSpacing);
            if (_layouts.Count >= MaxCachedLayouts)
            {
                _layouts.Clear();
            }

            return _layouts.GetOrAdd(key, layout);
        }

        /// <summary>Draws <paramref name="layout"/> with its origin at (<paramref name="x"/>, <paramref name="baseline"/>).</summary>
        public static void Draw(SKCanvas canvas, PosterTagTextLayout layout, float x, float baseline, SKPaint paint, bool subpixel)
        {
            foreach (var run in layout.Runs)
            {
                using var font = new SKFont(run.Typeface, run.FontSize)
                {
                    Edging = SKFontEdging.Antialias,
                    Hinting = SKFontHinting.Slight,
                    Subpixel = subpixel,
                };
                using var builder = new SKTextBlobBuilder();
                if (run.OffsetsY is { } offsetsY)
                {
                    // Marks HarfBuzz raised or lowered (combining diacritics): position every glyph in 2D.
                    var buffer = builder.AllocatePositionedRun(font, run.Glyphs.Length);
                    run.Glyphs.AsSpan().CopyTo(buffer.Glyphs);
                    var points = buffer.Positions;
                    for (int i = 0; i < points.Length; i++)
                    {
                        points[i] = new SKPoint(run.Positions[i], offsetsY[i]);
                    }
                }
                else
                {
                    var buffer = builder.AllocateHorizontalRun(font, run.Glyphs.Length, 0);
                    run.Glyphs.AsSpan().CopyTo(buffer.Glyphs);
                    run.Positions.AsSpan().CopyTo(buffer.Positions);
                }

                using var blob = builder.Build();
                if (blob is not null)
                {
                    canvas.DrawText(blob, x, baseline, paint);
                }
            }
        }

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            lock (_shaperGate)
            {
                foreach (var shaper in _shapers.Values)
                {
                    shaper.Dispose();
                }

                _shapers.Clear();
            }

            // Host fallback faces are not ours to dispose: SkiaSharp hands every caller of the font manager the same
            // managed wrapper for a font, so Jellyfin's own drawing code in this process may be using them (SkiaSharp
            // 3.116/3.119 happen to ignore Dispose on them; don't rely on it). They are only forgotten here. The
            // embedded primary face is the renderer's own and PosterTagAssets disposes it.
            lock (_fallbackFaces)
            {
                _fallbackFaces.Clear();
            }

            _fallbacks.Clear();
            _layouts.Clear();
            _shapes.Clear();
        }

        private PosterTagTextLayout BuildLayout(string text, float fontSize, bool smallCaps, float letterSpacing)
        {
            var runs = new List<PosterTagTextRun>();
            float pen = 0f;
            foreach (var (runText, face, small) in Segment(text, smallCaps))
            {
                // Blink's synthetic small caps font: lroundf(computed size * 0.7) (SimpleFontData::CreateScaledFontData).
                float size = small ? PosterTagCss.RoundHalfUp(fontSize * PosterTagCss.SmallCapsScale) : fontSize;
                var shaped = Shape(face, runText);
                var positions = new float[shaped.Glyphs.Length];
                float[]? offsetsY = shaped.OffsetsY is null ? null : new float[shaped.Glyphs.Length];
                for (int i = 0; i < shaped.Glyphs.Length; i++)
                {
                    positions[i] = pen;
                    if (offsetsY is not null)
                    {
                        offsetsY[i] = shaped.OffsetsY![i] * size;
                    }

                    // Blink (DPR 1, no subpixel positioning) rounds each hinted advance to whole px; GPOS kerning from
                    // HarfBuzz is added on top unrounded.
                    float nominal = shaped.Advances[i] * size;
                    float kern = shaped.Kerning[i] * size;
                    pen += PosterTagCss.RoundHalfUp(nominal) + kern + letterSpacing;
                }

                runs.Add(new PosterTagTextRun(face, size, shaped.Glyphs, positions, offsetsY));
            }

            return new PosterTagTextLayout(runs, pen);
        }

        /// <summary>Splits text into runs of one typeface and one small-caps state, uppercasing small-caps runs.</summary>
        private IEnumerable<(string Text, SKTypeface Face, bool Small)> Segment(string text, bool smallCaps)
        {
            var sb = new StringBuilder();
            SKTypeface? runFace = null;
            bool runSmall = false;
            var e = StringInfo.GetTextElementEnumerator(text);
            var results = new List<(string, SKTypeface, bool)>();
            while (e.MoveNext())
            {
                var element = e.GetTextElement();
                bool small = false;
                if (smallCaps)
                {
                    var upper = element.ToUpperInvariant();
                    if (!string.Equals(upper, element, StringComparison.Ordinal) && char.IsLower(element, 0))
                    {
                        small = true;
                        element = upper;
                    }
                }

                var face = FaceFor(char.ConvertToUtf32(element, 0));
                if (runFace is not null && (!ReferenceEquals(face, runFace) || small != runSmall))
                {
                    results.Add((sb.ToString(), runFace, runSmall));
                    sb.Clear();
                }

                runFace = face;
                runSmall = small;
                sb.Append(element);
            }

            if (runFace is not null && sb.Length > 0)
            {
                results.Add((sb.ToString(), runFace, runSmall));
            }

            return results;
        }

        private SKTypeface FaceFor(int codepoint)
        {
            if (codepoint < 0x20 || _primary.ContainsGlyph(codepoint))
            {
                return _primary;
            }

            if (_fallbacks.TryGetValue(codepoint, out var cached))
            {
                return cached ?? _primary;
            }

            var fallback = MatchFallback(codepoint);
            // The codepoint index is bounded like the layout cache. Clearing it is safe: the faces themselves stay in
            // _fallbackFaces (one per host font, so bounded), which cached layouts and shapes reference.
            if (_fallbacks.Count >= MaxCachedFallbacks)
            {
                _fallbacks.Clear();
            }

            return _fallbacks.GetOrAdd(codepoint, fallback) ?? _primary;
        }

        /// <summary>The host font for <paramref name="codepoint"/>, one face per host font however many codepoints map to it.</summary>
        private SKTypeface? MatchFallback(int codepoint)
        {
            SKTypeface? face;
            try
            {
                face = SKFontManager.Default.MatchCharacter("Noto Sans", SKFontStyle.Bold, null, codepoint);
            }
            catch (Exception)
            {
                return null;
            }

            if (face is null)
            {
                return null;
            }

            // Skia's font managers return the same typeface (so the same managed wrapper) for every match in one font;
            // should one hand out a fresh wrapper per call, reuse the face already known for that font instead. Never
            // dispose a matched face (see Dispose): the wrapper may be shared with other code in the process.
            lock (_fallbackFaces)
            {
                if (_fallbackFaces.Contains(face))
                {
                    return face;
                }

                foreach (var known in _fallbackFaces)
                {
                    if (SameFont(known, face))
                    {
                        return known;
                    }
                }

                _fallbackFaces.Add(face);
                return face;
            }
        }

        private static bool SameFont(SKTypeface a, SKTypeface b)
            => string.Equals(a.FamilyName, b.FamilyName, StringComparison.Ordinal)
                && a.FontWeight == b.FontWeight
                && a.FontWidth == b.FontWidth
                && a.FontSlant == b.FontSlant;

        /// <summary>Glyphs, nominal advances, kerning and vertical mark offsets of one run, per 1px of font size.</summary>
        private ShapedRun Shape(SKTypeface face, string text)
        {
            if (_shapes.TryGetValue((face, text), out var cached))
            {
                return cached;
            }

            float upm = face.UnitsPerEm > 0 ? face.UnitsPerEm : 1000f;
            using var font = new SKFont(face, upm) { Hinting = SKFontHinting.None, LinearMetrics = true, Subpixel = true };

            ushort[] glyphs;
            float[]? shapedAdvances = null;
            float[]? offsetsY = null;
            if (!HarfBuzzUnavailable && TryShapeWithHarfBuzz(face, text, font, out var hbGlyphs, out var hbAdvances, out var hbOffsetsY))
            {
                glyphs = hbGlyphs;
                shapedAdvances = hbAdvances;
                if (hbOffsetsY is not null)
                {
                    offsetsY = new float[hbOffsetsY.Length];
                    for (int i = 0; i < offsetsY.Length; i++)
                    {
                        offsetsY[i] = hbOffsetsY[i] / upm;
                    }
                }
            }
            else
            {
                glyphs = font.GetGlyphs(text);
            }

            var nominal = font.GetGlyphWidths(glyphs);
            var advances = new float[glyphs.Length];
            var kerning = new float[glyphs.Length];
            for (int i = 0; i < glyphs.Length; i++)
            {
                advances[i] = nominal[i] / upm;
                if (shapedAdvances is not null)
                {
                    float delta = shapedAdvances[i] - nominal[i];
                    // HarfBuzz positions come back quantised to 1/512 em; ignore that noise, keep real GPOS kerning.
                    kerning[i] = Math.Abs(delta) < upm / 256f ? 0f : delta / upm;
                }
            }

            var run = new ShapedRun(glyphs, advances, kerning, offsetsY);
            if (_shapes.Count >= MaxCachedShapes)
            {
                _shapes.Clear();
            }

            return _shapes.GetOrAdd((face, text), run);
        }

        private bool TryShapeWithHarfBuzz(SKTypeface face, string text, SKFont font, out ushort[] glyphs, out float[] advances, out float[]? offsetsY)
        {
            glyphs = Array.Empty<ushort>();
            advances = Array.Empty<float>();
            offsetsY = null;
            try
            {
                lock (_shaperGate)
                {
                    ObjectDisposedException.ThrowIf(_disposed, this);
                    if (!_shapers.TryGetValue(face, out var shaper))
                    {
                        shaper = HarfBuzzBridge.CreateShaper(face);
                        _shapers[face] = shaper;
                    }

                    return HarfBuzzBridge.Shape(shaper, text, font, out glyphs, out advances, out offsetsY);
                }
            }
            catch (ObjectDisposedException)
            {
                throw;
            }
            catch (Exception)
            {
                // SkiaSharp.HarfBuzz / HarfBuzzSharp missing or broken on this host: keep drawing, unshaped.
                Volatile.Write(ref _harfBuzzUnavailable, true);
                return false;
            }
        }

        private readonly record struct LayoutKey(string Text, float FontSize, bool SmallCaps, float LetterSpacing);

        /// <param name="OffsetsY">Per-glyph baseline offsets (y down), or null when every glyph sits on the baseline.</param>
        private sealed record ShapedRun(ushort[] Glyphs, float[] Advances, float[] Kerning, float[]? OffsetsY);

        /// <summary>
        /// Every reference to SkiaSharp.HarfBuzz lives here, behind non-inlined methods, so a host without the assembly
        /// fails inside <see cref="TryShapeWithHarfBuzz"/>'s try block instead of when the caller is compiled.
        /// </summary>
        private static class HarfBuzzBridge
        {
            [MethodImpl(MethodImplOptions.NoInlining)]
            public static IDisposable CreateShaper(SKTypeface face) => new SKShaper(face);

            /// <remarks>
            /// SKShaper reports each glyph's pen position plus its HarfBuzz offset. The x offsets stay in the advances
            /// (the distance to the next glyph's point); the y offsets (already y down) are returned separately, null
            /// when all are zero.
            /// </remarks>
            [MethodImpl(MethodImplOptions.NoInlining)]
            public static bool Shape(IDisposable shaper, string text, SKFont font, out ushort[] glyphs, out float[] advances, out float[]? offsetsY)
            {
                var result = ((SKShaper)shaper).Shape(text, font);
                int n = result.Codepoints.Length;
                glyphs = new ushort[n];
                advances = new float[n];
                offsetsY = null;
                for (int i = 0; i < n; i++)
                {
                    glyphs[i] = (ushort)result.Codepoints[i];
                    float next = i + 1 < n ? result.Points[i + 1].X : result.Width;
                    advances[i] = next - result.Points[i].X;
                    if (result.Points[i].Y != 0f)
                    {
                        offsetsY ??= new float[n];
                        offsetsY[i] = result.Points[i].Y;
                    }
                }

                return n > 0 || text.Length == 0;
            }
        }
    }

    /// <summary>
    /// One shaped run: a typeface at one size with glyph x positions in CSS px and, when a glyph leaves the baseline
    /// (a raised or lowered mark), per-glyph y offsets in CSS px (y down).
    /// </summary>
    internal sealed record PosterTagTextRun(SKTypeface Typeface, float FontSize, ushort[] Glyphs, float[] Positions, float[]? OffsetsY = null);

    /// <summary>Laid-out text: runs plus the advance width in CSS px.</summary>
    internal sealed record PosterTagTextLayout(IReadOnlyList<PosterTagTextRun> Runs, float Width);
}
