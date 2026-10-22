/**
 * @file Requests & downloads, phase 4 lists: the client transport of /JellyfinEnhanced/acquire/lists (list views,
 * adding/applying/editing/removing entries, reorder, the swap-in switch, request preview and Request one / Request all
 * missing, editable lists, creating playlists and collections). One request id per user action, reused by a retry after
 * a lost answer (the server answers a retry from its durable operation, never applying it twice). No network on load.
 * Page modules (playlist rows, collection section, pickers) build on JE.arrLists; nothing here renders.
 *
 * One acceptance rule for every answer ({@link ticket}): it is used (cached, announced to listeners, drawn) only while
 * the session it was asked in is still the current one and, for a view, only when it is the view of the list asked
 * about; pages add their own view and route to the same rule. It is checked after every await, so an answer read
 * across a person switch is dropped (rejects with {stale: true}). Change notifications carry the session they come
 * from ({epoch}), and listeners refuse another session's.
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
     * A list id in N form (32 lowercase hex), or null.
     * @param {*} id Id in N or D form.
     * @returns {string|null} Id.
     */
    function normalizeId(id) {
        const value = String(id || '').replace(/-/g, '').toLowerCase();
        return /^[0-9a-f]{32}$/.test(value) ? value : null;
    }

    /**
     * The acceptance rule of one request: taken before it is sent, asked after every await.
     * - current(): the session it was asked in is still the current one, and the caller's own scope (a page adds the
     *   view shown and its route) still holds;
     * - accepts(view): current, and a view (when there is one) is of the list asked about.
     * @param {string|null} listId The list asked about (null: not about one list).
     * @param {function(): boolean} [scope] The caller's part of the rule.
     * @returns {{epoch: number, listId: (string|null), current: function(): boolean, accepts: function(Object=): boolean}} Ticket.
     */
    function ticket(listId, scope) {
        const same = value => normalizeId(value) || String(value ?? '');
        const id = listId == null ? null : same(listId);
        const started = epoch();
        const current = () => epoch() === started && (typeof scope !== 'function' || scope() === true);
        return {
            epoch: started,
            listId: id,
            current,
            accepts: view => current() && (!view || (id !== null && same(view.listId) === id))
        };
    }

    /** The rejection of an answer the rule refused. */
    const STALE = Object.freeze({ stale: true });

    /**
     * A new request id for one user action (keep it for that action's retries).
     * @returns {string} Request id ([A-Za-z0-9_-], at most 64 characters).
     */
    function newRequestId() {
        const random = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
        return 'l' + random.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    }

    /**
     * Calls a list route; resolves with {status, body} for every HTTP answer, rejects with {stale:true} when the rule
     * refuses it (another session, or the caller's scope no longer holds) and with the fetch error when no answer arrived.
     * @param {string} path Path under /JellyfinEnhanced/acquire/lists.
     * @param {{method?: string, body?: Object, signal?: AbortSignal, etag?: string, ticket?: Object, session?: any,
     *   readOnly?: boolean}} [options] Options; session: a write's origin (required: a write without it is refused, never
     *   sent as whoever is signed in); readOnly: a read sent as POST (a preview), which needs none.
     * @returns {Promise<{status: number, body: Object|null, etag: string|null}>} The answer.
     */
    async function call(path, options) {
        const rule = options?.ticket || ticket(null);
        const method = options?.method || 'GET';
        // A write goes out through JE.core.userWrite with the origin it was made in (never another person's).
        const write = method !== 'GET' && options?.readOnly !== true;
        const binding = write ? options?.session || null : null;
        if (write && !binding) return JE.core.userWrite.send(null, () => Promise.resolve(), path);
        const transmit = () => {
            const headers = { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json' };
            if (options?.body) headers['Content-Type'] = 'application/json';
            if (options?.etag) headers['If-None-Match'] = options.etag;
            return fetch(ApiClient.getUrl(`/JellyfinEnhanced/acquire/lists${path}`), {
                method,
                headers,
                body: options?.body ? JSON.stringify(options.body) : undefined,
                signal: options?.signal,
                cache: 'no-store'
            });
        };
        const response = await (binding ? JE.core.userWrite.send(binding, transmit, path) : transmit());
        // Every answer names the server's build: seen before the rule or the body can end this call (asked with no-store:
        // the server's now).
        JE.core.build?.noteAnswer?.(response, { fresh: true });
        if (!rule.current()) throw STALE;

        let body = null;
        if (response.status !== 304) {
            const text = await response.text().catch(() => '');
            // The body can take a while: the person may have changed while it was read.
            if (!rule.current()) throw STALE;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                body = null;
            }
        }

        return { status: response.status, body, etag: response.headers.get('ETag') };
    }

    /**
     * Tells listeners a list changed (its new view, when known), with the session it comes from.
     * @param {string} listId List id.
     * @param {Object|null} view The new view.
     * @param {{epoch: number}} origin The session of the change.
     */
    function changed(listId, view, origin) {
        if (view && view.listId) views.delete(normalizeId(view.listId) || view.listId);
        views.delete(listId);
        for (const listener of listeners) {
            try {
                listener(listId, view, { epoch: origin.epoch });
            } catch (error) {
                console.warn(logPrefix, 'listener failed', error);
            }
        }
    }

    /**
     * A mutation: its answer's view (409 conflicts carry a fresh one too) is announced to listeners, if the rule still
     * accepts it (a view of another list is announced as "changed", without it).
     * @param {string} listId List id.
     * @param {string} path Path.
     * @param {string} method Method.
     * @param {Object} body Body.
     * @param {AbortSignal} [signal] Abort.
     * @param {any} [origin] The change's origin (taken when the person acted; required from a caller that waited).
     * @returns {Promise<{status: number, body: Object|null}>} The answer.
     */
    async function mutate(listId, path, method, body, signal, origin) {
        origin = JE.core.userWrite.originOf(origin);
        const rule = ticket(listId);
        const answer = await call(path, { method, body, signal, ticket: rule, session: origin });
        if (!rule.current()) throw STALE;
        const found = answer.body?.view || answer.body?.result?.view || (answer.body?.listId && answer.body?.placeholders ? answer.body : null);
        const view = found && rule.accepts(found) ? found : null;
        if (answer.status < 500) changed(listId, view, rule);
        return answer;
    }

    /**
     * The caller's view of a list (revalidated: an unchanged list costs no body). Cached only while the rule accepts it.
     * @param {string} listId Playlist or collection id.
     * @param {{signal?: AbortSignal, ticket?: Object}} [options] Options (a page's ticket adds its view and route).
     * @returns {Promise<{status: number, body: Object|null}>} The view ({listId, listKind, rev, canEdit, nativeCanEdit, actions[], statusShown, swapIn, reconciling, placeholders[], order?, source?}).
     */
    async function getList(listId, options) {
        const rule = options?.ticket || ticket(listId);
        const cached = views.get(listId);
        const answer = await call(`/${encodeURIComponent(listId)}`, { signal: options?.signal, etag: cached?.etag, ticket: rule });
        if (!rule.current()) throw STALE;
        if (answer.status === 304 && cached) return { status: 200, body: cached.view };
        if (answer.status === 200 && answer.body && !rule.accepts(answer.body)) throw STALE;
        if (answer.status === 200 && answer.etag) views.set(listId, { etag: answer.etag, view: answer.body });
        return answer;
    }

    const api = {
        enabled,
        newRequestId,
        ticket,
        getList,
        /**
         * Adds entries ({kind, mediaType, tmdbId, tvdbId?, imdbId?, title, year?, releaseDate?, posterPath?, seasonNumber?, episodes?, note?, edition?}).
         * @param {string} listId List id.
         * @param {{requestId: string, rev?: number, placeholders: Object[], position?: {afterToken?: string, atStart?: boolean}}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ApplyResult ({added[], addedAsItems[], skipped[], view}).
         */
        addItems: (listId, body, signal, origin) => mutate(listId, `/${encodeURIComponent(listId)}/items`, 'POST', body, signal, origin),
        /**
         * Applies ordered entries ({type: 'item', itemId} or {type: 'placeholder', placeholder}).
         * @param {string} listId List id.
         * @param {{requestId: string, rev?: number, entries: Object[], position?: Object}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ApplyResult.
         */
        apply: (listId, body, signal, origin) => mutate(listId, `/${encodeURIComponent(listId)}/apply`, 'POST', body, signal, origin),
        /**
         * Edits an entry's note, or links a custom entry to a title.
         * @param {string} listId List id.
         * @param {string} placeholderId Entry id.
         * @param {{requestId: string, rev: number, note?: string, link?: Object}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} The view.
         */
        patchItem: (listId, placeholderId, body, signal, origin) => mutate(listId, `/${encodeURIComponent(listId)}/items/${encodeURIComponent(placeholderId)}`, 'PATCH', body, signal, origin),
        /**
         * Removes an entry.
         * @param {string} listId List id.
         * @param {string} placeholderId Entry id.
         * @param {{requestId: string, rev: number}} query Revision and request id.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} The view.
         */
        removeItem: (listId, placeholderId, query, signal, origin) => mutate(listId, `/${encodeURIComponent(listId)}/items/${encodeURIComponent(placeholderId)}?rev=${encodeURIComponent(query.rev)}&requestId=${encodeURIComponent(query.requestId)}`, 'DELETE', null, signal, origin),
        /**
         * Saves the order after a drag (the caller's projection; a moved real row is moved in Jellyfin by the server).
         * @param {string} listId Playlist id.
         * @param {{requestId: string, rev: number, order: string[], moved?: string}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} The view (409 with a fresh view when it can't).
         */
        reorder: (listId, body, signal, origin) => mutate(listId, `/${encodeURIComponent(listId)}/order`, 'PUT', body, signal, origin),
        /**
         * Turns automatic swap-in on or off for a list.
         * @param {string} listId List id.
         * @param {{requestId: string, rev: number, enabled: boolean}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} The view.
         */
        setSwapIn: (listId, body, signal, origin) => mutate(listId, `/${encodeURIComponent(listId)}/swap-in`, 'PUT', body, signal, origin),
        /**
         * What asking for entries would do (nothing is written).
         * @param {string} listId List id.
         * @param {{placeholderIds?: string[], all?: boolean}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} Preview ({items[{placeholderId, title, outcome, reason, cost}], askable, cost, maxBatch}).
         */
        previewRequests: (listId, body, signal) => call(`/${encodeURIComponent(listId)}/requests/preview`, { method: 'POST', body, signal, readOnly: true }),
        /**
         * Asks for at most 20 entries as one confirmation (keep clientId for its retries).
         * @param {string} listId List id.
         * @param {{clientId: string, placeholderIds: string[]}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ({operationId, replayed, results[{placeholderId, result}], view}).
         */
        requestEntries: async (listId, body, signal, origin) => {
            origin = JE.core.userWrite.originOf(origin);
            const rule = ticket(listId);
            const answer = await mutate(listId, `/${encodeURIComponent(listId)}/requests`, 'POST', body, signal, origin);
            if (!rule.current()) throw STALE;
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
        createPlaylist: (body, signal, origin) => call('/playlists', { method: 'POST', body, signal, session: JE.core.userWrite.originOf(origin) }),
        /**
         * Creates a collection (administrators and collection managers).
         * @param {{requestId: string, name: string, entries?: Object[]}} body Body.
         * @param {AbortSignal} [signal] Abort.
         * @returns {Promise<{status: number, body: Object|null}>} ({listId, listKind, name, result}).
         */
        createCollection: (body, signal, origin) => call('/collections', { method: 'POST', body, signal, session: JE.core.userWrite.originOf(origin) }),
        /**
         * Subscribes to list changes made through this module.
         * @param {function(string, Object|null, {epoch: number}): void} listener Called with (listId, view or null, the
         *   session of the change: refuse it when it isn't the current one).
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
