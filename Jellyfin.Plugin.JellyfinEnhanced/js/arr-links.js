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

            function getExternalIds() {
                const ids = { tmdb: null};
                const links = document.querySelectorAll('.itemExternalLinks a, .externalIdLinks a');
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
                // If the function is already running, exit to prevent duplicates.
                if (isAddingLinks) {
                    return;
                }

                const anchorElement = document.querySelector('.itemExternalLinks');
                // Also exit if links are already present or the anchor isn't found.
                if (!anchorElement || anchorElement.querySelector('.arr-link')) {
                    return;
                }

                isAddingLinks = true; // Set the lock
                try {
                    // Re-check for links after acquiring the lock to be extra safe.
                    if (document.querySelector('.itemExternalLinks .arr-link')) {
                        return;
                    }

                    const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                    if (!itemId) return;

                    const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
                    if (!item?.Type) return;

                    const ids = getExternalIds();

                    if (item.Type === 'Series' && item.Name && JE.pluginConfig.SonarrUrl) {
                        const seriesSlug = slugify(item.Name);
                        const url = `${JE.pluginConfig.SonarrUrl}/series/${seriesSlug}`;
                        const sonarrButton = createLinkButton("Sonarr", url, "arr-link-sonarr");
                        anchorElement.appendChild(document.createTextNode(', '));
                        anchorElement.appendChild(sonarrButton);
                    }

                    if (item.Type === 'Movie' && ids.tmdb && JE.pluginConfig.RadarrUrl) {
                        const url = `${JE.pluginConfig.RadarrUrl}/movie/${ids.tmdb}`;
                        const radarrButton = createLinkButton("Radarr", url, "arr-link-radarr");
                        anchorElement.appendChild(document.createTextNode(', '));
                        anchorElement.appendChild(radarrButton);
                    }

                    if ((item.Type === 'Series' || item.Type === 'Movie') && JE.pluginConfig.BazarrUrl) {
                        const path = item.Type === 'Series' ? 'series' : 'movies';
                        const url = `${JE.pluginConfig.BazarrUrl}/${path}/`;
                        const bazarrButton = createLinkButton("Bazarr", url, "arr-link-bazarr");
                        anchorElement.appendChild(document.createTextNode(', '));
                        anchorElement.appendChild(bazarrButton);
                    }
                } finally {
                    isAddingLinks = false; // Release the lock, even if an error occurs.
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

            let debounceTimer = null;
            function debouncedRun() {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(addArrLinks, 750);
            }

            const observer = new MutationObserver(debouncedRun);
            observer.observe(document.body, { childList: true, subtree: true });

            debouncedRun();

        } catch (err) {
            console.error(`${logPrefix} Failed to initialize`, err);
            setTimeout(() => JE.initializeArrLinksScript(), 1000); // retry after 1s
        }
    };
})(window.JellyfinEnhanced);