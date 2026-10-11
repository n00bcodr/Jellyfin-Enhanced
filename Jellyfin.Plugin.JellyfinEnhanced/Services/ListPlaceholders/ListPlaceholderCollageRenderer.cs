using System;
using System.Collections.Generic;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// Renders the poster collage of a placeholder-only list with the SkiaSharp copy Jellyfin itself loads (compile-only
    /// reference, like Spoiler Blur and the native poster tags). The output has the shape Jellyfin gives its own list
    /// images: square (600x600) for playlists, poster (400x600, 2:3) for collections.
    /// <list type="bullet">
    /// <item>1 poster: collections show it as is; playlists show it whole, centred on a blurred, darkened copy.</item>
    /// <item>2 posters: two columns.</item>
    /// <item>3 posters: the first as a full-height left column, the other two stacked on the right.</item>
    /// <item>4 posters: a 2x2 grid.</item>
    /// </list>
    /// Every cell is filled edge to edge (scaled to cover, centred crop), so there are no gaps or bars.
    /// </summary>
    public static class ListPlaceholderCollageRenderer
    {
        /// <summary>Most posters a collage uses.</summary>
        public const int MaxPosters = 4;

        /// <summary>Square (playlist) collage side, as Jellyfin's own square collages.</summary>
        public const int SquareSize = 600;

        /// <summary>Poster (collection) collage width, as Jellyfin's own poster collages.</summary>
        public const int PosterWidth = 400;

        /// <summary>Poster (collection) collage height.</summary>
        public const int PosterHeight = 600;

        private const int JpegQuality = 90;
        private const long MaxPosterPixels = 4096L * 4096L;
        private const float BackgroundBlurSigma = 24f;

        /// <summary>The output size for a list kind.</summary>
        /// <param name="square">True for playlists (square), false for collections (2:3 poster).</param>
        /// <returns>Width and height in pixels.</returns>
        public static (int Width, int Height) SizeFor(bool square) =>
            square ? (SquareSize, SquareSize) : (PosterWidth, PosterHeight);

        /// <summary>
        /// The cells (left, top, right, bottom) of a collage of <paramref name="count"/> posters in a
        /// <paramref name="width"/> x <paramref name="height"/> canvas.
        /// </summary>
        /// <param name="count">Number of posters (1-4).</param>
        /// <param name="width">Canvas width.</param>
        /// <param name="height">Canvas height.</param>
        /// <returns>One rectangle per poster, in poster order.</returns>
        public static IReadOnlyList<SKRectI> Layout(int count, int width, int height)
        {
            var halfW = width / 2;
            var halfH = height / 2;
            return Math.Clamp(count, 0, MaxPosters) switch
            {
                0 => Array.Empty<SKRectI>(),
                1 => new[] { new SKRectI(0, 0, width, height) },
                2 => new[] { new SKRectI(0, 0, halfW, height), new SKRectI(halfW, 0, width, height) },
                3 => new[] { new SKRectI(0, 0, halfW, height), new SKRectI(halfW, 0, width, halfH), new SKRectI(halfW, halfH, width, height) },
                _ => new[]
                {
                    new SKRectI(0, 0, halfW, halfH),
                    new SKRectI(halfW, 0, width, halfH),
                    new SKRectI(0, halfH, halfW, height),
                    new SKRectI(halfW, halfH, width, height),
                },
            };
        }

        /// <summary>
        /// Renders the collage. Posters that can't be decoded are skipped (the layout uses the ones that can).
        /// </summary>
        /// <param name="posters">Encoded poster images (JPEG/PNG/WebP), in list order; only the first four are used.</param>
        /// <param name="square">True for a playlist (square), false for a collection (2:3 poster).</param>
        /// <returns>The JPEG bytes, or null when no poster could be decoded or SkiaSharp failed.</returns>
        public static byte[]? Render(IReadOnlyList<byte[]> posters, bool square)
        {
            ArgumentNullException.ThrowIfNull(posters);
            var decoded = new List<SKBitmap>(MaxPosters);
            try
            {
                foreach (var bytes in posters)
                {
                    if (decoded.Count == MaxPosters)
                    {
                        break;
                    }

                    if (bytes == null || bytes.Length == 0)
                    {
                        continue;
                    }

                    var bitmap = TryDecode(bytes);
                    if (bitmap == null || bitmap.Width <= 0 || bitmap.Height <= 0)
                    {
                        bitmap?.Dispose();
                        continue;
                    }

                    decoded.Add(bitmap);
                }

                if (decoded.Count == 0)
                {
                    return null;
                }

                var (width, height) = SizeFor(square);
                using var surface = SKSurface.Create(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul));
                if (surface == null)
                {
                    return null;
                }

                var canvas = surface.Canvas;
                canvas.Clear(new SKColor(0x10, 0x10, 0x10));
                if (decoded.Count == 1 && square)
                {
                    DrawSingleOnSquare(canvas, decoded[0], width, height);
                }
                else
                {
                    var cells = Layout(decoded.Count, width, height);
                    for (var i = 0; i < cells.Count; i++)
                    {
                        DrawCover(canvas, decoded[i], cells[i], null);
                    }
                }

                canvas.Flush();
                using var image = surface.Snapshot();
                using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, JpegQuality);
                return encoded?.ToArray();
            }
            finally
            {
                foreach (var bitmap in decoded)
                {
                    bitmap.Dispose();
                }
            }
        }

        // SKBitmap.Decode(byte[]) throws (instead of returning null) when no codec recognises the data.
        /// <summary>
        /// True when the bytes are an image the collage can use: a known format that decodes completely (a truncated
        /// or corrupt file is refused, not drawn half grey) and isn't absurdly large.
        /// </summary>
        /// <param name="bytes">Encoded image.</param>
        /// <returns>Whether it decodes.</returns>
        public static bool CanDecode(byte[] bytes)
        {
            using var bitmap = bytes == null || bytes.Length == 0 ? null : TryDecode(bytes);
            return bitmap != null;
        }

        // Strict decode: null unless the codec recognises the data and decodes every pixel (SKBitmap.Decode accepts
        // incomplete input and returns a partly blank image).
        private static SKBitmap? TryDecode(byte[] bytes)
        {
            using var data = SKData.CreateCopy(bytes);
            using var codec = SKCodec.Create(data);
            if (codec == null || codec.Info.Width <= 0 || codec.Info.Height <= 0 || (long)codec.Info.Width * codec.Info.Height > MaxPosterPixels)
            {
                return null;
            }

            var bitmap = new SKBitmap(new SKImageInfo(codec.Info.Width, codec.Info.Height, SKImageInfo.PlatformColorType, SKAlphaType.Premul));
            var pixels = bitmap.GetPixels();
            if (pixels == IntPtr.Zero || codec.GetPixels(bitmap.Info, pixels) != SKCodecResult.Success)
            {
                bitmap.Dispose();
                return null;
            }

            return bitmap;
        }

        // One poster on a square canvas: a blurred, darkened cover-filled copy as the backdrop and the whole poster,
        // scaled to the canvas height, centred on top of it.
        private static void DrawSingleOnSquare(SKCanvas canvas, SKBitmap poster, int width, int height)
        {
            using (var paint = new SKPaint
            {
                // Owned by the paint (see ImageBlurService): not disposed separately.
                ImageFilter = SKImageFilter.CreateBlur(BackgroundBlurSigma, BackgroundBlurSigma, SKShaderTileMode.Clamp),
                IsAntialias = true,
            })
            {
                DrawCover(canvas, poster, new SKRectI(0, 0, width, height), paint);
            }

            using (var shade = new SKPaint { Color = new SKColor(0, 0, 0, 115) })
            {
                canvas.DrawRect(new SKRect(0, 0, width, height), shade);
            }

            var scale = Math.Min((float)width / poster.Width, (float)height / poster.Height);
            var fitW = Math.Max(1, (int)Math.Round(poster.Width * scale));
            var fitH = Math.Max(1, (int)Math.Round(poster.Height * scale));
            var left = (width - fitW) / 2;
            var top = (height - fitH) / 2;
            DrawCover(canvas, poster, new SKRectI(left, top, left + fitW, top + fitH), null);
        }

        // Scales the poster to cover the cell (keeping its aspect ratio) and draws the centred crop.
        private static void DrawCover(SKCanvas canvas, SKBitmap poster, SKRectI cell, SKPaint? paint)
        {
            var cellW = cell.Width;
            var cellH = cell.Height;
            if (cellW <= 0 || cellH <= 0)
            {
                return;
            }

            var scale = Math.Max((float)cellW / poster.Width, (float)cellH / poster.Height);
            var scaledW = Math.Max(cellW, (int)Math.Ceiling(poster.Width * scale));
            var scaledH = Math.Max(cellH, (int)Math.Ceiling(poster.Height * scale));
            using var scaled = new SKBitmap(new SKImageInfo(scaledW, scaledH, SKColorType.Rgba8888, SKAlphaType.Premul));
            if (!poster.ScalePixels(scaled, new SKSamplingOptions(SKCubicResampler.Mitchell)))
            {
                return;
            }

            canvas.Save();
            canvas.ClipRect(new SKRect(cell.Left, cell.Top, cell.Right, cell.Bottom));
            canvas.DrawBitmap(scaled, cell.Left - ((scaledW - cellW) / 2f), cell.Top - ((scaledH - cellH) / 2f), paint);
            canvas.Restore();
        }
    }
}
