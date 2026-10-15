/**
 * Home Screen Sections (HSS) Discovery Handler
 * Intercepts discover card clicks and opens the Jellyseerr more-info modal
 * instead of navigating to the Jellyseerr website
 */

(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: HSS Discovery Handler:';

    function initDiscoveryHandler() {

        document.addEventListener('click', function(e) {
            // Don't intercept if clicking the request button
            if (e.target.closest('.discover-requestbutton')) {
                return;
            }

            // Target any click on the discover card (except the request button)
            const discoverCard = e.target.closest('.discover-card');

            if (!discoverCard) {
                return;
            }

            const tmdbId = discoverCard.dataset.tmdbId;
            const mediaType = discoverCard.dataset.mediaType;

            // Native details (when offered) or the more-info modal; without either the card keeps its own link.
            const nativeOn = JE?.titleDetails?.available?.() === true;
            if (!tmdbId || !mediaType || (!nativeOn && !JE?.jellyseerrMoreInfo?.open)) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            if (JE.titleDetails?.show) {
                JE.titleDetails.show(tmdbId, mediaType);
            } else {
                JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
            }
        }, true);
    }

    initDiscoveryHandler();

})(window.JellyfinEnhanced);
