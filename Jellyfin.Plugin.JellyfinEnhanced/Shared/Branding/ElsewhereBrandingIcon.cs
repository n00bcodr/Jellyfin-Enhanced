using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Branding
{
    /// <summary>
    /// The uploaded Elsewhere custom branding icon: its fixed branding slot, the image types it may hold, how a stored
    /// icon is recognised, and the version public config hands viewers. Chrome stores and serves the slot; Platform puts
    /// the version into public config. Unlike the other branding slots it is not swapped into a jellyfin-web asset:
    /// viewers load it from <c>/JellyfinEnhanced/ElsewhereBrandingIcon</c>. The name is fixed, but the bytes may be
    /// PNG, JPEG, GIF, WebP or SVG, so it is served by its content.
    /// </summary>
    public static class ElsewhereBrandingIcon
    {
        /// <summary>The slot's file name in the branding directory.</summary>
        public const string FileName = "elsewhere-icon.png";

        /// <summary>The upload content types the slot takes: the image types every browser shows.</summary>
        public static readonly IReadOnlySet<string> ContentTypes = new HashSet<string>(new[]
        {
            "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"
        }, StringComparer.OrdinalIgnoreCase);

        /// <summary>
        /// How many leading bytes are read to recognise an image. An SVG can open with an XML prolog, comments,
        /// metadata or a DOCTYPE before <c>&lt;svg</c>; upload and serving use the same window, so every stored icon is
        /// recognised when served.
        /// </summary>
        public const int SniffWindow = 64 * 1024;

        /// <summary>Whether a (normalized) branding file name is this slot.</summary>
        public static bool IsSlot(string? fileName)
            => string.Equals(fileName, FileName, StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// Identifies an image by its first bytes (PNG, JPEG, GIF, WebP or UTF-8 SVG). Returns null when the content
        /// is not recognised.
        /// </summary>
        public static string? Sniff(Stream stream)
        {
            var head = new byte[SniffWindow];
            var read = 0;
            int n;
            while (read < head.Length && (n = stream.Read(head, read, head.Length - read)) > 0)
            {
                read += n;
            }

            if (read >= 8 && head[0] == 0x89 && head[1] == 0x50 && head[2] == 0x4E && head[3] == 0x47) return "image/png";
            if (read >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF) return "image/jpeg";
            if (read >= 6 && head[0] == 0x47 && head[1] == 0x49 && head[2] == 0x46 && head[3] == 0x38) return "image/gif";
            if (read >= 12 && head[0] == 0x52 && head[1] == 0x49 && head[2] == 0x46 && head[3] == 0x46
                && head[8] == 0x57 && head[9] == 0x45 && head[10] == 0x42 && head[11] == 0x50) return "image/webp";
            var text = Encoding.UTF8.GetString(head, 0, read);
            return text.Contains("<svg", StringComparison.OrdinalIgnoreCase) ? "image/svg+xml" : null;
        }

        /// <summary>
        /// Sniffs a stored image's type. Returns false when the file vanished or cannot be read (for example deleted
        /// mid-request); <paramref name="contentType"/> is null when the content is not recognised.
        /// </summary>
        public static bool TrySniffFile(string filePath, out string? contentType)
        {
            contentType = null;
            try
            {
                using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                contentType = Sniff(stream);
                return true;
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
        }

        /// <summary>
        /// Changes whenever the icon is uploaded, replaced or deleted: the file's last-write ticks and size, or an empty
        /// string when no icon is stored. Size as well as time, so a replacement on a coarse-mtime filesystem (or one
        /// restored with its old mtime) still gets a new URL.
        /// </summary>
        public static string Version(string? brandingDirectory)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(brandingDirectory))
                {
                    return string.Empty;
                }

                var info = new FileInfo(Path.Combine(brandingDirectory, FileName));
                return info.Exists && info.Length > 0
                    ? string.Create(CultureInfo.InvariantCulture, $"{info.LastWriteTimeUtc.Ticks}-{info.Length}")
                    : string.Empty;
            }
            catch (Exception)
            {
                return string.Empty;
            }
        }
    }
}
