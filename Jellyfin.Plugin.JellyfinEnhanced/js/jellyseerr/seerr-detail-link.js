// /js/jellyseerr/seerr-detail-link.js
(function (JE) {
    'use strict';

    JE.initializeSeerrDetailLinkScript = function () {
        const logPrefix = '🪼 Jellyfin Enhanced: Seerr Detail Link:';

        if (!JE?.pluginConfig?.JellyseerrEnabled || !JE?.pluginConfig?.JellyseerrShowDetailPageLink) {
            console.log(`${logPrefix} Disabled in plugin settings.`);
            return;
        }

        console.log(`${logPrefix} Initializing...`);

        let isAddingLink = false;
        let debounceTimer = null;
        let observer = null;

        const SEERR_ICON_URL = JE.cdn.selfhst('svg/seerr.svg');

        const styleId = 'seerr-detail-link-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .seerr-link-img {
                    width: 25px;
                    height: 25px;
                    display: block;
                    object-fit: contain;
                }
            `;
            document.head.appendChild(style);
        }

        // Same TMDB-id sniffing arr-links.js uses — reads the themoviedb.org external link
        // Jellyfin already renders on the detail page, rather than round-tripping our own lookup.
        function getTmdbId(context) {
            const links = context.querySelectorAll('.itemExternalLinks a, .externalIdLinks a');
            for (const link of links) {
                const href = link.href;
                if (href.includes('themoviedb.org/movie/')) return href.match(/\/movie\/(\d+)/)?.[1] || null;
                if (href.includes('themoviedb.org/tv/')) return href.match(/\/tv\/(\d+)/)?.[1] || null;
            }
            return null;
        }

        function createSeerrLink(tmdbId, mediaType) {
            const useMoreInfoModal = !!JE.pluginConfig.JellyseerrUseMoreInfoModal;
            const base = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl() || '';
            const jellyseerrUrl = base ? `${base}/${mediaType}/${tmdbId}` : null;

            const button = document.createElement('a');
            button.setAttribute('is', 'emby-linkbutton');
            button.className = 'button-link emby-button seerr-link';

            if (JE.pluginConfig.JellyseerrShowDetailPageLinkAsText) {
                button.textContent = 'Seerr';
            } else {
                const img = document.createElement('img');
                img.src = SEERR_ICON_URL;
                img.alt = 'Seerr';
                img.className = 'seerr-link-img';
                button.appendChild(img);
            }

            if (useMoreInfoModal) {
                // Open the more-info modal (status chips, requested-by, request actions) —
                // it already renders its own "View on Seerr" link for anyone who wants to jump
                // straight to the real Jellyseerr page from there.
                button.href = '#';
                button.title = JE.t('jellyseerr_card_view_on_jellyseerr') || 'View on Seerr';
                button.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (typeof JE.jellyseerrMoreInfo?.open === 'function') {
                        JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
                    } else {
                        console.warn(`${logPrefix} more-info modal not available`);
                    }
                });
            } else if (jellyseerrUrl) {
                // More Info modal disabled — link straight to the item on Seerr, same as the
                // search-result cards do when JellyseerrUseMoreInfoModal is off.
                button.href = jellyseerrUrl;
                button.target = '_blank';
                button.rel = 'noopener noreferrer';
                button.title = JE.t('jellyseerr_card_view_on_jellyseerr') || 'View on Seerr';
            } else {
                // No Seerr base URL resolved (not configured / not authenticated) — nothing to
                // link to and no modal to fall back on.
                return null;
            }

            return button;
        }

        async function addSeerrLink() {
            if (isAddingLink) return;

            const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
            if (!visiblePage) return;

            const anchorElement = visiblePage.querySelector('.itemExternalLinks');

            // Cleanup stale links from any non-visible pages, mirroring arr-links.js.
            document.querySelectorAll('#itemDetailPage.hide .seerr-link').forEach(staleLink => {
                if (staleLink.previousSibling && staleLink.previousSibling.nodeType === Node.TEXT_NODE) {
                    staleLink.previousSibling.remove();
                }
                staleLink.remove();
            });

            if (!anchorElement || anchorElement.querySelector('.seerr-link')) {
                return;
            }

            const hashAtStart = window.location.hash;
            const isStillValidTarget = () =>
                document.contains(anchorElement)
                && !anchorElement.closest('#itemDetailPage.hide')
                && window.location.hash === hashAtStart;

            isAddingLink = true;
            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                if (!itemId) return;

                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(itemId)
                    : await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);

                if (!isStillValidTarget()) return;
                if (item?.Type !== 'Movie' && item?.Type !== 'Series') return;

                const tmdbId = getTmdbId(visiblePage);
                if (!tmdbId) return;

                const mediaType = item.Type === 'Movie' ? 'movie' : 'tv';

                const link = createSeerrLink(tmdbId, mediaType);
                if (!link) return;

                anchorElement.appendChild(document.createTextNode(' '));
                anchorElement.appendChild(link);
            } finally {
                isAddingLink = false;
            }
        }

        observer = JE.helpers.createObserver('seerr-detail-link', () => {
            if (!JE?.pluginConfig?.JellyseerrEnabled || !JE?.pluginConfig?.JellyseerrShowDetailPageLink) {
                if (observer) {
                    observer.disconnect();
                    console.log(`${logPrefix} Observer disconnected — feature disabled`);
                }
                return;
            }

            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
                addSeerrLink();
            }, 100);
        }, document.body, {
            childList: true,
            subtree: true,
        });

        console.log(`${logPrefix} Initialized successfully`);
    };
})(window.JellyfinEnhanced);
