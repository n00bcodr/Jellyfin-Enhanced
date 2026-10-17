/**
 * @file Requests & downloads, phase 4c3a: a playlist page's entries that aren't in the library, drawn inline between
 * Jellyfin's own rows in the list's order (the person's projection from GET acquire/lists/{id}).
 *
 * - Placement: every real row gets its occurrence token `e:<itemId>:<k>` (k-th copy of the item), each entry goes
 *   after the nearest real token before it in the projected order that is on screen (or first). An entry whose anchor
 *   is hidden from this person follows the previous visible one, so hidden rows are never revealed by a gap.
 * - A playlist with no real items gets its rows too: jellyfin-web renders nothing there (12.2 has no empty message),
 *   and the rows go in once its items container is set up. They are re-inserted after each of Jellyfin's own
 *   re-renders (its `afterRefresh` hook, chained; a MutationObserver puts them back if they were dropped another way).
 * - Rows are not `.listItem`s and have no item id, so Jellyfin's play / play-from-here / multi-select and menus ignore
 *   them. Dragging a real row still works: Sortable's `newIndex` would count JE rows, so the drop index Jellyfin uses
 *   for its own Move is corrected to count real rows only, and the view is read again to re-anchor the entries.
 *   Dragging entries themselves (and Move up/down) is not part of this phase.
 * - Late or out-of-order answers are dropped (a newer read wins; a lower revision never replaces a higher one), and
 *   everything stops when the page is left, the person changes or the pages are switched off.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};
    const logPrefix = '🪼 Jellyfin Enhanced: Lists:';

    /** Debounce of a re-read after a change was announced. */
    const REFETCH_MS = 1000;
    /** At most this many re-reads per controller per minute (arrivals can come in bursts). */
    const REFETCH_PER_MINUTE = 6;
    /** How long to wait for jellyfin-web to set up the items container of a page being drawn. */
    const CONTAINER_WAIT_MS = 250;
    const CONTAINER_WAIT_TRIES = 40;
    /** Rows built per slice when many are new (a 699-entry list never blocks the page in one long task). */
    const BUILD_CHUNK = 150;

    /**
     * Whether jellyfin-web runs its TV layout.
     * @returns {boolean} TV.
     */
    function isTv() {
        return document.documentElement.classList.contains('layout-tv');
    }

    /**
     * Jellyfin's own rows, in order.
     * @param {HTMLElement} container Items container.
     * @returns {HTMLElement[]} Rows.
     */
    function realRows(container) {
        return Array.from(container.children).filter(n => n.classList.contains('listItem'));
    }

    /**
     * The occurrence token of each real row (`e:<itemId>:<k>`), set on the row and returned by token.
     * @param {HTMLElement} container Items container.
     * @returns {Map<string, HTMLElement>} token → row.
     */
    function assignRealTokens(container) {
        const counts = new Map();
        const tokens = new Map();
        for (const row of realRows(container)) {
            const id = lp.render.normalizeId(row.getAttribute('data-id') || row.getAttribute('data-playlistitemid'));
            if (!id) continue;
            const k = counts.get(id) || 0;
            counts.set(id, k + 1);
            const token = `e:${id}:${k}`;
            row.__jeListToken = token;
            tokens.set(token, row);
        }
        return tokens;
    }

    /**
     * Where each entry goes: before the first real row, or after its anchor (the nearest real token before it in the
     * projected order that is on screen). Entries the order doesn't name go at the end.
     * @param {string[]} order Projected order.
     * @param {Set<string>} present Real tokens on screen.
     * @param {string[]} ids Entry ids to place, in the view's order.
     * @returns {{start: string[], after: Map<string, string[]>, orphans: string[]}} Plan.
     */
    function planPlacement(order, present, ids) {
        const wanted = new Set(ids);
        const start = [];
        const after = new Map();
        const seen = new Set();
        let anchor = null;
        for (const token of order || []) {
            if (typeof token !== 'string') continue;
            if (token.startsWith('e:')) {
                if (present.has(token)) anchor = token;
                continue;
            }
            if (!token.startsWith('p:')) continue;
            const id = token.slice(2);
            if (!wanted.has(id) || seen.has(id)) continue;
            seen.add(id);
            if (anchor === null) start.push(id);
            else {
                if (!after.has(anchor)) after.set(anchor, []);
                after.get(anchor).push(id);
            }
        }
        return { start, after, orphans: ids.filter(id => !seen.has(id)) };
    }

    /**
     * Whether a view is older than the one shown (revisions only grow).
     * @param {Object} view New view.
     * @param {Object|null} known Shown view.
     * @returns {boolean} Older.
     */
    function isOlder(view, known) {
        return !!known && Number.isFinite(view?.rev) && Number.isFinite(known?.rev) && view.rev < known.rev;
    }

    /**
     * The controller of one playlist page's items container.
     * @param {HTMLElement} page The details page.
     * @param {HTMLElement} container `#childrenContent .itemsContainer`.
     * @param {string} listId Playlist id (N form).
     * @returns {Object} Controller.
     */
    function createController(page, container, listId) {
        const ctrl = {
            kind: 'playlist',
            listId,
            page,
            container,
            view: null,
            guarded: () => true,
            seq: 0,
            abort: null,
            refetchTimer: null,
            waitTimer: null,
            waitTries: 0,
            refetches: [],
            nodes: new Map(),
            statusKeys: '',
            statusOff: null,
            paused: false,
            disposed: false,
            focusOnRender: null,
            observer: null,
            buildToken: 0
        };

        /** @returns {boolean} The page is still in the document. */
        ctrl.isAlive = () => !ctrl.disposed && container.isConnected && page.isConnected;

        /** @returns {boolean} The page is the one on screen. */
        ctrl.isShown = () => ctrl.isAlive() && !page.classList.contains('hide');

        /**
         * Whether jellyfin-web has set the container up (its rows, or its fetch for a playlist with none).
         * @returns {boolean} Ready.
         */
        ctrl.containerReady = () => !!container.querySelector(':scope > .listItem') || typeof container.fetchData === 'function';

        /**
         * The entry with an id, as shown.
         * @param {string} id Entry id.
         * @returns {Object|undefined} Entry.
         */
        ctrl.byId = (id) => (ctrl.view?.placeholders || []).find(p => p.id === id);

        /** @returns {Object} Drawing context. */
        ctrl.context = () => ({
            tv: isTv(),
            // Jellyfin's rows start with a drag handle when the person may reorder: entries keep the same indent.
            handleSpace: !!container.querySelector(':scope > .listItem > .listViewDragHandle'),
            statusShown: ctrl.view?.statusShown === true,
            statusContext: {},
            requests: JE.pluginConfig?.ArrListRequestsEnabled === true && (ctrl.view?.actions || []).includes('request'),
            guarded: ctrl.guarded
        });

        /** Removes every row this page shows (and any copy of one). */
        ctrl.clear = () => {
            container.querySelectorAll(':scope > .je-list-row').forEach(n => n.remove());
            ctrl.nodes.clear();
        };

        /** Draws the rows in place (re-using rows whose content didn't change). */
        ctrl.render = () => {
            const view = ctrl.view;
            if (!view || !ctrl.isAlive() || ctrl.disposed) return;
            if (!ctrl.containerReady()) {
                ctrl.waitForContainer();
                return;
            }
            lp.render.ensureStyles();
            const placeholders = view.placeholders || [];
            const context = ctrl.context();
            const stale = placeholders.filter((ph) => {
                const known = ctrl.nodes.get(ph.id);
                return !known || known.sig !== lp.render.signature(ph, context);
            });
            if (stale.length > BUILD_CHUNK) {
                // Many new rows: built in slices first (the rows shown stay meanwhile), then placed in one go.
                ctrl.buildInSlices(stale, context);
                return;
            }
            const keep = new Map();
            for (const ph of placeholders) {
                const sig = lp.render.signature(ph, context);
                const known = ctrl.nodes.get(ph.id);
                keep.set(ph.id, known && known.sig === sig ? known : { node: lp.render.row(ph, context), sig });
            }
            // Rows of this page not in the new set (and copies Jellyfin may have cloned) go.
            container.querySelectorAll(':scope > .je-list-row').forEach((n) => {
                const id = n.dataset.jeListId;
                if (!keep.has(id) || keep.get(id).node !== n) n.remove();
            });
            ctrl.nodes = keep;
            if (!placeholders.length) return;
            const tokens = assignRealTokens(container);
            const plan = planPlacement(view.order, new Set(tokens.keys()), placeholders.map(p => p.id));
            const fragmentOf = (ids) => {
                const fragment = document.createDocumentFragment();
                for (const id of ids) fragment.appendChild(keep.get(id).node);
                return fragment;
            };
            if (plan.start.length) container.insertBefore(fragmentOf(plan.start), container.firstChild);
            for (const [token, ids] of plan.after) tokens.get(token).after(fragmentOf(ids));
            if (plan.orphans.length) container.appendChild(fragmentOf(plan.orphans));
            if (ctrl.focusOnRender) {
                const target = keep.get(ctrl.focusOnRender)?.node.querySelector('.je-list-row-main');
                ctrl.focusOnRender = null;
                if (target && typeof target.focus === 'function') target.focus();
            }
        };

        /**
         * Builds rows in slices of BUILD_CHUNK (one per task), then draws.
         * @param {Object[]} list Entries whose rows are missing or out of date.
         * @param {Object} context Drawing context.
         */
        ctrl.buildInSlices = (list, context) => {
            const token = ++ctrl.buildToken;
            let index = 0;
            const step = () => {
                if (token !== ctrl.buildToken || ctrl.disposed || ctrl.paused) return;
                const end = Math.min(index + BUILD_CHUNK, list.length);
                for (; index < end; index++) {
                    const ph = list[index];
                    ctrl.nodes.set(ph.id, { node: lp.render.row(ph, context), sig: lp.render.signature(ph, context) });
                }
                if (index < list.length) setTimeout(step, 0);
                else ctrl.render();
            };
            step();
        };

        /** Waits (bounded) for jellyfin-web to set up the items container of the page it is drawing. */
        ctrl.waitForContainer = () => {
            if (ctrl.waitTimer || ctrl.disposed) return;
            ctrl.waitTimer = setTimeout(() => {
                ctrl.waitTimer = null;
                if (!ctrl.isShown()) return;
                if (ctrl.containerReady()) ctrl.render();
                else if (++ctrl.waitTries < CONTAINER_WAIT_TRIES) ctrl.waitForContainer();
            }, CONTAINER_WAIT_MS);
        };

        /**
         * Shows a view (GET, a change's answer, a 409's fresh view). An older revision never replaces a newer one.
         * @param {Object} view View.
         * @param {{fromChange?: boolean}} [options] A change's answer (its statuses may be missing: read again soon).
         */
        ctrl.applyView = (view, options) => {
            if (!view || lp.render.normalizeId(view.listId) !== listId || !ctrl.isAlive() || ctrl.paused) return;
            if (isOlder(view, ctrl.view)) return;
            ctrl.view = view;
            ctrl.render();
            ctrl.follow();
            if (options?.fromChange) ctrl.scheduleRefetch(REFETCH_MS);
        };

        /** Follows the shared status of the titles shown (one subscription per set of titles). */
        ctrl.follow = () => {
            const keys = [...new Set((ctrl.view?.placeholders || []).map(p => p.titleKey).filter(k => typeof k === 'string' && k))].sort();
            const signature = keys.join(',');
            if (signature === ctrl.statusKeys && ctrl.statusOff) return;
            ctrl.statusOff?.();
            ctrl.statusOff = null;
            ctrl.statusKeys = signature;
            if (!keys.length || typeof JE.arrStatus?.subscribe !== 'function' || ctrl.view?.statusShown !== true) return;
            ctrl.statusOff = JE.arrStatus.subscribe(keys, () => ctrl.scheduleRefetch(REFETCH_MS), { since: ctrl.since ?? undefined });
        };

        /**
         * Reads the view and shows it, after Spoiler Guard's state is known (nothing is painted before). A newer read
         * or leaving the page drops this one's answer.
         * @returns {Promise<void>}
         */
        ctrl.load = async () => {
            if (!ctrl.isShown() || ctrl.paused) return;
            const seq = ++ctrl.seq;
            ctrl.abort?.abort();
            const abort = new AbortController();
            ctrl.abort = abort;
            const epoch = JE.session?.getEpoch ? JE.session.getEpoch() : 0;
            const current = () => seq === ctrl.seq && !abort.signal.aborted && ctrl.isShown() && !ctrl.paused
                && (JE.session?.getEpoch ? JE.session.getEpoch() : 0) === epoch;
            let answer;
            let since;
            let guarded;
            try {
                since = JE.arrStatus?.feedPosition ? await JE.arrStatus.feedPosition() : undefined;
                [answer, guarded] = await Promise.all([
                    JE.arrLists.getList(listId, { signal: abort.signal }),
                    lp.render.spoilerPolicy({ listKind: 'playlist', listId })
                ]);
            } catch (err) {
                if (!err?.stale && err?.name !== 'AbortError') console.warn(`${logPrefix} the playlist couldn't be read`, err?.message || err);
                return;
            }
            if (!current()) return;
            if (answer.status === 404 || answer.status === 403) {
                // Gone or no longer this person's to see: nothing of it stays on the page.
                ctrl.view = null;
                ctrl.clear();
                ctrl.statusOff?.();
                ctrl.statusOff = null;
                ctrl.statusKeys = '';
                return;
            }
            if (answer.status !== 200 || !answer.body) return;
            ctrl.since = since;
            ctrl.guarded = guarded;
            ctrl.applyView(answer.body);
        };

        /**
         * Reads the view again shortly (debounced; the earliest pending wins; at most REFETCH_PER_MINUTE a minute).
         * @param {number} [delay] Delay in ms.
         */
        ctrl.scheduleRefetch = (delay = REFETCH_MS) => {
            if (ctrl.disposed || ctrl.paused) return;
            const now = Date.now();
            ctrl.refetches = ctrl.refetches.filter(t => now - t < 60000);
            if (ctrl.refetchTimer) return;
            const wait = ctrl.refetches.length >= REFETCH_PER_MINUTE ? Math.max(delay, 60000 - (now - ctrl.refetches[0])) : delay;
            ctrl.refetchTimer = setTimeout(() => {
                ctrl.refetchTimer = null;
                ctrl.refetches.push(Date.now());
                ctrl.load();
            }, wait);
        };

        /**
         * A library change Jellyfin announced: the playlist itself (its items) or new/updated items that may be
         * an entry arriving.
         * @param {Set<string>} ids Changed item ids (N form).
         * @param {boolean} added Items were added.
         */
        ctrl.onLibraryChanged = (ids, added) => {
            const placeholders = ctrl.view?.placeholders || [];
            if (ids.has(listId)) ctrl.scheduleRefetch(REFETCH_MS);
            else if (placeholders.some(p => p.kind !== 'custom') && added) ctrl.scheduleRefetch(3000);
        };

        /**
         * SortableJS `end` (a DOM event dispatched before jellyfin-web's own onEnd, with the same event object): a
         * real row's drop index counts real rows only, so Jellyfin's own Move lands where the person dropped it.
         * @param {Event & {item?: HTMLElement, newIndex?: number}} e Event.
         */
        ctrl.onSortEnd = (e) => {
            const dragged = e.item;
            if (!dragged || dragged.parentElement !== container || !dragged.classList.contains('listItem')) return;
            if (!container.querySelector(':scope > .je-list-row')) return;
            let index = 0;
            for (let n = dragged.previousElementSibling; n; n = n.previousElementSibling) {
                if (n.classList.contains('listItem')) index++;
            }
            e.newIndex = index;
            ctrl.scheduleRefetch(1500);
        };

        /**
         * Clicks on the rows: Request, or open the title at its exact scope.
         * @param {MouseEvent} e Event.
         */
        ctrl.onClick = (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const rowNode = target?.closest?.('.je-list-row');
            if (!rowNode || rowNode.parentElement !== container) return;
            const ph = ctrl.byId(rowNode.dataset.jeListId);
            if (!ph) return;
            const request = target.closest('.je-list-request');
            const main = target.closest('button.je-list-row-main');
            if (!request && !main) return;
            e.preventDefault();
            e.stopPropagation();
            if (request) {
                if (!request.disabled) lp.request.open({ listId, onDone: () => ctrl.scheduleRefetch(500) }, ph, request);
                return;
            }
            lp.pages.openEntry(ctrl, ph);
        };

        // jellyfin-web's post-render hook (its rows were replaced): put the rows back. Chained and never unhooked (a
        // later hook may wrap this one): a disposed controller's link just passes the call on.
        const previousAfterRefresh = container.afterRefresh;
        container.afterRefresh = function (result) {
            try {
                if (typeof previousAfterRefresh === 'function') previousAfterRefresh.call(this, result);
            } finally {
                if (!ctrl.disposed && !ctrl.paused) ctrl.render();
            }
        };

        /** Puts the rows back if a re-render that bypassed afterRefresh dropped all of them. */
        ctrl.restoreIfLost = () => {
            if (ctrl.disposed || ctrl.paused || !(ctrl.view?.placeholders || []).length) return;
            if (container.querySelector(':scope > .je-list-row')) return;
            // The rows built before are put back as they are (no rebuild).
            ctrl.render();
        };

        if (typeof MutationObserver !== 'undefined') {
            let scheduled = false;
            ctrl.observer = new MutationObserver(() => {
                if (scheduled) return;
                scheduled = true;
                const run = () => {
                    scheduled = false;
                    ctrl.restoreIfLost();
                };
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
            });
            ctrl.observer.observe(container, { childList: true });
        }

        /** Stops reading and following while the page is hidden (jellyfin-web keeps a few pages); rows stay. */
        ctrl.pause = () => {
            ctrl.paused = true;
            ctrl.seq++;
            ctrl.buildToken++;
            ctrl.abort?.abort();
            ctrl.abort = null;
            clearTimeout(ctrl.refetchTimer);
            clearTimeout(ctrl.waitTimer);
            ctrl.refetchTimer = ctrl.waitTimer = null;
            ctrl.statusOff?.();
            ctrl.statusOff = null;
            ctrl.statusKeys = '';
        };

        /** The page is shown again: read the view again. */
        ctrl.resume = () => {
            if (ctrl.disposed) return;
            ctrl.paused = false;
            ctrl.waitTries = 0;
            ctrl.load();
        };

        /** Removes everything this controller added and stops all of its work. */
        ctrl.dispose = () => {
            if (ctrl.disposed) return;
            ctrl.pause();
            ctrl.disposed = true;
            ctrl.observer?.disconnect();
            container.removeEventListener('end', ctrl.onSortEnd);
            container.removeEventListener('click', ctrl.onClick);
            ctrl.clear();
            ctrl.view = null;
            if (container.__jeListCtrl === ctrl) delete container.__jeListCtrl;
        };

        container.addEventListener('end', ctrl.onSortEnd);
        container.addEventListener('click', ctrl.onClick);
        return ctrl;
    }

    /**
     * The controller of a playlist page (made once per items container).
     * @param {HTMLElement} page Details page.
     * @param {string} listId Playlist id.
     * @returns {Object|null} Controller.
     */
    function attach(page, listId) {
        const container = page.querySelector('#childrenContent .itemsContainer');
        if (!container) return null;
        let ctrl = container.__jeListCtrl;
        if (ctrl && (ctrl.disposed || ctrl.listId !== listId)) {
            ctrl.dispose();
            ctrl = null;
        }
        if (!ctrl) {
            ctrl = createController(page, container, listId);
            container.__jeListCtrl = ctrl;
        }
        return ctrl;
    }

    lp.playlist = { attach, createController, planPlacement, assignRealTokens, isOlder, isTv, REFETCH_PER_MINUTE };
})(window.JellyfinEnhanced);
