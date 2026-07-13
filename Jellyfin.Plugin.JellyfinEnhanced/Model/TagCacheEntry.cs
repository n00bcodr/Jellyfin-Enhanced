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
        // Series ID in N format (lowercase). Set for Episodes and Seasons, null
        // otherwise. Lets the Spoiler Guard filter strip cache entries for
        // unwatched episodes whose parent series is in the user's spoiler list
        // without a per-episode library lookup on every request.
        public string? SeriesId { get; set; }

        // Shallow copy required by per-user mutators (spoiler tag-strip): the
        // TagCacheService stores ONE shared instance per item across ALL users,
        // so mutating in place would leak one user's strip into every other user's
        // cache response. Arrays are kept by reference, but the strip only REPLACES
        // them (with empty/null), never mutates in place, so this is safe.
        //
        // Same caveat for StreamData (also reference-shared): treat it as immutable
        // across users — replace the whole object (StreamData = null), never mutate
        // its fields, or every user's cache silently corrupts.
        /// <summary>
        /// Value-compare two entries on every client-visible field, ignoring
        /// <see cref="LastUpdated"/> (a build timestamp, not content). Used by the
        /// incremental rebuild path to detect no-op ItemUpdated events: nightly
        /// library scans and chapter/trickplay tasks re-save thousands of items
        /// without changing any tag-relevant data, and treating each re-save as a
        /// change caused the whole cache to be re-serialized to disk every ~30s
        /// for the duration of the scan.
        /// Compare EVERY content property (same rule as <see cref="Clone"/>): a
        /// field omitted here makes real changes to that field invisible, so stale
        /// data would be served until the next full rebuild.
        /// </summary>
        public static bool ContentEquals(TagCacheEntry? a, TagCacheEntry? b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null) return false;

            return a.Type == b.Type
                && a.TmdbId == b.TmdbId
                && a.SeriesTmdbId == b.SeriesTmdbId
                && a.SeasonNumber == b.SeasonNumber
                && a.EpisodeNumber == b.EpisodeNumber
                && SequencesEqual(a.Genres, b.Genres)
                && NullableFloatEquals(a.CommunityRating, b.CommunityRating)
                && NullableFloatEquals(a.CriticRating, b.CriticRating)
                && SequencesEqual(a.AudioLanguages, b.AudioLanguages)
                && TagStreamData.ContentEquals(a.StreamData, b.StreamData)
                && a.SeriesId == b.SeriesId;
        }

        /// <summary>
        /// Ordinal, order-sensitive array compare. Order sensitivity is intentional:
        /// both sides are built by the same code from the same source, so a stable
        /// item produces the same order — and a false "different" only costs one
        /// redundant save, while an order-insensitive compare would cost allocations
        /// on every rebuilt item.
        /// </summary>
        private static bool SequencesEqual(string[]? a, string[]? b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null) return a == null && b == null;
            if (a.Length != b.Length) return false;
            for (var i = 0; i < a.Length; i++)
            {
                if (!string.Equals(a[i], b[i], System.StringComparison.Ordinal)) return false;
            }

            return true;
        }

        /// <summary>
        /// Exact nullable-float compare. Exactness is safe here: both values are read
        /// from the same database column, so an unchanged rating is bit-identical.
        /// Nullable.Equals also treats NaN as equal to NaN, so a NaN rating can't
        /// keep an entry perpetually "changed".
        /// </summary>
        private static bool NullableFloatEquals(float? a, float? b) => System.Nullable.Equals(a, b);

        public TagCacheEntry Clone() => new()
        {
            Type = Type,
            // Copy EVERY property: this clone replaces the shared instance in the
            // response, so any field omitted here is silently blanked for the
            // client. TmdbId/SeriesTmdbId/SeasonNumber/EpisodeNumber build the
            // review key — dropping them broke reviews on cloned entries.
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

        /// <summary>
        /// Value-compare for the no-op-rebuild check (see TagCacheEntry.ContentEquals).
        /// Compares EVERY property — an omitted field hides real changes from clients.
        /// </summary>
        public static bool ContentEquals(TagStreamData? a, TagStreamData? b)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null) return false;

            return a.ItemName == b.ItemName
                && a.ItemPath == b.ItemPath
                && ListsEqual(a.Streams, b.Streams, TagMediaStream.ContentEquals)
                && ListsEqual(a.Sources, b.Sources, TagMediaSource.ContentEquals);
        }

        private static bool ListsEqual<T>(List<T>? a, List<T>? b, System.Func<T, T, bool> equals)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null) return false;
            if (a.Count != b.Count) return false;
            for (var i = 0; i < a.Count; i++)
            {
                if (!equals(a[i], b[i])) return false;
            }

            return true;
        }
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

        /// <summary>
        /// Value-compare for the no-op-rebuild check (see TagCacheEntry.ContentEquals).
        /// Compares EVERY property — an omitted field hides real changes from clients.
        /// </summary>
        public static bool ContentEquals(TagMediaStream a, TagMediaStream b) =>
            a.Type == b.Type
            && a.Language == b.Language
            && a.Codec == b.Codec
            && a.CodecTag == b.CodecTag
            && a.Profile == b.Profile
            && a.Height == b.Height
            && a.Channels == b.Channels
            && a.ChannelLayout == b.ChannelLayout
            && a.VideoRangeType == b.VideoRangeType
            && a.DisplayTitle == b.DisplayTitle;
    }

    public class TagMediaSource
    {
        public string? Path { get; set; }
        public string? Name { get; set; }

        /// <summary>
        /// Value-compare for the no-op-rebuild check (see TagCacheEntry.ContentEquals).
        /// Compares EVERY property — an omitted field hides real changes from clients.
        /// </summary>
        public static bool ContentEquals(TagMediaSource a, TagMediaSource b) =>
            a.Path == b.Path && a.Name == b.Name;
    }
}
