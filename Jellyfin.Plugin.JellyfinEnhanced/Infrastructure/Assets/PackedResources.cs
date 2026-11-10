using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Assets
{
    /// <summary>
    /// Reads the plugin's embedded client assets by the name they always had. The build embeds the bulky text ones
    /// (the readable scripts, their source maps, the minified twins and the locales: JePackedAsset in the project
    /// file) packed by scripts/pack-embedded.mjs, under their name plus <see cref="PackedSuffix"/>: four bytes with
    /// the original length (little-endian), then the content as one brotli stream. Unpacked they made the DLL
    /// 31.7 MB, twice the release it replaces. Everything else is embedded as it is, and both kinds are read here.
    /// </summary>
    internal static class PackedResources
    {
        internal const string PackedSuffix = ".jez";

        /// <summary>
        /// The resource's content as a read-only, seekable stream (so a file result still sends its length), or null
        /// when the assembly has no such resource.
        /// </summary>
        internal static Stream? Open(Assembly assembly, string name)
        {
            var plain = assembly.GetManifestResourceStream(name);
            if (plain != null) return plain;
            using var packed = assembly.GetManifestResourceStream(name + PackedSuffix);
            return packed == null ? null : new MemoryStream(Unpack(packed, name), writable: false);
        }

        /// <summary>Whether the assembly has the resource, packed or not.</summary>
        internal static bool Exists(Assembly assembly, string name)
            => assembly.GetManifestResourceInfo(name) != null || assembly.GetManifestResourceInfo(name + PackedSuffix) != null;

        /// <summary>Every embedded resource, a packed one under the name its content is read by.</summary>
        internal static IEnumerable<string> Names(Assembly assembly)
            => assembly.GetManifestResourceNames().Select(name => name.EndsWith(PackedSuffix, StringComparison.Ordinal) ? name[..^PackedSuffix.Length] : name);

        private static byte[] Unpack(Stream packed, string name)
        {
            Span<byte> header = stackalloc byte[4];
            packed.ReadExactly(header);
            var content = new byte[BinaryPrimitives.ReadUInt32LittleEndian(header)];
            using var brotli = new BrotliStream(packed, CompressionMode.Decompress);
            brotli.ReadExactly(content);
            if (brotli.ReadByte() != -1) throw new InvalidDataException($"Packed resource {name} is longer than its recorded length.");
            return content;
        }
    }
}
