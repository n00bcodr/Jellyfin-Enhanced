import { installOnce, onDispose, selectionLease, enqueueWrite, pendingWrites } from './host';
import { lease, policyLease } from './host';
import { record, decodeLibraryItem } from './model';
import { host, registry, type HiddenHost } from './host';
/**
 * @file Hidden Content — the client-side filter engine: scope-aware surface
 * detection, native card filtering, parent-series cascading, and the
 * navigation/mutation observers that drive it.
 * Split from hidden-content.js (code motion; bodies verbatim). This module is
 * jank-sensitive: injection/observation timing is identical to the original —
 * debouncedFilterNative is built at script parse time and setupNativeObserver
 * registers the same onViewPage hook and priority-10 body-mutation subscriber.
 */
(function (JE: HiddenHost) {
    if(!installOnce(JE,'hidden-content-filter'))return;
    'use strict';
    const internal = registry(JE, 'hiddenContent');

    const { hiddenIdSet, normalizeId, getSettings, shouldFilterSurface, getHiddenData, getHiddenCount } = internal;
    // Late-bound cross-module reference (defined in hidden-content-buttons.js).
    const addLibraryHideButtons = () => internal.addLibraryHideButtons();

    const parentSeriesCache = new Map<string,string|null>();
    const parentSeriesRequestMap = new Map<string,Promise<string|null|undefined>>();

    // Item lookups were fetched as the previous user (library access and
    // spoiler stripping differ per user) — drop them on a user switch, and
    // un-hide + un-mark every card the previous user's policy touched so the
    // new user's list is re-evaluated from scratch (the "checked" marker
    // would otherwise keep the old verdict until a full re-render).
    host.JellyfinEnhanced.session?.onUserChange('hidden-content-filter', () => {
        parentSeriesCache.clear();
        parentSeriesRequestMap.clear();
        try {
            document.querySelectorAll('.je-hidden').forEach((el) => el.classList.remove('je-hidden'));
            document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
                el.removeAttribute(PROCESSED_ATTR);
                el.removeAttribute(HIDDEN_PARENT_ATTR);
                el.removeAttribute(HIDDEN_DIRECT_ATTR);
            });
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: hidden-content DOM reset on user switch failed', e);
        }
    });
    const sectionSurfaceCache = new WeakMap<Element,string|null>();

    /** Delay for first detail-page rescan (async episode loading). */
    const DETAIL_RESCAN_DELAY_MS = 500;
    /** Delay for final detail-page rescan. */
    const DETAIL_FINAL_RESCAN_DELAY_MS = 1200;
    /** Debounce interval for the MutationObserver card filter. */
    const NATIVE_FILTER_DEBOUNCE_MS = 50;
    /** Data attribute marking a card as already scanned. */
    const PROCESSED_ATTR = 'data-je-hidden-checked';
    /** Data attribute storing the parent series ID that caused hiding. */
    const HIDDEN_PARENT_ATTR = 'data-je-hidden-parent-series-id';
    /** Data attribute marking a directly-hidden card. */
    const HIDDEN_DIRECT_ATTR = 'data-je-hidden-direct';
    /** Selector for any hideable card/list-item. */
    const CARD_SEL = '.card[data-id], .card[data-itemid], .listItem[data-id]';
    /** Selector for not-yet-scanned cards only. */
    const CARD_SEL_NEW = '.card[data-id]:not([data-je-hidden-checked]), .card[data-itemid]:not([data-je-hidden-checked]), .listItem[data-id]:not([data-je-hidden-checked])';

    /**
     * Fetches the parent series ID for an episode/season item from the API.
     * Results are cached in `parentSeriesCache`; in-flight requests are
     * de-duplicated via `parentSeriesRequestMap`.
     * @param {string} itemId Jellyfin item ID (episode or season).
     * @returns {Promise<string|null>} The series ID, or `null` if unavailable.
     */
    async function getParentSeriesId(itemId: string) {
        if (parentSeriesCache.has(itemId)) {
            return parentSeriesCache.get(itemId);
        }
        if (parentSeriesRequestMap.has(itemId)) {
            return parentSeriesRequestMap.get(itemId);
        }
        const requestToken=lease(JE,true), api=requestToken.api;
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const request = (async () => {
            try {
                const userId = api.getCurrentUserId();
                const item = await api.ajax({
                    type: 'GET',
                    url: api.getUrl(`/Users/${userId}/Items/${itemId}`, { Fields: 'SeriesId' }),
                    dataType: 'json'
                });
                if (!requestToken.current() || (JE.session && !JE.session.isCurrent(requestEpoch))) return null;
                const seriesId = normalizeId(decodeLibraryItem(item).SeriesId) || null;
                parentSeriesCache.set(itemId, seriesId);
                return seriesId;
            } catch (e) {
                if (!requestToken.current() || (JE.session && !JE.session.isCurrent(requestEpoch))) return null;
                console.warn('🪼 Jellyfin Enhanced: Failed to fetch parent series for', itemId, e);
                return null;
            } finally {
                if (!JE.session || JE.session.isCurrent(requestEpoch)) parentSeriesRequestMap.delete(itemId);
            }
        })();
        parentSeriesRequestMap.set(itemId, request);
        return request;
    }

    // ============================================================
    // Scope-aware filtering
    // ============================================================

    /**
     * Detects which home surface a card is displayed on.
     *
     * Delegates to the Remove feature's row detector, so a card is classified the same way
     * when it is hidden and when it is filtered back out. The two used to disagree: this one
     * matched only the English headings "Next Up" / "Continue Watching", so on a translated
     * client it classified nothing and scope-hidden items came back on the next render.
     * Note this is the strict, row-gated detector — a Continue Watching hide must not blank
     * the same item where it also appears in, say, a Recently Added row.
     * @param {HTMLElement} card The card element to check.
     * @returns {'nextup'|'continuewatching'|null} The detected surface or null.
     */
    function getCardSurface(card: HTMLElement) {
        if (typeof JE.detectCardRowSurface === 'function') return JE.detectCardRowSurface(card);

        // Fallback for the (unsupported) case of the Remove module not being loaded.
        const section = card.closest('.section, .verticalSection, .homeSection');
        if (!section) return null;
        if (sectionSurfaceCache.has(section)) return sectionSurfaceCache.get(section) ?? null;
        const titleEl = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
        const title = (titleEl?.textContent || '').toLowerCase();
        let surface: string | null = null;
        if (title.includes('next up')) surface = 'nextup';
        else if (title.includes('continue watching')) surface = 'continuewatching';
        sectionSurfaceCache.set(section, surface);
        return surface;
    }

    /**
     * Checks if an item should be hidden on a specific surface, respecting hide scope.
     * Items with scope 'global' are hidden everywhere.
     * Items with scope 'nextup' or 'continuewatching' are only hidden on their respective surfaces.
     * The 'homesections' scope matches both 'nextup' and 'continuewatching'.
     * @param {string} itemId The Jellyfin item ID.
     * @param {string} surface The surface to check ('nextup', 'continuewatching', or 'library').
     * @returns {boolean} `true` if the item is hidden on this surface.
     */
    function isHiddenOnSurface(itemId: string, surface: string) {
        if (!itemId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;

        const data = getHiddenData();
        const items = data.items || {};
        const wanted = normalizeId(itemId);

        for (const key of Object.keys(items)) {
            const item = items[key];
            if (!item) continue;
            if (normalizeId(item.itemId) !== wanted) continue;
            const scope = (item.hideScope || 'global').toLowerCase();
            if (scope === 'global') return true;
            if (scope === surface) return true;
            if (scope === 'homesections' && (surface === 'nextup' || surface === 'continuewatching')) return true;
        }
        return false;
    }

    // ============================================================
    // Native card filtering
    // ============================================================

    /**
     * Extracts the Jellyfin item ID from a card or list-item element.
     * @param {HTMLElement} el The card element.
     * @returns {string|null} The item ID, or null if not found.
     */
    function getCardItemId(el: HTMLElement) {
        // Normalised so it can be compared against store keys directly — the store
        // holds dashed GUIDs when the server wrote the entry, undashed when the client did.
        if (el.dataset && el.dataset.id) return normalizeId(el.dataset.id);
        if (el.dataset && el.dataset.itemid) return normalizeId(el.dataset.itemid);
        return null;
    }

    /**
     * Determines the current native Jellyfin surface from the URL hash.
     * @returns {'details'|'search'|'upcoming'|'library'} The current surface name.
     */
    function getCurrentNativeSurface() {
        const hash = (window.location.hash || '').toLowerCase();
        if (hash.indexOf('/details') !== -1) return 'details';
        if (hash.indexOf('/search') !== -1) return 'search';
        if (hash.indexOf('/upcoming') !== -1) return 'upcoming';
        return 'library';
    }

    /**
     * Asynchronously checks whether a card's parent series is hidden and,
     * if so, hides the card.  Used for episode/season cards in library views.
     * @param {HTMLElement} card The card element.
     * @param {string} itemId The episode/season's Jellyfin item ID.
     */
    function checkAndHideByParentSeries(card: HTMLElement, itemId: string) {
        if (!card || !itemId) return;
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
        if (hiddenIdSet.size === 0) return;

        const requestToken=lease(JE,true), api=requestToken.api;
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        getParentSeriesId(itemId).then((seriesId) => {
            if (!requestToken.current() || (JE.session && !JE.session.isCurrent(requestEpoch))) return;
            if (!seriesId) return;
            if (!card.isConnected || getCardItemId(card)!==normalizeId(itemId)) return;
            if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;

            if (hiddenIdSet.has(seriesId)) {
                card.classList.add('je-hidden');
                card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            } else if (card.getAttribute(HIDDEN_PARENT_ATTR) === seriesId && card.classList.contains('je-hidden')) {
                card.classList.remove('je-hidden');
                card.removeAttribute(HIDDEN_PARENT_ATTR);
            }
        }).catch((e) => {
            console.warn('🪼 Jellyfin Enhanced: Parent series check failed for', itemId, e);
        });
    }

    /**
     * Batch-checks parent series IDs for multiple cards in a single API call.
     * Cards whose parent series is in `hiddenIdSet` are hidden; others are left alone.
     * @param {Array<{card: HTMLElement, itemId: string}>} cardEntries Cards needing lookup.
     */
    async function batchCheckParentSeries(cardEntries: {card:HTMLElement;itemId:string}[]) {
        if (!cardEntries || cardEntries.length === 0) return;
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
        if (hiddenIdSet.size === 0) return;

        const requestToken=lease(JE,true), api=requestToken.api;
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const canApply = () => requestToken.current() && (!JE.session || JE.session.isCurrent(requestEpoch))
            && getSettings().enabled && shouldFilterSurface(getCurrentNativeSurface());

        // Separate cached from uncached
        const cached: {card:HTMLElement; itemId:string; seriesId:string|null|undefined}[] = [];
        const uncached = [];
        for (const entry of cardEntries) {
            if (parentSeriesCache.has(entry.itemId)) {
                cached.push({ ...entry, seriesId: parentSeriesCache.get(entry.itemId) });
            } else {
                uncached.push(entry);
            }
        }

        // Process cached entries immediately
        if (cached.length > 0) {
            requestAnimationFrame(() => {
                if (!canApply()) return;
                for (const { card, itemId, seriesId } of cached) {
                    if (!card.isConnected || getCardItemId(card)!==normalizeId(itemId) || !seriesId) continue;
                    if (hiddenIdSet.has(seriesId)) {
                        card.classList.add('je-hidden');
                        card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                        card.removeAttribute(HIDDEN_DIRECT_ATTR);
                    }
                }
            });
        }

        // Fetch uncached entries in batches of 50
        if (uncached.length === 0) return;

        const BATCH_SIZE = 50;
        const userId = api.getCurrentUserId();

        for (let start = 0; start < uncached.length; start += BATCH_SIZE) {
            if(!canApply())return;
            const chunk = uncached.slice(start, start + BATCH_SIZE);
            const ids = chunk.map(e => e.itemId).join(',');

            try {
                const result = await api.ajax({
                    type: 'GET',
                    url: api.getUrl(`/Users/${userId}/Items`, { Ids: ids, Fields: 'SeriesId' }),
                    dataType: 'json'
                });

                if (!canApply()) return;
                const itemsById = new Map();
                const responseItems = record(result).Items;
                if (!Array.isArray(responseItems)) throw new Error("Invalid item list");
                for (let i = 0; i < responseItems.length; i++) {
                    const item = decodeLibraryItem(responseItems[i]);
                    if(!item.Id)throw new Error("Missing parent lookup item ID");
                    const itemId = normalizeId(item.Id);
                    const seriesId = normalizeId(item.SeriesId) || null;
                    itemsById.set(itemId, seriesId);
                    parentSeriesCache.set(itemId, seriesId);
                }

                // Also cache items that weren't in the response (deleted, etc.)
                for (const entry of chunk) {
                    if (!itemsById.has(entry.itemId)) {
                        parentSeriesCache.set(entry.itemId, null);
                    }
                }

                // Batch apply hiding
                requestAnimationFrame(() => {
                    if (!canApply()) return;
                    for (const { card, itemId } of chunk) {
                        if (!card.isConnected || getCardItemId(card)!==normalizeId(itemId)) continue;
                        const seriesId = parentSeriesCache.get(itemId);
                        if (seriesId && hiddenIdSet.has(seriesId)) {
                            card.classList.add('je-hidden');
                            card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                            card.removeAttribute(HIDDEN_DIRECT_ATTR);
                        }
                    }
                });
            } catch (e) {
                if (!canApply()) return;
                console.warn('🪼 Jellyfin Enhanced: Batch parent series check failed', e);
                // Fall back to individual lookups for this chunk
                for (const entry of chunk) {
                    checkAndHideByParentSeries(entry.card, entry.itemId);
                }
            }
        }
    }

    /**
     * Restores visibility for cards matching a set of item IDs.
     * Used when un-hiding items to immediately show them again.
     * @param {Set<string>} idsToRestore Set of item IDs to restore.
     */
    function restoreNativeCardsForIds(idsToRestore: Set<string>) {
        if (!idsToRestore || idsToRestore.size === 0) return;
        // Callers pass IDs straight from the store or from an unhide argument, so they may be
        // dashed; the IDs they are matched against here are not. Canonicalise once, up front.
        const wanted = new Set<string>();
        idsToRestore.forEach((id) => {
            const norm = normalizeId(id);
            if (norm) wanted.add(norm);
        });
        if (wanted.size === 0) return;
        document.querySelectorAll<HTMLElement>(CARD_SEL).forEach((card) => {
            card.removeAttribute(PROCESSED_ATTR);
            const cardId = getCardItemId(card);
            const hiddenBySeriesId = normalizeId(card.getAttribute(HIDDEN_PARENT_ATTR));
            if (hiddenBySeriesId && wanted.has(hiddenBySeriesId) && card.classList.contains('je-hidden')) {
                card.classList.remove('je-hidden');
                card.removeAttribute(HIDDEN_PARENT_ATTR);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            } else if ((cardId && wanted.has(cardId)) || card.getAttribute(HIDDEN_DIRECT_ATTR) === '1') {
                card.classList.remove('je-hidden');
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            }
        });
    }

    /**
     * Triggers a full re-filter of all native cards.  If filtering is disabled,
     * restores any previously-hidden cards instead.
     */
    function refreshNativeCardVisibility() {
        const frameToken=policyLease(JE);
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) {
            document.querySelectorAll(CARD_SEL).forEach(card=>{card.classList.remove("je-hidden");card.removeAttribute(HIDDEN_DIRECT_ATTR);card.removeAttribute(HIDDEN_PARENT_ATTR);card.removeAttribute(PROCESSED_ATTR);});
            JE.hideEmptyHomeSections?.();
            return;
        }
        requestAnimationFrame(() => {
            if (!frameToken.current()) return;
            filterAllNativeCards();

        });
    }

    /**
     * Filters only newly-added (not yet scanned) native cards.
     * Called by the debounced MutationObserver callback.
     */
    function filterNativeCards() {
        const frameToken=policyLease(JE);
        const nativeSurface = getCurrentNativeSurface();
        if (!shouldFilterSurface(nativeSurface)) return;
        const settings = getSettings();
        if (!settings.enabled) return;
        if (getHiddenCount() === 0) return;
        const isDetailPage = nativeSurface === 'details';

        const toHide: {card:HTMLElement;itemId:string}[] = [];
        const toShow: {card:HTMLElement;itemId:string}[] = [];
        const pendingParentChecks = [];
        const cards = document.querySelectorAll<HTMLElement>(CARD_SEL_NEW);
        for (const card of cards) {
            // Skip image editor cards (they have data-imagetype attribute)
            if (card.hasAttribute('data-imagetype')) continue;
            const itemId = getCardItemId(card);
            card.setAttribute(PROCESSED_ATTR, '1');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
            if (!itemId) continue;

            // Check scope-aware hiding for cards in Next Up / Continue Watching sections
            const cardSurface = getCardSurface(card);
            if (cardSurface) {
                if (shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
                    toHide.push({card,itemId});
                    card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                    continue;
                }
            }

            if (hiddenIdSet.has(itemId)) {
                toHide.push({card,itemId});
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
            } else {
                if (card.getAttribute(HIDDEN_DIRECT_ATTR) === '1' && card.classList.contains('je-hidden')) {
                    toShow.push({card,itemId});
                    card.removeAttribute(HIDDEN_DIRECT_ATTR);
                }
                if (!isDetailPage) {
                    const cardType = card.dataset.type || '';
                    if (cardType === 'Episode' || cardType === 'Season') {
                        pendingParentChecks.push({ card, itemId });
                    }
                }
            }
        }

        // Batch apply visibility changes
        if (toHide.length > 0 || toShow.length > 0) {
            requestAnimationFrame(() => {
                if (!frameToken.current()) return;
                for (const {card,itemId} of toHide) if(card.isConnected && getCardItemId(card)===itemId)card.classList.add('je-hidden');
                for (const {card,itemId} of toShow) if(card.isConnected && getCardItemId(card)===itemId)card.classList.remove('je-hidden');
                JE.hideEmptyHomeSections?.();
            });
        }

        // Batch parent series checks
        if (pendingParentChecks.length > 0) {
            batchCheckParentSeries(pendingParentChecks);
        }
    }

    /**
     * Filters ALL native cards on the page (including previously scanned ones).
     * Used after settings changes or when the hidden-items set has been modified.
     */
    function filterAllNativeCards() {
        const frameToken=policyLease(JE);
        const nativeSurface = getCurrentNativeSurface();
        if (!shouldFilterSurface(nativeSurface)) return;
        const settings = getSettings();
        if (!settings.enabled) return;
        const isDetailPage = nativeSurface === 'details';

        const toHide: {card:HTMLElement;itemId:string}[] = [];
        const toShow: {card:HTMLElement;itemId:string}[] = [];
        const pendingParentChecks = [];
        const cards = document.querySelectorAll<HTMLElement>(CARD_SEL);
        for (const card of cards) {
            const itemId = getCardItemId(card);
            card.setAttribute(PROCESSED_ATTR, '1');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
            if (!itemId) continue;

            const cardSurface = getCardSurface(card);
            let hiddenByScope = false;
            if (cardSurface && shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
                toHide.push({card,itemId});
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                hiddenByScope = true;
            }

            if (!hiddenByScope) {
                if (hiddenIdSet.has(itemId)) {
                    toHide.push({card,itemId});
                    card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                } else {
                    if (card.classList.contains('je-hidden')) {
                        toShow.push({card,itemId});
                        card.removeAttribute(HIDDEN_DIRECT_ATTR);
                    }
                    if (!isDetailPage) {
                        const cardType = card.dataset.type || '';
                        if (cardType === 'Episode' || cardType === 'Season') {
                            pendingParentChecks.push({ card, itemId });
                        }
                    }
                }
            }
        }

        // Batch apply visibility changes
        if (toHide.length > 0 || toShow.length > 0) {
            requestAnimationFrame(() => {
                if (!frameToken.current()) return;
                for (const {card,itemId} of toHide) if(card.isConnected && getCardItemId(card)===itemId)card.classList.add('je-hidden');
                for (const {card,itemId} of toShow) if(card.isConnected && getCardItemId(card)===itemId)card.classList.remove('je-hidden');
                JE.hideEmptyHomeSections?.();
            });
        }

        // Batch parent series checks
        if (pendingParentChecks.length > 0) {
            batchCheckParentSeries(pendingParentChecks);
        }
    }

    // ============================================================
    // Native observer setup
    // ============================================================

    const debouncedFilterNative = JE.helpers?.debounce
        ? JE.helpers.debounce(() => { requestAnimationFrame(filterNativeCards); }, NATIVE_FILTER_DEBOUNCE_MS)
        : filterNativeCards;

    /**
     * Sets up page-navigation and MutationObserver hooks to trigger card
     * filtering and button injection when new cards appear in the DOM.
     */
    let observerInstalled=false;
    function setupNativeObserver() {
        if(observerInstalled)return;observerInstalled=true;
        // Use onViewPage for page navigation — much cheaper than a body MutationObserver
        if (JE.helpers?.onViewPage) {
            JE.helpers.onViewPage(() => {
                // Detail pages load episodes asynchronously — staggered re-scans catch late-rendered cards
                if (getCurrentNativeSurface() === 'details') {
                    const rescan = () => {
                        refreshNativeCardVisibility();
                        if (getSettings().showButtonLibrary) addLibraryHideButtons();
                    };
                    setTimeout(rescan, DETAIL_RESCAN_DELAY_MS);
                    setTimeout(rescan, DETAIL_FINAL_RESCAN_DELAY_MS);
                }
            });
        }

        // Lightweight observer for card/list containers
        if (typeof JE?.helpers?.onBodyMutation === 'function') {
            // Priority 10: hidden-content must run before other subscribers (tags, bookmarks, etc.)
            // so it can filter/hide cards before other modules waste time processing them
            JE.helpers.onBodyMutation('hidden-content', (mutations) => {
                const settings = getSettings();
                if (!settings.enabled) return;
                const shouldFilter = getHiddenCount() > 0;
                const shouldAddButtons = settings.showHideButtons && settings.showButtonLibrary;
                if (!shouldFilter && !shouldAddButtons) return;
                let hasNewItems = false;
                for (let i = 0; i < mutations.length; i++) {
                    const added = mutations[i]?.addedNodes;
                    if (!added) continue;
                    for (let j = 0; j < added.length; j++) {
                        const node = added[j];
                        if (node instanceof Element && (
                            node.classList?.contains('card') ||
                            node.classList?.contains('listItem') ||
                            node.querySelector?.('.card[data-id], .listItem[data-id]')
                        )) {
                            hasNewItems = true;
                            break;
                        }
                    }
                    if (hasNewItems) break;
                }
                if (hasNewItems) {
                    if (shouldFilter) debouncedFilterNative();
                    if (shouldAddButtons) addLibraryHideButtons();
                }
            }, { priority: 10 });
        }
    }

    Object.assign(internal, {
        getCardSurface,
        getCardItemId,
        isHiddenOnSurface,
        restoreNativeCardsForIds,
        refreshNativeCardVisibility,
        filterNativeCards,
        filterAllNativeCards,
        setupNativeObserver,
    });

})(host.JellyfinEnhanced);
