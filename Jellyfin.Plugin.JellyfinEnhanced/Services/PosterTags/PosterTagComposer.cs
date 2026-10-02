using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>The image a poster is drawn on.</summary>
    /// <param name="ContentType">Normalized media type (image/jpeg, image/png or image/webp).</param>
    /// <param name="Identity">
    /// A string that changes whenever the bytes can change: the served file's path, length and modification
    /// time, or a hash of in-memory bytes (Spoiler Guard–transformed images).
    /// </param>
    /// <param name="Load">Reads the bytes. Called at most once, only on a cache miss.</param>
    public sealed record PosterTagBaseImage(string ContentType, string Identity, Func<Task<byte[]>> Load);

    /// <summary>What <see cref="PosterTagComposer.ComposeAsync"/> produced.</summary>
    public enum PosterTagComposeStatus
    {
        /// <summary>A composite was drawn (or served from cache).</summary>
        Rendered,

        /// <summary>Nothing to draw: serve the original image (deterministic, cacheable).</summary>
        Passthrough,

        /// <summary>No tag data could be found or built for the item (transient: do not cache the original).</summary>
        NoData,
    }

    /// <summary>The outcome of composing one poster.</summary>
    /// <param name="Status">What happened.</param>
    /// <param name="Bytes">The composite (only for <see cref="PosterTagComposeStatus.Rendered"/>).</param>
    /// <param name="Key">The content-addressed composite key (empty for <see cref="PosterTagComposeStatus.NoData"/>).</param>
    /// <param name="SpoilerStripped">True when Spoiler Guard stripped the tag data for this viewer.</param>
    public sealed record PosterTagComposeResult(PosterTagComposeStatus Status, byte[]? Bytes, string Key, bool SpoilerStripped);

    // Data → layout → pixels for one poster, shared by the image filter and the
    // admin preview endpoint so both draw exactly the same thing:
    //
    //   PosterTagDataProvider (entry, Spoiler Guard strip, review chip)
    //   → CompositeImageCache key (content-addressed, see there)
    //   → on a miss: decode size, landscape = width > 1.2 × height,
    //     PosterTagResolver.Resolve, PosterTagRenderer.RenderEncoded.
    public sealed class PosterTagComposer
    {
        /// <summary>Bumped when this class's composition rules change (part of every composite key).</summary>
        public const string CompositionVersion = "1";

        /// <summary>
        /// Every version that changes a composite's pixels and is not already part of
        /// <see cref="PosterTagSettings.Digest"/> (which carries <see cref="PosterTagSettings.ResolverVersion"/>):
        /// the renderer's and this class's. Variant tokens are minted and verified against it, so a bump of
        /// either retires every issued URL instead of only regenerating server-side composites under URLs
        /// clients keep for a year.
        /// </summary>
        public const string PixelVersion = PosterTagRenderer.Version + "." + CompositionVersion;

        /// <summary>Largest base image ever loaded or drawn on; bigger ones pass through untouched.</summary>
        internal const int MaxSourceBytes = 32 * 1024 * 1024;

        private const int MinSide = 32;
        private const int MaxSide = 4096;

        private readonly PosterTagDataProvider _data;
        private readonly CompositeImageCache _cache;
        private readonly Lazy<PosterTagRenderer> _renderer;

        public PosterTagComposer(PosterTagDataProvider data, CompositeImageCache cache, IServiceProvider services)
        {
            _data = data;
            _cache = cache;
            // Resolved on the first actual render: the renderer loads fonts and
            // icons, which a server with the feature off should never pay for.
            // PublicationOnly: a failed construction is retried, not cached.
            _renderer = new Lazy<PosterTagRenderer>(services.GetRequiredService<PosterTagRenderer>, LazyThreadSafetyMode.PublicationOnly);
        }

        /// <summary>
        /// Composes the poster for a visible item. <paramref name="item"/> must come from a user-scoped lookup.
        /// <paramref name="topRightOffset"/> comes from the variant token, never from current user data, so the
        /// result is fully determined by the URL. With a <paramref name="snapshot"/> the tag data is taken from
        /// it instead of being re-read (the image filter draws exactly what the token was validated against).
        /// Exceptions mean "failed": serve the original uncached.
        /// </summary>
        public async Task<PosterTagComposeResult> ComposeAsync(
            HttpContext httpContext,
            BaseItem item,
            JUser user,
            PosterTagSettings settings,
            bool topRightOffset,
            PosterTagBaseImage image,
            int quality,
            bool useCache,
            CancellationToken cancellationToken,
            PosterTagDataSnapshot? snapshot = null)
        {
            var data = await _data.GetRenderDataAsync(httpContext, item, user, snapshot, cancellationToken).ConfigureAwait(false);
            if (data == null) return new PosterTagComposeResult(PosterTagComposeStatus.NoData, null, string.Empty, false);

            var key = CompositeKey(image, settings.Digest, topRightOffset, data.DataKey, quality);
            var itemType = data.Entry.Type ?? item.GetBaseItemKind().ToString();
            Task<byte[]> Render() => RenderAsync(image, data, settings, itemType, topRightOffset, quality);

            var bytes = useCache
                ? await _cache.GetOrCreateAsync(key, Extension(image.ContentType), Render, cancellationToken).ConfigureAwait(false)
                : await Render().ConfigureAwait(false);

            return bytes.Length == 0
                ? new PosterTagComposeResult(PosterTagComposeStatus.Passthrough, null, key, data.SpoilerStripped)
                : new PosterTagComposeResult(PosterTagComposeStatus.Rendered, bytes, key, data.SpoilerStripped);
        }

        /// <summary>
        /// Cheap end-of-stream check: JPEG ends with EOI (FF D9, allowing a little trailing padding), PNG with
        /// its IEND chunk, WebP's RIFF size covers the whole buffer.
        /// </summary>
        public static bool IsStructurallyComplete(ReadOnlySpan<byte> data, string contentType)
        {
            switch (contentType)
            {
                case "image/jpeg":
                    if (data.Length < 4 || data[0] != 0xFF || data[1] != 0xD8) return false;
                    for (var i = data.Length - 2; i >= Math.Max(2, data.Length - 64); i--)
                    {
                        if (data[i] == 0xFF && data[i + 1] == 0xD9) return true;
                    }

                    return false;
                case "image/png":
                    ReadOnlySpan<byte> iend = stackalloc byte[] { 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82 };
                    return data.Length >= 20 && data.Slice(data.Length - 8).SequenceEqual(iend);
                case "image/webp":
                    if (data.Length < 12 || data[0] != (byte)'R' || data[1] != (byte)'I' || data[2] != (byte)'F' || data[3] != (byte)'F') return false;
                    var riffSize = (long)data[4] | ((long)data[5] << 8) | ((long)data[6] << 16) | ((long)data[7] << 24);
                    return riffSize + 8 <= data.Length;
                default:
                    return false;
            }
        }

        /// <summary>The file extension the disk cache uses for a media type.</summary>
        public static string Extension(string contentType) => contentType switch
        {
            "image/png" => ".png",
            "image/webp" => ".webp",
            _ => ".jpg",
        };

        // The EXIF origins PosterTagRenderer's ApplyOrigin rotates by a quarter
        // turn (swapping width and height); keep the two lists in step.
        private static bool IsQuarterTurn(SKEncodedOrigin origin)
            => origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;

        private static string CompositeKey(PosterTagBaseImage image, string settingsDigest, bool topRightOffset, string dataKey, int quality)
        {
            var input = "ptc" + CompositionVersion
                + "|" + PosterTagRenderer.Version
                + "|" + image.ContentType
                + "|" + image.Identity
                + "|" + settingsDigest
                + "|" + (topRightOffset ? "1" : "0")
                + "|" + dataKey
                + "|" + quality.ToString(System.Globalization.CultureInfo.InvariantCulture);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input))).ToLowerInvariant();
        }

        // Returns CompositeImageCache.Passthrough when nothing is drawn.
        private async Task<byte[]> RenderAsync(
            PosterTagBaseImage image,
            PosterTagRenderData data,
            PosterTagSettings settings,
            string itemType,
            bool topRightOffset,
            int quality)
        {
            var source = await image.Load().ConfigureAwait(false);
            // The file loader already refuses oversized files before reading
            // them; this also covers in-memory sources (Spoiler Guard output).
            if (source.Length == 0 || source.Length > MaxSourceBytes) return CompositeImageCache.Passthrough;
            // Never cache a composite of a truncated image (Skia decodes those
            // "successfully" with a grey tail). Throwing = not cached, original served.
            if (!IsStructurallyComplete(source, image.ContentType))
            {
                throw new InvalidDataException("The base image is incomplete.");
            }

            int width, height;
            using (var encoded = SKData.CreateCopy(source))
            using (var codec = SKCodec.Create(encoded))
            {
                if (codec == null) return CompositeImageCache.Passthrough;
                width = codec.Info.Width;
                height = codec.Info.Height;
                // The renderer draws on the EXIF-oriented image, so size and
                // landscape are decided on the oriented dimensions too.
                if (IsQuarterTurn(codec.EncodedOrigin)) (width, height) = (height, width);
            }

            if (width < MinSide || height < MinSide || width > MaxSide || height > MaxSide) return CompositeImageCache.Passthrough;

            var landscape = width > height * 1.2;
            var context = new PosterTagItemContext(
                itemType,
                Played: topRightOffset,
                UnplayedItemCount: null,
                UserReviewAverage: data.Reviews.Average,
                UserReviewCount: data.Reviews.Count);
            var layout = PosterTagResolver.Resolve(data.Entry, settings, context, landscape);
            if (layout == null || layout.IsEmpty) return CompositeImageCache.Passthrough;

            // The token's bit decides the indicator offset, so the drawing is a
            // pure function of the URL (see PosterTagVariantFlags).
            layout = layout with { TopRightOffset = topRightOffset, Landscape = landscape };
            return _renderer.Value.RenderEncoded(source, image.ContentType, quality, layout) ?? CompositeImageCache.Passthrough;
        }
    }
}
