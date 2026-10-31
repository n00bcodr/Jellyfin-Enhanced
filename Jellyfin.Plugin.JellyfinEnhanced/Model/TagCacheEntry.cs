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

        // Multi-source ratings (schema v15). Immutable, shared across users.
        /// <summary>MDBList source values in their native units; absent without a configured key.</summary>
        public TagSourceRatings? Ratings { get; set; }
        /// <summary>Cached title-level awards/chart facts, refreshed independently of library metadata.</summary>
        public TagAwards? Awards { get; set; }

        // Logos tag group (schema v17). Seasons and episodes carry their series'.
        /// <summary>Provider, network or studio logos, at most the administrator's maximum; null when none or nobody shows the group.</summary>
        public TagLogo[]? Logos { get; set; }

        /// <summary>
        /// Parental / age rating as stored by Jellyfin (e.g. "PG-13", "TV-MA",
        /// "DE-12"). Seasons and Episodes fall back to their Series' rating at
        /// build time, mirroring the CommunityRating fallback.
        /// </summary>
        public string? OfficialRating { get; set; }
        public string[]? AudioLanguages { get; set; }
        /// <summary>
        /// For Series/Season: the subset of <see cref="AudioLanguages"/> that is
        /// missing from at least one episode. <see cref="AudioLanguages"/> is the
        /// union across all episodes, so a language absent from this list is on
        /// every episode ("full-series" language). Null for every other item type.
        /// </summary>
        public string[]? PartialAudioLanguages { get; set; }

        // ── Subtitle languages (schema v14) ─────────────────────────────────
        /// <summary>
        /// Subtitle languages (embedded and external tracks), lower-cased, one
        /// per language however many forced / SDH tracks carry it. Series/Season:
        /// the union across their episodes, like <see cref="AudioLanguages"/>
        /// (no partial list). BoxSet: the union of its members. Spoiler Guard's
        /// tag strip drops it together with <see cref="AudioLanguages"/>.
        /// </summary>
        public string[]? SubtitleLanguages { get; set; }

        public TagStreamData? StreamData { get; set; }

        // Source and edition naming facts (schema v15).
        /// <summary>Canonical release source, derived server-side from the selected version's file/folder name.</summary>
        public string? Source { get; set; }
        /// <summary>Edition label from the selected version's file/folder name; contains no path.</summary>
        public string? Edition { get; set; }

        /// <summary>
        /// When the item was added to the library (Jellyfin's DateCreated), in Unix
        /// milliseconds UTC. Drives the Status Tags "Just Added" badge. Null when
        /// Jellyfin has no date for it.
        /// </summary>
        public long? DateCreated { get; set; }
        /// <summary>
        /// Movie/Series/Episode only: premiere (air) date in Unix milliseconds UTC,
        /// for the Status Tags "New Movie" / "New Series" / "Coming Soon" badges
        /// and an episode's own "New Episode" / premiere / finale badges. Null for
        /// every other type.
        /// </summary>
        public long? PremiereDate { get; set; }
        /// <summary>
        /// Series/Season only: the newest <see cref="DateCreated"/> among its
        /// non-virtual episodes, in Unix milliseconds UTC, for the Status Tags
        /// "New Episode" badge. Null for every other type or a container without
        /// episodes.
        /// </summary>
        public long? LatestEpisodeAdded { get; set; }
        /// <summary>
        /// Series/Season only: the episode (N format, lowercase) that supplied
        /// <see cref="LatestEpisodeAdded"/>. Server-side: the per-user filter drops
        /// the date when the user can't see that episode, and the tag-cache
        /// response leaves it out.
        /// </summary>
        public string? LatestEpisodeId { get; set; }

        // ── Status Tags schedule and milestone facts (combined schema v13) ──────────
        // Built from the same episode walk as LatestEpisodeAdded; every field
        // here that comes from episodes is dropped together, per user, when
        // one of the episodes in StatusEpisodeIds is hidden from them (see
        // TagCacheService.WithoutHiddenLatestEpisode).

        /// <summary>
        /// Series only: Jellyfin's series status ("Continuing", "Ended",
        /// "Unreleased"), for the Status Tags Returning / Ended badge.
        /// </summary>
        public string? Status { get; set; }
        /// <summary>Episode only: its numbers and whether it is the last non-virtual episode in its season.</summary>
        public TagEpisodeIndex? EpisodeIndex { get; set; }
        /// <summary>
        /// Series/Season only: the newest premiere (air) date among the non-virtual
        /// regular episodes, in Unix milliseconds UTC (specials count only in a
        /// Specials season).
        /// </summary>
        public long? LatestEpisodeAired { get; set; }
        /// <summary>Server-only next premiere boundary; a due container is recomputed even without metadata changes.</summary>
        public long? NextEpisodePremiere { get; set; }
        /// <summary>Series/Season only: season and episode number of the episode behind <see cref="LatestEpisodeAired"/>.</summary>
        public TagEpisodeIndex? LatestEpisodeIndex { get; set; }
        /// <summary>
        /// Series: the newest regular season in the library and the air date of
        /// its first aired episode ("New Season"). Season: the season itself and
        /// its first aired episode ("Season Premiere").
        /// </summary>
        public TagSeasonPremiere? SeasonPremiere { get; set; }
        /// <summary>
        /// Season only: when its first and newest episodes were added, and how
        /// many non-virtual episodes it has ("Complete Season").
        /// </summary>
        public TagAddedSpan? SeasonAddedSpan { get; set; }
        /// <summary>
        /// Series/Season only: the episodes (N format, lowercase) the fields
        /// above came from. Server-side like <see cref="LatestEpisodeId"/>: the
        /// per-user filter drops those fields when the user can't see one of
        /// them, and the tag-cache response leaves it out.
        /// </summary>
        public string[]? StatusEpisodeIds { get; set; }

        // Series/season quality aggregation (schema v15). Contributors stay server-side.
        public TagQualitySummary? QualitySummary { get; set; }
        public string[]? QualityEpisodeIds { get; set; }

        public long LastUpdated { get; set; }
        // Series ID in N format (lowercase). Set for Episodes and Seasons, null
        // otherwise. Lets the Spoiler Guard filter strip cache entries for
        // unwatched episodes whose parent series is in the user's spoiler list
        // without a per-episode library lookup on every request.
        public string? SeriesId { get; set; }
        /// <summary>
        /// The library (top-level collection folder) the item is in, N format
        /// (lowercase); Seasons/Episodes take their Series'. Tag look rules on a
        /// library match against it. Null (and left out of responses) when the
        /// item is in no library.
        /// </summary>
        public string? LibraryId { get; set; }

        /// <summary>
        /// Custom tag group: the ids of the administrator's rules the item matches
        /// (<c>tag:&lt;hash&gt;</c> or <c>collection:&lt;hash&gt;</c>, see
        /// <see cref="Configuration.CustomTagRuleSet.RuleId"/>), in the rule order of when it
        /// was matched; renderers treat it as a set and draw the current rule order. Tags are the
        /// item's own plus, for a Season/Episode, its Series'; collections are the
        /// collections holding the item (or its Series). Null when no rule matches.
        /// </summary>
        public string[]? CustomTags { get; set; }

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
                && a.Ratings == b.Ratings
                && a.Awards == b.Awards
                && TagLogo.SequencesEqual(a.Logos, b.Logos)
                && a.OfficialRating == b.OfficialRating
                && SequencesEqual(a.AudioLanguages, b.AudioLanguages)
                && SequencesEqual(a.PartialAudioLanguages, b.PartialAudioLanguages)
                && SequencesEqual(a.SubtitleLanguages, b.SubtitleLanguages)
                && TagStreamData.ContentEquals(a.StreamData, b.StreamData)
                && a.Source == b.Source
                && a.Edition == b.Edition
                && a.DateCreated == b.DateCreated
                && a.PremiereDate == b.PremiereDate
                && a.LatestEpisodeAdded == b.LatestEpisodeAdded
                && a.LatestEpisodeId == b.LatestEpisodeId
                && a.EpisodeIndex == b.EpisodeIndex
                && a.Status == b.Status
                && a.NextEpisodePremiere == b.NextEpisodePremiere
                && a.LatestEpisodeAired == b.LatestEpisodeAired
                && a.LatestEpisodeIndex == b.LatestEpisodeIndex
                && a.SeasonPremiere == b.SeasonPremiere
                && a.SeasonAddedSpan == b.SeasonAddedSpan
                && SequencesEqual(a.StatusEpisodeIds, b.StatusEpisodeIds)
                && TagQualitySummary.ContentEquals(a.QualitySummary, b.QualitySummary)
                && SequencesEqual(a.QualityEpisodeIds, b.QualityEpisodeIds)
                && a.SeriesId == b.SeriesId
                && a.LibraryId == b.LibraryId
                && SequencesEqual(a.CustomTags, b.CustomTags);
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
            if (a == null || b == null) return false;
            if (a.Length != b.Length) return false;
            for (var i = 0; i < a.Length; i++)
            {
                if (!string.Equals(a[i], b[i], StringComparison.Ordinal)) return false;
            }

            return true;
        }

        /// <summary>
        /// Exact nullable-float compare. Exactness is safe on both legs: a freshly
        /// rebuilt value is read from the same database column as the last rebuild,
        /// and a disk-loaded value round-trips bit-exactly because System.Text.Json
        /// writes floats in shortest round-trippable form. Nullable.Equals also
        /// treats NaN as equal to NaN, so a NaN rating can't keep an entry
        /// perpetually "changed".
        /// </summary>
        private static bool NullableFloatEquals(float? a, float? b) => Nullable.Equals(a, b);

        public TagCacheEntry Clone() => new()
        {
            Type = Type,
            // Copy EVERY property: this clone replaces the shared instance in the
            // response, so any field omitted here is silently blanked for the
            // client. TmdbId/SeriesTmdbId/SeasonNumber/EpisodeNumber build the
            // review key — dropping them broke reviews on cloned entries.
            // When adding a field, also add it to ContentEquals above — a field
            // missing there makes real changes to it invisible to the incremental
            // rebuild, so stale data would be served until the next full rebuild.
            TmdbId = TmdbId,
            SeriesTmdbId = SeriesTmdbId,
            SeasonNumber = SeasonNumber,
            EpisodeNumber = EpisodeNumber,
            Genres = Genres,
            CommunityRating = CommunityRating,
            CriticRating = CriticRating,
            Ratings = Ratings,
            Awards = Awards,
            Logos = Logos,
            OfficialRating = OfficialRating,
            AudioLanguages = AudioLanguages,
            PartialAudioLanguages = PartialAudioLanguages,
            SubtitleLanguages = SubtitleLanguages,
            StreamData = StreamData,
            Source = Source,
            Edition = Edition,
            DateCreated = DateCreated,
            PremiereDate = PremiereDate,
            LatestEpisodeAdded = LatestEpisodeAdded,
            LatestEpisodeId = LatestEpisodeId,
            EpisodeIndex = EpisodeIndex,
            Status = Status,
            NextEpisodePremiere = NextEpisodePremiere,
            LatestEpisodeAired = LatestEpisodeAired,
            LatestEpisodeIndex = LatestEpisodeIndex,
            SeasonPremiere = SeasonPremiere,
            SeasonAddedSpan = SeasonAddedSpan,
            StatusEpisodeIds = StatusEpisodeIds,
            QualitySummary = QualitySummary,
            QualityEpisodeIds = QualityEpisodeIds,
            LastUpdated = LastUpdated,
            SeriesId = SeriesId,
            LibraryId = LibraryId,
            CustomTags = CustomTags,
        };
    }

    /// <summary>
    /// A season and episode number (Status Tags). Immutable and value-compared,
    /// so entries can share one instance.
    /// </summary>
    public sealed record TagEpisodeIndex
    {
        public int Season { get; init; }
        public int Episode { get; init; }
        /// <summary>True for the last known episode of its season; null when not resolved.</summary>
        public bool? IsLast { get; init; }
    }

    /// <summary>A season number and the air date (Unix ms UTC) of its first aired episode (Status Tags).</summary>
    public sealed record TagSeasonPremiere
    {
        public int Season { get; init; }
        public long Aired { get; init; }
    }

    /// <summary>When a season's first and newest episodes were added (Unix ms UTC), and its episode count (Status Tags).</summary>
    public sealed record TagAddedSpan
    {
        public long First { get; init; }
        public long Last { get; init; }
        public int Count { get; init; }
    }

    /// <summary>One distinct per-track quality value; audio retains its language for personal filtering.</summary>
    public sealed record TagStreamQuality(string Category, string Label, string? Language = null);

    /// <summary>Raw stream facts and precomputed per-track quality sets shared by web and native resolution.</summary>
    public class TagStreamData
    {
        /// <summary>Distinct stream category values, derived once while building the cache. Null on old/fixture entries.</summary>
        public List<TagStreamQuality>? DistinctQualities { get; set; }
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
                && ListsEqual(a.DistinctQualities, b.DistinctQualities, (x, y) => x == y)
                && ListsEqual(a.Streams, b.Streams, TagMediaStream.ContentEquals)
                && ListsEqual(a.Sources, b.Sources, TagMediaSource.ContentEquals);
        }

        private static bool ListsEqual<T>(List<T>? a, List<T>? b, Func<T, T, bool> equals)
            where T : class
        {
            if (ReferenceEquals(a, b)) return true;
            if (a == null || b == null) return false;
            if (a.Count != b.Count) return false;
            for (var i = 0; i < a.Count; i++)
            {
                var x = a[i];
                var y = b[i];

                // Guard null ELEMENTS before invoking the comparer: the plugin never
                // writes them, but the existing side is deserialized from disk and
                // System.Text.Json happily materializes a JSON null array element as a
                // null item. Without this, one corrupt entry would throw on every
                // rebuild — poisoning that item's incremental updates and aborting the
                // nightly reconcile task, which has no per-item catch.
                if (ReferenceEquals(x, y)) continue;
                if (x == null || y == null) return false;
                if (!equals(x, y)) return false;
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
