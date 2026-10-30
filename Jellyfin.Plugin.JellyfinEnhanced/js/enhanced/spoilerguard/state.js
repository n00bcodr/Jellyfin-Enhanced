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
    // Bumped on every change to the sets, preferences or load state above;
    // tagStripRevision memoizes on it.
    let stateVersion = 0;
    let revisionMemo = { version: -1, value: '' };
    function changed() { stateVersion++; }

    function request(path, options) {
        return JE.core.api.plugin(path, options);
    }

    internal.loadState = function() {
        if (statePromise) return statePromise;
        // A response resolving after a user switch must not populate the
        // (already reset) state with the previous user's data.
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        // The page-load bootstrap carries this user's state (same body as the
        // endpoint); it is handed out once, so later loads ask the server.
        const prefetchedState = JE.takePrefetched?.('SpoilerBlurSeries');
        statePromise = (prefetchedState ? Promise.resolve(prefetchedState) : request('/spoiler-blur/series'))
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
                changed();
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
                changed();
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
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: 'POST', skipRetry: true })
            .then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                enabledSeries.add(normalized);
                changed();
            });
    };

    internal.disableForSeries = function(id) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                enabledSeries.delete(normalized);
                changed();
            });
    };

    internal.enableForMovie = function(id, name) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, {
            method: 'POST', body: { MovieName: name || '' }, skipRetry: true
        }).then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                enabledMovies.add(normalized);
                changed();
            });
    };

    internal.disableForMovie = function(id) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                enabledMovies.delete(normalized);
                changed();
            });
    };

    internal.enableForCollection = function(id, name) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, {
            method: 'POST', body: { CollectionName: name || '' }, skipRetry: true
        }).then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                enabledCollections.add(normalized);
                changed();
            });
    };

    internal.disableForCollection = function(id) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                enabledCollections.delete(normalized);
                changed();
            });
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
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : '';
        return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}${query}`, { method: 'POST', skipRetry: true })
            .then(function(response) {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return response;
                const key = internal.pendingKey(type, id);
                if (response?.promoted === 'pending') {
                    if (key) enabledPendingTmdb.add(key);
                } else if (response?.promoted === 'series' && response.jellyfinId) {
                    const jellyfinId = internal.normalizeId(response.jellyfinId);
                    enabledSeries.add(jellyfinId);
                    if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.set(key, jellyfinId); }
                    changed();
                } else if (response?.promoted === 'movie' && response.jellyfinId) {
                    const jellyfinId = internal.normalizeId(response.jellyfinId);
                    enabledMovies.add(jellyfinId);
                    if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.set(key, jellyfinId); }
                    changed();
                }
                return response;
            });
    };

    internal.disableForTmdb = function(mediaType, tmdbId) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}`, { method: 'DELETE', skipRetry: true })
            .then(function(response) {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return response;
                const key = internal.pendingKey(type, id);
                if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.delete(key); }
                if (response?.removedFrom === 'series' && response.jellyfinId) {
                    enabledSeries.delete(internal.normalizeId(response.jellyfinId));
                    changed();
                } else if (response?.removedFrom === 'movie' && response.jellyfinId) {
                    enabledMovies.delete(internal.normalizeId(response.jellyfinId));
                    changed();
                }
                return response;
            });
    };

    /**
     * A short fingerprint of what this user's Spoiler Guard strips from card
     * tags (Hide tags, as the server's SpoilerTagDataStripper decides it):
     * 'off' when nothing is (the feature, the administrator's tag strip or
     * the user's Hide tags is off, or nothing is guarded), else a hash of the
     * guarded series, movies and collections. Null while the state is unknown
     * (loading or failed). Tag renderers stamp what they keep in browser
     * caches with it and treat another stamp as a miss, since the server's
     * strip at the time decided those tags.
     * @returns {string|null}
     */
    internal.tagStripRevision = function() {
        const cfg = JE.pluginConfig || {};
        if (cfg.SpoilerBlurEnabled !== true || cfg.SpoilerStripTags === false) return 'off';
        if (!loaded || !loadOk) return null;
        if (userPrefs.HideTags === false) return 'off';
        if (revisionMemo.version === stateVersion) return revisionMemo.value;
        const keys = [];
        enabledSeries.forEach(id => keys.push(`s${id}`));
        enabledMovies.forEach(id => keys.push(`m${id}`));
        enabledCollections.forEach(id => keys.push(`c${id}`));
        let value = 'off';
        if (keys.length > 0) {
            // FNV-1a over the sorted keys: short enough to stamp every entry.
            let hash = 0x811c9dc5;
            const text = keys.sort().join(',');
            for (let i = 0; i < text.length; i++) {
                hash ^= text.charCodeAt(i);
                hash = Math.imul(hash, 0x01000193) >>> 0;
            }
            value = `g${keys.length}.${hash.toString(36)}`;
        }
        revisionMemo = { version: stateVersion, value };
        return value;
    };

    internal.getUserPrefs = function() { return Object.assign({}, userPrefs); };
    internal.setUserPrefs = function(next) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const payload = next || {};
        return request('/spoiler-blur/user-prefs', { method: 'POST', body: payload, skipRetry: true })
            .then(function(response) {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return response;
                userPrefs = Object.assign({}, payload);
                changed();
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
        changed();
    });
})(window.JellyfinEnhanced);
