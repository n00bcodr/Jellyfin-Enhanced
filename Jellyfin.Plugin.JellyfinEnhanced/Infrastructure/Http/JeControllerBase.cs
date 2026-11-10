using System;
using System.Collections.Generic;
using Jellyfin.Data;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Auth;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Reviews;

namespace Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Http
{
    /// <summary>
    /// Shared base of the JE controllers (artifacts/restructure-plan/backend.md §3 "Shared base"). No class-level
    /// attributes, so anonymous routes stay anonymous. The helpers read <c>User</c> or <see cref="IsAdminUser"/> and
    /// must stay controller members; their bodies were moved verbatim from JellyfinEnhancedController.
    /// </summary>
    public abstract class JeControllerBase : ControllerBase
    {
        protected readonly Logger _logger;
        protected readonly IUserManager _userManager;
        protected readonly UserConfigurationManager _userConfigurationManager;

        protected JeControllerBase(IUserManager userManager, Logger logger, UserConfigurationManager userConfigurationManager)
        {
            _userManager = userManager;
            _logger = logger;
            _userConfigurationManager = userConfigurationManager;
        }

        protected IActionResult? AuthorizeUserConfigAccess(string requestedUserId, out string authorizedUserId)
        {
            authorizedUserId = string.Empty;

            if (string.IsNullOrWhiteSpace(requestedUserId))
            {
                return BadRequest(new { message = "userId is required." });
            }

            if (!Guid.TryParse(requestedUserId, out var parsedUserId) && !Guid.TryParseExact(requestedUserId, "N", out parsedUserId))
            {
                return BadRequest(new { message = "Invalid userId format." });
            }

            var effectiveUserId = UserHelper.GetUserId(User, parsedUserId);
            if (!effectiveUserId.HasValue)
            {
                return Forbid();
            }

            // UserConfigurationManager expects folder names in N format (without dashes).
            authorizedUserId = effectiveUserId.Value.ToString("N");
            return null;
        }

        protected IActionResult? AuthorizeUserAccess(Guid requestedUserId, out JUser user)
        {
            user = null!;
            var effectiveUserId = UserHelper.GetUserId(User, requestedUserId);
            if (!effectiveUserId.HasValue)
            {
                return Forbid();
            }

            var resolvedUser = _userManager.GetUserById(effectiveUserId.Value);
            if (resolvedUser is null)
            {
                return NotFound();
            }

            user = resolvedUser;
            return null;
        }

        // previously a single `User.IsInRole("Administrator")`
        // magic-string check. Cross-check against the IUserManager-resolved
        // Jellyfin user's actual `IsAdministrator` permission so a future
        // Jellyfin core role-name rename can't silently downgrade JE's
        // admin gates. Falls back to the role claim if the user lookup
        // fails (which would be a programmer error since `[Authorize]`
        // gates every admin endpoint).
        protected bool IsAdminUser()
        {
            if (User.IsInRole("Administrator")) return true;
            try
            {
                var jfUserId = UserHelper.GetCurrentUserId(User);
                if (!jfUserId.HasValue) return false;
                var u = _userManager.GetUserById(jfUserId.Value);
                return u != null && u.HasPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.IsAdministrator);
            }
            catch { return false; }
        }

        protected RevisionedSettingsResponse LoadRevisionedSettings(string userId)
            => new Shared.Settings.SettingsDocumentService(_userConfigurationManager).Read(userId, SettingsDefaults.Create, IsAdminUser());

        protected ReviewVisibilityContext CreateReviewVisibilityContext(string endpoint, string target)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;

            // Resolve the current viewer's "N"-format user id so we can
            // always show their OWN review back to them, even when the
            // viewer themselves is hidden/disabled in Jellyfin and the
            // hide filters would otherwise drop their author record.
            // Without this, a hidden non-admin user posting a review would
            // immediately lose visibility of their own content (issue 546).
            var viewerUserIdN = UserHelper.GetCurrentUserId(User)?.ToString("N");
            if (string.IsNullOrEmpty(viewerUserIdN))
            {
                // Anomalous: [Authorize] passed but the Jellyfin-UserId
                // claim is missing or unparseable. The self-review bypass
                // below will silently no-op, so warn here to give a
                // diagnostic trail if a hidden user reports the symptom
                // again with no obvious cause.
                _logger.Warning($"{endpoint}: could not resolve viewer user id from claims on {target}; self-review bypass disabled.");
            }

