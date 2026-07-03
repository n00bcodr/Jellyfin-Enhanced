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
        public string? TmdbId { get; set; }
        /// <summary>For Season/Episode: the parent Series TMDB ID.</summary>
        public string? SeriesTmdbId { get; set; }
        /// <summary>For Season/Episode: season number for building the review key.</summary>
        public int? SeasonNumber { get; set; }
        /// <summary>For Episode: episode number for building the review key.</summary>
        public int? EpisodeNumber { get; set; }
        public string[]? Genres { get; set; }
        public float? CommunityRating { get; set; }
        public float? CriticRating { get; set; }
        public string[]? AudioLanguages { get; set; }
        public TagStreamData? StreamData { get; set; }
        public long LastUpdated { get; set; }
        // Series ID in N format (no dashes, lowercase). Set for Episodes
        // and Seasons; null for everything else. Used by the Spoiler Guard
        // filter to strip cache entries for unwatched episodes whose parent
        // series is in the requesting user's spoiler list — avoids a
        // per-request library lookup for every episode in a 1000-item
        // cache.
        public string? SeriesId { get; set; }

        // Shallow copy. Required by per-user mutators (spoiler tag-strip)
        // because the underlying TagCacheService stores ONE shared instance
        // per item across ALL users. Mutating in place would leak one user's
        // strip into every other user's cache response. Arrays are kept by
        // reference; spoiler strip only ever REPLACES them (with empty/null),
        // never mutates an existing array, so the shallow copy is safe.
        //
        // R6-L2 caveat: StreamData (TagStreamData object) is also reference-
        // shared. Today's strip code replaces the reference (Stream Data =
        // null) — safe. If a future feature mutates `clone.StreamData.Streams.Add(...)`
        // or similar, every user's cache silently corrupts. Treat StreamData
        // as immutable across users; replace the whole object, never mutate
        // its fields.
        public TagCacheEntry Clone() => new()
        {
            Type = Type,
            // Copy EVERY property: the spoiler tag-strip replaces the shared
            // instance with this clone in the response, so any field omitted
            // here is silently blanked for the client. TmdbId / SeriesTmdbId /
            // SeasonNumber / EpisodeNumber build the review key — dropping them
            // broke reviews on cloned entries even when reviews weren't the
            // field being stripped.
            TmdbId = TmdbId,
            SeriesTmdbId = SeriesTmdbId,
            SeasonNumber = SeasonNumber,
            EpisodeNumber = EpisodeNumber,
            Genres = Genres,
            CommunityRating = CommunityRating,
            CriticRating = CriticRating,
            AudioLanguages = AudioLanguages,
            StreamData = StreamData,
            LastUpdated = LastUpdated,
            SeriesId = SeriesId,
        };
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
