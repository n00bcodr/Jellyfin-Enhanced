/**
 * @file Requests & downloads: a details page whose title arrives turns into the normal playable page by
 * itself. One rule for every details page (movie, series, season, episode, and the native page of a
 * title that isn't in the library): once the title shown, or the item Jellyfin replaced it with, is
 * available, the page either moves to that item in its own history entry (Jellyfin gives a missing
 * episode or season a new id once its file is there, and a native page's title gets its library item),
 * or, for the same item, has Jellyfin reload its own page, so Play, badges, media info and versions are
 * Jellyfin's own. It follows the page's status reads (status-details hands each one over; JE's change
 * feed starts them) and Jellyfin's LibraryChanged message about the page's item, season or series,
 * whichever comes first. A change waits while the viewer types, plays or has a dialog open, is checked
 * again right before it happens, happens once (reloads of one page are spaced out), and is dropped when
 * the viewer leaves the page or the user changes.
 */
(function (JE) {
    'use strict';

    /** Pauses in ms (tests shorten them). */
    const timing = {
        /** Jellyfin messages close together make one status read. */
        probe: 1200,
        /** How soon a held change looks again whether the viewer is still busy. */
        recheck: 1000,
        /** After a reload, when Jellyfin has drawn its page again (JE's page handlers then run on it). */
        settle: 1500,
        /** Least time between two reloads of one page. */
        gap: 15000,
        /**
         * A season or series page reloads once its status has stopped changing for this long: a season
         * pack arriving file by file, and Jellyfin dropping the missing episodes the files replace (the
         * Jellyfin bridge does that a few seconds after each file), make one reload.
         */
        batch: 6000,
        /**
         * After the item a page showed was deleted with nothing in its place yet, when to look again
         * (Jellyfin adds the file's item a moment after it drops the missing one); then the page gives up.
         */
        lost: [1500, 4000, 10000, 30000]
    };
    const LIBRARY_ID = /^[0-9a-f]{32}$/;
    const NOT_TYPING = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden']);
    const DIALOGS = '.dialogContainer .dialog, .dialog.opened, [role="dialog"], [aria-modal="true"], .actionSheet, #jellyfin-enhanced-panel';
    /** Viewer actions that mean they moved the page themselves (their scroll position is theirs to keep). */
    const INTENTS = ['wheel', 'touchmove', 'keydown', 'mousedown'];

    /**
     * The page followed now: { view, id, key, kind, base, pending, timer, probeTimer, reloadedAt, tried, parents }.
     * `base` is what the page was drawn with (its first status, then each change acted on).
     * @type {Object|null}
     */
    let page = null;
    /** Jellyfin's message subscription: { client, off }. */
    let socket = null;
    /**
     * The scope key each item's page showed lately (item id -> key): a page shown again after Jellyfin
     * deleted its item (the viewer was on other pages meanwhile) still finds its successor.
     * @type {Map<string, string>}
     */
    const keys = new Map();
    const KEYS_KEPT = 50;

    /**
     * An item id in one form (no dashes, lower case).
     * @param {*} id Id.
     * @returns {string} Id, or ''.
     */
    function norm(id) {
        return typeof id === 'string' ? id.replace(/-/g, '').toLowerCase() : '';
    }

    /**
     * A Jellyfin library item id (never a native page's id or anything else).
     * @param {*} id Candidate.
     * @returns {string|null} The id, normalised, or null.
     */
    function libraryId(id) {
        const n = norm(id);
        return LIBRARY_ID.test(n) && !JE.titleDetails?.isSynthetic?.(n) ? n : null;
    }

    /**
     * The query of the details URL shown now.
     * @returns {URLSearchParams} Parameters.
     */
    function hashParams() {
        try {
            return new URLSearchParams((window.location.hash || '').split('?')[1] || '');
        } catch {
            return new URLSearchParams();
        }
    }

    /**
     * The id of the details page in the URL, or null.
     * @returns {string|null} Id.
     */
    function hashId() {
        return /details/i.test(window.location.hash || '') ? hashParams().get('id') : null;
    }

    /**
     * True when the status surfaces are on.
     * @returns {boolean} On.
     */
    function enabled() {
        return !!JE.arrStatus?.enabled?.();
    }

    /**
     * True when an element is on screen: in the page, not hidden by Jellyfin's classes or attributes,
     * and (where the browser lays pages out) with a box.
     * @param {Element|null} n Element.
     * @returns {boolean} Shown.
     */
    function visible(n) {
        if (!n || !n.isConnected || n.closest('.hide, [hidden], [aria-hidden="true"]')) return false;
        const style = window.getComputedStyle ? window.getComputedStyle(n) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
        const laidOut = document.body && document.body.getClientRects().length > 0;
        return !laidOut || n.getClientRects().length > 0;
    }

    /**
     * Why the page can't change under the viewer right now, or null: typing in a field, a dialog,
     * sheet or menu open (Jellyfin's or JE's), or something playing.
     * @returns {'typing'|'dialog'|'playing'|null} Reason.
     */
    function busy() {
        const a = document.activeElement;
        if (a && a !== document.body && (a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'
            || (a.tagName === 'INPUT' && !NOT_TYPING.has(String(a.type || 'text').toLowerCase())))) return 'typing';
        if ([...document.querySelectorAll(DIALOGS)].some(visible)) return 'dialog';
        const bar = document.querySelector('.nowPlayingBar');
        if ((bar && !bar.classList.contains('nowPlayingBar-hidden') && visible(bar))
            || [...document.querySelectorAll('.videoPlayerContainer, #videoOsdPage')].some(visible)) return 'playing';
        return null;
    }

    /**
     * What a status says is available: an episode or movie is there or not; a season or series has
     * so many episodes there.
     * @param {Object} status Status.
     * @returns {{ready: boolean, count: number|null}} Signature.
     */
    function signature(status) {
        if (status.kind === 'season' || status.kind === 'series') {
            const count = status.summary?.ready;
            return { ready: false, count: Number.isFinite(count) ? count : null };
        }
        return { ready: status.stage === 'ready', count: null };
    }

    /**
     * True for a season or series page (its reloads wait for a burst of arrivals to settle).
     * @param {Object} state Page state.
     * @returns {boolean} A list page.
     */
    function listPage(state) {
        return state.kind === 'season' || state.kind === 'series';
    }

    /**
     * True when `now` has more of the title available than `before`.
     * @param {{ready: boolean, count: number|null}} now Signature now.
     * @param {{ready: boolean, count: number|null}} before Signature the page was drawn with.
     * @returns {boolean} More.
     */
    function more(now, before) {
        return (now.ready && !before.ready) || (now.count != null && before.count != null && now.count > before.count);
    }

    /**
     * The page state for a details view and its item: the one followed now, or a new one (the old one,
     * with whatever it was waiting to do, is dropped).
     * @param {HTMLElement} view Details page.
     * @param {string} itemId Its item (or native page) id.
     * @returns {Object|null} Page state.
     */
    function follow(view, itemId) {
        if (!view || !itemId) return null;
        if (page && page.view === view && page.id === itemId) return page;
        drop();
        const state = {
            view, id: itemId, key: keys.get(norm(itemId)) || null, kind: null, base: null, pending: null, timer: null, probeTimer: null,
            lostTimer: null, lostTries: 0, reloadedAt: 0, tried: new Set(), parents: new Set([norm(itemId)])
        };
        page = state;
        if (enabled()) {
            listen();
            learnParents(state);
        }
        return state;
    }

    /**
     * Learns the page item's season and series, whose LibraryChanged entries also concern it (a
     * missing episode's file lands in its season; a new season folder in its series). Read through
     * JE's item cache, which the page's other modules fill.
     * @param {Object} state Page state.
     * @returns {void}
     */
    function learnParents(state) {
        if (!libraryId(state.id) || typeof JE.helpers?.getItemCached !== 'function') return;
        let read;
        try {
            read = JE.helpers.getItemCached(state.id);
        } catch {
            return;
        }
        Promise.resolve(read).then((item) => {
            if (page !== state || !item) return;
            [item.SeriesId, item.SeasonId].forEach((id) => { if (id) state.parents.add(norm(id)); });
        }).catch(() => { /* the item itself is still followed */ });
    }

    /**
     * Forgets the page followed (and what it was waiting to do).
     * @returns {void}
     */
    function drop() {
        const state = page;
        if (!state) return;
        clearTimeout(state.timer);
        clearTimeout(state.probeTimer);
        clearTimeout(state.lostTimer);
        page = null;
    }

    /**
     * Subscribes to Jellyfin's LibraryChanged message once per API client: Jellyfin 12's
     * `ApiClient.subscribe`, or the 10.11 API client's `message` event.
     * @returns {void}
     */
    function listen() {
        const client = window.ApiClient;
        if (!client || socket?.client === client) return;
        unlisten();
        let off = null;
        try {
            if (typeof client.subscribe === 'function') {
                const result = client.subscribe(['LibraryChanged'], msg => onLibrary(msg?.Data));
                off = typeof result === 'function' ? result : null;
            } else {
                client._callbacks = client._callbacks || {};
                const list = client._callbacks.message = client._callbacks.message || [];
                const handler = (e, msg) => { if (msg?.MessageType === 'LibraryChanged') onLibrary(msg.Data); };
                list.push(handler);
                off = () => {
                    const at = list.indexOf(handler);
                    if (at !== -1) list.splice(at, 1);
                };
            }
        } catch {
            off = null;
        }
        socket = { client, off };
    }

    /**
     * Ends the LibraryChanged subscription.
     * @returns {void}
     */
    function unlisten() {
        const current = socket;
        socket = null;
        try { current?.off?.(); } catch { /* the client is gone */ }
    }

    /**
     * Jellyfin's LibraryChanged message: when it names the page's item, season or series, the page's
     * status is read again (once for messages close together). A season or series page that Jellyfin
     * removed something from (the missing episode or season a file replaced) has its own list redrawn.
     * @param {Object} data Message data.
     * @returns {void}
     */
    function onLibrary(data) {
        const state = page;
        if (!state || !data || !enabled()) return;
        const ids = [].concat(data.ItemsAdded || [], data.ItemsUpdated || [], data.ItemsRemoved || [], data.FoldersAddedTo || [], data.FoldersRemovedFrom || []);
        if (!ids.some(id => state.parents.has(norm(id)))) return;
        const self = norm(state.id);
        const removedFromPage = (data.FoldersRemovedFrom || []).some(id => norm(id) === self) && !(data.ItemsRemoved || []).some(id => norm(id) === self);
        if (removedFromPage && state.base && libraryId(state.id) && (state.kind === 'season' || state.kind === 'series')) {
            plan(state, { kind: 'reload', base: state.base });
        }
        if (state.probeTimer) return;
        state.probeTimer = setTimeout(() => {
            state.probeTimer = null;
            if (page === state) JE.internals?.arrStatusDetails?.update?.(true);
        }, timing.probe);
    }

    /**
     * The details surface read the page's status (each read, after drawing it). A successor item named
     * by the status opens in the page's place; more of the title than the page was drawn with reloads
     * Jellyfin's page (the first read is what the page was drawn with, unless Jellyfin restored the page
     * still marked missing although the item has its file now).
     * @param {HTMLElement} view Details page.
     * @param {string} itemId Its item (or native page) id.
     * @param {Object} status Status read.
     * @returns {void}
     */
    function seen(view, itemId, status) {
        if (!status || !enabled()) return;
        const state = follow(view, itemId);
        if (!state) return;
        if (status.key) {
            state.key = status.key;
            const id = norm(itemId);
            keys.delete(id);
            keys.set(id, status.key);
            if (keys.size > KEYS_KEPT) keys.delete(keys.keys().next().value);
        }
        if (status.kind) state.kind = status.kind;
        const target = libraryId(status.openItemId);
        if (target && target !== norm(state.id)) {
            plan(state, { kind: 'replace', target });
            return;
        }
        // A native page has no library item to reload: it only ever moves to one.
        if (!libraryId(state.id)) return;
        const now = signature(status);
        if (!state.base) {
            state.base = now;
            if (now.ready && state.kind === 'episode' && missingShown(view)) plan(state, { kind: 'reload', base: now });
            return;
        }
        if (more(now, state.base)) plan(state, { kind: 'reload', base: now });
    }

    /**
     * True when Jellyfin's page shows the item as missing (its badge in the title area).
     * @param {HTMLElement} view Details page.
     * @returns {boolean} Shown.
     */
    function missingShown(view) {
        return [...view.querySelectorAll('.detailPagePrimaryContainer .missingIndicator, .itemMiscInfo-primary .missingIndicator')].some(visible);
    }

    /**
     * The details surface read nothing for an item that had a status: Jellyfin deleted it (a missing
     * episode or season once its file is there). When the viewer can open an item of the same scope,
     * it opens in the page's place. Jellyfin adds that item a moment after it drops the missing one,
     * so with none yet the page is read again after a pause (and on any live signal meanwhile), a few
     * times, before it gives up. The caller keeps the page as it is while this answers true.
     * @param {HTMLElement} view Details page.
     * @param {string} itemId Its item id.
     * @returns {Promise<boolean>} True while a successor is opening or still looked for.
     */
    async function vanished(view, itemId) {
        if (!enabled()) return false;
        const state = follow(view, itemId);
        if (!state?.key) return false;
        if (state.lostTries > timing.lost.length) return false;
        const answer = await JE.arrStatus.fetchArrival(state.key, libraryId(state.id));
        if (page !== state) return false;
        const target = libraryId(answer?.itemId);
        if (target && target !== norm(state.id)) {
            plan(state, { kind: 'replace', target });
            return true;
        }
        // Looked again after the last pause: nothing came in its place.
        if (state.lostTries === timing.lost.length) {
            state.lostTries++;
            return false;
        }
        clearTimeout(state.lostTimer);
        state.lostTimer = setTimeout(() => {
            state.lostTimer = null;
            if (page === state) JE.internals?.arrStatusDetails?.update?.(true);
        }, timing.lost[state.lostTries++]);
        return true;
    }

    /**
     * Another module (the native page's first look) found that the page's title is here now: the page
     * moves to that item by the same rule (at once, or once the viewer is done).
     * @param {HTMLElement} view Details page.
     * @param {string} fromId The page's id.
     * @param {string} targetId The library item.
     * @returns {boolean} True when it will move (false: not a library item).
     */
    function open(view, fromId, targetId) {
        const target = libraryId(targetId);
        const state = follow(view, fromId);
        if (!state || !target || target === norm(fromId)) return false;
        plan(state, { kind: 'replace', target });
        return true;
    }

    /**
     * Sets what the page is to do (moving to another item wins over a reload) and tries it.
     * @param {Object} state Page state.
     * @param {{kind: 'replace'|'reload', target?: string, base?: Object}} action Action.
     * @returns {void}
     */
    function plan(state, action) {
        if (page !== state) return;
        if (action.kind === 'replace' && state.tried.has(action.target)) return;
        if (action.kind === 'reload' && state.pending?.kind === 'replace') return;
        state.pending = action;
        schedule(state, action.kind === 'reload' && listPage(state) ? timing.batch : 0);
    }

    /**
     * Tries the pending action after a pause.
     * @param {Object} state Page state.
     * @param {number} wait Pause.
     * @returns {void}
     */
    function schedule(state, wait) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            state.timer = null;
            run(state);
        }, Math.max(0, wait));
    }

    /**
     * True while the followed page is the one shown.
     * @param {Object} state Page state.
     * @returns {boolean} Shown.
     */
    function shown(state) {
        return state.view.isConnected && !state.view.classList.contains('hide') && hashId() === state.id;
    }

    /**
     * Does the pending action now, unless the page isn't shown (another page: dropped; hidden: later)
     * or the viewer is busy (later), or the page was reloaded a moment ago (after the gap).
     * @param {Object} state Page state.
     * @returns {void}
     */
    function run(state) {
        if (page !== state || !state.pending) return;
        if (!shown(state)) {
            if (hashId() !== state.id) drop();
            else schedule(state, timing.recheck);
            return;
        }
        if (busy()) {
            schedule(state, timing.recheck);
            return;
        }
        const action = state.pending;
        if (action.kind === 'reload' && state.reloadedAt) {
            const wait = state.reloadedAt + timing.gap - Date.now();
            if (wait > 0) {
                schedule(state, wait);
                return;
            }
        }
        state.pending = null;
        if (action.kind === 'replace') {
            state.tried.add(action.target);
            move(state, action.target);
        } else {
            reload(state, action.base);
        }
    }

    /**
     * Shows another item in the page's history entry (Back goes where it went before), keeping the
     * server and context of the URL.
     * @param {Object} state Page state.
     * @param {string} target Library item id.
     * @returns {void}
     */
    function move(state, target) {
        const params = hashParams();
        params.set('id', target);
        if (!params.get('serverId')) {
            const server = window.ApiClient?.serverId?.();
            if (server) params.set('serverId', server);
        }
        const path = (window.location.hash || '').split('?')[0] || '#/details';
        drop();
        window.location.replace(`${path}?${params.toString()}`);
    }

    /**
     * Has Jellyfin reload its own details page for the same item: JE's copy of the item is refreshed,
     * then the page gets the view events a fresh show sends (its controller reads the item again and
     * draws Play, badges, media info and versions; the hide first releases what its last show
     * subscribed). Only the page hears them (they don't bubble: no theme music, no router). Once it has
     * redrawn, JE's page handlers run on it again, the status is read again, and the viewer's scroll
     * position and focus stay, unless they moved meanwhile.
     * @param {Object} state Page state.
     * @param {{ready: boolean, count: number|null}} base What the page shows from now on.
     * @returns {void}
     */
    function reload(state, base) {
        state.base = base;
        state.reloadedAt = Date.now();
        const scroller = document.scrollingElement || document.documentElement;
        const top = scroller.scrollTop;
        const focused = document.activeElement && document.activeElement !== document.body && state.view.contains(document.activeElement) ? document.activeElement : null;
        let moved = false;
        const mark = () => { moved = true; };
        INTENTS.forEach(type => window.addEventListener(type, mark, { capture: true, passive: true }));
        try {
            const refreshed = JE.helpers?.getItemCached?.(state.id, { forceRefresh: true });
            if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => { /* Jellyfin reads it itself */ });
        } catch {
            // Jellyfin reads the item itself.
        }
        const detail = { type: state.view.getAttribute('data-type'), isRestored: false, params: Object.fromEntries(hashParams()) };
        state.view.dispatchEvent(new CustomEvent('viewbeforehide', { detail, bubbles: false, cancelable: false }));
        state.view.dispatchEvent(new CustomEvent('viewshow', { detail, bubbles: false, cancelable: false }));
        setTimeout(() => {
            INTENTS.forEach(type => window.removeEventListener(type, mark, { capture: true }));
            if (page !== state || !shown(state)) return;
            if (!moved && scroller.scrollTop !== top) scroller.scrollTop = top;
            const active = document.activeElement;
            if (focused && focused.isConnected && (!active || active === document.body)) focused.focus({ preventScroll: true });
            JE.core?.navigation?.replayViewShow?.(state.view);
            JE.internals?.arrStatusDetails?.update?.(true);
        }, timing.settle);
    }

    JE.session?.onUserChange?.('arr-status-arrival', () => {
        drop();
        unlisten();
        keys.clear();
    });

    JE.internals = JE.internals || {};
    JE.internals.arrStatusArrival = { seen, vanished, open, busy, timing, state: () => page };
})(window.JellyfinEnhanced);
