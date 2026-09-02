namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr
{
    /// <summary>
    /// Pure, side-effect-free port of the rating branches of Jellyfin's parental
    /// control decision (<c>MediaBrowser.Controller.Entities.BaseItem.IsParentalAllowed</c>),
    /// used to decide whether a Seerr/TMDB search or discovery result may be shown
    /// to a given Jellyfin user:
    ///  - no usable rating -> allowed unless the user blocks unrated items of this type;
    ///  - the user has no rating limit -> allowed;
    ///  - otherwise the item's (score, subScore) must be &lt;= the user's
    ///    (maxScore, maxSubScore), compared lexicographically.
    ///
    /// Adapted from Jellyfin-Canopy (GPL-3.0), Helpers/Seerr/ParentalRatingDecision.cs.
    /// </summary>
    public static class ParentalRatingDecision
    {
        /// <summary>
        /// Decides whether an item is allowed for a user under their parental limit.
        /// </summary>
        /// <param name="itemScore">
        /// The item's resolved parental score, or <c>null</c> when the item is unrated
        /// or its rating string could not be recognized (mirrors the <c>null</c>
        /// return of <c>ILocalizationManager.GetRatingScore</c>).
        /// </param>
        /// <param name="itemSubScore">The item's sub-score; <c>null</c> is treated as 0.</param>
        /// <param name="blockUnratedForType">
        /// Whether the user's BlockUnratedItems policy covers this item's type
        /// (Movie for movies, Series for TV). Used only when the item has no usable rating.
        /// </param>
        /// <param name="maxScore">The user's MaxParentalRatingScore; <c>null</c> means no limit.</param>
        /// <param name="maxSubScore">
        /// The user's MaxParentalRatingSubScore; <c>null</c> means unbounded at the
        /// matching score level.
        /// </param>
        /// <returns><c>true</c> when the item should be shown; <c>false</c> to hide it.</returns>
        public static bool IsAllowed(int? itemScore, int? itemSubScore, bool blockUnratedForType, int? maxScore, int? maxSubScore)
        {
            // No usable rating -> allow unless the user blocks unrated items of this type.
            if (itemScore is null)
            {
                return !blockUnratedForType;
            }

            // The user has no configured rating limit -> allow.
            if (maxScore is null)
            {
                return true;
            }

            // Compare (score, subScore) lexicographically against the user's max.
            if (itemScore.Value != maxScore.Value)
            {
                return itemScore.Value < maxScore.Value;
            }

            return maxSubScore is null || (itemSubScore ?? 0) <= maxSubScore.Value;
        }
    }
}
