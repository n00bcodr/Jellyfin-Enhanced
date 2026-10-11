// /js/jellyseerr/listplaceholders/listplaceholders-playlist.js
// Playlist pages: placeholder rows inline between Jellyfin's own rows, in the order the
// server projects for this user.
// - jellyfin-web re-renders the rows with a full innerHTML replace, so the rows are
//   re-inserted from a chained `container.afterRefresh` hook, with a MutationObserver
//   fallback that only acts when every JE row is gone (B2).
// - Drag: a listener for SortableJS's DOM `end` event (fires before jellyfin-web's onEnd)
//   strips `data-playlistid` from a dragged real row so jellyfin-web makes no Move call of
//   its own (its index would count JE rows), and JE saves the whole order with PUT /order;
//   the server moves the real item in Jellyfin (B1). Placeholder rows join the same
//   Sortable when the user can edit the playlist natively and isn't in TV layout (B4).
// Rows never carry `.listItem`, `data-id` or `.itemAction`, so play-from-here, multi-select,
// context menus and Jellyfin's Move indices ignore them.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    /** Seerr status re-fetch delays while the server's status index is still loading (D2). */
    const POLL_DELAYS = [2000, 4000, 8000, 16000, 32000];
    const REFETCH_DEBOUNCE_MS = 1000;
    const EMPTY_PLAYLIST_WAIT_MS = 1500;

    /**
     * Whether jellyfin-web runs its TV layout (rows are focusable buttons without drag handles).
     * @returns {boolean}
     */
    function isTvLayout() {
        return document.documentElement.classList.contains('layout-tv');
    }

    /**
     * jellyfin-web's own rows, in DOM order.
     * @param {HTMLElement} container
     * @returns {HTMLElement[]}
     */
    function realRows(container) {
        return Array.from(container.children).filter(el => el.classList.contains('listItem'));
    }

    /**
     * Gives every real row its order token `e:<itemId>:<k>` (k-th occurrence in the list).
     * @param {HTMLElement} container
     * @returns {Map<string, HTMLElement>} token -> row.
     */
    function assignRealTokens(container) {
        const counts = new Map();
        const tokens = new Map();
        for (const row of realRows(container)) {
            const id = lp.normalizeId(row.getAttribute('data-id') || row.getAttribute('data-playlistitemid'));
            if (!id) { row.__jeLpToken = null; continue; }
            const k = counts.get(id) || 0;
            counts.set(id, k + 1);
            const token = `e:${id}:${k}`;
            row.__jeLpToken = token;
            tokens.set(token, row);
        }
        return tokens;
    }

    /**
     * Where each placeholder goes: before the first real row, or after its anchor (the nearest
     * preceding real token of the projected order that is on screen; missing real tokens are skipped).
     * @param {string[]} order - Projected order.
     * @param {Set<string>} presentReal - Real tokens present in the DOM.
     * @param {Set<string>} placeholderIds - Ids of the placeholders to place.
     * @returns {{start: string[], after: Map<string, string[]>, orphans: string[]}}
     */
    function planPlacement(order, presentReal, placeholderIds) {
        const start = [];
        const after = new Map();
        const seen = new Set();
        let anchor = null;
        for (const token of order || []) {
            if (token.startsWith('e:')) {
                if (presentReal.has(token)) anchor = token;
                continue;
            }
            if (!token.startsWith('p:')) continue;
            const id = token.slice(2);
            if (!placeholderIds.has(id) || seen.has(id)) continue;
            seen.add(id);
            if (anchor === null) {
                start.push(id);
            } else {
                if (!after.has(anchor)) after.set(anchor, []);
                after.get(anchor).push(id);
            }
        }
        const orphans = Array.from(placeholderIds).filter(id => !seen.has(id));
        return { start, after, orphans };
    }

    /**
     * Tokens of every row (real and JE) in DOM order; null when a real row has no token yet.
     * @param {HTMLElement} container
     * @returns {string[]|null}
     */
    function domOrder(container) {
        const out = [];
        for (const el of container.children) {
            if (el.classList.contains('listItem')) {
                if (!el.__jeLpToken) return null;
                out.push(el.__jeLpToken);
            } else if (el.classList.contains('je-lp-row')) {
                out.push('p:' + el.getAttribute('data-je-lp-id'));
            }
        }
        return out;
    }

    /**
     * Real tokens the DOM would have if numbered now (without touching the rows).
     * @param {HTMLElement} container
     * @returns {string[]}
     */
    function domRealTokens(container) {
        const counts = new Map();
        const out = [];
        for (const row of realRows(container)) {
            const id = lp.normalizeId(row.getAttribute('data-id') || row.getAttribute('data-playlistitemid'));
            if (!id) continue;
            const k = counts.get(id) || 0;
            counts.set(id, k + 1);
            out.push(`e:${id}:${k}`);
        }
        return out;
    }

    /**
     * Identity of a view for the once-only native row reload: its revision plus its real-entry
     * order (a playlist without placeholders has no document and stays at rev 0 while items are added).
     * @param {Object} view
     * @returns {string}
     */
    function nativeRefreshKey(view) {
        return `${view.rev}|${(view.order || []).filter(t => t.startsWith('e:')).join(',')}`;
    }

    /**
     * Element-wise equality of two string arrays.
     * @param {string[]} a
     * @param {string[]} b
     * @returns {boolean}
     */
    function sameArray(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    /**
     * Whether two token lists hold the same tokens (any order).
     * @param {string[]} a
     * @param {string[]} b
     * @returns {boolean}
     */
    function sameMembers(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        const set = new Set(a);
        return b.every(t => set.has(t));
    }

    /**
     * Occurrence index of a real token (0 = first copy).
     * @param {string} token
     * @returns {number}
     */
    function occurrenceOf(token) {
        const k = Number(String(token).split(':')[2]);
        return Number.isFinite(k) ? k : 0;
    }

    /**
     * Controller for one playlist page container.
     * @param {HTMLElement} page - The .itemDetailPage element.
     * @param {HTMLElement} container - `#childrenContent .itemsContainer`.
     * @param {Object} item - The playlist item (Id, Name).
     * @returns {Object}
     */
    function createController(page, container, item) {
        const ctrl = {
            listId: lp.normalizeId(item.Id),
            listKind: 'playlist',
            listName: item.Name || '',
            page,
            container,
            view: null,
            user: null,
            nativeRendered: !!container.querySelector(':scope > .listItem'),
            busy: false,
            suspended: false,
            pendingView: null,
            pollIndex: 0,
            pollTimer: null,
            refetchTimer: null,
            refetchAt: 0,
            addingSeen: new Set(),
            emptyTimer: null,
            moScheduled: false,
            toolbar: null
        };

        /** @returns {boolean} Whether the page still exists. */
        ctrl.isAlive = () => container.isConnected;

        /** @returns {boolean} Whether the page is the one on screen (jellyfin-web hides cached pages). */
        ctrl.isShown = () => ctrl.isAlive() && !page.classList.contains('hide');

        /** @returns {boolean} Whether placeholder rows can be dragged in Jellyfin's Sortable (B4). */
        ctrl.canDragPlaceholders = () => !!(ctrl.view?.nativeCanEdit && !isTvLayout() && container.sortable);

        /**
         * Looks up a visible placeholder by id.
         * @param {string} id
         * @returns {Object|undefined}
         */
        ctrl.byId = (id) => (ctrl.view?.placeholders || []).find(p => p.id === id);

        /** @returns {Object} Rendering context for rows. */
        ctrl.rowContext = () => ({
            draggable: ctrl.canDragPlaceholders(),
            canEdit: !!ctrl.view?.canEdit,
            tv: isTvLayout(),
            seerrEnabled: !!ctrl.view?.seerrEnabled && JE.pluginConfig?.JellyseerrEnabled === true,
            statusReady: !!ctrl.view?.seerrStatusReady,
            user: ctrl.user
        });

        /** Lets placeholder rows join jellyfin-web's Sortable (editors outside TV layout). */
        ctrl.configureSortable = () => {
            const sortable = container.sortable;
            if (!sortable || typeof sortable.option !== 'function') return;
            const draggable = sortable.option('draggable');
            if (ctrl.canDragPlaceholders() && draggable === '.listItem') sortable.option('draggable', '.listItem, .je-lp-row');
        };

        /** (Re)inserts every placeholder row at its place. */
        ctrl.render = () => {
            const view = ctrl.view;
            if (!view || !ctrl.nativeRendered || !ctrl.isAlive()) return;
            lp.ensureStyles?.();
            container.querySelectorAll(':scope > .je-lp-row').forEach(row => row.remove());
            const tokens = assignRealTokens(container);
            const placeholders = view.placeholders || [];
            ctrl.renderToolbar();
            if (!placeholders.length) return;
            const rows = lp.render.buildRows(placeholders, ctrl.rowContext());
            const plan = planPlacement(view.order, new Set(tokens.keys()), new Set(rows.keys()));
            /** @param {string[]} ids @returns {DocumentFragment} */
            const fragmentOf = (ids) => {
                const fragment = document.createDocumentFragment();
                for (const id of ids) fragment.appendChild(rows.get(id));
                return fragment;
            };
            if (plan.start.length) container.insertBefore(fragmentOf(plan.start), container.firstChild);
            for (const [token, ids] of plan.after) tokens.get(token).after(fragmentOf(ids));
            if (plan.orphans.length) container.appendChild(fragmentOf(plan.orphans));
            ctrl.configureSortable();
        };

        /**
         * Re-renders only the status badges / request buttons (status poll, request events) and
         * the subtitles: aired counts and date labels follow today's date without a new revision.
         */
        ctrl.updateStatuses = () => {
            if (!ctrl.view) return;
            const context = ctrl.rowContext();
            container.querySelectorAll(':scope > .je-lp-row').forEach((row) => {
                const ph = ctrl.byId(row.getAttribute('data-je-lp-id'));
                if (!ph) return;
                const mount = row.querySelector('.je-lp-status');
                if (mount) mount.innerHTML = lp.render.statusHtml(ph, context);
                const sub = row.querySelector('.je-lp-sub');
                const text = lp.render.rowSubtitle(ph);
                if (sub && sub.textContent !== text) sub.textContent = text;
            });
        };

        /** Shows the editor toolbar ("Add title") above the list. */
        ctrl.renderToolbar = () => {
            const view = ctrl.view;
            const parent = container.parentElement;
            if (!view?.canEdit || !parent) {
                ctrl.toolbar?.remove();
                ctrl.toolbar = null;
                return;
            }
            if (!ctrl.toolbar || !ctrl.toolbar.isConnected) {
                ctrl.toolbar = lp.toolbar.create(ctrl);
                parent.insertBefore(ctrl.toolbar, container);
            }
            lp.toolbar.update(ctrl.toolbar, (view.placeholders || []).length);
        };

        /** Asks jellyfin-web to reload its rows (afterRefresh then re-inserts ours). */
        ctrl.refreshNative = () => {
            ctrl.nativeRefreshes = (ctrl.nativeRefreshes || 0) + 1;
            if (typeof container.refreshItems === 'function') {
                container.refreshItems();
            } else {
                ctrl.render();
            }
        };

        /**
         * Adopts a view from the server (GET, mutation or 409).
         * @param {Object} view
         */
        ctrl.applyView = (view) => {
            if (!view || lp.normalizeId(view.listId) !== ctrl.listId || !ctrl.isAlive()) return;
            const previous = ctrl.view;
            if (lp.isOlderView(view, previous)) return; // a late answer for an older revision
            if (ctrl.suspended || ctrl.busy) {
                // A drag or its save is running: re-rendering now would take the row SortableJS holds out of the
                // list (the drop is then lost) or move rows under the save. The newest view waits for resume().
                if (!lp.isOlderView(view, ctrl.pendingView)) ctrl.pendingView = view;
                return;
            }
            ctrl.pendingView = null;
            ctrl.view = view;
            const viewReal = (view.order || []).filter(t => t.startsWith('e:'));
            const key = nativeRefreshKey(view);
            if (ctrl.nativeRendered && ctrl.nativeRefreshedKey !== key && !sameArray(domRealTokens(container), viewReal)) {
                // Jellyfin's rows are out of date (items added/moved elsewhere): reload them,
                // afterRefresh re-inserts the placeholders. Once per revision and real order (a
                // list without placeholders stays at rev 0 while items are added), so a lasting
                // difference can't loop.
                ctrl.nativeRefreshedKey = key;
                ctrl.refreshNative();
            } else if (!previous || previous.rev !== view.rev || !lp.samePlaceholders(previous, view)
                || container.querySelectorAll(':scope > .je-lp-row').length !== (view.placeholders || []).length) {
                ctrl.render();
            } else {
                ctrl.updateStatuses();
                ctrl.renderToolbar();
            }
            ctrl.schedulePoll();
            lp.freshness.checkAdding(ctrl, view);
            if (!ctrl.nativeRendered) ctrl.waitForEmptyPlaylist();
        };

        /** An empty playlist may never produce a row: render placeholders once jellyfin-web is set up. */
        ctrl.waitForEmptyPlaylist = () => {
            clearTimeout(ctrl.emptyTimer);
            ctrl.emptyTimer = setTimeout(() => {
                if (ctrl.nativeRendered || !ctrl.isAlive()) return;
                if (typeof container.fetchData === 'function') {
                    ctrl.nativeRendered = true;
                    ctrl.render();
                } else {
                    ctrl.waitForEmptyPlaylist();
                }
            }, EMPTY_PLAYLIST_WAIT_MS);
        };

        /** Polls with backoff while Seerr statuses are not ready yet (D2). */
        ctrl.schedulePoll = () => {
            clearTimeout(ctrl.pollTimer);
            const view = ctrl.view;
            if (!view || view.seerrStatusReady || !view.seerrEnabled) {
                ctrl.pollIndex = 0;
                return;
            }
            if (ctrl.pollIndex >= POLL_DELAYS.length) return;
            ctrl.pollTimer = setTimeout(() => ctrl.load(), POLL_DELAYS[ctrl.pollIndex++]);
        };

        /** Fetches the view and applies it if the page is still the one shown. */
        ctrl.load = async () => {
            if (!ctrl.isShown()) return;
            const epoch = lp.epochNow();
            let view;
            try {
                view = await lp.api.getView(ctrl.listId);
            } catch (error) {
                if (error?.status !== 404) console.warn('🪼 Jellyfin Enhanced: List placeholders: could not load the playlist view', error);
                return;
            }
            // A page left meanwhile re-fetches when it is shown again (viewshow, B3).
            if (!lp.isCurrentEpoch(epoch) || !ctrl.isShown()) return;
            ctrl.applyView(view);
            // No status yet, or a negative one (Seerr down / user not linked) that is asked for again.
            if (!lp.requests.canRequest(ctrl.user) && ctrl.view?.seerrEnabled && JE.pluginConfig?.JellyseerrEnabled === true) {
                lp.requests.userStatus().then((user) => {
                    if (!lp.isCurrentEpoch(epoch) || !ctrl.isAlive()) return;
                    ctrl.user = user;
                    ctrl.updateStatuses();
                });
            }
        };

        /**
         * Debounced re-fetch (LibraryChanged, a swap in progress, requests; B3).
         * @param {number} [delayMs] - Wait before the GET (default 1 s); an earlier pending one wins.
         */
        ctrl.scheduleRefetch = (delayMs = REFETCH_DEBOUNCE_MS) => lp.freshness.schedule(ctrl, delayMs);

        /** A request was announced somewhere: refresh badges now, statuses from the server shortly. */
        ctrl.onRequested = () => {
            ctrl.updateStatuses();
            ctrl.scheduleRefetch();
        };

        /**
         * Items were added as real entries: reload Jellyfin's rows, unless adopting the
         * mutation's view already did for this revision and real order.
         */
        ctrl.afterRealItemsAdded = () => {
            const key = ctrl.view ? nativeRefreshKey(ctrl.view) : undefined;
            if (key !== undefined && ctrl.nativeRefreshedKey === key) return;
            ctrl.nativeRefreshedKey = key;
            ctrl.refreshNative();
        };

        /**
         * Position choices of the Add title modal: end, start, after any row.
         * @returns {Array<{value: string, label: string}>}
         */
        ctrl.positionOptions = () => {
            const options = [
                { value: 'end', label: JE.t('listPlaceholders_position_end') },
                { value: 'start', label: JE.t('listPlaceholders_position_start') }
            ];
            const tokens = assignRealTokens(container);
            for (const token of ctrl.view?.order || []) {
                let label = '';
                if (token.startsWith('p:')) {
                    const ph = ctrl.byId(token.slice(2));
                    if (ph) label = `${ph.title} (${lp.render.kindLabel(ph)})`;
                } else {
                    const row = tokens.get(token);
                    label = row?.querySelector('.listItemBodyText')?.textContent?.trim() || '';
                }
                if (label) options.push({ value: token, label: JE.t('listPlaceholders_position_after', { title: label }) });
            }
            return options;
        };

        /**
         * Saves the order the DOM shows after a drag.
         * @param {string|null} draggedRealToken - Token of a dragged real row, null for a placeholder.
         * @returns {Promise<void>}
         */
        ctrl.persistDomOrder = async (draggedRealToken) => {
            const view = ctrl.view;
            const order = domOrder(container);
            const current = view?.order || [];
            if (!view || !order || !sameMembers(order, current)) {
                ctrl.resume();
                JE.toast(JE.t('listPlaceholders_err_changed'), 3000);
                ctrl.refreshNative();
                ctrl.load();
                return;
            }
            if (sameArray(order, current)) {
                ctrl.resume();
                return;
            }
            const realBefore = current.filter(t => t.startsWith('e:'));
            const realAfter = order.filter(t => t.startsWith('e:'));
            const moved = draggedRealToken && !sameArray(realBefore, realAfter) ? draggedRealToken : null;
            if (moved && occurrenceOf(moved) > 0) {
                // Jellyfin always moves the first copy of a duplicated item.
                ctrl.resume();
                JE.toast(JE.t('listPlaceholders_err_duplicate_copy'), 4000);
                ctrl.refreshNative();
                return;
            }
            const sortable = container.sortable;
            const refreshesBefore = ctrl.nativeRefreshes || 0;
            ctrl.busy = true;
            try { sortable?.option?.('disabled', true); } catch (_) { /* ignore */ }
            try {
                await lp.api.reorder(ctrl.listId, view.rev, order, moved);
            } catch (error) {
                if (lp.isStaleIdentityError(error)) return;
                JE.toast(lp.errorMessage(error), 4000);
                // The save is over: adopt the view the refusal carried (held back while it ran) before restoring.
                ctrl.busy = false;
                ctrl.suspended = false;
                ctrl.applyPendingView();
                ctrl.restoreServerOrder(!error?.responseJSON?.view, refreshesBefore);
            } finally {
                ctrl.busy = false;
                try { sortable?.option?.('disabled', false); } catch (_) { /* ignore */ }
                ctrl.resume();
            }
        };

        /**
         * Puts the rows back in the server's order after a refused or failed save: the DOM still
         * shows the drop (whatever the error's view revision). Real rows out of order → jellyfin-web
         * reloads its rows (afterRefresh re-inserts ours) unless adopting the error's view already
         * started that; only placeholder rows out of order → they are re-rendered.
         * @param {boolean} refetch - Also fetch the view (the error carried none).
         * @param {number} refreshesBefore - ctrl.nativeRefreshes when the save started.
         */
        ctrl.restoreServerOrder = (refetch, refreshesBefore) => {
            const viewReal = (ctrl.view?.order || []).filter(t => t.startsWith('e:'));
            if (refetch || !sameArray(domRealTokens(container), viewReal)) {
                if ((ctrl.nativeRefreshes || 0) === refreshesBefore) ctrl.refreshNative();
            } else {
                ctrl.render();
            }
            if (refetch) ctrl.load();
        };

        /**
         * SortableJS `end` (DOM event, dispatched before jellyfin-web's onEnd with the same event object).
         * @param {Event} e
         */
        ctrl.onSortEnd = (e) => {
            const dragged = e.item;
            if (!dragged || dragged.parentElement !== container) return;
            if (!ctrl.view || !container.querySelector(':scope > .je-lp-row')) {
                // No placeholders on screen: jellyfin-web's own Move is correct; leave it alone.
                ctrl.resume();
                return;
            }
            let realToken = null;
            if (dragged.classList.contains('listItem')) {
                let index = 0;
                for (let p = dragged.previousElementSibling; p; p = p.previousElementSibling) {
                    if (p.classList.contains('listItem')) index++;
                }
                e.newIndex = index;
                const playlistId = dragged.getAttribute('data-playlistid');
                if (playlistId !== null) {
                    // jellyfin-web takes its no-server-call branch for an element without
                    // data-playlistid; JE saves the order (and the server moves the item).
                    dragged.removeAttribute('data-playlistid');
                    queueMicrotask(() => {
                        if (!dragged.hasAttribute('data-playlistid')) dragged.setAttribute('data-playlistid', playlistId);
                    });
                }
                realToken = dragged.__jeLpToken || null;
            }
            ctrl.persistDomOrder(realToken);
        };

        /**
         * Delegated clicks on JE rows: Request, "…" menu, more info.
         * @param {MouseEvent} e
         */
        ctrl.onClick = (e) => {
            const row = e.target.closest?.('.je-lp-row');
            if (!row || row.parentElement !== container) return;
            const ph = ctrl.byId(row.getAttribute('data-je-lp-id'));
            if (!ph) return;
            const requestButton = e.target.closest('.je-lp-request');
            const menuButton = e.target.closest('.je-lp-menu-btn');
            if (requestButton) {
                e.preventDefault();
                e.stopPropagation();
                if (!requestButton.disabled) lp.requests.requestPlaceholder(ph, requestButton);
            } else if (menuButton) {
                e.preventDefault();
                e.stopPropagation();
                lp.actions.showPlaceholderMenu(ctrl, ph, menuButton);
            } else if (e.target.closest('.je-lp-row-main')) {
                e.preventDefault();
                e.stopPropagation();
                if (ph.tmdbId && JE.pluginConfig?.JellyseerrEnabled && JE.jellyseerrMoreInfo?.open) {
                    JE.jellyseerrMoreInfo.open(Number(ph.tmdbId), ph.mediaType);
                } else if (ctrl.view?.canEdit) {
                    const anchor = row.querySelector('.je-lp-menu-btn');
                    if (anchor) lp.actions.showPlaceholderMenu(ctrl, ph, anchor);
                }
            }
        };

        // jellyfin-web's post-render hook (unused by playlists in 12.2); chain whatever is there.
        const previousAfterRefresh = container.afterRefresh;
        container.afterRefresh = function (result) {
            try {
                if (typeof previousAfterRefresh === 'function') previousAfterRefresh.call(this, result);
            } finally {
                ctrl.nativeRendered = true;
                ctrl.render();
            }
        };

        /**
         * Re-inserts the rows if a native re-render dropped every one of them (B2). Never
         * repositions rows that are still there; does nothing while a drag/save is running.
         */
        ctrl.restoreIfLost = () => {
            if (ctrl.busy || ctrl.suspended || !ctrl.view || !(ctrl.view.placeholders || []).length) return;
            if (container.querySelector(':scope > .je-lp-row')) return;
            if (!container.querySelector(':scope > .listItem') && !ctrl.nativeRendered) return;
            ctrl.nativeRendered = true;
            ctrl.render();
        };

        /** Adopts the newest view that arrived during a drag or a save (see applyView). */
        ctrl.applyPendingView = () => {
            const view = ctrl.pendingView;
            ctrl.pendingView = null;
            if (view) ctrl.applyView(view);
        };

        /** Ends a drag suspension and catches up on a view or a re-render that arrived meanwhile. */
        ctrl.resume = () => {
            ctrl.suspended = false;
            if (!ctrl.busy) ctrl.applyPendingView();
            ctrl.restoreIfLost();
        };

        // Fallback for re-renders that bypass afterRefresh: rAF-debounced, idempotent.
        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(() => {
                if (ctrl.moScheduled) return;
                ctrl.moScheduled = true;
                /** Runs once per frame however many mutations arrived. */
                const run = () => {
                    ctrl.moScheduled = false;
                    ctrl.restoreIfLost();
                };
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run); else setTimeout(run, 16);
            });
            observer.observe(container, { childList: true });
            ctrl.observer = observer;
        }

        /**
         * Stops the observer and timers when the controller leaves lp.controllers (page dropped by
         * jellyfin-web, or user switch).
         */
        ctrl.dispose = () => {
            ctrl.observer?.disconnect();
            clearTimeout(ctrl.pollTimer);
            clearTimeout(ctrl.refetchTimer);
            clearTimeout(ctrl.emptyTimer);
            ctrl.pollTimer = ctrl.refetchTimer = ctrl.emptyTimer = null;
            ctrl.refetchAt = 0;
            ctrl.pendingView = null;
            // The source menu's queue and last answer belong to the user who made the changes.
            ctrl.sourceView = null;
            ctrl.sourceQueue = null;
        };

        /** Takes a disposed controller back into use (its page is shown again, e.g. after a user switch). */
        ctrl.reactivate = () => {
            ctrl.view = null;
            ctrl.pendingView = null;
            ctrl.sourceView = null;
            ctrl.sourceQueue = null;
            ctrl.user = null;
            ctrl.nativeRefreshedKey = undefined;
            ctrl.pollIndex = 0;
            ctrl.addingSeen = new Set();
            ctrl.observer?.observe(container, { childList: true });
        };

        // SortableJS DOM events: suspend the fallback from pick-up until the save settles.
        container.addEventListener('choose', () => { ctrl.suspended = true; });
        container.addEventListener('unchoose', () => { setTimeout(() => { if (!ctrl.busy) ctrl.resume(); }, 0); });
        container.addEventListener('end', ctrl.onSortEnd);
        container.addEventListener('click', ctrl.onClick);
        return ctrl;
    }

    /**
     * Attaches to (or refreshes) the playlist page shown.
     * @param {HTMLElement} page - .itemDetailPage element.
     * @param {Object} item - Playlist item.
     * @returns {Object|null} The controller.
     */
    function attach(page, item) {
        const container = page.querySelector('#childrenContent .itemsContainer');
        if (!container) return null;
        let ctrl = container.__jeLpController;
        if (!ctrl) {
            ctrl = createController(page, container, item);
            container.__jeLpController = ctrl;
            lp.controllers.add(ctrl);
        } else if (!lp.controllers.has(ctrl)) {
            ctrl.reactivate();
            lp.controllers.add(ctrl);
        }
        ctrl.load();
        return ctrl;
    }

    lp.playlist = {
        attach,
        createController,
        planPlacement,
        assignRealTokens,
        domOrder,
        domRealTokens,
        sameArray,
        sameMembers,
        occurrenceOf,
        isTvLayout
    };

})(window.JellyfinEnhanced);
