// @ts-check
// In-memory Spoiler Guard state and server API operations.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    const enabledSeries = new Set();
    const enabledMovies = new Set();
    const enabledCollections = new Set();
    const enabledPendingTmdb = new Set();

    let userPrefs = {};
    let loaded = false;
    let loadOk = false;
    let statePromise = null;

    function request(path, options) {
        return JE.core.api.plugin(path, options);
    }

    let mutationQueue = Promise.resolve();
    let generation = 0;

    /** Replaces every mirror from the same complete server document; removed copies and mappings disappear. */
    function adoptState(data) {
        const value = data || {};
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        Object.keys(value.Series || {}).forEach(key => enabledSeries.add(internal.normalizeId(key)));
        Object.keys(value.Movies || {}).forEach(key => enabledMovies.add(internal.normalizeId(key)));
        Object.keys(value.Collections || {}).forEach(key => enabledCollections.add(internal.normalizeId(key)));
        Object.keys(value.ProviderTitles || {}).forEach(key => enabledPendingTmdb.add(String(key).replace(':tmdb:', ':').toLowerCase()));
        Object.keys(value.PendingTmdb || {}).forEach(key => enabledPendingTmdb.add(String(key).toLowerCase()));
        userPrefs = value.Prefs || {};
        loaded = true;
        loadOk = true;
    }

    /** All controls share one ordered write, authoritative read and policy notification path. */
    function mutateState(path, options) {
        const action = JE.createSessionAction();
        const task = mutationQueue.catch(() => {}).then(async () => {
            if (!action.current()) return;
            const response = await request(path, options);
            if (!action.current()) return response;
            generation++;
            JE.core.api.manager?.invalidatePresentation?.();
            try {
                // A unique signal prevents joining a read submitted before this write.
                const value = await request('/spoiler-blur/series', { skipCache: true, signal: new AbortController().signal });
                if (!action.current()) return response;
                adoptState(value);
                statePromise = Promise.resolve();
            } catch (err) {
                if (!action.current()) return response;
                loaded = true;
                loadOk = false;
                throw err;
            } finally {
                if (action.current()) {
                    window.dispatchEvent(new CustomEvent('je-spoiler-policy-changed', { detail: { userId: ApiClient.getCurrentUserId() } }));
                    document.querySelectorAll('.je-spoiler-pending-btn, .je-spoiler-pending-detail').forEach(node => node.jeSpoilerRefresh?.());
                    internal.refreshSpoilerableImages?.();
                    void JE.tagPipeline?.invalidateServerCache?.();
                    JE.tagPipeline?.clearProcessed?.();
                    JE.tagPipeline?.scheduleScan?.();
                }
            }
            return response;
        });
        mutationQueue = task.catch(() => {});
        return task;
    }

    internal.loadState = function() {
        if (statePromise) return statePromise;
        // A response resolving after a user switch must not populate the
        // (already reset) state with the previous user's data.
        const action = JE.createSessionAction();
        // The page-load bootstrap carries this user's state (same body as the
        // endpoint); it is handed out once, so later loads ask the server.
        const requestGeneration = generation;
        const prefetchedState = JE.takePrefetched?.('SpoilerBlurSeries');
        statePromise = (prefetchedState ? Promise.resolve(prefetchedState) : request('/spoiler-blur/series'))
            .then(function(data) {
                if (!action.current() || requestGeneration !== generation) return;
                adoptState(data);
                // If tag renderers already ran fail-closed while this request was
                // in flight, give them one authoritative pass now.
                try {
                    JE.tagPipeline?.clearProcessed?.();
                    JE.tagPipeline?.scheduleScan?.();
                } catch (e) {
                    console.warn(`${logPrefix} post-load tag rescan failed:`, e);
                }
            })
            .catch(function(err) {
                if (!action.current() || requestGeneration !== generation) return;
                console.error(`${logPrefix} state load failed; downstream consumers will fail closed:`, err);
                loaded = true;
                loadOk = false;
                // Tag renderers held back on cards while this was in flight
                // (e.g. user-review chips, see ratingtags.js): with the state
                // settled — failed, so ratings stay suppressed — give them
                // their final pass too.
                try {
                    JE.tagPipeline?.clearProcessed?.();
                    JE.tagPipeline?.scheduleScan?.();
                } catch (e) {
                    console.warn(`${logPrefix} post-failure tag rescan failed:`, e);
                }
            });
        return statePromise;
    };

    internal.whenLoaded = function() {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return Promise.resolve();
        if (loaded) return Promise.resolve();
        return statePromise || internal.loadState();
    };

    internal.isStateLoaded = function() { return loaded; };
    internal.isLoadOk = function() { return loadOk; };
    // True once the initial state request has settled (successfully or not).
    internal.isLoaded = function() { return loaded; };
    internal.isEnabledFor = function(id) { return enabledSeries.has(internal.normalizeId(id)); };
    internal.isMovieEnabledFor = function(id) { return enabledMovies.has(internal.normalizeId(id)); };
    internal.isCollectionEnabledFor = function(id) { return enabledCollections.has(internal.normalizeId(id)); };
    internal.hasAnyState = function() {
        return enabledSeries.size > 0 || enabledMovies.size > 0 || enabledCollections.size > 0 || enabledPendingTmdb.size > 0;
    };

    internal.isEnabledForKind = function(kind, id) {
        if (kind === 'movie') return internal.isMovieEnabledFor(id);
        if (kind === 'collection') return internal.isCollectionEnabledFor(id);
        return internal.isEnabledFor(id);
    };

    internal.enableForSeries = function(id) {
        return mutateState(`/spoiler-blur/series/${encodeURIComponent(internal.normalizeId(id))}`, { method: 'POST', skipRetry: true });
    };
    internal.disableForSeries = function(id) {
        return mutateState(`/spoiler-blur/series/${encodeURIComponent(internal.normalizeId(id))}`, { method: 'DELETE', skipRetry: true });
    };
    internal.enableForMovie = function(id, name) {
        return mutateState(`/spoiler-blur/movies/${encodeURIComponent(internal.normalizeId(id))}`, { method: 'POST', body: { MovieName: name || '' }, skipRetry: true });
    };
    internal.disableForMovie = function(id) {
        return mutateState(`/spoiler-blur/movies/${encodeURIComponent(internal.normalizeId(id))}`, { method: 'DELETE', skipRetry: true });
    };
    internal.enableForCollection = function(id, name) {
        return mutateState(`/spoiler-blur/collections/${encodeURIComponent(internal.normalizeId(id))}`, { method: 'POST', body: { CollectionName: name || '' }, skipRetry: true });
    };
    internal.disableForCollection = function(id) {
        return mutateState(`/spoiler-blur/collections/${encodeURIComponent(internal.normalizeId(id))}`, { method: 'DELETE', skipRetry: true });
    };

    internal.isTmdbEnabled = function(mediaType, tmdbId, jellyfinMediaId) {
        const key = internal.pendingKey(mediaType, tmdbId);
        if (key && enabledPendingTmdb.has(key)) return true;
        const jellyfinId = jellyfinMediaId;
        if (!jellyfinId) return false;
        if (mediaType === 'movie') return internal.isMovieEnabledFor(jellyfinId);
        if (mediaType === 'tv') return internal.isEnabledFor(jellyfinId);
        return false;
    };

    internal.enableForTmdb = function(mediaType, tmdbId, displayName) {
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : '';
        return mutateState(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}${query}`, { method: 'POST', skipRetry: true });
    };
    internal.disableForTmdb = function(mediaType, tmdbId) {
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        return mutateState(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}`, { method: 'DELETE', skipRetry: true });
    };

    internal.getUserPrefs = function() { return Object.assign({}, userPrefs); };
    internal.setUserPrefs = function(next) {
        return mutateState('/spoiler-blur/user-prefs', { method: 'POST', body: next || {}, skipRetry: true })
            .then(() => internal.getUserPrefs());
    };

    // Spoiler Guard state (enabled series/movies/collections, prefs) is
    // per-user and memoized for the whole SPA session via statePromise.
    // Drop it on a user switch so the next whenLoaded() fetches the new
    // user's state instead of serving the previous user's.
    JE.session?.onUserChange('spoilerguard-state', () => {
        generation++;
        mutationQueue = Promise.resolve();
        statePromise = null;
        loaded = false;
        loadOk = false;
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        userPrefs = {};
    });
})(window.JellyfinEnhanced);
