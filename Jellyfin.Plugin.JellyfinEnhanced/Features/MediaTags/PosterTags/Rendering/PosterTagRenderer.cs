using System;
using System.Threading;
using System.Linq;
using SkiaSharp;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags.PosterTags.Rendering;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering
{
    /// <summary>
    /// Draws JE's card tags (quality, genre, rating + user review, age rating, language) into a poster or thumb the
    /// way jellyfin-web shows them on a card: the image is treated as a card 180 CSS px wide (290 for landscape) and
    /// the web's layout is scaled to the image's pixels.
    /// </summary>
    /// <remarks>
    /// One shared instance serves every request: it is thread-safe, loads its embedded assets on first use and caches
    /// shaped text and pre-rendered tag tiles (chips with their blurred shadows, clipped flags), so a warm render is a
    /// handful of blits. Disposing stops new renders and releases every native object once the last in-flight render
    /// has finished.
    /// </remarks>
    public sealed class PosterTagRenderer : IDisposable
    {
        /// <summary>Output version. Bump whenever the pixels change; it is part of the image URL token.</summary>
        // Flush edge treatment changes pixels; Default, Tight and Bands retain their painting path.
        public const string Version = "9";

        /// <summary>Largest image side, in pixels, the renderer accepts; larger images are left untouched.</summary>
        public const int MaxImageDimension = 4096;

        internal const string StarIconKey = "MaterialIcons:star";
        internal const string UserReviewIconKey = "MaterialSymbolsRounded:person_heart";

        private const long DefaultTileCacheBytes = 32L * 1024 * 1024;

        // Tag colours that are not in the generated tables (ratingtags.js, genretags.js, userreviewtags.js).
        private static readonly SKColor QualityBorder = new(255, 255, 255, CssColor.AlphaByte(0.15f));
        private static readonly SKColor GenreBackground = new(10, 10, 10, CssColor.AlphaByte(0.8f));
        private static readonly SKColor GenreBorder = new(255, 255, 255, CssColor.AlphaByte(0.2f));
        private static readonly SKColor GenreGlyph = new(0xE0, 0xE0, 0xE0);
        private static readonly SKColor CommunityBackground = new(0, 0, 0, CssColor.AlphaByte(0.85f));
        private static readonly SKColor CriticBackground = new(0, 0, 0, CssColor.AlphaByte(0.8f));
        private static readonly SKColor CommunityText = new(0xFF, 0xC1, 0x07);
        private static readonly SKColor UserReviewText = new(0xE9, 0x1E, 0x8C);
        private static readonly SKColor PartialOutline = new(255, 255, 255, CssColor.AlphaByte(0.95f));

        // box-shadow values: (offset y, blur radius, colour). CSS blur radius B is a Gaussian with sigma B/2.
        private static readonly BoxShadow QualityShadow = new(1f, 4f, 0f, new SKColor(0, 0, 0, CssColor.AlphaByte(0.4f)));
        private static readonly BoxShadow GenreShadow = QualityShadow;
        private static readonly BoxShadow ChipShadow = new(2f, 4f, 0f, new SKColor(0, 0, 0, CssColor.AlphaByte(0.3f)));
        private static readonly BoxShadow FlagShadow = new(1f, 3f, 0f, new SKColor(0, 0, 0, CssColor.AlphaByte(0.4f)));
        private static readonly BoxShadow PartialFlagRing = new(0f, 0f, 1f, new SKColor(0, 0, 0, CssColor.AlphaByte(0.6f)));
        private static readonly SKColor TextShadowColor = new(0, 0, 0, CssColor.AlphaByte(0.6f));
        private static readonly SKColor CustomBackground = new(38, 50, 56, CssColor.AlphaByte(0.88f));
        private static readonly SKColor CustomBorder = new(255, 255, 255, CssColor.AlphaByte(0.22f));

        // CSS filter: saturate(0.5), in sRGB like Chrome's filter functions.
        private static readonly float[] Saturate50 =
        {
            0.6063f, 0.3576f, 0.0361f, 0f, 0f,
            0.1063f, 0.8576f, 0.0361f, 0f, 0f,
            0.1063f, 0.3576f, 0.5361f, 0f, 0f,
            0f, 0f, 0f, 1f, 0f,
        };

        private readonly Lazy<Engine> _engine;
        private int _active;
        private int _disposed;
        private int _released;

        /// <summary>Initializes a new instance of the <see cref="PosterTagRenderer"/> class. Assets load on first render.</summary>
        public PosterTagRenderer()
            : this(DefaultTileCacheBytes)
        {
        }

        /// <summary>Creates a renderer with a custom tile cache budget (0 disables tile caching).</summary>
        /// <param name="tileCacheBytes">Byte budget of the pre-rendered tile cache.</param>
        internal PosterTagRenderer(long tileCacheBytes)
        {
            _engine = new Lazy<Engine>(() => new Engine(PosterTagAssets.Load(), tileCacheBytes), LazyThreadSafetyMode.ExecutionAndPublication);
        }

        /// <summary>
        /// Draws <paramref name="layout"/> onto a copy of <paramref name="source"/> of the same size.
        /// </summary>
        /// <param name="source">The poster or thumb, any colour type. Not modified.</param>
        /// <param name="layout">The resolved tags.</param>
        /// <returns>
        /// A new bitmap owned by the caller, or null when nothing would be drawn (empty layout, no drawable tag) or the
        /// image is empty or larger than <see cref="MaxImageDimension"/> on a side.
        /// </returns>
        public SKBitmap? Render(SKBitmap source, PosterTagLayout layout)
        {
            ArgumentNullException.ThrowIfNull(source);
            ArgumentNullException.ThrowIfNull(layout);
            if (layout.IsEmpty || !IsSupportedSize(source.Width, source.Height) || source.IsNull)
            {
                return null;
            }

            if (!TryEnter())
            {
                return null;
            }

            try
            {
                var engine = _engine.Value;
                // Poster preset: the chips take this artwork's colours (the planner resolves them into every tile key).
                if (layout.Styles is { IsPoster: true, Sampled: null } styles)
                {
                    layout = layout with { Styles = styles.WithSampled(PosterColour.Sample(source)) };
                }

                var plan = engine.Planner.Plan(source.Width, source.Height, layout);
                if (plan.Groups.Count == 0)
                {
                    return null;
                }

                var info = new SKImageInfo(source.Width, source.Height, SKImageInfo.PlatformColorType, SKAlphaType.Premul, source.ColorSpace);
                var result = new SKBitmap();
                if (!result.TryAllocPixels(info))
                {
                    result.Dispose();
                    return null;
                }

                try
                {
                    using var canvas = new SKCanvas(result);
                    using (var copy = new SKPaint { BlendMode = SKBlendMode.Src })
                    {
                        canvas.DrawBitmap(source, 0, 0, copy);
                    }

                    engine.Draw(canvas, plan);
                    canvas.Flush();
                    return result;
                }
                catch
                {
                    result.Dispose();
                    throw;
                }
            }
            finally
            {
                Exit();
            }
        }

        /// <summary>
        /// Decodes <paramref name="source"/>, draws <paramref name="layout"/> and encodes the result in the same format.
        /// </summary>
        /// <remarks>
        /// Encoding: JPEG and WebP are encoded lossy at <paramref name="jpegQuality"/>, PNG losslessly. WebP being lossy
        /// is deliberate and departs from the original design note ("png/webp lossless"): it is what Jellyfin itself
        /// serves, as its SkiaEncoder encodes WebP at the request's quality like JPEG (lossy below 100), and lossless
        /// WebP of photographic artwork would be several times the size of the image it replaces. Pass 100 to get
        /// lossless WebP.
        /// </remarks>
        /// <param name="source">Encoded JPEG, PNG or WebP bytes.</param>
        /// <param name="contentType">The source's MIME type (image/jpeg, image/png or image/webp).</param>
        /// <param name="jpegQuality">Encoder quality (1-100) for the lossy formats, JPEG and WebP; 100 makes WebP lossless. PNG is always lossless.</param>
        /// <param name="layout">The resolved tags.</param>
        /// <returns>The encoded composite, or null when nothing was drawn or the input cannot be handled.</returns>
        public byte[]? RenderEncoded(ReadOnlySpan<byte> source, string contentType, int jpegQuality, PosterTagLayout layout)
        {
            ArgumentNullException.ThrowIfNull(layout);
            if (layout.IsEmpty || source.IsEmpty)
            {
                return null;
            }

            var format = OutputFormat(contentType);
            if (format is null)
            {
                return null;
            }

            using var data = SKData.CreateCopy(source);
            using var codec = SKCodec.Create(data);
            if (codec is null)
            {
                return null;
            }

            var encoded = codec.Info;
            if (!IsSupportedSize(encoded.Width, encoded.Height))
            {
                return null;
            }

            var alpha = encoded.AlphaType == SKAlphaType.Opaque ? SKAlphaType.Opaque : SKAlphaType.Premul;
            using var decoded = SKBitmap.Decode(codec, new SKImageInfo(encoded.Width, encoded.Height, SKImageInfo.PlatformColorType, alpha, encoded.ColorSpace));
            if (decoded is null)
            {
                return null;
            }

            // Re-encoding drops EXIF, so apply the orientation the client would otherwise have applied.
            using var oriented = ApplyOrigin(decoded, codec.EncodedOrigin);
            using var rendered = Render(oriented ?? decoded, layout);
            if (rendered is null)
            {
                return null;
            }

            using var image = SKImage.FromBitmap(rendered);
            using var output = image.Encode(format.Value, Math.Clamp(jpegQuality, 1, 100));
            return output?.ToArray();
        }

        /// <summary>
        /// Stops accepting renders and releases the cached assets and tiles: now when idle, otherwise when the last
        /// in-flight render finishes (never under a render still drawing with them).
        /// </summary>
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1)
            {
                return;
            }

            // Pairs with TryEnter/Exit: a render either saw _disposed and backed out, or is counted in _active and the
            // last one to leave releases the engine.
            if (Volatile.Read(ref _active) == 0)
            {
                ReleaseEngine();
            }
        }

        /// <summary>Maps a layout flag code to its asset ("no-dialogue" and "zxx" share the no-dialogue artwork).</summary>
        internal static string? FlagAssetCode(string? flagCode)
        {
            if (string.IsNullOrWhiteSpace(flagCode))
            {
                return null;
            }

            var code = flagCode.Trim().ToLowerInvariant();
            return code == "no-dialogue" ? "zxx" : code;
        }

        /// <summary>Plans <paramref name="layout"/> for an image of the given size (harness and diagnostics).</summary>
        internal PosterTagPlan Plan(int width, int height, PosterTagLayout layout) => _engine.Value.Planner.Plan(width, height, layout);

        /// <summary>Drops cached tiles (harness: cold-cache measurements).</summary>
        internal void ClearTileCache() => _engine.Value.Tiles.Clear();

        /// <summary>Bytes held by cached tiles (harness: allocation bounds).</summary>
        internal long TileCacheBytes => _engine.IsValueCreated ? _engine.Value.Tiles.Bytes : 0;

        /// <summary>Number of cached tiles (harness: cache key bounds).</summary>
        internal int TileCacheCount => _engine.IsValueCreated ? _engine.Value.Tiles.Count : 0;

        /// <summary>True when HarfBuzz could not be loaded on this host and text is drawn unshaped.</summary>
        internal bool HarfBuzzUnavailable => _engine.IsValueCreated && _engine.Value.Text.HarfBuzzUnavailable;

        private static bool IsSupportedSize(int width, int height)
            => width > 0 && height > 0 && width <= MaxImageDimension && height <= MaxImageDimension;

        private static SKEncodedImageFormat? OutputFormat(string? contentType)
        {
            if (string.IsNullOrWhiteSpace(contentType))
            {
                return null;
            }

            var type = contentType.Split(';', 2)[0].Trim().ToLowerInvariant();
            return type switch
            {
                "image/jpeg" or "image/jpg" or "image/pjpeg" => SKEncodedImageFormat.Jpeg,
                "image/png" => SKEncodedImageFormat.Png,
                "image/webp" => SKEncodedImageFormat.Webp,
                _ => null,
            };
        }

        private static SKBitmap? ApplyOrigin(SKBitmap bitmap, SKEncodedOrigin origin)
        {
            if (origin == SKEncodedOrigin.TopLeft || (int)origin == 0)
            {
                return null;
            }

            bool swap = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
            int w = swap ? bitmap.Height : bitmap.Width;
            int h = swap ? bitmap.Width : bitmap.Height;
            var result = new SKBitmap(new SKImageInfo(w, h, bitmap.ColorType, bitmap.AlphaType, bitmap.ColorSpace));
            using var canvas = new SKCanvas(result);
            var m = origin switch
            {
                SKEncodedOrigin.TopRight => new SKMatrix(-1, 0, w, 0, 1, 0, 0, 0, 1),
                SKEncodedOrigin.BottomRight => new SKMatrix(-1, 0, w, 0, -1, h, 0, 0, 1),
                SKEncodedOrigin.BottomLeft => new SKMatrix(1, 0, 0, 0, -1, h, 0, 0, 1),
                SKEncodedOrigin.LeftTop => new SKMatrix(0, 1, 0, 1, 0, 0, 0, 0, 1),
                SKEncodedOrigin.RightTop => new SKMatrix(0, -1, w, 1, 0, 0, 0, 0, 1),
                SKEncodedOrigin.RightBottom => new SKMatrix(0, -1, w, -1, 0, h, 0, 0, 1),
                SKEncodedOrigin.LeftBottom => new SKMatrix(0, 1, 0, -1, 0, h, 0, 0, 1),
                _ => SKMatrix.Identity,
            };
            canvas.SetMatrix(m);
            canvas.DrawBitmap(bitmap, 0, 0);
            return result;
        }

        private bool TryEnter()
        {
            Interlocked.Increment(ref _active);
            if (Volatile.Read(ref _disposed) == 1)
            {
                Exit();
                return false;
            }

            return true;
        }

        private void Exit()
        {
            if (Interlocked.Decrement(ref _active) == 0 && Volatile.Read(ref _disposed) == 1)
            {
                ReleaseEngine();
            }
        }

        private void ReleaseEngine()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0 && _engine.IsValueCreated)
            {
                _engine.Value.Dispose();
            }
        }

        private readonly record struct BoxShadow(float OffsetY, float Blur, float Spread, SKColor Color);

        /// <summary>Where a tile's local CSS-px space sits in its pixels: device = Offset + local * Scale.</summary>
        private readonly record struct TileSpace(float Scale, float OffsetX, float OffsetY, bool Subpixel)
        {
            /// <summary>Snaps a local point to the device pixel grid when glyphs are not subpixel-positioned (DPR 1).</summary>
            public SKPoint GlyphOrigin(float x, float y)
            {
                if (Subpixel)
                {
                    return new SKPoint(x, y);
                }

                return new SKPoint(
                    (MathF.Round(OffsetX + (x * Scale)) - OffsetX) / Scale,
                    (MathF.Round(OffsetY + (y * Scale)) - OffsetY) / Scale);
            }
        }

        /// <summary>Loaded assets plus caches; created once per renderer on first use.</summary>
        private sealed class Engine : IDisposable
        {
            public Engine(PosterTagAssets assets, long tileCacheBytes)
            {
                Assets = assets;
                Text = new PosterTagText(assets.TextTypeface);
                Planner = new PosterTagPlanner(assets, Text);
                Tiles = new PosterTagTileCache(tileCacheBytes);
            }

            public PosterTagAssets Assets { get; }

            public PosterTagText Text { get; }

            public PosterTagPlanner Planner { get; }

            public PosterTagTileCache Tiles { get; }

            public void Dispose()
            {
                Tiles.Dispose();
                Text.Dispose();
                Assets.Dispose();
            }

            public void Draw(SKCanvas canvas, PosterTagPlan plan)
            {
                float s = plan.Scale;
                foreach (var band in plan.Bands)
                {
                    var box = SKRect.Create(0, band.Y * s, plan.ImageWidth, band.Height * s);
                    var dark = new SKColor(0, 0, 0, CssColor.AlphaByte(band.Top ? 0.62f : 0.68f));
                    using var shader = SKShader.CreateLinearGradient(new SKPoint(0, box.Top), new SKPoint(0, box.Bottom),
                        band.Top ? new[] { dark, SKColors.Transparent } : new[] { SKColors.Transparent, dark }, null, SKShaderTileMode.Clamp);
                    using var paint = new SKPaint { Shader = shader };
                    canvas.DrawRect(box, paint);
                }
                foreach (var group in plan.Groups)
                {
                    // Blink pixel-snaps the container's own position; boxes inside it snap from there. Corner stacking is
                    // a CSS transform applied afterwards: boxes move by it rounded to whole pixels (Blink moves the
                    // already snapped boxes by the exact fraction, anti-aliasing their edges), content by the exact value.
                    float originX = MathF.Round(group.X * s);
                    float originY = MathF.Round(group.NaturalY * s);
                    float shift = (group.Y - group.NaturalY) * s;
                    int boxShift = (int)MathF.Round(shift);
                    SKRectI? clip = null;
                    if (group.Clips)
                    {
                        // overflow: hidden clips at the container's pixel-snapped box (chip shadows included).
                        var c = Snap(originX, originY, group.Width * s, group.Height * s);
                        c.Offset(0, boxShift);
                        clip = c;
                    }

                    foreach (var item in group.Items)
                    {
                        if (item.Hidden) continue;
                        float x = originX + ((item.X - group.X) * s);
                        float y = originY + ((item.Y - group.Y) * s);
                        var box = Snap(x, y, item.Width * s, item.Height * s);
                        box.Offset(0, boxShift);
                        DrawItem(canvas, plan, item, box, x, y + shift, clip);
                    }
                }
            }

            /// <summary>Blink's PixelSnappedIntRect (device px): round the edges, so adjacent boxes never overlap or gap.</summary>
            private static SKRectI Snap(float x, float y, float w, float h)
            {
                int left = (int)MathF.Round(x);
                int top = (int)MathF.Round(y);
                int right = (int)MathF.Round(x + w);
                int bottom = (int)MathF.Round(y + h);
                return new SKRectI(left, top, Math.Max(left + 1, right), Math.Max(top + 1, bottom));
            }

            private static int Phase(float value) => (int)MathF.Round(value * 16f);

            /// <param name="box">The item's pixel-snapped border box in device px.</param>
            /// <param name="x">Device x of the item's layout origin (content is placed relative to it).</param>
            /// <param name="y">Device y of the item's layout origin.</param>
            private void DrawItem(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRectI box, float x, float y, SKRectI? clip)
            {
                float s = plan.Scale;
                // Content (text, icons) keeps its sub-pixel position relative to the snapped box: quantised to
                // 1/16 px so equal tiles are shared between posters.
                int phaseX = item.Kind == PosterTagTileKind.Flag ? 0 : Phase(x - box.Left);
                int phaseY = item.Kind == PosterTagTileKind.Flag ? 0 : Phase(y - box.Top);
                int margin = (int)MathF.Ceiling(10f * s) + 2; // 3 sigma of the widest shadow (blur 4) + its 2px offset

                // Rasterise only the part of the tile that can land on the image (plus the margin): an overflowing chip
                // (long text, unwrapped like the web's) would otherwise allocate a tile as wide as its text. Boxes inside
                // the image keep their whole tile, so those stay shared between posters. Tile pixel (tx, ty) lands on
                // device (box.Left - margin + tx, box.Top - margin + ty).
                var full = new SKRectI(0, 0, box.Width + (2 * margin), box.Height + (2 * margin));
                var visible = new SKRectI(-box.Left, -box.Top, plan.ImageWidth + (2 * margin) - box.Left, plan.ImageHeight + (2 * margin) - box.Top);
                var crop = SKRectI.Intersect(full, visible);
                if (crop.IsEmpty)
                {
                    return;
                }

                var key = new PosterTagTileKey(item.Kind, item.Text, item.Style + "|flush=" + (int)item.FlushEdges, s, plan.CardWidth, box.Width, box.Height, phaseX, phaseY, crop, item.Tag is QualityTag q ? q.Category + (q.DisplayText == null ? string.Empty : "|" + q.Label) : string.Empty, item.Css.Scale, item.Css.Gap);
                var state = (Engine: this, Plan: plan, Item: item, Box: box, Margin: margin, PhaseX: phaseX / 16f, PhaseY: phaseY / 16f, Crop: crop);
                using var lease = Tiles.Rent(key, state, static st => st.Engine.RenderTile(st.Plan, st.Item, st.Box, st.Margin, st.PhaseX, st.PhaseY, st.Crop));
                if (lease.Image is not { } tile)
                {
                    return;
                }

                if (clip is { } c)
                {
                    canvas.Save();
                    canvas.ClipRect(c, SKClipOperation.Intersect, false);
                }

                if (item.Opacity < 1f)
                {
                    // A kind's own opacity (PosterTagLayout.KindLooks): the whole chip, shadow included, like CSS opacity.
                    using var faded = new SKPaint { Color = SKColors.Black.WithAlpha((byte)MathF.Round(Math.Clamp(item.Opacity, 0f, 1f) * 255f)) };
                    canvas.DrawImage(tile, box.Left - margin + crop.Left, box.Top - margin + crop.Top, SKSamplingOptions.Default, faded);
                }
                else
                {
                    canvas.DrawImage(tile, box.Left - margin + crop.Left, box.Top - margin + crop.Top);
                }

                if (clip is not null)
                {
                    canvas.Restore();
                }
            }

            /// <param name="crop">The part of the full tile (box plus margin on every side) to rasterise.</param>
            private SKImage? RenderTile(PosterTagPlan plan, PlannedItem item, SKRectI box, int margin, float phaseX, float phaseY, SKRectI crop)
            {
                float s = plan.Scale;
                var info = new SKImageInfo(crop.Width, crop.Height, SKImageInfo.PlatformColorType, SKAlphaType.Premul);
                using var surface = SKSurface.Create(info);
                if (surface is null)
                {
                    return null;
                }

                var canvas = surface.Canvas;
                canvas.Clear(SKColors.Transparent);
                if (crop.Left != 0 || crop.Top != 0)
                {
                    canvas.Translate(-crop.Left, -crop.Top);
                }

                var space = new TileSpace(s, margin + phaseX, margin + phaseY, Subpixel: MathF.Abs(s - 1f) > 0.01f);
                canvas.Translate(space.OffsetX, space.OffsetY);
                canvas.Scale(s);

                // The item's snapped border box, in its local CSS px (origin = the item's layout position).
                var local = new SKRect(-phaseX / s, -phaseY / s, (box.Width - phaseX) / s, (box.Height - phaseY) / s);
                // Borders are whole device pixels (at least one), like Blink at any zoom.
                float border = MathF.Max(1f, MathF.Floor(s + 0.0001f)) / s;

                switch (item.Kind)
                {
                    case PosterTagTileKind.Overflow:
                        PaintOverflow(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Status:
                        PaintStatus(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Quality:
                        PaintQuality(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Genre:
                        PaintGenre(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Rating:
                        PaintRating(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Award:
                        PaintAward(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.AgeRating:
                        PaintAge(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.LanguageChip:
                        PaintLanguageChip(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Flag:
                        PaintFlag(canvas, item, local, border, space);
                        break;
                    case PosterTagTileKind.Logo:
                        PaintLogo(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Custom:
                        PaintCustom(canvas, plan, item, local, border, space);
                        break;
                }

                canvas.Flush();
                return surface.Snapshot();
            }

            /// <summary>.je-tag-more has size-scaled text/padding, fixed colours and no box or text shadow.</summary>
            private void PaintOverflow(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                using var shape = new SKRoundRect(local, PosterTagCss.OverflowRadius);
                PaintBox(canvas, shape, new SKColor(0, 0, 0, CssColor.AlphaByte(0.72f)),
                    new SKColor(255, 255, 255, CssColor.AlphaByte(0.22f)), border, default, item.FlushEdges);
                float x = 1 + PosterTagCss.Lu(item.Css.OverflowPaddingH);
                float top = 1 + PosterTagCss.Lu(item.Css.OverflowPaddingV);
                // The anonymous flex text box floors its leading before align-items: center.
                float baseline = MathF.Floor(Assets.TextMetrics.BaselineOffset(item.Css.OverflowFontSize, item.Css.OverflowLineHeight));
                DrawText(canvas, item.TextLayout!, x, top + baseline,
                    SKColors.White, null, space);
            }

            /// <summary>Static status chip: the family colours participate in the tile key; no viewport backdrop filter.</summary>
            private void PaintStatus(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var colors = TagColors.Decode(item.Style[(item.Style.IndexOf('\n') + 1)..]);
                using var shape = new SKRoundRect(local, Math.Clamp(plan.CardWidth * 0.03f, 4, 6));
                PaintBox(canvas, shape, colors.Background ?? new SKColor(15, 15, 15, CssColor.AlphaByte(0.72f)),
                    colors.Border ?? new SKColor(255, 255, 255, CssColor.AlphaByte(0.18f)), border, ChipShadow, item.FlushEdges);
                float x = 1 + PosterTagCss.Lu(Math.Clamp(plan.CardWidth * 0.05f, 5, 10) * item.Css.Scale);
                float fontSize = item.Css.ChipFontSize;
                float top = 1 + PosterTagCss.Lu(item.Css.ChipPaddingV);
                DrawText(canvas, item.TextLayout!, x, top + Assets.TextMetrics.BaselineOffset(fontSize, PosterTagCss.Lu(fontSize * 1.15f)),
                    colors.Text ?? (item.Tag is StatusTag { StyleKey: "trending" } ? new SKColor(255, 209, 102) : SKColors.White), null, space);
            }

            private void PaintQuality(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var css = item.Css;
                var (background, text) = item.Tag is QualityTag { Category: "runtime" or "aspectRatio" or "frameRate" }
                    ? (new SKColor(55, 71, 79, 242), SKColors.White)
                    : item.Tag is QualityTag { Category: "edition" }
                    ? (new SKColor(106, 27, 154, 242), SKColors.White)
                    : QualityColours((item.Tag as QualityTag)?.Label ?? item.Text);
                var edge = QualityBorder;
                if (item.Style.Length > 0)
                {
                    var o = TagColors.Decode(item.Style);
                    background = o.Background ?? background;
                    text = o.Text ?? text;
                    edge = o.Border ?? edge;
                }

                using var rrect = new SKRoundRect(local, css.QualityRadius);
                PaintBox(canvas, rrect, background, edge, border, QualityShadow, item.FlushEdges);

                float fontSize = css.QualityFontSize;
                float lineHeight = PosterTagCss.Lu(1.2f * fontSize);
                float x = 1f + PosterTagCss.Lu(css.QualityPaddingH);
                float top = 1f + PosterTagCss.Lu(css.QualityPaddingV);
                float baseline = top + Assets.TextMetrics.BaselineOffset(fontSize, lineHeight);
                DrawText(canvas, item.TextLayout!, x, baseline, text, null, space);
            }

            private void PaintGenre(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var css = item.Css;
                var o = item.Style.Length > 0 ? TagColors.Decode(item.Style) : default;
                var glyph = o.Text ?? GenreGlyph;
                using var rrect = new SKRoundRect(local, local.Width / 2f, local.Height / 2f);
                PaintBox(canvas, rrect, o.Background ?? GenreBackground, o.Border ?? GenreBorder, border, GenreShadow, item.FlushEdges);

                var icon = Assets.GetIcon(item.Text) ?? Assets.GetIcon("theaters");
                if (icon is null)
                {
                    return;
                }

                // A flex-centred inline box: hinted advance wide, line-height: 1 high.
                float size = css.GenreGlyphSize;
                float content = PosterTagCss.Lu(css.GenreSize);
                float boxWidth = PosterTagCss.RoundHalfUp(icon.Advance / icon.Metrics.UnitsPerEm * size);
                float boxHeight = PosterTagCss.Lu(size);
                float x = 1f + PosterTagCss.Lu((content - boxWidth) / 2f);
                float y = 1f + PosterTagCss.Lu((content - boxHeight) / 2f);
                DrawIcon(canvas, icon, x, y + icon.Metrics.BaselineOffset(size, boxHeight), size, glyph, space);
            }

            private static string SourceColor(string id) => id switch
            {
                "community" => "#ffc107", "imdb" => "#f5c518", "tmdb" => "#01b4a4", "rtAudience" => "#ffeab0",
                "metacritic" => "#ffcc33", "letterboxd" => "#00e054", _ => "#ed1c24"
            };

            private void PaintRating(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var css = item.Css;
                var tag = (RatingTag)item.Tag;
                var background = tag.Source == PosterRatingSource.Community ? CommunityBackground : CriticBackground;
                var textColor = tag.Source switch
                {
                    PosterRatingSource.Community => CommunityText,
                    PosterRatingSource.UserReview => UserReviewText,
                    _ => SKColors.White,
                };
                if (tag.ScoreColor != null) textColor = CssColor.Parse(tag.ScoreColor, textColor);
                SKColor? ring = null;
                var nl = item.Style.IndexOf('\n');
                if (nl >= 0)
                {
                    var o = TagColors.Decode(item.Style[(nl + 1)..]);
                    background = o.Background ?? background;
                    textColor = o.Text ?? textColor;
                    ring = o.Border;
                }
                using var rrect = new SKRoundRect(local, 4f);
                // Rating chips have no border; a Tag Styles border is an inner ring (outline-offset: -1px on the web).
                PaintBox(canvas, rrect, background, ring, ring is null ? 0f : border, ChipShadow, item.FlushEdges);

                float fontSize = css.ChipFontSize;
                float x = PosterTagCss.Lu(css.ChipPaddingH);
                float contentTop = PosterTagCss.Lu(css.ChipPaddingV);
                float textHeight = PosterTagCss.Lu(fontSize);
                float contentHeight = Math.Max(item.IconHeight, textHeight);
                float iconTop = contentTop + PosterTagCss.Lu((contentHeight - item.IconHeight) / 2f);

                if (tag.Compact)
                {
                    using var dot = new SKPaint { Color = CssColor.Parse(SourceColor(tag.SourceId), SKColors.White), IsAntialias = true };
                    canvas.DrawCircle(x + css.Scale, iconTop + css.Scale, css.Scale, dot);
                }
                else if (tag.IsSource)
                {
                    var logoBox = SKRect.Create(x, iconTop, item.IconWidth, item.IconHeight);
                    if (Assets.GetSourceLogo(tag.SourceId, tag.Fresh) is { } logoImage) DrawImageContain(canvas, logoImage, logoBox, space);
                    else if (Assets.GetVectorIcon("rating-" + tag.SourceId) is { } sourceLogo) DrawVectorContain(canvas, sourceLogo, logoBox);
                }
                else switch (tag.Source)
                {
                    case PosterRatingSource.Critic:
                        var tomato = Assets.GetVectorIcon(tag.Fresh ? "rt-fresh" : "rt-rotten");
                        if (tomato is not null)
                        {
                            DrawVectorContain(canvas, tomato, SKRect.Create(x, iconTop, item.IconWidth, item.IconHeight));
                        }

                        break;
                    case PosterRatingSource.UserReview:
                        if (Assets.GetIcon(UserReviewIconKey) is { } heart)
                        {
                            float size = PosterTagCss.UserReviewIconSize * css.Scale;
                            DrawIcon(canvas, heart, x, iconTop + heart.Metrics.BaselineOffset(size, item.IconHeight), size, textColor, space);
                        }

                        break;
                    default:
                        if (Assets.GetIcon(StarIconKey) is { } star)
                        {
                            float size = css.RatingIconSize;
                            DrawIcon(canvas, star, x, iconTop + star.Metrics.BaselineOffset(size, item.IconHeight), size, textColor, space);
                        }

                        break;
                }

                float textX = x + item.IconWidth + PosterTagCss.Lu(css.RatingInnerGap);
                float textTop = contentTop + PosterTagCss.Lu((contentHeight - textHeight) / 2f);
                DrawText(canvas, item.TextLayout!, textX, textTop + Assets.TextMetrics.BaselineOffset(fontSize, textHeight), textColor, null, space);
            }

            private void PaintAward(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var tag = (AwardTag)item.Tag;
                var css = item.Css;
                var background = new SKColor(15, 15, 15, 217);
                var text = SKColors.White;
                SKColor? ring = null;
                var nl = item.Style.IndexOf('\n');
                if (nl >= 0)
                {
                    var over = TagColors.Decode(item.Style[(nl + 1)..]);
                    background = over.Background ?? background;
                    text = over.Text ?? text;
                    ring = over.Border;
                }
                using var box = new SKRoundRect(local, 4f);
                PaintBox(canvas, box, background, ring, ring == null ? 0 : border, ChipShadow, item.FlushEdges);
                var x = PosterTagCss.Lu(css.ChipPaddingH);
                var awardBox = SKRect.Create(x, (local.Height - item.IconHeight) / 2, item.IconWidth, item.IconHeight);
                if (Assets.GetAwardLogo(tag.Id) is { } awardImage) DrawImageContain(canvas, awardImage, awardBox, space);
                else if (Assets.GetVectorIcon("award-" + tag.Id) is { } icon) DrawVectorContain(canvas, icon, awardBox);
                var textHeight = PosterTagCss.Lu(css.ChipFontSize);
                DrawText(canvas, item.TextLayout!, x + item.IconWidth + PosterTagCss.Lu(css.RatingInnerGap),
                    (local.Height - textHeight) / 2 + Assets.TextMetrics.BaselineOffset(css.ChipFontSize, textHeight), text, null, space);
            }

            private void PaintAge(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var css = item.Css;
                var nl = item.Style.IndexOf('\n');
                var styleKey = nl >= 0 ? item.Style[..nl] : item.Style;
                var style = Assets.AgeRatingStyles.TryGetValue(styleKey, out var found) ? found : AgeRatingStyle.Default;
                if (nl >= 0)
                {
                    var o = TagColors.Decode(item.Style[(nl + 1)..]);
                    style = style with { Background = o.Background ?? style.Background, Border = o.Border ?? style.Border, Text = o.Text ?? style.Text };
                }

                using var rrect = new SKRoundRect(local, 4f);
                PaintBox(canvas, rrect, style.Background, style.Border, border, ChipShadow, item.FlushEdges);

                float fontSize = css.ChipFontSize;
                float lineHeight = PosterTagCss.Lu(fontSize);
                float x = 1f + PosterTagCss.Lu(css.ChipPaddingH);
                float top = 1f + PosterTagCss.Lu(css.ChipPaddingV);
                float baseline = top + Assets.TextMetrics.BaselineOffset(fontSize, lineHeight);
                DrawText(canvas, item.TextLayout!, x, baseline, style.Text, style.TextShadow ? TextShadowColor : null, space);
            }

            /// <summary>A Custom tag chip (customtags.js): optional icon, then the label, in the label's Tag Styles colours.</summary>
            private void PaintCustom(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var css = item.Css;
                var nl = item.Style.IndexOf('\n');
                var iconName = nl >= 0 ? item.Style[..nl] : item.Style;
                var o = nl >= 0 ? TagColors.Decode(item.Style[(nl + 1)..]) : default;
                var textColor = o.Text ?? SKColors.White;
                using var rrect = new SKRoundRect(local, 4f);
                PaintBox(canvas, rrect, o.Background ?? CustomBackground, o.Border ?? CustomBorder, border, ChipShadow, item.FlushEdges);

                float fontSize = css.ChipFontSize;
                float x = 1f + PosterTagCss.Lu(css.ChipPaddingH);
                float contentTop = 1f + PosterTagCss.Lu(css.ChipPaddingV);
                float textHeight = PosterTagCss.Lu(PosterTagCss.CustomLineHeight * fontSize);
                float contentHeight = Math.Max(item.IconHeight, textHeight);
                if (iconName.Length > 0 && Assets.GetIcon(iconName) is { } icon)
                {
                    float size = PosterTagCss.CustomIconScale * fontSize;
                    float iconTop = contentTop + PosterTagCss.Lu((contentHeight - item.IconHeight) / 2f);
                    DrawIcon(canvas, icon, x, iconTop + icon.Metrics.BaselineOffset(size, item.IconHeight), size, textColor, space);
                    x += item.IconWidth + PosterTagCss.Lu(PosterTagCss.CustomIconGapEm * fontSize);
                }

                float textTop = contentTop + PosterTagCss.Lu((contentHeight - textHeight) / 2f);
                DrawText(canvas, item.TextLayout!, x, textTop + Assets.TextMetrics.BaselineOffset(fontSize, textHeight), textColor, TextShadowColor, space);
            }

            /// <summary>Codes, audio-count badges, and CC-prefixed subtitle flags.</summary>
            private void PaintLanguageChip(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var tag = (LanguageTag)item.Tag;
                var parts = item.Style.Split('|', 3);
                var colors = parts.Length == 3 ? TagColors.Decode(parts[2]) : default;
                using var opacity = new SKPaint { Color = new SKColor(0, 0, 0, tag.Partial ? CssColor.AlphaByte(0.55f) : (byte)255) };
                canvas.SaveLayer(opacity);
                using var shape = new SKRoundRect(local, item.Css.QualityRadius);
                PaintBox(canvas, shape, colors.Background ?? new SKColor(15, 15, 15, CssColor.AlphaByte(0.72f)), colors.Border ?? QualityBorder, border, QualityShadow, item.FlushEdges);
                var fontSize = item.Css.QualityFontSize;
                float top = 1f + PosterTagCss.Lu(item.Css.QualityPaddingV);
                float contentHeight = local.Height - 2f - (2 * PosterTagCss.Lu(item.Css.QualityPaddingV));
                float textHeight = PosterTagCss.Lu(1.2f * fontSize);
                DrawText(canvas, item.TextLayout!, 1f + PosterTagCss.Lu(item.Css.LanguagePaddingH(tag)), top + PosterTagCss.Lu((contentHeight - textHeight) / 2f) + Assets.TextMetrics.BaselineOffset(fontSize, textHeight), colors.Text ?? SKColors.White, null, space);
                if (item.IconWidth > 0 && Assets.GetFlag(parts[0]) is { } image)
                {
                    var target = SKRect.Create(local.Width - item.IconWidth - 1f - PosterTagCss.Lu(item.Css.LanguagePaddingH(tag)), top + PosterTagCss.Lu((contentHeight - item.IconHeight) / 2f), item.IconWidth, item.IconHeight);
                    canvas.DrawImage(image, target, new SKSamplingOptions(SKFilterMode.Linear));
                }
                canvas.Restore();
            }

            /// <summary>
            /// A Logos chip: its pill (Tag Styles colours over the built-in provider / company / name
            /// colours) with the logo contained in its box, or the shortened name in the name chip.
            /// </summary>
            private void PaintLogo(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var tag = (LogoTag)item.Tag;
                var bar = item.Style.IndexOf('|');
                var label = bar >= 0 ? item.Style[..bar] : item.Style;
                var over = bar >= 0 ? TagColors.Decode(item.Style[(bar + 1)..]) : default;
                var builtin = TagStylePalettes.Builtin(TagStyleKeys.Logos, label);
                var background = over.Background ?? CssColor.Parse(builtin.Background, SKColors.Transparent);
                var borderColor = over.Border ?? CssColor.Parse(builtin.Border, SKColors.Transparent);
                var text = over.Text ?? CssColor.Parse(builtin.Text, SKColors.White);

                using var rrect = new SKRoundRect(local, 4f);
                PaintBox(canvas, rrect, background, borderColor, border, ChipShadow, item.FlushEdges);

                if (label == "text")
                {
                    float fontSize = item.Css.LogoFontSize;
                    float lineHeight = PosterTagCss.Lu(fontSize);
                    float contentTop = 1f + PosterTagCss.LogoPaddingV * item.Css.Scale;
                    float contentHeight = item.Height - 2f - (2 * PosterTagCss.LogoPaddingV * item.Css.Scale);
                    float top = contentTop + PosterTagCss.Lu((contentHeight - lineHeight) / 2f);
                    DrawText(canvas, item.TextLayout!, 1f + PosterTagCss.LogoPaddingH * item.Css.Scale, top + Assets.TextMetrics.BaselineOffset(fontSize, lineHeight), text, TextShadowColor, space);
                    return;
                }

                if (tag.Logo is null || Assets.GetLogo(tag.Logo) is not { } image) return;
                bool provider = label == "provider";
                float padV = (provider ? PosterTagCss.LogoProviderPadding : PosterTagCss.LogoPaddingV) * item.Css.Scale;
                float padH = (provider ? PosterTagCss.LogoProviderPadding : PosterTagCss.LogoPaddingH) * item.Css.Scale;
                var box = SKRect.Create(1f + padH, 1f + padV, item.IconWidth, item.IconHeight);
                // object-fit: contain inside the image box, centred.
                float fit = Math.Min(box.Width / image.Width, box.Height / image.Height);
                var target = SKRect.Create(box.MidX - (image.Width * fit / 2f), box.MidY - (image.Height * fit / 2f), image.Width * fit, image.Height * fit);
                canvas.Save();
                using (var clip = new SKRoundRect(box, 3f))
                {
                    canvas.ClipRoundRect(clip, SKClipOperation.Intersect, true);
                }

                int deviceWidth = Math.Max(1, (int)MathF.Round(target.Width * space.Scale));
                int deviceHeight = Math.Max(1, (int)MathF.Round(target.Height * space.Scale));
                using (var scaled = PosterTagImageScaler.Scale(image, deviceWidth, deviceHeight))
                using (var paint = new SKPaint { IsAntialias = true })
                {
                    canvas.DrawImage(scaled ?? image, target, new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear), paint);
                }

                canvas.Restore();
            }

            private void PaintFlag(SKCanvas canvas, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var image = Assets.GetFlag(item.Text);
                if (image is null)
                {
                    return;
                }

                bool partial = item.Style == PosterTagPlanner.PartialFlagStyle;
                SKColor? styleRing = item.Style.StartsWith(PosterTagPlanner.RingFlagStyle, StringComparison.Ordinal)
                    ? TagColors.Decode(item.Style[PosterTagPlanner.RingFlagStyle.Length..]).Border
                    : null;
                using var rrect = new SKRoundRect(local, 2f);
                if (partial)
                {
                    // opacity: .55 applies to the whole element: image, outline and shadow ring.
                    using var layer = new SKPaint { Color = new SKColor(0, 0, 0, CssColor.AlphaByte(0.55f)) };
                    canvas.SaveLayer(layer);
                }

                PaintShadow(canvas, rrect, partial ? PartialFlagRing : FlagShadow);

                canvas.Save();
                canvas.ClipRoundRect(rrect, SKClipOperation.Intersect, true);
                // The flag box is pixel-snapped (no phase), so the area-averaged raster lands 1:1 on device pixels.
                int deviceWidth = (int)MathF.Round(local.Width * space.Scale);
                int deviceHeight = (int)MathF.Round(local.Height * space.Scale);
                using (var scaled = PosterTagImageScaler.Scale(image, deviceWidth, deviceHeight))
                using (var saturate = partial ? SKColorFilter.CreateColorMatrix(Saturate50) : null)
                using (var paint = new SKPaint { IsAntialias = true, ColorFilter = saturate })
                {

                    canvas.DrawImage(scaled ?? image, local, new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear), paint);
                }

                canvas.Restore();

                if (styleRing is { } ringColor)
                {
                    // Tag Styles border: outline: 1px solid; outline-offset: -1px, the box's outermost pixel ring.
                    float half = border / 2f;
                    using var inner = new SKRoundRect(SKRect.Inflate(local, -half, -half), Math.Max(0f, 2f - half));
                    using var stroke = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = border, Color = ringColor };
                    canvas.DrawRoundRect(inner, stroke);
                }

                if (partial)
                {
                    // outline: 1px dashed rgba(255,255,255,.95), outline-offset: -1px: the box's outermost pixel ring,
                    // following the 2px radius. Blink dashes thin lines 3 on, 2 off.
                    float half = border / 2f;
                    using var ring = new SKRoundRect(SKRect.Inflate(local, -half, -half), Math.Max(0f, 2f - half));
                    using var dash = SKPathEffect.CreateDash(new[] { 3f * border, 2f * border }, 0f);
                    using var outline = new SKPaint
                    {
                        IsAntialias = true,
                        Style = SKPaintStyle.Stroke,
                        StrokeWidth = border,
                        Color = PartialOutline,
                        PathEffect = dash,
                    };
                    canvas.DrawRoundRect(ring, outline);
                    canvas.Restore(); // the opacity layer
                }
            }

            private (SKColor Background, SKColor Text) QualityColours(string label)
            {
                var colours = Assets.QualityColours;
                if (colours.TryGetValue(label, out var exact))
                {
                    return exact;
                }

                // normalizeQualityLabel: "ATMOS 7.1" shares ATMOS's colour.
                foreach (var b in Assets.QualityCompositeBases)
                {
                    if (label.StartsWith(b + " ", StringComparison.Ordinal) && colours.TryGetValue(b, out var composite))
                    {
                        return composite;
                    }
                }

                // No rule matches: the web shows the label on no background in the card's (white) text colour.
                return (SKColors.Transparent, SKColors.White);
            }

            private static void PaintBox(SKCanvas canvas, SKRoundRect rrect, SKColor background, SKColor? border, float borderWidth, BoxShadow shadow, FlushEdges edges = FlushEdges.None)
            {
                if (edges != FlushEdges.None)
                {
                    var radii = rrect.Radii;
                    if ((edges & (FlushEdges.Left | FlushEdges.Top)) != 0) radii[0] = default;
                    if ((edges & (FlushEdges.Right | FlushEdges.Top)) != 0) radii[1] = default;
                    if ((edges & (FlushEdges.Right | FlushEdges.Bottom)) != 0) radii[2] = default;
                    if ((edges & (FlushEdges.Left | FlushEdges.Bottom)) != 0) radii[3] = default;
                    rrect.SetRectRadii(rrect.Rect, radii);
                    // Keep the original shadow only on inward sides.
                    var clip = rrect.Rect;
                    clip.Left -= edges.HasFlag(FlushEdges.Left) ? 0 : 12;
                    clip.Top -= edges.HasFlag(FlushEdges.Top) ? 0 : 12;
                    clip.Right += edges.HasFlag(FlushEdges.Right) ? 0 : 12;
                    clip.Bottom += edges.HasFlag(FlushEdges.Bottom) ? 0 : 12;
                    canvas.Save();
                    canvas.ClipRect(clip);
                }
                PaintShadow(canvas, rrect, shadow);
                using var paint = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Fill, Color = background };
                // background-clip: border-box: the background runs under the (translucent) border.
                canvas.DrawRoundRect(rrect, paint);
                if (border is { } borderColor && borderWidth > 0f)
                {
                    using var inner = new SKRoundRect(rrect.Rect, rrect.Radii[0].X, rrect.Radii[0].Y);
                    if (edges == FlushEdges.None) inner.Deflate(borderWidth, borderWidth);
                    else
                    {
                        var rect = rrect.Rect;
                        rect.Left += edges.HasFlag(FlushEdges.Left) ? 0 : borderWidth;
                        rect.Top += edges.HasFlag(FlushEdges.Top) ? 0 : borderWidth;
                        rect.Right -= edges.HasFlag(FlushEdges.Right) ? 0 : borderWidth;
                        rect.Bottom -= edges.HasFlag(FlushEdges.Bottom) ? 0 : borderWidth;
                        inner.SetRectRadii(rect, rrect.Radii.Select(r => new SKPoint(Math.Max(0, r.X - borderWidth), Math.Max(0, r.Y - borderWidth))).ToArray());
                    }
                    paint.Color = borderColor;
                    canvas.DrawRoundRectDifference(rrect, inner, paint);
                }
                if (edges != FlushEdges.None) canvas.Restore();
            }

            /// <summary>An outer box-shadow: drawn only outside the border box, so translucent chips stay clean.</summary>
            private static void PaintShadow(SKCanvas canvas, SKRoundRect rrect, BoxShadow shadow)
            {
                if (shadow.Color.Alpha == 0)
                {
                    return;
                }

                canvas.Save();
                canvas.ClipRoundRect(rrect, SKClipOperation.Difference, true);
                using var paint = new SKPaint { IsAntialias = true, Color = shadow.Color };
                using var blur = shadow.Blur > 0f ? SKMaskFilter.CreateBlur(SKBlurStyle.Normal, shadow.Blur / 2f) : null;
                paint.MaskFilter = blur;
                using var shape = new SKRoundRect(rrect.Rect, rrect.Radii[0].X, rrect.Radii[0].Y);
                if (shadow.Spread > 0f)
                {
                    shape.Inflate(shadow.Spread, shadow.Spread);
                }

                shape.Offset(0f, shadow.OffsetY);
                canvas.DrawRoundRect(shape, paint);
                canvas.Restore();
            }

            private static void DrawText(SKCanvas canvas, PosterTagTextLayout layout, float x, float baseline, SKColor color, SKColor? shadow, TileSpace space)
            {
                var origin = space.GlyphOrigin(x, baseline);
                if (shadow is { } shadowColor)
                {
                    // text-shadow: 0 0 2px: a Gaussian with sigma 1 under the glyphs.
                    using var blur = SKMaskFilter.CreateBlur(SKBlurStyle.Normal, 1f);
                    using var shadowPaint = new SKPaint { IsAntialias = true, Color = shadowColor, MaskFilter = blur };
                    PosterTagText.Draw(canvas, layout, origin.X, origin.Y, shadowPaint, space.Subpixel);
                }

                using var paint = new SKPaint { IsAntialias = true, Color = color };
                PosterTagText.Draw(canvas, layout, origin.X, origin.Y, paint, space.Subpixel);
            }

            /// <summary>Draws an icon glyph outline with its pen position at x and its baseline at <paramref name="baseline"/>.</summary>
            private static void DrawIcon(SKCanvas canvas, PosterTagIcon icon, float x, float baseline, float size, SKColor color, TileSpace space)
            {
                var origin = space.GlyphOrigin(x, baseline);
                float k = size / icon.Metrics.UnitsPerEm;
                canvas.Save();
                // Path y runs down from the font's ascent, so the ascent line goes ascent * k above the baseline.
                canvas.Translate(origin.X, origin.Y - (icon.Metrics.Ascent * k));
                canvas.Scale(k);
                using var paint = new SKPaint { IsAntialias = true, Color = color };
                canvas.DrawPath(icon.Path, paint);
                canvas.Restore();
            }

            /// <summary>background-size: contain; background-position: center, for a raster.</summary>
            private static void DrawImageContain(SKCanvas canvas, SKImage image, SKRect box, TileSpace space)
            {
                float k = Math.Min(box.Width / image.Width, box.Height / image.Height);
                float width = image.Width * k, height = image.Height * k;
                var target = SKRect.Create(box.MidX - (width / 2f), box.MidY - (height / 2f), width, height);
                int deviceWidth = Math.Max(1, (int)MathF.Round(width * space.Scale));
                int deviceHeight = Math.Max(1, (int)MathF.Round(height * space.Scale));
                using var scaled = PosterTagImageScaler.Scale(image, deviceWidth, deviceHeight);
                using var paint = new SKPaint { IsAntialias = true };
                canvas.DrawImage(scaled ?? image, target, new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear), paint);
            }

            /// <summary>background-size: contain; background-position: center.</summary>
            private static void DrawVectorContain(SKCanvas canvas, PosterTagVectorIcon icon, SKRect box)
            {
                var vb = icon.ViewBox;
                float k = Math.Min(box.Width / vb.Width, box.Height / vb.Height);
                canvas.Save();
                canvas.Translate(box.MidX - (vb.Width * k / 2f), box.MidY - (vb.Height * k / 2f));
                canvas.Scale(k);
                canvas.Translate(-vb.Left, -vb.Top);
                using var paint = new SKPaint { IsAntialias = true };
                foreach (var (path, fill) in icon.Parts)
                {
                    paint.Color = fill;
                    canvas.DrawPath(path, paint);
                }

                canvas.Restore();
            }
        }
    }
}
