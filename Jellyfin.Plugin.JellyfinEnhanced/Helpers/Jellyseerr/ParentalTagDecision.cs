using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

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
    ///  - Matching is whole-token over values normalised like core's
    ///    <c>GetCleanValue()</c> (lower-case, diacritics stripped, punctuation to
    ///    spaces, whitespace collapsed), so "Sci-Fi" == "sci fi".
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
        /// Decides whether a title with the given cleaned keyword/genre sets is
        /// visible under the user's cleaned blocked/allowed tag lists. Set overlap
        /// only; all inputs must already be cleaned via <see cref="CleanTags"/>.
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
        /// Normalises a raw tag list the way core normalises both sides of its tag
        /// comparison, dropping entries that clean to empty.
        /// </summary>
        public static HashSet<string> CleanTags(IEnumerable<string?>? raw)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            if (raw == null)
            {
                return result;
            }

            foreach (var value in raw)
            {
                var cleaned = CleanValue(value);
                if (!string.IsNullOrEmpty(cleaned))
                {
                    result.Add(cleaned);
                }
            }

            return result;
        }

        /// <summary>
        /// Mirrors Jellyfin's <c>String.GetCleanValue()</c>: lower-case, strip
        /// diacritics, replace anything that is not a letter or digit with a space,
        /// collapse runs of whitespace, trim.
        /// </summary>
        public static string CleanValue(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }

            var decomposed = value.Normalize(NormalizationForm.FormD);
            var sb = new StringBuilder(decomposed.Length);
            var lastWasSpace = true;
            foreach (var ch in decomposed)
            {
                var category = CharUnicodeInfo.GetUnicodeCategory(ch);
                if (category == UnicodeCategory.NonSpacingMark)
                {
                    continue; // diacritic
                }

                if (char.IsLetterOrDigit(ch))
                {
                    sb.Append(char.ToLowerInvariant(ch));
                    lastWasSpace = false;
                }
                else if (!lastWasSpace)
                {
                    sb.Append(' ');
                    lastWasSpace = true;
                }
            }

            return sb.ToString().Trim();
        }
    }
}
