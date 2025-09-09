// /js/cardBuilder.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Card Builder:';

    JE.initializeCardBuilderScript = function() {
        if (typeof JE.cardBuilder !== 'undefined') {
            return;
        }

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

            // Add click handler
            card.addEventListener('click', (e) => {
                if (!e.target.closest('button')) {
                    console.log(`${logPrefix} Item clicked:`, { id: item.Id, name: item.Name });
                    try {
                        Dashboard.navigate(`#!/details?id=${item.Id}&serverId=${serverId}`);
                    } catch(e) {
                        console.error(`${logPrefix} Navigation failed:`, e);
                    }
                }
            });

            return card;
        }

        // Expose the cardBuilder to the global JE object
        JE.cardBuilder = {
            buildCard: function(item) {
                return createJellyfinCardElement(item);
            }
        };

        console.log(`${logPrefix} Module loaded and available at JE.cardBuilder`);
    };
})(window.JellyfinEnhanced);