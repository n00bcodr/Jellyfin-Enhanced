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
    // Whether this session's list came from the server. A list that failed to
    // load (JE.userConfig.hiddenContent is null) is unknown, not empty: every
    // save writes the whole list, so an edit made on an empty stand-in would
    // replace the stored one. False until the first load and from a user switch
    // until the incoming user's list has loaded.
    let loaded = false;
    // The stored list as this session last read or wrote it. Where the session's
    // list differs from it is this session's own change, and a save writes only
    // that onto the list as stored at that moment (see rebaseOnto): another
    // device, an administrator or the server may have changed it meanwhile.
    let storedCopy = { items: {}, settings: {} };
    // Bumped whenever the session's list is replaced from outside (a load or a
    // user switch), so a save that started before cannot adopt its result.
    let listGeneration = 0;

    // ============================================================
    // Internal helpers
    // ============================================================

    /**
     * Canonicalises a Jellyfin item ID for comparison.
     *
     * Item IDs reach this module in two shapes: the server writes GUIDs dashed
     * ("N" vs "D" format) into hidden-content.json, while cards carry them
     * undashed in `data-id`. Comparing the raw strings silently never matches,
     * so every lookup key and every ID read off the DOM goes through here.
     * @param {*} id Raw ID from the store, an API payload, or a DOM attribute.
     * @returns {string} Lowercase, dash-free ID, or '' when there is nothing usable.
     */
    function normalizeId(id) {
        if (!id) return '';
        if (typeof id !== 'string' && typeof id !== 'number' && typeof id !== 'bigint') return '';
        return String(id).replace(/-/g, '').toLowerCase();
    }

    /**
     * A deep copy of a hidden list, so the stored copy can't change with the session's list.
     * @param {Object} doc
     * @returns {Object}
     */
    function copyOf(doc) {
        return JSON.parse(JSON.stringify(doc));
    }

    /**
     * Deep equality for JSON values, ignoring object key order.
     * @param {*} a
     * @param {*} b
     * @returns {boolean}
     */
    function sameValue(a, b) {
        if (a === b) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length
            && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
    }

    /**
     * Returns `onto` with the changes that turn `base` into `edited` applied:
     * each setting whose value differs, and each hidden item added, changed or
     * removed. An entry `base` holds that is changed or removed is replaced or
     * removed under every spelling of its key (compared the way IDs are, see
     * normalizeId): the server keys a Continue Watching hide by the dashed ID,
     * this client by the ID it was given. An added entry leaves entries stored
     * under other spellings alone, as a separate entry would be.
     * @param {{items: Object, settings: Object}} base The list the changes were made from.
     * @param {{items: Object, settings: Object}} edited The list with the changes.
     * @param {{items: Object, settings: Object}} onto The list to apply them to.
     * @returns {{items: Object, settings: Object}} A new list; the inputs are not modified.
     */
    function withChanges(base, edited, onto) {
        const baseItems = base?.items || {}, editedItems = edited?.items || {};
        const items = { ...(onto?.items || {}) };
        const changed = [...new Set([...Object.keys(baseItems), ...Object.keys(editedItems)])]
            .filter(key => !sameValue(baseItems[key], editedItems[key]));
        const replaced = new Set(changed.filter(key => baseItems[key] !== undefined).map(normalizeId));
        for (const key of Object.keys(items)) {
            if (replaced.has(normalizeId(key))) delete items[key];
        }
        for (const key of changed) {
            if (editedItems[key] !== undefined) items[key] = editedItems[key];
        }

        const baseSettings = base?.settings || {}, editedSettings = edited?.settings || {};
        const settings = { ...(onto?.settings || {}) };
        for (const key of new Set([...Object.keys(baseSettings), ...Object.keys(editedSettings)])) {
            if (sameValue(baseSettings[key], editedSettings[key])) continue;
            if (editedSettings[key] === undefined) delete settings[key];
            else settings[key] = editedSettings[key];
        }
        return { ...onto, items, settings };
    }

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
     * Whether this session's hidden list was loaded from the server, so edits
     * can be saved. False while it failed to load or is still loading after a
     * user switch.
     * @returns {boolean}
     */
    function isLoaded() {
        return loaded;
    }

    /**
     * Refuses an edit while the list is not loaded: logs, tells the user to
     * reload, and returns true. Returns false when the edit may go ahead.
     * @returns {boolean} `true` if the edit must not be made.
     */
    function refuseEditIfNotLoaded() {
        if (loaded) return false;
        console.warn('🪼 Jellyfin Enhanced: Hidden Content list did not load; change not made so the stored list is kept');
        try {
            if (typeof JE.toast === 'function') JE.toast(JE.t('hidden_content_not_loaded'), 5000);
        } catch (_) { /* toast helper unavailable; the warning above stands */ }
        return true;
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
            if (item.itemId) hiddenIdSet.add(normalizeId(item.itemId));
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
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        try {
            const userId = ApiClient.getCurrentUserId();
            if (!userId) return false;
            const fresh = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`),
                dataType: 'json'
            });
            if (JE.session && !JE.session.isCurrent(requestEpoch)) return false;
            const camelCased = (typeof JE.toCamelCase === 'function') ? JE.toCamelCase(fresh) : fresh;
            if (!camelCased || typeof camelCased !== 'object') return false;
            // Changes this session has not saved yet stay on top of the list as read.
            hiddenData = loaded ? withChanges(storedCopy, getHiddenData(), camelCased) : camelCased;
            storedCopy = copyOf(camelCased);
            loaded = true;
            JE.userConfig = JE.userConfig || {};
            JE.userConfig.hiddenContent = hiddenData;
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

    /**
     * Returns `data` with the scoped home-row hide the server wrote for `itemId`
     * mirrored in: preserves existing metadata and merges scopes via
     * mergeCwScope. Returns `data` itself when it already holds that entry.
     * @param {{items: Object}} data A hidden list.
     * @param {string} itemId Jellyfin item ID, dashed or not.
     * @param {string} _scope Lowercase scope that was written.
     * @param {string} now Timestamp for a new entry.
     * @returns {{items: Object}}
     */
    function withScopedHide(data, itemId, _scope, now) {
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
        if (items[itemId] && items[itemId].hideScope === finalScope && !altPresent) return data;
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
            hiddenAt: earliestHiddenAt || now,
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
        return { ...data, items: nextItems };
    }

    // Local-cache mirror of a server-side hide write — preserves existing metadata + merges scopes via mergeCwScope.
    // Looks up under hyphenated AND N-format keys (server canonical is hyphenated; some callers pass N-format from data-id).
    // The server wrote the entry, so it is recorded as stored as well: a save never counts it as this session's own
    // change, and so never writes it back after the server drops it (playback, item removal).
    function markScopedHidden(itemId, scope) {
        if (!itemId) return;
        const _scope = (scope || 'continuewatching').toLowerCase();
        const now = new Date().toISOString();
        storedCopy = withScopedHide(storedCopy, itemId, _scope, now);
        const data = getHiddenData();
        const next = withScopedHide(data, itemId, _scope, now);
        if (next === data) return;
        hiddenData = next;
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
        return hiddenIdSet.has(normalizeId(jellyfinItemId));
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
     * @returns {boolean} `false` if the list is not loaded and nothing was hidden.
     */
    function hideItem({ itemId, name, type, tmdbId, posterPath, seriesId, seriesName, seasonNumber, episodeNumber, hideScope }) {
        if (refuseEditIfNotLoaded()) return false;
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
        return true;
    }

    /**
     * Unhides an item by removing it from the hidden-content data store.
     * Restores visibility for the item's native cards.
     * @param {string} itemId The storage key or Jellyfin item ID to unhide.
     * @returns {boolean} `false` if the list is not loaded and nothing was unhidden.
     */
    function unhideItem(itemId) {
        if (refuseEditIfNotLoaded()) return false;
        const data = getHiddenData();
        const newItems = { ...data.items };
        let restoredJellyfinId = '';

        // Try direct key match first (covers storage keys like "tmdb-12345")
        if (newItems[itemId]) {
            restoredJellyfinId = newItems[itemId].itemId || '';
            delete newItems[itemId];
        } else {
            // Fallback: itemId might be a Jellyfin ID — find the matching storage key.
            // Compared canonically: the caller usually has an undashed ID off a card, while a
            // server-written entry stores it dashed, and a raw comparison would silently no-op.
            // Guarded against an empty/unusable argument, which would otherwise normalise to ''
            // and match the first TMDB-only entry (those carry no itemId).
            const wanted = normalizeId(itemId);
            const matchingKey = wanted
                ? Object.keys(newItems).find(k => normalizeId(newItems[k].itemId) === wanted)
                : undefined;
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
        return true;
    }

    /**
     * Merges partial settings into the hidden-content settings.
     * Triggers a save, change event, and native card re-filter.
     * @param {Object} partial Key-value pairs to merge into settings.
     * @returns {boolean} `false` if the list is not loaded and nothing was changed.
     */
    function updateSettings(partial) {
        if (refuseEditIfNotLoaded()) return false;
        const data = getHiddenData();
        hiddenData = {
            ...data,
            settings: { ...data.settings, ...partial }
        };
        JE.userConfig.hiddenContent = hiddenData;
        debouncedSave();
        emitChange();
        refreshNativeCardVisibility();
        return true;
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
            if (event.itemId && hiddenIdSet.has(normalizeId(event.itemId))) return false;
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
            if (item.jellyfinMediaId && hiddenIdSet.has(normalizeId(item.jellyfinMediaId))) return false;
            return true;
        });
    }

    /**
     * Unhides all items, restoring full visibility.  Clears the entire items map.
     * @returns {boolean} `false` if the list is not loaded and nothing was unhidden.
     */
    function unhideAll() {
        if (refuseEditIfNotLoaded()) return false;
        const oldHiddenIds = new Set(hiddenIdSet);
        const data = getHiddenData();
        hiddenData = { ...data, items: {} };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();
        restoreNativeCardsForIds(oldHiddenIds);
        refreshNativeCardVisibility();
        return true;
    }

    /**
     * Split shim: performs JE.initializeHiddenContent's data reset (formerly
     * the inline `hiddenData = …; rebuildSets();` lines) inside the module
     * that owns the hiddenData closure variable.
     */
    function resetFromUserConfig() {
        loaded = JE.userConfig?.hiddenContent != null;
        hiddenData = JE.userConfig?.hiddenContent || { items: {}, settings: {} };
        storedCopy = copyOf(hiddenData);
        listGeneration++;
        rebuildSets();
    }

    /**
     * Starts a save. The list is saved whole, so the save starts from `stored`,
     * the list as just read from the server, and applies only what this session
     * changed since it last read or wrote the list. Call `saved()` once `list`
     * is written: the session then shows that list, keeping any change made
     * while the save was in flight for the next save.
     * @param {{items: Object, settings: Object}} stored The list as stored now (camelCase).
     * @returns {{list: Object, saved: Function}}
     */
    function rebaseOnto(stored) {
        const generation = listGeneration;
        // A copy: the session's list must not change under the save.
        const sent = copyOf(getHiddenData());
        const list = withChanges(storedCopy, sent, stored);
        return {
            list,
            saved() {
                if (generation !== listGeneration) return; // another user's list, or reloaded meanwhile
                const local = getHiddenData();
                const next = sameValue(sent, local) ? list : withChanges(sent, local, list);
                storedCopy = copyOf(list);
                hiddenData = next;
                JE.userConfig = JE.userConfig || {};
                JE.userConfig.hiddenContent = next;
                if (!sameValue(local, next)) {
                    rebuildSets();
                    emitChange();
                    refreshNativeCardVisibility();
                }
            }
        };
    }

    // Hidden-content data is per-user. Clear the local mirror the moment the
    // identity changes (don't read JE.userConfig here — reset handlers run in
    // registration order and the globals may not be wiped yet), then rebuild
    // from the incoming user's config once the re-bootstrap has loaded it.
    JE.session?.onUserChange('hidden-content-data', () => {
        hiddenData = null;
        loaded = false;
        storedCopy = { items: {}, settings: {} };
        listGeneration++;
        hiddenIdSet.clear();
        hiddenTmdbIdSet.clear();
    });
    document.addEventListener('je:user-data-loaded', () => {
        resetFromUserConfig();
        emitChange();
        // Re-apply the incoming user's policy to whatever is on screen (the
        // filter reset stripped the previous user's hide marks and verdicts).
        refreshNativeCardVisibility();
    });

    Object.assign(internal, {
        hiddenIdSet,
        normalizeId,
        getHiddenData,
        isLoaded,
        refuseEditIfNotLoaded,
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
        rebaseOnto,
    });

})(window.JellyfinEnhanced);
