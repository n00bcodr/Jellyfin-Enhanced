using System;
using System.Threading;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering
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
        public const string Version = "1";

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

                var key = new PosterTagTileKey(item.Kind, item.Text, item.Style, s, plan.CardWidth, box.Width, box.Height, phaseX, phaseY, crop);
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

                canvas.DrawImage(tile, box.Left - margin + crop.Left, box.Top - margin + crop.Top);
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
                    case PosterTagTileKind.Quality:
                        PaintQuality(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Genre:
                        PaintGenre(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Rating:
                        PaintRating(canvas, plan, item, local, space);
                        break;
                    case PosterTagTileKind.AgeRating:
                        PaintAge(canvas, plan, item, local, border, space);
                        break;
                    case PosterTagTileKind.Flag:
                        PaintFlag(canvas, item, local, border, space);
                        break;
                }

                canvas.Flush();
                return surface.Snapshot();
            }

            private void PaintQuality(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var css = plan.Css;
                var (background, text) = QualityColours(item.Text);
                using var rrect = new SKRoundRect(local, css.QualityRadius);
                PaintBox(canvas, rrect, background, QualityBorder, border, QualityShadow);

                float fontSize = css.QualityFontSize;
                float lineHeight = PosterTagCss.Lu(1.2f * fontSize);
                float x = 1f + PosterTagCss.Lu(css.QualityPaddingH);
                float top = 1f + PosterTagCss.Lu(css.QualityPaddingV);
                float baseline = top + Assets.TextMetrics.BaselineOffset(fontSize, lineHeight);
                DrawText(canvas, item.TextLayout!, x, baseline, text, null, space);
            }

            private void PaintGenre(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var css = plan.Css;
                using var rrect = new SKRoundRect(local, local.Width / 2f, local.Height / 2f);
                PaintBox(canvas, rrect, GenreBackground, GenreBorder, border, GenreShadow);

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
                DrawIcon(canvas, icon, x, y + icon.Metrics.BaselineOffset(size, boxHeight), size, GenreGlyph, space);
            }

            private void PaintRating(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, TileSpace space)
            {
                var css = plan.Css;
                var tag = (RatingTag)item.Tag;
                var background = tag.Source == PosterRatingSource.Community ? CommunityBackground : CriticBackground;
                var textColor = tag.Source switch
                {
                    PosterRatingSource.Community => CommunityText,
                    PosterRatingSource.UserReview => UserReviewText,
                    _ => SKColors.White,
                };
                using var rrect = new SKRoundRect(local, 4f);
                PaintBox(canvas, rrect, background, null, 0f, ChipShadow);

                float fontSize = css.ChipFontSize;
                float x = PosterTagCss.Lu(css.ChipPaddingH);
                float contentTop = PosterTagCss.Lu(css.ChipPaddingV);
                float textHeight = PosterTagCss.Lu(fontSize);
                float contentHeight = Math.Max(item.IconHeight, textHeight);
                float iconTop = contentTop + PosterTagCss.Lu((contentHeight - item.IconHeight) / 2f);

                switch (tag.Source)
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
                            float size = PosterTagCss.UserReviewIconSize;
                            DrawIcon(canvas, heart, x, iconTop + heart.Metrics.BaselineOffset(size, item.IconHeight), size, UserReviewText, space);
                        }

                        break;
                    default:
                        if (Assets.GetIcon(StarIconKey) is { } star)
                        {
                            float size = css.RatingIconSize;
                            DrawIcon(canvas, star, x, iconTop + star.Metrics.BaselineOffset(size, item.IconHeight), size, CommunityText, space);
                        }

                        break;
                }

                float textX = x + item.IconWidth + PosterTagCss.Lu(css.RatingInnerGap);
                float textTop = contentTop + PosterTagCss.Lu((contentHeight - textHeight) / 2f);
                DrawText(canvas, item.TextLayout!, textX, textTop + Assets.TextMetrics.BaselineOffset(fontSize, textHeight), textColor, null, space);
            }

            private void PaintAge(SKCanvas canvas, PosterTagPlan plan, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var css = plan.Css;
                var style = Assets.AgeRatingStyles.TryGetValue(item.Style, out var found) ? found : AgeRatingStyle.Default;
                using var rrect = new SKRoundRect(local, 4f);
                PaintBox(canvas, rrect, style.Background, style.Border, border, ChipShadow);

                float fontSize = css.ChipFontSize;
                float lineHeight = PosterTagCss.Lu(fontSize);
                float x = 1f + PosterTagCss.Lu(css.ChipPaddingH);
                float top = 1f + PosterTagCss.Lu(css.ChipPaddingV);
                float baseline = top + Assets.TextMetrics.BaselineOffset(fontSize, lineHeight);
                DrawText(canvas, item.TextLayout!, x, baseline, style.Text, style.TextShadow ? TextShadowColor : null, space);
            }

            private void PaintFlag(SKCanvas canvas, PlannedItem item, SKRect local, float border, TileSpace space)
            {
                var image = Assets.GetFlag(item.Text);
                if (image is null)
                {
                    return;
                }

                bool partial = item.Style.Length > 0;
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

            private static void PaintBox(SKCanvas canvas, SKRoundRect rrect, SKColor background, SKColor? border, float borderWidth, BoxShadow shadow)
            {
                PaintShadow(canvas, rrect, shadow);
                using var paint = new SKPaint { IsAntialias = true, Style = SKPaintStyle.Fill, Color = background };
                // background-clip: border-box: the background runs under the (translucent) border.
                canvas.DrawRoundRect(rrect, paint);
                if (border is { } borderColor && borderWidth > 0f)
                {
                    using var inner = new SKRoundRect(rrect.Rect, rrect.Radii[0].X, rrect.Radii[0].Y);
                    inner.Deflate(borderWidth, borderWidth);
                    paint.Color = borderColor;
                    canvas.DrawRoundRectDifference(rrect, inner, paint);
                }
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
