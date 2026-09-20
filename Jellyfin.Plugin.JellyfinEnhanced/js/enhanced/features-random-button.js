/**
 * @file Random-item header button: fetches a random movie/series and navigates to it.
 * Split from features.js (code motion; bodies verbatim).
 *
 * Two opt-in per-user behaviours layer on top (see features-random-roulette.js):
 *   - randomRouletteEnabled: on a page that renders item cards, pick from those
 *     cards with a visible roulette spin instead of from the whole library.
 *   - randomAutoplay: start playing the pick instead of opening its details page.
 */
(function(JE) {
    'use strict';

    // Lucide dice-1..dice-6 faces, 24px to match the header's other icons.
    const DICE_FACES = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M12 12h.01"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M15 9h.01"/><path d="M9 15h.01"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M12 12h.01"/><path d="M8 16h.01"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M16 12h.01"/><path d="M16 16h.01"/><path d="M8 8h.01"/><path d="M8 12h.01"/><path d="M8 16h.01"/></svg>'
    ];

    /** Returns a random dice face's HTML, optionally excluding one index (to avoid repeats). */
    function randomDiceFace(excludeIndex) {
        let face;
        do { face = Math.floor(Math.random() * DICE_FACES.length); } while (face === excludeIndex);
        return face;
    }

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
     * Hands the chosen item to the user: plays it in this session when
     * autoplay is on, otherwise opens its details page. Autoplay falls back to
     * the details page when the play command is refused (no controllable
     * session, API error) so the pick is never lost.
     * @param {object} item An item DTO or anything with an `Id`.
     */
    async function deliverItem(item) {
        if (JE.currentSettings.randomAutoplay && item?.Id) {
            const played = await JE.internals.randomRoulette.playItem(item);
            if (played) return;
        }
        navigateToItem(item);
    }

    /**
     * Picks the item for one press of the button. With roulette enabled and
     * at least two eligible cards on the current page, spins over those cards;
     * otherwise draws from the whole library as before.
     * @returns {Promise<object|null>} The chosen item (`{ Id }` at minimum) or null.
     */
    async function pickItem() {
        if (JE.currentSettings.randomRouletteEnabled) {
            const roulette = JE.internals.randomRoulette;
            const cards = await roulette.getPageCandidates();
            if (cards.length > 1) {
                const card = await roulette.spin(cards);
                // null = the user navigated away mid-spin; drop the pick silently.
                return card ? { Id: card.dataset.id, Type: card.dataset.type } : null;
            }
        }
        return getRandomItem();
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
        randomButton.innerHTML = `<span class="je-dice-spin"><span class="je-dice-face"></span></span>`;
        const diceFace = randomButton.querySelector('.je-dice-face');
        let currentFace = randomDiceFace();
        diceFace.innerHTML = DICE_FACES[currentFace];

        randomButton.addEventListener('click', async () => {
            randomButton.disabled = true;
            randomButton.classList.add('loading');

            const rollDice = () => {
                currentFace = randomDiceFace(currentFace);
                diceFace.innerHTML = DICE_FACES[currentFace];
            };
            const rollInterval = setInterval(rollDice, 120);

            try {
                const item = await pickItem();
                if (item) {
                    await deliverItem(item);
                }
            } finally {
                clearInterval(rollInterval);
                setTimeout(() => {
                    if (document.getElementById(randomButton.id)) {
                        randomButton.disabled = false;
                        randomButton.classList.remove('loading');
                        rollDice();
                    }
                }, 500);
            }
        });

        buttonContainer.appendChild(randomButton);
        const headerRight = JE.helpers.getHeaderRightContainer();
        headerRight?.prepend(buttonContainer);
    };
})(window.JellyfinEnhanced);
