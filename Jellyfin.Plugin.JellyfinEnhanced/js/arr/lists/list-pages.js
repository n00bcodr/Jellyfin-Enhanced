/**
 * @file Requests & downloads, phase 4c3a: when list pages draw, and when they stop.
 *
 * - On: lists on (server), the playlist or collection page switch on (server), and the person hasn't hidden list
 *   entries or that kind of page in their settings (null follows the household). Nothing is read or watched otherwise,
 *   and turning a preference off removes what is drawn at once.
 * - A details page of a playlist or collection that is shown gets one controller (made once per page element; a page
 *   jellyfin-web keeps hidden is paused: no reads, timers or subscriptions; it reads again when shown).
 * - Stops and removes everything on a person change; answers from before it are dropped by the transport.
 * - Refreshes: a list change made through JE.arrLists (its new view), the shared status feed of the titles shown
 *   (JE.arrStatus.subscribe, inside the controllers), and Jellyfin's LibraryChanged (the list's own items, or new items
 *   that may be an entry arriving), each debounced and bounded per list.
 * - Opening an entry goes to its title at the exact scope (season / episode) through JE.titleDetails; Back returns to
 *   the list and focus goes back to the entry that was opened.
 *
 * Public: JE.arrListPages { uiOn(kind), coveredKeys(listId) → Promise<{keys, entries}|null>, settingsChanged() }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};
    const logPrefix = '🪼 Jellyfin Enhanced: Lists:';

    /** @type {Set<Object>} live controllers */
    const controllers = new Set();
    /** @type {{listId: string, placeholderId: string}|null} the entry opened last (focus returns there on Back) */
    let lastOpened = null;
    let started = false;
    let offChange = null;
    let offLibrary = null;
    let libraryClient = null;
    let viewHook = null;

    /**
     * A person's own list setting (null when never chosen).
     * @param {string} key Settings key.
     * @returns {boolean|null} Value.
     */
    function preference(key) {
        const value = JE.currentSettings?.[key] ?? JE.userConfig?.settings?.[key];
        return value === true ? true : value === false ? false : null;
    }

    /**
     * Whether a kind of list page draws its entries for this person.
     * @param {'playlist'|'collection'} kind Kind.
     * @returns {boolean} On.
     */
    function uiOn(kind) {
        if (JE.arrLists?.enabled?.() !== true) return false;
        const admin = kind === 'collection' ? JE.pluginConfig?.ArrListCollectionUiEnabled === true : JE.pluginConfig?.ArrListPlaylistUiEnabled === true;
        if (!admin || preference('listPlaceholders') === false) return false;
        return preference(kind === 'collection' ? 'listCollectionUi' : 'listPlaylistUi') !== false;
    }

    /**
     * The item id of a details route, or null.
     * @param {string} hash Route hash.
     * @returns {string|null} Id.
     */
    function idFromHash(hash) {
        const value = String(hash || '');
        if (!value.includes('details')) return null;
        const query = value.split('?')[1];
        return query ? lp.render.normalizeId(new URLSearchParams(query).get('id')) : null;
    }

    /**
     * Stops and forgets a controller.
     * @param {Object} ctrl Controller.
     */
    function dispose(ctrl) {
        controllers.delete(ctrl);
        try {
            ctrl.dispose();
        } catch (err) {
            console.warn(`${logPrefix} cleanup failed`, err);
        }
    }

    /** Stops and removes everything drawn (person change, pages switched off). */
    function disposeAll() {
        Array.from(controllers).forEach(dispose);
        // Copies a re-render may have left behind.
        document.querySelectorAll('.je-list-row, .je-list-section').forEach(n => n.remove());
    }

    /**
     * Pauses the controllers of pages that aren't shown, drops those of removed pages.
     * @param {HTMLElement|null} shown The page shown now.
     */
    function prune(shown) {
        for (const ctrl of Array.from(controllers)) {
            if (!ctrl.isAlive()) dispose(ctrl);
            else if (ctrl.page !== shown && !ctrl.paused) ctrl.pause();
        }
    }

    /**
     * A page was shown: attach to it when it is a playlist or collection whose page is on for this person.
     * @param {HTMLElement|null} element The page element (from the view hook).
     * @param {string} hash Route hash.
     * @returns {Promise<void>}
     */
    async function onViewShow(element, hash) {
        const page = element?.classList?.contains('itemDetailPage') ? element : document.querySelector('.itemDetailPage:not(.hide)');
        prune(page);
        if (!uiOn('playlist') && !uiOn('collection')) return;
        lp.grid.scan();
        const id = idFromHash(hash || window.location.hash);
        if (!id || !page) return;
        const epoch = JE.session?.getEpoch ? JE.session.getEpoch() : 0;
        let item;
        try {
            item = JE.helpers?.getItemCached ? await JE.helpers.getItemCached(id) : await ApiClient.getItem(ApiClient.getCurrentUserId(), id);
        } catch {
            return;
        }
        if ((JE.session?.getEpoch ? JE.session.getEpoch() : 0) !== epoch || !page.isConnected || page.classList.contains('hide')) return;
        if (lp.render.normalizeId(item?.Id) !== id) return;
        const kind = item.Type === 'Playlist' ? 'playlist' : item.Type === 'BoxSet' ? 'collection' : null;
        if (!kind || !uiOn(kind)) return;
        const ctrl = kind === 'playlist' ? lp.playlist.attach(page, id) : lp.collection.attach(page, id);
        if (!ctrl) return;
        controllers.add(ctrl);
        if (lastOpened && lastOpened.listId === id) {
            ctrl.focusOnRender = lastOpened.placeholderId;
            lastOpened = null;
        }
        ctrl.resume();
    }

    /**
     * Opens an entry's title at its exact scope (season / episode), keeping where the person was for Back.
     * @param {Object} ctrl Controller of the page.
     * @param {Object} ph Entry.
     * @returns {void}
     */
    function openEntry(ctrl, ph) {
        if (!lp.render.opensTitle(ph)) return;
        lastOpened = { listId: ctrl.listId, placeholderId: ph.id };
        const options = { mediaType: ph.mediaType === 'movie' ? 'movie' : 'tv', tmdbId: Number(ph.tmdbId) || undefined };
        if (ph.kind === 'season' || ph.kind === 'episodes') options.season = Number(ph.seasonNumber);
        if (ph.kind === 'episodes' && (ph.episodes || []).length === 1) options.episode = Number(ph.episodes[0]?.e);
        if (typeof JE.titleDetails?.openKey === 'function') {
            JE.titleDetails.openKey(ph.titleKey, options).catch?.(() => {});
        } else if (Number(ph.tmdbId) > 0 && typeof JE.jellyseerrMoreInfo?.open === 'function') {
            JE.jellyseerrMoreInfo.open(Number(ph.tmdbId), options.mediaType);
        }
    }

    /**
     * Jellyfin's LibraryChanged: the controllers decide whether to read their list again.
     * @param {Object} message {Data: {ItemsAdded, ItemsUpdated, ItemsRemoved}}.
     */
    function onLibraryChanged(message) {
        const data = message?.Data || message;
        if (!data) return;
        const added = Array.isArray(data.ItemsAdded) && data.ItemsAdded.length > 0;
        const ids = new Set([].concat(data.ItemsUpdated || [], data.ItemsAdded || [], data.ItemsRemoved || []).map(lp.render.normalizeId).filter(Boolean));
        if (!ids.size) return;
        ids.forEach(id => lp.grid.invalidate(id));
        for (const ctrl of controllers) {
            if (ctrl.isAlive() && !ctrl.paused) ctrl.onLibraryChanged(ids, added);
        }
    }

    /** Subscribes to LibraryChanged on the current ApiClient (moved when jellyfin-web replaces the client). */
    function subscribeLibrary() {
        const client = typeof ApiClient !== 'undefined' ? ApiClient : null;
        if (client === libraryClient) return;
        try {
            offLibrary?.();
        } catch {
            // The old socket is gone with its client.
        }
        offLibrary = null;
        libraryClient = null;
        if (client && typeof client.subscribe === 'function') {
            try {
                const off = client.subscribe(['LibraryChanged'], onLibraryChanged);
                offLibrary = typeof off === 'function' ? off : null;
                libraryClient = client;
            } catch (err) {
                console.warn(`${logPrefix} LibraryChanged subscription failed`, err);
            }
        }
    }

    /** Starts the pages (once, while on); stops them when they are off for this person. */
    function sync() {
        const on = uiOn('playlist') || uiOn('collection');
        if (on && !started) {
            started = true;
            offChange = JE.arrLists.onChange((listId, view) => {
                lp.grid.invalidate(listId);
                const id = lp.render.normalizeId(listId);
                for (const ctrl of controllers) {
                    if (ctrl.listId !== id || ctrl.paused) continue;
                    if (view) ctrl.applyView(view, { fromChange: true });
                    else ctrl.scheduleRefetch(500);
                }
            });
            subscribeLibrary();
            lp.grid.start();
            const onView = JE.core?.navigation?.onViewPage || JE.helpers?.onViewPage;
            if (onView && !viewHook) viewHook = onView((view, element, hash) => { onViewShow(element, hash); }, { immediate: true });
            else onViewShow(null, window.location.hash);
        } else if (!on && started) {
            started = false;
            offChange?.();
            offChange = null;
            lp.grid.stop();
            disposeAll();
        } else if (on) {
            // The person changed one of the kinds: drop the controllers of a kind now off, draw the other again.
            for (const ctrl of Array.from(controllers)) if (!uiOn(ctrl.kind)) dispose(ctrl);
            lp.grid.reset();
            document.querySelectorAll('.card[data-je-list-grid]').forEach(card => lp.grid.decorate(card, '', 0));
            lp.grid.scan();
            onViewShow(null, window.location.hash);
        }
    }

    /**
     * What a collection's own section already offers this person (for the collection-gap rows): from their view of
     * it, only while the collection page draws its entries; null when it doesn't (nothing is covered then).
     * @param {string} listId Collection id.
     * @returns {Promise<{keys: Set<string>, entries: Array<Object>}|null>} Covered keys.
     */
    async function coveredKeys(listId) {
        const id = lp.render.normalizeId(listId);
        if (!id || !uiOn('collection')) return null;
        const epoch = JE.session?.getEpoch ? JE.session.getEpoch() : 0;
        try {
            const answer = await JE.arrLists.getList(id);
            if ((JE.session?.getEpoch ? JE.session.getEpoch() : 0) !== epoch || answer.status !== 200 || answer.body?.listKind !== 'collection') return null;
            return lp.collection.coveredOf(answer.body);
        } catch {
            return null;
        }
    }

    JE.session?.onUserChange?.('arr-list-pages', () => {
        lastOpened = null;
        disposeAll();
        JE.arrLists?.reset?.();
        lp.grid.reset();
        document.querySelectorAll('.card[data-je-list-grid]').forEach(card => lp.grid.decorate(card, '', 0));
        subscribeLibrary();
        // The new person's settings decide whether the pages stay on (they arrive after the switch).
        setTimeout(sync, 0);
    });

    lp.pages = { uiOn, idFromHash, onViewShow, openEntry, onLibraryChanged, sync, controllers, disposeAll };
    JE.arrListPages = Object.freeze({ uiOn, coveredKeys, settingsChanged: sync });

    // No network and no DOM work while the bundle loads: the first look happens a moment later.
    if (JE.arrLists?.enabled?.() === true && (JE.pluginConfig?.ArrListPlaylistUiEnabled === true || JE.pluginConfig?.ArrListCollectionUiEnabled === true)) {
        setTimeout(() => { if (!started) sync(); }, 400);
    }
})(window.JellyfinEnhanced);
