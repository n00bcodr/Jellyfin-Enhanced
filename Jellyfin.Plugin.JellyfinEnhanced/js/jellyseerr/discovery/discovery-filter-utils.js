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
        { value: '', label: 'Popular', labelKey: 'discovery_sort_popular' },
        { value: 'vote_average.desc', label: 'Top rated', labelKey: 'discovery_sort_top_rated' },
        { value: 'vote_count.desc', label: 'Most votes', labelKey: 'discovery_sort_most_votes' },
        { value: 'release_date.desc', label: 'Newest', labelKey: 'discovery_sort_newest' },
        { value: 'release_date.asc', label: 'Oldest', labelKey: 'discovery_sort_oldest' }
    ];
    // Per header's tabs: the All / Movies / Series choice, for the Filters menu to offer where the tabs are out of sight.
    const typePickers = new WeakMap();

    /**
     * A translated string, in English where the key has no translation, with its {placeholders} filled.
     * @param {string} key - Locale key
     * @param {string} fallback - English text
     * @param {Object<string, (string|number)>} [values] - Placeholder values
     * @returns {string}
     */
    function label(key, fallback, values) {
        const text = typeof JE?.t === 'function' ? JE.t(key, values) : '';
        let said = text && text !== key ? text : fallback;
        for (const [name, value] of Object.entries(values ?? {})) said = said.replace(`{${name}}`, String(value));
        return said;
    }

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
     * Resets module filter mode back to default. A section starts with nothing narrowing it:
     * neither the type nor the further filters.
     * @param {string} moduleName
     */
    function resetFilterMode(moduleName) {
        runtimeFilterModes.delete(moduleName);
        JE.discoveryFilters?.reset?.(moduleName);
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
     * All / Movies / Series as Jellyfin's own tab buttons, so the active theme styles them.
     * Given a title (a section's header), it also carries what its row shows on a phone while the
     * header is held at the top of the screen: that title in the tabs' place. (The choice itself is
     * then in the Filters menu, beside it.)
     * @param {string} moduleName - Module name for the runtime state
     * @param {Function} [onFilterChange] - Callback when the type changes: (newMode) => void
     * @param {string} [heldTitle] - The section's title, for its held row on a phone
     * @returns {HTMLElement} - The filter control container
     */
    function createFilterControl(moduleName, onFilterChange, heldTitle) {
        const filterLabel = label('discovery_filter_label', 'Filter');
        const container = document.createElement('div');
        container.className = 'jellyseerr-discovery-filter';
        container.setAttribute('role', 'group');
        container.setAttribute('aria-label', filterLabel);
        const buttons = [
            { mode: FILTER_MODES.MIXED, label: label('jellyseerr_discover_all', 'All') },
            { mode: FILTER_MODES.MOVIES, label: label('jellyseerr_quota_label_movie', 'Movies') },
            { mode: FILTER_MODES.TV, label: label('jellyseerr_quota_label_tv', 'Series') }
        ];
        /** Marks the type in use on its tab. */
        const paint = () => {
            const mode = getFilterMode(moduleName);
            for (const tab of container.querySelectorAll('.jellyseerr-filter-btn')) {
                const active = tab.getAttribute('data-mode') === mode;
                tab.classList.toggle('emby-tab-button-active', active);
                tab.setAttribute('aria-pressed', String(active));
            }
        };
        /**
         * Takes a type: the tabs, the Filters button beside them, then the list.
         * @param {string} mode
         */
        const choose = (mode) => {
            if (mode === getFilterMode(moduleName)) return;
            setFilterMode(moduleName, mode);
            paint();
            JE.discoveryFilters?.repaint?.(container.closest('.jellyseerr-discovery-header') ?? container);
            onFilterChange?.(mode);
        };
        for (const entry of buttons) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'jellyseerr-filter-btn emby-tab-button emby-button';
            button.setAttribute('data-mode', entry.mode);
            button.textContent = entry.label;
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                choose(entry.mode);
            });
            container.appendChild(button);
        }
        if (heldTitle) {
            // The heading itself is still on the page (above, out of sight): this copy is for the eye only.
            const held = document.createElement('span');
            held.className = 'jellyseerr-filter-held';
            const title = document.createElement('span');
            title.className = 'jellyseerr-filter-held-title';
            title.setAttribute('aria-hidden', 'true');
            title.textContent = heldTitle;
            held.appendChild(title);
            container.appendChild(held);
        }
        container.dataset.typeGroup = '';
        typePickers.set(container, {
            groupOf: () => ({
                id: 'type', name: label('discovery_filter_type', 'Type'),
                choices: buttons.map(entry => ({ id: entry.mode, name: entry.label, selected: entry.mode === getFilterMode(moduleName) }))
            }),
            choose,
            // (Known from what puts them out of sight, a held header at a phone's width, as the stylesheet has
            // it: their own style is no guide while they are still fading.)
            tabsShowing: () => !(container.closest('.jellyseerr-discovery-header')?.hasAttribute('data-stuck')
                && window.matchMedia?.('(max-width: 34em)').matches)
        });
        paint();
        return container;
    }

    /**
     * The All / Movies / Series choice of a header's tabs, for the Filters menu to offer where the
     * tabs are out of sight.
     * @param {Element|null} tabs - The tabs' container (it carries [data-type-group])
     * @returns {{groupOf: function(): Object, choose: function(string): void, tabsShowing: function(): boolean}|undefined}
     */
    function typePickerOf(tabs) {
        return tabs ? typePickers.get(tabs) : undefined;
    }

    /**
     * The sort control: a quiet text button in the filter tabs' type that names the current order
     * and opens a menu of the others (Jellyfin's action sheet, not the browser's select list).
     * @param {string} moduleName
     * @param {Function} [onSortChange] - Callback: (newSort) => void
     * @returns {HTMLElement}
     */
    function createSortControl(moduleName, onSortChange) {
        const sortLabel = label('discovery_sort_label', 'Sort');
        /** @param {string} value */
        const nameOf = (value) => {
            const entry = SORT_OPTIONS.find(option => option.value === value) ?? SORT_OPTIONS[0];
            return entry ? label(entry.labelKey, entry.label) : '';
        };
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jellyseerr-sort-btn emby-tab-button emby-button';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        const text = document.createElement('span');
        const chevron = document.createElement('span');
        chevron.className = 'material-icons expand_more';
        chevron.setAttribute('aria-hidden', 'true');
        button.append(text, chevron);
        /** Names the order in use. */
        const paint = () => {
            const current = nameOf(getSortMode(moduleName));
            text.textContent = current;
            // The visible word is the order; the label says what the button is for.
            button.setAttribute('aria-label', `${sortLabel}: ${current}`);
        };
        paint();
        button.addEventListener('click', () => {
            const current = getSortMode(moduleName);
            button.setAttribute('aria-expanded', 'true');
            JE.discoveryMenu?.openMenu({
                anchor: button, title: sortLabel, onClose: () => button.setAttribute('aria-expanded', 'false'),
                choices: SORT_OPTIONS.map(option => ({ id: option.value, name: label(option.labelKey, option.label), selected: option.value === current })),
                onPick(value) {
                    if (value === getSortMode(moduleName)) return;
                    setSortMode(moduleName, value);
                    paint();
                    JE.discoveryBusy?.hold?.(button);
                    onSortChange?.(value);
                }
            });
        });
        return button;
    }

    /**
     * Puts the filter in a header's bar, before the sort, so the two share a row.
     * @param {Element} header - A section's header
     * @param {string} moduleName
     * @param {Function} [onFilterChange] - Callback when the type changes: (newMode) => void
     */
    function addFilterControl(header, moduleName, onFilterChange) {
        const bar = header.querySelector('.jellyseerr-discovery-bar');
        if (!bar || bar.querySelector('.jellyseerr-discovery-filter')) return;
        bar.prepend(createFilterControl(moduleName, onFilterChange, header.querySelector('.sectionTitle')?.textContent || undefined));
        // On the bar for its own layout, and on the header for its compact form.
        bar.setAttribute('data-has-filter', '');
        header.setAttribute('data-has-filter', '');
    }

    /**
     * Creates a section header: the title; under it one row: what the titles are, in words, and the
     * controls (All / Movies / Series, the Filters button, the sort).
     * @param {string} title - Section title text
     * @param {string} moduleName - Module name for the runtime state
     * @param {boolean} showFilter - Whether to show the All / Movies / Series tabs now
     * @param {Function} [onFilterChange] - Callback when the type changes
     * @param {Function} [onSortChange] - Callback when the sort (or a further filter) changes
     * @param {string} [subject] - The name the title is about, kept whole when the title wraps
     * @param {'feed'|'person'} [scope='feed'] - Which further filters the section can offer
     * @returns {HTMLElement} - The header element
     */
    function createSectionHeader(title, moduleName, showFilter, onFilterChange, onSortChange, subject, scope = 'feed') {
        const header = document.createElement('div');
        header.className = 'jellyseerr-discovery-header';
        // Said only when it is true: the admin's setting leaves library titles out of these sections.
        const notInLibrary = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        // The words of the line that goes to this section from the top of a long list page: what
        // pressing it does (with the title), then the rest of the phrase.
        const [lead = '', rest = ''] = (notInLibrary
            ? label('discovery_go_to_not_in_library', 'Go to {title}, not in your library')
            : label('discovery_go_to', 'Go to {title}')).split('{title}');
        header.setAttribute('data-jump-label', `${lead}${title}`);
        if (rest) header.setAttribute('data-jump-note', rest);
        // The title; under it one row: what the titles are, in words, and the controls.
        const name = document.createElement('h2');
        name.className = 'sectionTitle sectionTitle-cards';
        // The name the title is about is kept whole when the title takes two lines ("More from" / "Channel 4 Television").
        const at = subject ? title.indexOf(subject) : -1;
        if (subject && at >= 0) {
            const whole = document.createElement('span');
            whole.className = 'jellyseerr-discovery-name';
            whole.textContent = subject;
            name.append(title.slice(0, at), whole, title.slice(at + subject.length));
        } else name.textContent = title;
        const meta = document.createElement('div');
        meta.className = 'jellyseerr-discovery-meta';
        // While the header is held at the top of the screen this row shows the title in the summary's place.
        meta.setAttribute('data-title', title);
        const bar = document.createElement('div');
        bar.className = 'jellyseerr-discovery-bar';
        if (notInLibrary) {
            const summary = document.createElement('p');
            summary.className = 'jellyseerr-discovery-summary';
            summary.textContent = label('discovery_not_in_library', 'Not in your library');
            meta.appendChild(summary);
        }
        if (onSortChange) {
            // (On a genre's page that genre is given: its Genres list says so.)
            const filters = JE.discoveryFilters?.createFiltersControl?.(header, moduleName, scope,
                () => onSortChange(getSortMode(moduleName)), moduleName === 'genre' ? subject : undefined);
            if (filters) bar.appendChild(filters);
            bar.appendChild(createSortControl(moduleName, onSortChange));
        }
        meta.appendChild(bar);
        header.append(name, meta);
        if (showFilter) addFilterControl(header, moduleName, onFilterChange);
        return header;
    }

    /**
     * What a feed's request carries after its page: the order, then the further filters.
     * @param {string} moduleName
     * @param {'tv'|'movie'} kind
     * @returns {string} Query string part, starting with '&' (or empty)
     */
    function feedQuery(moduleName, kind) {
        const sort = kind === 'tv' ? getTvSortMode(moduleName) : getSortMode(moduleName);
        return `${sort ? `&sortBy=${encodeURIComponent(sort)}` : ''}${JE.discoveryFilters?.feedQuery?.(moduleName, kind) ?? ''}`;
    }

    /**
     * A person's titles as the further filters keep them (all of them when none is set).
     * @param {string} moduleName
     * @param {Array} results
     * @returns {Array}
     */
    function keepByFilters(moduleName, results) {
        return JE.discoveryFilters?.keep?.(moduleName, results) ?? results;
    }

    /**
     * Whether any further filter is narrowing a section.
     * @param {string} moduleName
     * @returns {boolean}
     */
    function hasMoreFilters(moduleName) {
        return !!JE.discoveryFilters?.active?.(moduleName);
    }

    /**
     * The rebuilt list takes its own height, and says so when the further filters leave it empty,
     * with the way out. `hasMore`: Seerr has more to look through, so not yet.
     * @param {string} moduleName
     * @param {HTMLElement} container - The section's itemsContainer
     * @param {boolean} hasMore
     */
    function noteIfEmpty(moduleName, container, hasMore) {
        JE.discoveryBusy?.release?.(container);
        JE.discoveryFilters?.noteIfEmpty?.(moduleName, container, hasMore);
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
                const requestedAt = JE.requestManager.cacheStamp?.();
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
                JE.requestManager.setCache(cacheKey, data, requestedAt);
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
    // company or person that maps to, rarely changes, yet resolving it costs
    // one or two round trips before a discovery section can fetch its first
    // page. The modules' lookup caches therefore also live in sessionStorage,
    // for RESOLUTION_STORAGE_TTL_MS: a reload in the same tab resolves at once.
    // They are kept per server AND per user: the lookups run as the signed-in
    // user (library access, Seerr results filtered by the user's policy), so
    // one user's resolution must never be handed to the next user signing in
    // in the same tab.
    const RESOLUTION_STORAGE_PREFIX = 'je-discovery-resolution-v2:';
    // Entries written per server only (before they were scoped by user):
    // never read, removed on first use.
    const RESOLUTION_STORAGE_LEGACY_PREFIX = 'je-discovery-resolution:';
    const RESOLUTION_STORAGE_TTL_MS = 30 * 60 * 1000;
    const RESOLUTION_STORAGE_MAX_ENTRIES = 200;
    // Stands in for the server id while it is unknown (no Jellyfin server id
    // is empty): those entries are never written to sessionStorage.
    const MEMORY_ONLY_SERVER = '';
    let legacyResolutionStoragePurged = false;

    /**
     * Removes the resolution entries stored under the old server-only keys
     * (once per page load).
     */
    function purgeLegacyResolutionStorage() {
        if (legacyResolutionStoragePurged) return;
        legacyResolutionStoragePurged = true;
        try {
            for (let i = sessionStorage.length - 1; i >= 0; i--) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith(RESOLUTION_STORAGE_LEGACY_PREFIX)) sessionStorage.removeItem(key);
            }
        } catch (_) {
            // Storage unavailable: nothing to clean up.
        }
    }

    /**
     * A lookup cache whose entries are also kept in sessionStorage, one entry
     * set per server and user. `scope()` binds has / get / set to the user
     * signed in when it is called: a lookup takes its scope before it awaits
     * anything, so a result that lands after a user switch is stored for the
     * user it was fetched for. While no user is known nothing is cached; while
     * the server is unknown the user's entries stay in memory only. Stored
     * entries that are expired, malformed or rejected by `isValid` are
     * ignored; storage that is full or unavailable leaves the cache working
     * from memory. Only the signed-in user's entries are kept in memory.
     * @param {string} name - Cache name, part of the storage key
     * @param {function(*): boolean} isValid - Whether a stored value is well-formed
     * @returns {{scope: function(): {has: function(string): boolean, get: function(string): *, set: function(string, *): void}}}
     */
    function createSessionCache(name, isValid) {
        /** @type {string|null} Storage key of the entries held in memory */
        let memoryKey = null;
        /** @type {Map<string, {value: *, storedAt: number}>|null} */
        let memoryEntries = null;

        /**
         * Key of the signed-in user's entries: their sessionStorage key, or a
         * memory-only key (MEMORY_ONLY_SERVER as the server) while the server
         * is unknown; null while no user is signed in.
         * @returns {string|null}
         */
        const storageKey = () => {
            const userId = JE.session?.getUserId?.();
            if (!userId) return null;
            const serverId = JE.session?.getServerId?.() || MEMORY_ONLY_SERVER;
            return `${RESOLUTION_STORAGE_PREFIX}${serverId}:${userId}:${name}`;
        };
        /**
         * @param {string} key
         * @returns {boolean} The key's entries are kept in sessionStorage
         */
        const persisted = (key) => !key.startsWith(`${RESOLUTION_STORAGE_PREFIX}${MEMORY_ONLY_SERVER}:`);

        /**
         * Reads the stored entries for one storage key, keeping only fresh,
         * well-formed ones.
         * @param {string} key
         * @returns {Map<string, {value: *, storedAt: number}>}
         */
        const load = (key) => {
            const entries = new Map();
            if (!persisted(key)) return entries;
            purgeLegacyResolutionStorage();
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

        /**
         * The entries for a storage key: the in-memory set when it is the
         * signed-in user's (loaded on first use, replacing the previous
         * user's), straight from storage otherwise (a lookup that outlived a
         * user switch).
         * @param {string} key
         * @returns {Map<string, {value: *, storedAt: number}>}
         */
        const entriesFor = (key) => {
            if (key === memoryKey && memoryEntries) return memoryEntries;
            const entries = load(key);
            if (key === storageKey()) {
                memoryKey = key;
                memoryEntries = entries;
            }
            return entries;
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

        /**
         * has / get / set for the user signed in now.
         * @returns {{has: function(string): boolean, get: function(string): *, set: function(string, *): void}}
         */
        const scope = () => {
            const key = storageKey();
            return {
                has(k) {
                    return !!key && fresh(entriesFor(key), String(k));
                },
                get(k) {
                    if (!key) return undefined;
                    const entries = entriesFor(key);
                    return fresh(entries, String(k)) ? entries.get(String(k)).value : undefined;
                },
                set(k, value) {
                    if (!key) return;
                    const entries = entriesFor(key);
                    entries.delete(String(k));
                    entries.set(String(k), { value, storedAt: Date.now() });
                    // Oldest first (insertion order): drop the oldest over the cap.
                    while (entries.size > RESOLUTION_STORAGE_MAX_ENTRIES) {
                        entries.delete(entries.keys().next().value);
                    }
                    if (!persisted(key) || !isValid(value)) return;
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
        };

        return { scope };
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
        // On a person's titles: what the person did in this one, on a line of its own under the title.
        JE.discoveryRoles?.decorateCard?.(card, item);

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
     * The viewport box of the first of `elements` that has a size.
     * @param {Array<Element|null>} elements - Candidates, innermost first
     * @returns {DOMRect|null} Null when none is laid out with a size
     */
    function firstSizedBox(elements) {
        for (const el of elements) {
            if (!el) continue;
            const box = el.getBoundingClientRect();
            if (box.width > 0 && box.height > 0) return box;
        }
        return null;
    }

    /**
     * How many cards appended to the end of a container would land on screen
     * or within half a screen past its edge: the part of a batch that must be
     * appended at once so nothing pops in where the viewer is looking. While
     * the container holds no card to measure (e.g. filtering removed every
     * card of the first page), there is no telling how many cards cover the
     * screen, so a container in view takes the whole batch at once.
     * @param {HTMLElement} container - Element holding the .card elements
     * @param {object} [options]
     * @param {boolean} [options.horizontal=false] - A horizontal row (cards extend to the right)
     * @returns {number} May be Infinity (every card of the batch)
     */
    function cardsInView(container, options = {}) {
        const scroll = JE.seamlessScroll;
        if (!scroll?.cardsNeeded || !container.isConnected) return 0;
        const rect = container.getBoundingClientRect();
        if (options.horizontal) {
            // A row above or below the screen shows none of its new cards. An
            // empty track measures zero high while its row (header, scroller)
            // is on screen: judge the row by its scroller or section then.
            const row = firstSizedBox([container, container.closest('.emby-scroller'), container.closest('.verticalSection')]);
            if (!row || row.bottom <= 0 || row.top >= window.innerHeight) return 0;
            let last = container.lastElementChild;
            while (last && !last.classList.contains('card')) last = last.previousElementSibling;
            const end = last ? last.getBoundingClientRect().right : rect.left;
            const gapPx = window.innerWidth * 1.5 - end;
            return gapPx > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx, horizontal: true }, Infinity) : 0;
        }
        const gapPx = window.innerHeight * 1.5 - rect.bottom;
        return gapPx > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx }, Infinity) : 0;
    }

    /**
     * Appends cards for `items` to the end of `container`: the first
     * `syncCount` (the ones in view) at once, the rest built in short slices
     * across tasks and appended together at the end. The returned promise
     * settles once every card is in, so a caller reporting to the scroll
     * engine measures the whole batch. A card that fails to build rejects
     * the promise with the batch's cards taken out again (a batch built in
     * one go added nothing either); a dropped batch keeps the cards already
     * appended. Either way the posters of the cards left out are released.
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

        // Cards built but not in the container yet.
        let pending = document.createDocumentFragment();
        // The cards appended at once.
        let syncCards = [];
        let settled = false;
        try {
            let appended = 0;
            if (syncCount > 0) {
                appended = build(pending, syncCount, 0);
                if (appended > 0) {
                    syncCards = Array.from(pending.children);
                    container.appendChild(pending);
                }
                pending = document.createDocumentFragment();
            }
            let built = build(pending, 0, BUILD_SLICE_MS);
            while (index < items.length) {
                await yieldToBrowser();
                if (!isCurrent()) {
                    // Dropped: the cards built so far are released below.
                    settled = true;
                    return appended;
                }
                built += build(pending, 1, BUILD_SLICE_MS);
            }
            if (built > 0) container.appendChild(pending);
            settled = true;
            return appended + built;
        } finally {
            // Stop watching the posters of cards that never made it in (the
            // poster sweep leaves cards inside a fragment alone).
            if (pending.firstChild) JE.jellyseerrUI?.releasePosters?.(pending);
            if (!settled && syncCards.length > 0) {
                syncCards.forEach(card => card.remove());
                JE.jellyseerrUI?.releasePosters?.();
            }
        }
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
        addFilterControl,
        typePickerOf,
        createSortControl,
        createSectionHeader,
        feedQuery,
        keepByFilters,
        hasMoreFilters,
        noteIfEmpty,
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
