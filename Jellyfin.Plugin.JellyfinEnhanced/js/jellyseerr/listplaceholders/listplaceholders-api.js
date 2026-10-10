// /js/jellyseerr/listplaceholders/listplaceholders-api.js
// List placeholders ("Not in your library"): the shared internal namespace, the
// /JellyfinEnhanced/list-placeholders route wrappers and the per-list view cache.
// Nothing here runs at load time beyond defining functions; the feature starts
// from JE.initializeListPlaceholders (listplaceholders-init.js).
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const BASE = '/list-placeholders';
    /** Document event fired with {listId, view} whenever a mutation returns a fresh view. */
    const VIEW_EVENT = 'je-lp-view';
    const ID_RE = /^[0-9a-f]{32}$/;

    /** listId -> { view, at } of the last GET (shared between page modules for a few seconds). */
    const views = new Map();
    /** listId -> in-flight GET promise. */
    const inflight = new Map();

    /**
     * Whether the admin enabled list placeholders.
     * @returns {boolean}
     */
    function isEnabled() {
        return JE.pluginConfig?.ListPlaceholdersEnabled === true;
    }

    /**
     * Normalises a Jellyfin item id to the 32-hex "N" form the server uses.
     * @param {*} id - Id in N or D format.
     * @returns {string|null} The N-form id, or null when it isn't a GUID.
     */
    function normalizeId(id) {
        const value = String(id || '').replace(/-/g, '').toLowerCase();
        return ID_RE.test(value) ? value : null;
    }

    /**
     * Returns a fresh client request id (B10: the server replays a retried mutation instead of applying it twice).
     * @returns {string}
     */
    function newRequestId() {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        } catch (_) { /* fall through */ }
        let id = '';
        for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
        return id;
    }

    /**
     * Current identity epoch (0 when the session module is absent).
     * @returns {number}
     */
    function epochNow() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * Whether an epoch captured earlier still belongs to the signed-in user.
     * @param {number} epoch
     * @returns {boolean}
     */
    function isCurrentEpoch(epoch) {
        return !JE.session?.isCurrent || JE.session.isCurrent(epoch);
    }

    /**
     * Calls a list-placeholders route.
     * @param {string} path - Path below /JellyfinEnhanced/list-placeholders.
     * @param {Object} [options] - JE.core.api options.
     * @returns {Promise<any>}
     */
    function call(path, options) {
        return JE.core.api.plugin(BASE + path, options);
    }

    /**
     * Whether a view is older than one already known for the list. Revisions only grow on the
     * server (a document is deleted only with its list), so a lower rev is a stale answer.
     * @param {Object} view - ListViewDto.
     * @param {Object|null|undefined} known - The newest view seen so far.
     * @returns {boolean}
     */
    function isOlderView(view, known) {
        return !!known && Number.isFinite(view?.rev) && Number.isFinite(known.rev) && view.rev < known.rev;
    }

    /**
     * Caches a view and tells page modules about it (never replacing a newer revision).
     * @param {Object} view - ListViewDto.
     * @returns {Object} The same view.
     */
    function publish(view) {
        if (!view || !view.listId) return view;
        if (isOlderView(view, views.get(view.listId)?.view)) return view;
        views.set(view.listId, { view, at: Date.now() });
        document.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: { listId: view.listId, view } }));
        return view;
    }

    /**
     * The error a mutation rejects with when its answer arrives after a user switch: the
     * result is dropped, and callers stay silent (no toast, no retry) under the new identity.
     * @returns {Error}
     */
    function staleIdentityError() {
        const error = new Error('The signed-in user changed while the request was running.');
        error.name = 'AbortError';
        error.jeStaleIdentity = true;
        return error;
    }

    /**
     * Whether an error is a dropped answer from before a user switch.
     * @param {*} error
     * @returns {boolean}
     */
    function isStaleIdentityError(error) {
        return error?.jeStaleIdentity === true;
    }

    /**
     * Toasts a failed list call, unless it was dropped because the user changed.
     * @param {*} error
     */
    function toastError(error) {
        if (!isStaleIdentityError(error)) JE.toast(errorMessage(error), 4000);
    }

    /**
     * Loads the caller's view of a list. Concurrent callers share one request; with
     * `maxAgeMs` a view fetched that recently is reused (one GET per page view even when
     * the collection section and the "Missing from" discovery both need it).
     * @param {string} listId - Playlist or collection id.
     * @param {{maxAgeMs?: number}} [options]
     * @returns {Promise<Object>} ListViewDto.
     */
    function getView(listId, options = {}) {
        const id = normalizeId(listId);
        if (!id) return Promise.reject(new Error('invalid list id'));
        const maxAgeMs = options.maxAgeMs || 0;
        const cached = views.get(id);
        if (maxAgeMs > 0 && cached && Date.now() - cached.at <= maxAgeMs) return Promise.resolve(cached.view);
        const running = inflight.get(id);
        if (running) return running;
        const epoch = epochNow();
        const promise = call('/' + id, { skipCache: true })
            .then((view) => {
                if (!isCurrentEpoch(epoch) || !view || !view.listId) return view;
                // A GET that read an older revision than a mutation published meanwhile is stale.
                const known = views.get(view.listId)?.view;
                if (isOlderView(view, known)) return known;
                views.set(view.listId, { view, at: Date.now() });
                return view;
            })
            .finally(() => {
                if (inflight.get(id) === promise) inflight.delete(id);
            });
        inflight.set(id, promise);
        return promise;
    }

    /**
     * Runs a mutation and publishes the view it returns (also the fresh view a 409 carries).
     * An answer that arrives after a user switch is dropped (rejects with a stale-identity error).
     * @param {string} method - HTTP method.
     * @param {string} path - Route path.
     * @param {Object} [body] - JSON body.
     * @returns {Promise<any>} The parsed response.
     */
    async function mutate(method, path, body) {
        const epoch = epochNow();
        let result;
        try {
            result = await call(path, { method, body, skipRetry: true, skipCache: true });
        } catch (error) {
            if (!isCurrentEpoch(epoch)) throw staleIdentityError();
            const view = error?.responseJSON?.view;
            if (view) publish(view);
            throw error;
        }
        if (!isCurrentEpoch(epoch)) throw staleIdentityError();
        const view = result?.view || result?.result?.view || (result && Array.isArray(result.placeholders) ? result : null);
        if (view) publish(view);
        return result;
    }

    /**
     * Adds placeholders to a list (titles already in the library become real entries server-side).
     * @param {string} listId
     * @param {Array<Object>} placeholders - NewPlaceholderDto list.
     * @param {Object} [position] - {afterToken} or {atStart:true}; omitted = end.
     * @returns {Promise<Object>} ApplyResultDto.
     */
    function addPlaceholders(listId, placeholders, position) {
        const body = { requestId: newRequestId(), placeholders };
        if (position) body.position = position;
        return mutate('POST', `/${normalizeId(listId)}/items`, body);
    }

    /**
     * Edits a placeholder (note, or link a custom entry to a TMDB title).
     * @param {string} listId
     * @param {string} placeholderId
     * @param {{rev: number, note?: string, link?: Object}} change
     * @returns {Promise<Object>} ListViewDto.
     */
    function patchPlaceholder(listId, placeholderId, change) {
        return mutate('PATCH', `/${normalizeId(listId)}/items/${encodeURIComponent(placeholderId)}`, { requestId: newRequestId(), ...change });
    }

    /**
     * Removes a placeholder.
     * @param {string} listId
     * @param {string} placeholderId
     * @param {number} rev - Revision the caller saw.
     * @returns {Promise<Object>} ListViewDto.
     */
    function removePlaceholder(listId, placeholderId, rev) {
        const query = `?rev=${encodeURIComponent(rev)}&requestId=${encodeURIComponent(newRequestId())}`;
        return mutate('DELETE', `/${normalizeId(listId)}/items/${encodeURIComponent(placeholderId)}${query}`);
    }

    /**
     * Saves a playlist's new order (the caller's projection after a drag or a menu move).
     * @param {string} listId
     * @param {number} rev
     * @param {string[]} order - Tokens in the new order.
     * @param {string|null} moved - The real token that moved (the server moves it in Jellyfin), if any.
     * @returns {Promise<Object>} ListViewDto.
     */
    function reorder(listId, rev, order, moved) {
        const body = { requestId: newRequestId(), rev, order };
        if (moved) body.moved = moved;
        return mutate('PUT', `/${normalizeId(listId)}/order`, body);
    }

    /**
     * Lists the playlists and collections the caller can add to.
     * @returns {Promise<Object>} EditableListsDto.
     */
    function getEditableLists() {
        return call('/editable-lists', { skipCache: true });
    }

    /**
     * Creates a playlist (any user) or collection (admins / collection managers) with initial entries.
     * @param {'playlist'|'collection'} kind
     * @param {{name: string, isPublic?: boolean, entries?: Array<Object>, requestId?: string}} data - Pass the
     *   same `requestId` when retrying a failed create: the server then re-applies to the list the first attempt
     *   created instead of creating another one.
     * @returns {Promise<Object>} CreateListResultDto.
     */
    function createList(kind, data) {
        const path = kind === 'collection' ? '/collections' : '/playlists';
        return mutate('POST', path, { requestId: data.requestId || newRequestId(), name: data.name, isPublic: !!data.isPublic, entries: data.entries || [] });
    }

    /** Forgets every cached view (user switch). */
    function resetCaches() {
        views.clear();
        inflight.clear();
    }

    /**
     * Turns a failed call into a short, already-escaped message for a toast.
     * @param {*} error - Error from JE.core.api (status/responseJSON).
     * @returns {string}
     */
    function errorMessage(error) {
        const code = error?.responseJSON?.code;
        const known = {
            rev_conflict: 'listPlaceholders_err_changed',
            stale_anchor: 'listPlaceholders_err_changed',
            real_order_changed: 'listPlaceholders_err_changed',
            not_permutation: 'listPlaceholders_err_changed',
            move_mismatch: 'listPlaceholders_err_changed',
            duplicate_copy: 'listPlaceholders_err_duplicate_copy',
            forbidden: 'listPlaceholders_err_forbidden',
            parental_block: 'listPlaceholders_err_forbidden',
            not_found: 'listPlaceholders_err_not_found',
            store_unavailable: 'listPlaceholders_err_unavailable',
            duplicate: 'listPlaceholders_skip_duplicate'
        };
        if (code && known[code]) return JE.t(known[code]);
        if (error?.status === 403) return JE.t('listPlaceholders_err_forbidden');
        if (error?.status === 404) return JE.t('listPlaceholders_err_not_found');
        return JE.t('listPlaceholders_err_generic');
    }

    /**
     * Text for a skipped add/apply entry.
     * @param {string} reason - SkippedEntryDto.reason.
     * @returns {string}
     */
    function skipReasonText(reason) {
        const keys = {
            duplicate: 'listPlaceholders_skip_duplicate',
            alreadyInList: 'listPlaceholders_skip_already_in_list',
            listFull: 'listPlaceholders_skip_list_full',
            blocked: 'listPlaceholders_skip_blocked'
        };
        return JE.t(keys[reason] || 'listPlaceholders_skip_other');
    }

    /** Live page controllers (playlist/collection pages); pruned when their page is gone. */
    lp.controllers = lp.controllers || new Set();
    lp.events = { VIEW: VIEW_EVENT };
    lp.isEnabled = isEnabled;
    lp.normalizeId = normalizeId;
    lp.newRequestId = newRequestId;
    lp.epochNow = epochNow;
    lp.isCurrentEpoch = isCurrentEpoch;
    lp.errorMessage = errorMessage;
    lp.toastError = toastError;
    lp.isStaleIdentityError = isStaleIdentityError;
    lp.isOlderView = isOlderView;
    lp.skipReasonText = skipReasonText;
    lp.api = {
        getView,
        addPlaceholders,
        patchPlaceholder,
        removePlaceholder,
        reorder,
        getEditableLists,
        createList,
        resetCaches,
        publish
    };

})(window.JellyfinEnhanced);
