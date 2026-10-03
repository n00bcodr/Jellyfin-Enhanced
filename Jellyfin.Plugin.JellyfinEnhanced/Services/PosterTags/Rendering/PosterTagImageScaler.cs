using System;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering
{
    /// <summary>
    /// Area-average ("box") downscaling for the flag rasters. Averaging the covered source area per target pixel is what
    /// rasterising the original SVG at the small size does (coverage anti-aliasing), so a 160x120 flag shrunk to a
    /// card's 27x20 matches the browser's vector rendering more closely than mipmapped or cubic sampling.
    /// </summary>
    internal static class PosterTagImageScaler
    {
        /// <summary>
        /// Scales <paramref name="source"/> (a raster RGBA8888 premultiplied image) to exactly
        /// <paramref name="width"/> x <paramref name="height"/>. Area-averages when shrinking; uses cubic resampling when
        /// a side grows.
        /// </summary>
        public static SKImage? Scale(SKImage source, int width, int height)
        {
            if (width <= 0 || height <= 0)
            {
                return null;
            }

            var info = new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul);
            using var pixmap = source.PeekPixels();
            if (pixmap is null || pixmap.ColorType != SKColorType.Rgba8888 || width > source.Width || height > source.Height)
            {
                using var bitmap = new SKBitmap(info);
                using var target = bitmap.PeekPixels();
                if (!source.ScalePixels(target, new SKSamplingOptions(SKCubicResampler.Mitchell)))
                {
                    return null;
                }

                return SKImage.FromBitmap(bitmap);
            }

            var src = pixmap.GetPixelSpan<byte>();
            int srcW = pixmap.Width, srcH = pixmap.Height, srcStride = pixmap.RowBytes;
            var dst = new byte[width * height * 4];
            var (xIndex, xSource, xWeight) = Weights(srcW, width);
            var (yIndex, ySource, yWeight) = Weights(srcH, height);

            // Separable: rows first into a float buffer of width x srcH, then columns.
            var rows = new float[width * srcH * 4];
            for (int y = 0; y < srcH; y++)
            {
                var line = src.Slice(y * srcStride, srcW * 4);
                for (int x = 0; x < width; x++)
                {
                    float r = 0, g = 0, b = 0, a = 0;
                    for (int k = xIndex[x]; k < xIndex[x + 1]; k++)
                    {
                        float w = xWeight[k];
                        int sx = xSource[k];
                        r += line[(sx * 4) + 0] * w;
                        g += line[(sx * 4) + 1] * w;
                        b += line[(sx * 4) + 2] * w;
                        a += line[(sx * 4) + 3] * w;
                    }

                    int o = ((y * width) + x) * 4;
                    rows[o] = r;
                    rows[o + 1] = g;
                    rows[o + 2] = b;
                    rows[o + 3] = a;
                }
            }

            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    float r = 0, g = 0, b = 0, a = 0;
                    for (int k = yIndex[y]; k < yIndex[y + 1]; k++)
                    {
                        float w = yWeight[k];
                        int sy = ySource[k];
                        int o = ((sy * width) + x) * 4;
                        r += rows[o] * w;
                        g += rows[o + 1] * w;
                        b += rows[o + 2] * w;
                        a += rows[o + 3] * w;
                    }

                    int d = ((y * width) + x) * 4;
                    dst[d] = ToByte(r);
                    dst[d + 1] = ToByte(g);
                    dst[d + 2] = ToByte(b);
                    dst[d + 3] = ToByte(a);
                }
            }

            return SKImage.FromPixelCopy(info, dst, width * 4);
        }

        private static byte ToByte(float v) => (byte)Math.Clamp((int)MathF.Round(v), 0, 255);

        /// <summary>
        /// Box-filter kernel in CSR form: entries index[t]..index[t+1] of source/weight belong to target pixel t; the
        /// weights are the covered fraction of each source pixel and sum to 1.
        /// </summary>
        private static (int[] Index, int[] Source, float[] Weight) Weights(int srcSize, int dstSize)
        {
            double scale = (double)srcSize / dstSize;
            var index = new int[dstSize + 1];
            var source = new System.Collections.Generic.List<int>(srcSize + dstSize);
            var weight = new System.Collections.Generic.List<float>(srcSize + dstSize);
            for (int t = 0; t < dstSize; t++)
            {
                index[t] = source.Count;
                double start = t * scale;
                double end = (t + 1) * scale;
                for (int i = (int)Math.Floor(start); i < Math.Min(srcSize, (int)Math.Ceiling(end)); i++)
                {
                    double covered = Math.Min(end, i + 1) - Math.Max(start, i);
                    if (covered > 0)
                    {
                        source.Add(i);
                        weight.Add((float)(covered / scale));
                    }
                }
            }

            index[dstSize] = source.Count;
            return (index, source.ToArray(), weight.ToArray());
        }
    }
}
