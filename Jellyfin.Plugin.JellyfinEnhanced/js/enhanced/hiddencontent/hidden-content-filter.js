/**
 * @file Hidden Content — the client-side filter engine: scope-aware surface
 * detection, native card filtering, parent-series cascading, and the
 * navigation/mutation observers that drive it.
 * Split from hidden-content.js (code motion; bodies verbatim). This module is
 * jank-sensitive: injection/observation timing is identical to the original —
 * debouncedFilterNative is built at script parse time and setupNativeObserver
 * registers the same onViewPage hook and priority-10 body-mutation subscriber.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    const { hiddenIdSet, normalizeId, getSettings, shouldFilterSurface, getHiddenData, getHiddenCount } = internal;
    // Late-bound cross-module reference (defined in hidden-content-buttons.js).
    const addLibraryHideButtons = (...args) => internal.addLibraryHideButtons(...args);

    const parentSeriesCache = new Map();
    const parentSeriesWork = new Map();
    const parentTitlesWork = new Map();
    const parentTitlesChecked = new Map();

    // Metadata work belongs to the requesting identity. Boundaries invalidate verdict scopes,
    // never walk retained DOM nodes or transfer an outgoing session's work/backoff.
    window.JellyfinEnhanced.session?.onUserChange('hidden-content-filter', () => {
        parentSeriesCache.clear();
        parentSeriesWork.clear();
        parentTitlesWork.clear();
        parentTitlesChecked.clear();
        requestAnimationFrame(filterNativeCards);
    });
    let viewGeneration = 0;
    let visibilityGeneration = 0;
    const cardDecisions = new WeakMap();

    /** Captures the lifetime of a final verdict without exposing session credentials in DOM. */
    function captureNativeDecisionScope() {
        return { action: JE.createSessionAction(), view: viewGeneration, visibility: visibilityGeneration, rules: internal.getRulesGeneration() };
    }

    /** Positive identities/hides survive navigation; negative verdicts also depend on their view. */
    function nativeDecisionScopeCurrent(scope, viewScoped = true) {
        return !!scope && scope.action.current() && scope.visibility === visibilityGeneration && scope.rules === internal.getRulesGeneration() &&
            (!viewScoped || scope.view === viewGeneration);
    }

    /** Sole processed-marker writer: record the decision's identity, surface and lifetime. */
    function markNativeDecision(card, hidden, scope = captureNativeDecisionScope()) {
        if (!nativeDecisionScopeCurrent(scope, !hidden)) return;
        cardDecisions.set(card, { scope, viewScoped: !hidden, itemId: getCardItemId(card),
            surface: getCardSurface(card) || getCurrentNativeSurface() });
        card.setAttribute(PROCESSED_ATTR, `${scope.rules}:${hidden ? 'hide' : scope.view}`);
    }

    /** Sole processed-marker reader, including retained nodes marked in an older scope. */
    function nativeDecisionResolved(card) {
        const decision = cardDecisions.get(card);
        return card.hasAttribute(PROCESSED_ATTR) && !!decision &&
            decision.itemId === getCardItemId(card) && decision.surface === (getCardSurface(card) || getCurrentNativeSurface()) &&
            nativeDecisionScopeCurrent(decision.scope, decision.viewScoped);
    }
    const sectionSurfaceCache = new WeakMap();

    /** Delay for first detail-page rescan (async episode loading). */
    const DETAIL_RESCAN_DELAY_MS = 500;
    /** Delay for final detail-page rescan. */
    const DETAIL_FINAL_RESCAN_DELAY_MS = 1200;
    /** Debounce interval for the MutationObserver card filter. */
    const NATIVE_FILTER_DEBOUNCE_MS = 50;
    /** Data attribute marking a card whose filtering decision is resolved. */
    const PROCESSED_ATTR = 'data-je-hidden-checked';
    /** Data attribute storing the parent series ID that caused hiding. */
    const HIDDEN_PARENT_ATTR = 'data-je-hidden-parent-series-id';
    /** Data attribute marking a directly-hidden card. */
    const HIDDEN_DIRECT_ATTR = 'data-je-hidden-direct';
    /** Selector for any hideable card/list-item. */
    const CARD_SEL = '.card[data-id], .card[data-itemid], .listItem[data-id]';

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
    function getCardSurface(card) {
        const explicit = card.closest('[data-je-hide-surface]')?.dataset.jeHideSurface;
        if (explicit) return explicit;
        if (card.closest('#similarCollapsible, #recommendationsCollapsible, .je-recommendations-section')) return 'recommendations';
        if (card.closest('.je-discovery-grid, .je-native-absent-list, [class*="-discovery-section"]')) return 'discovery';
        if (card.closest('#searchPage, .searchPage')) return 'search';
        if (typeof JE.detectCardRowSurface === 'function') return JE.detectCardRowSurface(card);

        // Fallback for the (unsupported) case of the Remove module not being loaded.
        const section = card.closest('.section, .verticalSection, .homeSection');
        if (!section) return null;
        if (sectionSurfaceCache.has(section)) return sectionSurfaceCache.get(section);
        const titleEl = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
        const title = (titleEl?.textContent || '').toLowerCase();
        let surface = null;
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
    function isHiddenOnSurface(itemId, surface, metadata) {
        if (!itemId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        if (internal.isHidden(itemId, metadata)) return true;

        const data = getHiddenData();
        const items = data.items || {};
        const wanted = normalizeId(itemId);

        for (const key of Object.keys(items)) {
            const item = items[key];
            if (normalizeId(item.itemId) !== wanted) continue;
            const scope = item.hideScope || 'global';
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
    function getCardItemId(el) {
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

    /** Failed and unattempted identities wait before a later ordinary pass retries them. */
    const TITLE_RETRY_AFTER_MS = 30000;

    /** Whether the required parent identity has an authoritative answer, including a successful omission. */
    function parentTitleResolved(seriesId) {
        return !seriesId || !internal.hasProviderRules() || internal.isHidden(seriesId) ||
            nativeDecisionScopeCurrent(parentTitlesChecked.get(seriesId)) || !!internal.titleData({ itemId: seriesId });
    }

    /** Positive parent identity is session-owned; a successful missing parent has verdict scope. */
    function parentSeriesResolved(id) {
        const entry = parentSeriesCache.get(id);
        return !!entry && (!!entry.seriesId || nativeDecisionScopeCurrent(entry.scope));
    }

    /**
     * Resolves child-parent or parent-provider metadata by identity. DOM nodes never own pending work.
     * Concurrent scans share each batch promise; errors and unattempted identities back off for 30s.
     * Successful omissions are resolved "no parent/provider", matching the native metadata contract.
     */
    async function hydrateParentMetadata(ids, providers, action) {
        const work = providers ? parentTitlesWork : parentSeriesWork;
        const resolved = id => providers ? parentTitleResolved(id) : parentSeriesResolved(id);
        for (const id of ids) {
            const old = work.get(id);
            if (old?.action && !old.action.current()) work.delete(id);
        }
        const wanted = [...new Set(ids)].filter(id => id && !resolved(id));
        const pending = wanted.map(id => work.get(id)?.promise).filter(Boolean);
        const missing = wanted.filter(id => !work.get(id)?.promise && Date.now() >= (work.get(id)?.retryAt || 0));
        for (let start = 0; start < missing.length; start += 50) {
            if (!action.current()) return;
            // Another scan may have started or resolved these future identities while this pass awaited.
            const candidates = missing.slice(start, start + 50);
            pending.push(...candidates.map(id => work.get(id)?.promise).filter(Boolean));
            const batch = candidates.filter(id => !resolved(id) && !work.get(id)?.promise && Date.now() >= (work.get(id)?.retryAt || 0));
            if (!batch.length) continue;
            const job = { action, scope: captureNativeDecisionScope(), promise: null, retryAt: 0 };
            job.promise = (async () => {
                try {
                    const user = ApiClient.getCurrentUserId();
                    let reply;
                    try {
                        reply = await ApiClient.ajax({ type: 'GET', dataType: 'json',
                            url: ApiClient.getUrl(`/Users/${user}/Items`, { Ids: batch.join(','), Fields: providers ? 'ProviderIds' : 'SeriesId' }) });
                    } catch (error) {
                        if (!action.current() || providers || internal.hasProviderRules()) throw error;
                        // Preserve native ID-only fallback; provider rules always use bounded batches.
                        reply = { Items: await Promise.all(batch.map(async id => {
                            if (!action.current()) return null;
                            const item = await ApiClient.ajax({ type: 'GET', dataType: 'json',
                                url: ApiClient.getUrl(`/Users/${user}/Items/${id}`, { Fields: 'SeriesId' }) });
                            return { ...item, Id: id };
                        })) };
                    }
                    if (!action.current()) return;
                    const items = new Map((reply?.Items || []).filter(Boolean).map(item => [normalizeId(item.Id), item]));
                    for (const id of batch) {
                        if (providers) {
                            if (internal.titleData(items.get(id) || { itemId: id })) parentTitlesChecked.delete(id);
                            else parentTitlesChecked.set(id, job.scope);
                        } else parentSeriesCache.set(id, { seriesId: normalizeId(items.get(id)?.SeriesId) || null, scope: job.scope });
                        work.delete(id);
                    }
                } catch (_) {
                    if (!action.current()) return;
                    const retryAt = Date.now() + TITLE_RETRY_AFTER_MS;
                    for (const id of missing.slice(start)) {
                        if (!resolved(id) && (!work.get(id)?.promise || work.get(id) === job)) work.set(id, { action, retryAt });
                    }
                }
            })();
            for (const id of batch) work.set(id, job);
            await job.promise;
            if (!action.current() || !batch.every(resolved)) break;
        }
        await Promise.all(pending);
    }

    /** Resolves and paints retained child cards only when both required metadata decisions are final. */
    async function batchCheckParentSeries(cardEntries) {
        if (!cardEntries?.length || !getSettings().enabled) return;
        if (hiddenIdSet.size === 0 && !internal.hasProviderRules()) return;
        const action = JE.createSessionAction();
        const allowsCard = card => shouldFilterSurface(getCardSurface(card) || getCurrentNativeSurface());
        cardEntries = cardEntries.filter(entry => allowsCard(entry.card));
        await hydrateParentMetadata(cardEntries.map(entry => entry.itemId), false, action);
        if (!action.current()) return;
        if (internal.hasProviderRules()) {
            await hydrateParentMetadata(cardEntries.map(entry => parentSeriesCache.get(entry.itemId)?.seriesId), true, action);
        }
        if (!action.current()) return;
        requestAnimationFrame(() => {
            if (!action.current() || !getSettings().enabled) return;
            for (const { card, itemId } of cardEntries) {
                if (!card.isConnected || getCardItemId(card) !== itemId || !allowsCard(card) || !parentSeriesResolved(itemId)) continue;
                const seriesId = parentSeriesCache.get(itemId)?.seriesId;
                if (!parentTitleResolved(seriesId)) continue;
                // A newer direct/scoped hide remains authoritative over this older parent read.
                if (isHiddenOnSurface(itemId, getCardSurface(card) || getCurrentNativeSurface(),
                    { type: card.dataset.type, tmdbId: card.dataset.tmdbId })) continue;
                const hidden = !!seriesId && internal.isHidden(seriesId);
                card.classList.toggle('je-hidden', hidden);
                if (hidden) card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                else card.removeAttribute(HIDDEN_PARENT_ATTR);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
                markNativeDecision(card, hidden);
            }
        });
    }

    /** Whether a title card needs no more identity work before its visible verdict is final. */
    function cardTitleResolved(card, itemId) {
        return !internal.hasProviderRules() || !['movie', 'series'].includes((card.dataset.type || '').toLowerCase()) ||
            !!internal.titleData({ itemId, type: card.dataset.type, tmdbId: card.dataset.tmdbId }) ||
            internal.isCardTitleResolved?.(itemId);
    }

    /**
     * Restores visibility for cards matching a set of item IDs.
     * Used when un-hiding items to immediately show them again.
     * @param {Set<string>} idsToRestore Set of item IDs to restore.
     */
    function restoreNativeCardsForIds(idsToRestore) {
        if (!idsToRestore || idsToRestore.size === 0) return;
        // Callers pass IDs straight from the store or from an unhide argument, so they may be
        // dashed; the IDs they are matched against here are not. Canonicalise once, up front.
        const wanted = new Set();
        idsToRestore.forEach((id) => {
            const norm = normalizeId(id);
            if (norm) wanted.add(norm);
        });
        if (wanted.size === 0) return;
        document.querySelectorAll(CARD_SEL).forEach((card) => {
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
        if (!getSettings().enabled || JE.pluginConfig?.HiddenContentEnabled === false) {
            visibilityGeneration++;
            document.querySelectorAll(CARD_SEL).forEach(card => {
                card.classList.remove('je-hidden');
                card.removeAttribute(HIDDEN_PARENT_ATTR);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            });
            return;
        }
        requestAnimationFrame(() => {
            filterAllNativeCards();
            if (typeof JE.hideEmptyHomeSections === 'function') {
                JE.hideEmptyHomeSections();
            }
        });
    }

    /**
     * Filters only newly-added (not yet scanned) native cards.
     * Called by the debounced MutationObserver callback.
     */
    function filterNativeCardPass(all) {
        const nativeSurface = getCurrentNativeSurface();
        const settings = getSettings();
        if (!settings.enabled || JE.pluginConfig?.HiddenContentEnabled === false) return;
        const scope = captureNativeDecisionScope();
        void internal.hydrateCardTitles?.();
        const isDetailPage = nativeSurface === 'details';
        const pendingParentChecks = [];
        const changes = [];
        const cards = document.querySelectorAll(CARD_SEL);
        for (const card of cards) {
            if (card.hasAttribute('data-imagetype') || (!all && nativeDecisionResolved(card))) continue;
            const itemId = getCardItemId(card);
            card.removeAttribute(PROCESSED_ATTR);
            if (!itemId) continue;
            const cardSurface = getCardSurface(card) || nativeSurface;
            const allows = shouldFilterSurface(cardSurface);
            const hidden = allows && isHiddenOnSurface(itemId, cardSurface,
                { type: card.dataset.type, tmdbId: card.dataset.tmdbId });
            if (hidden) {
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                card.removeAttribute(HIDDEN_PARENT_ATTR);
                markNativeDecision(card, true, scope);
            } else if (allows && !isDetailPage && ['Episode', 'Season'].includes(card.dataset.type) &&
                (hiddenIdSet.size > 0 || internal.hasProviderRules())) {
                // Preserve an existing hide until its asynchronous parent verdict is resolved.
                pendingParentChecks.push({ card, itemId });
                continue;
            } else {
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
                card.removeAttribute(HIDDEN_PARENT_ATTR);
                if (cardTitleResolved(card, itemId)) markNativeDecision(card, false, scope);
            }
            changes.push({ card, hidden, itemId });
        }
        if (changes.length) requestAnimationFrame(() => {
            if (!nativeDecisionScopeCurrent(scope, false) || !getSettings().enabled) return;
            for (const { card, hidden, itemId } of changes) {
                if (getCardItemId(card) !== itemId || (!hidden && !nativeDecisionScopeCurrent(scope))) continue;
                card.classList.toggle('je-hidden', hidden);
            }
        });
        if (pendingParentChecks.length) void batchCheckParentSeries(pendingParentChecks);
    }

    /** Ordinary scans revisit unresolved or expired retained-node verdicts. */
    function filterNativeCards() {
        filterNativeCardPass(false);
    }

    /** Full passes use the same decision writer/reader and identity work owner as ordinary scans. */
    function filterAllNativeCards() {
        filterNativeCardPass(true);
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
    function setupNativeObserver() {
        // Use onViewPage for page navigation — much cheaper than a body MutationObserver
        if (JE.helpers?.onViewPage) {
            JE.helpers.onViewPage(() => {
                // Successful missing-provider answers belong to this view; retries remain session-owned.
                viewGeneration++;
                parentTitlesChecked.clear();
                internal.resetCardTitleVerdicts?.();
                requestAnimationFrame(filterNativeCards);
                // Detail pages load episodes asynchronously — staggered re-scans catch late-rendered cards
                if (getCurrentNativeSurface() === 'details') {
                    const rescan = () => {
                        refreshNativeCardVisibility();
                        if (getSettings().showButtonLibrary || getSettings().showButtonJellyseerr || getSettings().showButtonCast) addLibraryHideButtons();
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
                const shouldAddButtons = settings.showHideButtons && (settings.showButtonLibrary || settings.showButtonJellyseerr || settings.showButtonCast);
                if (!shouldFilter && !shouldAddButtons) return;
                let hasNewItems = false;
                for (let i = 0; i < mutations.length; i++) {
                    const added = mutations[i].addedNodes;
                    for (let j = 0; j < added.length; j++) {
                        const node = added[j];
                        if (node.nodeType === 1 && (
                            node.classList?.contains('card') ||
                            node.classList?.contains('listItem') || node.hasAttribute?.('data-je-hide-title') ||
                            node.querySelector?.('.card[data-id], .listItem[data-id], [data-je-hide-title]')
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
        captureNativeDecisionScope,
        nativeDecisionScopeCurrent,
        getCurrentNativeSurface,
        getCardSurface,
        getCardItemId,
        isHiddenOnSurface,
        restoreNativeCardsForIds,
        refreshNativeCardVisibility,
        filterNativeCards,
        filterAllNativeCards,
        setupNativeObserver,
    });

})(window.JellyfinEnhanced);
