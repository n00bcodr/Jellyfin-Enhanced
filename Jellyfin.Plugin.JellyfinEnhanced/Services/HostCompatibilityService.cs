using System;
using System.IO;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using MediaBrowser.Controller;

#if JF10 && JF12
#error Both JF10 and JF12 are defined; JellyfinTarget must select exactly one (see JellyfinEnhanced.csproj)
#endif

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Single source of truth for "which Jellyfin was this DLL built for" vs
    /// "which Jellyfin is actually running it".
    ///
    /// The same source ships as two artifacts (see JellyfinEnhanced.csproj):
    /// the jf10 build (net9.0, Jellyfin.Controller 10.11.0) and the jf12 build
    /// (net10.0, Jellyfin.Controller 12.0.0). Jellyfin's plugin loader only
    /// enforces a LOWER ABI bound (targetAbi &lt;= server version), so a
    /// Jellyfin 12 host happily installs and loads the jf10 zip when the admin
    /// added the 10.11 manifest. The DLL loads (.NET 10 runs net9 assemblies)
    /// and mostly works, then throws MissingMethod/TypeLoad on whichever code
    /// path first hits a changed server API. Nothing in Jellyfin tells the
    /// admin why. This service does.
    ///
    /// That is the only mismatch that can physically occur: a jf12 (net10)
    /// DLL does not load on the .NET 9 runtime of 10.11 at all, and a jf10
    /// (net9) DLL does not load on the .NET 8 runtime of 10.10 and older
    /// (that historical line is frozen at plugin 10.11.1.0 and is not built
    /// from this source). So the host is classified into just two lines.
    ///
    /// Depends only on IServerApplicationHost, which Jellyfin registers before
    /// any plugin service, and uses only members that exist unchanged on both
    /// lines, so this check itself can never be the first thing to throw on a
    /// mismatched host.
    /// </summary>
    public class HostCompatibilityService
    {
        /// <summary>Compile-time build target of this DLL: "jf10" or "jf12" (JF10/JF12 symbols from the csproj).</summary>
        public static string BuiltFor =>
#if JF12
            "jf12";
#elif JF10
            "jf10";
#else
#error JellyfinTarget must define JF10 or JF12 (see JellyfinEnhanced.csproj); the csproj default is jf12, so this only trips on a stray DefineConstants override
#endif

        /// <summary>The one manifest that serves every Jellyfin line; Jellyfin's own ABI filter picks the right build.</summary>
        public const string ManifestUrl = "https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/manifest.json";

        private readonly IServerApplicationHost _appHost;

        public HostCompatibilityService(IServerApplicationHost appHost)
        {
            _appHost = appHost;
        }

        /// <summary>Assembly version of the running server (12.0.0-rc1 reports 12.0.0.0).</summary>
        public Version HostVersion => _appHost.ApplicationVersion;

        /// <summary>Human-readable server version, e.g. "12.0.0" or "10.11.11".</summary>
        public string HostVersionString => _appHost.ApplicationVersionString;

        /// <summary>
        /// "jf12" for 12 and anything newer (deliberately: it is the best build
        /// we have until a dedicated target exists; revisit when Jellyfin 13
        /// ships), "jf10" for everything older that can load this DLL at all.
        /// </summary>
        public string HostTarget => HostVersion.Major >= 12 ? "jf12" : "jf10";

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

        /// <summary>Release asset the admin should have installed instead.</summary>
        public string ExpectedAssetName =>
            HostTarget == "jf12"
                ? "Jellyfin.Plugin.JellyfinEnhanced_12.0.0.zip"
                : "Jellyfin.Plugin.JellyfinEnhanced_10.11.0.zip";

        /// <summary>
        /// One-line diagnosis for the log and administrator diagnostics endpoint, using an
        /// already computed stale state so the condition and the message agree.
        /// </summary>
        /// <param name="isStale">Whether the plugin file on disk differs from the running module.</param>
        /// <param name="includeInstallAdvice">Name the asset and manifest to install (the log); the config page shows its own link.</param>
        /// <returns>The diagnosis, or null when the build matches the host and is not stale.</returns>
        public string? GetCompatibilityMessage(bool isStale, bool includeInstallAdvice = false)
        {
            if (!IsMismatch && !isStale) return null;

            var diagnosis = IsMismatch
                ? $"This copy of Jellyfin Enhanced was built for Jellyfin {(BuiltFor == "jf12" ? "12.x" : "10.11.x")} " +
                  $"but the server is Jellyfin {HostVersionString}. Features may fail unpredictably. "
                : "";

            // Both builds of a release share one version number, so Jellyfin swaps them in place
            // (same folder, same file name), and its in-process dashboard restart then keeps
            // running the image it already has mapped for that path (issue #948).
            return isStale
                ? diagnosis + "The plugin file on disk was replaced after Jellyfin loaded it, but Jellyfin is still " +
                  "running the old copy from memory and a dashboard restart keeps it loaded. Stop and start the " +
                  "Jellyfin service or container (e.g. systemctl restart jellyfin, docker restart <container>) to load it."
                : diagnosis + (includeInstallAdvice ? $"Install {ExpectedAssetName} from {ManifestUrl}. " : "") +
                  "Both builds share one version number, so after installing the right one, stop and start " +
                  "the Jellyfin service or container (e.g. systemctl restart jellyfin, docker restart <container>); " +
                  "a dashboard restart keeps this build loaded.";
        }
    }
}