            return new ReviewVisibilityContext
            {
                ViewerIsAdmin = IsAdminUser(),
                ViewerUserIdN = viewerUserIdN,
                HideHiddenAuthors = config?.HideReviewsFromHiddenUsers ?? true,
                HideDisabledAuthors = config?.HideReviewsFromDisabledUsers ?? true,
            };
        }

        protected Guid GetCurrentUserId()
        {
            var claim = User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)
                     ?? User.FindFirst("sub")
                     ?? User.FindFirst("Sid");
            if (claim != null && Guid.TryParse(claim.Value, out var id))
                return id;
            return Guid.Empty;
        }

        protected IActionResult ParentalBlockedResult()
        {
            return StatusCode(403, new
            {
                error = true,
                code = "parental_block",
                message = "This title is above your parental rating limit."
            });
        }

        /// <summary>
        /// Decides whether <paramref name="review"/> is visible to the viewer
        /// described by <paramref name="ctx"/> and resolves its author
        /// (null when the id is unparseable or the user no longer exists).
        /// May throw on a corrupt record or a failing user lookup — callers
        /// isolate each review so one bad record cannot fail the request.
        /// </summary>
        /// <summary>
        /// The Jellyfin user behind a review author id (null when the user no
        /// longer exists), through <see cref="Jellyfin.Plugin.JellyfinEnhanced.Shared.Reviews.ReviewAuthorCache"/>, which the
        /// user update/delete events invalidate.
        /// </summary>
        protected Jellyfin.Database.Implementations.Entities.User? ResolveReviewAuthor(Guid userGuid)
            => Jellyfin.Plugin.JellyfinEnhanced.Shared.Reviews.ReviewAuthorCache.Resolve(userGuid, _userManager.GetUserById);

        protected bool IsReviewVisibleToViewer(
            UserReview review,
            ReviewVisibilityContext ctx,
            string itemLabel,
            out Jellyfin.Database.Implementations.Entities.User? jellyfinUser)
        {
            // Rules live in ReviewVisibility (shared with native poster tags'
            // review chip); authors are resolved at most once per request.
            var visible = ReviewVisibility.IsVisible(
                review,
                ctx.ViewerIsAdmin,
                ctx.ViewerUserIdN,
                ctx.HideHiddenAuthors,
                ctx.HideDisabledAuthors,
                userGuid =>
                {
                    if (!ctx.Authors.TryGetValue(userGuid, out var author))
                    {
                        author = ResolveReviewAuthor(userGuid);
                        ctx.Authors[userGuid] = author;
                    }
                    return author;
                },
                out jellyfinUser,
                out var hiddenAsOrphan);
            if (hiddenAsOrphan)
            {
                _logger.Warning($"Hiding orphaned review for unknown userId={review.UserId} on {itemLabel} from non-admin viewer.");
            }
            return visible;
        }

        /// <summary>
        /// One pass over the review store: the rating sum and count per
        /// "mediaType:tmdbKey" over the reviews visible to the viewer described
        /// by <paramref name="ctx"/>, for the keys <paramref name="wanted"/>
        /// accepts. Only keys with at least one counted rating are yielded.
        /// Shared by <see cref="GetReviewRatings"/> and the tag-cache payload so
        /// a poster chip shows the same average whichever way it was resolved.
        /// </summary>
        protected IEnumerable<(string Key, double Sum, int Count)> AggregateVisibleReviewRatings(ReviewVisibilityContext ctx, Func<string, bool> wanted)
        {
            var store = _userConfigurationManager.GetAllReviews();
            var totals = new Dictionary<string, (double Sum, int Count)>(StringComparer.Ordinal);

            foreach (var kvp in store.Reviews)
            {
                // Store keys are "{userIdN}:{mediaType}:{tmdbKey}". A requested
                // key K matches exactly when the store key ends with ":" + K —
                // the same suffix test GetItemReviews applies — so probe the
                // tail after every ':' (a key holds at most a handful).
                var storeKey = kvp.Key;
                for (var i = storeKey.IndexOf(':'); i >= 0; i = storeKey.IndexOf(':', i + 1))
                {
                    var itemKey = storeKey.Substring(i + 1);
                    // A store key's item part always starts with its media type, so
                    // only a "movie:"/"tv:" tail can be an item key; the shorter tails
                    // ("1399:s1", "s1") are never one.
                    if (!itemKey.StartsWith("movie:", StringComparison.Ordinal) && !itemKey.StartsWith("tv:", StringComparison.Ordinal)) continue;
                    if (!wanted(itemKey)) continue;

                    // Same per-review isolation as GetItemReviews: a corrupt
                    // record or failing author lookup skips only this review.
                    var review = kvp.Value;
                    if (review == null)
                    {
                        _logger.Warning($"Skipping review key={storeKey}: empty record.");
                        continue;
                    }

                    try
                    {
                        if (!IsReviewVisibleToViewer(review, ctx, itemKey, out _)) continue;

                        // Mirror the client's historical `filter(r => r.rating)`: only
                        // a non-zero rating counts (NaN is excluded too).
                        var rating = review.Rating ?? 0;
                        if (double.IsNaN(rating) || Math.Abs(rating) <= 0) continue;

                        var acc = totals.TryGetValue(itemKey, out var existing) ? existing : (0d, 0);
                        totals[itemKey] = (acc.Item1 + rating, acc.Item2 + 1);
                    }
                    catch (Exception ex) when (ex is not OutOfMemoryException)
                    {
                        // Same per-review isolation as GetItemReviews: one unusable record
                        // (e.g. an author id the user manager rejects) skips only itself
                        // instead of failing every chip in the batch.
                        _logger.Warning($"Skipping review key={storeKey} due to filter error: {ex.Message}");
                    }
                }
            }

            foreach (var kvp in totals)
            {
                yield return (kvp.Key, kvp.Value.Sum, kvp.Value.Count);
            }
        }
    }
}
