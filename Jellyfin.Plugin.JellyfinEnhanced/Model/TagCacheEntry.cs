using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model
{
    /// <summary>
    /// Pre-computed tag data for a single library item.
    /// Stored server-side and served to clients in bulk.
    /// </summary>
    public class TagCacheEntry
    {
        public string? Type { get; set; }
        public string[]? Genres { get; set; }
        public float? CommunityRating { get; set; }
        public float? CriticRating { get; set; }
        public string[]? AudioLanguages { get; set; }
        public TagStreamData? StreamData { get; set; }
        public long LastUpdated { get; set; }
    }

    /// <summary>
    /// Raw media stream data for client-side quality tag computation.
    /// Quality detection logic (700+ lines) stays in JS to avoid C# duplication.
    /// </summary>
    public class TagStreamData
    {
        public List<TagMediaStream>? Streams { get; set; }
        public List<TagMediaSource>? Sources { get; set; }
        public string? ItemName { get; set; }
        public string? ItemPath { get; set; }
    }

    public class TagMediaStream
    {
        public string? Type { get; set; }
        public string? Language { get; set; }
        public string? Codec { get; set; }
        public string? CodecTag { get; set; }
        public string? Profile { get; set; }
        public int? Height { get; set; }
        public int? Channels { get; set; }
        public string? ChannelLayout { get; set; }
        public string? VideoRangeType { get; set; }
        public string? DisplayTitle { get; set; }
    }

    public class TagMediaSource
    {
        public string? Path { get; set; }
        public string? Name { get; set; }
    }
}
