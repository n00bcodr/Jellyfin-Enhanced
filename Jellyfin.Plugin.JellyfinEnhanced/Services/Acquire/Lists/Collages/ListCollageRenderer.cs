using System;
using System.Collections.Generic;
using System.Threading;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Collages
{
    /// <summary>The shape of a list's collage, as Jellyfin shapes its own list images.</summary>
    public enum ListCollageShape
    {
        /// <summary>A playlist: 600x600.</summary>
        Square = 0,

        /// <summary>A collection: 400x600 (2:3).</summary>
        Poster = 1,
    }

    /// <summary>A rendered collage.</summary>
    /// <param name="Jpeg">The JPEG bytes.</param>
    /// <param name="Width">Width in pixels.</param>
    /// <param name="Height">Height in pixels.</param>
    /// <param name="Shape">The shape it was drawn for.</param>
    /// <param name="UsedInputs">Indexes (in the input list) of the posters drawn, in cell order.</param>
    public sealed record ListCollageRendering(byte[] Jpeg, int Width, int Height, ListCollageShape Shape, IReadOnlyList<int> UsedInputs);

    /// <summary>
    /// Renders the poster collage of a placeholder-only list from poster bytes the caller already has (no fetching, no
    /// files), with the SkiaSharp copy Jellyfin itself loads.
    /// <list type="bullet">
    /// <item>1 poster: a collection shows it as is; a playlist shows it whole, fitted to the height and centred on a
    /// blurred, darkened copy of itself.</item>
    /// <item>2 posters: two columns. 3: the first as a full-height left column, the other two stacked on the right.
    /// 4: a 2x2 grid. Every cell is filled edge to edge (scaled to cover, centred crop).</item>
    /// </list>
    /// Only the first <see cref="MaxInputs"/> inputs are looked at, inputs over <see cref="MaxInputBytes"/> are skipped,
    /// and a source must decode completely within <see cref="MaxSourcePixels"/> pixels and a 4:1 aspect. Every Skia
    /// object is disposed whether rendering succeeds, finds nothing usable or is cancelled. Stateless: no usable poster
    /// is no collage, never an earlier one.
    /// </summary>
    public static class ListCollageRenderer
    {
        /// <summary>Most posters drawn.</summary>
        public const int MaxPosters = 4;

        /// <summary>Most inputs looked at (the candidates of one selection).</summary>
        public const int MaxInputs = 8;

        /// <summary>Largest encoded poster accepted, in bytes.</summary>
        public const int MaxInputBytes = 2 * 1024 * 1024;

        /// <summary>Most source pixels decoded (4096x4096).</summary>
        public const long MaxSourcePixels = 4096L * 4096L;

        /// <summary>Flattest or tallest source accepted (either way).</summary>
        public const int MaxAspectRatio = 4;

        /// <summary>JPEG quality of the output.</summary>
        public const int JpegQuality = 90;

        /// <summary>Square side.</summary>
        public const int SquareSize = 600;

        /// <summary>Poster width.</summary>
        public const int PosterWidth = 400;

        /// <summary>Poster height.</summary>
        public const int PosterHeight = 600;

        /// <summary>Identifies this renderer's layout and drawing, for byte identities: change it with either.</summary>
        public const string Version = "je-list-collage-1";

        private const float BackgroundBlurSigma = 24f;
        private const byte BackgroundShadeAlpha = 115;

        private static readonly AsyncLocal<ListCollageRenderTrace?> CurrentTrace = new();

        /// <summary>The shape of a list kind, or null for a kind that has no collage.</summary>
        /// <param name="listKind">A <see cref="ListKinds"/> value.</param>
        /// <returns>The shape or null.</returns>
        public static ListCollageShape? ShapeFor(string? listKind) => listKind switch
        {
            ListKinds.Playlist => ListCollageShape.Square,
            ListKinds.Collection => ListCollageShape.Poster,
            _ => null,
        };

        /// <summary>The output size of a shape.</summary>
        /// <param name="shape">The shape.</param>
        /// <returns>Width and height.</returns>
        public static (int Width, int Height) SizeFor(ListCollageShape shape) => shape switch
        {
            ListCollageShape.Square => (SquareSize, SquareSize),
            ListCollageShape.Poster => (PosterWidth, PosterHeight),
            _ => throw new ArgumentOutOfRangeException(nameof(shape), shape, "Unknown collage shape."),
        };

        /// <summary>The cells (in poster order) of a collage of <paramref name="count"/> posters.</summary>
        /// <param name="count">Posters drawn (clamped to 0-4).</param>
        /// <param name="width">Canvas width.</param>
        /// <param name="height">Canvas height.</param>
        /// <returns>One rectangle per poster.</returns>
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
        /// Whether bytes are a poster the collage can use: within the byte limit, a known format that decodes completely
        /// (a truncated file is refused, not drawn half grey), within the pixel limit and at most 4:1 either way.
        /// </summary>
        /// <param name="bytes">Encoded image.</param>
        /// <returns>Whether it is usable.</returns>
        public static bool CanDecode(byte[]? bytes)
        {
            var owned = new List<IDisposable>(4);
            try
            {
                return TryDecode(bytes, owned, CancellationToken.None) != null;
            }
            finally
            {
                DisposeAll(owned);
            }
        }

        /// <summary>
        /// Renders the collage of the first usable posters (at most four of the first eight inputs, in input order).
        /// </summary>
        /// <param name="posters">Encoded posters (JPEG/PNG/WebP), in list order.</param>
        /// <param name="shape">The list's shape.</param>
        /// <param name="cancellationToken">Cancels between steps (everything created so far is disposed).</param>
        /// <returns>The rendering, or null when no input is usable or Skia produced nothing.</returns>
        public static ListCollageRendering? Render(IReadOnlyList<byte[]?> posters, ListCollageShape shape, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(posters);
            var (width, height) = SizeFor(shape);
            cancellationToken.ThrowIfCancellationRequested();
            var owned = new List<IDisposable>(16);
            try
            {
                var decoded = new List<SKBitmap>(MaxPosters);
                var used = new List<int>(MaxPosters);
                for (var i = 0; i < posters.Count && i < MaxInputs && decoded.Count < MaxPosters; i++)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var bitmap = TryDecode(posters[i], owned, cancellationToken);
                    if (bitmap != null)
                    {
                        decoded.Add(bitmap);
                        used.Add(i);
                        Stage("decoded:" + decoded.Count);
                    }
                }

                if (decoded.Count == 0)
                {
                    return null;
                }

                cancellationToken.ThrowIfCancellationRequested();
                var surface = Own(owned, SKSurface.Create(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul)));
                if (surface == null)
                {
                    return null;
                }

                var canvas = surface.Canvas;
                canvas.Clear(new SKColor(0x10, 0x10, 0x10));
                if (decoded.Count == 1 && shape == ListCollageShape.Square)
                {
                    DrawSingleOnSquare(canvas, decoded[0], width, height, owned);
                }
                else
                {
                    var cells = Layout(decoded.Count, width, height);
                    for (var i = 0; i < cells.Count; i++)
                    {
                        DrawCover(canvas, decoded[i], cells[i], null, owned);
                    }
                }

                canvas.Flush();
                Stage("drawn");
                cancellationToken.ThrowIfCancellationRequested();
                var image = Own(owned, surface.Snapshot());
                var encoded = Own(owned, image?.Encode(SKEncodedImageFormat.Jpeg, JpegQuality));
                Stage("encoded");
                var bytes = encoded?.ToArray();
                return bytes == null || bytes.Length == 0 ? null : new ListCollageRendering(bytes, width, height, shape, used);
            }
            finally
            {
                DisposeAll(owned);
            }
        }

        /// <summary>Starts counting this flow's Skia objects (tests); dispose to stop.</summary>
        /// <returns>The trace.</returns>
        internal static ListCollageRenderTrace Trace()
        {
            var trace = new ListCollageRenderTrace(CurrentTrace.Value, t => CurrentTrace.Value = t);
            CurrentTrace.Value = trace;
            return trace;
        }

        // Strict decode: null unless the bytes are within limits, a codec recognises them and decodes every pixel.
        private static SKBitmap? TryDecode(byte[]? bytes, List<IDisposable> owned, CancellationToken cancellationToken)
        {
            if (bytes == null || bytes.Length == 0 || bytes.Length > MaxInputBytes)
            {
                return null;
            }

            var data = Own(owned, SKData.CreateCopy(bytes));
            var codec = data == null ? null : Own(owned, SKCodec.Create(data));
            if (codec == null)
            {
                return null;
            }

            var info = codec.Info;
            if (info.Width <= 0 || info.Height <= 0 || (long)info.Width * info.Height > MaxSourcePixels
                || info.Width > (long)info.Height * MaxAspectRatio || info.Height > (long)info.Width * MaxAspectRatio)
            {
                return null;
            }

            cancellationToken.ThrowIfCancellationRequested();
            var bitmap = Own(owned, new SKBitmap(new SKImageInfo(info.Width, info.Height, SKImageInfo.PlatformColorType, SKAlphaType.Premul)));
            var pixels = bitmap.GetPixels();
            if (pixels == IntPtr.Zero || codec.GetPixels(bitmap.Info, pixels) != SKCodecResult.Success)
            {
                return null;
            }

            return bitmap;
        }

        // One poster on a square: a blurred, darkened cover-filled copy as the backdrop and the whole poster, fitted to
        // the canvas, centred on top.
        private static void DrawSingleOnSquare(SKCanvas canvas, SKBitmap poster, int width, int height, List<IDisposable> owned)
        {
            var blur = Own(owned, SKImageFilter.CreateBlur(BackgroundBlurSigma, BackgroundBlurSigma, SKShaderTileMode.Clamp));
            var backdrop = Own(owned, new SKPaint { ImageFilter = blur, IsAntialias = true });
            DrawCover(canvas, poster, new SKRectI(0, 0, width, height), backdrop, owned);

            var shade = Own(owned, new SKPaint { Color = new SKColor(0, 0, 0, BackgroundShadeAlpha) });
            canvas.DrawRect(new SKRect(0, 0, width, height), shade);

            var scale = Math.Min((float)width / poster.Width, (float)height / poster.Height);
            var fitW = Math.Max(1, (int)Math.Round(poster.Width * scale));
            var fitH = Math.Max(1, (int)Math.Round(poster.Height * scale));
            var left = (width - fitW) / 2;
            var top = (height - fitH) / 2;
            DrawCover(canvas, poster, new SKRectI(left, top, left + fitW, top + fitH), null, owned);
        }

        // Draws the centred part of the poster with the cell's aspect, scaled into the cell (cover). No scaled copy is made,
        // so memory stays bounded by the decoded poster and the canvas whatever the poster's shape.
        private static void DrawCover(SKCanvas canvas, SKBitmap poster, SKRectI cell, SKPaint? paint, List<IDisposable> owned)
        {
            if (cell.Width <= 0 || cell.Height <= 0)
            {
                return;
            }

            var scale = Math.Max((float)cell.Width / poster.Width, (float)cell.Height / poster.Height);
            var sourceW = Math.Min(poster.Width, cell.Width / scale);
            var sourceH = Math.Min(poster.Height, cell.Height / scale);
            var source = SKRect.Create((poster.Width - sourceW) / 2f, (poster.Height - sourceH) / 2f, sourceW, sourceH);
            var image = Own(owned, SKImage.FromBitmap(poster));
            canvas.DrawImage(image, source, new SKRect(cell.Left, cell.Top, cell.Right, cell.Bottom), new SKSamplingOptions(SKCubicResampler.Mitchell), paint);
        }

        private static T Own<T>(List<IDisposable> owned, T resource)
            where T : IDisposable?
        {
            if (resource != null)
            {
                owned.Add(resource);
                CurrentTrace.Value?.Created();
            }

            return resource;
        }

        private static void DisposeAll(List<IDisposable> owned)
        {
            for (var i = owned.Count - 1; i >= 0; i--)
            {
                owned[i].Dispose();
                CurrentTrace.Value?.Disposed();
            }

            owned.Clear();
        }

        private static void Stage(string stage) => CurrentTrace.Value?.OnStage?.Invoke(stage);
    }

    /// <summary>Counts the Skia objects one flow of <see cref="ListCollageRenderer"/> creates and disposes (tests).</summary>
    internal sealed class ListCollageRenderTrace : IDisposable
    {
        private readonly ListCollageRenderTrace? _previous;
        private readonly Action<ListCollageRenderTrace?> _restore;
        private int _created;
        private int _disposed;

        internal ListCollageRenderTrace(ListCollageRenderTrace? previous, Action<ListCollageRenderTrace?> restore)
        {
            _previous = previous;
            _restore = restore;
        }

        /// <summary>Gets the objects created.</summary>
        internal int CreatedCount => Volatile.Read(ref _created);

        /// <summary>Gets the objects disposed.</summary>
        internal int DisposedCount => Volatile.Read(ref _disposed);

        /// <summary>Gets or sets a callback per rendering step ("decoded:n", "drawn", "encoded").</summary>
        internal Action<string>? OnStage { get; set; }

        /// <inheritdoc />
        public void Dispose() => _restore(_previous);

        internal void Created() => Interlocked.Increment(ref _created);

        internal void Disposed() => Interlocked.Increment(ref _disposed);
    }
}
