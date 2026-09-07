using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// Port of the TAG branch of Jellyfin's <c>BaseItem.IsParentalAllowed</c>
    /// (<c>IsVisibleViaTags</c>), adapted for external TMDB titles. Companion to
    /// <see cref="ParentalRatingDecision"/>.
    ///
    /// Core semantics preserved:
    ///  - BlockedTags always wins: one overlap hides the item even if an allowed
    ///    tag also matches.
    ///  - AllowedTags (when non-empty) is a strict allow-list: the item must carry
    ///    at least one allowed tag or it is hidden.
    ///  - Both lists empty: no gating.
    ///  - Matching is whole-value and case-insensitive-ordinal on the RAW strings,
    ///    exactly as core compares its tags (<c>StringComparer.OrdinalIgnoreCase</c>,
    ///    no cleaning). Normalising punctuation/diacritics here would widen the
    ///    allow-list beyond what the library accepts, e.g. an allowed tag
    ///    "family!" must not be satisfied by the plain keyword "family".
    ///
    /// Adaptation for external titles: the two directions use different match
    /// surfaces because their safe-failure directions are opposite.
    ///  - BlockedTags match the title's TMDB keywords ∪ genre names. Keywords are
    ///    the parity signal (Jellyfin's TMDB provider imports TMDB keywords as the
    ///    item Tags native blocking matches); genres are an intent extension
    ///    (blocking "horror" should block the genre too). Over-blocking is safe.
    ///  - AllowedTags match keywords ONLY. Genres never become item Tags, so a
    ///    genre satisfying the allow-list would show a restricted user titles the
    ///    library itself would hide.
    ///
    /// Adapted from Jellyfin-Canopy (GPL-3.0), Helpers/Seerr/ParentalTagDecision.cs.
    /// </summary>
    public static class ParentalTagDecision
    {
        /// <summary>
        /// Decides whether a title with the given keyword/genre sets is visible
        /// under the user's blocked/allowed tag lists. Set overlap only; every set
        /// must have been built by <see cref="ToTagSet"/> so the comparison is the
        /// case-insensitive ordinal one core uses.
        /// </summary>
        public static bool IsAllowed(
            IReadOnlyCollection<string> titleKeywords,
            IReadOnlyCollection<string> titleGenres,
            IReadOnlyCollection<string> blockedTags,
            IReadOnlyCollection<string> allowedTags)
        {
            if (blockedTags.Count == 0 && allowedTags.Count == 0)
            {
                return true;
            }

            if (blockedTags.Count > 0
                && (titleKeywords.Any(blockedTags.Contains) || titleGenres.Any(blockedTags.Contains)))
            {
                return false; // blocked wins, even over an allowed match
            }

            if (allowedTags.Count > 0 && !titleKeywords.Any(allowedTags.Contains))
            {
                return false; // allow-list active and nothing matched
            }

            return true;
        }

        /// <summary>
        /// Builds a comparison set from raw tag/keyword/genre names: values are kept
        /// verbatim (only trimmed) and compared case-insensitive-ordinal, which is
        /// exactly how core matches tags. Null/blank entries are dropped as they
        /// could never match anything.
        /// </summary>
        public static HashSet<string> ToTagSet(IEnumerable<string?>? raw)
        {
            var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (raw == null)
            {
                return result;
            }

            foreach (var value in raw)
            {
                if (!string.IsNullOrWhiteSpace(value))
                {
                    result.Add(value.Trim());
                }
            }

            return result;
        }
    }
}
