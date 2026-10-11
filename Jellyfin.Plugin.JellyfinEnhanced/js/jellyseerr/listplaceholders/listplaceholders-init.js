// /js/jellyseerr/listplaceholders/listplaceholders-init.js
// Starts list placeholders (plugin.js calls JE.initializeListPlaceholders only while the
// admin setting is on) and publishes the public facade other modules call at call time:
// the Seerr card / more-info "Add to collection or playlist" actions and the
// "Missing from <collection>" filter (B7).
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};
    const logPrefix = '🪼 Jellyfin Enhanced: List placeholders:';

    /**
     * Re-GET delay after library arrivals that don't name the list: swaps that only change
     * placeholders (collection season progress, a title already in the list, metadata) never
     * touch the list item itself, so its id isn't in the message.
     */
    const LIBRARY_ADDED_REFETCH_MS = 3000;

    let initialized = false;
    let unsubscribeLibrary = null;
    /** The ApiClient the LibraryChanged subscription is on (jellyfin-web binds subscribe per client). */
    let subscribedClient = null;

    /**
     * The item id of a details route, or null.
     * @param {string} hash - location.hash.
     * @returns {string|null}
     */
    function idFromHash(hash) {
        const value = String(hash || '');
        if (!value.includes('details')) return null;
        const query = value.split('?')[1];
        if (!query) return null;
        return lp.normalizeId(new URLSearchParams(query).get('id'));
    }

    /**
     * Forgets a controller and stops its observer and timers.
     * @param {Object} ctrl
     */
    function disposeController(ctrl) {
        lp.controllers.delete(ctrl);
        try {
            ctrl.dispose?.();
        } catch (error) {
            console.warn(`${logPrefix} controller cleanup failed`, error);
        }
    }

    /** Drops the controllers of pages jellyfin-web removed (its view cache keeps only a few). */
    function pruneControllers() {
        for (const ctrl of Array.from(lp.controllers)) {
            if (!ctrl.isAlive()) disposeController(ctrl);
        }
    }

    /**
     * Runs a callback for every live page controller (dropping controllers of removed pages).
     * @param {function(Object): void} fn
     */
    function forEachController(fn) {
        for (const ctrl of Array.from(lp.controllers)) {
            if (!ctrl.isAlive()) {
                disposeController(ctrl);
                continue;
            }
            try {
                fn(ctrl);
            } catch (error) {
                console.warn(`${logPrefix} controller update failed`, error);
            }
        }
    }

    /**
     * Attaches to a playlist or collection details page when it is shown (and again when a
     * cached page is restored, which re-fetches its view, B3).
     * @param {HTMLElement|null} element - The page element from the view-show hook.
     * @param {string} hash - Route hash.
     * @returns {Promise<void>}
     */
    async function onViewShow(element, hash) {
        pruneControllers();
        lp.sourceUi?.onViewShow(element, hash || window.location.hash);
        const id = idFromHash(hash || window.location.hash);
        if (!id) return;
        const page = element?.classList?.contains('itemDetailPage') ? element : document.querySelector('.itemDetailPage:not(.hide)');
        if (!page) return;
        const epoch = lp.epochNow();
        let item;
        try {
            item = JE.helpers?.getItemCached
                ? await JE.helpers.getItemCached(id)
                : await ApiClient.getItem(ApiClient.getCurrentUserId(), id);
        } catch (_) {
            return;
        }
        if (!lp.isCurrentEpoch(epoch) || !page.isConnected || lp.normalizeId(item?.Id) !== id) return;
        if (item.Type === 'Playlist') lp.playlist.attach(page, item);
        else if (item.Type === 'BoxSet') lp.collection.attach(page, item);
    }

    /**
     * WebSocket LibraryChanged (B3): a change to a list shown here re-fetches its view (1 s);
     * new library items re-fetch every shown list that has placeholders (3 s), and updated ones
     * every shown list with placeholders a library item can match (not custom entries), because
     * a swap that only changes placeholders doesn't name the list (e.g. a later episode of a
     * season whose Season item is already in a collection, or an episode re-identified by a
     * metadata refresh). Jellyfin sends ids in "N" form and batches the message (~30 s after the
     * change); the earliest pending re-fetch wins, so it is one GET per list and message at most.
     * @param {Object} message - {MessageType, Data}.
     */
    function onLibraryChanged(message) {
        const data = message?.Data;
        if (!data) return;
        const added = Array.isArray(data.ItemsAdded) && data.ItemsAdded.length > 0;
        const ids = new Set([].concat(data.ItemsUpdated || [], data.ItemsAdded || []).map(lp.normalizeId).filter(Boolean));
        if (!ids.size) return;
        forEachController((ctrl) => {
            const placeholders = ctrl.view?.placeholders || [];
            if (ids.has(ctrl.listId)) ctrl.scheduleRefetch();
            else if (added ? placeholders.length > 0 : placeholders.some(p => p.kind !== 'custom')) ctrl.scheduleRefetch(LIBRARY_ADDED_REFETCH_MS);
        });
    }

    /**
     * Subscribes to LibraryChanged on the current ApiClient, moving the subscription when jellyfin-web replaced
     * window.ApiClient (server switch): its subscribe is bound to each client's own socket.
     */
    function subscribeLibrary() {
        const client = typeof ApiClient !== 'undefined' ? ApiClient : null;
        if (client === subscribedClient) return;
        try {
            unsubscribeLibrary?.();
        } catch (error) {
            console.warn(`${logPrefix} LibraryChanged unsubscribe failed`, error);
        }
        unsubscribeLibrary = null;
        subscribedClient = null;
        try {
            if (client && typeof client.subscribe === 'function') {
                unsubscribeLibrary = client.subscribe(['LibraryChanged'], onLibraryChanged);
                subscribedClient = client;
            }
        } catch (error) {
            console.warn(`${logPrefix} LibraryChanged subscription failed`, error);
        }
    }

    /**
     * Starts the feature. No-op unless ListPlaceholdersEnabled is on; safe to call twice.
     */
    function initialize() {
        if (initialized || !lp.isEnabled()) return;
        initialized = true;

        document.addEventListener(lp.events.VIEW, (e) => {
            const { listId, view } = e.detail || {};
            forEachController((ctrl) => { if (ctrl.listId === listId) ctrl.applyView(view); });
        });
        document.addEventListener('jellyseerr-media-requested', (e) => {
            if (lp.requests.markRequested(e.detail)) forEachController(ctrl => ctrl.onRequested());
        });
        subscribeLibrary();
        JE.session?.onUserChange?.('list-placeholders', () => {
            lp.api.resetCaches();
            lp.requests.reset();
            lp.actions.closeMenu();
            lp.importer?.closeAll?.();
            Array.from(lp.controllers).forEach(disposeController);
            subscribeLibrary();
        });
        const onView = JE.core?.navigation?.onViewPage || JE.helpers?.onViewPage;
        if (onView) onView((view, element, hash) => { onViewShow(element, hash); }, { immediate: true });
    }

    lp.idFromHash = idFromHash;
    lp.onViewShow = onViewShow;
    lp.onLibraryChanged = onLibraryChanged;
    lp.forEachController = forEachController;
    lp.pruneControllers = pruneControllers;
    /** @returns {Function|null} The LibraryChanged unsubscribe (tests). */
    lp.getLibraryUnsubscribe = () => unsubscribeLibrary;

    JE.initializeListPlaceholders = initialize;
    // Merge, never replace: other modules (e.g. listplaceholders-arr.js) add their own members.
    JE.listPlaceholders = Object.assign(JE.listPlaceholders || {}, {
        isEnabled: lp.isEnabled,
        openPicker: (options) => lp.picker.openPicker(options),
        appendCardAction: (card, item) => lp.picker.appendCardAction(card, item),
        appendModalAction: (mount, data, mediaType) => lp.picker.appendModalAction(mount, data, mediaType),
        getPlaceholderTmdbIds: (listId, mediaType) => lp.collection.placeholderTmdbIds(listId, mediaType),
        openImport: (options) => lp.importer.open(options),
        parser: lp.parser
    });

})(window.JellyfinEnhanced);
