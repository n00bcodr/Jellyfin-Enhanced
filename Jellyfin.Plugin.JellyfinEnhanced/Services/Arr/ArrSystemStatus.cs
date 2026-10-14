using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>The parts of <c>GET /api/v3/system/status</c> JE uses.</summary>
    public sealed class ArrSystemStatus
    {
        /// <summary>"Sonarr", "Radarr", ... as reported.</summary>
        public string AppName { get; init; } = string.Empty;

        /// <summary>The instance's own name (shown in its UI and webhooks).</summary>
        public string InstanceName { get; init; } = string.Empty;

        /// <summary>Full version string, e.g. "6.0.4.10291".</summary>
        public string Version { get; init; } = string.Empty;

        /// <summary>Release branch ("master", "develop", ...).</summary>
        public string Branch { get; init; } = string.Empty;

        /// <summary>URL base the arr is configured with ("" for none).</summary>
        public string UrlBase { get; init; } = string.Empty;

        /// <summary>Parses a status document; null when it is not one.</summary>
        public static ArrSystemStatus? Parse(JsonElement root)
        {
            if (root.ValueKind != JsonValueKind.Object) return null;
            string Str(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? string.Empty : string.Empty;
            var appName = Str("appName");
            var version = Str("version");
            if (string.IsNullOrEmpty(appName) && string.IsNullOrEmpty(version)) return null;
            return new ArrSystemStatus
            {
                AppName = appName,
                InstanceName = Str("instanceName"),
                Version = version,
                Branch = Str("branch"),
                UrlBase = Str("urlBase"),
            };
        }
    }

    /// <summary>
    /// What JE may use on a given arr build. Everything shipping today serves <c>/api/v3</c>; the
    /// gates below cover endpoint differences between majors (see the arr API notes in the docs).
    /// </summary>
    public sealed class ArrCapabilities
    {
        /// <summary>Sonarr or Radarr.</summary>
        public ArrKind Kind { get; init; }

        /// <summary>Parsed version (null when unparseable).</summary>
        public string? Version { get; init; }

        /// <summary>Major version (0 when unknown).</summary>
        public int Major { get; init; }

        /// <summary>The API dialect JE talks: "v3" today.</summary>
        public string Dialect { get; init; } = "v3";

        /// <summary>False for builds JE does not support (Sonarr v3, Radarr before v4).</summary>
        public bool Supported { get; init; }

        /// <summary>Feature gates by name (stable keys, serialized for admins).</summary>
        public IReadOnlyDictionary<string, bool> Features { get; init; } = new Dictionary<string, bool>();

        /// <summary>Admin-facing notes about this build.</summary>
        public IReadOnlyList<string> Warnings { get; init; } = Array.Empty<string>();

        /// <summary>True when the named feature is available.</summary>
        public bool Has(string feature) => Features.TryGetValue(feature, out var on) && on;

        /// <summary>Feature name: <c>/wanted/missing</c> and <c>/wanted/cutoff</c> (Radarr 5.6+, all Sonarr v4).</summary>
        public const string WantedLists = "wantedLists";

        /// <summary>Feature name: <c>/releaseprofile</c> (Radarr 5+, Sonarr v4).</summary>
        public const string ReleaseProfiles = "releaseProfiles";

        /// <summary>Feature name: Radarr 4's <c>/restriction</c>.</summary>
        public const string Restrictions = "restrictions";

        /// <summary>Feature name: working language profiles (Sonarr v3 only).</summary>
        public const string LanguageProfiles = "languageProfiles";

        /// <summary>Feature name: custom formats (Radarr, Sonarr v4+).</summary>
        public const string CustomFormats = "customFormats";

        /// <summary>Feature name: tag labels limited to <c>[a-z0-9-]</c> (Radarr 6+).</summary>
        public const string StrictTagLabels = "strictTagLabels";

        /// <summary>Feature name: Sonarr's <c>/api/v5</c> exists (JE still uses v3).</summary>
        public const string ApiV5 = "apiV5";

        /// <summary>Derives capabilities for an app version.</summary>
        public static ArrCapabilities For(ArrKind kind, string? version)
        {
            System.Version? parsed = null;
            if (!string.IsNullOrWhiteSpace(version))
            {
                System.Version.TryParse(version.Trim(), out parsed);
            }
            var major = parsed?.Major ?? 0;
            var minor = parsed?.Minor ?? 0;
            var warnings = new List<string>();
            var features = new Dictionary<string, bool>(StringComparer.Ordinal);
            bool supported;

            if (kind == ArrKind.Sonarr)
            {
                supported = major == 0 || major >= 4;
                features[WantedLists] = true;
                features[ReleaseProfiles] = true;
                features[Restrictions] = false;
                features[LanguageProfiles] = major > 0 && major < 4;
                features[CustomFormats] = major == 0 || major >= 4;
                features[StrictTagLabels] = false;
                features[ApiV5] = major >= 5;
                if (major > 0 && major < 4) warnings.Add("Sonarr v3 is end-of-life. Jellyfin Enhanced needs Sonarr v4 or newer.");
                if (major >= 5) warnings.Add("Sonarr v5 detected. Jellyfin Enhanced uses its v3 API, which v5 still serves.");
            }
            else
            {
                supported = major == 0 || major >= 4;
                features[WantedLists] = major == 0 || major > 5 || (major == 5 && minor >= 6);
                features[ReleaseProfiles] = major == 0 || major >= 5;
                features[Restrictions] = major == 4;
                features[LanguageProfiles] = false;
                features[CustomFormats] = true;
                features[StrictTagLabels] = major >= 6;
                features[ApiV5] = false;
                if (major > 0 && major < 4) warnings.Add("This Radarr version is too old. Jellyfin Enhanced needs Radarr v4 or newer.");
                else if (major == 4) warnings.Add("Radarr v4 is old: wanted lists need Radarr 5.6 or newer.");
            }

            if (major == 0) warnings.Add("Could not read the version; assuming a current release.");

            return new ArrCapabilities
            {
                Kind = kind,
                Version = parsed?.ToString(),
                Major = major,
                Supported = supported,
                Features = features,
                Warnings = warnings,
            };
        }

        /// <summary>The expected appName for a kind.</summary>
        public static string AppNameFor(ArrKind kind) => kind == ArrKind.Sonarr ? "Sonarr" : "Radarr";

        /// <summary>True when <paramref name="appName"/> is the app for <paramref name="kind"/>.</summary>
        public static bool IsExpectedApp(ArrKind kind, string? appName)
            => string.Equals((appName ?? string.Empty).Trim(), AppNameFor(kind), StringComparison.OrdinalIgnoreCase);

        /// <summary>Formats the major.minor for messages.</summary>
        public override string ToString() => string.Format(CultureInfo.InvariantCulture, "{0} {1}", Kind, Version ?? "unknown");
    }
}
