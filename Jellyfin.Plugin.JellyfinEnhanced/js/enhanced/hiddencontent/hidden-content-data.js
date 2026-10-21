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
    // The document revision (core/access-revision.js) the rules were read under, taken BEFORE the read; null: unknown.
    // Another tab or device saving the rules moves it: the rules are read again, in place.
    let loadedRevision = null;
    // A newer revision was seen while the rules couldn't be read again (a save of this tab pending, a read running).
    let revisionPending = false;
    // The read again running now and the sign-in it belongs to: a read of the previous person is never joined, and its
    // completion can't take (or retry) anything of the next one.
    /** @type {{epoch: number, promise: Promise<boolean>}|null} */
    let revalidating = null;
    // A read again that failed is retried after a pause that grows, a few times at most (then on the next page or the
    // next revision); never at once, so an unreachable server isn't asked in a loop.
    const RELOAD_RETRY_MS = [2000, 8000, 30000];
    let retryTimer = null;
    let retryAttempt = 0;
    // The rules as last read from the server (or saved from this tab), as JSON: what this tab's changes are made on. A
    // save made while a newer document is known reads it first and puts this tab's changes on it (see prepareSave).
    /** @type {string|null} */
    let baseJson = null;

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
     * Returns the in-memory hidden-content data object, lazily initialised
     * from `JE.userConfig.hiddenContent`.
     * @returns {{ items: Object, settings: Object }}
     */
    function getHiddenData() {
        if (!hiddenData) {
            hiddenData = JE.userConfig?.hiddenContent || { items: {}, settings: {} };
            baseJson = JSON.stringify(hiddenData);
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
            JE.userConfig = JE.userConfig || {};
            JE.userConfig.hiddenContent = camelCased || { items: {}, settings: {} };
            hiddenData = JE.userConfig.hiddenContent;
            baseJson = JSON.stringify(hiddenData);
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
     */
    function hideItem({ itemId, name, type, tmdbId, posterPath, seriesId, seriesName, seasonNumber, episodeNumber, hideScope }) {
        // Synthetic ids (titles not in the library, shown on a native details page) are never stored.
        if ((itemId && JE.titleDetails?.isSynthetic?.(itemId)) || (seriesId && JE.titleDetails?.isSynthetic?.(seriesId))) return;
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
        baseJson = JSON.stringify(hiddenData);
        // The page-load documents were read under the bootstrap's revision (the core holds it from then).
        loadedRevision = knownRevision();
        revisionPending = false;
        rebuildSets();
    }

    /** @returns {string|null} The rules' document revision known now (core/access-revision.js). */
    function knownRevision() {
        return JE.core?.revision?.document?.('hidden-content') ?? null;
    }

    /** @returns {number} The sign-in's session epoch now. */
    function sessionEpoch() {
        return JE.session ? JE.session.getEpoch() : 0;
    }

    /** @param {number} epoch @returns {boolean} The sign-in that epoch belongs to is the current one. */
    function isCurrentEpoch(epoch) {
        return !JE.session || JE.session.isCurrent(epoch);
    }

    /** Ends a waiting retry of a failed read. */
    function cancelRetry() {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
    }

    /**
     * A read again failed: try once more after a pause (longer each time, a few times at most) while this sign-in is
     * current and the rules known are still newer than the ones read.
     * @param {number} epoch
     */
    function scheduleRetry(epoch) {
        cancelRetry();
        if (retryAttempt >= RELOAD_RETRY_MS.length) {
            console.warn('🪼 Jellyfin Enhanced: Hidden Content rules could not be read again; trying on the next page');
            return;
        }
        retryTimer = setTimeout(() => {
            retryTimer = null;
            if (isCurrentEpoch(epoch) && hiddenData && knownRevision() !== loadedRevision) revalidate();
        }, RELOAD_RETRY_MS[retryAttempt++]);
    }

    /**
     * Puts rules read from the server in place: only what changed is hidden or shown again (nothing is cleared first).
     * @param {any} next The rules as read.
     * @returns {boolean} True when anything changed.
     */
    function installRead(next) {
        baseJson = JSON.stringify(next);
        if (JSON.stringify(next) === JSON.stringify(hiddenData)) return false;
        const shownBefore = new Set(hiddenIdSet);
        JE.userConfig = JE.userConfig || {};
        JE.userConfig.hiddenContent = next;
        hiddenData = next;
        rebuildSets();
        emitChange();
        const shownAgain = new Set([...shownBefore].filter(id => !hiddenIdSet.has(id)));
        if (shownAgain.size) restoreNativeCardsForIds(shownAgain);
        refreshNativeCardVisibility();
        return true;
    }

    /**
     * Reads the person's rules from the server.
     * @returns {Promise<any>} The rules (camelCase), or null with nobody signed in.
     */
    async function readRules() {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) return null;
        const fresh = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`),
            dataType: 'json'
        });
        return (typeof JE.toCamelCase === 'function' ? JE.toCamelCase(fresh) : fresh) || { items: {}, settings: {} };
    }

    /**
     * The rules' document moved on the server (another tab or device saved them): read them again and bring this tab
     * in line in place: only what changed is hidden or shown again, nothing is cleared first. Not while a save of this
     * tab is pending (that save reads the current document first and keeps both: see prepareSave; the next revision
     * after it reads again), and a change made here while the read runs keeps the read from being taken (read again
     * later). The read belongs to the sign-in that started it; a failed one is retried with a growing pause.
     * @returns {Promise<boolean>} True when the rules are the server's as of a known revision.
     */
    function revalidate() {
        const epoch = sessionEpoch();
        if (revalidating && revalidating.epoch === epoch) { revisionPending = true; return revalidating.promise; }
        if (internal.hasPendingSave?.()) { revisionPending = true; return Promise.resolve(false); }
        cancelRetry();
        revisionPending = false;
        // Taken before the read: the rules as read are at least this new.
        const revision = knownRevision();
        const before = getHiddenData();
        /** @type {{epoch: number, promise: Promise<boolean>}} */
        const owner = { epoch, promise: Promise.resolve(false) };
        owner.promise = (async () => {
            let failed = false;
            try {
                const next = await readRules();
                if (!isCurrentEpoch(epoch) || next === null) return false;
                retryAttempt = 0;
                // Changed here meanwhile, or a save started: this tab's change wins; read again after it.
                if (hiddenData !== before || internal.hasPendingSave?.()) { revisionPending = true; return false; }
                const after = knownRevision();
                loadedRevision = after === revision ? revision : null;
                if (after !== revision) revisionPending = true;
                installRead(next);
                return true;
            } catch (e) {
                if (!isCurrentEpoch(epoch)) return false;
                console.warn('🪼 Jellyfin Enhanced: Failed to read hidden-content again after a revision', e);
                failed = true;
                return false;
            } finally {
                if (revalidating === owner) revalidating = null;
                if (isCurrentEpoch(epoch)) {
                    if (failed) {
                        scheduleRetry(epoch);
                    } else if (revisionPending && knownRevision() !== loadedRevision) {
                        revisionPending = false;
                        // A newer revision came while this ran: once more (each run is caused by a real move).
                        setTimeout(() => { if (isCurrentEpoch(epoch)) revalidate(); }, 0);
                    }
                }
            }
        })();
        revalidating = owner;
        return owner.promise;
    }

    /**
     * Before a save of the whole document: when a newer document than the one this tab's rules were read from is known
     * (another tab or device saved meanwhile), read it and put this tab's changes on it, so the save keeps both. Each
     * item and setting this tab changed since its last read is taken from here, everything else from the server.
     * Throws when the current document can't be read (the save then waits for its retry; nothing is overwritten) or the
     * sign-in changed while it was read.
     * @returns {Promise<void>}
     */
    async function prepareSave() {
        const revision = knownRevision();
        if (!hiddenData || revision === null || revision === loadedRevision) return;
        const epoch = sessionEpoch();
        const next = await readRules();
        if (!isCurrentEpoch(epoch) || next === null) throw new Error('The sign-in changed before the save');
        const base = baseJson ? JSON.parse(baseJson) : { items: {}, settings: {} };
        const merged = mergeOnto(base, getHiddenData(), next);
        // The document known is in: nothing more to read for it once this save is done.
        if (knownRevision() === revision) { loadedRevision = revision; revisionPending = false; }
        baseJson = JSON.stringify(next);
        const shownBefore = new Set(hiddenIdSet);
        JE.userConfig = JE.userConfig || {};
        JE.userConfig.hiddenContent = merged;
        hiddenData = merged;
        rebuildSets();
        emitChange();
        const shownAgain = new Set([...shownBefore].filter(id => !hiddenIdSet.has(id)));
        if (shownAgain.size) restoreNativeCardsForIds(shownAgain);
        refreshNativeCardVisibility();
    }

    /**
     * Three-way merge of the rules: what this tab changed since `base` (an item hidden, shown again or edited; a setting)
     * is put on `server`; everything else is the server's.
     * @param {any} base The rules this tab's changes were made on.
     * @param {any} local The rules in this tab now.
     * @param {any} server The rules on the server now.
     * @returns {any} The rules to save.
     */
    function mergeOnto(base, local, server) {
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        /** @param {any} b @param {any} l @param {any} r */
        const mergeMap = (b, l, r) => {
            const out = { ...(r || {}) };
            for (const key of new Set([...Object.keys(b || {}), ...Object.keys(l || {})])) {
                const mine = (l || {})[key];
                if (same((b || {})[key], mine)) continue;
                if (mine === undefined) delete out[key];
                else out[key] = mine;
            }
            return out;
        };
        const merged = { ...(server || {}) };
        for (const key of new Set([...Object.keys(base || {}), ...Object.keys(local || {})])) {
            if (key === 'items' || key === 'settings') continue;
            if (!same((base || {})[key], (local || {})[key])) merged[key] = (local || {})[key];
        }
        merged.items = mergeMap(base?.items, local?.items, server?.items);
        merged.settings = mergeMap(base?.settings, local?.settings, server?.settings);
        return merged;
    }

    /** This tab's save went through: the server holds what it sent (the base of the next changes). @param {string} sent */
    function savedAs(sent) {
        baseJson = sent;
    }

    document.addEventListener('je-document-revision', (e) => {
        const detail = /** @type {CustomEvent} */ (e).detail || {};
        if (detail.document !== 'hidden-content' || detail.revision === loadedRevision) return;
        // Nothing read yet: the first read takes the current rules anyway.
        if (!hiddenData) return;
        // A real move: a read now, and a fresh set of retries if it fails.
        retryAttempt = 0;
        revalidate();
    });

    // A page shown after reads that failed (or gave up): the rules known to be newer are read again now.
    try {
        JE.core?.navigation?.onNavigate?.(() => {
            if (!hiddenData || retryTimer || revalidating || knownRevision() === loadedRevision || knownRevision() === null) return;
            retryAttempt = 0;
            revalidate();
        });
    } catch (_) { /* no navigation module: the next revision reads again */ }

    // Hidden-content data is per-user. Clear the local mirror the moment the
    // identity changes (don't read JE.userConfig here — reset handlers run in
    // registration order and the globals may not be wiped yet), then rebuild
    // from the incoming user's config once the re-bootstrap has loaded it.
    // The previous person's read and its retry end with them.
    JE.session?.onUserChange('hidden-content-data', () => {
        hiddenData = null;
        baseJson = null;
        loadedRevision = null;
        revisionPending = false;
        revalidating = null;
        cancelRetry();
        retryAttempt = 0;
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
        revalidate,
        prepareSave,
        savedAs,
        /** @returns {boolean} A newer revision of the rules is waiting to be read (after this tab's pending save). */
        hasRevisionPending: () => revisionPending,
    });

})(window.JellyfinEnhanced);
