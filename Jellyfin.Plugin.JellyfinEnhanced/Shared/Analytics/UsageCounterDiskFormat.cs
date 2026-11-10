using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Analytics
{
    /// <summary>On-disk format for usage-counters.json, mirroring the AwardsCacheDiskFormat pattern.</summary>
    public class UsageCounterDiskFormat
    {
        public int SchemaVersion { get; set; }
        public string PeriodStart { get; set; } = string.Empty;
        public Dictionary<string, int> Counters { get; set; } = new();
    }
}
