/**
 * @file Random-item header button: fetches a random movie/series and navigates to it.
 * Split from features.js (code motion; bodies verbatim).
 *
 * Two per-user settings narrow where the pick comes from:
 *   - randomScopeCurrentContainer: on a Playlist/BoxSet details page, pick
 *     from that container's items.
 *   - randomSourceId: a pinned playlist/collection to pick from on every page.
 * Either falls back to the whole library (with a toast) when it yields nothing.
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

    // Containers the button can be scoped to (see resolveSourceContainer).
    const CONTAINER_TYPES = ['Playlist', 'BoxSet'];

    // Why the current press fell back to the whole library, if it did. Shown
    // in place of the plain "loaded" toast so the two do not stack on top of
    // each other (toasts share one fixed position).
    let fallbackNotice = null;

    /**
     * Item types the user opted into, as an IncludeItemTypes value. Inside a
     * container, episodes count as "shows" so an episode playlist is not empty.
     * @param {boolean} inContainer True when querying a playlist/collection.
     * @returns {string}
     */
    function includeItemTypes(inContainer) {
        const types = [];
        if (JE.currentSettings.randomIncludeMovies) types.push('Movie');
        if (JE.currentSettings.randomIncludeShows) types.push('Series', ...(inContainer ? ['Episode'] : []));
        return types.join(',');
    }

    /**
     * Fetches an item by id, through the shared short-TTL cache when available.
     * @param {string} itemId
     * @returns {Promise<object|null>} null when the item cannot be read (deleted, no access).
     */
    function fetchItem(itemId) {
        const userId = ApiClient.getCurrentUserId();
        const request = JE.helpers?.getItemCached
            ? JE.helpers.getItemCached(itemId, { userId })
            : ApiClient.getItem(userId, itemId);
        return request.catch(() => null);
    }

    /**
     * Resolves the playlist or collection the button should draw from: the one
     * open on screen when "scope to current playlist/collection" is on and a
     * Playlist/BoxSet details page is showing, else the source pinned in the
     * settings panel, else null for the whole library.
     * @returns {Promise<object|null>} The container item, or null.
     */
    async function resolveSourceContainer() {
        if (JE.currentSettings.randomScopeCurrentContainer && /details/.test(window.location.hash)) {
            const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            const item = itemId ? await fetchItem(itemId) : null;
            if (item && CONTAINER_TYPES.includes(item.Type)) return item;
        }
        const pinnedId = JE.currentSettings.randomSourceId;
        if (pinnedId) {
            // Validate by type rather than by "did the request succeed": a
            // deleted id 404s, but the all-zero id answers with the user's root
            // folder, and neither is something we should draw from.
            const item = await fetchItem(pinnedId);
            if (item && CONTAINER_TYPES.includes(item.Type)) return item;
            fallbackNotice = JE.t('toast_random_source_missing');
        }
        return null;
    }

    /**
     * Fetches up to 100 candidate items in random order: the direct children
     * of `parentId` when given (a playlist's entries, a collection's titles),
     * otherwise the whole library recursively.
     * @param {string} userId
     * @param {string|null} parentId
     * @returns {Promise<object[]>}
     */
    async function fetchCandidates(userId, parentId) {
        const scope = parentId ? `ParentId=${parentId}` : 'Recursive=true';
        const apiUrl = ApiClient.getUrl(`/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes(!!parentId)}&${scope}&SortBy=Random&Limit=100&Fields=ExternalUrls`);
        const response = await ApiClient.ajax({ type: 'GET', url: apiUrl, dataType: 'json' });
        return response?.Items || [];
    }

    /**
     * Applies the "unwatched only" setting: series need unplayed episodes,
     * everything else (movies, episodes) must simply not be played.
     * @param {object[]} items
     * @returns {object[]}
     */
    function filterUnwatched(items) {
        if (!JE.currentSettings.randomUnwatchedOnly) return items;
        return items.filter(item => item.Type === 'Series'
            ? item.UserData?.UnplayedItemCount > 0
            : !item.UserData?.Played);
    }

    /**
     * Fetches a random item (Movie or Series) from the user's library, or from
     * the playlist/collection the button is scoped to. A scoped container with
     * nothing eligible falls back to the whole library with a toast.
     * @returns {Promise<object|null>} A promise that resolves to a random item or null.
     */
    async function getRandomItem() {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) {
            console.error("🪼 Jellyfin Enhanced: User not logged in.");
            return null;
        }

        try {
            fallbackNotice = null;
            const container = await resolveSourceContainer();
            let items = container ? filterUnwatched(await fetchCandidates(userId, container.Id)) : [];
            if (container && items.length === 0) {
                fallbackNotice = JE.t('toast_random_source_empty', { name: JE.escapeHtml(container.Name) });
            }
            if (items.length === 0) {
                const libraryItems = await fetchCandidates(userId, null);
                if (libraryItems.length === 0) throw new Error('No items found in selected libraries.');
                items = filterUnwatched(libraryItems);
                if (items.length === 0) throw new Error('No unwatched items found in selected libraries.');
            }
            return items[Math.floor(Math.random() * items.length)];
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
            JE.toast(fallbackNotice || JE.t('toast_random_item_loaded'), fallbackNotice ? 3000 : 2000);
            fallbackNotice = null;
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

        // Getting the tray also reconnects its existing buttons after a native
        // header remount; check the ID only after that reconciliation.
        const headerRight = JE.helpers.getHeaderButtonTray();
        if (!headerRight || document.getElementById('randomItemButton')) return;

        const buttonContainer = document.createElement('div');
        buttonContainer.id = 'randomItemButtonContainer';

        const randomButton = document.createElement('button');
        randomButton.id = 'randomItemButton';
        randomButton.setAttribute('is', 'paper-icon-button-light');
        randomButton.className = 'headerButton headerButtonRight paper-icon-button-light';
        randomButton.title = JE.t('random_button_tooltip');
        const headerLabel = JE.t('header_random_item');
        randomButton.dataset.headerLabel = headerLabel === 'header_random_item' ? 'Random item' : headerLabel;
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
                const item = await getRandomItem();
                if (item) {
                    navigateToItem(item);
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
        headerRight.prepend(buttonContainer);
    };
})(window.JellyfinEnhanced);
