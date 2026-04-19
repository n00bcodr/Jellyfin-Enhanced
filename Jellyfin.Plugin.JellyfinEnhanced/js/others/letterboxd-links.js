// /js/others/letterboxd-links.js
(function (JE) {
    'use strict';

    JE.initializeLetterboxdLinksScript = async function () {
        const logPrefix = '🪼 Jellyfin Enhanced: Letterboxd Links:';

        if (!JE?.pluginConfig?.LetterboxdEnabled) {
            console.log(`${logPrefix} Integration disabled in plugin settings.`);
            return;
        }

        console.log(`${logPrefix} Initializing...`);

        let isAddingLinks = false; // Lock to prevent concurrent runs
        let processedItemIds = new Set(); // Cache of items we've already processed
        let lastVisibleItemId = null; // Track the currently visible item

        const LETTERBOXD_ICON_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/letterboxd.svg';

        // Safe fallback for helpers.js Stage-3 load-order races.
        const extLink = JE.helpers?.createExternalLink || ((u, o) => {
            const a = document.createElement('a');
            a.setAttribute('is', 'emby-linkbutton');
            a.href = u;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            if (o?.text) a.textContent = o.text;
            if (o?.title) a.title = o.title;
            if (o?.className) a.className = o.className;
            return a;
        });

        const styleId = 'letterboxd-links-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .letterboxd-link-icon::before {
                    content: "";
                    display: inline-block;
                    width: 25px;
                    height: 25px;
                    background-image: url(${LETTERBOXD_ICON_URL});
                    background-size: contain;
                    background-repeat: no-repeat;
                    vertical-align: middle;
                    margin-right: 5px;
                }
            `;
            document.head.appendChild(style);
        }

        function getImdbId(context) {
            const links = context.querySelectorAll('.itemExternalLinks a, .externalIdLinks a');
            for (const link of links) {
                const href = link.href;
                if (href.includes('imdb.com/title/')) {
                    const match = href.match(/\/title\/(tt\d+)/);
                    if (match) {
                        return match[1];
                    }
                }
            }
            return null;
        }

        async function addLetterboxdLinks() {
            if (isAddingLinks) {
                return;
            }

            const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
            if (!visiblePage) return;

            const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            if (!itemId) return;

            // If we've already processed this item, skip it
            if (processedItemIds.has(itemId)) {
                return;
            }

            // If item changed, clear the processed set to allow reprocessing on new item
            if (lastVisibleItemId && lastVisibleItemId !== itemId) {
                processedItemIds.clear();
            }
            lastVisibleItemId = itemId;

            const anchorElement = visiblePage.querySelector('.itemExternalLinks');

            // Cleanup stale links from any non-visible pages to prevent future conflicts
            document.querySelectorAll('#itemDetailPage.hide .letterboxd-link').forEach(staleLink => {
                if (staleLink.previousSibling && staleLink.previousSibling.nodeType === Node.TEXT_NODE) {
                   staleLink.previousSibling.remove();
                }
                staleLink.remove();
            });

            if (!anchorElement || anchorElement.querySelector('.letterboxd-link')) {
                return;
            }

            isAddingLinks = true;
            try {
                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(itemId)
                    : await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
                if (!item?.Type) {
                    processedItemIds.add(itemId);
                    return;
                }

                if (!['Movie', 'Series'].includes(item.Type)) {
                    console.log(`${logPrefix} Skipping ${item.Type} - Letterboxd links not supported.`);
                    processedItemIds.add(itemId);
                    return;
                }

                const imdbId = getImdbId(visiblePage);
                if (!imdbId) {
                    console.log(`${logPrefix} No IMDb ID found for ${item.Type}.`);
                    processedItemIds.add(itemId);
                    return;
                }

                // Create Letterboxd link using IMDb ID
                const letterboxdUrl = `https://letterboxd.com/imdb/${imdbId}`;
                anchorElement.appendChild(document.createTextNode(' '));
                anchorElement.appendChild(createLinkButton("Letterboxd", letterboxdUrl, "letterboxd-link-icon"));
                processedItemIds.add(itemId);
            } catch (err) {
                console.error(`${logPrefix} Error adding Letterboxd link:`, err);
                processedItemIds.add(itemId);
            } finally {
                isAddingLinks = false;
            }
        }

        function createLinkButton(text, url, className) {
            const button = extLink(url, { title: text });
            if (JE.pluginConfig.ShowLetterboxdLinkAsText) {
                button.textContent = text;
                button.className = 'button-link emby-button letterboxd-link';
            } else {
                button.className = 'button-link emby-button letterboxd-link letterboxd-link-icon';
            }
            return button;
        }

        // Replace polling with MutationObserver for better performance
        let processingLetterboxd = false;
        const letterboxdObserver = JE.helpers.createObserver('letterboxd-links', () => {
            if (!JE?.pluginConfig?.LetterboxdEnabled) {
                letterboxdObserver.disconnect();
                console.log(`${logPrefix} Stopped - feature disabled`);
                return;
            }

            if (!processingLetterboxd) {
                processingLetterboxd = true;
                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(() => {
                        addLetterboxdLinks();
                        processingLetterboxd = false;
                    }, { timeout: 500 });
                } else {
                    setTimeout(() => {
                        addLetterboxdLinks();
                        processingLetterboxd = false;
                    }, 100);
                }
            }
        }, document.body, {
            childList: true,
            subtree: true,
            attributeFilter: ['class']
        });

        // Initial check
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => addLetterboxdLinks(), { timeout: 1000 });
        } else {
            setTimeout(addLetterboxdLinks, 500);
        }

        try {
            console.log(`${logPrefix} Letterboxd links integration initialized successfully.`);
        } catch (err) {
            console.error(`${logPrefix} Failed to initialize`, err);
        }
    };
})(window.JellyfinEnhanced);