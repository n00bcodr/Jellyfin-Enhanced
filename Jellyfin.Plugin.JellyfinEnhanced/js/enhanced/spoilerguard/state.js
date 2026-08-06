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
    // A pending enable can be promoted immediately. Keep the returned Jellyfin
    // id so a Seerr payload without jellyfinMediaId still renders the live state.
    const tmdbToJellyfin = new Map();

    let userPrefs = {};
    let loaded = false;
    let loadOk = false;
    let statePromise = null;

    function request(path, options) {
        return JE.core.api.plugin(path, options);
    }

    internal.loadState = function() {
        if (statePromise) return statePromise;
        // A response resolving after a user switch must not populate the
        // (already reset) state with the previous user's data.
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        statePromise = request('/spoiler-blur/series')
            .then(function(data) {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                const value = data || {};
                enabledSeries.clear();
                enabledMovies.clear();
                enabledCollections.clear();
                enabledPendingTmdb.clear();
                tmdbToJellyfin.clear();
                Object.keys(value.Series || {}).forEach(key => enabledSeries.add(internal.normalizeId(key)));
                Object.keys(value.Movies || {}).forEach(key => enabledMovies.add(internal.normalizeId(key)));
                Object.keys(value.Collections || {}).forEach(key => enabledCollections.add(internal.normalizeId(key)));
                Object.keys(value.PendingTmdb || {}).forEach(key => enabledPendingTmdb.add(String(key).toLowerCase()));
                userPrefs = value.Prefs || {};
                loaded = true;
                loadOk = true;
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
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                console.error(`${logPrefix} state load failed; downstream consumers will fail closed:`, err);
                loaded = true;
                loadOk = false;
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
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: 'POST', skipRetry: true })
            .then(function() { enabledSeries.add(normalized); });
    };

    internal.disableForSeries = function(id) {
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() { enabledSeries.delete(normalized); });
    };

    internal.enableForMovie = function(id, name) {
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, {
            method: 'POST', body: { MovieName: name || '' }, skipRetry: true
        }).then(function() { enabledMovies.add(normalized); });
    };

    internal.disableForMovie = function(id) {
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() { enabledMovies.delete(normalized); });
    };

    internal.enableForCollection = function(id, name) {
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, {
            method: 'POST', body: { CollectionName: name || '' }, skipRetry: true
        }).then(function() { enabledCollections.add(normalized); });
    };

    internal.disableForCollection = function(id) {
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() { enabledCollections.delete(normalized); });
    };

    internal.isTmdbEnabled = function(mediaType, tmdbId, jellyfinMediaId) {
        const key = internal.pendingKey(mediaType, tmdbId);
        if (key && enabledPendingTmdb.has(key)) return true;
        const jellyfinId = jellyfinMediaId || (key ? tmdbToJellyfin.get(key) : null);
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
        return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}${query}`, { method: 'POST', skipRetry: true })
            .then(function(response) {
                const key = internal.pendingKey(type, id);
                if (response?.promoted === 'pending') {
                    if (key) enabledPendingTmdb.add(key);
                } else if (response?.promoted === 'series' && response.jellyfinId) {
                    const jellyfinId = internal.normalizeId(response.jellyfinId);
                    enabledSeries.add(jellyfinId);
                    if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.set(key, jellyfinId); }
                } else if (response?.promoted === 'movie' && response.jellyfinId) {
                    const jellyfinId = internal.normalizeId(response.jellyfinId);
                    enabledMovies.add(jellyfinId);
                    if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.set(key, jellyfinId); }
                }
                return response;
            });
    };

    internal.disableForTmdb = function(mediaType, tmdbId) {
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}`, { method: 'DELETE', skipRetry: true })
            .then(function(response) {
                const key = internal.pendingKey(type, id);
                if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.delete(key); }
                if (response?.removedFrom === 'series' && response.jellyfinId) {
                    enabledSeries.delete(internal.normalizeId(response.jellyfinId));
                } else if (response?.removedFrom === 'movie' && response.jellyfinId) {
                    enabledMovies.delete(internal.normalizeId(response.jellyfinId));
                }
                return response;
            });
    };

    internal.getUserPrefs = function() { return Object.assign({}, userPrefs); };
    internal.setUserPrefs = function(next) {
        const payload = next || {};
        return request('/spoiler-blur/user-prefs', { method: 'POST', body: payload, skipRetry: true })
            .then(function(response) {
                userPrefs = Object.assign({}, payload);
                return response?.prefs || userPrefs;
            })
            .catch(function(err) {
                console.error(`${logPrefix} setUserPrefs failed:`, err);
                throw err;
            });
    };

    // Spoiler Guard state (enabled series/movies/collections, prefs) is
    // per-user and memoized for the whole SPA session via statePromise.
    // Drop it on a user switch so the next whenLoaded() fetches the new
    // user's state instead of serving the previous user's.
    JE.session?.onUserChange('spoilerguard-state', () => {
        statePromise = null;
        loaded = false;
        loadOk = false;
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        tmdbToJellyfin.clear();
        userPrefs = {};
    });
})(window.JellyfinEnhanced);
