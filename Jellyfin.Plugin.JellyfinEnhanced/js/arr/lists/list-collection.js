/**
 * @file Requests & downloads, phase 4c3a: a collection page's "Not in your library" section, right after Jellyfin's
 * own `.collectionItems` (a sibling survives that block's re-renders). Entries come in the server's collection order:
 * release date, dates still to be announced last; a TV entry with some episodes in the collection says how far it is
 * filled, apart from where its request stands. Cards are built in slices so hundreds of entries never block the page.
 *
 * Covered keys for the collection-gap rows (4d): {@link coveredOf} derives, from this person's own view, the titles the
 * section already offers: `movie:tmdb:<id>` / `tv:tvdb:<id>` per standard entry (`…@4k` for a 4K entry, which doesn't
 * cover the standard copy), plus `tv:…:s<n>` for a season entry. Hidden entries are never in the view, so they never
 * suppress a gap or change a count.
 *
 * The controller's one ticket (lp.pages.issue) is issued after a successful read and revoked on access loss, pause or
 * disposal. Every DOM write (the section, each slice of cards, the header, Jellyfin's card refresh) goes through
 * lp.gate.paint with it, removals through lp.gate.erase; answers are taken only while the ticket and this controller's
 * newest read hold.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};
    const logPrefix = '🪼 Jellyfin Enhanced: Lists:';

    const REFETCH_MS = 1000;
    const REFETCH_PER_MINUTE = 6;
    /** Cards built per slice. */
    const CARD_CHUNK = 24;

    /**
     * The covered keys of a view: what the collection's own section offers this person.
     * @param {Object|null} view List view.
     * @returns {{keys: Set<string>, entries: Array<{key: string, titleKey: string, edition: string, kind: string, seasonNumber: (number|null)}>}} Covered.
     */
    function coveredOf(view) {
        const keys = new Set();
        const entries = [];
        for (const ph of view?.placeholders || []) {
            if (typeof ph?.titleKey !== 'string' || !ph.titleKey || ph.kind === 'custom') continue;
            const edition = ph.edition === '4k' ? '4k' : 'standard';
            let key = ph.titleKey;
            if ((ph.kind === 'season' || ph.kind === 'episodes') && Number.isInteger(ph.seasonNumber)) key += `:s${ph.seasonNumber}`;
            if (edition === '4k') key += '@4k';
            keys.add(key);
            entries.push({ key, titleKey: ph.titleKey, edition, kind: ph.kind, seasonNumber: Number.isInteger(ph.seasonNumber) ? ph.seasonNumber : null });
        }
        return { keys, entries };
    }

    /**
     * The controller of one collection page.
     * @param {HTMLElement} page Details page.
     * @param {string} listId Collection id (N form).
     * @returns {Object} Controller.
     */
    function createController(page, listId) {
        const ctrl = {
            kind: 'collection',
            listId,
            page,
            view: null,
            ticket: null,
            section: null,
            seq: 0,
            abort: null,
            refetchTimer: null,
            refetches: [],
            renderToken: 0,
            statusKeys: '',
            statusOff: null,
            paused: false,
            disposed: false,
            focusOnRender: null,
            header: null
        };
        ctrl.header = lp.render.headerMark(page, () => ctrl.ticket);

        /** @returns {boolean} The page is still in the document. */
        ctrl.isAlive = () => !ctrl.disposed && page.isConnected;

        /** @returns {boolean} The page is the one on screen. */
        ctrl.isShown = () => ctrl.isAlive() && !page.classList.contains('hide');

        /**
         * The entry with an id, as shown.
         * @param {string} id Entry id.
         * @returns {Object|undefined} Entry.
         */
        ctrl.byId = (id) => (ctrl.view?.placeholders || []).find(p => p.id === id);

        /** @returns {Object} Drawing context. */
        ctrl.context = () => ({
            tv: lp.playlist.isTv(),
            statusShown: ctrl.view?.statusShown === true,
            statusContext: {},
            requests: JE.pluginConfig?.ArrListRequestsEnabled === true && (ctrl.view?.actions || []).includes('request'),
            swapActive: ctrl.view?.swapIn === true && ctrl.view?.reconciling !== true,
            guarded: ctrl.ticket ? ctrl.ticket.policy : lp.gate.FAIL_CLOSED,
            ticket: ctrl.ticket
        });

        /**
         * The section, right after `.collectionItems` (made, or moved back after a re-render).
         * @returns {HTMLElement|null} Section.
         */
        ctrl.ensureSection = () => {
            const anchor = page.querySelector('.collectionItems');
            if (!anchor) return null;
            if (ctrl.section && ctrl.section.isConnected) {
                if (anchor.nextElementSibling !== ctrl.section) anchor.after(ctrl.section);
                return ctrl.section;
            }
            lp.gate.erase(() => page.querySelectorAll('.je-list-section').forEach(n => n.remove()));
            lp.render.ensureStyles();
            const tr = lp.render.tr;
            const section = lp.render.el('div', 'verticalSection je-list-section');
            const head = lp.render.el('div', 'sectionTitleContainer sectionTitleContainer-cards padded-left');
            const h2 = lp.render.el('h2', 'sectionTitle sectionTitle-cards');
            h2.appendChild(lp.render.el('span', null, tr('arr_lists_section_title')));
            h2.appendChild(lp.render.el('span', 'je-list-section-count'));
            head.appendChild(h2);
            section.appendChild(head);
            section.appendChild(lp.render.el('div', 'itemsContainer vertical-wrap je-list-cards padded-left padded-right'));
            section.addEventListener('click', ctrl.onClick);
            anchor.after(section);
            ctrl.section = section;
            return section;
        };

        /** Removes the section. */
        ctrl.removeSection = () => {
            ctrl.renderToken++;
            lp.gate.erase(() => {
                ctrl.section?.remove();
            });
            ctrl.section = null;
        };

        /** Draws the section through the gate. */
        ctrl.render = () => {
            lp.gate.paint(ctrl.ticket, ctrl.draw, 'render');
        };

        /** Draws the section (cards in slices; cards whose content didn't change are kept). Runs inside paint() only. */
        ctrl.draw = () => {
            const view = ctrl.view;
            if (!view || !ctrl.isAlive()) return;
            const placeholders = view.placeholders || [];
            ctrl.header.set(placeholders.length);
            if (!placeholders.length) {
                ctrl.removeSection();
                return;
            }
            const section = ctrl.ensureSection();
            if (!section) return;
            section.querySelector('.je-list-section-count').textContent = String(placeholders.length);
            const cards = section.querySelector('.je-list-cards');
            const context = ctrl.context();
            const old = new Map();
            cards.querySelectorAll(':scope > .je-list-card').forEach(n => old.set(n.dataset.jeListId, n));
            const token = ++ctrl.renderToken;
            // Each slice paints with the ticket it was started under: a pause, dispose or newer show drops the rest.
            const t = ctrl.ticket;
            let index = 0;
            /** Builds the next slice in place. */
            const step = () => {
                if (token !== ctrl.renderToken || !cards.isConnected) return;
                const end = Math.min(index + CARD_CHUNK, placeholders.length);
                for (; index < end; index++) {
                    const ph = placeholders[index];
                    const sig = lp.render.signature(ph, context);
                    let node = old.get(ph.id);
                    if (!node || node.__jeListSig !== sig) {
                        node = lp.render.card(ph, context);
                        node.__jeListSig = sig;
                    }
                    old.delete(ph.id);
                    const at = cards.children[index];
                    if (at !== node) cards.insertBefore(node, at || null);
                }
                if (index < placeholders.length) {
                    setTimeout(() => lp.gate.paint(t, step, 'slice'), 0);
                    return;
                }
                old.forEach(n => n.remove());
                while (cards.children.length > placeholders.length) cards.lastElementChild.remove();
                if (ctrl.focusOnRender) {
                    const target = cards.querySelector(`.je-list-card[data-je-list-id="${CSS.escape(ctrl.focusOnRender)}"] .je-list-card-main`);
                    ctrl.focusOnRender = null;
                    if (target && typeof target.focus === 'function') target.focus();
                }
            };
            step();
        };

        /**
         * Shows a view (an older revision never replaces a newer one).
         * @param {Object} view View.
         * @param {{fromChange?: boolean}} [options] A change's answer (read again soon for its statuses).
         */
        ctrl.applyView = (view, options) => {
            if (!view || lp.render.normalizeId(view.listId) !== listId || !ctrl.isAlive() || ctrl.paused) return;
            // Only for the controller's current ticket (this person, this page show, this route and list).
            if (!ctrl.ticket || !ctrl.ticket.accepts(view)) return;
            if (lp.playlist.isOlder(view, ctrl.view)) return;
            const swapped = ctrl.swappedSince(ctrl.view, view);
            ctrl.view = view;
            ctrl.render();
            ctrl.follow();
            if (swapped) ctrl.refreshNative();
            if (options?.fromChange) ctrl.scheduleRefetch(REFETCH_MS);
        };

        /**
         * Whether a newer view shows items that went into the collection since the one shown (an entry left without
         * being removed here, or a TV entry has more episodes in): Jellyfin's own cards above need a reload.
         * @param {Object|null} previous Shown view.
         * @param {Object} view New view.
         * @returns {boolean} Swapped.
         */
        ctrl.swappedSince = (previous, view) => {
            if (!previous || !(view.rev > previous.rev)) return false;
            const now = new Map((view.placeholders || []).map(ph => [ph.id, ph]));
            return (previous.placeholders || []).some((ph) => {
                const next = now.get(ph.id);
                return !next || (Number(next.filledCount) || 0) > (Number(ph.filledCount) || 0);
            });
        };

        /** Lets Jellyfin re-render its own collection cards. */
        ctrl.refreshNative = () => {
            lp.gate.paint(ctrl.ticket, () => page.querySelectorAll('.collectionItems .itemsContainer').forEach((container) => {
                try {
                    container.notifyRefreshNeeded?.(true);
                } catch {
                    // Not an emby-itemscontainer (older layouts): Jellyfin refreshes it on its own.
                }
            }), 'native');
        };

        /** Follows the shared status of the titles shown. */
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
         * Reads the view and shows it once Spoiler Guard's state is known; newer reads and leaving drop it.
         * @returns {Promise<void>}
         */
        ctrl.load = async () => {
            if (!ctrl.isShown() || ctrl.paused) return;
            const seq = ++ctrl.seq;
            ctrl.abort?.abort();
            const abort = new AbortController();
            ctrl.abort = abort;
            // Read permission is separate from paint permission so a revoked page can establish access again.
            // This rule still binds the session, page show, route, controller and newest read.
            const rule = lp.pages.ticket(ctrl, () => seq === ctrl.seq && !abort.signal.aborted && ctrl.isShown() && !ctrl.paused);
            let answer;
            let since;
            try {
                since = JE.arrStatus?.feedPosition ? await JE.arrStatus.feedPosition() : undefined;
                if (!rule.current()) return;
                answer = await JE.arrLists.getList(listId, { signal: abort.signal, ticket: rule });
                if (!rule.current()) return;
            } catch (err) {
                if (!err?.stale && err?.name !== 'AbortError') console.warn(`${logPrefix} the collection couldn't be read`, err?.message || err);
                return;
            }
            if (answer.status === 404 || answer.status === 403) {
                ctrl.ticket?.revoke();
                ctrl.view = null;
                ctrl.header.clear();
                ctrl.removeSection();
                ctrl.statusOff?.();
                ctrl.statusOff = null;
                ctrl.statusKeys = '';
                return;
            }
            if (answer.status !== 200 || !answer.body || !rule.accepts(answer.body)) return;
            if (!ctrl.ticket?.current()) ctrl.ticket = lp.pages.issue(ctrl);
            ctrl.since = since;
            ctrl.applyView(answer.body);
        };

        /**
         * Reads the view again shortly (debounced, bounded per minute).
         * @param {number} [delay] Delay in ms.
         */
        ctrl.scheduleRefetch = (delay = REFETCH_MS) => {
            if (ctrl.disposed || ctrl.paused || ctrl.refetchTimer) return;
            const now = Date.now();
            ctrl.refetches = ctrl.refetches.filter(t => now - t < 60000);
            const wait = ctrl.refetches.length >= REFETCH_PER_MINUTE ? Math.max(delay, 60000 - (now - ctrl.refetches[0])) : delay;
            ctrl.refetchTimer = setTimeout(() => {
                ctrl.refetchTimer = null;
                ctrl.refetches.push(Date.now());
                ctrl.load();
            }, wait);
        };

        /**
         * A library change Jellyfin announced.
         * @param {Set<string>} ids Changed item ids.
         * @param {boolean} added Items were added.
         */
        ctrl.onLibraryChanged = (ids, added) => {
            const placeholders = ctrl.view?.placeholders || [];
            if (ids.has(listId)) ctrl.scheduleRefetch(REFETCH_MS);
            else if (added && placeholders.some(p => p.kind !== 'custom')) ctrl.scheduleRefetch(3000);
        };

        /**
         * Clicks in the section: Request, or open the title at its exact scope.
         * @param {MouseEvent} e Event.
         */
        ctrl.onClick = (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const cardNode = target?.closest?.('.je-list-card');
            if (!cardNode) return;
            const ph = ctrl.byId(cardNode.dataset.jeListId);
            if (!ph) return;
            const request = target.closest('.je-list-request');
            const main = target.closest('button.je-list-card-main');
            if (!request && !main) return;
            e.preventDefault();
            e.stopPropagation();
            if (request) {
                if (!request.disabled) lp.request.open({ listId, ticket: () => ctrl.ticket, onDone: () => ctrl.scheduleRefetch(500) }, ph, request, JE.ownerOf?.(e));
                return;
            }
            lp.pages.openEntry(ctrl, ph, JE.ownerOf?.(e));
        };

        /** Puts the section back where it belongs after Jellyfin re-rendered the page around it. */
        ctrl.restoreIfLost = () => {
            if (ctrl.disposed || ctrl.paused || !(ctrl.view?.placeholders || []).length) return;
            const anchor = page.querySelector('.collectionItems');
            if (anchor && (!ctrl.section || !ctrl.section.isConnected || anchor.nextElementSibling !== ctrl.section)) ctrl.render();
        };

        /** Stops reading and following while the page is hidden. */
        ctrl.pause = () => {
            ctrl.paused = true;
            ctrl.ticket?.revoke();
            // Slices still scheduled stop too.
            ctrl.renderToken++;
            ctrl.seq++;
            ctrl.abort?.abort();
            ctrl.abort = null;
            clearTimeout(ctrl.refetchTimer);
            ctrl.refetchTimer = null;
            ctrl.statusOff?.();
            ctrl.statusOff = null;
            ctrl.statusKeys = '';
        };

        /** The page is shown again. */
        ctrl.resume = () => {
            if (ctrl.disposed) return;
            ctrl.paused = false;
            ctrl.ticket?.revoke();
            ctrl.ticket = null;
            ctrl.load();
        };

        /** Removes the section and stops everything. */
        ctrl.dispose = () => {
            if (ctrl.disposed) return;
            ctrl.pause();
            ctrl.disposed = true;
            ctrl.removeSection();
            ctrl.header.clear();
            ctrl.view = null;
            if (page.__jeListCollectionCtrl === ctrl) delete page.__jeListCollectionCtrl;
        };

        return ctrl;
    }

    /**
     * The controller of a collection page (one per page element).
     * @param {HTMLElement} page Details page.
     * @param {string} listId Collection id.
     * @returns {Object} Controller.
     */
    function attach(page, listId) {
        let ctrl = page.__jeListCollectionCtrl;
        if (ctrl && (ctrl.disposed || ctrl.listId !== listId)) {
            ctrl.dispose();
            ctrl = null;
        }
        if (!ctrl) {
            ctrl = createController(page, listId);
            page.__jeListCollectionCtrl = ctrl;
        }
        return ctrl;
    }

    lp.collection = { attach, createController, coveredOf };
})(window.JellyfinEnhanced);
