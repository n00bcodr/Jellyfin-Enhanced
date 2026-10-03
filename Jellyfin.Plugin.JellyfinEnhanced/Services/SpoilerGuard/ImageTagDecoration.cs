using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// The decorated parts of an image tag. <see cref="Base"/> is Jellyfin's own tag;
    /// the rest is null when absent.
    /// </summary>
    /// <param name="CacheBust">The 8 hex of Spoiler Guard's "sb-{8hex}-" prefix.</param>
    /// <param name="Base">Jellyfin's image tag.</param>
    /// <param name="Variant">The native poster tags token after "-jet".</param>
    /// <param name="Marker">The 12 hex Spoiler Guard identity marker after "-jeu".</param>
    public readonly record struct ImageTagParts(string? CacheBust, string Base, string? Variant, string? Marker);

    // One place that knows the full shape of a decorated image tag, so the
    // filters that add pieces to it can never disagree about where each goes:
    //
    //   [sb-{8hex}-]{jellyfinTag}[-jet{23hex}][-jeu{12hex}]
    //
    //   sb-   SpoilerFieldStripFilter.MutateImageTagsForCacheBust: a PREFIX, so
    //         it keeps working with any suffix and is detected with StartsWith.
    //   -jet  native poster tags variant token (PosterTagVariantToken). Always
    //         sits directly in front of -jeu, so -jeu stays the trailing suffix
    //         SpoilerIdentityService.TryParseMarker expects.
    //   -jeu  Spoiler Guard's per-user identity marker (SpoilerIdentityService).
    //
    // Jellyfin's own tags are lowercase hex, so none of the sentinels can occur
    // inside one, and every decorated part is fixed width, which keeps parsing
    // unambiguous from either end.
    public static class ImageTagDecoration
    {
        /// <summary>Spoiler Guard's cache-bust prefix.</summary>
        public const string CacheBustPrefix = "sb-";

        /// <summary>Hex length of the cache-bust token inside the prefix.</summary>
        public const int CacheBustHexLength = 8;

        /// <summary>Sentinel of the native poster tags variant token.</summary>
        public const string VariantSentinel = "-jet";

        /// <summary>Hex length of the variant token (flags, data hash, MAC).</summary>
        public const int VariantHexLength = 23;

        private const int CacheBustPrefixLength = 3 + CacheBustHexLength + 1; // "sb-" + 8 hex + "-"

        /// <summary>
        /// Splits a tag into its parts. Never throws; a value without decoration
        /// comes back as its own <see cref="ImageTagParts.Base"/>.
        /// </summary>
        public static ImageTagParts Parse(string? tag)
        {
            if (string.IsNullOrEmpty(tag)) return new ImageTagParts(null, string.Empty, null, null);

            string? marker = null;
            var rest = tag;
            if (SpoilerIdentityService.TryParseMarker(rest, out var withoutMarker, out var markerHex))
            {
                marker = markerHex;
                rest = withoutMarker;
            }

            string? variant = null;
            var variantSuffix = VariantSentinel.Length + VariantHexLength;
            if (rest.Length > variantSuffix
                && string.CompareOrdinal(rest, rest.Length - variantSuffix, VariantSentinel, 0, VariantSentinel.Length) == 0
                && IsLowerHex(rest, rest.Length - VariantHexLength, VariantHexLength))
            {
                variant = rest.Substring(rest.Length - VariantHexLength);
                rest = rest.Substring(0, rest.Length - variantSuffix);
            }

            string? cacheBust = null;
            if (rest.Length > CacheBustPrefixLength
                && rest.StartsWith(CacheBustPrefix, StringComparison.Ordinal)
                && rest[CacheBustPrefixLength - 1] == '-'
                && IsLowerHex(rest, CacheBustPrefix.Length, CacheBustHexLength))
            {
                cacheBust = rest.Substring(CacheBustPrefix.Length, CacheBustHexLength);
                rest = rest.Substring(CacheBustPrefixLength);
            }

            return new ImageTagParts(cacheBust, rest, variant, marker);
        }

        /// <summary>Builds the tag string for <paramref name="parts"/> (inverse of <see cref="Parse"/>).</summary>
        public static string Compose(ImageTagParts parts)
        {
            var length = parts.Base.Length
                + (parts.CacheBust != null ? CacheBustPrefixLength : 0)
                + (parts.Variant != null ? VariantSentinel.Length + parts.Variant.Length : 0)
                + (parts.Marker != null ? SpoilerIdentityService.MarkerSentinel.Length + parts.Marker.Length : 0);
            var builder = new System.Text.StringBuilder(length);
            if (parts.CacheBust != null) builder.Append(CacheBustPrefix).Append(parts.CacheBust).Append('-');
            builder.Append(parts.Base);
            if (parts.Variant != null) builder.Append(VariantSentinel).Append(parts.Variant);
            if (parts.Marker != null) builder.Append(SpoilerIdentityService.MarkerSentinel).Append(parts.Marker);
            return builder.ToString();
        }

        /// <summary>
        /// Returns <paramref name="tag"/> carrying exactly this variant token and
        /// identity marker, keeping any cache-bust prefix. Idempotent: a tag that
        /// already carries both returns the same instance; an existing variant or
        /// marker is replaced, never duplicated.
        /// </summary>
        public static string WithVariant(string tag, string variant, string marker)
        {
            if (string.IsNullOrEmpty(tag)) return tag;
            var parts = Parse(tag);
            if (string.Equals(parts.Variant, variant, StringComparison.Ordinal)
                && string.Equals(parts.Marker, marker, StringComparison.Ordinal))
            {
                return tag;
            }

            return Compose(parts with { Variant = variant, Marker = marker });
        }

        /// <summary>The variant token of a tag, or null when it carries none.</summary>
        public static string? GetVariant(string? tag)
        {
            if (string.IsNullOrEmpty(tag) || tag.IndexOf(VariantSentinel, StringComparison.Ordinal) < 0) return null;
            return Parse(tag).Variant;
        }

        /// <summary>Jellyfin's own tag with every decoration removed.</summary>
        public static string StripAll(string? tag) => Parse(tag).Base;

        private static bool IsLowerHex(string value, int start, int count)
        {
            for (var i = start; i < start + count; i++)
            {
                var c = value[i];
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            }

            return true;
        }
    }
}
