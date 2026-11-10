using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders
{
    public partial class JeDetailsProvidersController
    {
        // ─── User Reviews (shared reviews.json at plugin config root) ────────────

        public sealed class ReviewPayload
        {
            public string Content { get; set; } = string.Empty;
            public double? Rating { get; set; }
        }

        /// <summary>Rating must be 0.5–5 in 0.5 increments (0.5, 3.5, 5, etc.).</summary>
        private static bool IsValidRating(double? rating) =>
            !rating.HasValue || (rating.Value >= 0.5 && rating.Value <= 5 && Math.Abs(rating.Value * 2 - Math.Round(rating.Value * 2)) < 0.0001);

        private static readonly System.Text.RegularExpressions.Regex _tmdbIdRegex =
            new System.Text.RegularExpressions.Regex(@"^\d+$", System.Text.RegularExpressions.RegexOptions.Compiled);

        // Extended key for season/episode reviews: {tmdbId}:s{n} or {tmdbId}:s{n}e{n}
        private static readonly System.Text.RegularExpressions.Regex _tmdbIdExtendedRegex =
            new System.Text.RegularExpressions.Regex(@"^\d+(:s\d+(:e\d+)?)?$", System.Text.RegularExpressions.RegexOptions.Compiled);

        private static bool IsValidTmdbKey(string tmdbId) =>
            !string.IsNullOrWhiteSpace(tmdbId) && _tmdbIdExtendedRegex.IsMatch(tmdbId);

        [HttpGet("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetItemReviews(string mediaType, string tmdbId)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { message = "Invalid TmdbId." });

            var itemLabel = $"{mediaType}:{tmdbId}";
            var ctx = CreateReviewVisibilityContext(nameof(GetItemReviews), itemLabel);

            var suffix = $":{mediaType}:{tmdbId}";
            var store = _userConfigurationManager.GetAllReviews();
            var results = new List<object>();

            foreach (var kvp in store.Reviews)
            {
                if (!kvp.Key.EndsWith(suffix, StringComparison.Ordinal)) continue;

                // Per-review try/catch: if anything blows up while looking up
                // the author or evaluating their permissions, we skip just
                // this review with a warning. Without this, a single corrupt
                // or orphaned record would 500 the entire GetItemReviews call
                // and hide every other review on the item.
                try
                {
                    var review = kvp.Value;
                    if (!IsReviewVisibleToViewer(review, ctx, itemLabel, out var jellyfinUser)) continue;

                    results.Add(new
                    {
                        userId = review.UserId,
                        userName = jellyfinUser != null ? jellyfinUser.Username : review.UserId,
                        tmdbId = review.TmdbId,
                        mediaType = review.MediaType,
                        content = review.Content,
                        rating = review.Rating,
                        createdAt = review.CreatedAt,
                        updatedAt = review.UpdatedAt
                    });
                }
                catch (Exception ex)
                {
                    _logger.Warning($"Skipping review key={kvp.Key} due to filter error: {ex.Message}");
                }
            }

            return Ok(new { reviews = results });
        }

        /// <summary>Most distinct keys one <see cref="GetReviewRatings"/> call may ask for.</summary>
        private const int MaxReviewRatingKeys = 200;

        /// <summary>
        /// Average user rating for many items in one pass over the review
        /// store (the poster rating chips ask for a whole page at once instead
        /// of one <see cref="GetItemReviews"/> call per card).
        /// </summary>
        /// <param name="keys">Comma-separated "mediaType:tmdbKey" entries, e.g.
        /// "movie:603,tv:1399:s1". Malformed entries are ignored; at most
        /// <see cref="MaxReviewRatingKeys"/> distinct valid keys.</param>
        /// <returns>
        /// <c>{ "ratings": { "movie:603": { "average": 4.5, "count": 2 }, "tv:1399:s1": null } }</c>
        /// — one entry per valid requested key; null when no review visible to
        /// this viewer carries a rating. Computed from exactly the reviews
        /// <see cref="GetItemReviews"/> would return to the same viewer.
        /// </returns>
        [HttpGet("reviews/ratings")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetReviewRatings([FromQuery] string? keys)
        {
            // Insertion-ordered so the response lists keys in request order.
            var requested = new Dictionary<string, (double Sum, int Count)>(StringComparer.Ordinal);
            var order = new List<string>();
            foreach (var raw in (keys ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                var sep = raw.IndexOf(':');
                if (sep <= 0) continue;
                var mediaType = raw.Substring(0, sep);
                if (mediaType != "movie" && mediaType != "tv") continue;
                if (!IsValidTmdbKey(raw.Substring(sep + 1))) continue;
                if (requested.ContainsKey(raw)) continue;
                if (requested.Count >= MaxReviewRatingKeys)
                    return BadRequest(new { message = $"At most {MaxReviewRatingKeys} keys per request." });
                requested[raw] = (0, 0);
                order.Add(raw);
            }

            if (requested.Count == 0)
                return BadRequest(new { message = "No valid keys. Expected comma-separated 'movie:<tmdbId>' or 'tv:<tmdbId>[:s<n>[:e<n>]]' entries." });

            var ctx = CreateReviewVisibilityContext(nameof(GetReviewRatings), $"{requested.Count} keys");
            foreach (var (key, sum, count) in AggregateVisibleReviewRatings(ctx, requested.ContainsKey))
            {
                requested[key] = (sum, count);
            }

            var ratings = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var key in order)
            {
                var (sum, count) = requested[key];
                ratings[key] = count == 0 ? null : new { average = sum / count, count };
            }

            return Ok(new { ratings });
        }

        [HttpPost("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UpsertReview(string mediaType, string tmdbId, [FromBody] ReviewPayload payload)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (payload == null)
                return BadRequest(new { success = false, message = "Invalid review payload." });

            var normalizedContent = payload.Content?.Trim() ?? string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedContent) && !payload.Rating.HasValue)
                return BadRequest(new { success = false, message = "A rating or review text is required." });

            if (normalizedContent.Length > 2000)
                return BadRequest(new { success = false, message = "Review content must not exceed 2000 characters." });

            if (!IsValidRating(payload.Rating))
                return BadRequest(new { success = false, message = "Rating must be between 0.5 and 5, in 0.5 increments." });

            var currentUserId = UserHelper.GetCurrentUserId(User);
            if (!currentUserId.HasValue || currentUserId.Value == Guid.Empty) return Forbid();
            var userIdN = currentUserId.Value.ToString("N");

            try
            {
                var now = DateTime.UtcNow.ToString("o");
                var previousRating = _userConfigurationManager.UpsertReview(
                    userIdN, mediaType, tmdbId, normalizedContent, payload.Rating, now);
                _logger.Info($"Saved review for {mediaType}:{tmdbId} by user {_userDisplayResolver.ResolveUserDisplay(userIdN)}.");
                MirrorReviewRatingToUserData(userIdN, mediaType, tmdbId, previousRating, payload.Rating);
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to save review for user {_userDisplayResolver.ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save review." });
            }
        }

        [HttpPost("reviews/admin/{userIdN}/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminUpsertReview(string userIdN, string mediaType, string tmdbId, [FromBody] ReviewPayload payload)
        {
            if (!IsAdminUser())
                return Forbid();

            if (string.IsNullOrWhiteSpace(userIdN) || !Guid.TryParseExact(userIdN, "N", out _))
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (payload == null)
                return BadRequest(new { success = false, message = "Invalid review payload." });

            var normalizedContent = payload.Content?.Trim() ?? string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedContent) && !payload.Rating.HasValue)
                return BadRequest(new { success = false, message = "A rating or review text is required." });

            if (normalizedContent.Length > 2000)
                return BadRequest(new { success = false, message = "Review content must not exceed 2000 characters." });

            if (!IsValidRating(payload.Rating))
                return BadRequest(new { success = false, message = "Rating must be between 0.5 and 5, in 0.5 increments." });

            try
            {
                var now = DateTime.UtcNow.ToString("o");
                var previousRating = _userConfigurationManager.UpsertReview(
                    userIdN, mediaType, tmdbId, normalizedContent, payload.Rating, now);
                _logger.Info($"Admin saved review for {mediaType}:{tmdbId} on behalf of {_userDisplayResolver.ResolveUserDisplay(userIdN)}.");
                MirrorReviewRatingToUserData(userIdN, mediaType, tmdbId, previousRating, payload.Rating);
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin failed to save review for user {_userDisplayResolver.ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save review." });
            }
        }

        [HttpDelete("reviews/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DeleteReview(string mediaType, string tmdbId)
        {
            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            var currentUserId = UserHelper.GetCurrentUserId(User);
            if (!currentUserId.HasValue || currentUserId.Value == Guid.Empty) return Forbid();
            var userIdN = currentUserId.Value.ToString("N");

            try
            {
                if (_userConfigurationManager.DeleteReview(userIdN, mediaType, tmdbId, out var removedRating))
                {
                    _logger.Info($"Deleted review for {mediaType}:{tmdbId} by user {_userDisplayResolver.ResolveUserDisplay(userIdN)}.");
                    MirrorReviewRatingToUserData(userIdN, mediaType, tmdbId, removedRating, null);
                }
                return Ok(new { success = true });
            }
            catch (Exception ex)
            {
                _logger.Error($"Failed to delete review for user {_userDisplayResolver.ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to delete review." });
            }
        }

        /// <summary>
        /// Optionally keeps Jellyfin's own per-user rating for the matching
        /// library item in step with a review's star rating, so tools that only
        /// read Jellyfin user data (scrobblers, Letterboxd/Trakt syncs, other
        /// clients) can see ratings given through the reviews UI. Gated by the
        /// MirrorReviewRatingsToJellyfin setting (off by default).
        ///
        /// previousRating is the review's rating before this change (null if it
        /// had none or is new) and newRating the rating after it (null when the
        /// review was deleted or saved without a rating).
        ///
        /// - newRating set: write it to Jellyfin (overwrites).
        /// - newRating null and previousRating set: clear the Jellyfin rating,
        ///   but only if it still equals what the review would have mirrored.
        ///   Jellyfin ratings carry no provenance, so a value that differs was
        ///   changed somewhere else (another client, a sync tool) and is left
        ///   alone.
        ///
        /// Only whole movies and series are touched (a season/episode key has
        /// no reliably TMDB-keyed library item). Scale: 1-5 stars in half steps
        /// become Jellyfin's 0-10 (x2), which is what Jellyfin's own clients
        /// and the ratings-based sync tools already expect.
        ///
        /// Never throws: the review change is already saved by the time this
        /// runs, and a mirror failure must not turn that into a 500.
        /// </summary>
        private void MirrorReviewRatingToUserData(string userIdN, string mediaType, string tmdbId, double? previousRating, double? newRating)
        {
            try
            {
                var config = JellyfinEnhanced.Instance?.Configuration;
                if (config == null || !config.MirrorReviewRatingsToJellyfin) return;
                if (!newRating.HasValue && !previousRating.HasValue) return;

                // Season/episode reviews carry a ":s{n}[:e{n}]" suffix; there is no
                // TMDB-keyed library item to attach those to, so leave them alone.
                if (tmdbId.Contains(':')) return;

                if (!Guid.TryParseExact(userIdN, "N", out var userGuid)) return;
                var user = _userManager.GetUserById(userGuid);
                if (user == null) return;

                var item = _libraryItemLookup.FindLibraryItemByTmdb(user, mediaType, tmdbId);
                if (item == null)
                {
                    _logger.Debug($"[ReviewRatingMirror] No library item for {mediaType}:{tmdbId}; nothing to mirror for {_userDisplayResolver.ResolveUserDisplay(userIdN)}.");
                    return;
                }

                var userData = _userDataManager.GetUserData(user, item);
                if (userData == null) return;

                if (newRating.HasValue)
                {
                    var jellyfinRating = Math.Round(newRating.Value * 2, 1);
                    if (userData.Rating.HasValue && Math.Abs(userData.Rating.Value - jellyfinRating) < 0.01) return;

                    userData.Rating = jellyfinRating;
                    _userDataManager.SaveUserData(user, item, userData, UserDataSaveReason.UpdateUserRating, default);
                    _logger.Info($"[ReviewRatingMirror] Set Jellyfin rating {jellyfinRating} on '{item.Name}' for {_userDisplayResolver.ResolveUserDisplay(userIdN)} from their review.");
                    return;
                }

                var mirroredRating = Math.Round(previousRating!.Value * 2, 1);
                if (!userData.Rating.HasValue) return;
                if (Math.Abs(userData.Rating.Value - mirroredRating) >= 0.01)
                {
                    _logger.Debug($"[ReviewRatingMirror] Jellyfin rating {userData.Rating.Value} on '{item.Name}' no longer matches the review's {mirroredRating}; leaving it for {_userDisplayResolver.ResolveUserDisplay(userIdN)}.");
                    return;
                }

                userData.Rating = null;
                _userDataManager.SaveUserData(user, item, userData, UserDataSaveReason.UpdateUserRating, default);
                _logger.Info($"[ReviewRatingMirror] Cleared Jellyfin rating {mirroredRating} on '{item.Name}' for {_userDisplayResolver.ResolveUserDisplay(userIdN)} after their review rating was removed.");
            }
            catch (Exception ex)
            {
                _logger.Warning($"[ReviewRatingMirror] Could not mirror rating for {mediaType}:{tmdbId}: {ex.Message}");
            }
        }

        /// <summary>
        /// Lists every review on the server for an Administrator caller, so a
        /// headless integration (a sync job, a scrobbler, a backup script) can
        /// consume reviews without knowing the store's on-disk layout or
        /// polling the per-item endpoint once per TMDB id. Ordered by
        /// updatedAt ascending so a client can page forward and keep the last
        /// updatedAt it saw as its next "since".
        /// </summary>
        /// <param name="since">Optional ISO 8601 timestamp; only reviews whose updatedAt is at or after it are returned. A review whose stored timestamp cannot be parsed is always returned rather than silently dropped.</param>
        /// <param name="userId">Optional author filter, 32-char hex (N) form.</param>
        /// <param name="limit">Page size, 1-1000, default 500.</param>
        /// <param name="offset">Number of matching reviews to skip, default 0.</param>
        [HttpGet("reviews/admin/all")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminListReviews(
            [FromQuery] string? since = null,
            [FromQuery] string? userId = null,
            [FromQuery] int limit = 500,
            [FromQuery] int offset = 0)
        {
            if (!IsAdminUser())
                return Forbid();

            DateTimeOffset? sinceUtc = null;
            if (!string.IsNullOrWhiteSpace(since))
            {
                if (!DateTimeOffset.TryParse(since, System.Globalization.CultureInfo.InvariantCulture,
                        System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                        out var parsedSince))
                    return BadRequest(new { success = false, message = "Invalid 'since' (expected ISO 8601)." });
                sinceUtc = parsedSince;
            }

            if (!string.IsNullOrWhiteSpace(userId) && !Guid.TryParseExact(userId, "N", out _))
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            if (limit < 1 || limit > 1000)
                return BadRequest(new { success = false, message = "limit must be between 1 and 1000." });

            if (offset < 0)
                return BadRequest(new { success = false, message = "offset must be 0 or greater." });

            try
            {
                var store = _userConfigurationManager.GetAllReviews();

                var matching = new List<(DateTimeOffset? UpdatedAt, string Key, UserReview Review)>();
                foreach (var kvp in store.Reviews)
                {
                    var review = kvp.Value;
                    if (review == null) continue;

                    if (!string.IsNullOrWhiteSpace(userId)
                        && !string.Equals(review.UserId, userId, StringComparison.OrdinalIgnoreCase))
                        continue;

                    DateTimeOffset? updatedAt = null;
                    if (DateTimeOffset.TryParse(review.UpdatedAt, System.Globalization.CultureInfo.InvariantCulture,
                            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                            out var parsedUpdated))
                        updatedAt = parsedUpdated;

                    // Unparseable timestamps are kept so a corrupt field never hides a review.
                    if (sinceUtc.HasValue && updatedAt.HasValue && updatedAt.Value < sinceUtc.Value)
                        continue;

                    matching.Add((updatedAt, kvp.Key, review));
                }

                // Stable order: by updatedAt, then by key so ties never reshuffle between pages.
                matching.Sort((a, b) =>
                {
                    var byDate = Nullable.Compare(a.UpdatedAt, b.UpdatedAt);
                    return byDate != 0 ? byDate : string.CompareOrdinal(a.Key, b.Key);
                });

                var page = matching.Skip(offset).Take(limit).Select(m =>
                {
                    var review = m.Review;
                    string displayName = review.UserId;
                    if (Guid.TryParseExact(review.UserId, "N", out var authorGuid))
                    {
                        var author = _userManager.GetUserById(authorGuid);
                        if (author != null) displayName = author.Username;
                    }

                    return new
                    {
                        userId = review.UserId,
                        userName = displayName,
                        tmdbId = review.TmdbId,
                        mediaType = review.MediaType,
                        content = review.Content,
                        rating = review.Rating,
                        createdAt = review.CreatedAt,
                        updatedAt = review.UpdatedAt
                    };
                }).ToList();

                return Ok(new
                {
                    reviews = page,
                    total = matching.Count,
                    offset,
                    limit
                });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin failed to list reviews: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to list reviews." });
            }
        }

        [HttpDelete("reviews/admin/{userIdN}/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AdminDeleteReview(string userIdN, string mediaType, string tmdbId)
        {
            if (!IsAdminUser())
                return Forbid();

            if (mediaType != "movie" && mediaType != "tv")
                return BadRequest(new { success = false, message = "MediaType must be 'movie' or 'tv'." });

            if (!IsValidTmdbKey(tmdbId))
                return BadRequest(new { success = false, message = "Invalid TmdbId." });

            if (string.IsNullOrWhiteSpace(userIdN) || !Guid.TryParseExact(userIdN, "N", out _))
                return BadRequest(new { success = false, message = "Invalid userId (expected 32-char hex)." });

            try
            {
                var removed = _userConfigurationManager.DeleteReview(userIdN, mediaType, tmdbId, out var removedRating);
                if (removed)
                {
                    _logger.Info($"Admin deleted review for {mediaType}:{tmdbId} by user {_userDisplayResolver.ResolveUserDisplay(userIdN)}.");
                    MirrorReviewRatingToUserData(userIdN, mediaType, tmdbId, removedRating, null);
                    return Ok(new { success = true, removed = true });
                }
                // Fail explicitly: nothing to delete means the review was
                // already gone (race with a concurrent delete, wrong
                // userIdN, or a stale admin click). Returning 200 here
                // lets the frontend think it succeeded and refresh to a
                // list that looks the same as before.
                return NotFound(new { success = false, removed = false, message = "No matching review to delete." });
            }
            catch (Exception ex)
            {
                _logger.Error($"Admin failed to delete review for {mediaType}:{tmdbId} user {_userDisplayResolver.ResolveUserDisplay(userIdN)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to delete review." });
            }
        }
    }
}
