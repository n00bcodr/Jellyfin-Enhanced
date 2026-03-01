// /js/jellyseerr/discovery-filter-utils.js
// Shared utilities for discovery section content type filtering
(function(JE) {
    'use strict';

    const FILTER_MODES = {
        MIXED: 'mixed',
        MOVIES: 'movies',
        TV: 'tv'
    };
    const runtimeFilterModes = new Map();

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
     * Creates a section header with title and optional filter control
     * @param {string} title - Section title text
     * @param {string} moduleName - Module name for filter persistence
     * @param {boolean} showFilter - Whether to show the filter control
     * @param {Function} onFilterChange - Callback when filter changes
     * @returns {HTMLElement} - The header element
     */
    function createSectionHeader(title, moduleName, showFilter, onFilterChange) {
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

            const fetchFn = async () => {
                const response = await JE.requestManager.fetchWithRetry(url, {
                    method: 'GET',
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId(),
                        'X-Emby-Token': ApiClient.accessToken(),
                        'Accept': 'application/json'
                    },
                    signal
                });
                const data = await response.json();
                JE.requestManager.setCache(cacheKey, data);
                return data;
            };

            return JE.requestManager.withConcurrencyLimit(() =>
                JE.requestManager.deduplicatedFetch(cacheKey, fetchFn)
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
        const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        const excludeBlocklistedItems = JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true;
        const seen = new Set();

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

            if (excludeBlocklistedItems && item.mediaInfo?.status === 6) { // Status 6 = Blocklisted
                continue;
            }
            const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
            if (!card) continue;

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

            fragment.appendChild(card);
        }

        return fragment;
    }

    /**
     * Wait for the page to be ready (active page only, not hidden)
     * @param {AbortSignal} [signal] - Optional abort signal
     * @param {object} [options] - Options
     * @param {string} [options.type] - Type of page: 'list' or 'detail'
     * @returns {Promise<HTMLElement|null>}
     */
    function waitForPageReady(signal, options = {}) {
        const { type = 'list' } = options;

        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve(null);
                return;
            }

            const checkContainer = () => {
                if (type === 'detail') {
                    const detailContent = document.querySelector('.itemDetailPage:not(.hide) .detailPageContent') ||
                                          document.querySelector('.itemDetailPage:not(.hide)');
                    return detailContent;
                }
                // List page
                const listContainer = document.querySelector('.page:not(.hide) .itemsContainer') ||
                                      document.querySelector('.libraryPage:not(.hide) .itemsContainer');
                return listContainer?.children.length > 0 ? listContainer : null;
            };

            const immediate = checkContainer();
            if (immediate) {
                resolve(immediate);
                return;
            }

            let observer = null;
            let timeoutId = null;

            const cleanup = () => {
                if (observer) {
                    observer.disconnect();
                    observer = null;
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

            observer = new MutationObserver(() => {
                const container = checkContainer();
                if (container) {
                    cleanup();
                    resolve(container);
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });
            timeoutId = setTimeout(() => {
                cleanup();
                resolve(checkContainer());
            }, 3000);
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
    function setupInfiniteScroll(state, sectionSelector, loadMoreFn, hasMoreCheck, isLoadingCheck) {
        JE.seamlessScroll.setupInfiniteScroll(
            state, sectionSelector, loadMoreFn, hasMoreCheck, isLoadingCheck
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
        getFilterMode,
        setFilterMode,
        interleaveArrays,
        filterByMediaType,
        hasBothTypes,
        resultHasBothTypes,
        createFilterControl,
        createSectionHeader,
        resetFilterMode,
        // Shared utilities
        fetchWithManagedRequest,
        createCardsFragment,
        waitForPageReady,
        setupInfiniteScroll,
        cleanupScrollObserver,
        applyFilterVisibility
    };

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
