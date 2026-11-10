using System;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using MediaBrowser.Controller;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Host
{
    /// <summary>
    /// Diagnoses whether the running host is in the supported Jellyfin 12.x line.
    /// A plugin's minimum ABI does not impose an upper major-version bound, so
    /// future hosts must be rejected explicitly. Older hosts are unsupported too;
    /// their runtimes may reject this .NET 10 assembly before diagnostics can run.
    /// </summary>
    public class HostCompatibilityService
    {
        /// <summary>The sole build target of this rewrite.</summary>
        public static string BuiltFor => "jf12";

        /// <summary>Upstream plugin manifest; retained for administrator diagnostics.</summary>
        public const string ManifestUrl = "https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/manifest.json";

        /// <summary>Public releases page, where a release that supports a newer Jellyfin line will be listed.</summary>
        public const string ReleasesUrl = "https://github.com/n00bcodr/Jellyfin-Enhanced/releases";

        private readonly IServerApplicationHost _appHost;

        public HostCompatibilityService(IServerApplicationHost appHost)
        {
            _appHost = appHost;
        }

        /// <summary>Host target for a Jellyfin line that no build of this release supports (any major other than 12).</summary>
        public const string UnsupportedTarget = "unsupported";

        /// <summary>Assembly version of the running server (12.0.0-rc1 reports 12.0.0.0).</summary>
        public Version HostVersion => _appHost.ApplicationVersion;

        /// <summary>Human-readable server version, e.g. "12.0.0" or "10.11.11".</summary>
        public string HostVersionString => _appHost.ApplicationVersionString;

        /// <summary>
        /// "jf12" for major 12; every older or newer major is unsupported.
        /// </summary>
        public string HostTarget => HostVersion.Major == 12 ? BuiltFor : UnsupportedTarget;

        /// <summary>True when the host is a Jellyfin line no build of this release supports.</summary>
        public bool IsHostUnsupported => HostTarget == UnsupportedTarget;

        /// <summary>True when this DLL was built for a different Jellyfin line than the host.</summary>
        public bool IsMismatch => !string.Equals(BuiltFor, HostTarget, StringComparison.Ordinal);

        /// <summary>
        /// True when the plugin file on disk differs from the module running in memory.
        /// Rechecked on every access; unreadable or unavailable metadata is treated as not stale.
        /// </summary>
        public bool IsStale
        {
            get
            {
                try
                {
                    var assembly = typeof(HostCompatibilityService).Assembly;
                    return IsAssemblyStale(assembly.Location, assembly.ManifestModule.ModuleVersionId);
                }
                catch
                {
                    return false;
                }
            }
        }

        internal static bool IsAssemblyStale(string? location, Guid loadedMvid)
        {
            try
            {
                if (string.IsNullOrEmpty(location)) return false;

                // Jellyfin can replace the same path while the old image stays mapped.
                // Read only metadata, without blocking replacement or loading another assembly.
                using var stream = File.Open(location, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var peReader = new PEReader(stream, PEStreamOptions.PrefetchMetadata);
                if (!peReader.HasMetadata) return false;
                var metadata = peReader.GetMetadataReader();
                var mvid = metadata.GetModuleDefinition().Mvid;
                return !mvid.IsNil && metadata.GetGuid(mvid) != loadedMvid;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Release asset the admin should have installed instead, or null when no asset of this release fits the host.</summary>
        public string? ExpectedAssetName => HostTarget switch
        {
            "jf12" => "Jellyfin.Plugin.JellyfinEnhanced_12.0.0.zip",
            _ => null,
        };

        private const string BuiltForLine = "12.x";

        /// <summary>
        /// One-line diagnosis for the log and administrator diagnostics endpoint, using an
        /// already computed stale state so the condition and the message agree.
        /// </summary>
        /// <param name="isStale">Whether the plugin file on disk differs from the running module.</param>
        /// <param name="includeInstallAdvice">Include the supported-releases URL (the log); the config page shows its own link.</param>
        /// <returns>The diagnosis, or null when the build matches the host and is not stale.</returns>
        public string? GetCompatibilityMessage(bool isStale, bool includeInstallAdvice = false)
        {
            if (!IsMismatch && !isStale) return null;

            var diagnosis = "";
            if (IsHostUnsupported)
            {
                diagnosis = $"This release of Jellyfin Enhanced supports Jellyfin 12.x only " +
                    $"(the server is Jellyfin {HostVersionString}; this copy was built for Jellyfin {BuiltForLine}). " +
                    "Features may fail unpredictably. " +
                    (HostVersion.Major < 12
                        ? "Upgrade the server to Jellyfin 12.x before using this rewrite."
                        : "Use a Jellyfin Enhanced release that explicitly supports this server's major version.");
                if (includeInstallAdvice)
                    diagnosis += $" See {ReleasesUrl} for supported releases.";
            }

            // Replacing the DLL does not replace the image already mapped by the
            // running process. This remains relevant for updates within the 12.x line.
            if (isStale)
            {
                if (diagnosis.Length > 0) diagnosis += " ";
                diagnosis += "The plugin file on disk was replaced after Jellyfin loaded it, but Jellyfin is still " +
                    "running the old copy from memory and a dashboard restart keeps it loaded. Stop and start the " +
                    "Jellyfin service or container (e.g. systemctl restart jellyfin, docker restart <container>) to load it.";
            }
            return diagnosis;
        }
    }
}
