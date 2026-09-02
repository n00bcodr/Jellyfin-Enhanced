using System;
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

        /// <summary>Release asset the admin should have installed instead.</summary>
        public string ExpectedAssetName =>
            HostTarget == "jf12"
                ? "Jellyfin.Plugin.JellyfinEnhanced_12.0.0.zip"
                : "Jellyfin.Plugin.JellyfinEnhanced_10.11.0.zip";

        /// <summary>One-line diagnosis for the log and the config page. Remediation text lives in the config page.</summary>
        public string? MismatchMessage => !IsMismatch
            ? null
            : $"This copy of Jellyfin Enhanced was built for Jellyfin {(BuiltFor == "jf12" ? "12.x" : "10.11.x")} " +
              $"but the server is Jellyfin {HostVersionString}. Features may fail unpredictably.";
    }
}
