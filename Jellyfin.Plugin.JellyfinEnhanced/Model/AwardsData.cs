using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model
{
    /// <summary>
    /// One award category result, shaped differently depending on which side
    /// queried it (see WikidataAwardsService.BuildQuery):
    ///   - Title lookups ("movie"/"tv") populate Recipients — the individual
    ///     people who hold that award/nomination for this title (acting,
    ///     directing, writing categories are recorded on the person in
    ///     Wikidata, qualified "for work" back to the film/show).
    ///   - Person lookups populate Works instead — the film/show each award
    ///     was received "for" (the same "for work" qualifier, read from the
    ///     other direction). A person's own non-competitive honors (honorary
    ///     degrees, civic awards, guild fellowships, etc.) have no qualifying
    ///     work, so Works is empty for those rows.
    /// A given entry only ever populates one of the two, never both.
    /// </summary>
    public class AwardEntry
    {
        public string Name { get; set; } = string.Empty;
        /// <summary>"Won" or "Nominated".</summary>
        public string Result { get; set; } = string.Empty;
        public int? Year { get; set; }
        public List<string> Recipients { get; set; } = new();
        public List<string> Works { get; set; } = new();
    }

    /// <summary>
    /// Cached awards lookup result for one title, keyed by media type + TMDB id
    /// (see WikidataAwardsService.CacheKey). Persisted to disk as part of
    /// AwardsCacheDiskFormat.
    /// </summary>
    public class AwardsCacheEntry
    {
        /// <summary>False when the title has no matching Wikidata item, or the
        /// item has no award claims. Distinguishes "we checked, there's nothing"
        /// from an entry that was never looked up.</summary>
        public bool Found { get; set; }
        public int Wins { get; set; }
        public int Nominations { get; set; }
        public List<AwardEntry> Awards { get; set; } = new();
        /// <summary>True once Wikidata actually answered this query (success
        /// response, whether or not it contained rows). False means this entry
        /// is a failure placeholder — a network error, timeout, or non-2xx
        /// response — and must NOT be treated as a confirmed "no awards": it's
        /// retried on WikidataAwardsService.RetryTtl (short), not the full
        /// NegativeTtl, so a transient WDQS hiccup on a title's first lookup
        /// can't hide its real award data for weeks. Defaults to false, so an
        /// on-disk entry from before this field existed is treated as
        /// unconfirmed and retried promptly rather than trusted as-is.</summary>
        public bool Confirmed { get; set; }
        /// <summary>Unix ms timestamp this entry was fetched. Found entries
        /// expire on WikidataAwardsService.PositiveTtl (long — Wikidata
        /// corrections/additions are rare but do happen); !Found entries expire
        /// on the much shorter NegativeTtl if Confirmed, or RetryTtl if not (see
        /// Confirmed) — so a title that later gains Wikidata award data (new
        /// release, still-being-edited item, or a retried transient failure)
        /// gets re-checked instead of staying stale forever.</summary>
        public long FetchedAtUnixMs { get; set; }
    }

    /// <summary>On-disk shape of awards.json.</summary>
    public class AwardsCacheDiskFormat
    {
        public int SchemaVersion { get; set; }
        public Dictionary<string, AwardsCacheEntry> Items { get; set; } = new();
    }
}
