import { getApi, lease, invalidatePolicy } from './host';
import { installOnce, onDispose, selectionLease, enqueueWrite, pendingWrites } from './host';
import type { HiddenDataSurface } from './host';
import { decodeDocument, settingsFor, normalizeId, widestScope, sameValue, earliestHiddenAt, aliasMetadata, withChanges, mergeHomeScope as mergeCwScope, type HiddenDocument, type HiddenItem, type Settings } from './model';
import { host, registry, type HiddenHost } from './host';
/**
 * @file Hidden Content — data store, lookup sets, and the public data API.
 * Split from hidden-content.js (code motion; bodies verbatim). Owns the
 * hiddenData closure variable and the ID lookup Sets; every other
 * hidden-content-* module reads state through the functions exported here.
 */
(function (JE: HiddenHost) {
    if(!installOnce(JE,'hidden-content-data'))return;
    'use strict';
    const internal = registry(JE, 'hiddenContent');

    // Late-bound cross-module references (defined in the later-loaded
    // hidden-content-save/dialogs/filter modules).
    const debouncedSave = (...args: Parameters<HiddenDataSurface["debouncedSave"]>) => internal.debouncedSave(...args);
    const showUndoToast = (...args: Parameters<HiddenDataSurface["showUndoToast"]>) => internal.showUndoToast(...args);
    const refreshNativeCardVisibility = (...args: Parameters<HiddenDataSurface["refreshNativeCardVisibility"]>) => internal.refreshNativeCardVisibility(...args);
    const restoreNativeCardsForIds = (...args: Parameters<HiddenDataSurface["restoreNativeCardsForIds"]>) => internal.restoreNativeCardsForIds(...args);

    // ============================================================
    // State
    // ============================================================

    const hiddenIdSet = new Set<string>();
    const hiddenTmdbIdSet = new Set<string>();
    let hiddenData: HiddenDocument | null = null;
    // The stored list as this session last read or wrote it: what it changed since then is its own.
    let storedCopy: HiddenDocument = {items:{},settings:{}};
    let loadValid = true;
    let dataOwner:ReturnType<typeof lease>|null=null;
    let editSequence=0;
    let policyRevision=0;
    let refreshSequence=0;
    const itemEdits=new Map<string,number>();
    const itemIntents=new Map<string,number>();
    let intentReset=0;
    /** Track actual policy changes; equivalent refreshes preserve Undo applicability. */
    function noteItemChanges(before:HiddenDocument['items'],after:HiddenDocument['items'],forced:string[]=[],scopedMirror=false):void {
        for(const key of new Set([...Object.keys(before),...Object.keys(after),...forced])) {
            if(!forced.includes(key)&&sameValue(before[key],after[key]))continue;
            const version=++editSequence;
            itemEdits.set(key,version);
            if(!scopedMirror)for(const id of [before[key]?.itemId,after[key]?.itemId,key]) {
                if(id)itemIntents.set(normalizeId(id),version);
            }
        }
    }
    /** Bind a scoped operation to this logical item's intent, including no-op unhide and reset. */
    function captureItemIntent(itemId:string):{current():boolean} {
        getHiddenData();
        const id=normalizeId(itemId),version=itemIntents.get(id),reset=intentReset;
        return {current:()=>reset===intentReset&&version===itemIntents.get(id)};
    }

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

    /**
     * Returns the in-memory hidden-content data object, lazily initialised
     * from `JE.userConfig.hiddenContent`.
     * @returns {{ items: Object, settings: Object }}
     */
    function getHiddenData(): HiddenDocument {
        if (!hiddenData) {
            resetFromUserConfig();
        }
        return hiddenData ?? {items:{},settings:{}};
    }

    /**
     * Returns the merged settings object (defaults + user overrides).
     * @returns {Object} Merged settings with boolean flags for every filter surface.
     */
    function assertWritable() { getHiddenData(); if (!loadValid || !dataOwner?.current()) throw new Error("Hidden Content policy unavailable; reload before editing"); }

    function getSettings() {
        const data = getHiddenData();
        return settingsFor(data);
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
            if (!item) continue;
            const scope = (item.hideScope || 'global').toLowerCase();
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
    function shouldFilterSurface(surface: string) {
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
        policyRevision++;
        invalidatePolicy(JE);
        try {
            window.dispatchEvent(new CustomEvent('je-hidden-content-changed'));
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to emit hidden-content-changed event', e);
        }
    }

    // Re-fetch from server and replace local cache. Don't call immediately after a server-direct write from THIS tab — use markScopedHidden().
    async function refresh() {
        const before=JSON.stringify(hiddenData);
        const revision=policyRevision,requestId=++refreshSequence;
        const requestToken=lease(JE), api=requestToken.api;
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        try {
            const userId = api.getCurrentUserId();
            if (!userId) return false;
            const fresh = await api.ajax({
                type: 'GET',
                url: api.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`),
                dataType: 'json'
            });
            if (!requestToken.current() || (JE.session && !JE.session.isCurrent(requestEpoch))) return false;
            if (revision!==policyRevision || requestId!==refreshSequence || before!==JSON.stringify(hiddenData)) return false;
            const camelCased = decodeDocument(fresh);
            loadValid = true;
            JE.userConfig = JE.userConfig || {};
            JE.userConfig.hiddenContent = camelCased || { items: {}, settings: {} };
            noteItemChanges(hiddenData?.items??{},camelCased.items);
            hiddenData = camelCased; storedCopy = camelCased; dataOwner=requestToken;
            rebuildSets();
            emitChange();
            refreshNativeCardVisibility();
            return true;
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to refresh hidden-content', e);
            return false;
        }
    }

    // Client-side mirror of MergeHomeScope in HiddenContentController.cs (scoped home-row hide write).

    // Rank-based widest-scope mirror of server's WiderScope — commutative max function for use in folds.
    // Disjoint rank-2 scopes (continuewatching ⊕ nextup) compose to homesections.

    // Local-cache mirror of a server-side hide write — preserves existing metadata + merges scopes via mergeCwScope.
    // Looks up under hyphenated AND N-format keys (server canonical is hyphenated; some callers pass N-format from data-id).
    // The server wrote the entry, so it is recorded as stored first: a save never sends it as this session's change, and
    // removes it when this session has unhidden the item since the write was sent (then only `storedOnly` is recorded).
    function markScopedHidden(itemId: string, scope?: string, storedOnly = false) {
        if (!itemId) return;
        if (!storedOnly) markScopedHidden(itemId, scope, true);
        const _scope = (scope || 'continuewatching').toLowerCase();
        const local = getHiddenData(), data = storedOnly ? storedCopy : local;
        const items = (data.items) || {};
        const noHyphen = itemId.replace(/-/g, '');
        const hyphenated = noHyphen.length === 32
            ? `${noHyphen.slice(0, 8)}-${noHyphen.slice(8, 12)}-${noHyphen.slice(12, 16)}-${noHyphen.slice(16, 20)}-${noHyphen.slice(20)}`
            : itemId;
        // Collect every variant present, fold the widest scope across all of them so duplicate keys with
        // disjoint scopes (e.g. nextup + continuewatching = homesections) don't durably narrow on collapse.
        // Uses widestScope (rank-based, commutative) for the fold so result is order-independent;
        // mergeCwScope is asymmetric and biased to existing — wrong choice for a max-fold.
        const variants = [items[itemId], items[hyphenated], items[noHyphen]].filter((item): item is HiddenItem => item !== undefined);
        const widestExisting = variants.reduce((acc, e) => widestScope(acc, e.hideScope || 'global'), '');
        const finalScope = mergeCwScope(widestExisting, _scope);
        const existing = aliasMetadata(variants);
        const altPresent = (hyphenated !== itemId && items[hyphenated]) || (noHyphen !== itemId && items[noHyphen]);
        if (items[itemId] && items[itemId]?.hideScope === finalScope && !altPresent) return;
        // Pick the earliest hiddenAt across variants so re-affirming doesn't reset history.

        const merged = {
            ...existing,
            itemId,
            name: existing?.name || '',
            type: existing?.type || '',
            tmdbId: existing?.tmdbId || '',
            hiddenAt: earliestHiddenAt(variants),
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
        if (storedOnly) { storedCopy = { ...data, items: nextItems }; return; }
        noteItemChanges(data.items,nextItems,[],true);
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
    function isHidden(jellyfinItemId: unknown) {
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
    function isHiddenByTmdbId(tmdbId: unknown) {
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
    function hideItem({ itemId, name, type, tmdbId, posterPath, seriesId, seriesName, seasonNumber, episodeNumber, hideScope }: HiddenItem) {
        assertWritable();
        const data = getHiddenData();
        if(!itemId && !tmdbId)throw new Error('Hidden item needs a Jellyfin or TMDB identity');
        const requestedKey=itemId||`tmdb-${tmdbId}`;
        const aliases=Object.entries(data.items).filter(([key,value])=>key===requestedKey || !!itemId&&normalizeId(value.itemId)===normalizeId(itemId));
        const key=aliases.find(([key])=>key===requestedKey)?.[0]??aliases[0]?.[0]??requestedKey;
        const variants=aliases.map(([,value])=>value);
        const previous=data.items[key];
        const metadata=aliasMetadata(previous?[previous,...variants.filter(item=>item!==previous)]:variants);
        const newItem:HiddenItem={
            ...metadata,
            itemId:previous?.itemId||itemId||'', name:name??metadata.name??'', type:type??metadata.type??'',
            tmdbId:tmdbId!=null?String(tmdbId):metadata.tmdbId??'',
            hiddenAt:earliestHiddenAt(variants), posterPath:posterPath??metadata.posterPath??'',
            seriesId:seriesId??metadata.seriesId??'',seriesName:seriesName??metadata.seriesName??'',
            seasonNumber:seasonNumber!==undefined?seasonNumber:metadata.seasonNumber??null,
            episodeNumber:episodeNumber!==undefined?episodeNumber:metadata.episodeNumber??null,
            hideScope:variants.reduce((scope,item)=>widestScope(scope,item.hideScope||'global'),hideScope||'global')
        };
        const items={...data.items};for(const [alias] of aliases)delete items[alias];items[key]=newItem;
        const affected=[...new Set([...aliases.map(([alias])=>alias),key])];
        noteItemChanges(data.items,items,affected);
        const appliedVersions=new Map(affected.map(key=>[key,itemEdits.get(key)]));
        hiddenData={...data,items};JE.userConfig.hiddenContent=hiddenData;
        rebuildSets();debouncedSave();emitChange();
        showUndoToast(name||'Item',key,()=>{
            assertWritable();
            const current=getHiddenData();
            if(affected.some(key=>itemEdits.get(key)!==appliedVersions.get(key)||!sameValue(current.items[key],items[key])))return;
            const restored={...current.items};
            for(const key of affected){if(data.items[key])restored[key]=data.items[key];else delete restored[key];}
            noteItemChanges(current.items,restored,affected);
            hiddenData={...current,items:restored};JE.userConfig.hiddenContent=hiddenData;
            rebuildSets();debouncedSave();emitChange();refreshNativeCardVisibility();
        });
        refreshNativeCardVisibility();
    }

    /**
     * Unhides an item by removing it from the hidden-content data store.
     * Restores visibility for the item's native cards.
     * @param {string} itemId The storage key or Jellyfin item ID to unhide.
     */
    function unhideItem(itemId: string) {
        assertWritable();
        const data = getHiddenData();
        const newItems = { ...data.items };
        let restoredJellyfinId = '';

        const direct=newItems[itemId];
        const wanted=normalizeId(direct?.itemId || (itemId.startsWith('tmdb-') ? '' : itemId));
        for(const [key,item] of Object.entries(newItems)) {
            if(key===itemId || (wanted && normalizeId(item.itemId)===wanted)) {
                restoredJellyfinId=item.itemId || restoredJellyfinId;
                delete newItems[key];
            }
        }

        noteItemChanges(data.items,newItems,[itemId]);
        hiddenData = { ...data, items: newItems };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();

        const idsToRestore = new Set<string>();
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
    function updateSettings(partial: Partial<Settings>) {
        assertWritable();
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
    function filterJellyseerrResults<T extends {id?: unknown; tmdbId?: unknown}>(results: T[], surface: string) {
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
    function filterCalendarEvents<T extends {tmdbId?: unknown; itemId?: unknown; title?: string}>(events: T[]) {
        if (!shouldFilterSurface('calendar')) return events;
        if (!Array.isArray(events)) return events;

        // Build a set of normalised hidden-item names for fuzzy matching
        const hiddenNames = new Set<string>();
        const items = (getHiddenData().items) || {};
        for (const key of Object.keys(items)) {
            if ((items[key]?.hideScope || 'global') !== 'global') continue;
            const name = items[key]?.name;
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
    function filterRequestItems<T extends {tmdbId?: unknown; id?: unknown; jellyfinMediaId?: unknown}>(items: T[]) {
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
        assertWritable();
        const oldHiddenIds = new Set(hiddenIdSet);
        const data = getHiddenData();
        intentReset++;
        noteItemChanges(data.items,{});
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
        policyRevision++; intentReset++; itemIntents.clear();
        try {
            const next = JE.userConfig?.hiddenContent == null ? { items: {}, settings: {} } : decodeDocument(JE.userConfig.hiddenContent);
            // A list that failed to load (null) is unknown, not empty: nothing shows as hidden and edits are refused.
            hiddenData = next; storedCopy = next; dataOwner=lease(JE); itemEdits.clear(); loadValid = JE.userConfig?.hiddenContent != null; rebuildSets();
        } catch (error) { hiddenData ??= {items:{},settings:{}}; loadValid = false; console.warn("Invalid hidden-content policy", error); }
    }

    /**
     * A save writes the whole list, so it starts from `stored`, the list as just read (another device, an
     * administrator or the server may have changed it), and applies only what this session changed. `saved()`,
     * called once that is written, takes the result as this session's list, keeping edits made meanwhile.
     */
    function rebaseOnto(stored: HiddenDocument) {
        assertWritable();
        const owner=dataOwner, sent=getHiddenData(), merged=withChanges(storedCopy, sent, stored);
        return { merged, saved() {
            if (dataOwner !== owner) return;
            const local=getHiddenData(), next=withChanges(sent, local, merged), changed=!sameValue(local, next);
            if (changed) noteItemChanges(local.items, next.items);
            storedCopy = merged; hiddenData = next; JE.userConfig.hiddenContent = next;
            if (changed) { rebuildSets(); emitChange(); refreshNativeCardVisibility(); }
        } };
    }

    // Hidden-content data is per-user. Clear the local mirror the moment the
    // identity changes (don't read JE.userConfig here — reset handlers run in
    // registration order and the globals may not be wiped yet), then rebuild
    // from the incoming user's config once the re-bootstrap has loaded it.
    JE.session?.onUserChange('hidden-content-data', () => {
        policyRevision++; intentReset++; itemIntents.clear();
        hiddenData = { items: {}, settings: {} }; storedCopy = hiddenData;
        loadValid = false; dataOwner=null; itemEdits.clear();
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
        assertWritable,
        captureItemIntent,
        isLoadOk:()=>loadValid,
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
        rebaseOnto,
    });

})(host.JellyfinEnhanced);
