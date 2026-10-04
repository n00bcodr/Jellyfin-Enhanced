// /js/jellyseerr/discovery/discovery-filter-utils.js
// Shared utilities for discovery section content type filtering
(function(JE) {
    'use strict';

    const FILTER_MODES = {
        MIXED: 'mixed',
        MOVIES: 'movies',
        TV: 'tv'
    };
    const runtimeFilterModes = new Map();
    const runtimeSortModes = new Map();

    const SORT_OPTIONS = [
        { value: '', label: 'Popular' },
        { value: 'vote_average.desc', label: 'Top Rated' },
        { value: 'release_date.desc', label: 'Newest' },
        { value: 'release_date.asc', label: 'Oldest' }
    ];

    /**
     * Gets the current filter mode for a module from runtime state.
     * @param {string} moduleName - e.g., 'genre', 'tag', 'person', 'network'
     * @returns {string} - 'mixed', 'movies', or 'tv'
     */
    function getFilterMode(moduleName) {
        const stored = runtimeFilterModes.get(moduleName);
        if (stored && Object.values(FILTER_MODES).includes(stored)) {
            return stored;
        }
        return FILTER_MODES.MIXED;
    }

    /**
     * Sets the filter mode for a module in runtime state.
     * @param {string} moduleName
     * @param {string} mode - 'mixed', 'movies', or 'tv'
     */
    function setFilterMode(moduleName, mode) {
        if (Object.values(FILTER_MODES).includes(mode)) {
            runtimeFilterModes.set(moduleName, mode);
        }
    }

    /**
     * Resets module filter mode back to default.
     * @param {string} moduleName
     */
    function resetFilterMode(moduleName) {
        runtimeFilterModes.delete(moduleName);
    }

    /**
     * Gets the current sort mode for a module.
     * @param {string} moduleName - e.g., 'genre', 'tag', 'person', 'network'
     * @returns {string} Sort value (empty string = default/popular)
     */
    function getSortMode(moduleName) {
        return runtimeSortModes.get(moduleName) || '';
    }

    /**
     * Gets the sort value adapted for TV endpoints.
     * TMDB uses first_air_date for TV instead of release_date for movies.
     * @param {string} moduleName
     * @returns {string} TV-compatible sort value
     */
    function getTvSortMode(moduleName) {
        const sort = runtimeSortModes.get(moduleName) || '';
        return sort.replace('release_date', 'first_air_date');
    }

    /**
     * Sets the sort mode for a module.
     * @param {string} moduleName
     * @param {string} sort - Sort value from SORT_OPTIONS
     */
    function setSortMode(moduleName, sort) {
        runtimeSortModes.set(moduleName, sort);
    }

    /**
     * Resets module sort mode back to default (popular).
     * @param {string} moduleName
     */
    function resetSortMode(moduleName) {
        runtimeSortModes.delete(moduleName);
    }

    /**
     * Interleaves two arrays in 1:1 alternating fashion
     * Preserves internal order of each array
     * @param {Array} arr1 - First array (e.g., TV results)
     * @param {Array} arr2 - Second array (e.g., Movie results)
     * @returns {Array} - Interleaved array
     */
    function interleaveArrays(arr1, arr2) {
        const result = [];
        const len1 = arr1.length;
        const len2 = arr2.length;
        const maxLen = Math.max(len1, len2);

        let i1 = 0;
        let i2 = 0;

        for (let i = 0; i < maxLen * 2 && (i1 < len1 || i2 < len2); i++) {
            if (i % 2 === 0 && i1 < len1) {
                result.push(arr1[i1++]);
            } else if (i % 2 === 1 && i2 < len2) {
                result.push(arr2[i2++]);
            } else if (i1 < len1) {
                result.push(arr1[i1++]);
            } else if (i2 < len2) {
                result.push(arr2[i2++]);
            }
        }

        return result;
    }

    /**
     * Filters results by media type
     * @param {Array} results - Array of items with mediaType property
     * @param {string} mode - 'mixed', 'movies', or 'tv'
     * @returns {Array} - Filtered array
     */
    function filterByMediaType(results, mode) {
        if (mode === FILTER_MODES.MIXED) {
            return results;
        }
        if (mode === FILTER_MODES.MOVIES) {
            return results.filter(item => item.mediaType === 'movie');
        }
        if (mode === FILTER_MODES.TV) {
            return results.filter(item => item.mediaType === 'tv');
        }
        return results;
    }

    /**
     * Determines if both movies and TV exist in results
     * @param {Array} tvResults - TV results array
     * @param {Array} movieResults - Movie results array
     * @returns {boolean}
     */
    function hasBothTypes(tvResults, movieResults) {
        return (tvResults && tvResults.length > 0) && (movieResults && movieResults.length > 0);
    }

    /**
     * Determines if results contain both media types (for combined endpoint results)
     * @param {Array} results - Combined results array
     * @returns {boolean}
     */
    function resultHasBothTypes(results) {
        if (!results || results.length === 0) return false;
        let hasMovie = false;
        let hasTv = false;
        for (let i = 0; i < results.length && !(hasMovie && hasTv); i++) {
            if (results[i].mediaType === 'movie') hasMovie = true;
            if (results[i].mediaType === 'tv') hasTv = true;
        }
        return hasMovie && hasTv;
    }

    /**
     * Creates the filter control UI element
     * @param {string} moduleName - Module name for persistence
     * @param {Function} onFilterChange - Callback when filter changes: (newMode) => void
     * @returns {HTMLElement} - The filter control container
     */
    function createFilterControl(moduleName, onFilterChange) {
        const currentMode = getFilterMode(moduleName);

        const container = document.createElement('div');
        container.className = 'jellyseerr-discovery-filter';
        container.style.cssText = 'display:inline-flex;gap:0;font-size:0.85em;vertical-align:middle;';

        const allLabel = (typeof JE?.t === 'function') ? JE.t('jellyseerr_discover_all') || 'All' : 'All';
        const moviesLabel = (typeof JE?.t === 'function') ? JE.t('jellyseerr_card_badge_movie') || 'Movies' : 'Movies';
        const seriesLabel = (typeof JE?.t === 'function') ? JE.t('jellyseerr_card_badge_series') || 'Series' : 'Series';

        const buttons = [
            { mode: FILTER_MODES.MIXED, label: allLabel },
            { mode: FILTER_MODES.MOVIES, label: moviesLabel },
            { mode: FILTER_MODES.TV, label: seriesLabel }
        ];

        buttons.forEach((btn, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'jellyseerr-filter-btn';
            button.setAttribute('data-mode', btn.mode);
            button.textContent = btn.label;

            // Segmented button styling
            let borderRadius = '0';
            if (index === 0) borderRadius = '4px 0 0 4px';
            if (index === buttons.length - 1) borderRadius = '0 4px 4px 0';

            const isActive = currentMode === btn.mode;
            button.style.cssText = `
                padding: 4px 10px;
                border: 1px solid rgba(255,255,255,0.3);
                border-radius: ${borderRadius};
                background: ${isActive ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)'};
                color: rgba(255,255,255,0.8);
                cursor: pointer;
                font-size: inherit;
                font-family: inherit;
                margin-left: ${index > 0 ? '-1px' : '0'};
                transition: background 0.15s, border-color 0.15s;
                font-weight: ${isActive ? '600' : '400'};
            `;

            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                const newMode = btn.mode;
                if (newMode === getFilterMode(moduleName)) return;

                setFilterMode(moduleName, newMode);

                // Update button states
                container.querySelectorAll('.jellyseerr-filter-btn').forEach(b => {
                    const isNowActive = b.getAttribute('data-mode') === newMode;
                    b.style.background = isNowActive ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
                    b.style.fontWeight = isNowActive ? '600' : '400';
                });

                if (onFilterChange) {
                    onFilterChange(newMode);
                }
            });

            // Hover effects
            button.addEventListener('mouseenter', () => {
                if (getFilterMode(moduleName) !== btn.mode) {
                    button.style.background = 'rgba(255,255,255,0.1)';
                }
            });
            button.addEventListener('mouseleave', () => {
                const isActive = getFilterMode(moduleName) === btn.mode;
                button.style.background = isActive ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
            });

            container.appendChild(button);
        });

        return container;
    }

    /**
     * Creates the sort control dropdown
     * @param {string} moduleName
     * @param {Function} onSortChange - Callback: (newSort) => void
     * @returns {HTMLElement}
     */
    function createSortControl(moduleName, onSortChange) {
        const currentSort = getSortMode(moduleName);

        const container = document.createElement('div');
        container.className = 'jellyseerr-discovery-sort';
        container.style.cssText = 'display:inline-flex;align-items:center;gap:0.4em;font-size:0.85em;margin-left:auto;';

        const label = document.createElement('span');
        label.textContent = 'Sort:';
        label.style.cssText = 'color:rgba(255,255,255,0.5);';
        container.appendChild(label);

        const select = document.createElement('select');
        select.className = 'jellyseerr-sort-select';
        select.style.cssText = `
            background: rgba(255,255,255,0.08);
            color: rgba(255,255,255,0.85);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 4px;
            padding: 3px 8px;
            font-size: inherit;
            font-family: inherit;
            cursor: pointer;
            outline: none;
        `;

        SORT_OPTIONS.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            option.style.cssText = 'background:#1a1a2e;color:#fff;';
            if (currentSort === opt.value) option.selected = true;
            select.appendChild(option);
        });

        select.addEventListener('change', () => {
            const newSort = select.value;
            setSortMode(moduleName, newSort);
            if (onSortChange) onSortChange(newSort);
        });

        container.appendChild(select);
        return container;
    }

    /**
     * Creates a section header with title, optional filter control, and sort dropdown
     * @param {string} title - Section title text
     * @param {string} moduleName - Module name for filter persistence
     * @param {boolean} showFilter - Whether to show the filter control
     * @param {Function} onFilterChange - Callback when filter changes
     * @param {Function} [onSortChange] - Callback when sort changes
     * @returns {HTMLElement} - The header element
     */
    function createSectionHeader(title, moduleName, showFilter, onFilterChange, onSortChange) {
        const header = document.createElement('div');
        header.className = 'jellyseerr-discovery-header';
        header.style.cssText = 'display:flex;align-items:baseline;gap:1em;margin-bottom:1em;flex-wrap:wrap;width:100%;';

        const titleElement = document.createElement('h2');
        titleElement.className = 'sectionTitle sectionTitle-cards';
        titleElement.textContent = title;
        titleElement.style.margin = '0';
        header.appendChild(titleElement);

        if (showFilter) {
            const filterControl = createFilterControl(moduleName, onFilterChange);
            header.appendChild(filterControl);
        }

        if (onSortChange) {
            const sortControl = createSortControl(moduleName, onSortChange);
            header.appendChild(sortControl);
        }

        return header;
    }

    /**
     * Managed fetch helper using request manager when available
     * @param {string} path - API path
     * @param {string} cachePrefix - Cache key prefix (e.g., 'genre', 'network')
     * @param {object} [options] - Fetch options including signal
     * @returns {Promise<any>}
     */
    async function fetchWithManagedRequest(path, cachePrefix, options = {}) {
        const url = ApiClient.getUrl(path);
        const { signal } = options;

        if (JE.requestManager) {
            const cacheKey = `${cachePrefix}:${path}`;
            const cached = JE.requestManager.getCached(cacheKey);
            if (cached) return cached;

            // Identity epoch at request start. Cache keys carry no user id and the
            // cache is flushed on a user switch, so a response that lands after the
            // switch must neither be cached nor handed back: it was fetched under
            // the previous user's permissions (and their parental filter).
            const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
            const stillCurrent = () => !JE.session || JE.session.isCurrent(requestEpoch);

            const fetchFn = async () => {
                const response = await JE.requestManager.fetchWithRetry(url, {
                    method: 'GET',
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId(),
                        // Jellyfin 12 authenticates from the Authorization header; the
                        // legacy X-Emby-Token is kept for 10.11 back-compat.
                        'Authorization': 'MediaBrowser Token="' + ApiClient.accessToken() + '"',
                        'X-Emby-Token': ApiClient.accessToken(),
                        'Accept': 'application/json'
                    },
                    signal
                });
                const data = await response.json();
                if (!stillCurrent()) {
                    throw new DOMException('User changed during request', 'AbortError');
                }
                JE.requestManager.setCache(cacheKey, data);
                return data;
            };

            // Dedup outside the pool (only the unique fetch holds a slot) and
            // re-check the cache after acquiring the slot, so a prefetch that
            // finished while we queued is not fetched again.
            return JE.requestManager.deduplicatedFetch(cacheKey, () =>
                JE.requestManager.withConcurrencyLimit(() => {
                    if (!stillCurrent()) {
                        return Promise.reject(new DOMException('User changed during request', 'AbortError'));
                    }
                    const hit = JE.requestManager.getCached(cacheKey);
                    return hit ? Promise.resolve(hit) : fetchFn();
                }),
                signal
            );
        }

        // Fallback to ApiClient.ajax
        return ApiClient.ajax({
            type: 'GET',
            url: url,
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
            dataType: 'json'
        });
    }

    // The TMDB genre lists ({id, name} per genre, one list for TV and one for
    // movies) are prefetched at startup so genre discovery has them at once.
    // They rarely change, so they are also kept in sessionStorage, per server
    // and user, for as long as the in-memory response cache keeps them (30
    // minutes): a reload in the same tab then reuses them instead of asking
    // the server again on every page load.
    const GENRE_LIST_STORAGE_PREFIX = 'je-tmdb-genres:';
    const GENRE_LIST_STORAGE_TTL_MS = 30 * 60 * 1000;

    /**
     * Builds the sessionStorage key for one TMDB genre list.
     * @param {'tv'|'movie'} mediaType - Which list
     * @returns {string|null} The key, or null while the server or user is unknown
     */
    function genreListStorageKey(mediaType) {
        const serverId = JE.session?.getServerId?.();
        const userId = JE.session?.getUserId?.();
        if (!serverId || !userId) return null;
        return `${GENRE_LIST_STORAGE_PREFIX}${serverId}:${userId}:${mediaType}`;
    }

    /**
     * Reads a stored TMDB genre list. Anything missing, expired, unreadable or
     * not shaped like a genre list counts as absent.
     * @param {string} key - Key from genreListStorageKey
     * @returns {Array<{id: number, name: string}>|null} The list, or null when absent
     */
    function readStoredGenreList(key) {
        try {
            const raw = sessionStorage.getItem(key);
            if (!raw) return null;
            const entry = JSON.parse(raw);
            const age = Date.now() - (typeof entry?.storedAt === 'number' ? entry.storedAt : NaN);
            if (!(age >= 0 && age < GENRE_LIST_STORAGE_TTL_MS)) return null;
            const genres = entry.genres;
            if (!Array.isArray(genres) || genres.length === 0) return null;
            const wellFormed = genres.every(g => g && typeof g.id === 'number' && typeof g.name === 'string');
            return wellFormed ? genres : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Fetches one TMDB genre list, from sessionStorage when this tab already
     * has a fresh copy, otherwise through fetchWithManagedRequest (shared
     * cache and in-flight dedup under the 'genre' prefix, as before) and then
     * stores it.
     * @param {'tv'|'movie'} mediaType - Which list
     * @param {object} [options] - Fetch options including signal
     * @returns {Promise<any>} The genre list (the endpoint's body when fetched)
     */
    async function fetchTmdbGenreList(mediaType, options = {}) {
        const storageKey = genreListStorageKey(mediaType);
        const stored = storageKey ? readStoredGenreList(storageKey) : null;
        if (stored) return stored;

        // Only keep a list fetched for the identity it was keyed under.
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const data = await fetchWithManagedRequest(`/JellyfinEnhanced/tmdb/genres/${mediaType}`, 'genre', options);
        if (storageKey && Array.isArray(data) && data.length > 0
            && (!JE.session || JE.session.isCurrent(requestEpoch))) {
            try {
                sessionStorage.setItem(storageKey, JSON.stringify({ storedAt: Date.now(), genres: data }));
            } catch (_) {
                // Storage full or unavailable: the next page load fetches again.
            }
        }
        return data;
    }

    // ---- Discovery resolution caches kept for the tab --------------------------
    // Which genre, studio or person a Jellyfin page is, and which TMDB genre,
    // company or person that maps to, is the same for every user and rarely
    // changes, yet resolving it costs one or two round trips before a
    // discovery section can fetch its first page. The modules' lookup caches
    // therefore also live in sessionStorage, per server and for
    // RESOLUTION_STORAGE_TTL_MS: a reload in the same tab resolves at once.
    const RESOLUTION_STORAGE_PREFIX = 'je-discovery-resolution:';
    const RESOLUTION_STORAGE_TTL_MS = 30 * 60 * 1000;
    const RESOLUTION_STORAGE_MAX_ENTRIES = 200;

    /**
     * A Map-like lookup cache (has / get / set) whose entries are also kept
     * in sessionStorage, one entry set per server. Stored entries that are
     * expired, malformed or rejected by `isValid` are ignored; storage that is
     * full or unavailable leaves the cache working from memory.
     * @param {string} name - Cache name, part of the storage key
     * @param {function(*): boolean} isValid - Whether a stored value is well-formed
     * @returns {{has: function(string): boolean, get: function(string): *, set: function(string, *): void}}
     */
    function createSessionCache(name, isValid) {
        // Storage key -> Map(key -> {value, storedAt}); the null key holds a
        // memory-only cache while the server is unknown.
        const caches = new Map();

        /** @returns {string|null} sessionStorage key for the current server */
        const storageKey = () => {
            const serverId = JE.session?.getServerId?.();
            return serverId ? `${RESOLUTION_STORAGE_PREFIX}${serverId}:${name}` : null;
        };

        /**
         * Reads the stored entries for one storage key, keeping only fresh,
         * well-formed ones.
         * @param {string|null} key
         * @returns {Map<string, {value: *, storedAt: number}>}
         */
        const load = (key) => {
            const entries = new Map();
            if (!key) return entries;
            try {
                const parsed = JSON.parse(sessionStorage.getItem(key) || 'null');
                const stored = parsed && typeof parsed === 'object' ? parsed.entries : null;
                if (!stored || typeof stored !== 'object') return entries;
                const now = Date.now();
                for (const [k, entry] of Object.entries(stored)) {
                    const age = now - (typeof entry?.storedAt === 'number' ? entry.storedAt : NaN);
                    if (!(age >= 0 && age < RESOLUTION_STORAGE_TTL_MS)) continue;
                    if (!isValid(entry.value)) continue;
                    entries.set(k, { value: entry.value, storedAt: entry.storedAt });
                }
            } catch (_) {
                // Unreadable or not ours: start empty.
            }
            return entries;
        };

        /** @returns {{key: (string|null), entries: Map<string, {value: *, storedAt: number}>}} */
        const current = () => {
            const key = storageKey();
            let entries = caches.get(key);
            if (!entries) {
                entries = load(key);
                caches.set(key, entries);
            }
            return { key, entries };
        };

        /**
         * @param {Map<string, {value: *, storedAt: number}>} entries
         * @param {string} k
         * @returns {boolean} The entry exists and has not expired
         */
        const fresh = (entries, k) => {
            const entry = entries.get(k);
            if (!entry) return false;
            if (Date.now() - entry.storedAt < RESOLUTION_STORAGE_TTL_MS) return true;
            entries.delete(k);
            return false;
        };

        return {
            has(k) {
                return fresh(current().entries, String(k));
            },
            get(k) {
                const { entries } = current();
                return fresh(entries, String(k)) ? entries.get(String(k)).value : undefined;
            },
            set(k, value) {
                const { key, entries } = current();
                entries.delete(String(k));
                entries.set(String(k), { value, storedAt: Date.now() });
                // Oldest first (insertion order): drop the oldest over the cap.
                while (entries.size > RESOLUTION_STORAGE_MAX_ENTRIES) {
                    entries.delete(entries.keys().next().value);
                }
                if (!key || !isValid(value)) return;
                try {
                    const stored = {};
                    entries.forEach((entry, entryKey) => {
                        if (isValid(entry.value)) stored[entryKey] = entry;
                    });
                    sessionStorage.setItem(key, JSON.stringify({ entries: stored }));
                } catch (_) {
                    // Storage full or unavailable: the cache keeps working from memory.
                }
            }
        };
    }

    /**
     * The results a discovery batch renders cards for, in order: hidden
     * content, duplicates within the batch and (when the admin excludes them)
     * library and blocklisted items are dropped.
     * @param {Array} results - Array of items
     * @returns {Array} The items to create cards for
     */
    function filterCardResults(results) {
        const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        const excludeBlocklistedItems = JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true;
        const seen = new Set();
        const items = [];

        // Filter hidden content before rendering
        const filteredResults = JE.hiddenContent
            ? JE.hiddenContent.filterJellyseerrResults(results, 'discovery')
            : results;

        for (let i = 0; i < filteredResults.length; i++) {
            const item = filteredResults[i];

            // Deduplicate by TMDB ID
            const key = `${item.mediaType}-${item.id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) {
                continue;
            }

            if (excludeBlocklistedItems && item.mediaInfo?.status === JE.seerrStatus.MEDIA.BLOCKED) {
                continue;
            }
            items.push(item);
        }
        return items;
    }

    /**
     * Creates one discovery card: the shared Seerr card with the section's
     * card class, its media type for CSS filtering, and the title linking to
     * the Jellyfin item when the item is in the library.
     * @param {Object} item - Seerr result
     * @param {string} cardClass - 'portraitCard' or 'overflowPortraitCard'
     * @returns {HTMLElement|null}
     */
    function createDiscoveryCard(item, cardClass) {
        const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
        if (!card) return null;

        const classList = card.classList;
        // Remove both possible classes and add the desired one
        classList.remove('portraitCard', 'overflowPortraitCard');
        classList.add(cardClass);

        // Add media type for fast CSS-based filtering
        card.setAttribute('data-media-type', item.mediaType);

        const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId;
        if (jellyfinMediaId) {
            card.setAttribute('data-library-item', 'true');
            card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
            classList.add('jellyseerr-card-in-library');

            const titleLink = card.querySelector('.cardText-first a');
            if (titleLink) {
                const itemName = item.title || item.name;
                titleLink.textContent = itemName;
                titleLink.title = itemName;
                titleLink.href = `#!/details?id=${jellyfinMediaId}`;
                titleLink.removeAttribute('target');
                titleLink.removeAttribute('rel');
            }
        }
        return card;
    }

    /**
     * Creates cards and returns a DocumentFragment for batch DOM insertion
     * @param {Array} results - Array of items to create cards for
     * @param {object} [options] - Options
     * @param {string} [options.cardClass] - Card class to use ('portraitCard' or 'overflowPortraitCard')
     * @returns {DocumentFragment}
     */
    function createCardsFragment(results, options = {}) {
        const { cardClass = 'portraitCard' } = options;
        const fragment = document.createDocumentFragment();
        for (const item of filterCardResults(results)) {
            const card = createDiscoveryCard(item, cardClass);
            if (card) fragment.appendChild(card);
        }
        return fragment;
    }

    // ---- Batches built in short slices ------------------------------------------
    // A load can bring 80-160 cards, and building them all in one go was one
    // long task. The cards that land where the viewer can see them (or within
    // half a screen of it) are still built and appended at once. The rest of
    // the batch, which the scroll engine renders well below the fold, is built
    // off-document in slices of BUILD_SLICE_MS with the browser free to handle
    // input and draw frames in between, then appended in one go — so it is
    // still laid out in a single frame: every frame that changes the page costs
    // a share proportional to the whole page (layout, paint, layerization), and
    // appending slice by slice would pay that share once per slice.
    const BUILD_SLICE_MS = 8;

    // Task-queue yield (no timer clamping, no throttling in hidden tabs).
    const yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
    const yieldWaiters = [];
    if (yieldChannel) {
        yieldChannel.port1.onmessage = () => {
            const resume = yieldWaiters.shift();
            if (resume) resume();
        };
    }

    /**
     * Resolves in a later task, letting the browser run input handlers and
     * render a frame in between.
     * @returns {Promise<void>}
     */
    function yieldToBrowser() {
        if (!yieldChannel) return new Promise(resolve => setTimeout(resolve, 0));
        return new Promise((resolve) => {
            yieldWaiters.push(resolve);
            yieldChannel.port2.postMessage(null);
        });
    }

    /**
     * How many cards appended to the end of a container would land on screen
     * or within half a screen past its edge: the part of a batch that must be
     * appended at once so nothing pops in where the viewer is looking.
     * @param {HTMLElement} container - Element holding the .card elements
     * @param {object} [options]
     * @param {boolean} [options.horizontal=false] - A horizontal row (cards extend to the right)
     * @returns {number}
     */
    function cardsInView(container, options = {}) {
        const scroll = JE.seamlessScroll;
        if (!scroll?.cardsNeeded || !container.isConnected) return 0;
        const rect = container.getBoundingClientRect();
        if (options.horizontal) {
            // A row above or below the screen shows none of its new cards.
            if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.height === 0) return 0;
            let last = container.lastElementChild;
            while (last && !last.classList.contains('card')) last = last.previousElementSibling;
            const end = last ? last.getBoundingClientRect().right : rect.left;
            const gapPx = window.innerWidth * 1.5 - end;
            return gapPx > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx, horizontal: true }, 20) : 0;
        }
        const gapPx = window.innerHeight * 1.5 - rect.bottom;
        return gapPx > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx }, 40) : 0;
    }

    /**
     * Appends cards for `items` to the end of `container`: the first
     * `syncCount` (the ones in view) at once, the rest built in short slices
     * across tasks and appended together at the end. The returned promise
     * settles once every card is in, so a caller reporting to the scroll
     * engine measures the whole batch.
     * @param {HTMLElement} container
     * @param {Array} items - Items to render, in order
     * @param {function(Object): (HTMLElement|null)} createCard - Builds one item's card
     * @param {object} [options]
     * @param {number} [options.syncCount=0] - Cards that must be appended synchronously
     * @param {function(): boolean} [options.isCurrent] - False once the batch is
     *   superseded (navigation, re-sort): the cards not appended yet are dropped
     * @returns {Promise<number>} Number of cards appended
     */
    async function appendInSlices(container, items, createCard, options = {}) {
        const { syncCount = 0, isCurrent = () => true } = options;
        let index = 0;
        /**
         * Builds cards into a fragment: at least `minCount`, then more while
         * the slice is under `budgetMs` of script time.
         * @param {DocumentFragment} fragment
         * @param {number} minCount
         * @param {number} budgetMs
         * @returns {number} Cards built
         */
        const build = (fragment, minCount, budgetMs) => {
            const start = performance.now();
            let count = 0;
            while (index < items.length && (count < minCount || performance.now() - start < budgetMs)) {
                const card = createCard(items[index++]);
                if (card) {
                    fragment.appendChild(card);
                    count++;
                }
            }
            return count;
        };

        let appended = 0;
        if (syncCount > 0) {
            const visible = document.createDocumentFragment();
            appended = build(visible, syncCount, 0);
            if (appended > 0) container.appendChild(visible);
        }
        const rest = document.createDocumentFragment();
        let built = build(rest, 0, BUILD_SLICE_MS);
        while (index < items.length) {
            await yieldToBrowser();
            if (!isCurrent()) {
                // Dropped: stop watching the posters of the cards built so far.
                JE.jellyseerrUI?.releasePosters?.(rest);
                return appended;
            }
            built += build(rest, 1, BUILD_SLICE_MS);
        }
        if (built > 0) container.appendChild(rest);
        return appended + built;
    }

    /**
     * Renders a discovery batch into a grid: the same cards as
     * createCardsFragment, the ones the viewer can see appended at once and
     * the rest built in short slices (appendInSlices).
     * @param {HTMLElement} container - The section's itemsContainer
     * @param {Array} results - The batch
     * @param {object} [options]
     * @param {string} [options.cardClass='portraitCard'] - Card class
     * @param {function(): boolean} [options.isCurrent] - See appendInSlices
     * @returns {Promise<number>} Number of cards appended
     */
    function appendCards(container, results, options = {}) {
        const { cardClass = 'portraitCard', isCurrent } = options;
        const items = filterCardResults(results);
        if (items.length === 0) return Promise.resolve(0);
        return appendInSlices(container, items, item => createDiscoveryCard(item, cardClass), {
            syncCount: cardsInView(container),
            isCurrent
        });
    }

    /**
     * Wait for the page to be ready (active page only, not hidden)
     * @param {AbortSignal} [signal] - Optional abort signal
     * @param {object} [options] - Options
     * @param {string} [options.type] - Type of page: 'list' or 'detail'
     * @returns {Promise<HTMLElement|null>}
     */
    // Unique id per wait: body subscribers are keyed by id, and two discovery
    // modules can wait on the same page at once (person + collection on a detail).
    let containerDetectSeq = 0;

    function waitForPageReady(signal, options = {}) {
        const { type = 'list', getView = null, isStalePage = null } = options;

        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve(null);
                return;
            }

            const checkContainer = (allowStale = false) => {
                if (type === 'detail') {
                    // Jellyfin 12 dropped the .detailPageContent wrapper; fall back to
                    // .detailPageSecondaryContainer, then the page itself.
                    const detailContent = document.querySelector('.itemDetailPage:not(.hide) .detailPageContent') ||
                                          document.querySelector('.itemDetailPage:not(.hide) .detailPageSecondaryContainer') ||
                                          document.querySelector('.itemDetailPage:not(.hide)');
                    return detailContent;
                }
                // List page. Prefer the view element the router just showed (it is
                // the page for this navigation by definition). Otherwise take the
                // visible list container — but during a transition the visible page
                // is still the OLD one, so a page that already existed when the
                // navigation started is stale until a new one appears. The container
                // merely existing is enough: waiting for Jellyfin to fill it (a slow
                // library query) would hold the Seerr section back.
                const view = getView?.();
                if (view) {
                    const viewContainer = view.querySelector('.itemsContainer');
                    if (viewContainer) return viewContainer;
                }
                const candidates = document.querySelectorAll('.page:not(.hide) .itemsContainer, .libraryPage:not(.hide) .itemsContainer');
                let staleFallback = null;
                for (const candidate of candidates) {
                    if (!isStalePage || !isStalePage(candidate.closest('.page, .libraryPage'))) return candidate;
                    // Same element reused for the new route (no new page appeared in
                    // time): accept it once it holds items, as the old code did.
                    if (allowStale && candidate.children.length > 0 && !staleFallback) staleFallback = candidate;
                }
                return staleFallback;
            };

            const immediate = checkContainer();
            if (immediate) {
                resolve(immediate);
                return;
            }

            let observerHandle = null;
            let timeoutId = null;

            let cleanup = () => {
                if (observerHandle) {
                    observerHandle.unsubscribe();
                    observerHandle = null;
                }
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };

            if (signal) {
                signal.addEventListener('abort', () => {
                    cleanup();
                    resolve(null);
                }, { once: true });
            }

            let allowStale = false;
            const recheck = () => {
                const container = checkContainer(allowStale);
                if (container) {
                    cleanup();
                    resolve(container);
                }
            };
            observerHandle = JE.helpers.onBodyMutation(`jellyseerr-discovery-container-detect-${++containerDetectSeq}`, recheck);
            // The router hides the old page by toggling a class, which the body
            // observer does not report; a light poll catches that.
            const pollId = setInterval(recheck, 100);
            const stopPoll = () => clearInterval(pollId);
            if (signal) signal.addEventListener('abort', stopPoll, { once: true });
            // Bounded wait for the reused-element case: past this the visible page
            // is accepted even if it looks stale, as long as it holds items. When NO
            // page is visible at all — the router has hidden the old one and is still
            // loading the new one, which a cold list query can hold for seconds —
            // keep waiting instead of answering null: giving up here left the section
            // off the page for good, because the render still in progress swallows
            // the re-entry the router's later 'viewshow' would have triggered.
            timeoutId = setTimeout(() => {
                allowStale = true;
                recheck();
                if (!timeoutId) return; // resolved
                timeoutId = setTimeout(() => {
                    cleanup();
                    resolve(checkContainer(true));
                }, 30000);
            }, type === 'list' ? 1500 : 3000);
            const originalCleanup = cleanup;
            cleanup = () => { stopPoll(); originalCleanup(); };
        });
    }

    /**
     * Sets up infinite scroll using seamlessScroll module
     * Features:
     * - Larger prefetch window (~2 viewport heights)
     * - Retry UI on failure
     * - Scroll event fallback
     * @param {object} state - State object with activeScrollObserver property
     * @param {string} sectionSelector - CSS selector for the section
     * @param {Function} loadMoreFn - Function to call when more items needed
     * @param {Function} hasMoreCheck - Function that returns whether more pages exist
     * @param {Function} isLoadingCheck - Function that returns whether currently loading
     */
    function setupInfiniteScroll(state, sectionSelector, loadMoreFn, hasMoreCheck, isLoadingCheck, options) {
        JE.seamlessScroll.setupInfiniteScroll(
            state, sectionSelector, loadMoreFn, hasMoreCheck, isLoadingCheck, options
        );
    }

    /**
     * Cleanup scroll observer
     * @param {object} state - State object with activeScrollObserver property
     */
    function cleanupScrollObserver(state) {
        JE.seamlessScroll.cleanupInfiniteScroll(state);
    }

    /**
     * Applies filter visibility using CSS classes (fast, no DOM rebuild)
     * @param {HTMLElement} container - The items container
     * @param {string} mode - 'mixed', 'movies', or 'tv'
     */
    function applyFilterVisibility(container, mode) {
        if (!container) return;

        // Remove existing filter class from container
        container.classList.remove('filter-movies', 'filter-tv');

        if (mode === FILTER_MODES.MOVIES) {
            container.classList.add('filter-movies');
        } else if (mode === FILTER_MODES.TV) {
            container.classList.add('filter-tv');
        }
        // 'mixed' mode: no class = all visible
    }

    /**
     * Injects CSS rules for fast filter visibility (once per page)
     */
    function injectFilterStyles() {
        if (document.getElementById('jellyseerr-filter-styles')) return;

        const style = document.createElement('style');
        style.id = 'jellyseerr-filter-styles';
        style.textContent = `
            .filter-movies [data-media-type="tv"] { display: none !important; }
            .filter-tv [data-media-type="movie"] { display: none !important; }
        `;
        document.head.appendChild(style);
    }

    // Inject styles on load
    injectFilterStyles();

    // Export utilities
    JE.discoveryFilter = {
        MODES: FILTER_MODES,
        SORT_OPTIONS,
        getFilterMode,
        setFilterMode,
        resetFilterMode,
        getSortMode,
        getTvSortMode,
        setSortMode,
        resetSortMode,
        interleaveArrays,
        filterByMediaType,
        hasBothTypes,
        resultHasBothTypes,
        createFilterControl,
        createSortControl,
        createSectionHeader,
        // Shared utilities
        fetchWithManagedRequest,
        fetchTmdbGenreList,
        createSessionCache,
        createCardsFragment,
        appendCards,
        appendInSlices,
        cardsInView,
        waitForPageReady,
        setupInfiniteScroll,
        cleanupScrollObserver,
        applyFilterVisibility
    };

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
