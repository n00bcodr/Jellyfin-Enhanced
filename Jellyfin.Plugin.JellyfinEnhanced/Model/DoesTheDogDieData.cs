using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model
{
    /// <summary>One topic's community votes for a title (DoesTheDogDie topicItemStat).</summary>
    public class DddTopicStat
    {
        public int Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public int Yes { get; set; }
        public int No { get; set; }
    }

    /// <summary>Cached DoesTheDogDie answer for one title, keyed by media type + TMDB id.</summary>
    public class DddCacheEntry
    {
        public bool Found { get; set; }
        /// <summary>DoesTheDogDie's own item id, used to link to the title's page.</summary>
        public int ItemId { get; set; }
        public string Name { get; set; } = string.Empty;
        public List<DddTopicStat> Topics { get; set; } = new();
        /// <summary>False for failed or skipped lookups, which are retried after an hour.</summary>
        public bool Confirmed { get; set; }
        public long FetchedAtUnixMs { get; set; }
    }

    public class DddCatalogTopic
    {
        public int Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public string Category { get; set; } = string.Empty;
        public string Group { get; set; } = string.Empty;
    }

    /// <summary>All DoesTheDogDie topics with their category and super category, for the picker.</summary>
    public class DddCatalog
    {
        public List<DddCatalogTopic> Topics { get; set; } = new();
        public long FetchedAtUnixMs { get; set; }
    }

    /// <summary>On-disk shape of ddd-cache.json.</summary>
    public class DddCacheDiskFormat
    {
        public int SchemaVersion { get; set; }
        public DddCatalog? Catalog { get; set; }
        public Dictionary<string, DddCacheEntry> Items { get; set; } = new();
    }
}
