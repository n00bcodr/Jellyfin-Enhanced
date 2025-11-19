// /js/letterboxd-links.js
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

        const LETTERBOXD_ICON_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/letterboxd.svg';

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
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                if (!itemId) return;

                const item = await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
                if (!item?.Type) return;

                const imdbId = getImdbId(visiblePage);
                if (!imdbId) {
                    console.log(`${logPrefix} No IMDb ID found for ${item.Type}, cannot create Letterboxd link.`);
                    return;
                }

                // Create Letterboxd link using IMDb ID
                const letterboxdUrl = `https://letterboxd.com/imdb/${imdbId}`;
                anchorElement.appendChild(document.createTextNode(' '));
                anchorElement.appendChild(createLinkButton("Letterboxd", letterboxdUrl, "letterboxd-link-icon"));
            } catch (err) {
                console.error(`${logPrefix} Error adding Letterboxd link:`, err);
            } finally {
                isAddingLinks = false;
            }
        }

        function createLinkButton(text, url, className) {
            const button = document.createElement('a');
            button.setAttribute('is', 'emby-linkbutton');
            if (JE.pluginConfig.ShowLetterboxdLinkAsText) {
                button.textContent = text;
                button.className = 'button-link emby-button letterboxd-link';
            } else {
                button.className = 'button-link emby-button letterboxd-link letterboxd-link-icon';
            }
            button.href = url;
            button.target = '_blank';
            button.rel = 'noopener noreferrer';
            button.title = text;
            return button;
        }

        setInterval(addLetterboxdLinks, 500);

        try {
            console.log(`${logPrefix} Letterboxd links integration initialized successfully.`);
        } catch (err) {
            console.error(`${logPrefix} Failed to initialize`, err);
        }
    };
})(window.JellyfinEnhanced);