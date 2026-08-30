using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model
{
    /// <summary>
    /// Marks a non-bool PluginConfiguration property as safe to include in the
    /// analytics config-flag snapshot. Bools are reflected automatically since
    /// there's no way for one to leak a secret. Strings aren't safe to include
    /// the same way, since an API key, URL, or free-text branding field is
    /// also a string, so each string sent needs a deliberate, per-property
    /// decision instead of a blanket type scan.
    /// Tag the property here, at its declaration, so adding a new enum-style
    /// setting (e.g. a *Position or *Style field) automatically starts being
    /// tracked without a second file to remember to edit.
    /// Tagged values are sent VERBATIM, so the attribute may only go on
    /// fixed-choice values. A string whose raw value isn't safe to share
    /// as-is (free text, or anything that can hold an identifier) must NOT
    /// be tagged — derive a safe value in
    /// AnalyticsReportingService.GetStringSettings instead, the way
    /// MaintenanceModeAffectedUsers and LanguageTagsPriority are.
    /// </summary>
    [AttributeUsage(AttributeTargets.Property)]
    public sealed class AnalyticsIncludeAttribute : Attribute
    {
    }

    /// <summary>
    /// Marks a bool PluginConfiguration property as EXCLUDED from the
    /// automatic feature-flag reflection. Bools default to included since one
    /// can't leak a secret, but not every bool is a real, admin-facing
    /// feature toggle: some are internal bookkeeping the plugin sets on
    /// itself (e.g. *CustomTabJeOwned, tracking whether JE currently owns a
    /// Custom Tabs entry, not something an admin ever checks) or dev/ops
    /// flags with no config-page control at all (DisableScriptInjectionMiddleware,
    /// DisableBrandingMiddleware). Reflected in with everything else, these
    /// have no fieldset to be grouped under on the dashboard, so they land in
    /// "Other" and tell nobody anything about real feature adoption. Tag them
    /// here instead of letting them accumulate as dashboard noise.
    /// </summary>
    [AttributeUsage(AttributeTargets.Property)]
    public sealed class AnalyticsExcludeAttribute : Attribute
    {
    }

    /// <summary>
    /// One feature_key's count for the current reporting period. Explicit
    /// lowercase [JsonPropertyName] on both fields: SendAsync serializes the
    /// whole rpc body with plain JsonSerializer.Serialize (no camelCase
    /// naming policy), so without this it would emit "Key"/"Count", but
    /// report_stats reads p_events with lowercase event->>'key'/'count'.
    /// That mismatch made every event a NULL key/count, tripping a NOT NULL
    /// violation (Postgres 23502) on literally every report that included
    /// any event, i.e. every report -- caught only by checking Supabase's
    /// edge logs for the actual error, since every manual curl smoke test
    /// during development hand-typed lowercase keys and never exercised the
    /// real C# serialization path.
    /// </summary>
    public class UsageEventEntry
    {
        [JsonPropertyName("key")]
        public string Key { get; set; } = string.Empty;
        [JsonPropertyName("count")]
        public int Count { get; set; }
    }

    /// <summary>
    /// The exact shape sent to (and previewable from) the analytics backend.
    /// Every field here is either non-identifying by construction (install id
    /// is a random GUID, never derived from anything personal) or gated by its
    /// own opt-in category toggle; see AnalyticsReportingService.BuildPayload.
    /// </summary>
    public class AnalyticsPayload
    {
        public string InstallId { get; set; } = string.Empty;
        public string PluginVersion { get; set; } = string.Empty;
        public string JellyfinVersion { get; set; } = string.Empty;
        public string JellyfinTarget { get; set; } = string.Empty;

        /// <summary>Boolean feature-flag snapshot (config.AnalyticsShareFeatureFlags). Null when that category is off.</summary>
        public Dictionary<string, bool>? Config { get; set; }

        /// <summary>
        /// Byte sizes of the plugin's own data files on disk (config.AnalyticsShareDataSizes).
        /// Deliberately narrow; see AnalyticsReportingService.GetDataFileSizes for what's
        /// included and why. Sizes only, never contents. Null when the category is off.
        /// </summary>
        public Dictionary<string, long>? DataFileSizes { get; set; }

        /// <summary>
        /// Non-bool config values explicitly opted in via [AnalyticsInclude]
        /// (icon style, tag overlay positions, maintenance-mode mode, etc.).
        /// Shares config.AnalyticsShareFeatureFlags with Config: same privacy
        /// category, "what does your config look like". Null when that category is off.
        /// </summary>
        public Dictionary<string, string>? Settings { get; set; }

        /// <summary>Start-of-period date (yyyy-MM-dd) this snapshot covers.</summary>
        public string Period { get; set; } = string.Empty;

        /// <summary>Cumulative usage counters since Period started (config.AnalyticsShareUsageCounts). Null when that category is off.</summary>
        public List<UsageEventEntry>? Events { get; set; }
    }

    /// <summary>On-disk format for usage-counters.json, mirroring the AwardsCacheDiskFormat pattern.</summary>
    public class UsageCounterDiskFormat
    {
        public int SchemaVersion { get; set; }
        public string PeriodStart { get; set; } = string.Empty;
        public Dictionary<string, int> Counters { get; set; } = new();
    }
}
