using System;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Which user reviews a viewer may see. Shared by the review endpoints
    /// (GET /reviews/{type}/{id}, GET /reviews/ratings) and native poster tags'
    /// review chip, so a list, a web chip and a baked chip can never disagree.
    /// </summary>
    internal static class ReviewVisibility
    {
        /// <summary>
        /// Decides whether <paramref name="review"/> is visible to the viewer and resolves its author (null
        /// when the id is unparseable or the user no longer exists). <paramref name="hiddenAsOrphan"/> is true
        /// when the review was hidden because its author no longer exists (callers log that). May throw on a
        /// corrupt record or a failing user lookup; callers isolate each review.
        /// </summary>
        internal static bool IsVisible(
            UserReview review,
            bool viewerIsAdmin,
            string? viewerUserIdN,
            bool hideHiddenAuthors,
            bool hideDisabledAuthors,
            Func<Guid, JUser?> resolveAuthor,
            out JUser? author,
            out bool hiddenAsOrphan)
        {
            author = null;
            hiddenAsOrphan = false;
            if (Guid.TryParseExact(review.UserId, "N", out var userGuid))
            {
                author = resolveAuthor(userGuid);
            }

            // The viewer's own review is ALWAYS visible to themselves,
            // regardless of admin status or hide filters. The hide
            // filters exist to let admins moderate OTHER users'
            // content, not to make a user's own writing invisible to
            // them. Skipping the filter for self also prevents the
            // confusing "I just posted, where did it go?" symptom
            // when the viewer's own account has IsHidden set.
            //
            // Require author != null on the self-bypass so an
            // orphaned-self record (auth token still resolves to a
            // deleted user — Jellyfin doesn't universally invalidate
            // tokens on user delete) still falls into the orphan
            // hide path below instead of being served back with a
            // raw-Guid display name.
            var isOwnReview = author != null
                && !string.IsNullOrEmpty(viewerUserIdN)
                && string.Equals(review.UserId, viewerUserIdN, StringComparison.OrdinalIgnoreCase);

            // Admin viewers always see every review so they can moderate.
            if (viewerIsAdmin || isOwnReview) return true;

            // Orphaned authors (Jellyfin user was deleted) are
            // hidden from non-admin viewers IF either hide toggle
            // is on — fail CLOSED. Otherwise a deleted problem
            // user's review would resurface for everyone. Admins
            // still see them so orphans can be cleaned up.
            if (author == null)
            {
                if (hideHiddenAuthors || hideDisabledAuthors)
                {
                    hiddenAsOrphan = true;
                    return false;
                }
                return true;
            }

            if (hideHiddenAuthors && author.HasPermission(PermissionKind.IsHidden))
                return false;
            if (hideDisabledAuthors && author.HasPermission(PermissionKind.IsDisabled))
                return false;
            return true;
        }
    }
}
