// /js/watchlist.js
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
            const sectionHtml = createWatchlistSection(type, items);
            container.innerHTML = sectionHtml;
            return { type, itemCount: items.length };
        }

        function createWatchlistSection(type, items) {
            const verticalSection = document.createElement('div');
            verticalSection.className = 'verticalSection emby-scroller-container';

            const sectionTitle = document.createElement('h2');
            sectionTitle.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
            sectionTitle.textContent = getTypeDisplayName(type);

            const scrollButtons = document.createElement('div');
            scrollButtons.setAttribute('is', 'emby-scrollbuttons');
            scrollButtons.className = 'emby-scrollbuttons padded-right';

            const prevButton = document.createElement('button');
            prevButton.type = 'button';
            prevButton.setAttribute('is', 'paper-icon-button-light');
            prevButton.setAttribute('data-ripple', 'false');
            prevButton.setAttribute('data-direction', 'left');
            prevButton.title = 'Previous';
            prevButton.className = 'emby-scrollbuttons-button paper-icon-button-light';
            prevButton.disabled = true;

            const prevIcon = document.createElement('span');
            prevIcon.className = 'material-icons chevron_left';
            prevIcon.setAttribute('aria-hidden', 'true');
            prevButton.appendChild(prevIcon);

            const nextButton = document.createElement('button');
            nextButton.type = 'button';
            nextButton.setAttribute('is', 'paper-icon-button-light');
            nextButton.setAttribute('data-ripple', 'false');
            nextButton.setAttribute('data-direction', 'right');
            nextButton.title = 'Next';
            nextButton.className = 'emby-scrollbuttons-button paper-icon-button-light';

            const nextIcon = document.createElement('span');
            nextIcon.className = 'material-icons chevron_right';
            nextIcon.setAttribute('aria-hidden', 'true');
            nextButton.appendChild(nextIcon);

            scrollButtons.appendChild(prevButton);
            scrollButtons.appendChild(nextButton);

            const scroller = document.createElement('div');
            scroller.setAttribute('is', 'emby-scroller');
            scroller.setAttribute('data-horizontal', 'true');
            scroller.setAttribute('data-centerfocus', 'card');
            scroller.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
            scroller.setAttribute('data-scroll-mode-x', 'custom');
            scroller.style.overflow = 'hidden';

            const itemsContainer = document.createElement('div');
            itemsContainer.setAttribute('is', 'emby-itemscontainer');
            itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider animatedScrollX';
            itemsContainer.style.whiteSpace = 'nowrap';
            itemsContainer.style.willChange = 'transform';
            itemsContainer.style.transition = 'transform 270ms ease-out';
            itemsContainer.style.transform = 'translateX(0px)';

            items.forEach((item, index) => {
                if (typeof JE.cardBuilder !== 'undefined' && JE.cardBuilder.buildCard) {
                    const card = JE.cardBuilder.buildCard(item);
                    card.setAttribute('data-index', index);
                    card.classList.add('discover-card');
                    itemsContainer.appendChild(card);
                }
            });

            scroller.appendChild(itemsContainer);

            let scrollPosition = 0;
            const cardWidth = 212; // 200px card + 12px gap
            const visibleCards = Math.floor(scroller.offsetWidth / cardWidth);
            const scrollStep = Math.max(1, Math.floor(visibleCards * 0.9));
            const maxScroll = Math.max(0, items.length - visibleCards);

            const updateScrollButtons = () => {
                prevButton.disabled = scrollPosition <= 0;
                nextButton.disabled = scrollPosition >= maxScroll;
            };

            const scrollTo = (position, smooth = true) => {
                scrollPosition = Math.max(0, Math.min(position, maxScroll));

                if (smooth) {
                    itemsContainer.style.transition = 'transform 500ms cubic-bezier(0.25, 0.46, 0.45, 0.94)';
                } else {
                    itemsContainer.style.transition = 'none';
                }

                itemsContainer.style.transform = `translateX(-${scrollPosition * cardWidth}px)`;
                updateScrollButtons();

                if (smooth) {
                    setTimeout(() => {
                        itemsContainer.style.transition = 'transform 270ms ease-out';
                    }, 500);
                }
            };

            prevButton.addEventListener('click', () => {
                const newPosition = Math.max(0, scrollPosition - scrollStep);
                scrollTo(newPosition, true);
            });

            nextButton.addEventListener('click', () => {
                const newPosition = Math.min(maxScroll, scrollPosition + scrollStep);
                scrollTo(newPosition, true);
            });

            updateScrollButtons();

            verticalSection.appendChild(sectionTitle);
            verticalSection.appendChild(scrollButtons);
            verticalSection.appendChild(scroller);

            return verticalSection.outerHTML;
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