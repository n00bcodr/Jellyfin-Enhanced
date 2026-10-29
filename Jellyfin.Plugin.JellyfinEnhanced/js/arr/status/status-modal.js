/**
 * @file Requests & downloads, phase 1: the status pill and journey in Seerr's more-info modal, for
 * titles that may not be in Jellyfin yet ("Downloading · 42% · about 12 min", "Waiting for Dad to
 * OK it"). One status read per modal (GET /acquire/status?keys=…&detail=true), re-read in place when
 * the change feed reports the title. Administrators also get a Manage button. Nothing is shown when
 * the status is quiet (e.g. long since ready) or the viewer may not ask about the title.
 */
(function (JE) {
    'use strict';

    const SURFACE = 'modal';
    let current = null; // { modal, key, controller, unsubscribe }

    /**
     * True when the server has the modal pill on.
     * @returns {boolean} Enabled.
     */
    function enabled() {
        return JE.pluginConfig?.ArrSeerrModalStatus === true && JE.arrStatus?.enabled?.() === true;
    }

    /**
     * The title key of a more-info modal's title: TMDB for a movie; TVDB for a series when Seerr
     * names one, else TMDB.
     * @param {Object} data Seerr's details.
     * @param {string} mediaType movie or tv.
     * @returns {string|null} Key.
     */
    function keyOf(data, mediaType) {
        const tmdb = Number(data?.id);
        if (mediaType === 'movie') return tmdb > 0 ? `movie:tmdb:${tmdb}` : null;
        const tvdb = Number(data?.externalIds?.tvdbId);
        if (tvdb > 0) return `tv:tvdb:${tvdb}`;
        return tmdb > 0 ? `tv:tmdb:${tmdb}` : null;
    }

    /**
     * The change-feed keys to follow for the modal's title: its key and the key the feed announces it
     * under. A series known only by TMDB (no TVDB id anywhere yet) has no key the feed carries, so the
     * viewer's own request-list key stands in: their own request being answered still updates the pill.
     * @param {string} key Title key.
     * @param {Object|undefined} status The title's status.
     * @returns {string[]} Keys.
     */
    function followKeys(key, status) {
        const keys = [key, status?.liveKey].filter(Boolean);
        if (keys.some((k) => /^(movie:tmdb|tv:tvdb):/.test(k))) return keys;
        const userId = typeof ApiClient !== 'undefined' && typeof ApiClient.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
        if (userId) keys.push('req:u:' + String(userId).replace(/-/g, '').toLowerCase());
        return keys;
    }

    /**
     * Stops following the current modal's title.
     * @returns {void}
     */
    function stop() {
        if (!current) return;
        current.controller.abort();
        if (typeof current.unsubscribe === 'function') current.unsubscribe();
        current = null;
    }

    /**
     * Where the pill goes in the modal: under the tagline, above "requested by" and the actions.
     * @param {HTMLElement} modal Modal.
     * @returns {HTMLElement|null} Mount.
     */
    function mountOf(modal) {
        let mount = modal.querySelector('.je-arr-modal-status');
        if (mount) return mount;
        const anchor = modal.querySelector('[data-mount="je-requested-by"]');
        if (!anchor?.parentNode) return null;
        mount = document.createElement('div');
        mount.className = 'je-arr-modal-status';
        anchor.parentNode.insertBefore(mount, anchor);
        return mount;
    }

    /**
     * Reads and renders the status for the modal shown now; again when the feed reports a change.
     * @param {Object} state Modal state.
     * @returns {Promise<void>}
     */
    async function update(state) {
        if (current !== state) return;
        // Feed changes start reads that can overlap: only the newest renders, and only while the window's owner is
        // current (D46S2-R6).
        const newest = state.reads(JE.ownerOf(state.modal));
        const data = await JE.arrStatus.fetchKey(state.key, state.controller.signal);
        if (current !== state || !document.contains(state.modal) || !newest()) return;
        const status = data?.items?.[0];
        const mount = mountOf(state.modal);
        if (!mount) return;
        if (!data && state.unsubscribe) return; // a failed re-read keeps what is shown
        mount.textContent = '';
        if (status && (!status.quiet || status.admin)) {
            const block = JE.arrStatus.buildPill(status, data);
            block.dataset.jeArrSurface = SURFACE;
            mount.appendChild(block);
            if (status.admin && JE.pluginConfig?.ArrManageDrawerEnabled && JE.arrManage) {
                const manage = document.createElement('button');
                manage.type = 'button';
                manage.className = 'je-manage-btn je-arr-modal-manage';
                JE.internals?.arrManage?.injectStyles?.();
                manage.appendChild(JE.arrStatus.icon('tune'));
                manage.appendChild(document.createTextNode(JE.arrStatus.tr('arr_manage_button')));
                manage.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    JE.arrManage.open({ key: status.key, name: state.name }, { operation: JE.ownerOf(e) });
                });
                mount.appendChild(manage);
            }
        }
        // Phase 2: Notify me / Following (and Remind) for the title, in or not in the library.
        JE.internals?.arrNotify?.attachModal?.(mount, status || null, state.key, data);
        if (state.unsubscribe) state.unsubscribe();
        const keys = followKeys(state.key, status);
        state.unsubscribe = JE.arrStatus.subscribe(keys, () => update(state), { since: data?.since ?? null });
    }

    /**
     * A more-info modal opened (its init module announces it).
     * @param {CustomEvent} e Event with detail {modal, data, mediaType}.
     * @returns {void}
     */
    function onOpened(e) {
        stop();
        if (!enabled()) return;
        const { modal, data, mediaType } = e.detail || {};
        const key = keyOf(data, mediaType);
        if (!modal || !key) return;
        current = { modal, key, name: data?.title || data?.name || '', controller: new AbortController(), unsubscribe: null, reads: JE.latestIntent() };
        update(current);
    }

    let started = false;

    /**
     * Starts the modal surface (behind its flag).
     * @returns {void}
     */
    function initialize() {
        if (started || !enabled()) return;
        started = true;
        document.addEventListener('jellyseerr-more-info-opened', onOpened);
        // The close event comes after the exit animation, possibly after another modal opened.
        document.addEventListener('jellyseerr-more-info-closed', () => {
            if (current && !document.contains(current.modal)) stop();
        });
    }

    JE.session?.onUserChange?.('arr-status-modal', stop);

    JE.internals = JE.internals || {};
    JE.internals.arrStatusModal = { keyOf, stop, followKeys };
    JE.initializeArrStatusModal = initialize;
})(window.JellyfinEnhanced);
