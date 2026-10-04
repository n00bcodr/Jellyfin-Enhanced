using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Proof that an analytics report came from a released build. The backend stores the
    /// SHA-256 of each shipped DLL and checks sha256(dllHash:installId:pluginVersion)
    /// against it. The DLL hash is never logged or included in the preview payload.
    /// </summary>
    internal static class BuildAttestation
    {
        private static readonly Lazy<string?> DllHash = new(ComputeDllHash);

        /// <summary>Returns the proof, or null when the assembly file cannot be read.</summary>
        public static string? Prove(string installId, string pluginVersion)
        {
            var dllHash = DllHash.Value;
            if (dllHash is null)
            {
                return null;
            }

            var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{dllHash}:{installId}:{pluginVersion}"));
            return Convert.ToHexString(bytes).ToLowerInvariant();
        }

        private static string? ComputeDllHash()
        {
            try
            {
                var path = typeof(BuildAttestation).Assembly.Location;
                if (string.IsNullOrEmpty(path) || !File.Exists(path))
                {
                    return null;
                }

                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            }
            catch
            {
                return null;
            }
        }
    }
}
