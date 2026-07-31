/**
 * @file Random-item header button: fetches a random movie/series and navigates to it.
 * Split from features.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    /**
     * Fetches a random item (Movie or Series) from the user's library.
     * @returns {Promise<object|null>} A promise that resolves to a random item or null.
     */
    async function getRandomItem() {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) {
            console.error("🪼 Jellyfin Enhanced: User not logged in.");
            return null;
        }

        const itemTypes = [];
        if (JE.currentSettings.randomIncludeMovies) itemTypes.push('Movie');
        if (JE.currentSettings.randomIncludeShows) itemTypes.push('Series');
        const includeItemTypes = itemTypes.join(',');

        let apiUrl = ApiClient.getUrl(`/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes}&Recursive=true&SortBy=Random&Limit=100&Fields=ExternalUrls`);

        try {
            const response = await ApiClient.ajax({ type: 'GET', url: apiUrl, dataType: 'json' });
            if (response && response.Items && response.Items.length > 0) {
                let items = response.Items;

                if (JE.currentSettings.randomUnwatchedOnly) {
                    items = items.filter(item => {
                        // For movies: check if not played
                        if (item.Type === 'Movie') {
                            return !item.UserData?.Played;
                        }
                        // For series: check if there are unplayed episodes
                        if (item.Type === 'Series') {
                            return item.UserData?.UnplayedItemCount > 0;
                        }
                        return false;
                    });
                    // If no unwatched items found, show error
                    if (items.length === 0) {
                        throw new Error('No unwatched items found in selected libraries.');
                    }
                }

                const randomIndex = Math.floor(Math.random() * items.length);
                return items[randomIndex];
            }
            throw new Error('No items found in selected libraries.');
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Error fetching random item:', error);
            JE.toast(`${JE.icon(JE.IconName.ERROR)} ${error.message || 'Unknown error'}`, 2000);
            return null;
        }
    }

    /**
     * Navigates the browser to the details page of the given item.
     * @param {object} item The item to navigate to.
     */
    function navigateToItem(item) {
        if (item && item.Id) {
            if (window.Emby && window.Emby.Page && typeof window.Emby.Page.show === 'function') {
                const serverId = ApiClient.serverId();
                window.Emby.Page.show(`/details?id=${item.Id}${serverId ? `&serverId=${serverId}` : ''}`);
            } else if (window.Dashboard && typeof window.Dashboard.navigate === 'function') {
                window.Dashboard.navigate(`details.html?id=${item.Id}`);
            } else {
                // Fallback to hash navigation for older versions
                const serverId = ApiClient.serverId();
                const itemUrl = `#!/details?id=${item.Id}${serverId ? `&serverId=${serverId}` : ''}`;
                window.location.hash = itemUrl;
            }
            JE.toast(JE.t('toast_random_item_loaded'), 2000);
        } else {
            console.error('🪼 Jellyfin Enhanced: Invalid item object or ID:', item);
            JE.toast(JE.t('toast_generic_error'), 2000);
        }
    }

    /**
     * Creates and injects the "Random" button into the page header if enabled.
     */
    JE.addRandomButton = () => {
        if (!JE.currentSettings.randomButtonEnabled) {
            document.getElementById('randomItemButtonContainer')?.remove();
            return;
        }

        if (document.getElementById('randomItemButton')) return;

        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'randomItemButtonContainer';

        const randomButton = document.createElement('button');
        randomButton.id = 'randomItemButton';
        randomButton.setAttribute('is', 'paper-icon-button-light');
        randomButton.className = 'headerButton headerButtonRight paper-icon-button-light';
        randomButton.title = JE.t('random_button_tooltip');
        randomButton.innerHTML = `<i class="material-icons">casino</i>`;

        randomButton.addEventListener('click', async () => {
            randomButton.disabled = true;
            randomButton.classList.add('loading');
            randomButton.innerHTML = '<i class="material-icons">hourglass_empty</i>';

            try {
                const item = await getRandomItem();
                if (item) {
                    navigateToItem(item);
                }
            } finally {
                setTimeout(() => {
                    if (document.getElementById(randomButton.id)) {
                        randomButton.disabled = false;
                        randomButton.classList.remove('loading');
                        randomButton.innerHTML = `<i class="material-icons">casino</i>`;
                    }
                }, 500);
            }
        });

        buttonContainer.appendChild(randomButton);
        const headerRight = JE.helpers.getHeaderRightContainer();
        headerRight?.prepend(buttonContainer);
    };
})(window.JellyfinEnhanced);
