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
    const knownTitles = new Map();
    let hiddenData = null;

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

    /** Canonical typed title identity. Ambiguous legacy metadata never spans movie and TV. */
    function titleKey(type, tmdbId) {
        const kind = String(type || '').toLowerCase();
        const id = Number(tmdbId);
        if (!Number.isInteger(id) || id <= 0 || id > 0x7fffffff) return '';
        return (kind === 'movie' ? 'movie' : kind === 'tv' || kind === 'series' ? 'tv' : '') &&
            `${kind === 'movie' ? 'movie' : 'tv'}:tmdb:${id}`;
    }

    /** Gets provider metadata from a known card or a checksum-validated native page identity. */
    function titleData(data) {
        const parts = JE.titleDetails?.parse?.(data.itemId || data.Id || data.id);
        if (parts && !['movie', 'series', 'season', 'episode'].includes(parts.kind)) return null;
        const itemId = data.itemId || data.Id;
        const known = knownTitles.get(normalizeId(itemId));
        const key = titleKey(parts?.kind === 'movie' ? 'movie' : ['series', 'season', 'episode'].includes(parts?.kind) ? 'tv' : data.mediaType || data.kind || data.type || data.Type,
            parts?.tmdbId || data.tmdbId || data.ProviderIds?.Tmdb || (data.mediaType ? data.id : null)) || known;
        if (!key) return null;
        if (itemId && !parts) {
            knownTitles.set(normalizeId(itemId), key);
            if (knownTitles.size > 1024) knownTitles.delete(knownTitles.keys().next().value);
        }
        return { ...data, itemId: '', seriesId: '', type: key.startsWith('movie:') ? 'Movie' : 'Series',
            tmdbId: key.split(':')[2], hideScope: 'global', key };
    }

    let persistence = Promise.resolve();
    /** Serializes bulk and atomic writes in this tab; each task validates its captured viewer. */
    function enqueuePersistence(work) {
        const next = persistence.catch(() => {}).then(work);
        persistence = next;
        return next;
    }
    const ruleWrites = new Map();
    /** Saves a single provider rule. No optimistic success, stale-user writes or full-document replacement. */
    function saveTitleRule(data, hidden) {
        const title = titleData(data);
        if (!title) return Promise.resolve(false);
        const user = ApiClient.getCurrentUserId();
        const action = JE.createSessionAction();
        const previous = ruleWrites.get(title.key) || Promise.resolve();
        // Queue the pending debounce before the atomic write; its acknowledgement is our rule base.
        const flushed = internal.flushPendingSave?.() || Promise.resolve();
        const task = flushed.then(() => previous.catch(() => {})).then(() => enqueuePersistence(async () => {
            if (!action.current()) return false;
            const beforeRules = JSON.parse(JSON.stringify(getHiddenData().items || {}));
            const item = { itemId: '', seriesId: '', type: title.type, tmdbId: title.tmdbId,
                name: title.name || title.title || '', posterPath: title.posterPath || '', hideScope: 'global', hiddenAt: new Date().toISOString() };
            const reply = await ApiClient.ajax({ type: hidden ? 'PUT' : 'DELETE', dataType: 'json',
                url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${user}/hidden-content/rule/${encodeURIComponent(title.key)}`),
                ...(hidden ? { data: JSON.stringify(item), contentType: 'application/json' } : {}) });
            if (!action.current()) return false;
            const current = getHiddenData();
            const authoritative = reply?.items || reply?.Items;
            const items = authoritative ? (typeof JE.toCamelCase === 'function' ? JE.toCamelCase(authoritative) : authoritative) : { ...current.items };
            // A revision describes its complete rule base. Preserve edits made locally while this write awaited.
            if (authoritative) for (const key of new Set([...Object.keys(beforeRules), ...Object.keys(current.items || {})])) {
                if (JSON.stringify(beforeRules[key]) === JSON.stringify(current.items?.[key])) continue;
                if (current.items?.[key]) items[key] = current.items[key];
                else delete items[key];
            }
            for (const key of Object.keys(items)) {
                if (titleKey(items[key].type, items[key].tmdbId) === title.key && (items[key].hideScope || 'global') === 'global') delete items[key];
            }
            if (hidden) items[title.key] = typeof JE.toCamelCase === 'function' ? JE.toCamelCase(reply?.item || reply?.Item || item) : item;
            hiddenData = { ...current, items, revision: authoritative ? reply?.revision || reply?.Revision || current.revision : current.revision };
            JE.userConfig.hiddenContent = hiddenData;
            rebuildSets();
            emitChange();
            refreshNativeCardVisibility();
            if (hidden) showUndoToast(item.name, title.key);
            return true;
        }));
        ruleWrites.set(title.key, task);
        task.finally(() => { if (ruleWrites.get(title.key) === task) ruleWrites.delete(title.key); }).catch(() => {});
        return task;
    }

    /** Shared control host for native pages/cards, modal and future list/home renderers. */
    function buildTitleControl(data, options = {}) {
        const title = titleData(data);
        const settings = getSettings();
        if (!title || JE.pluginConfig?.HiddenContentEnabled === false || !settings.enabled || !settings.showHideButtons ||
            (options.detail ? settings.showButtonDetails === false : settings.showButtonJellyseerr === false)) return null;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = options.detail ? 'button-flat detailButton emby-button je-detail-hide-btn' : 'je-hide-btn';
        button.dataset.jeTitleKey = title.key;
        /** Repaints only changed attributes so mutation observers settle. */
        function paint() {
            const hidden = hiddenTmdbIdSet.has(title.key);
            const label = JE.t(hidden ? 'hidden_content_unhide' : 'hidden_content_hide_button');
            const card = options.card || button.closest('.je-discover-card, .jellyseerr-card, .card, .je-hub-entry, [data-je-hide-title]');
            const surface = typeof options.surface === 'function' ? options.surface() : options.surface || 'recommendations';
            if (card) card.classList.toggle('je-hidden', hidden && shouldFilterSurface(surface));
            button.classList.toggle('je-already-hidden', hidden);
            const iconName = hidden ? 'visibility_off' : 'visibility';
            if (button.dataset.jeHideIcon !== iconName) {
                const content = document.createElement('span');
                content.className = options.detail ? 'detailButton-content' : '';
                const icon = document.createElement('span');
                icon.className = options.detail ? 'material-icons detailButton-icon' : 'material-icons';
                icon.setAttribute('aria-hidden', 'true'); icon.textContent = iconName;
                content.appendChild(icon); button.replaceChildren(content); button.dataset.jeHideIcon = iconName;
            }
            if (button.title !== label) button.title = label;
            if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
        }
        paint();
        button.onclick = async e => {
            e.preventDefault(); e.stopPropagation();
            if (!hiddenTmdbIdSet.has(title.key) && internal.showHideConfirmation && !internal.isConfirmationSuppressed()) {
                internal.showHideConfirmation(title.name || title.title || '', () => run());
                return;
            }
            return run();
        };
        /** Persists before acknowledging the action and leaves a retryable failure on the control. */
        async function run() {
            button.disabled = true;
            try {
                const hidden = !hiddenTmdbIdSet.has(title.key);
                if (await saveTitleRule(title, hidden)) options.onChanged?.(hidden);
                paint();
            } catch (_) {
                delete button.dataset.jeHideIcon;
                button.textContent = JE.t('hidden_content_save_failed_persistent');
                button.setAttribute('aria-label', button.textContent);
            } finally { button.disabled = false; }
        }
        // The owner remounts copied nodes; this property never survives cloneNode.
        button.jeHiddenPaint = paint;
        button.jeHideButtonLive = true;
        return button;
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
            const typed = titleKey(item.type, item.tmdbId);
            if (typed) hiddenTmdbIdSet.add(typed);
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
            document.querySelectorAll('[data-je-title-key], .je-detail-hide-btn, .je-hide-btn').forEach(node => node.jeHiddenPaint?.());
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
     * Checks an item's Jellyfin ID and any already-known typed provider identity.
     * @param {string} jellyfinItemId The Jellyfin item ID.
     * @param {Object} [metadata] Existing library DTO or card metadata; never fetched here.
     * @returns {boolean} `true` if the item is hidden.
     */
    function isHidden(jellyfinItemId, metadata) {
        if (!jellyfinItemId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        const title = titleData({ ...metadata, itemId: jellyfinItemId });
        return hiddenIdSet.has(normalizeId(jellyfinItemId)) || !!title && hiddenTmdbIdSet.has(title.key);
    }

    /**
     * Checks if an item is hidden by its TMDB ID.
     * @param {string|number} tmdbId The TMDB ID.
     * @returns {boolean} `true` if the item is hidden.
     */
    function isHiddenByTmdbId(tmdbId, type) {
        if (!tmdbId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        return hiddenTmdbIdSet.has(titleKey(type, tmdbId));
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
        const provider = titleData({ itemId, name, type, tmdbId, posterPath });
        if ((!itemId || JE.titleDetails?.isSynthetic?.(itemId)) && provider) return saveTitleRule(provider, true).catch(() => false);
        if (JE.titleDetails?.isSynthetic?.(itemId) || JE.titleDetails?.isSynthetic?.(seriesId)) return;
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
     * @param {Object} [metadata] Existing library DTO or card metadata for provider-rule removal.
     */
    function unhideItem(itemId, metadata) {
        if (/^(movie|tv):tmdb:[1-9][0-9]*$/.test(itemId)) {
            const [type, , tmdbId] = itemId.split(':');
            return saveTitleRule({ type, tmdbId }, false).catch(() => false);
        }
        const data = getHiddenData();
        const entry = data.items?.[itemId] || Object.values(data.items || {}).find(item =>
            item.itemId && normalizeId(item.itemId) === normalizeId(itemId));
        const title = titleData({ ...(metadata || entry), itemId });
        if (title && hiddenTmdbIdSet.has(title.key)) {
            // Old detail hides sometimes stored only the Jellyfin id. Remove those exact-item
            // global aliases before the atomic provider delete; the queue flush preserves ordering.
            const wanted = normalizeId(metadata?.Id || metadata?.itemId || entry?.itemId || itemId);
            const items = { ...data.items };
            let changed = false;
            for (const key of Object.keys(items)) {
                if (items[key].itemId && normalizeId(items[key].itemId) === wanted &&
                    (items[key].hideScope || 'global') === 'global' && !titleKey(items[key].type, items[key].tmdbId)) {
                    delete items[key]; changed = true;
                }
            }
            if (changed) {
                hiddenData = { ...data, items };
                JE.userConfig.hiddenContent = hiddenData;
                rebuildSets();
                debouncedSave();
            }
            return saveTitleRule(title, false).catch(() => false);
        }
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
            return !hiddenTmdbIdSet.has(titleKey(item.mediaType || item.kind || item.type, tmdbId));
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
            if (event.tmdbId && hiddenTmdbIdSet.has(titleKey(event.mediaType || event.kind || event.type, event.tmdbId))) return false;
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
            if (tmdbId && hiddenTmdbIdSet.has(titleKey(item.mediaType || item.kind || item.type, tmdbId))) return false;
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
        rebuildSets();
    }

    // Hidden-content data is per-user. Clear the local mirror the moment the
    // identity changes (don't read JE.userConfig here — reset handlers run in
    // registration order and the globals may not be wiped yet), then rebuild
    // from the incoming user's config once the re-bootstrap has loaded it.
    JE.session?.onUserChange('hidden-content-data', () => {
        hiddenData = null;
        hiddenIdSet.clear();
        hiddenTmdbIdSet.clear();
        knownTitles.clear();
        document.querySelectorAll('[data-je-title-key], .je-hide-btn, .je-detail-hide-btn').forEach(button => {
            button.closest('[data-je-hide-title], .je-discover-card, .jellyseerr-card, .card, .je-hub-entry')?.classList.remove('je-hidden');
            button.remove();
        });
    });
    document.addEventListener('je:user-data-loaded', () => {
        resetFromUserConfig();
        internal.addLibraryHideButtons?.();
        emitChange();
        // Re-apply the incoming user's policy to whatever is on screen (the
        // filter reset stripped the previous user's hide marks and verdicts).
        refreshNativeCardVisibility();
    });

    Object.assign(internal, {
        hiddenIdSet,
        hasProviderRules: () => hiddenTmdbIdSet.size > 0,
        titleKey, titleData, saveTitleRule, buildTitleControl, enqueuePersistence,
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
    });

})(window.JellyfinEnhanced);
