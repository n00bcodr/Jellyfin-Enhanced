/**
 * @file Hidden Content — data store, lookup sets, and the public data API.
 * Split from hidden-content.js (code motion; bodies verbatim). Owns the
 * hiddenData closure variable and the ID lookup Sets; every other
 * hidden-content-* module reads state through the functions exported here.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    // Late-bound cross-module references (defined in the later-loaded
    // hidden-content-save/dialogs/filter modules).
    const debouncedSave = (...args) => internal.debouncedSave(...args);
    const showUndoToast = (...args) => internal.showUndoToast(...args);
    const refreshNativeCardVisibility = (...args) => internal.refreshNativeCardVisibility(...args);
    const restoreNativeCardsForIds = (...args) => internal.restoreNativeCardsForIds(...args);

    // ============================================================
    // State
    // ============================================================

    const hiddenIdSet = new Set();
    const hiddenTmdbIdSet = new Set();
    let hiddenData = null;

    // ============================================================
    // Internal helpers
    // ============================================================

    /**
     * Returns the in-memory hidden-content data object, lazily initialised
     * from `JE.userConfig.hiddenContent`.
     * @returns {{ items: Object, settings: Object }}
     */
    function getHiddenData() {
        if (!hiddenData) {
            hiddenData = JE.userConfig?.hiddenContent || { items: {}, settings: {} };
        }
        return hiddenData;
    }

    /**
     * Returns the merged settings object (defaults + user overrides).
     * @returns {Object} Merged settings with boolean flags for every filter surface.
     */
    function getSettings() {
        const data = getHiddenData();
        return {
            enabled: true,
            filterLibrary: true,
            filterDiscovery: true,
            filterUpcoming: true,
            filterCalendar: true,
            filterSearch: false,
            filterRecommendations: true,
            filterRequests: true,
            filterNextUp: true,
            filterContinueWatching: true,
            showHideConfirmation: true,
            showHideButtons: true,
            showButtonJellyseerr: true,
            showButtonLibrary: false,
            showButtonDetails: true,
            showButtonCast: false,
            experimentalHideCollections: false,
            ...data.settings
        };
    }

    /**
     * Rebuilds the in-memory ID Sets from the current hidden-data items map.
     * Must be called after any mutation to `hiddenData.items`.
     */
    function rebuildSets() {
        hiddenIdSet.clear();
        hiddenTmdbIdSet.clear();
        const data = getHiddenData();
        const items = data.items || {};
        for (const key of Object.keys(items)) {
            const item = items[key];
            const scope = item.hideScope || 'global';
            if (scope !== 'global') continue;
            if (item.itemId) hiddenIdSet.add(item.itemId);
            if (item.tmdbId) hiddenTmdbIdSet.add(String(item.tmdbId));
        }
    }

    /**
     * Checks whether filtering is enabled for a given surface.
     * @param {string} surface One of 'library', 'details', 'discovery', 'search',
     *   'upcoming', 'calendar', 'recommendations', 'requests', 'nextup',
     *   'continuewatching'.
     * @returns {boolean} `true` if hidden items should be filtered on this surface.
     */
    function shouldFilterSurface(surface) {
        const settings = getSettings();
        if (!settings.enabled) return false;
        switch (surface) {
            case 'details': return settings.filterLibrary;
            case 'library': return settings.filterLibrary;
            case 'discovery': return settings.filterDiscovery;
            case 'search': return settings.filterSearch;
            case 'upcoming': return settings.filterUpcoming;
            case 'calendar': return settings.filterCalendar;
            case 'recommendations': return settings.filterRecommendations;
            case 'requests': return settings.filterRequests;
            case 'nextup': return settings.filterNextUp;
            case 'continuewatching': return settings.filterContinueWatching;
            default: return true;
        }
    }

    // ============================================================
    // Event emission
    // ============================================================

    /**
     * Dispatches a `je-hidden-content-changed` CustomEvent on `window`.
     * Other modules (e.g. the management page) listen for this to re-render.
     */
    function emitChange() {
        try {
            window.dispatchEvent(new CustomEvent('je-hidden-content-changed'));
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to emit hidden-content-changed event', e);
        }
    }

    // Re-fetch from server and replace local cache. Don't call immediately after a server-direct write from THIS tab — use markScopedHidden().
    async function refresh() {
        try {
            const userId = ApiClient.getCurrentUserId();
            if (!userId) return false;
            const fresh = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`),
                dataType: 'json'
            });
            const camelCased = (typeof JE.toCamelCase === 'function') ? JE.toCamelCase(fresh) : fresh;
            JE.userConfig = JE.userConfig || {};
            JE.userConfig.hiddenContent = camelCased || { items: {}, settings: {} };
            hiddenData = JE.userConfig.hiddenContent;
            rebuildSets();
            emitChange();
            return true;
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to refresh hidden-content', e);
            return false;
        }
    }

    // Client-side mirror of MergeHomeScope in HiddenContentController.cs (scoped home-row hide write).
    function mergeCwScope(existing, incoming) {
        const ex = (existing || '').toLowerCase();
        const inc = (incoming || 'continuewatching').toLowerCase();
        if (!ex) return inc;
        if (ex === 'global' || ex === 'homesections') return ex;
        if (ex === inc) return ex;
        return 'homesections';
    }

    // Rank-based widest-scope mirror of server's WiderScope — commutative max function for use in folds.
    // Disjoint rank-2 scopes (continuewatching ⊕ nextup) compose to homesections.
    const SCOPE_RANK = { global: 4, homesections: 3, continuewatching: 2, nextup: 2 };
    function widestScope(a, b) {
        if (!a) return b || '';
        if (!b) return a;
        const la = a.toLowerCase();
        const lb = b.toLowerCase();
        const ra = SCOPE_RANK[la] ?? 1;
        const rb = SCOPE_RANK[lb] ?? 1;
        if (ra === 2 && rb === 2 && la !== lb) return 'homesections';
        return ra >= rb ? la : lb;
    }

    // Local-cache mirror of a server-side hide write — preserves existing metadata + merges scopes via mergeCwScope.
    // Looks up under hyphenated AND N-format keys (server canonical is hyphenated; some callers pass N-format from data-id).
    function markScopedHidden(itemId, scope) {
        if (!itemId) return;
        const _scope = (scope || 'continuewatching').toLowerCase();
        const data = getHiddenData();
        const items = (data.items) || {};
        const noHyphen = itemId.replace(/-/g, '');
        const hyphenated = noHyphen.length === 32
            ? `${noHyphen.slice(0, 8)}-${noHyphen.slice(8, 12)}-${noHyphen.slice(12, 16)}-${noHyphen.slice(16, 20)}-${noHyphen.slice(20)}`
            : itemId;
        // Collect every variant present, fold the widest scope across all of them so duplicate keys with
        // disjoint scopes (e.g. nextup + continuewatching = homesections) don't durably narrow on collapse.
        // Uses widestScope (rank-based, commutative) for the fold so result is order-independent;
        // mergeCwScope is asymmetric and biased to existing — wrong choice for a max-fold.
        const variants = [items[itemId], items[hyphenated], items[noHyphen]].filter(Boolean);
        const widestExisting = variants.reduce((acc, e) => widestScope(acc, e.hideScope), '');
        const finalScope = mergeCwScope(widestExisting, _scope);
        const existing = variants[0] || null;
        const altPresent = (hyphenated !== itemId && items[hyphenated]) || (noHyphen !== itemId && items[noHyphen]);
        if (items[itemId] && items[itemId].hideScope === finalScope && !altPresent) return;
        // Pick the earliest hiddenAt across variants so re-affirming doesn't reset history.
        let earliestHiddenAt = '';
        for (const v of variants) {
            if (!v?.hiddenAt) continue;
            if (!earliestHiddenAt || v.hiddenAt < earliestHiddenAt) earliestHiddenAt = v.hiddenAt;
        }
        const merged = {
            itemId,
            name: existing?.name || '',
            type: existing?.type || '',
            tmdbId: existing?.tmdbId || '',
            hiddenAt: earliestHiddenAt || new Date().toISOString(),
            posterPath: existing?.posterPath || '',
            seriesId: existing?.seriesId || '',
            seriesName: existing?.seriesName || '',
            seasonNumber: existing?.seasonNumber ?? null,
            episodeNumber: existing?.episodeNumber ?? null,
            hideScope: finalScope,
        };
        const nextItems = { ...items, [itemId]: merged };
        if (hyphenated !== itemId) delete nextItems[hyphenated];
        if (noHyphen !== itemId) delete nextItems[noHyphen];
        hiddenData = { ...data, items: nextItems };
        JE.userConfig = JE.userConfig || {};
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        emitChange();
    }

    // ============================================================
    // Public API
    // ============================================================

    /**
     * Checks if an item is hidden by its Jellyfin ID.
     * @param {string} jellyfinItemId The Jellyfin item ID.
     * @returns {boolean} `true` if the item is hidden.
     */
    function isHidden(jellyfinItemId) {
        if (!jellyfinItemId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        return hiddenIdSet.has(jellyfinItemId);
    }

    /**
     * Checks if an item is hidden by its TMDB ID.
     * @param {string|number} tmdbId The TMDB ID.
     * @returns {boolean} `true` if the item is hidden.
     */
    function isHiddenByTmdbId(tmdbId) {
        if (!tmdbId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        return hiddenTmdbIdSet.has(String(tmdbId));
    }

    /**
     * Hides an item by adding it to the hidden-content data store.
     * Rebuilds lookup sets, schedules a save, emits a change event,
     * shows an undo toast, and refreshes native card visibility.
     * @param {Object} params Item data to hide.
     * @param {string} [params.itemId] Jellyfin item ID.
     * @param {string} [params.name] Display name.
     * @param {string} [params.type] Item type (Movie, Series, Episode, etc.).
     * @param {string|number} [params.tmdbId] TMDB ID.
     * @param {string} [params.posterPath] TMDB poster path.
     * @param {string} [params.seriesId] Parent series Jellyfin ID.
     * @param {string} [params.seriesName] Parent series name.
     * @param {number|null} [params.seasonNumber] Season number.
     * @param {number|null} [params.episodeNumber] Episode number.
     * @param {string} [params.hideScope] Scope: 'global', 'nextup', 'continuewatching', or 'homesections'.
     */
    function hideItem({ itemId, name, type, tmdbId, posterPath, seriesId, seriesName, seasonNumber, episodeNumber, hideScope }) {
        const data = getHiddenData();
        const key = itemId || `tmdb-${tmdbId}`;
        const newItem = {
            itemId: itemId || '',
            name: name || '',
            type: type || '',
            tmdbId: tmdbId ? String(tmdbId) : '',
            hiddenAt: new Date().toISOString(),
            posterPath: posterPath || '',
            seriesId: seriesId || '',
            seriesName: seriesName || '',
            seasonNumber: seasonNumber != null ? seasonNumber : null,
            episodeNumber: episodeNumber != null ? episodeNumber : null,
            hideScope: hideScope || 'global'
        };

        hiddenData = {
            ...data,
            items: { ...data.items, [key]: newItem }
        };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();
        showUndoToast(name || 'Item', key);
        refreshNativeCardVisibility();
    }

    /**
     * Unhides an item by removing it from the hidden-content data store.
     * Restores visibility for the item's native cards.
     * @param {string} itemId The storage key or Jellyfin item ID to unhide.
     */
    function unhideItem(itemId) {
        const data = getHiddenData();
        const newItems = { ...data.items };
        let restoredJellyfinId = '';

        // Try direct key match first (covers storage keys like "tmdb-12345")
        if (newItems[itemId]) {
            restoredJellyfinId = newItems[itemId].itemId || '';
            delete newItems[itemId];
        } else {
            // Fallback: itemId might be a Jellyfin ID — find the matching storage key
            const matchingKey = Object.keys(newItems).find(k => newItems[k].itemId === itemId);
            if (matchingKey) {
                restoredJellyfinId = newItems[matchingKey].itemId || itemId || '';
                delete newItems[matchingKey];
            }
        }

        hiddenData = { ...data, items: newItems };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();

        const idsToRestore = new Set();
        if (restoredJellyfinId) idsToRestore.add(restoredJellyfinId);
        else if (itemId && !String(itemId).startsWith('tmdb-')) idsToRestore.add(itemId);
        restoreNativeCardsForIds(idsToRestore);
        refreshNativeCardVisibility();
    }

    /**
     * Merges partial settings into the hidden-content settings.
     * Triggers a save, change event, and native card re-filter.
     * @param {Object} partial Key-value pairs to merge into settings.
     */
    function updateSettings(partial) {
        const data = getHiddenData();
        hiddenData = {
            ...data,
            settings: { ...data.settings, ...partial }
        };
        JE.userConfig.hiddenContent = hiddenData;
        debouncedSave();
        emitChange();
        refreshNativeCardVisibility();
    }

    /**
     * Returns all hidden items as an array with `_key` attached.
     * @returns {Array<Object>} Array of hidden item objects.
     */
    function getAllHiddenItems() {
        const data = getHiddenData();
        const items = data.items || {};
        return Object.entries(items).map(([key, item]) => ({ ...item, _key: key }));
    }

    /**
     * Returns the number of hidden items.
     * @returns {number} Count of hidden items.
     */
    function getHiddenCount() {
        const data = getHiddenData();
        return Object.keys(data.items || {}).length;
    }

    /**
     * Filters Jellyseerr discovery/search results, removing hidden items by TMDB ID.
     * @param {Array} results Array of Jellyseerr result objects.
     * @param {string} surface The surface name (e.g. 'discovery', 'search').
     * @returns {Array} Filtered array.
     */
    function filterJellyseerrResults(results, surface) {
        if (!shouldFilterSurface(surface)) return results;
        if (!Array.isArray(results)) return results;
        return results.filter((item) => {
            const tmdbId = item.id || item.tmdbId;
            return !hiddenTmdbIdSet.has(String(tmdbId));
        });
    }

    /**
     * Filters calendar events, removing hidden items by TMDB ID, Jellyfin ID,
     * or normalised name match (for Sonarr events without TMDB IDs).
     * @param {Array} events Array of calendar event objects.
     * @returns {Array} Filtered array.
     */
    function filterCalendarEvents(events) {
        if (!shouldFilterSurface('calendar')) return events;
        if (!Array.isArray(events)) return events;

        // Build a set of normalised hidden-item names for fuzzy matching
        const hiddenNames = new Set();
        const items = (getHiddenData().items) || {};
        for (const key of Object.keys(items)) {
            const name = items[key].name;
            if (name) {
                const lower = name.toLowerCase();
                hiddenNames.add(lower);
                // Also store without trailing parenthetical qualifier
                // so "Hell's Kitchen (US)" matches "Hell's Kitchen" and vice-versa.
                const stripped = lower.replace(/\s*\([^)]*\)\s*$/, '');
                if (stripped !== lower) hiddenNames.add(stripped);
            }
        }

        return events.filter((event) => {
            if (event.tmdbId && hiddenTmdbIdSet.has(String(event.tmdbId))) return false;
            if (event.itemId && hiddenIdSet.has(event.itemId)) return false;
            if (event.title && hiddenNames.has(event.title.toLowerCase())) return false;
            return true;
        });
    }

    /**
     * Filters request items, removing hidden items by TMDB ID or Jellyfin media ID.
     * @param {Array} items Array of request item objects.
     * @returns {Array} Filtered array.
     */
    function filterRequestItems(items) {
        if (!shouldFilterSurface('requests')) return items;
        if (!Array.isArray(items)) return items;
        return items.filter((item) => {
            const tmdbId = item.tmdbId || item.id;
            if (tmdbId && hiddenTmdbIdSet.has(String(tmdbId))) return false;
            if (item.jellyfinMediaId && hiddenIdSet.has(item.jellyfinMediaId)) return false;
            return true;
        });
    }

    /**
     * Unhides all items, restoring full visibility.  Clears the entire items map.
     */
    function unhideAll() {
        const oldHiddenIds = new Set(hiddenIdSet);
        const data = getHiddenData();
        hiddenData = { ...data, items: {} };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();
        restoreNativeCardsForIds(oldHiddenIds);
        refreshNativeCardVisibility();
    }

    /**
     * Split shim: performs JE.initializeHiddenContent's data reset (formerly
     * the inline `hiddenData = …; rebuildSets();` lines) inside the module
     * that owns the hiddenData closure variable.
     */
    function resetFromUserConfig() {
        hiddenData = JE.userConfig?.hiddenContent || { items: {}, settings: {} };
        rebuildSets();
    }

    Object.assign(internal, {
        hiddenIdSet,
        getHiddenData,
        getSettings,
        rebuildSets,
        shouldFilterSurface,
        emitChange,
        refresh,
        markScopedHidden,
        isHidden,
        isHiddenByTmdbId,
        hideItem,
        unhideItem,
        updateSettings,
        getAllHiddenItems,
        getHiddenCount,
        filterJellyseerrResults,
        filterCalendarEvents,
        filterRequestItems,
        unhideAll,
        resetFromUserConfig,
    });

})(window.JellyfinEnhanced);
