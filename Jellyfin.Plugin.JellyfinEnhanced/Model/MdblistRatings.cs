using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Model
{
    /// <summary>
    /// One rating source entry as returned by MDBList's API, e.g. source
    /// "tmdb" (0-10 scale) or "tomatoes" (Rotten Tomatoes critic, 0-100
    /// scale). <see cref="Score"/> is the already-scaled value MDBList itself
    /// displays; <see cref="Value"/> is the raw un-scaled figure. Either can
    /// be null when MDBList has no data for that source on this title.
    /// </summary>
    public class MdblistRatingSource
    {
        public string Source { get; set; } = string.Empty;
        public double? Value { get; set; }
        public double? Score { get; set; }
        public int? Votes { get; set; }
        /// <summary>Source-specific deep link (e.g. a Rotten Tomatoes or
        /// Letterboxd slug/path) when MDBList provides one. Null for sources
        /// the display module instead links via MdblistCacheEntry.Ids (tmdb,
        /// imdb, trakt) or a constructed URL (metacritic, myanimelist).</summary>
        public string? Url { get; set; }
        /// <summary>Rotten Tomatoes' own Fresh/Rotten status for the "tomatoes"
        /// (critic) source only; confirmed absent from every other source,
        /// including "popcorn" (audience). 1 = Fresh, 0 = Rotten, null when
        /// MDBList doesn't report it for this title.</summary>
        public int? Fresh { get; set; }
    }

    /// <summary>
    /// Cached MDBList lookup result for one title, keyed by media type + TMDB
    /// id (see MdblistService.CacheKey). Persisted to disk as part of
    /// MdblistCacheDiskFormat.
    /// </summary>
    public class MdblistCacheEntry
    {
        /// <summary>False when MDBList has no matching title at all.
        /// Distinguishes "we checked, MDBList doesn't have this title" from a
        /// title that does exist but simply has no ratings for a given
        /// source (see MdblistRatingSource.Score being null).</summary>
        public bool Found { get; set; }
        public List<MdblistRatingSource> Ratings { get; set; } = new();
        /// <summary>True once MDBList actually answered this query (success
        /// response), whether or not it had a match. False means this entry
        /// is a failure placeholder (network error, timeout, rate limit) and
        /// must NOT be treated as a confirmed miss; see
        /// MdblistService.RetryTtl vs NegativeTtl.</summary>
        public bool Confirmed { get; set; }
        public long FetchedAtUnixMs { get; set; }
        /// <summary>Cross-provider IDs (imdb, tmdb, trakt, mal, anilist, ...)
        /// from the top-level "ids" object, used by the display module to
        /// build direct links to each rating's source site. Populated by both
        /// the single-item endpoint and MdblistService.GetMediaBatchAsync's
        /// batch endpoint, since both return the same media item shape.</summary>
        public Dictionary<string, string> Ids { get; set; } = new();
    }

    /// <summary>On-disk shape of mdblist-ratings.json.</summary>
    public class MdblistCacheDiskFormat
    {
        public int SchemaVersion { get; set; }
        public Dictionary<string, MdblistCacheEntry> Items { get; set; } = new();
    }

    /// <summary>
    /// Live account/quota status from MDBList's own GET /user endpoint,
    /// the authoritative source for how much of the daily request quota is
    /// left, rather than a locally-tracked counter that would drift out of
    /// sync with reality across a plugin/server restart. Not persisted to
    /// disk; kept in memory only, refreshed on a short TTL (see
    /// MdblistService.AccountStatusTtl).
    /// </summary>
    public class MdblistAccountStatus
    {
        public string Plan { get; set; } = string.Empty;
        public bool IsSupporter { get; set; }
        /// <summary>The account's total daily request quota (MDBList's "rate_limit").</summary>
        public int RateLimit { get; set; }
        /// <summary>Requests left before RateLimitResetUnixSeconds.</summary>
        public int RateLimitRemaining { get; set; }
        /// <summary>Unix seconds (UTC) when RateLimitRemaining resets back to RateLimit.</summary>
        public long RateLimitResetUnixSeconds { get; set; }
        public long FetchedAtUnixMs { get; set; }
    }
}
