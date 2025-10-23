// /js/watchlist/watchlist.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Watchlist:';

    JE.initializeWatchlistScript = function() {
        if (!JE.pluginConfig.WatchlistEnabled) {
            console.log(`${logPrefix} Watchlist feature is disabled in plugin settings.`);
            return;
        }

        const styleId = 'watchlist-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .watchlist-button[data-active="true"] .material-icons,
                .watchlist-icon[data-active="true"] .material-icons {
                    font-family: 'Material Icons';
                }
                .watchlist-icon[data-active='true'] .detailButton-icon:before {
                    font-variation-settings: 'FILL' 1,'wght' 400,'GRAD' 0,'opsz' 20;
                }
            `;
            document.head.appendChild(style);
        }

        console.log(`${logPrefix} Initializing...`);

        async function fetchLikedItems(type) {
            const apiClient = window.ApiClient;
            const userId = apiClient.getCurrentUserId();
            const serverUrl = apiClient.serverAddress();
            const token = apiClient.accessToken();

            const url = `${serverUrl}/Items?Filters=Likes&IncludeItemTypes=${type}&UserId=${userId}&Recursive=true`;

            try {
                const res = await fetch(url, { headers: { "Authorization": `MediaBrowser Token=\"${token}\"` } });
                const data = await res.json();
                return data.Items || [];
            } catch (err) {
                console.error(`${logPrefix} Failed to fetch liked items for type:`, type, err);
                return [];
            }
        }

        async function renderCards(containerSelector, type) {
            const container = document.querySelector(containerSelector);
            if (!container) {
                console.warn(`${logPrefix} Container not found:`, containerSelector);
                return { type, itemCount: 0 };
            }
            const items = await fetchLikedItems(type);

            if (!items || items.length === 0) {
                container.style.display = 'none';
                return { type, itemCount: 0 };
            }

            container.style.display = '';
            if (typeof JE.cardBuilder !== 'undefined' && JE.cardBuilder.renderCards) {
                const scrollableContainer = JE.cardBuilder.renderCards(items, getTypeDisplayName(type));
                container.innerHTML = '';
                container.appendChild(scrollableContainer);
            } else {
                console.error("cardBuilder is not available");
            }
            return { type, itemCount: items.length };
        }

        function getTypeDisplayName(itemType) {
            const typeMap = {
                'Movie': 'Movies',
                'Series': 'TV Shows',
                'Episode': 'Episodes',
                'Person': 'People',
                'MusicAlbum': 'Albums',
                'Audio': 'Songs',
                'Artist': 'Artists',
                'Playlist': 'Playlists',
                'Book': 'Books',
                'AudioBook': 'Audiobooks',
                'Photo': 'Photos',
                'PhotoAlbum': 'Photo Albums',
                'TvChannel': 'TV Channels',
                'LiveTvProgram': 'Live TV',
                'BoxSet': 'Collections'
            };
            return typeMap[itemType] || itemType;
        }

        async function renderWatchlistContent() {
            try {
                const results = await Promise.all([
                    renderCards(".sections.watchlist > .watchlist-movies", "Movie"),
                    renderCards(".sections.watchlist > .watchlist-series", "Series"),
                    renderCards(".sections.watchlist > .watchlist-episodes", "Episode")
                ]);

                const totalItems = results.reduce((sum, result) => sum + result.itemCount, 0);

                if (totalItems === 0) {
                    showEmptyWatchlistMessage();
                } else {
                    hideEmptyWatchlistMessage();
                }
            } catch (err) {
                console.error(`${logPrefix} Error rendering watchlist cards:`, err);
            }
        }

        function checkAndRenderWatchlist() {
            const watchlistSection = document.querySelector('.sections.watchlist');
            if (watchlistSection && !watchlistSection.dataset.watchlistRendered) {
                watchlistSection.dataset.watchlistRendered = 'true';
                renderWatchlistContent();
            }
        }

        function setupWatchlistSectionObserver() {
            checkAndRenderWatchlist();

            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                if (node.classList && node.classList.contains('sections') && node.classList.contains('watchlist')) {
                                    checkAndRenderWatchlist();
                                }

                                const watchlistSection = node.querySelector && node.querySelector('.sections.watchlist');
                                if (watchlistSection) {
                                    checkAndRenderWatchlist();
                                }
                            }
                        });
                    }
                });
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        setupWatchlistSectionObserver();

        function showEmptyWatchlistMessage() {
            let emptyMessage = document.querySelector('.watchlist-empty-message');
            if (emptyMessage) {
                emptyMessage.style.display = 'block';
                return;
            }

            emptyMessage = document.createElement('div');
            emptyMessage.className = 'watchlist-empty-message';
            emptyMessage.style.cssText = `
                text-align: center;
                padding: 40px 20px;
                color: #999;
                font-size: 16px;
                line-height: 1.5;
            `;

            emptyMessage.innerHTML = `
                <div style="margin-bottom: 20px;">
                    <span class="material-icons" style="font-size: 48px; color: #666;">bookmark_border</span>
                </div>
                <h3 style="color: #fff; margin-bottom: 16px; font-size: 20px;">Your Watchlist is Empty</h3>
                <p style="margin: 0; max-width: 400px; margin-left: auto; margin-right: auto;">
                    Press the <span class="material-icons" style="font-size: 18px; vertical-align: middle; color: #00a4dc;">bookmark_border</span>
                    button to add an item to your Watchlist
                </p>
            `;

            const watchlistContainer = document.querySelector('.sections.watchlist');
            if (watchlistContainer) {
                watchlistContainer.appendChild(emptyMessage);
            } else {
                document.body.appendChild(emptyMessage);
            }
        }

        function hideEmptyWatchlistMessage() {
            const emptyMessage = document.querySelector('.watchlist-empty-message');
            if (emptyMessage) {
                emptyMessage.style.display = 'none';
            }
        }

        function addWatchlistButton(overlayContainer) {
            if (overlayContainer && overlayContainer.querySelector('.watchlist-button')) {
                return;
            }

            const card = overlayContainer.closest('.card');
            if (!card) {
                console.warn(`${logPrefix} Could not find card parent for overlay container`);
                return;
            }
            const itemType = card.getAttribute('data-type');
            if (!['Movie', 'Series', 'Episode'].includes(itemType)) {
                return;
            }
            const itemId = card.getAttribute('data-id');
            if (!itemId) {
                console.warn(`${logPrefix} Could not find data-id on card element`);
                return;
            }

            const buttonContainer = overlayContainer.querySelector('.cardOverlayButton-br');
            if (!buttonContainer) {
                console.warn(`${logPrefix} Could not find .cardOverlayButton-br container`);
                return;
            }

            const watchlistButton = document.createElement('button');
            watchlistButton.type = 'button';
            watchlistButton.className = 'watchlist-button cardOverlayButton cardOverlayButton-hover itemAction paper-icon-button-light emby-button';
            watchlistButton.setAttribute('data-action', 'none');
            watchlistButton.setAttribute('data-id', itemId);
            watchlistButton.setAttribute('data-active', 'false');
            watchlistButton.title = 'Add to Watchlist';

            const watchlistIcon = document.createElement('span');
            watchlistIcon.className = 'material-icons cardOverlayButtonIcon cardOverlayButtonIcon-hover';
            watchlistIcon.textContent = 'bookmark_border';
            watchlistIcon.setAttribute('aria-hidden', 'true');

            watchlistButton.appendChild(watchlistIcon);

            watchlistButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const newRating = watchlistButton.dataset.active === 'false' ? 'true' : 'false';
                ApiClient.updateUserItemRating(ApiClient.getCurrentUserId(), itemId, newRating)
                    .then(() => {
                        if (document.querySelector('.sections.watchlist')) {
                            renderWatchlistContent();
                        }
                    });

                watchlistButton.dataset.active = newRating;
                const isActive = watchlistButton.dataset.active === 'true';
                watchlistIcon.textContent = isActive ? 'bookmark' : 'bookmark_border';
                watchlistButton.title = isActive ? 'Remove from Watchlist' : 'Add to Watchlist';
            });

            ApiClient.getItem(ApiClient.getCurrentUserId(), itemId).then((item) => {
                if (item.UserData && item.UserData.Likes) {
                    watchlistButton.dataset.active = 'true';
                    watchlistIcon.textContent = 'bookmark';
                    watchlistButton.title = 'Remove from Watchlist';
                }
            }).catch(err => {
                console.error(`${logPrefix} Error fetching item data for watchlist button:`, err);
            });

            buttonContainer.appendChild(watchlistButton);
        }

        function processExistingOverlayContainers() {
            const overlayContainers = document.querySelectorAll('.cardOverlayContainer');

            overlayContainers.forEach((overlayContainer) => {
                const buttonContainer = overlayContainer.querySelector('.cardOverlayButton-br');
                if (buttonContainer) {
                    addWatchlistButton(overlayContainer);
                }
            });
        }

        function setupWatchlistButtonObserver() {
            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                if (node.classList && node.classList.contains('cardOverlayContainer')) {
                                    const buttonContainer = node.querySelector('.cardOverlayButton-br');
                                    if (buttonContainer) {
                                        addWatchlistButton(node);
                                    }
                                }

                                const overlayContainers = node.querySelectorAll && node.querySelectorAll('.cardOverlayContainer');
                                if (overlayContainers && overlayContainers.length > 0) {
                                    overlayContainers.forEach((overlayContainer) => {
                                        const buttonContainer = overlayContainer.querySelector('.cardOverlayButton-br');
                                        if (buttonContainer) {
                                            addWatchlistButton(overlayContainer);
                                        }
                                    });
                                }
                            }
                        });
                    }
                });
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            processExistingOverlayContainers();
        }

        setupWatchlistButtonObserver();

        function addDetailPageWatchlistButton() {
            const buttonContainer = document.querySelector('.itemDetailPage:not(.hide) .mainDetailButtons');
            if (!buttonContainer || buttonContainer.querySelector('.watchlist-icon')) {
                return;
            }

            const watchlistButton = document.createElement('button');
            watchlistButton.setAttribute("is", "emby-button");
            watchlistButton.className = 'button-flat watchlist-icon detailButton emby-button';
            watchlistButton.title = "Add to Watchlist";
            watchlistButton.dataset.active = 'false';
            watchlistButton.style.visibility = 'hidden'; // Hide until we confirm it's needed

            const iconSpan = document.createElement('span');
            iconSpan.className = 'material-icons detailButton-icon';
            iconSpan.textContent = 'bookmark_border';
            watchlistButton.appendChild(iconSpan);

            const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            if (!itemId) return;

            watchlistButton.addEventListener('click', () => {
                const newRating = watchlistButton.dataset.active === 'false' ? 'true' : 'false';
                ApiClient.updateUserItemRating(ApiClient.getCurrentUserId(), itemId, newRating)
                    .then(() => {
                        if (document.querySelector('.sections.watchlist')) {
                            renderWatchlistContent();
                        }
                    });

                watchlistButton.dataset.active = newRating;
                const isActive = watchlistButton.dataset.active === 'true';
                iconSpan.textContent = isActive ? 'bookmark' : 'bookmark_border';
                watchlistButton.title = isActive ? 'Remove from Watchlist' : 'Add to Watchlist';
            });

            ApiClient.getItem(ApiClient.getCurrentUserId(), itemId).then((item) => {
                if (!['Movie', 'Series', 'Season', 'Episode'].includes(item.Type)) {
                    watchlistButton.remove(); // Not a valid type, so remove the button
                    return;
                }

                if (item.UserData && item.UserData.Likes) {
                    watchlistButton.dataset.active = 'true';
                    iconSpan.textContent = 'bookmark';
                    watchlistButton.title = 'Remove from Watchlist';
                }
                watchlistButton.style.visibility = 'visible'; // Make button visible
            }).catch(err => {
                console.error(`${logPrefix} Error fetching item data for detail page button:`, err);
                watchlistButton.remove();
            });

            const playButton = buttonContainer.querySelector('.btnPlay');
            if (playButton) {
                playButton.parentElement.insertBefore(watchlistButton, playButton.nextSibling);
            } else {
                buttonContainer.appendChild(watchlistButton);
            }
        }

        function monitorItemDetailPage() {
            const observer = new MutationObserver(() => {
                const visibleItemDetailPage = document.querySelector('.itemDetailPage:not(.hide)');
                if (!visibleItemDetailPage) {
                    return;
                }

                const existingButton = document.querySelector('.itemDetailPage:not(.hide) .watchlist-icon');
                if (existingButton) {
                    return;
                }

                addDetailPageWatchlistButton();
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class']
            });
        }

        monitorItemDetailPage();
    };
})(window.JellyfinEnhanced);