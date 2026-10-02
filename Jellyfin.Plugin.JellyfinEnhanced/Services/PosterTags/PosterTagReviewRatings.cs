using System;
using System.Collections.Generic;
using System.Threading;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    /// <summary>A viewer's user-review summary for one item.</summary>
    /// <param name="Average">Average rating (1-5) of the visible rated reviews, null when there are none.</param>
    /// <param name="Count">Number of visible rated reviews; null when the item has no review key (no chip at all).</param>
    public readonly record struct PosterTagReviewSummary(double? Average, int? Count)
    {
        /// <summary>No review chip for this item (feature off, unsupported type or no TMDB id).</summary>
        public static readonly PosterTagReviewSummary None = new(null, null);
    }

    // The user-review chip's number, computed exactly like GET
    // /JellyfinEnhanced/reviews/ratings computes it for the web chip: same key
    // match (store key ends with ":" + key), same per-viewer visibility
    // (ReviewVisibility), same "only a non-zero rating counts" rule.
    //
    // The web chip only resolves a key for Movie ("movie:{tmdb}") and Series
    // ("tv:{tmdb}") cards in server-cache mode; Season/Episode cards never get
    // the chip there (spec-visual §6, a web quirk kept for parity).
    //
    // reviews.json is read once into an index (by every ":"-tail of each store
    // key, mirroring the endpoint's suffix match) and rebuilt after a review
    // write (UserConfigurationManager.ReviewsChanged) or after a TTL.
    public sealed class PosterTagReviewRatings : IDisposable
    {
        private static readonly TimeSpan IndexTtl = TimeSpan.FromMinutes(5);

        private sealed record Index(Dictionary<string, List<UserReview>> ByKey, DateTime BuiltAt, long Generation);

        private readonly UserConfigurationManager _userConfig;
        private readonly PosterTagUserCache _users;
        private readonly Logger _logger;
        private readonly object _buildLock = new();
        private volatile Index? _index;

        // Bumped by every review write, so an index built from the file as it
        // was before a concurrent write is never served.
        private long _generation;

        public PosterTagReviewRatings(UserConfigurationManager userConfig, PosterTagUserCache users, Logger logger)
        {
            _userConfig = userConfig;
            _users = users;
            _logger = logger;
            _userConfig.ReviewsChanged += OnReviewsChanged;
        }

        /// <summary>
        /// The review chip data for a tag-cache entry as <paramref name="viewer"/> would see it,
        /// or <see cref="PosterTagReviewSummary.None"/> when the chip does not apply.
        /// </summary>
        public PosterTagReviewSummary Get(TagCacheEntry entry, JUser viewer)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config?.ShowUserReviews != true || config.ShowUserRatingOnPosters != true) return PosterTagReviewSummary.None;
            var key = ReviewKey(entry);
            if (key == null) return PosterTagReviewSummary.None;

            var index = GetIndex();
            if (!index.ByKey.TryGetValue(key, out var reviews)) return new PosterTagReviewSummary(null, 0);

            var viewerIsAdmin = viewer.HasPermission(PermissionKind.IsAdministrator);
            var viewerIdN = viewer.Id.ToString("N");
            double sum = 0;
            var count = 0;
            foreach (var review in reviews)
            {
                try
                {
                    var visible = ReviewVisibility.IsVisible(
                        review,
                        viewerIsAdmin,
                        viewerIdN,
                        config.HideReviewsFromHiddenUsers,
                        config.HideReviewsFromDisabledUsers,
                        _users.Get, // author lookup: cached (a DB transaction per call otherwise)
                        out _,
                        out _);
                    if (!visible) continue;

                    // Same rule as the endpoint: only a non-zero rating counts (NaN excluded).
                    var rating = review.Rating ?? 0;
                    if (double.IsNaN(rating) || Math.Abs(rating) <= 0) continue;
                    sum += rating;
                    count++;
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    // One unusable record skips only itself.
                    _logger.Debug($"Native poster tags: skipping review for {key}: {ex.Message}");
                }
            }

            return count == 0 ? new PosterTagReviewSummary(null, 0) : new PosterTagReviewSummary(sum / count, count);
        }

        /// <summary>The web chip's review key for an entry (Movie and Series only), or null.</summary>
        public static string? ReviewKey(TagCacheEntry entry)
        {
            if (string.IsNullOrEmpty(entry.TmdbId)) return null;
            return entry.Type switch
            {
                "Movie" => "movie:" + entry.TmdbId,
                "Series" => "tv:" + entry.TmdbId,
                _ => null,
            };
        }

        public void Dispose()
        {
            _userConfig.ReviewsChanged -= OnReviewsChanged;
        }

        private void OnReviewsChanged()
        {
            Interlocked.Increment(ref _generation);
            _index = null;
        }

        private bool IsCurrent(Index? index)
            => index != null
                && index.Generation == Interlocked.Read(ref _generation)
                && DateTime.UtcNow - index.BuiltAt < IndexTtl;

        private Index GetIndex()
        {
            var index = _index;
            if (IsCurrent(index)) return index!;
            lock (_buildLock)
            {
                index = _index;
                if (IsCurrent(index)) return index!;
                index = Build(Interlocked.Read(ref _generation));
                _index = index;
                return index;
            }
        }

        private Index Build(long generation)
        {
            var byKey = new Dictionary<string, List<UserReview>>(StringComparer.Ordinal);
            try
            {
                foreach (var kvp in _userConfig.GetAllReviews().Reviews)
                {
                    if (kvp.Value == null) continue;
                    // Store keys are "{userIdN}:{mediaType}:{tmdbKey}"; index every
                    // tail after a ':' so lookups match exactly like the endpoint's
                    // suffix probe.
                    var storeKey = kvp.Key;
                    for (var i = storeKey.IndexOf(':'); i >= 0; i = storeKey.IndexOf(':', i + 1))
                    {
                        var tail = storeKey.Substring(i + 1);
                        if (!byKey.TryGetValue(tail, out var list))
                        {
                            list = new List<UserReview>();
                            byKey[tail] = list;
                        }
                        list.Add(kvp.Value);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"Native poster tags: could not index reviews: {ex.Message}");
            }

            return new Index(byKey, DateTime.UtcNow, generation);
        }
    }
}
