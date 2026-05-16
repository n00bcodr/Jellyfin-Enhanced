using System;
using System.Collections.Concurrent;
using System.Threading;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    // Produces a "spoiler-style" blurred version of an input image, using
    // SkiaSharp's CreateBlur ImageFilter (a separable Gaussian implemented
    // in native code, with proper edge handling).
    //
    // Why SkiaSharp:
    //   - Jellyfin loads SkiaSharp.dll as its own thumbnail engine, so we
    //     reference it without shipping a copy.
    //   - Native, ~130 ms on 1280x720; pure-managed alternatives were 2 s+.
    //   - No banding artefacts at any sigma (ImageSharp's GaussianBlur
    //     produced visible vertical-stripe artefacts at sigma >= 25 on
    //     cartoon-style sources — see SPOILER_BLUR_FINDINGS.md).
    //
    // Cache results by (originalEtag, sigma) keyed by the caller. The cache
    // is bounded by entry count and total bytes; overflow evicts oldest.
    public sealed class ImageBlurService
    {
        private const int MaxCacheEntries = 256;
        private const long MaxCacheBytes = 64L * 1024 * 1024; // 64 MiB

        // Decoded source pixel ceiling (long edge). Episode thumbnails are at
        // most ~1280x720; constraining bounds runtime in case Jellyfin serves
        // a 4K backdrop here.
        private const int MaxDecodeEdgePx = 1920;

        // Sigma range exposed to admins. 1 = barely blurred, 100 = solid
        // blob. Default 40 hides scene content while keeping silhouettes
        // and dominant colours visible for cartoon-style children's shows.
        private const float MinSigma = 1f;
        private const float MaxSigma = 100f;

        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, CacheEntry> _cache = new();
        private long _cacheBytes;
        private readonly object _evictionLock = new();

        public ImageBlurService(Logger logger)
        {
            _logger = logger;
        }

        // Blurs <paramref name="input"/> and returns JPEG bytes. <paramref name="cacheKey"/>
        // should uniquely identify the source image+sigma; pass null/empty to skip cache.
        // Returns null on any decode/encode failure — caller should fall back to the
        // original bytes rather than serve a broken image.
        // Returns a tiny solid-grey JPEG sized to the input (or default
        // 600x900 poster ratio if input bytes can't be decoded). Used by
        // SpoilerBlurMode == "hide" — instead of blurring the actual
        // image, we return a generic placeholder so the user sees a
        // blank card. Cheap (~1 KB output), no per-image variation.
        // Output is a flat #101010 rectangle — matches Jellyfin's default
        // dark-theme --card-bg-color so the placeholder blends with the
        // card chrome the way an empty "missing episode" card does
        // rather than reading as a distinct grey block.
        public byte[]? StockCard(byte[] input, string? cacheKey)
        {
            if (!string.IsNullOrEmpty(cacheKey)
                && _cache.TryGetValue(cacheKey, out var cached))
            {
                Interlocked.Exchange(ref cached.LastAccessTicks, DateTime.UtcNow.Ticks);
                return cached.Bytes;
            }

            int width = 600;
            int height = 900;
            try
            {
                if (input != null && input.Length > 0)
                {
                    using var probe = SKBitmap.Decode(input);
                    if (probe != null && probe.Width > 0 && probe.Height > 0)
                    {
                        width = probe.Width;
                        height = probe.Height;
                        var longEdge = Math.Max(width, height);
                        if (longEdge > MaxDecodeEdgePx)
                        {
                            var ratio = (float)MaxDecodeEdgePx / longEdge;
                            width = Math.Max(1, (int)(width * ratio));
                            height = Math.Max(1, (int)(height * ratio));
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                // Decoder failed on probe — fall through to default 600x900.
                // Rate-limited so a malformed-image flood (corrupt poster
                // somewhere in the library) can't fill the log.
                _logger.Debug($"Spoiler stock-card probe failed for input ({input?.Length ?? 0} bytes): {ex.GetType().Name}: {ex.Message}. Using default dims 600x900.");
            }

            byte[]? output;
            try
            {
                using var surface = SKSurface.Create(new SKImageInfo(width, height));
                if (surface == null) return null;
                surface.Canvas.Clear(new SKColor(0x10, 0x10, 0x10));
                using var image = surface.Snapshot();
                using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, 70);
                if (encoded == null) return null;
                output = encoded.ToArray();
            }
            catch (Exception ex)
            {
                _logger.Error($"Spoiler stock-card render failed: {ex.Message}");
                return null;
            }

            if (!string.IsNullOrEmpty(cacheKey))
            {
                StoreInCache(cacheKey, output);
            }
            return output;
        }

        // R25: re-encode `source` JPEG bytes resized to match the
        // dimensions of `referenceBytes` (or, if the source is much
        // larger than the reference, scale it down). Used by the
        // hide-mode parent-Primary fallback so the placeholder card
        // doesn't shift the client's grid layout. Cached in the same
        // LRU as Blur/StockCard.
        public byte[]? ResizeToMatch(byte[] source, byte[] referenceBytes, string? cacheKey)
        {
            if (source == null || source.Length == 0) return null;

            if (!string.IsNullOrEmpty(cacheKey)
                && _cache.TryGetValue(cacheKey, out var cached))
            {
                Interlocked.Exchange(ref cached.LastAccessTicks, DateTime.UtcNow.Ticks);
                return cached.Bytes;
            }

            int targetW = 600, targetH = 900;
            try
            {
                if (referenceBytes != null && referenceBytes.Length > 0)
                {
                    using var probe = SKBitmap.Decode(referenceBytes);
                    if (probe != null && probe.Width > 0 && probe.Height > 0)
                    {
                        targetW = probe.Width;
                        targetH = probe.Height;
                    }
                }
            }
            catch (Exception ex)
            {
                // Reference probe failed — fall back to default 600x900
                // target dims. Debug-level since this fires for any
                // malformed reference and we have a sane default.
                _logger.Debug($"Spoiler parent-Primary reference probe failed: {ex.GetType().Name}: {ex.Message}. Using default dims 600x900.");
            }

            byte[]? output;
            try
            {
                using var srcBitmap = SKBitmap.Decode(source);
                if (srcBitmap == null) return null;

                int srcW = srcBitmap.Width;
                int srcH = srcBitmap.Height;
                if (srcW <= 0 || srcH <= 0) return null;

                // Cap target at MaxDecodeEdgePx so we don't blow memory
                // on a huge poster fed through a small thumbnail request.
                var longEdge = Math.Max(targetW, targetH);
                if (longEdge > MaxDecodeEdgePx)
                {
                    var ratio = (float)MaxDecodeEdgePx / longEdge;
                    targetW = Math.Max(1, (int)(targetW * ratio));
                    targetH = Math.Max(1, (int)(targetH * ratio));
                }

                // Scale source to target dims using high-quality sampling.
                var info = new SKImageInfo(targetW, targetH);
                using var dst = new SKBitmap(info);
                if (!srcBitmap.ScalePixels(dst, new SKSamplingOptions(SKCubicResampler.Mitchell)))
                {
                    return null;
                }
                using var image = SKImage.FromBitmap(dst);
                using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, 85);
                if (encoded == null) return null;
                output = encoded.ToArray();
            }
            catch (Exception ex)
            {
                _logger.Error($"Spoiler parent-Primary resize failed: {ex.Message}");
                return null;
            }

            if (!string.IsNullOrEmpty(cacheKey))
            {
                StoreInCache(cacheKey, output);
            }

            return output;
        }

        public byte[]? Blur(byte[] input, float requestedSigma, string? cacheKey)
        {
            if (input == null || input.Length == 0) return null;

            var sigma = Math.Clamp(requestedSigma, MinSigma, MaxSigma);

            if (!string.IsNullOrEmpty(cacheKey)
                && _cache.TryGetValue(cacheKey, out var cached))
            {
                // L3: Interlocked.Exchange for atomic 64-bit write — torn
                // reads on 32-bit ARM hosts could yield unstable LRU sort
                // order during eviction.
                Interlocked.Exchange(ref cached.LastAccessTicks, DateTime.UtcNow.Ticks);
                return cached.Bytes;
            }

            byte[]? output;
            try
            {
                output = BlurInternal(input, sigma);
            }
            catch (Exception ex)
            {
                _logger.Error($"Spoiler blur failed: {ex.Message}");
                return null;
            }

            if (output == null) return null;

            if (!string.IsNullOrEmpty(cacheKey))
            {
                StoreInCache(cacheKey, output);
            }

            return output;
        }

        private byte[]? BlurInternal(byte[] input, float sigma)
        {
            using var bitmap = SKBitmap.Decode(input);
            if (bitmap == null) return null;

            int width = bitmap.Width;
            int height = bitmap.Height;
            if (width <= 0 || height <= 0) return null;

            // Constrain very large source images first; saves CPU + memory.
            SKBitmap workingBitmap = bitmap;
            SKBitmap? resized = null;
            try
            {
                int longEdge = Math.Max(width, height);
                if (longEdge > MaxDecodeEdgePx)
                {
                    var ratio = (float)MaxDecodeEdgePx / longEdge;
                    int newW = Math.Max(1, (int)(width * ratio));
                    int newH = Math.Max(1, (int)(height * ratio));
                    resized = bitmap.Resize(new SKImageInfo(newW, newH), SKSamplingOptions.Default);
                    if (resized != null)
                    {
                        workingBitmap = resized;
                        width = newW;
                        height = newH;
                    }
                }

                using var surface = SKSurface.Create(new SKImageInfo(width, height));
                if (surface == null) return null;

                using var paint = new SKPaint
                {
                    // Clamp tile mode samples the edge pixel beyond the canvas
                    // so we don't get a black halo from the kernel reading
                    // transparent pixels. The SKImageFilter is owned by the
                    // SKPaint via SkiaSharp's internal ref-counting — wrapping
                    // it in `using var` (codex L1) and assigning to
                    // ImageFilter caused the filter to be released early in
                    // some draw paths and silently produce unblurred output
                    // (verified empirically on jellyfin-dev 2026-05-06).
                    ImageFilter = SKImageFilter.CreateBlur(sigma, sigma, SKShaderTileMode.Clamp),
                    IsAntialias = true,
                };

                surface.Canvas.Clear(SKColors.Transparent);
                surface.Canvas.DrawBitmap(workingBitmap, 0, 0, paint);

                using var image = surface.Snapshot();
                // Quality 85: heavily smoothed images don't benefit from
                // higher q; 85 keeps file size small (~30-40 KB at 1280x720).
                using var encoded = image.Encode(SKEncodedImageFormat.Jpeg, 85);
                if (encoded == null) return null;
                return encoded.ToArray();
            }
            finally
            {
                resized?.Dispose();
            }
        }

        private void StoreInCache(string key, byte[] bytes)
        {
            var entry = new CacheEntry
            {
                Bytes = bytes,
                LastAccessTicks = DateTime.UtcNow.Ticks,
            };

            if (_cache.TryAdd(key, entry))
            {
                Interlocked.Add(ref _cacheBytes, bytes.LongLength);
            }
            else
            {
                // Race: another caller blurred the same key first. Their entry is fine; drop ours.
                return;
            }

            EvictIfOverCap();
        }

        private void EvictIfOverCap()
        {
            // L4: serialize eviction so two threads observing the cap exceeded
            // don't both snapshot and over-evict. The blur-and-store path holds
            // this lock only for the eviction window, which is rare (cap-only)
            // and short — not on the hot path.
            if (_cache.Count <= MaxCacheEntries
                && Interlocked.Read(ref _cacheBytes) <= MaxCacheBytes)
            {
                return;
            }

            lock (_evictionLock)
            {
                // Re-check under the lock — another thread may already have evicted.
                if (_cache.Count <= MaxCacheEntries
                    && Interlocked.Read(ref _cacheBytes) <= MaxCacheBytes)
                {
                    return;
                }

                var snapshot = _cache.ToArray();
                Array.Sort(snapshot, (a, b) => a.Value.LastAccessTicks.CompareTo(b.Value.LastAccessTicks));

                foreach (var kvp in snapshot)
                {
                    if (_cache.Count <= MaxCacheEntries / 2
                        && Interlocked.Read(ref _cacheBytes) <= MaxCacheBytes / 2)
                    {
                        break;
                    }
                    if (_cache.TryRemove(kvp.Key, out var removed))
                    {
                        Interlocked.Add(ref _cacheBytes, -removed.Bytes.LongLength);
                    }
                }
            }
        }

        public void Clear()
        {
            _cache.Clear();
            Interlocked.Exchange(ref _cacheBytes, 0);
        }

        private sealed class CacheEntry
        {
            public required byte[] Bytes { get; init; }
            public long LastAccessTicks;
        }
    }
}
