// /js/arr-links.js
(function (JE) {
    'use strict';

    JE.initializeArrLinksScript = async function () {
        const logPrefix = '🪼 Jellyfin Enhanced: Arr Links:';

        if (!JE?.pluginConfig?.ArrLinksEnabled) {
            console.log(`${logPrefix} Integration disabled in plugin settings.`);
            return;
        }

        try {
            // --- Wait for user to be available ---
            let user = null;
            for (let i = 0; i < 20; i++) {  // ~10s retry window
                try {
                    user = await ApiClient.getCurrentUser();
                    if (user) break;
                } catch (e) {
                    // swallow error, retry
                }
                await new Promise(r => setTimeout(r, 500));
            }

            if (!user) {
                console.error(`${logPrefix} Could not get current user after retries.`);
                return;
            }

            if (!user?.Policy?.IsAdministrator) {
                console.log(`${logPrefix} User is not an administrator. Links will not be shown.`);
                return;
            }

            console.log(`${logPrefix} Initializing...`);

            let isAddingLinks = false; // Lock to prevent concurrent runs

            const SONARR_ICON_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/sonarr.svg';
            const RADARR_ICON_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/radarr-light-hybrid-light.svg';
            const BAZARR_ICON_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/bazarr.svg';

            const styleId = 'arr-links-styles';
            if (!document.getElementById(styleId)) {
                const style = document.createElement('style');
                style.id = styleId;
                style.textContent = `
                    .arr-link-sonarr::before,
                    .arr-link-radarr::before,
                    .arr-link-bazarr::before {
                        content: "";
                        display: inline-block;
                        width: 25px;
                        height: 25px;
                        background-size: contain;
                        background-repeat: no-repeat;
                        vertical-align: middle;
                        margin-right: 5px;
                    }
                    .arr-link-sonarr::before { background-image: url(${SONARR_ICON_URL}); }
                    .arr-link-radarr::before { background-image: url(${RADARR_ICON_URL}); }
                    .arr-link-bazarr::before { background-image: url(${BAZARR_ICON_URL}); }
                `;
                document.head.appendChild(style);
            }

            function getExternalIds(context) {
                const ids = { tmdb: null};
                const links = context.querySelectorAll('.itemExternalLinks a, .externalIdLinks a');
                links.forEach(link => {
                    const href = link.href;
                    if (href.includes('themoviedb.org/movie/')) {
                        ids.tmdb = href.match(/\/movie\/(\d+)/)?.[1];
                    } else if (href.includes('themoviedb.org/tv/')) {
                        ids.tmdb = href.match(/\/tv\/(\d+)/)?.[1];
                    }
                });
                return ids;
            }

            function slugify(text) {
                return text
                    .toString()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .trim()
                    .replace(/\s+/g, '-')
                    .replace(/[^\w-]+/g, '')
                    .replace(/--+/g, '-');
            }

            async function addArrLinks() {
                if (isAddingLinks) {
                    return;
                }

                const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
                if (!visiblePage) return;

                const anchorElement = visiblePage.querySelector('.itemExternalLinks');

                // Cleanup stale links from any non-visible pages to prevent future conflicts
                document.querySelectorAll('#itemDetailPage.hide .arr-link').forEach(staleLink => {
                    if (staleLink.previousSibling && staleLink.previousSibling.nodeType === Node.TEXT_NODE) {
                       staleLink.previousSibling.remove();
                    }
                    staleLink.remove();
                });

                if (!anchorElement || anchorElement.querySelector('.arr-link')) {
                    return;
                }

                isAddingLinks = true;
                try {
                    const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                    if (!itemId) return;

                    const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
                    if (!item?.Type) return;

                    const ids = getExternalIds(visiblePage);

                    if (item.Type === 'Series' && item.Name && JE.pluginConfig.SonarrUrl) {
                        const seriesSlug = slugify(item.Name);
                        const url = `${JE.pluginConfig.SonarrUrl}/series/${seriesSlug}`;
                        anchorElement.appendChild(document.createTextNode(' '));
                        anchorElement.appendChild(createLinkButton("Sonarr", url, "arr-link-sonarr"));
                    }

                    if (item.Type === 'Movie' && ids.tmdb && JE.pluginConfig.RadarrUrl) {
                        const url = `${JE.pluginConfig.RadarrUrl}/movie/${ids.tmdb}`;
                        anchorElement.appendChild(document.createTextNode(' '));
                        anchorElement.appendChild(createLinkButton("Radarr", url, "arr-link-radarr"));
                    }

                    if ((item.Type === 'Series' || item.Type === 'Movie') && JE.pluginConfig.BazarrUrl) {
                        const path = item.Type === 'Series' ? 'series' : 'movies';
                        const url = `${JE.pluginConfig.BazarrUrl}/${path}/`;
                        anchorElement.appendChild(document.createTextNode(' '));
                        anchorElement.appendChild(createLinkButton("Bazarr", url, "arr-link-bazarr"));
                    }
                } finally {
                    isAddingLinks = false;
                }
            }

            function createLinkButton(text, url, iconClass) {
                const button = document.createElement('a');
                button.setAttribute('is', 'emby-linkbutton');
                if (JE.pluginConfig.ShowArrLinksAsText) {
                    button.textContent = text;
                    button.className = 'button-link emby-button arr-link';
                } else {
                    button.className = `button-link emby-button arr-link ${iconClass}`;
                }
                button.href = url;
                button.target = '_blank';
                button.rel = 'noopener noreferrer';
                button.title = text;
                return button;
            }

            setInterval(addArrLinks, 500);

        } catch (err) {
            console.error(`${logPrefix} Failed to initialize`, err);
        }
    };
})(window.JellyfinEnhanced);