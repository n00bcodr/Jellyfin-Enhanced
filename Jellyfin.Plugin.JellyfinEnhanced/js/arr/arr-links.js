// /js/arr/arr-links.js
(function (JE) {
    'use strict';

    JE.initializeArrLinksScript = async function () {
        const logPrefix = '🪼 Jellyfin Enhanced: Arr Links:';

        if (!JE?.pluginConfig?.ArrLinksEnabled) {
            console.log(`${logPrefix} Integration disabled in plugin settings.`);
            return;
        }

        // Check admin status with session storage cache
        const adminCacheKey = 'JE_IsAdmin';
        let isAdmin = sessionStorage.getItem(adminCacheKey);

        if (isAdmin === null) {
            // Not cached, fetch user and check
            try {
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

                isAdmin = user?.Policy?.IsAdministrator ? 'true' : 'false';
                sessionStorage.setItem(adminCacheKey, isAdmin);
            } catch (err) {
                console.error(`${logPrefix} Error checking admin status:`, err);
                return;
            }
        }

        if (isAdmin !== 'true') {
            console.log(`${logPrefix} User is not an administrator. Links will not be shown.`);
            return;
        }

        console.log(`${logPrefix} Initializing...`);

        let isAddingLinks = false; // Lock to prevent concurrent runs
        let debounceTimer = null;
        let observer = null;

        try {
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
                const ids = { tmdb: null, hasTmdbLink: false };
                const links = context.querySelectorAll('.itemExternalLinks a, .externalIdLinks a');
                links.forEach(link => {
                    const href = link.href;
                    if (href.includes('themoviedb.org/movie/')) {
                        ids.tmdb = href.match(/\/movie\/(\d+)/)?.[1];
                        ids.hasTmdbLink = true;
                    } else if (href.includes('themoviedb.org/tv/')) {
                        ids.tmdb = href.match(/\/tv\/(\d+)/)?.[1];
                        ids.hasTmdbLink = true;
                    }
                });
                return ids;
            }

            function slugify(text) {
                return text
                    .toString()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/&/g, 'and')
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

                    // Only process movies and TV shows
                    if (item?.Type !== 'Movie' && item?.Type !== 'Series') return;

                    const ids = getExternalIds(visiblePage);

                    // Only add ARR links if we find a themoviedb link
                    if (!ids.hasTmdbLink) {
                        return;
                    }

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

            observer = new MutationObserver(() => {
                if (!JE?.pluginConfig?.ArrLinksEnabled) {
                    // Feature disabled - disconnect observer
                    if (observer) {
                        observer.disconnect();
                        console.log(`${logPrefix} Observer disconnected - feature disabled`);
                    }
                    return;
                }

                // Debounce to avoid excessive processing on rapid DOM changes
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }

                debounceTimer = setTimeout(() => {
                    addArrLinks();
                }, 100); // Wait 100ms after last mutation before processing
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class']
            });

            // Store observer reference for potential cleanup
            JE._arrLinksObserver = observer;

            // Listen for configuration changes
            window.addEventListener('JE:configUpdated', () => {
                const isEnabled = JE?.pluginConfig?.ArrLinksEnabled;

                if (!isEnabled) {
                    // Disable: disconnect observer
                    if (observer) {
                        observer.disconnect();
                        console.log(`${logPrefix} Observer disconnected - feature disabled via config update`);
                    }
                }
            });

            console.log(`${logPrefix} Initialized successfully`);
        } catch (err) {
            console.error(`${logPrefix} Failed to initialize`, err);
        }
    };
})(window.JellyfinEnhanced);
