/**
 * @file Requests & downloads, phase 4 lists: the client transport of /JellyfinEnhanced/acquire/lists (list views,
 * adding/applying/editing/removing entries, reorder, the swap-in switch, request preview and Request one / Request all
 * missing, editable lists, creating playlists and collections). One request id per user action, reused by a retry after
 * a lost answer (the server answers a retry from its durable operation, never applying it twice). Answers that arrive
 * after a user switch are dropped. No network on load. Page modules (playlist rows, collection section, pickers) build
 * on JE.arrLists; nothing here renders.
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Lists:';
    /** @type {Set<Function>} */
    const listeners = new Set();
    /** @type {Map<string, {etag: string, view: Object}>} list id -> last view (revalidated with its ETag) */
    const views = new Map();

    /**
     * True when the server has lists on (all parents and the list switch).
     * @returns {boolean} Enabled.
     */
    function enabled() {
        return JE.pluginConfig?.ArrListsEnabled === true;
    }

    /**
     * The current session epoch (a user switch changes it).
     * @returns {number} Epoch.
     */
    function epoch() {
        return JE.session?.getEpoch ? JE.session.getEpoch() : 0;
    }

    /**
     * A new request id for one user action (keep it for that action's retries).
     * @returns {string} Request id ([A-Za-z0-9_-], at most 64 characters).
     */
    function newRequestId() {
        const random = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
        return 'l' + random.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    }

    /**
     * Calls a list route; resolves with {status, body} for every HTTP answer, rejects with {stale:true} when the user
     * changed meanwhile and with the fetch error when no answer arrived.
     * @param {string} path Path under /JellyfinEnhanced/acquire/lists.
     * @param {{method?: string, body?: Object, signal?: AbortSignal, etag?: string}} [options] Options.
     * @returns {Promise<{status: number, body: Object|null, etag: string|null}>} The answer.
     */
    async function call(path, options) {
        const started = epoch();
        const method = options?.method || 'GET';
        const headers = { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json' };
        if (options?.body) headers['Content-Type'] = 'application/json';
        if (options?.etag) headers['If-None-Match'] = options.etag;
        const response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/acquire/lists${path}`), {
            method,
            headers,
            body: options?.body ? JSON.stringify(options.body) : undefined,
            signal: options?.signal,
            cache: 'no-store'
        });
        if (epoch() !== started) {
            throw { stale: true };
        }

        let body = null;
        if (response.status !== 304) {
            try {
                const text = await response.text();
                body = text ? JSON.parse(text) : null;
            } catch {
                body = null;
            }
        }

        return { status: response.status, body, etag: response.headers.get('ETag') };
    }

    /**
     * Tells listeners a list changed (its new view, when known).
     * @param {string} listId List id.
     * @param {Object|null} view The new view.
     */
    function changed(listId, view) {
        if (view && view.listId) views.delete(view.listId);
        for (const listener of listeners) {
            try {
                listener(listId, view);
            } catch (error) {
                console.warn(logPrefix, 'listener failed', error);
            }
        }
    }

    /**
     * A mutation: its answer's view (409 conflicts carry a fresh one too) is announced to listeners.
     * @param {string} listId List id.
     * @param {string} path Path.
     * @param {string} method Method.
     * @param {Object} body Body.
     * @param {AbortSignal} [signal] Abort.
     * @returns {Promise<{status: number, body: Object|null}>} The answer.
     */
    async function mutate(listId, path, method, body, signal) {
        const answer = await call(path, { method, body, signal });
        const view = answer.body?.view || answer.body?.result?.view || (answer.body?.listId && answer.body?.placeholders ? answer.body : null);
        if (answer.status < 500) changed(listId, view);
        return answer;
    }

    /**
     * The caller's view of a list (revalidated: an unchanged list costs no body).
     * @param {string} listId Playlist or collection id.
     * @param {{signal?: AbortSignal}} [options] Options.
     * @returns {Promise<{status: number, body: Object|null}>} The view ({listId, listKind, rev, canEdit, nativeCanEdit, actions[], statusShown, swapIn, reconciling, placeholders[], order?, source?}).
     */
    async function getList(listId, options) {
        const cached = views.get(listId);
        const answer = await call(`/${encodeURIComponent(listId)}`, { signal: options?.signal, etag: cached?.etag });
        if (answer.status === 304 && cached) return { status: 200, body: cached.view };
        if (answer.status === 200 && answer.etag) views.set(listId, { etag: answer.etag, view: answer.body });
        return answer;
    }

    const api = {
        enabled,
        newRequestId,
        getList,
        /**
         * Adds entries ({kind, mediaType, tmdbId, tvdbId?, imdbId?, title, year?, releaseDate?, posterPath?, seasonNumber?, episodes?, note?, edition?}).
         * @param {string} listId List id.
         * @param {{requestId: string, rev?: number, placeholders: Object[], position?: {afterToken?: string, atStart?: boolean}}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ApplyResult ({added[], addedAsItems[], skipped[], view}).
         */
        addItems: (listId, body, signal) => mutate(listId, `/${encodeURIComponent(listId)}/items`, 'POST', body, signal),
        /**
         * Applies ordered entries ({type: 'item', itemId} or {type: 'placeholder', placeholder}).
         * @param {string} listId List id.
         * @param {{requestId: string, rev?: number, entries: Object[], position?: Object}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ApplyResult.
         */
        apply: (listId, body, signal) => mutate(listId, `/${encodeURIComponent(listId)}/apply`, 'POST', body, signal),
        /**
         * Edits an entry's note, or links a custom entry to a title.
         * @param {string} listId List id.
         * @param {string} placeholderId Entry id.
         * @param {{requestId: string, rev: number, note?: string, link?: Object}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} The view.
         */
        patchItem: (listId, placeholderId, body, signal) => mutate(listId, `/${encodeURIComponent(listId)}/items/${encodeURIComponent(placeholderId)}`, 'PATCH', body, signal),
        /**
         * Removes an entry.
         * @param {string} listId List id.
         * @param {string} placeholderId Entry id.
         * @param {{requestId: string, rev: number}} query Revision and request id.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} The view.
         */
        removeItem: (listId, placeholderId, query, signal) => mutate(listId, `/${encodeURIComponent(listId)}/items/${encodeURIComponent(placeholderId)}?rev=${encodeURIComponent(query.rev)}&requestId=${encodeURIComponent(query.requestId)}`, 'DELETE', null, signal),
        /**
         * Saves the order after a drag (the caller's projection; a moved real row is moved in Jellyfin by the server).
         * @param {string} listId Playlist id.
         * @param {{requestId: string, rev: number, order: string[], moved?: string}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} The view (409 with a fresh view when it can't).
         */
        reorder: (listId, body, signal) => mutate(listId, `/${encodeURIComponent(listId)}/order`, 'PUT', body, signal),
        /**
         * Turns automatic swap-in on or off for a list.
         * @param {string} listId List id.
         * @param {{requestId: string, rev: number, enabled: boolean}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} The view.
         */
        setSwapIn: (listId, body, signal) => mutate(listId, `/${encodeURIComponent(listId)}/swap-in`, 'PUT', body, signal),
        /**
         * What asking for entries would do (nothing is written).
         * @param {string} listId List id.
         * @param {{placeholderIds?: string[], all?: boolean}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} Preview ({items[{placeholderId, title, outcome, reason, cost}], askable, cost, maxBatch}).
         */
        previewRequests: (listId, body, signal) => call(`/${encodeURIComponent(listId)}/requests/preview`, { method: 'POST', body, signal }),
        /**
         * Asks for at most 20 entries as one confirmation (keep clientId for its retries).
         * @param {string} listId List id.
         * @param {{clientId: string, placeholderIds: string[]}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ({operationId, replayed, results[{placeholderId, result}], view}).
         */
        requestEntries: async (listId, body, signal) => {
            const answer = await mutate(listId, `/${encodeURIComponent(listId)}/requests`, 'POST', body, signal);
            if (answer.status < 300) JE.arrStatus?.refresh?.();
            return answer;
        },
        /**
         * Lists the caller can add to.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ({playlists[], collections[], canManageCollections}).
         */
        editableLists: (signal) => call('/editable', { signal }),
        /**
         * Creates a playlist owned by the caller.
         * @param {{requestId: string, name: string, isPublic?: boolean, entries?: Object[]}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ({listId, listKind, name, result}).
         */
        createPlaylist: (body, signal) => call('/playlists', { method: 'POST', body, signal }),
        /**
         * Creates a collection (administrators and collection managers).
         * @param {{requestId: string, name: string, entries?: Object[]}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ({listId, listKind, name, result}).
         */
        createCollection: (body, signal) => call('/collections', { method: 'POST', body, signal }),
        /**
         * Subscribes to list changes made through this module.
         * @param {function(string, Object|null): void} listener Called with (listId, view or null).
         * @returns {function(): void} Unsubscribe.
         */
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        /** Forgets cached views (after a user switch). */
        reset: () => views.clear()
    };

    JE.arrLists = api;
})(window.JellyfinEnhanced);
