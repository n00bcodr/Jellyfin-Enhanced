// /js/watchlist/cardBuilder.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Card Builder:';

    JE.initializeCardBuilderScript = function() {
        if (typeof JE.cardBuilder !== 'undefined') {
            return;
        }

        // Main card builder object
        const cardBuilder = {
            /**
             * Main entry point function to build a Jellyfin card
             * @param {Object} item - The Jellyfin item object
             * @returns {HTMLElement} - The constructed card element
             */
            buildCard: function(item) {
                return createJellyfinCardElement(item);
            },

            /**
             * Renders a scrollable container with cards
             * @param {Array} items - Array of Jellyfin item objects
             * @param {string} title - Title for the scrollable container
             * @param {string} viewMoreUrl - Optional URL to make title clickable
             * @param {number} sectionIndex - Index for debugging
             * @returns {HTMLElement} - The constructed scrollable container
             */
            renderCards: function(items, title, viewMoreUrl = null, sectionIndex = 0) {
                return createScrollableContainer(items, title, viewMoreUrl, sectionIndex);
            },

            /**
             * Renders a scrollable container with cards from item IDs
             * @param {Array} itemIds - Array of Jellyfin item IDs
             * @param {string} title - Title for the scrollable container
             * @param {string} viewMoreUrl - Optional URL to make title clickable
             * @param {number} sectionIndex - Index for debugging
             * @returns {Promise<HTMLElement>} - The constructed scrollable container
             */
            renderCardsFromIds: async function(itemIds, title, viewMoreUrl = null, sectionIndex = 0) {
                const LOG = (...args) => console.log('[CardBuilder]', ...args);

                if (!itemIds || itemIds.length === 0) {
                    LOG(`No item IDs provided for section: ${title}`);
                    return createScrollableContainer([], title, viewMoreUrl, sectionIndex);
                }

                try {
                    // Fetch all items at once
                    const items = await Promise.all(
                        itemIds.map(id => ApiClient.getItem(ApiClient.getCurrentUserId(), id))
                    );

                    LOG(`Fetched ${items.length} items for section: ${title}`);
                    return createScrollableContainer(items, title, viewMoreUrl, sectionIndex);
                } catch (error) {
                    console.error('[CardBuilder] Error fetching items:', error);
                    return createScrollableContainer([], title, viewMoreUrl, sectionIndex);
                }
            }
        };

        /**
         * Creates a Jellyfin card element from an item
         * @param {Object} item - The Jellyfin item object
         * @returns {HTMLElement} - The constructed card element
         */
        function createJellyfinCardElement(item) {
            const serverId = ApiClient.serverId();
            const serverAddress = ApiClient.serverAddress();

            // Determine card type based on item type
            let cardClass, padderClass, imageParams;
            if (item.Type === 'Episode' || item.Type === 'TvChannel') {
                cardClass = 'overflowBackdropCard';
                padderClass = 'cardPadder-overflowBackdrop';
                imageParams = 'fillHeight=267&fillWidth=474';
            } else if (['MusicAlbum', 'Audio', 'Artist', 'MusicArtist'].includes(item.Type)) {
                cardClass = 'overflowSquareCard';
                padderClass = 'cardPadder-overflowSquare';
                imageParams = 'fillHeight=297&fillWidth=297';
            } else {
                // Default poster style for Movies, Series, etc.
                cardClass = 'overflowPortraitCard';
                padderClass = 'cardPadder-overflowPortrait';
                imageParams = 'fillHeight=446&fillWidth=297';
            }

            // Create the main card container
            const card = document.createElement('div');
            card.className = `card ${cardClass} card-hoverable card-withuserdata`;
            card.setAttribute('data-index', '0');
            card.setAttribute('data-isfolder', item.Type === 'MusicAlbum' || item.Type === 'Artist' ? 'true' : 'false');
            card.setAttribute('data-serverid', serverId);
            card.setAttribute('data-id', item.Id);
            card.setAttribute('data-type', item.Type);
            card.setAttribute('data-mediatype', item.MediaType || 'Video');
            card.setAttribute('data-prefix', item.Name?.startsWith('The ') ? 'THE' : '');

            // Card box container
            const cardBox = document.createElement('div');
            cardBox.className = 'cardBox cardBox-bottompadded';

            // Card scalable container
            const cardScalable = document.createElement('div');
            cardScalable.className = 'cardScalable';

            // Card padder with icon
            const cardPadder = document.createElement('div');
            cardPadder.className = `cardPadder ${padderClass} lazy-hidden-children`;

            const cardIcon = document.createElement('span');
            cardIcon.className = 'cardImageIcon material-icons';
            cardIcon.setAttribute('aria-hidden', 'true');

            // Set icon based on item type
            if (item.Type === 'Movie') {
                cardIcon.textContent = 'movie';
            } else if (item.Type === 'Series') {
                cardIcon.textContent = 'tv';
            } else if (item.Type === 'Episode') {
                cardIcon.textContent = 'play_circle';
            } else if (item.Type === 'MusicAlbum') {
                cardIcon.textContent = 'album';
            } else if (item.Type === 'Audio') {
                cardIcon.textContent = 'music_note';
            } else if (item.Type === 'Artist') {
                cardIcon.textContent = 'person';
            } else {
                cardIcon.textContent = 'folder';
            }

            cardPadder.appendChild(cardIcon);

            // Blurhash canvas (placeholder)
            const blurhashCanvas = document.createElement('canvas');
            blurhashCanvas.setAttribute('aria-hidden', 'true');
            blurhashCanvas.width = 20;
            blurhashCanvas.height = 20;
            blurhashCanvas.className = 'blurhash-canvas lazy-hidden';

            // Card image container
            const cardImageContainer = document.createElement('a');
            cardImageContainer.href = `#/details?id=${item.Id}&serverId=${serverId}`;
            cardImageContainer.className = 'cardImageContainer coveredImage cardContent itemAction lazy blurhashed lazy-image-fadein-fast';
            cardImageContainer.setAttribute('data-action', 'link');
            cardImageContainer.setAttribute('aria-label', item.Name || 'Unknown');

            // Set background image or icon
            if (item.ImageTags?.Primary) {
                let imageUrl;
                if (item.IsJellyseerr) {
                    // Jellyseerr items use external image URLs
                    imageUrl = item.ImageTags.Primary.startsWith('http')
                        ? item.ImageTags.Primary
                        : `https://image.tmdb.org/t/p/w500${item.ImageTags.Primary}`;
                } else {
                    // Regular Jellyfin items
                    imageUrl = `${serverAddress}/Items/${item.Id}/Images/Primary?${imageParams}&quality=96&tag=${item.ImageTags.Primary}`;
                }
                cardImageContainer.style.backgroundImage = `url("${imageUrl}")`;
            } else {
                // No image - add icon as inner element
                const iconSpan = document.createElement('span');
                iconSpan.className = 'cardImageIcon material-icons';
                iconSpan.setAttribute('aria-hidden', 'true');

                // Set icon based on item type
                if (item.Type === 'Movie') {
                    iconSpan.textContent = 'movie';
                } else if (item.Type === 'Series') {
                    iconSpan.textContent = 'tv';
                } else if (item.Type === 'Episode') {
                    iconSpan.textContent = 'tv';
                } else if (item.Type === 'Person') {
                    iconSpan.textContent = 'person';
                } else if (item.Type === 'MusicAlbum') {
                    iconSpan.textContent = 'album';
                } else if (item.Type === 'Audio') {
                    iconSpan.textContent = 'music_note';
                } else if (item.Type === 'Artist' || item.Type === 'MusicArtist') {
                    iconSpan.textContent = 'person';
                } else {
                    iconSpan.textContent = 'folder';
                }

                cardImageContainer.appendChild(iconSpan);
            }

            // Card overlay container
            const cardOverlayContainer = document.createElement('div');
            cardOverlayContainer.className = 'cardOverlayContainer itemAction';
            cardOverlayContainer.setAttribute('data-action', 'link');

            // Overlay link
            const overlayLink = document.createElement('a');
            overlayLink.href = `#/details?id=${item.Id}&serverId=${serverId}`;
            overlayLink.className = 'cardImageContainer';

            // Play button
            const playButton = document.createElement('button');
            playButton.setAttribute('is', 'paper-icon-button-light');
            playButton.className = 'cardOverlayButton cardOverlayButton-hover itemAction paper-icon-button-light cardOverlayFab-primary';
            playButton.setAttribute('data-action', 'resume');

            const playIcon = document.createElement('span');
            playIcon.className = 'material-icons cardOverlayButtonIcon cardOverlayButtonIcon-hover play_arrow';
            playIcon.setAttribute('aria-hidden', 'true');
            playButton.appendChild(playIcon);

            // Button container for additional overlay buttons (watchlist, etc.)
            const buttonContainer = document.createElement('div');
            buttonContainer.className = 'cardOverlayButton-br flex';

            // Add play button to button container
            buttonContainer.appendChild(playButton);

            // Assemble overlay
            cardOverlayContainer.appendChild(overlayLink);
            cardOverlayContainer.appendChild(buttonContainer);

            // Card text container - different structure for episodes
            const cardTextContainer = document.createElement('div');
            cardTextContainer.className = 'cardText cardTextCentered cardText-first';

            if (item.Type === 'Episode') {
                // Episodes: Series name as primary, episode title as secondary
                const seriesLink = document.createElement('a');
                seriesLink.href = `#/details?id=${item.SeriesId || item.Id}&serverId=${serverId}`;
                seriesLink.className = 'itemAction textActionButton';
                seriesLink.setAttribute('data-id', item.SeriesId || item.Id);
                seriesLink.setAttribute('data-serverid', serverId);
                seriesLink.setAttribute('data-type', 'Series');
                seriesLink.setAttribute('data-mediatype', 'undefined');
                seriesLink.setAttribute('data-channelid', 'undefined');
                seriesLink.setAttribute('data-isfolder', 'true');
                seriesLink.setAttribute('data-action', 'link');
                seriesLink.title = item.SeriesName || 'Unknown Series';
                seriesLink.textContent = item.SeriesName || 'Unknown Series';

                const seriesBdi = document.createElement('bdi');
                seriesBdi.appendChild(seriesLink);
                cardTextContainer.appendChild(seriesBdi);

                // Episode title as secondary
                const secondaryText = document.createElement('div');
                secondaryText.className = 'cardText cardTextCentered cardText-secondary';
                const episodeLink = document.createElement('a');
                episodeLink.href = `#/details?id=${item.Id}&serverId=${serverId}`;
                episodeLink.className = 'itemAction textActionButton';
                episodeLink.setAttribute('data-id', item.Id);
                episodeLink.setAttribute('data-serverid', serverId);
                episodeLink.setAttribute('data-type', 'Episode');
                episodeLink.setAttribute('data-mediatype', 'undefined');
                episodeLink.setAttribute('data-channelid', 'undefined');
                episodeLink.setAttribute('data-isfolder', 'false');
                episodeLink.setAttribute('data-action', 'link');
                episodeLink.title = item.Name || 'Unknown Episode';
                episodeLink.textContent = item.Name || 'Unknown Episode';

                const episodeBdi = document.createElement('bdi');
                episodeBdi.appendChild(episodeLink);
                secondaryText.appendChild(episodeBdi);
            } else {
                // Default: Item name as primary, year as secondary
                const titleLink = document.createElement('a');
                titleLink.href = `#/details?id=${item.Id}&serverId=${serverId}`;
                titleLink.className = 'itemAction textActionButton';
                titleLink.setAttribute('data-id', item.Id);
                titleLink.setAttribute('data-serverid', serverId);
                titleLink.setAttribute('data-type', item.Type);
                titleLink.setAttribute('data-mediatype', 'undefined');
                titleLink.setAttribute('data-channelid', 'undefined');
                titleLink.setAttribute('data-isfolder', item.Type === 'MusicAlbum' || item.Type === 'Artist' || item.Type === 'MusicArtist' ? 'true' : 'false');
                titleLink.setAttribute('data-action', 'link');
                titleLink.title = item.Name || 'Unknown';
                titleLink.textContent = item.Name || 'Unknown';

                const titleBdi = document.createElement('bdi');
                titleBdi.appendChild(titleLink);
                cardTextContainer.appendChild(titleBdi);

                // Secondary text (year)
                const secondaryText = document.createElement('div');
                secondaryText.className = 'cardText cardTextCentered cardText-secondary';
                const yearBdi = document.createElement('bdi');
                yearBdi.textContent = item.ProductionYear || item.PremiereDate?.substring(0, 4) || '';
                secondaryText.appendChild(yearBdi);
            }

            // Assemble card
            cardScalable.appendChild(cardPadder);
            cardScalable.appendChild(blurhashCanvas);
            cardScalable.appendChild(cardImageContainer);
            cardScalable.appendChild(cardOverlayContainer);

            cardBox.appendChild(cardScalable);
            cardBox.appendChild(cardTextContainer);

            // Add secondary text after primary text
            if (item.Type === 'Episode') {
                const secondaryText = document.createElement('div');
                secondaryText.className = 'cardText cardTextCentered cardText-secondary';
                const episodeLink = document.createElement('a');
                episodeLink.href = `#/details?id=${item.Id}&serverId=${serverId}`;
                episodeLink.className = 'itemAction textActionButton';
                episodeLink.setAttribute('data-id', item.Id);
                episodeLink.setAttribute('data-serverid', serverId);
                episodeLink.setAttribute('data-type', 'Episode');
                episodeLink.setAttribute('data-mediatype', 'undefined');
                episodeLink.setAttribute('data-channelid', 'undefined');
                episodeLink.setAttribute('data-isfolder', 'false');
                episodeLink.setAttribute('data-action', 'link');
                episodeLink.title = item.Name || 'Unknown Episode';
                episodeLink.textContent = item.Name || 'Unknown Episode';

                const episodeBdi = document.createElement('bdi');
                episodeBdi.appendChild(episodeLink);
                secondaryText.appendChild(episodeBdi);
                cardBox.appendChild(secondaryText);
            } else {
                const secondaryText = document.createElement('div');
                secondaryText.className = 'cardText cardTextCentered cardText-secondary';
                const yearBdi = document.createElement('bdi');
                yearBdi.textContent = item.ProductionYear || item.PremiereDate?.substring(0, 4) || '';
                secondaryText.appendChild(yearBdi);
                cardBox.appendChild(secondaryText);
            }

            card.appendChild(cardBox);

            return card;
        }

        /**
         * Creates a scrollable container with horizontal scrolling functionality
         * @param {Array} items - Array of Jellyfin item objects
         * @param {string} title - Title for the scrollable container
         * @param {string} viewMoreUrl - Optional URL to make title clickable
         * @param {number} sectionIndex - Index for debugging
         * @returns {HTMLElement} - The constructed scrollable container
         */
        function createScrollableContainer(items, title, viewMoreUrl = null, sectionIndex = 0) {
            const LOG = (...args) => console.log('[CardBuilder]', ...args);

            // Create the main vertical section container
            const verticalSection = document.createElement('div');
            verticalSection.className = 'verticalSection emby-scroller-container';

            // Create section title
            const sectionTitle = document.createElement('h2');
            sectionTitle.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';

            if (viewMoreUrl) {
                // Create clickable title with chevron icon
                const titleLink = document.createElement('a');
                titleLink.href = viewMoreUrl;
                titleLink.className = 'sectionTitle-link sectionTitleTextButton';
                titleLink.style.cssText = 'text-decoration: none; cursor: pointer; display: flex; align-items: center;';

                const titleText = document.createElement('span');
                titleText.textContent = title;

                const chevronIcon = document.createElement('span');
                chevronIcon.className = 'material-icons chevron_right';
                chevronIcon.setAttribute('aria-hidden', 'true');

                titleLink.appendChild(titleText);
                titleLink.appendChild(chevronIcon);
                sectionTitle.appendChild(titleLink);
            } else {
                // Regular non-clickable title
                sectionTitle.textContent = title;
            }

            // Create scroll buttons container
            const scrollButtons = document.createElement('div');
            //scrollButtons.setAttribute('is', 'emby-scrollbuttons');
            scrollButtons.className = 'emby-scrollbuttons custom-scrollbuttons padded-right';

            // Previous button
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

            // Next button
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

            // Create scroller container
            const scroller = document.createElement('div');
            scroller.setAttribute('is', 'emby-scroller');
            scroller.setAttribute('data-horizontal', 'true');
            scroller.setAttribute('data-centerfocus', 'card');
            scroller.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller custom-scroller';
            scroller.setAttribute('data-scroll-mode-x', 'custom');
            scroller.style.overflow = 'hidden';

            // Create items container
            const itemsContainer = document.createElement('div');
            itemsContainer.setAttribute('is', 'emby-itemscontainer');
            itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider animatedScrollX';
            itemsContainer.style.whiteSpace = 'nowrap';
            itemsContainer.style.willChange = 'transform';
            itemsContainer.style.transition = 'transform 270ms ease-out';
            itemsContainer.style.transform = 'translateX(0px)';

            // Add items to container
            items.forEach((item, index) => {
                const card = createJellyfinCardElement(item);
                card.setAttribute('data-index', index);
                itemsContainer.appendChild(card);
            });

            scroller.appendChild(itemsContainer);

            // Scroll functionality - calculate dynamically when needed
            let scrollPosition = 0;

            // Calculate scroll values dynamically based on current DOM state
            const calculateScrollValues = () => {
                const firstCard = itemsContainer.querySelector('.card');
                if (!firstCard) {
                    LOG(`[SCROLL ERROR] No cards found in scroller ${sectionIndex}`);
                    return { cardWidth: 212, visibleCards: 1, scrollStep: 1, maxScroll: 0 };
                }

                const cardRect = firstCard.getBoundingClientRect();
                const computedStyle = window.getComputedStyle(firstCard);
                const marginRight = parseFloat(computedStyle.marginRight) || 0;
                const cardWidth = cardRect.width + marginRight; // Card width + gap

                const visibleCards = Math.floor(scroller.offsetWidth / cardWidth);
                const scrollStep = Math.max(1, visibleCards); // Scroll by the number of fully visible cards
                const maxScroll = Math.max(0, items.length - visibleCards);

                LOG(`[SCROLL CALC] Scroller ${sectionIndex}: containerWidth=${scroller.offsetWidth}, cardWidth=${cardWidth}, visibleCards=${visibleCards}, scrollStep=${scrollStep}, totalItems=${items.length}, maxScroll=${maxScroll}`);

                return { cardWidth, visibleCards, scrollStep, maxScroll };
            };

            const updateScrollButtons = () => {
                const { maxScroll } = calculateScrollValues();
                prevButton.disabled = scrollPosition <= 0;
                nextButton.disabled = scrollPosition >= maxScroll;
            };

            const scrollTo = (position, smooth = true) => {
                const { cardWidth, maxScroll } = calculateScrollValues();

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

            // Check if buttons already have event listeners (from Jellyfin's default handlers)
            const hasExistingListeners = () => {
                // Check if the buttons have any event listeners attached
                // We'll look for the presence of Jellyfin's default scroll behavior
                const existingButtons = document.querySelectorAll('.emby-scrollbuttons-button.paper-icon-button-light');
                return existingButtons.length > 0 && existingButtons[0].onclick !== null;
            };

            // Native horizontal scrolling with momentum and snap
            let touchStartX = 0;
            let touchStartY = 0;
            let touchCurrentX = 0;
            let isDragging = false;
            let startScrollPosition = 0;
            let currentScrollOffset = 0;
            let lastTouchTime = 0;
            let velocity = 0;
            let lastTouchX = 0;
            let animationFrame = null;
            let momentumAnimation = null;

            const handleTouchStart = (e) => {
                if (e.touches.length !== 1) return;

                // Cancel any ongoing momentum animation
                if (momentumAnimation) {
                    cancelAnimationFrame(momentumAnimation);
                    momentumAnimation = null;
                }

                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                lastTouchX = touchStartX;
                lastTouchTime = Date.now();
                isDragging = true;
                startScrollPosition = scrollPosition;
                currentScrollOffset = 0;
                velocity = 0;

                // Disable smooth transitions during drag
                itemsContainer.style.transition = 'none';

                // Don't prevent default here - let touch move determine if we should handle it
            };

            const handleTouchMove = (e) => {
                if (!isDragging || e.touches.length !== 1) return;

                touchCurrentX = e.touches[0].clientX;
                const deltaX = touchStartX - touchCurrentX;
                const deltaY = touchStartY - e.touches[0].clientY;

                // Only process horizontal swipes
                if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
                    e.preventDefault(); // Prevent default scrolling behavior

                    // Calculate velocity for momentum
                    const currentTime = Date.now();
                    const timeDelta = currentTime - lastTouchTime;
                    if (timeDelta > 0) {
                        velocity = (lastTouchX - touchCurrentX) / timeDelta;
                    }
                    lastTouchX = touchCurrentX;
                    lastTouchTime = currentTime;

                    // Update scroll position in real-time
                    const { cardWidth } = calculateScrollValues();
                    currentScrollOffset = deltaX / cardWidth;
                    const newPosition = startScrollPosition + currentScrollOffset;

                    // Apply the transform immediately
                    itemsContainer.style.transform = `translateX(-${newPosition * cardWidth}px)`;
                }
            };

            const handleTouchEnd = (e) => {
                if (!isDragging) return;

                isDragging = false;

                // Calculate final position with momentum
                const { cardWidth, maxScroll } = calculateScrollValues();
                let finalPosition = startScrollPosition + currentScrollOffset;

                // Apply momentum if velocity is significant
                if (Math.abs(velocity) > 0.1) {
                    const momentumDistance = velocity * 200; // Adjust multiplier for momentum strength
                    finalPosition += momentumDistance / cardWidth;
                }

                // Clamp to bounds
                finalPosition = Math.max(0, Math.min(finalPosition, maxScroll));

                // Snap to nearest card
                const snapPosition = Math.round(finalPosition);
                finalPosition = Math.max(0, Math.min(snapPosition, maxScroll));

                // Update scroll position and animate to final position
                scrollPosition = finalPosition;

                // Re-enable smooth transitions
                itemsContainer.style.transition = 'transform 300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)';
                itemsContainer.style.transform = `translateX(-${scrollPosition * cardWidth}px)`;

                // Update button states
                updateScrollButtons();

                LOG(`[TOUCH END] Scroller ${sectionIndex}: velocity=${velocity.toFixed(3)}, finalPosition=${finalPosition}, snapPosition=${snapPosition}`);

                // Reset velocity
                velocity = 0;
                currentScrollOffset = 0;
            };

            // Add touch event listeners to the scroller
            scroller.addEventListener('touchstart', handleTouchStart, { passive: false });
            scroller.addEventListener('touchmove', handleTouchMove, { passive: false });
            scroller.addEventListener('touchend', handleTouchEnd, { passive: false });
            scroller.addEventListener('touchcancel', handleTouchEnd, { passive: false });

            // Only attach our event listeners if there are no existing ones
            if (true) {
                prevButton.addEventListener('click', () => {
                    const { scrollStep, maxScroll } = calculateScrollValues();
                    const newPosition = Math.max(0, scrollPosition - scrollStep);
                    LOG(`[PREV CLICK] Scroller ${sectionIndex}: currentPosition=${scrollPosition}, scrollStep=${scrollStep}, newPosition=${newPosition}`);
                    scrollTo(newPosition, true);
                });

                nextButton.addEventListener('click', () => {
                    const { scrollStep, maxScroll } = calculateScrollValues();
                    const newPosition = Math.min(maxScroll, scrollPosition + scrollStep);
                    LOG(`[NEXT CLICK] Scroller ${sectionIndex}: currentPosition=${scrollPosition}, scrollStep=${scrollStep}, newPosition=${newPosition}`);
                    scrollTo(newPosition, true);
                });
            }

            // Initial state
            updateScrollButtons();

            // Assemble the section
            verticalSection.appendChild(sectionTitle);
            verticalSection.appendChild(scrollButtons);
            verticalSection.appendChild(scroller);

            return verticalSection;
        }

        // Add CSS to hide emby-scrollbuttons that aren't custom-scrollbuttons and improve touch experience
        const style = document.createElement('style');
        style.textContent = `
            .smart-search-results .emby-scrollbuttons {
                display: none;
            }
            .layout-desktop .smart-search-results .emby-scrollbuttons:not(.custom-scrollbuttons) {
                display: block !important;
            }

            /* Native horizontal scrolling experience - ONLY for our custom scrollers */
            .emby-scroller.custom-scroller {
                -webkit-overflow-scrolling: touch !important;
                touch-action: pan-x !important;
                overscroll-behavior-x: contain !important;
            }

            /* Improve touch responsiveness */
            .emby-scroller.custom-scroller .scrollSlider {
                touch-action: pan-x !important;
                -webkit-user-select: none !important;
                user-select: none !important;
            }

            /* Ensure smooth scrolling on mobile */
            @media (max-width: 768px) {
                .emby-scroller.custom-scroller {
                    scroll-behavior: smooth !important;
                }
            }
        `;
        document.head.appendChild(style);

        // Expose the cardBuilder to the global JE object
        JE.cardBuilder = cardBuilder;

        console.log(logPrefix, 'Module loaded and available at JE.cardBuilder');
    };
})(window.JellyfinEnhanced);